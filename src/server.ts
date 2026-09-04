import Fastify, { type FastifyRequest } from 'fastify';
import { z } from 'zod';

import { config } from './config';
import { handleMessage, type Reply } from './conversation/machine';
import { conversationsRepo } from './db';
import { logger } from './logger';
import { renderReceipt } from './receipt';
import { verify } from './util/hmac';
import type { WaSession } from './wa/session';
import { sessionManager } from './wa/session-manager';
import {
    drainOutbound,
    isSimulated,
    pushOutbound,
    registerSimulated,
    unregisterSimulated,
} from './wa/simulator';

const PUBLIC_ROUTES = new Set(['/health']);

const ensureSessionSchema = z.object({
    session_id: z.string().min(1),
    user_id: z.string().min(1),
});

/**
 * Dados do comprovante que acompanha o aviso de pagamento confirmado. O bot não
 * tem como reconstruí-los sozinho: o rascunho da conversa é descartado assim que
 * a cobrança é criada, então quem manda é o painel, dono do dado.
 */
const receiptSchema = z.object({
    amount: z.number().positive(),
    paid_at: z.string().min(1).optional(),
    payer_name: z.string().min(1).optional(),
    end_to_end_id: z.string().min(1).optional(),
    order_code: z.string().min(1).optional(),
});

const notifySchema = z.object({
    session_id: z.string().min(1),
    jid: z.string().min(1),
    text: z.string().min(1).max(4096),
    receipt: receiptSchema.optional(),
});

type ReceiptPayload = z.infer<typeof receiptSchema>;

const simulateMessageSchema = z.object({
    session_id: z.string().min(1),
    jid: z.string().min(1),
    text: z.string().min(1).max(4096),
});

const simulateSessionSchema = z.object({
    session_id: z.string().min(1),
    user_id: z.string().min(1).default('simulado'),
});

type RawBodyRequest = FastifyRequest & { rawBody?: string };

