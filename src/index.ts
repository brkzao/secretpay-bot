import { config } from './config';
import { purgeExpiredConversations } from './conversation/store';
import { closeDatabase } from './db';
import { logger } from './logger';
import { buildServer } from './server';
import { printStartupReport } from './startup-report';
import { sessionManager } from './wa/session-manager';

const PURGE_INTERVAL_MS = 5 * 60_000;

async function main(): Promise<void> {
    const app = buildServer();

    await app.listen({ port: config.PORT, host: config.HOST });

    logger.info({ port: config.PORT }, 'servidor interno no ar');

    // Diagnóstico para humanos, logo após o deploy. Nunca lança: um problema
    // aqui não pode impedir o bot de atender.
    await printStartupReport().catch((error: Error) => {
        logger.warn({ err: error.message }, 'falha ao imprimir o diagnóstico');
    });

    const purgeTimer = setInterval(() => {
        const removed = purgeExpiredConversations();

        if (removed > 0) {
            logger.debug({ removed }, 'conversas expiradas removidas');
        }
    }, PURGE_INTERVAL_MS);

    purgeTimer.unref();

    // Restaura em segundo plano: o healthcheck não pode esperar 200 sockets.
    void sessionManager.bootAll().catch((error: Error) => {
        logger.error({ err: error.message }, 'falha ao restaurar sessões');
    });

    let shuttingDown = false;

    const shutdown = async (signal: string): Promise<void> => {
        if (shuttingDown) {
            return;
        }

        shuttingDown = true;
        logger.info({ signal }, 'encerrando');

        clearInterval(purgeTimer);

        try {
            await app.close();
            await sessionManager.shutdown();
            closeDatabase();
        } catch (error) {
            logger.error({ err: (error as Error).message }, 'erro no shutdown');
        }

        process.exit(0);
    };

    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
}

// Um handler que estoura não pode derrubar as outras sessões do processo.
process.on('unhandledRejection', (reason) => {
    logger.error({ reason: String(reason) }, 'promise rejeitada sem tratamento');
});

process.on('uncaughtException', (error) => {
    logger.error({ err: error.message, stack: error.stack }, 'exceção não capturada');
});

void main().catch((error: Error) => {
    logger.error({ err: error.message, stack: error.stack }, 'falha ao iniciar');
    process.exit(1);
});
