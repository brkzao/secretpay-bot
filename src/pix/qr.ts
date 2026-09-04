import qrcode from 'qrcode-generator';

import { loadCanvas } from '../receipt/renderer';

/** Lado da imagem final, em pixels. Cabe na prévia do WhatsApp sem esticar. */
const SIZE = 720;

/** Quiet zone exigida pela especificação do QR: 4 módulos de cada lado. */
const MARGIN_MODULES = 4;

/**
 * Desenha o BR Code (copia e cola) como imagem para o pagador apontar a câmera.
 *
 * Nível de correção M: o payload do Pix é longo, e um nível mais alto engordaria
 * a matriz a ponto de os módulos ficarem pequenos demais para a câmera pegar.
 */
export async function renderPixQr(payload: string): Promise<Buffer> {
    const { createCanvas } = await loadCanvas();

    // Tipo 0 = deixa a biblioteca escolher a menor versão que comporta o payload.
    const qr = qrcode(0, 'M');
    qr.addData(payload);
    qr.make();

    const modules = qr.getModuleCount();
    const total = modules + MARGIN_MODULES * 2;
    // Inteiro: um passo fracionário deixaria os módulos com bordas borradas,
    // que é justamente o que atrapalha a leitura.
    const scale = Math.max(1, Math.floor(SIZE / total));
    const side = total * scale;

    const canvas = createCanvas(side, side);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, side, side);

    ctx.fillStyle = '#0B1524';

    for (let row = 0; row < modules; row++) {
        for (let col = 0; col < modules; col++) {
            if (qr.isDark(row, col)) {
                ctx.fillRect(
                    (col + MARGIN_MODULES) * scale,
                    (row + MARGIN_MODULES) * scale,
                    scale,
                    scale,
                );
            }
        }
    }

    // PNG e não JPEG: a compressão com perdas do JPEG suja as bordas dos
    // módulos e é exatamente o tipo de artefato que quebra a leitura do QR.
    return canvas.encode('png');
}
