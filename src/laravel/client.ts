import { config } from '../config';
import { logger } from '../logger';
import { currentTimestamp, sign } from '../util/hmac';

/**
 * Espelha `Order::toPublicArray()` do painel — o payload que pode chegar ao
 * pagador. Taxa, líquido e adquirente ficam de fora de propósito: são a
 * economia do vendedor.
 */
export type OrderPayload = {
    id: string;
    status: string;
    amount: string;
    currency: string;
    description: string | null;
    /** BR Code copia e cola. */
    pix_code: string | null;
    expires_at: string | null;
    paid_at: string | null;
    checkout_url: string;
    created_at: string | null;
};

export type CreateOrderInput = {
    session_id: string;
    wa_jid: string;
    idempotency_key: string;
    amount: number;
};

export type CreateOrderResult =
    | { ok: true; order: OrderPayload }
    | { ok: false; message: string; errors?: Record<string, string[]> };

type RequestOptions = {
    method?: 'GET' | 'POST';
    payload?: unknown;
    timeoutMs?: number;
};

async function request(
    path: string,
    { method = 'POST', payload, timeoutMs = 30_000 }: RequestOptions = {},
): Promise<{ status: number; body: unknown }> {
    const body = method === 'GET' ? '' : JSON.stringify(payload ?? {});
    const timestamp = currentTimestamp();

    const response = await fetch(`${config.LARAVEL_URL}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Bot-Timestamp': timestamp,
            'X-Bot-Signature': sign(timestamp, body),
        },
        body: method === 'GET' ? undefined : body,
        signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();

    let parsed: unknown = null;

    try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
    } catch {
        parsed = { message: text.slice(0, 500) };
    }

    return { status: response.status, body: parsed };
}

/**
 * Publica o QR corrente. Não retentamos: o QR expira em ~20s e o Baileys
 * emite um novo logo em seguida.
 */
export async function pushQr(sessionId: string, qr: string): Promise<void> {
    try {
        await request('/api/bot/qr', {
            payload: { session_id: sessionId, qr },
            timeoutMs: 10_000,
        });
    } catch (error) {
        logger.warn(
            { sessionId, err: (error as Error).message },
            'falha ao publicar QR no painel',
        );
    }
}

export async function pushStatus(
    sessionId: string,
    status: string,
    extra: { phone_number?: string | null; error?: string | null } = {},
): Promise<void> {
    try {
        await request('/api/bot/status', {
            payload: { session_id: sessionId, status, ...extra },
            timeoutMs: 10_000,
        });
    } catch (error) {
        logger.warn(
            { sessionId, status, err: (error as Error).message },
            'falha ao publicar status no painel',
        );
    }
}

export async function createOrder(
    input: CreateOrderInput,
): Promise<CreateOrderResult> {
    try {
        const { status, body } = await request('/api/bot/orders', {
            payload: input,
        });

        if (status === 201 || status === 200) {
            return { ok: true, order: body as OrderPayload };
        }

        const parsed = (body ?? {}) as {
            message?: string;
            errors?: Record<string, string[]>;
        };

        return {
            ok: false,
            message: parsed.message ?? `Erro ${status} ao criar a cobrança.`,
            errors: parsed.errors,
        };
    } catch (error) {
        logger.error(
            { sessionId: input.session_id, err: (error as Error).message },
            'falha ao criar cobrança no painel',
        );

        return {
            ok: false,
            message: 'Não consegui falar com o servidor. Tente novamente.',
        };
    }
}

export async function fetchOrderStatus(
    sessionId: string,
    orderId: string,
): Promise<OrderPayload | null> {
    try {
        const { status, body } = await request(
            `/api/bot/orders/${orderId}/status`,
            { payload: { session_id: sessionId } },
        );

        return status === 200 ? (body as OrderPayload) : null;
    } catch (error) {
        logger.warn(
            { sessionId, orderId, err: (error as Error).message },
            'falha ao consultar status da cobrança',
        );

        return null;
    }
}
