import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Só tipos: `import type` é apagado na compilação, então importar este módulo
// não carrega o binário nativo do canvas. Ele entra sob demanda em loadCanvas(),
// para que um problema com ele derrube o comprovante, nunca o bot inteiro.
import type { Image, SKRSContext2D } from '@napi-rs/canvas';

import { logger } from '../logger';
import { resolveFontFamily } from './fonts';
import type { ReceiptData, ReceiptOptions } from './types';

type CanvasModule = typeof import('@napi-rs/canvas');

let canvasModule: CanvasModule | null = null;

/** Carrega o @napi-rs/canvas na primeira renderização e reaproveita depois. */
export async function loadCanvas(): Promise<CanvasModule> {
    if (canvasModule === null) {
        canvasModule = await import('@napi-rs/canvas');
    }

    return canvasModule;
}

const log = logger.child({ scope: 'receipt' });

const LOGO_PATH = resolve(__dirname, '../assets/logo.jpg');

/** Paleta alinhada à marca do painel e à própria logo. */
const COLOR = {
    page: '#EEF2F8',
    card: '#FFFFFF',
    brand: '#2563A8',
    brandDark: '#16305C',
    accent: '#3B8FD9',
    ink: '#0B1524',
    muted: '#6B7A8C',
    line: '#E3E8F0',
};

const WIDTH = 1080;
const PADDING = 72;
const CARD_MARGIN = 40;
const ROW_HEIGHT = 62;
const SECTION_TITLE_HEIGHT = 58;
const SECTION_GAP = 28;

type Row = { label: string; value: string; strong?: boolean };
type Section = { title: string; rows: Row[] };

let logoPromise: Promise<Image | null> | null = null;

/**
 * Desenha o comprovante e devolve os bytes da imagem.
 *
 * Puro: não conhece sessão, ordem nem WhatsApp. Recebe dados, devolve imagem.
 */
export async function renderReceipt(
    data: ReceiptData,
    options: ReceiptOptions = {},
): Promise<Buffer> {
    const { createCanvas, GlobalFonts } = await loadCanvas();

    const family = resolveFontFamily(GlobalFonts);
    const sections = buildSections(data);
    const paidAt = data.paidAt ?? new Date();

    const cardTop = CARD_MARGIN;
    const headerHeight = 232;
    const heroHeight = 250;
    const sectionsHeight = sections.reduce(
        (total, section) =>
            total +
            SECTION_TITLE_HEIGHT +
            section.rows.length * ROW_HEIGHT +
            SECTION_GAP,
        0,
    );
    const footerHeight = 140;
    const cardHeight =
        headerHeight + heroHeight + sectionsHeight + footerHeight;
    const height = cardHeight + CARD_MARGIN * 2;

    const canvas = createCanvas(WIDTH, height);
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = COLOR.page;
    ctx.fillRect(0, 0, WIDTH, height);

    drawCard(ctx, cardTop, cardHeight);

    let y = cardTop;

    y = await drawHeader(ctx, family, y, headerHeight);
    y = drawHero(ctx, family, y, heroHeight, data.amount, paidAt);

    for (const section of sections) {
        y = drawSection(ctx, family, y, section);
    }

    drawFooter(ctx, family, cardTop + cardHeight - footerHeight, footerHeight);

    const buffer =
        options.format === 'png'
            ? await canvas.encode('png')
            : await canvas.encode('jpeg', options.quality ?? 92);

    log.debug(
        { bytes: buffer.length, format: options.format ?? 'jpeg' },
        'comprovante gerado',
    );

    return buffer;
}

function buildSections(data: ReceiptData): Section[] {
    const sections: Section[] = [];

    const payer: Row[] = [];

    if (data.payerName) {
        payer.push({ label: 'Nome', value: data.payerName, strong: true });
    }

    if (data.payerDocument) {
        payer.push({ label: 'Documento', value: data.payerDocument });
    }

    if (payer.length > 0) {
        sections.push({ title: 'Pagador', rows: payer });
    }

    const identification: Row[] = [];

    if (data.endToEndId) {
        // Vai inteiro: o E2E é o que o pagador leva ao banco dele para
        // rastrear o Pix, e abreviar tiraria justamente a utilidade do campo.
        identification.push({
            label: 'ID da transação',
            value: data.endToEndId,
        });
    }

    if (data.orderCode) {
        identification.push({
            label: 'Código da cobrança',
            value: data.orderCode,
        });
    }

    if (identification.length > 0) {
        sections.push({ title: 'Identificação', rows: identification });
    }

    return sections;
}

