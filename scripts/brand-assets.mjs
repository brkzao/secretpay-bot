/**
 * Gera os ícones da marca SecretPay.
 *
 * Os arquivos da marca anterior eram um selo verde vetorizado a partir de um
 * bitmap: 82 KB de paths com dezenas de preenchimentos quase brancos,
 * impossível de recolorir por busca e substituição. Mais simples redesenhar.
 *
 *   node scripts/brand-assets.mjs
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const SITE = resolve('../whats-site');

const NAVY = '#16305C';
const ACCENT = '#3B8FD9';

/** Mesma heurística do comprovante: usa a primeira fonte do sistema que existir. */
function family() {
    const preferred = ['Geist', 'Segoe UI', 'Inter', 'DejaVu Sans', 'Arial'];
    const available = new Set(GlobalFonts.families.map((f) => f.family));

    return preferred.find((name) => available.has(name)) ?? 'sans-serif';
}

/**
 * Desenha o monograma: círculo marinho com "S" branco e "P" no azul de
 * destaque, ecoando o "Secret" + "Pay" do wordmark.
 */
function mark(size) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    const half = size / 2;

    ctx.fillStyle = NAVY;
    ctx.beginPath();
    ctx.arc(half, half, half, 0, Math.PI * 2);
    ctx.fill();

    const font = `700 ${Math.round(size * 0.42)}px "${family()}"`;
    ctx.font = font;
    ctx.textBaseline = 'middle';

    const s = 'S';
    const p = 'P';
    const total = ctx.measureText(s + p).width;
    const left = half - total / 2;

    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.fillText(s, left, half + size * 0.015);

    ctx.fillStyle = ACCENT;
    ctx.fillText(p, left + ctx.measureText(s).width, half + size * 0.015);

    return canvas;
}

/**
 * Empacota PNGs num contêiner .ico. PNG dentro de ICO é suportado por todo
 * navegador atual e evita ter de escrever bitmaps DIB à mão.
 */
function ico(pngs) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reservado
    header.writeUInt16LE(1, 2); // 1 = ícone
    header.writeUInt16LE(pngs.length, 4);

    let offset = 6 + pngs.length * 16;
    const entries = [];

    for (const { size, data } of pngs) {
        const entry = Buffer.alloc(16);
        entry.writeUInt8(size >= 256 ? 0 : size, 0);
        entry.writeUInt8(size >= 256 ? 0 : size, 1);
        entry.writeUInt8(0, 2); // paleta
        entry.writeUInt8(0, 3); // reservado
        entry.writeUInt16LE(1, 4); // planos
        entry.writeUInt16LE(32, 6); // bits por pixel
        entry.writeUInt32LE(data.length, 8);
        entry.writeUInt32LE(offset, 12);

        entries.push(entry);
        offset += data.length;
    }

    return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

function write(path, buffer) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, buffer);
    console.log(`${String(Math.round(buffer.length / 1024)).padStart(4)} KB  ${path}`);
}

const png = (size) => ({ size, data: mark(size).toBuffer('image/png') });

write(resolve(SITE, 'public/apple-touch-icon.png'), png(180).data);
write(resolve(SITE, 'public/favicon.ico'), ico([png(16), png(32), png(48)]));

// O comprovante recorta a logo num círculo, então ela já nasce redonda.
write(resolve('src/assets/logo.jpg'), mark(512).toBuffer('image/jpeg', 92));

console.log(`\nfonte usada: ${family()}`);
