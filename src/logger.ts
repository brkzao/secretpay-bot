import pino from 'pino';

import { config } from './config';

export const logger = pino({
    level: config.LOG_LEVEL,
    base: undefined,
    redact: {
        paths: ['qr', '*.qr', 'creds', '*.creds'],
        censor: '[oculto]',
    },
});

/**
 * O Baileys é extremamente verboso mesmo em 'info'. Damos a ele um logger
 * silencioso por padrão e só abrimos quando LOG_LEVEL=trace.
 */
export const baileysLogger = pino({
    level: config.LOG_LEVEL === 'trace' ? 'debug' : 'silent',
    base: undefined,
});

export type Logger = typeof logger;