function drawCard(ctx: SKRSContext2D, top: number, height: number): void {
    ctx.save();
    ctx.shadowColor = 'rgba(11, 21, 36, 0.10)';
    ctx.shadowBlur = 32;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = COLOR.card;
    roundedRect(ctx, CARD_MARGIN, top, WIDTH - CARD_MARGIN * 2, height, 36);
    ctx.fill();
    ctx.restore();

    // Faixa da marca no topo, recortada pelo arredondamento do cartão.
    ctx.save();
    roundedRect(ctx, CARD_MARGIN, top, WIDTH - CARD_MARGIN * 2, height, 36);
    ctx.clip();

    const gradient = ctx.createLinearGradient(
        CARD_MARGIN,
        top,
        WIDTH - CARD_MARGIN,
        top,
    );
    gradient.addColorStop(0, COLOR.brandDark);
    gradient.addColorStop(1, COLOR.accent);

    ctx.fillStyle = gradient;
    ctx.fillRect(CARD_MARGIN, top, WIDTH - CARD_MARGIN * 2, 12);
    ctx.restore();
}

async function drawHeader(
    ctx: SKRSContext2D,
    family: string,
    top: number,
    height: number,
): Promise<number> {
    const logo = await loadLogo();
    const left = CARD_MARGIN + PADDING;
    const centerY = top + 12 + (height - 12) / 2;

    let textLeft = left;

    if (logo !== null) {
        const size = 112;
        const logoY = centerY - size / 2;

        // O arquivo tem margem branca em volta do selo; ampliamos dentro do
        // recorte para o selo ocupar o círculo em vez de flutuar no meio dele.
        const zoom = 1.18;
        const drawn = size * zoom;
        const inset = (drawn - size) / 2;

        ctx.save();
        ctx.beginPath();
        ctx.arc(left + size / 2, logoY + size / 2, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(logo, left - inset, logoY - inset, drawn, drawn);
        ctx.restore();

        textLeft = left + size + 28;
    }

    ctx.textAlign = 'left';
    ctx.fillStyle = COLOR.ink;
    ctx.font = `600 34px "${family}"`;
    ctx.fillText('Comprovante de pagamento', textLeft, centerY - 6);

    ctx.fillStyle = COLOR.muted;
    ctx.font = `400 26px "${family}"`;
    ctx.fillText('Pix • SecretPay', textLeft, centerY + 34);

    return top + height;
}

function drawHero(
    ctx: SKRSContext2D,
    family: string,
    top: number,
    height: number,
    amount: number,
    paidAt: Date,
): number {
    const left = CARD_MARGIN + PADDING;
    let y = top;

    // Selo de conclusão
    const badgeText = 'Pagamento confirmado';
    ctx.font = `600 24px "${family}"`;
    const badgeWidth = ctx.measureText(badgeText).width + 92;
    const badgeHeight = 56;

    ctx.fillStyle = 'rgba(59, 143, 217, 0.14)';
    roundedRect(ctx, left, y, badgeWidth, badgeHeight, badgeHeight / 2);
    ctx.fill();

    drawCheck(ctx, left + 32, y + badgeHeight / 2, 11);

    ctx.fillStyle = COLOR.brand;
    ctx.textAlign = 'left';
    ctx.fillText(badgeText, left + 60, y + badgeHeight / 2 + 9);

    y += badgeHeight + 46;

    ctx.fillStyle = COLOR.muted;
    ctx.font = `500 24px "${family}"`;
    ctx.fillText('Valor', left, y);

    y += 62;

    ctx.fillStyle = COLOR.ink;
    ctx.font = `700 68px "${family}"`;
    ctx.fillText(formatBrl(amount), left, y);

    y += 46;

    ctx.fillStyle = COLOR.muted;
    ctx.font = `400 25px "${family}"`;
    ctx.fillText(formatDateTime(paidAt), left, y);

    return top + height;
}

function drawSection(
    ctx: SKRSContext2D,
    family: string,
    top: number,
    section: Section,
): number {
    const left = CARD_MARGIN + PADDING;
    const right = WIDTH - CARD_MARGIN - PADDING;

    line(ctx, left, top + 8, right);

    ctx.textAlign = 'left';
    ctx.fillStyle = COLOR.brand;
    ctx.font = `700 22px "${family}"`;
    ctx.fillText(section.title.toUpperCase(), left, top + 50);

    let y = top + SECTION_TITLE_HEIGHT;

    for (const row of section.rows) {
        ctx.textAlign = 'left';
        ctx.fillStyle = COLOR.muted;
        ctx.font = `400 26px "${family}"`;
        ctx.fillText(row.label, left, y + 40);

        ctx.textAlign = 'right';
        ctx.fillStyle = COLOR.ink;
        ctx.font = `${row.strong === true ? 600 : 400} 27px "${family}"`;
        ctx.fillText(fit(ctx, row.value, right - left - 320), right, y + 40);

        y += ROW_HEIGHT;
    }

    return y + SECTION_GAP;
}

function drawFooter(
    ctx: SKRSContext2D,
    family: string,
    top: number,
    height: number,
): void {
    const left = CARD_MARGIN + PADDING;
    const right = WIDTH - CARD_MARGIN - PADDING;

    line(ctx, left, top + 20, right);

    ctx.textAlign = 'center';
    ctx.fillStyle = COLOR.muted;
    ctx.font = `400 23px "${family}"`;
    ctx.fillText(
        'Este comprovante foi gerado automaticamente pela SecretPay.',
        WIDTH / 2,
        top + height / 2 + 8,
    );

    ctx.fillStyle = COLOR.brand;
    ctx.font = `600 23px "${family}"`;
    ctx.fillText('secretpay.com.br', WIDTH / 2, top + height / 2 + 46);
}

/* -------------------------------------------------------------------------- */
/*  Primitivas                                                                */
/* -------------------------------------------------------------------------- */

function roundedRect(
    ctx: SKRSContext2D,
    x: number,
    y: number,
    width: number,
    height: number,
    radius: number,
): void {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + width - radius, y);
    ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
    ctx.lineTo(x + width, y + height - radius);
    ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    ctx.lineTo(x + radius, y + height);
    ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
}

