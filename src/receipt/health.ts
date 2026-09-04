import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { resolveFontFamily } from './fonts';
import { loadCanvas, renderReceipt } from './renderer';

const LOGO_PATH = resolve(__dirname, '../assets/logo.jpg');

export type ReceiptHealth = {
    ok: boolean;
    font: string | null;
    logo: boolean;
    bytes: number | null;
    error: string | null;
};

/**
 * Prova que o gerador funciona **de verdade**, renderizando um comprovante de
 * teste e descartando o resultado. Checar só se o módulo carrega não bastaria:
 * o modo de falha mais provável em container é fonte ausente, que só aparece na
 * hora de desenhar o texto.
 *
 * Nunca lança. O comprovante é acessório; o bot precisa subir mesmo sem ele.
 */
export async function checkReceiptSupport(): Promise<ReceiptHealth> {
    const logo = existsSync(LOGO_PATH);

    try {
        const { GlobalFonts } = await loadCanvas();
        const font = resolveFontFamily(GlobalFonts);

        const image = await renderReceipt(
            {
                amount: 1,
                paidAt: new Date(0),
            },
            { format: 'jpeg', quality: 40 },
        );

        return { ok: true, font, logo, bytes: image.length, error: null };
    } catch (error) {
        return {
            ok: false,
            font: null,
            logo,
            bytes: null,
            // Só a primeira linha: erros de módulo trazem o require stack junto.
            error:
                (error as Error).message.split('\n')[0] ?? 'erro desconhecido',
        };
    }
}
