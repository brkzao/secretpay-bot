import { createHmac, timingSafeEqual } from 'node:crypto';

import { config } from '../config';

/** Janela de tolerância do timestamp — bloqueia replay de requisições antigas. */
const MAX_SKEW_SECONDS = 300;

export function sign(timestamp: string, body: string): string {
    return createHmac('sha256', config.BOT_SHARED_SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex');
}

export function currentTimestamp(): string {
    return Math.floor(Date.now() / 1000).toString();
}

export function verify(
    timestamp: string | undefined,
    signature: string | undefined,
    body: string,
): boolean {
    if (!timestamp || !signature) {
        return false;
    }

    const parsed = Number(timestamp);

    if (!Number.isFinite(parsed)) {
        return false;
    }

    if (Math.abs(Math.floor(Date.now() / 1000) - parsed) > MAX_SKEW_SECONDS) {
        return false;
    }

    const expected = Buffer.from(sign(timestamp, body), 'utf8');
    const received = Buffer.from(signature, 'utf8');

    if (expected.length !== received.length) {
        return false;
    }

    return timingSafeEqual(expected, received);
}
