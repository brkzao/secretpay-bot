import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { stdout } from 'node:process';

import { renderReceipt, type ReceiptData } from './receipt';

/**
 * Gera comprovantes de exemplo em arquivo, para inspecionar o layout sem
 * depender de WhatsApp nem de ordem real.
 *
 *   npm run receipt:preview [-- caminho/de/saida.png]
 */

const MOCKS: { name: string; data: ReceiptData }[] = [
    {
        name: 'completo',
        data: {
            amount: 1500,
            payerName: 'Maria Aparecida da Silva',
            payerDocument: '279.957.530-74',
            endToEndId: 'E00416968202608061847ABCD5678EFGH',
            orderCode: '019FCEC7',
            paidAt: new Date('2026-08-06T18:47:00-03:00'),
        },
    },
    {
        name: 'minimo',
        data: {
            amount: 45.9,
            paidAt: new Date('2026-08-06T09:05:00-03:00'),
        },
    },
    {
        name: 'sem-documento',
        data: {
            amount: 87234.56,
            payerName: 'Comércio de Eletrônicos Boa Vista LTDA',
            endToEndId: 'E00416968202608062359WXYZ1234IJKL',
            orderCode: '019FCF20',
            paidAt: new Date('2026-08-06T23:59:00-03:00'),
        },
    },
];

async function main(): Promise<void> {
    const target = process.argv[2];
    const outDir =
        target !== undefined ? dirname(resolve(target)) : resolve('preview');

    mkdirSync(outDir, { recursive: true });

    for (const mock of MOCKS) {
        const buffer = await renderReceipt(mock.data, { format: 'png' });

        const path =
            target !== undefined && MOCKS.length === 1
                ? resolve(target)
                : resolve(outDir, `comprovante-${mock.name}.png`);

        writeFileSync(path, buffer);

        stdout.write(
            `${mock.name.padEnd(18)} ${(buffer.length / 1024).toFixed(0).padStart(5)} KB  ${path}\n`,
        );
    }

    // O JPEG é o formato de envio: mesma imagem, arquivo bem menor.
    const jpeg = await renderReceipt(MOCKS[0]!.data, { format: 'jpeg' });
    const jpegPath = resolve(outDir, 'comprovante-completo.jpg');

    writeFileSync(jpegPath, jpeg);

    stdout.write(
        `${'completo (jpeg)'.padEnd(18)} ${(jpeg.length / 1024).toFixed(0).padStart(5)} KB  ${jpegPath}\n`,
    );
}

void main().catch((error: Error) => {
    stdout.write(`erro: ${error.message}\n${error.stack ?? ''}\n`);
    process.exit(1);
});
