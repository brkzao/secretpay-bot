import { randomUUID } from 'node:crypto';

import {
    createOrder,
    fetchOrderStatus,
    type OrderPayload,
} from '../laravel/client';
import { logger } from '../logger';
import { renderPixQr } from '../pix/qr';
import {
    loadState,
    resetState,
    saveState,
    type ConversationState,
    type Step,
} from './store';
import { formatBrl, parseAmount } from './validators';

/**
 * Uma resposta do bot. Virou união quando o Pix entrou: o QR precisa sair como
 * imagem, e até então toda resposta era texto.
 */
export type Reply =
    | { kind: 'text'; text: string }
    | { kind: 'image'; image: Buffer; caption?: string };

export function text(value: string): Reply {
    return { kind: 'text', text: value };
}

export function image(buffer: Buffer, caption?: string): Reply {
    return { kind: 'image', image: buffer, caption };
}

/** Ordem dos passos — usada pelo comando "voltar". */
const FLOW: Step[] = ['AMOUNT', 'CONFIRM'];

const STATUS_LABELS: Record<string, string> = {
    PENDING: '⏳ Aguardando o seu pagamento',
    PAID: '✅ Pago',
    EXPIRED: '⌛ Expirou',
    CANCELLED: '❌ Cancelado',
};

export async function handleMessage(
    sessionId: string,
    jid: string,
    rawText: string,
): Promise<Reply[]> {
    const input = rawText.trim();
    const state = loadState(sessionId, jid);

    const global = await handleGlobalCommand(sessionId, jid, input, state);

    if (global !== null) {
        return global;
    }

    switch (state.step) {
        case 'MENU':
            return handleMenu(sessionId, jid, input, state);
        case 'AMOUNT':
            return handleAmount(sessionId, jid, input, state);
        case 'CONFIRM':
            return handleConfirm(sessionId, jid, input, state);
    }
}

/**
 * Comandos que funcionam em qualquer passo. Retorna `null` quando a mensagem
 * não é um comando e deve seguir para a máquina de estados.
 */
async function handleGlobalCommand(
    sessionId: string,
    jid: string,
    input: string,
    state: ConversationState,
): Promise<Reply[] | null> {
    const command = normalize(input);

    if (['cancelar', 'cancela', 'sair', 'parar'].includes(command)) {
        if (state.step === 'MENU') {
            return [text(menuMessage())];
        }

        resetState(sessionId, jid, state);

        return [text('Operação cancelada.'), text(menuMessage())];
    }

    if (
        [
            'menu',
            'inicio',
            'início',
            'oi',
            'ola',
            'olá',
            'bom dia',
            'boa tarde',
            'boa noite',
        ].includes(command)
    ) {
        resetState(sessionId, jid, state);

        return [text(menuMessage())];
    }

    if (['ajuda', 'help', '?'].includes(command)) {
        return [text(helpMessage())];
    }

    if (['status', '2'].includes(command) && state.step === 'MENU') {
        return statusReply(sessionId, state);
    }

    if (command === 'voltar') {
        return handleBack(sessionId, jid, state);
    }

    return null;
}

function handleBack(
    sessionId: string,
    jid: string,
    state: ConversationState,
): Reply[] {
    const index = FLOW.indexOf(state.step);

    if (index <= 0) {
        resetState(sessionId, jid, state);

        return [text(menuMessage())];
    }

    const previous = FLOW[index - 1] as Step;
    const draft = { ...state.draft };

    // Limpa o campo do passo para onde estamos voltando e os posteriores,
    // senão o resumo mostraria dados que o usuário está prestes a trocar.
    const fields: Record<Step, keyof typeof draft | null> = {
        MENU: null,
        AMOUNT: 'amount',
        CONFIRM: null,
    };

    for (const step of FLOW.slice(index - 1)) {
        const field = fields[step];

        if (field !== null) {
            delete draft[field];
        }
    }

    const next: ConversationState = { ...state, step: previous, draft };

    saveState(sessionId, jid, next);

    return [text(promptFor(previous, next))];
}

function handleMenu(
    sessionId: string,
    jid: string,
    input: string,
    state: ConversationState,
): Reply[] {
    const command = normalize(input);

    if (['1', 'pagar', 'pagamento', 'pix', 'novo', 'nova'].includes(command)) {
        const next: ConversationState = { ...state, step: 'AMOUNT', draft: {} };

        saveState(sessionId, jid, next);

        return [text(promptFor('AMOUNT', next))];
    }

    return [text(menuMessage())];
}

function handleAmount(
    sessionId: string,
    jid: string,
    input: string,
    state: ConversationState,
): Reply[] {
    const parsed = parseAmount(input);

    if (!parsed.ok) {
        return [text(parsed.error)];
    }

    const next: ConversationState = {
        ...state,
        step: 'CONFIRM',
        draft: { ...state.draft, amount: parsed.value },
        // Gerado antes do envio: se o usuário tocar "confirmar" duas vezes,
        // o Laravel devolve a mesma cobrança em vez de criar outra.
        idempotencyKey: randomUUID(),
    };

    saveState(sessionId, jid, next);

    return [text(promptFor('CONFIRM', next))];
}

