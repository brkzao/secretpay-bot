import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { config } from './config';
import { currentTimestamp, sign } from './util/hmac';

/**
 * REPL de teste: você digita como se fosse o cliente no WhatsApp e vê o que o
 * bot responderia. Fala com o bot em execução pela mesma API interna assinada,
 * então o caminho exercitado é o real — máquina de estados, validações e
 * criação da ordem no Laravel. O único pedaço fora do circuito é o Baileys.
 *
 *   npm run simulate -- <session-id> [jid]
 */

const BASE_URL = `http://127.0.0.1:${config.PORT}`;
const OUTBOX_POLL_MS = 2000;

const GREY = '\x1b[90m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

async function call(path: string, payload: unknown): Promise<unknown> {
    const body = JSON.stringify(payload);
    const timestamp = currentTimestamp();

    const response = await fetch(`${BASE_URL}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Bot-Timestamp': timestamp,
            'X-Bot-Signature': sign(timestamp, body),
        },
        body,
    });

    const text = await response.text();
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : null;

    if (!response.ok) {
        const message =
            (parsed as { message?: string } | null)?.message ??
            `HTTP ${response.status}`;

        throw new Error(message);
    }

    return parsed;
}

function printBot(text: string): void {
    const lines = text.split('\n');

    stdout.write(`${GREEN}bot${RESET} ${GREY}│${RESET} ${lines[0] ?? ''}\n`);

    for (const line of lines.slice(1)) {
        stdout.write(`    ${GREY}│${RESET} ${line}\n`);
    }

    stdout.write('\n');
}

function printNotice(text: string): void {
    stdout.write(`${YELLOW}🔔  aviso assíncrono${RESET}\n`);
    printBot(text);
}

async function main(): Promise<void> {
    const [sessionId, jidArg] = process.argv.slice(2);

    if (sessionId === undefined) {
        stdout.write(
            'Uso: npm run simulate -- <session-id> [jid]\n\n' +
                'Pegue o session-id rodando no painel Laravel:\n' +
                '  php artisan whatsapp:simular\n',
        );
        process.exit(1);
    }

    if (!config.SIMULATION_ENABLED) {
        stdout.write(
            `${YELLOW}SIMULATION_ENABLED não está true no .env do bot.${RESET}\n` +
                'Defina SIMULATION_ENABLED=true e reinicie o bot.\n',
        );
        process.exit(1);
    }

    const jid = jidArg ?? '5527999999999@s.whatsapp.net';

    try {
        await call('/internal/simulate/sessions', { session_id: sessionId });
    } catch (error) {
        stdout.write(
            `${YELLOW}Não consegui registrar a sessão simulada:${RESET} ${(error as Error).message}\n` +
                `O bot está rodando em ${BASE_URL}? (npm run dev)\n`,
        );
        process.exit(1);
    }

    stdout.write(
        `\n${CYAN}Conversa simulada${RESET}\n` +
            `${GREY}sessão ${sessionId}${RESET}\n` +
            `${GREY}contato ${jid}${RESET}\n\n` +
            `${GREY}Digite como se fosse o cliente. /reset limpa a conversa, /sair encerra.${RESET}\n` +
            `${GREY}A ordem só é criada de verdade quando você confirmar com 1 no resumo.${RESET}\n\n`,
    );

    const outboxTimer = setInterval(() => {
        void (async () => {
            try {
                const result = (await call('/internal/simulate/outbox', {
                    session_id: sessionId,
                })) as { messages?: { text: string }[] };

                for (const message of result.messages ?? []) {
                    printNotice(message.text);
                }
            } catch {
                // bot pode ter caído — o próximo envio mostra o erro
            }
        })();
    }, OUTBOX_POLL_MS);

    const rl = createInterface({ input: stdin, output: stdout });

    rl.on('close', () => {
        clearInterval(outboxTimer);
        stdout.write(`\n${GREY}encerrado${RESET}\n`);
        process.exit(0);
    });

    for (;;) {
        const input = (await rl.question(`${CYAN}você${RESET} ${GREY}│${RESET} `)).trim();

        if (input === '') {
            continue;
        }

        if (input === '/sair' || input === '/quit') {
            break;
        }

        if (input === '/reset') {
            await call('/internal/simulate/reset', {
                session_id: sessionId,
                jid,
            });

            stdout.write(`${GREY}conversa reiniciada${RESET}\n\n`);

            continue;
        }

        stdout.write('\n');

        try {
            const result = (await call('/internal/simulate/messages', {
                session_id: sessionId,
                jid,
                text: input,
            })) as { replies?: string[] };

            for (const reply of result.replies ?? []) {
                printBot(reply);
            }
        } catch (error) {
            stdout.write(`${YELLOW}erro:${RESET} ${(error as Error).message}\n\n`);
        }
    }

    rl.close();
}

void main().catch((error: Error) => {
    stdout.write(`erro: ${error.message}\n`);
    process.exit(1);
});
