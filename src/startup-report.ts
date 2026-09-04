import { accessSync, constants, statfsSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { stdout } from 'node:process';

import { config } from './config';
import { sessionsRepo } from './db';
import { checkReceiptSupport } from './receipt';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const GREY = '\x1b[90m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const OK = `${GREEN}✓${RESET}`;
const FAIL = `${RED}✗${RESET}`;
const WARN = `${YELLOW}!${RESET}`;

type Line = { mark: string; label: string; value: string; note?: string };

/**
 * Diagnóstico impresso uma vez, no boot. É para leitura humana logo depois de
 * um deploy — responde "subiu inteiro?" sem precisar caçar linha por linha nos
 * logs JSON.
 */
export async function printStartupReport(): Promise<void> {
    const lines: Line[] = [];

    lines.push({
        mark: OK,
        label: 'node',
        value: process.version,
        note: supportsNodeSqlite() ? undefined : 'node:sqlite exige >= 22.13',
    });

    lines.push({
        mark: OK,
        label: 'servidor',
        value: `${config.HOST}:${config.PORT}`,
        note: config.HOST === '0.0.0.0' ? 'em rede IPv6 use HOST=::' : undefined,
    });

    lines.push({ mark: OK, label: 'painel', value: config.LARAVEL_URL });

    lines.push({
        mark: OK,
        label: 'segredo HMAC',
        value: `definido (${config.BOT_SHARED_SECRET.length} caracteres)`,
    });

    lines.push(databaseLine());

    lines.push({
        mark: config.SIMULATION_ENABLED ? WARN : OK,
        label: 'simulação',
        value: config.SIMULATION_ENABLED ? 'ATIVA' : 'desativada',
        note: config.SIMULATION_ENABLED
            ? 'rotas /internal/simulate abertas — não use em produção'
            : undefined,
    });

    const receipt = await checkReceiptSupport();

    lines.push({
        mark: receipt.ok ? OK : FAIL,
        label: 'comprovantes',
        value: receipt.ok
            ? `fonte ${receipt.font} · logo ${receipt.logo ? 'ok' : 'ausente'} · teste ${formatKb(receipt.bytes)}`
            : 'INDISPONÍVEL',
        note: receipt.ok
            ? receipt.logo
                ? undefined
                : 'sem logo: o comprovante sai sem marca'
            : `${receipt.error} — o bot funciona, mas não enviará comprovantes`,
    });

    const pending = sessionsRepo.startable().length;

    lines.push({
        mark: OK,
        label: 'sessões',
        value: pending === 0 ? 'nenhuma para restaurar' : `${pending} a restaurar`,
    });

    render(lines);
}

function databaseLine(): Line {
    const path = resolve(config.DATABASE_PATH);
    const insideApp = !relative(process.cwd(), path).startsWith('..');

    let writable = true;

    try {
        accessSync(dirname(path), constants.W_OK);
    } catch {
        writable = false;
    }

    if (!writable) {
        return { mark: FAIL, label: 'banco', value: path, note: 'sem permissão de escrita' };
    }

    const free = freeSpace(dirname(path));
    const value = free === null ? path : `${path}  ${GREY}(${free} livres)${RESET}`;

    // Volume cheio derruba uma sessão por vez, conforme cada uma tenta gravar —
    // parece falha isolada do WhatsApp e não é.
    if (free !== null && free.endsWith('MB') && Number(free.replace(' MB', '')) < 50) {
        return { mark: WARN, label: 'banco', value, note: 'pouco espaço livre no volume' };
    }

    // Caminho relativo cai em /app no container: fora do volume, some no deploy.
    return insideApp
        ? {
              mark: WARN,
              label: 'banco',
              value,
              note: 'dentro do diretório da aplicação — sem volume, as sessões somem a cada deploy',
          }
        : { mark: OK, label: 'banco', value };
}

function freeSpace(directory: string): string | null {
    try {
        const stats = statfsSync(directory);
        const bytes = Number(stats.bavail) * Number(stats.bsize);

        return bytes >= 1024 ** 3
            ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
            : `${Math.round(bytes / 1024 ** 2)} MB`;
    } catch {
        return null;
    }
}

function render(lines: Line[]): void {
    const width = Math.max(...lines.map((line) => line.label.length));

    stdout.write(`\n${BOLD}SecretPay Bot${RESET} ${GREY}— verificação de inicialização${RESET}\n\n`);

    for (const line of lines) {
        stdout.write(
            `  ${line.mark} ${GREY}${line.label.padEnd(width)}${RESET}  ${line.value}\n`,
        );

        if (line.note !== undefined) {
            stdout.write(`    ${' '.repeat(width)}${YELLOW}↳ ${line.note}${RESET}\n`);
        }
    }

    const broken = lines.filter((line) => line.mark === FAIL).length;

    stdout.write(
        broken === 0
            ? `\n  ${GREEN}tudo pronto${RESET}\n\n`
            : `\n  ${RED}${broken} item(ns) com problema${RESET} ${GREY}— o bot subiu mesmo assim${RESET}\n\n`,
    );
}

function supportsNodeSqlite(): boolean {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);

    return major > 22 || (major === 22 && minor >= 13);
}

function formatKb(bytes: number | null): string {
    return bytes === null ? '—' : `${Math.round(bytes / 1024)} KB`;
}