async function handleConfirm(
    sessionId: string,
    jid: string,
    input: string,
    state: ConversationState,
): Promise<Reply[]> {
    const command = normalize(input);

    if (['2', 'nao', 'não', 'n', 'cancelar'].includes(command)) {
        resetState(sessionId, jid, state);

        return [text('Operação cancelada.'), text(menuMessage())];
    }

    if (!['1', 'sim', 's', 'confirmar', 'confirmo', 'ok'].includes(command)) {
        return [text('Responda *1* para confirmar ou *2* para cancelar.')];
    }

    const { amount } = state.draft;

    if (amount === undefined) {
        return restart(sessionId, jid, state);
    }

    const result = await createOrder({
        session_id: sessionId,
        wa_jid: jid,
        idempotency_key: state.idempotencyKey ?? randomUUID(),
        amount,
    });

    if (!result.ok) {
        logger.warn(
            { sessionId, jid, message: result.message },
            'geração do Pix recusada pelo painel',
        );

        const details = result.errors
            ? Object.values(result.errors).flat().join('\n• ')
            : null;

        return [
            text(
                details
                    ? `❌ Não foi possível gerar o Pix:\n• ${details}\n\nEnvie *menu* para recomeçar.`
                    : `❌ ${result.message}\n\nEnvie *menu* para recomeçar.`,
            ),
        ];
    }

    const next: ConversationState = {
        step: 'MENU',
        draft: {},
        lastOrderId: result.order.id,
    };

    saveState(sessionId, jid, next);

    return orderMessages(result.order);
}

function restart(
    sessionId: string,
    jid: string,
    state: ConversationState,
): Reply[] {
    resetState(sessionId, jid, state);

    return [
        text('Perdi o contexto da nossa conversa. Vamos começar de novo.'),
        text(menuMessage()),
    ];
}

async function statusReply(
    sessionId: string,
    state: ConversationState,
): Promise<Reply[]> {
    if (state.lastOrderId === undefined) {
        return [
            text(
                'Você ainda não fez nenhum pagamento nesta conversa. Envie *1* para gerar um Pix.',
            ),
        ];
    }

    const order = await fetchOrderStatus(sessionId, state.lastOrderId);

    if (order === null) {
        return [
            text(
                'Não consegui consultar o pagamento agora. Tente de novo em instantes.',
            ),
        ];
    }

    return [
        text(
            [
                '*Status do seu pagamento*',
                '',
                `Código: ${shortId(order.id)}`,
                `Valor: ${formatBrl(Number(order.amount))}`,
                `Situação: ${STATUS_LABELS[order.status] ?? order.status}`,
                '',
                `Acompanhe: ${order.checkout_url}`,
            ].join('\n'),
        ),
    ];
}

function promptFor(step: Step, state: ConversationState): string {
    switch (step) {
        case 'AMOUNT':
            return [
                '*Pagamento por Pix*',
                '',
                'Quanto você vai pagar?',
                '',
                '_Envie *cancelar* a qualquer momento._',
            ].join('\n');

        case 'CONFIRM': {
            const lines = [
                '*Confira antes de gerar*',
                '',
                `💰 Valor a pagar: *${formatBrl(state.draft.amount ?? 0)}*`,
            ];

            lines.push(
                '',
                'Gero o código Pix?',
                '',
                '*1* - Confirmar',
                '*2* - Cancelar',
                '',
                '_Envie *voltar* para corrigir o valor._',
            );

            return lines.join('\n');
        }

        case 'MENU':
            return menuMessage();
    }
}

/**
 * O copia-e-cola sai em mensagem própria, sem mais nada junto: no WhatsApp,
 * copiar uma mensagem copia o texto inteiro dela, então qualquer palavra a
 * mais viria grudada no código na hora de colar no app do banco.
 */
async function orderMessages(order: OrderPayload): Promise<Reply[]> {
    const lines = [
        '✅ *Pix gerado!*',
        '',
        `Código: ${shortId(order.id)}`,
        `Valor a pagar: *${formatBrl(Number(order.amount))}*`,
    ];

    if (order.expires_at !== null) {
        lines.push('', `⏱️ Válido até ${formatTime(order.expires_at)}.`);
    }

    lines.push(
        '',
        `Acompanhe por aqui: ${order.checkout_url}`,
        '',
        '_Assim que o seu pagamento cair eu confirmo aqui._',
        '_Envie *status* para consultar a qualquer momento._',
    );

    const messages: Reply[] = [text(lines.join('\n'))];

    if (order.pix_code !== null) {
        // Falhar ao desenhar o QR não pode derrubar a cobrança: o copia-e-cola
        // sozinho já permite pagar, e é ele que vai na mensagem seguinte.
        try {
            messages.push(
                image(
                    await renderPixQr(order.pix_code),
                    'Escaneie no app do seu banco',
                ),
            );
        } catch (error) {
            logger.error(
                { orderId: order.id, err: (error as Error).message },
                'falha ao gerar o QR do Pix',
            );
        }

        messages.push(text('Ou copie o código Pix abaixo:'));
        messages.push(text(order.pix_code));
    }

    return messages;
}

function menuMessage(): string {
    return [
        '👋 Olá! Sou o assistente de pagamentos da *SecretPay*.',
        '',
        'O que você quer fazer?',
        '',
        '*1* - Pagar com Pix',
        '*2* - Ver o meu último pagamento',
        '',
        '_Envie *ajuda* para ver os comandos._',
    ].join('\n');
}

function helpMessage(): string {
    return [
        '*Comandos disponíveis*',
        '',
        '*menu* - volta ao início',
        '*1* - gera um novo Pix para pagar',
        '*status* - status do seu último pagamento',
        '*voltar* - corrige o valor',
        '*cancelar* - cancela a operação atual',
    ].join('\n');
}

function shortId(id: string): string {
    return id.split('-')[0]?.toUpperCase() ?? id;
}

function formatTime(iso: string): string {
    return new Date(iso).toLocaleTimeString('pt-BR', {
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
    });
}

function normalize(value: string): string {
    return value.trim().toLowerCase();
}
