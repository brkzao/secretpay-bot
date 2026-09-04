import { sessionsRepo } from '../db';
import { logger } from '../logger';

export type Outbound = {
    jid: string;
    text: string;
    at: string;
};

/**
 * Sessões falsas para teste: têm estado de conversa e ordem reais no Laravel,
 * mas nenhum socket do WhatsApp. O que seria enviado ao contato é guardado
 * aqui e consumido pelo REPL (`npm run simulate`).
 *
 * Só existe quando SIMULATION_ENABLED=true — em produção o mapa fica vazio e
 * as rotas /internal/simulate respondem 404.
 */
const simulated = new Map<string, { userId: string; outbox: Outbound[] }>();

const log = logger.child({ scope: 'simulator' });

export function registerSimulated(sessionId: string, userId: string): void {
    sessionsRepo.upsert(sessionId, userId);
    sessionsRepo.updateStatus(sessionId, 'connected', '5527900000000');
    // Não deve ser reaberta como sessão real no próximo boot.
    sessionsRepo.setAutoStart(sessionId, false);

    if (!simulated.has(sessionId)) {
        simulated.set(sessionId, { userId, outbox: [] });
        log.info({ sessionId }, 'sessão simulada registrada');
    }
}

export function unregisterSimulated(sessionId: string): void {
    simulated.delete(sessionId);
    sessionsRepo.delete(sessionId);
}

export function isSimulated(sessionId: string): boolean {
    return simulated.has(sessionId);
}

/** Captura o que seria enviado ao contato (respostas assíncronas, avisos). */
export function pushOutbound(sessionId: string, jid: string, text: string): void {
    const entry = simulated.get(sessionId);

    if (entry === undefined) {
        return;
    }

    entry.outbox.push({ jid, text, at: new Date().toISOString() });
}

export function drainOutbound(sessionId: string): Outbound[] {
    const entry = simulated.get(sessionId);

    if (entry === undefined) {
        return [];
    }

    return entry.outbox.splice(0, entry.outbox.length);
}
