import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import type { GlobalFonts as GlobalFontsApi } from '@napi-rs/canvas';

import { logger } from '../logger';

type Fonts = typeof GlobalFontsApi;

const log = logger.child({ scope: 'receipt-fonts' });

/**
 * Ordem de preferência entre fontes do sistema. As duas primeiras são as que
 * costumam existir em container Linux enxuto (pacotes `dejavu_fonts` /
 * `liberation_ttf`); as demais cobrem macOS e Windows no desenvolvimento.
 */
const PREFERRED = [
    'DejaVu Sans',
    'Liberation Sans',
    'Noto Sans',
    'Inter',
    'Helvetica Neue',
    'Helvetica',
    'Segoe UI',
    'Arial',
];

const FONTS_DIR = resolve(__dirname, '../assets/fonts');

let resolved: string | null = null;

/**
 * Descobre uma família utilizável, uma única vez por processo.
 *
 * Fontes soltas em `src/assets/fonts` têm prioridade: registrá-las garante que o
 * comprovante saia idêntico em qualquer máquina, o que não acontece quando se
 * depende do que o sistema operacional tem instalado.
 */
export function resolveFontFamily(fonts: Fonts): string {
    if (resolved !== null) {
        return resolved;
    }

    resolved = registerBundledFonts(fonts) ?? pickSystemFont(fonts);

    return resolved;
}

function registerBundledFonts(fonts: Fonts): string | null {
    if (!existsSync(FONTS_DIR)) {
        return null;
    }

    const files = readdirSync(FONTS_DIR).filter((file) =>
        /\.(ttf|otf|ttc)$/i.test(file),
    );

    if (files.length === 0) {
        return null;
    }

    let family: string | null = null;

    for (const file of files) {
        const path = join(FONTS_DIR, file);

        // O segundo argumento vira o nome da família — fixamos para não
        // depender do nome interno do arquivo.
        if (fonts.registerFromPath(path, 'SecretPay Receipt')) {
            family = 'SecretPay Receipt';
        } else {
            log.warn({ file }, 'não consegui registrar a fonte');
        }
    }

    if (family !== null) {
        log.info({ files: files.length }, 'fontes do projeto registradas');
    }

    return family;
}

function pickSystemFont(fonts: Fonts): string {
    const available = new Set(fonts.families.map((font) => font.family));

    for (const family of PREFERRED) {
        if (available.has(family)) {
            log.info({ family }, 'usando fonte do sistema');

            return family;
        }
    }

    const fallback = fonts.families[0]?.family;

    if (fallback === undefined) {
        throw new Error(
            'Nenhuma fonte disponível para gerar o comprovante. Instale um pacote '+
                'de fontes no ambiente (ex.: dejavu_fonts) ou coloque um .ttf em '+
                'src/assets/fonts.',
        );
    }

    log.warn({ family: fallback }, 'nenhuma fonte preferida encontrada');

    return fallback;
}