export function buildServer() {
    const app = Fastify({ loggerInstance: logger, trustProxy: true });

    // Precisamos do corpo cru para conferir o HMAC — reserializar mudaria os bytes.
    app.addContentTypeParser(
        'application/json',
        { parseAs: 'string' },
        (request, body, done) => {
            (request as RawBodyRequest).rawBody = body as string;

            try {
                done(
                    null,
                    (body as string).length > 0
                        ? JSON.parse(body as string)
                        : {},
                );
            } catch (error) {
                done(error as Error, undefined);
            }
        },
    );

    // preValidation (e não onRequest): o corpo cru só existe depois do parse.
    app.addHook('preValidation', async (request, reply) => {
        if (PUBLIC_ROUTES.has(request.url.split('?')[0] ?? '')) {
            return;
        }

        const valid = verify(
            request.headers['x-bot-timestamp'] as string | undefined,
            request.headers['x-bot-signature'] as string | undefined,
            (request as RawBodyRequest).rawBody ?? '',
        );

        if (!valid) {
            return reply.code(401).send({ message: 'Assinatura inválida.' });
        }
    });

    app.get('/health', async () => ({ status: 'ok' }));

    /** Cria a sessão e abre o socket — é aqui que o QR começa a ser emitido. */
    app.post('/internal/sessions', async (request, reply) => {
        const parsed = ensureSessionSchema.safeParse(request.body);

        if (!parsed.success) {
            return reply
                .code(422)
                .send({
                    message: 'Payload inválido.',
                    issues: parsed.error.issues,
                });
        }

        const { session_id: sessionId, user_id: userId } = parsed.data;

        await sessionManager.ensure(sessionId, userId);

        return reply.code(202).send(present(sessionId));
    });

    app.get('/internal/sessions/:id', async (request, reply) => {
        const { id } = request.params as { id: string };
        const row = sessionManager.status(id);

        if (row === null) {
            return reply.code(404).send({ message: 'Sessão não encontrada.' });
        }

        return reply.send(present(id));
    });

    app.delete('/internal/sessions/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        await sessionManager.remove(id);

        return reply.send({ status: 'logged_out' });
    });

    /** Entrega uma mensagem avulsa (usado pelo job de mudança de status). */
    app.post('/internal/notify', async (request, reply) => {
        const parsed = notifySchema.safeParse(request.body);

        if (!parsed.success) {
            return reply
                .code(422)
                .send({
                    message: 'Payload inválido.',
                    issues: parsed.error.issues,
                });
        }

        const { session_id: sessionId, jid, text, receipt } = parsed.data;

        // Numa sessão simulada a mensagem vai para a caixa de saída de teste.
        if (isSimulated(sessionId)) {
            pushOutbound(sessionId, jid, text);

            if (receipt !== undefined) {
                pushOutbound(
                    sessionId,
                    jid,
                    `[imagem] comprovante de ${receipt.amount}`,
                );
            }

            return reply.send({ status: 'sent', simulated: true });
        }

        const session = sessionManager.get(sessionId);

        if (session === undefined || !session.connected) {
            return reply
                .code(409)
                .send({ message: 'Sessão não está conectada.' });
        }

        await session.sendText(jid, text);

        if (receipt === undefined) {
            return reply.send({ status: 'sent' });
        }

        const delivered = await deliverReceipt(session, jid, receipt);

        return reply.send({
            status: 'sent',
            receipt: delivered ? 'sent' : 'failed',
        });
    });

    // Rotas de teste: conversam com a máquina de estados sem WhatsApp nenhum.
    // Ficam fora do ar a menos que SIMULATION_ENABLED=true.
    if (!config.SIMULATION_ENABLED) {
        return app;
    }

    logger.warn('SIMULATION_ENABLED=true — rotas /internal/simulate ativas');

    app.post('/internal/simulate/sessions', async (request, reply) => {
        const parsed = simulateSessionSchema.safeParse(request.body);

        if (!parsed.success) {
            return reply
                .code(422)
                .send({
                    message: 'Payload inválido.',
                    issues: parsed.error.issues,
                });
        }

        registerSimulated(parsed.data.session_id, parsed.data.user_id);

        return reply.send({ status: 'connected', simulated: true });
    });

    app.delete('/internal/simulate/sessions/:id', async (request, reply) => {
        const { id } = request.params as { id: string };

        unregisterSimulated(id);

        return reply.send({ status: 'removed' });
    });

    /** Entrega uma mensagem "do contato" e devolve o que o bot responderia. */
    app.post('/internal/simulate/messages', async (request, reply) => {
        const parsed = simulateMessageSchema.safeParse(request.body);

        if (!parsed.success) {
            return reply
                .code(422)
                .send({
                    message: 'Payload inválido.',
                    issues: parsed.error.issues,
                });
        }

        const { session_id: sessionId, jid, text } = parsed.data;

        if (!isSimulated(sessionId)) {
            return reply
                .code(404)
                .send({ message: 'Sessão simulada não registrada.' });
        }

        const replies = await handleMessage(sessionId, jid, text);

        // A simulação é texto puro: uma imagem vira um marcador, para o
        // roteiro de teste continuar legível no terminal.
        return reply.send({ replies: replies.map(describeReply) });
    });

    /** Mensagens assíncronas (ex.: aviso de pagamento confirmado). */
    app.post('/internal/simulate/outbox', async (request, reply) => {
        const parsed = simulateSessionSchema.safeParse(request.body);

        if (!parsed.success) {
            return reply.code(422).send({ message: 'Payload inválido.' });
        }

        return reply.send({ messages: drainOutbound(parsed.data.session_id) });
    });

    /** Descarta o estado da conversa, voltando ao menu. */
    app.post('/internal/simulate/reset', async (request, reply) => {
        const parsed = simulateMessageSchema
            .omit({ text: true })
            .safeParse(request.body);

        if (!parsed.success) {
            return reply.code(422).send({ message: 'Payload inválido.' });
        }

        conversationsRepo.delete(parsed.data.session_id, parsed.data.jid);

        return reply.send({ status: 'reset' });
    });

    return app;
}

/**
 * Gera e envia o comprovante logo após o aviso de pagamento.
 *
 * Falhar aqui não pode derrubar a requisição: a mensagem de texto já saiu, e o
 * job do painel retentaria, duplicando o aviso para o cliente. Um comprovante
 * ausente é bem menos grave que dois avisos de pagamento.
 */
async function deliverReceipt(
    session: WaSession,
    jid: string,
    receipt: ReceiptPayload,
): Promise<boolean> {
    try {
        const image = await renderReceipt(
            {
                amount: receipt.amount,
                paidAt: parseDate(receipt.paid_at),
                payerName: receipt.payer_name,
                endToEndId: receipt.end_to_end_id,
                orderCode: receipt.order_code,
            },
            { format: 'jpeg' },
        );

        await session.sendImage(jid, image);

        logger.info(
            { sessionId: session.id, bytes: image.length },
            'comprovante enviado',
        );

        return true;
    } catch (error) {
        logger.error(
            { sessionId: session.id, err: (error as Error).message },
            'falha ao gerar ou enviar o comprovante',
        );

        return false;
    }
}

/** Achata uma resposta em texto para as rotas de simulação. */
function describeReply(reply: Reply): string {
    return reply.kind === 'image'
        ? `[imagem] ${reply.caption ?? 'QR Code Pix'}`
        : reply.text;
}

function parseDate(value: string | undefined): Date | undefined {
    if (value === undefined) {
        return undefined;
    }

    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function present(sessionId: string): Record<string, unknown> {
    const row = sessionManager.status(sessionId);
    const session = sessionManager.get(sessionId);

    return {
        session_id: sessionId,
        status: row?.status ?? 'pending',
        phone_number: row?.phone_number ?? null,
        last_error: row?.last_error ?? null,
        connected: session?.connected ?? false,
    };
}