function line(
    ctx: SKRSContext2D,
    left: number,
    y: number,
    right: number,
): void {
    ctx.strokeStyle = COLOR.line;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
}

function drawCheck(
    ctx: SKRSContext2D,
    cx: number,
    cy: number,
    radius: number,
): void {
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = COLOR.accent;
    ctx.fill();

    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - 5, cy);
    ctx.lineTo(cx - 1.5, cy + 4);
    ctx.lineTo(cx + 5.5, cy - 4);
    ctx.stroke();
}

/** Encurta o texto até caber, preservando o fim (útil para hashes). */
function fit(ctx: SKRSContext2D, text: string, maxWidth: number): string {
    if (ctx.measureText(text).width <= maxWidth) {
        return text;
    }

    let output = text;

    while (
        output.length > 8 &&
        ctx.measureText(`${output}…`).width > maxWidth
    ) {
        output = output.slice(0, -1);
    }

    return `${output}…`;
}

function formatBrl(value: number): string {
    return value.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
    });
}

function formatDateTime(date: Date): string {
    const formatted = date.toLocaleString('pt-BR', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'America/Sao_Paulo',
    });

    return formatted.replace(',', ' às');
}

async function loadLogo(): Promise<Image | null> {
    if (logoPromise === null) {
        logoPromise = (async () => {
            if (!existsSync(LOGO_PATH)) {
                log.warn({ path: LOGO_PATH }, 'logo não encontrada');

                return null;
            }

            try {
                const { loadImage } = await loadCanvas();

                return await loadImage(LOGO_PATH);
            } catch (error) {
                log.warn(
                    { err: (error as Error).message },
                    'não consegui carregar a logo',
                );

                return null;
            }
        })();
    }

    return logoPromise;
}
