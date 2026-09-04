import { config } from '../config';
import { sessionsRepo, type SessionRow } from '../db';
import { logger } from '../logger';
import { WaSession } from './session';

const log = logger.child({ scope: 'session-manager' });

/**
 * Um processo Node segura centenas de sockets Baileys — o limite prático é
 * memória, não CPU. Quando passar disso, dê um shard por réplica: o estado
 * já mora no banco, então basta filtrar por `hash(id) % réplicas`.
 */
class SessionManager {
    private readonly sessions = new Map<string, WaSession>();

    /** Cria (ou reaproveita) a sessão e abre o socket. */
    async ensure(id: string, userId: string): Promise<WaSession> {
        sessionsRepo.upsert(id, userId);

        let session = this.sessions.get(id);

        if (session === undefined) {
            session = new WaSession(id, userId);
            this.sessions.set(id, session);
        }

        await session.start();

        return session;
    }

    get(id: string): WaSession | undefined {
        return this.sessions.get(id);
    }

    /** Encerra o vínculo no aparelho, apaga credenciais e remove do banco. */
    async remove(id: string): Promise<void> {
        const session = this.sessions.get(id);

        if (session !== undefined) {
            await session.logout();
            this.sessions.delete(id);
        }

        sessionsRepo.delete(id);
    }

    status(id: string): SessionRow | null {
        return sessionsRepo.find(id);
    }

    /**
     * Reconecta em lotes escalonados. Subir 200 sockets de uma vez é convite
     * a rate-limit do WhatsApp.
     */
    async bootAll(): Promise<void> {
        const rows = sessionsRepo.startable();

        if (rows.length === 0) {
            log.info('nenhuma sessão para restaurar');

            return;
        }

        log.info({ total: rows.length }, 'restaurando sessões');

        for (let i = 0; i < rows.length; i += config.SESSION_BOOT_BATCH) {
            const batch = rows.slice(i, i + config.SESSION_BOOT_BATCH);

            await Promise.all(
                batch.map(async (row) => {
                    try {
                        await this.ensure(row.id, row.user_id);
                    } catch (error) {
                        log.error(
                            { sessionId: row.id, err: (error as Error).message },
                            'falha ao restaurar sessão',
                        );
                    }
                }),
            );

            if (i + config.SESSION_BOOT_BATCH < rows.length) {
                await delay(config.SESSION_BOOT_DELAY_MS);
            }
        }
    }

    async shutdown(): Promise<void> {
        await Promise.all(
            [...this.sessions.values()].map((session) => session.stop()),
        );

        this.sessions.clear();
    }
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export const sessionManager = new SessionManager();
