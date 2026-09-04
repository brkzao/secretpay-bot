import { config } from '../config';
import { conversationsRepo } from '../db';

export type Step = 'MENU' | 'AMOUNT' | 'CONFIRM';

export type Draft = {
    amount?: number;
};

export type ConversationState = {
    step: Step;
    draft: Draft;
    lastOrderId?: string;
    idempotencyKey?: string;
};

const INITIAL: ConversationState = { step: 'MENU', draft: {} };

export function loadState(sessionId: string, jid: string): ConversationState {
    const row = conversationsRepo.find(sessionId, jid);

    if (row === null) {
        return { ...INITIAL, draft: {} };
    }

    // expires_at é gravado em UTC no formato 'YYYY-MM-DD HH:MM:SS'.
    if (
        new Date(`${row.expires_at.replace(' ', 'T')}Z`).getTime() < Date.now()
    ) {
        conversationsRepo.delete(sessionId, jid);

        return { ...INITIAL, draft: {} };
    }

    try {
        const parsed = JSON.parse(row.data) as Partial<ConversationState>;

        return {
            step: row.step as Step,
            draft: parsed.draft ?? {},
            lastOrderId: parsed.lastOrderId,
            idempotencyKey: parsed.idempotencyKey,
        };
    } catch {
        return { ...INITIAL, draft: {} };
    }
}

export function saveState(
    sessionId: string,
    jid: string,
    state: ConversationState,
): void {
    const expiresAt = new Date(
        Date.now() + config.CONVERSATION_TTL_MINUTES * 60_000,
    )
        .toISOString()
        .replace('T', ' ')
        .slice(0, 19);

    conversationsRepo.save(
        sessionId,
        jid,
        state.step,
        JSON.stringify({
            draft: state.draft,
            lastOrderId: state.lastOrderId,
            idempotencyKey: state.idempotencyKey,
        }),
        expiresAt,
    );
}

/** Zera o rascunho mas preserva a referência da última ordem (comando "status"). */
export function resetState(
    sessionId: string,
    jid: string,
    previous: ConversationState,
): ConversationState {
    const next: ConversationState = {
        step: 'MENU',
        draft: {},
        lastOrderId: previous.lastOrderId,
    };

    saveState(sessionId, jid, next);

    return next;
}

export function purgeExpiredConversations(): number {
    return conversationsRepo.purgeExpired();
}
