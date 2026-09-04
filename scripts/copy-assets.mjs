import { cpSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * O `tsc` só emite JavaScript. A logo (e qualquer fonte em src/assets/fonts)
 * precisa ser copiada à mão, senão `node dist/index.js` gera comprovante sem
 * marca — e sem erro nenhum, o que é pior.
 */
const from = resolve('src/assets');
const to = resolve('dist/assets');

if (!existsSync(from)) {
    console.warn('[copy-assets] src/assets não existe; nada a copiar.');
    process.exit(0);
}

cpSync(from, to, { recursive: true });

console.log(`[copy-assets] ${from} -> ${to}`);
