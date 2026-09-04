import { z } from 'zod';

try {
    process.loadEnvFile();
} catch {
    // .env é opcional — em produção as variáveis vêm do ambiente.
}

const schema = z.object({
    PORT: z.coerce.number().int().positive().default(3333),
    HOST: z.string().min(1).default('0.0.0.0'),
    DATABASE_PATH: z.string().min(1).default('./data/bot.db'),
    LARAVEL_URL: z.string().min(1),
    BOT_SHARED_SECRET: z.string().min(16),
    LOG_LEVEL: z.string().min(1).default('info'),
    SESSION_BOOT_BATCH: z.coerce.number().int().positive().default(5),
    SESSION_BOOT_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
    CONVERSATION_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    // Faixa aceita, espelhando OMOPIX_MIN_AMOUNT/OMOPIX_MAX_AMOUNT do painel.
    // Quem manda de verdade e o adquirente do OmoPix: fora da faixa dele a
    // criacao responde 422, e validar aqui so serve para o erro ser instantaneo.
    MIN_ORDER_AMOUNT: z.coerce.number().positive().default(20),
    MAX_ORDER_AMOUNT: z.coerce.number().positive().default(1000),
    // Libera /internal/simulate/* (contas de teste sem WhatsApp real).
    SIMULATION_ENABLED: z
        .enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
    const issues = parsed.error.issues
        .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
        .join('\n');

    console.error(`Configuração inválida:\n${issues}`);
    process.exit(1);
}

export const config = {
    ...parsed.data,
    LARAVEL_URL: parsed.data.LARAVEL_URL.replace(/\/+$/, ''),
};

export type Config = typeof config;
