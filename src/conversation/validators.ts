import { config } from '../config';

export type Validated<T> =
    { ok: true; value: T } | { ok: false; error: string };

/**
 * Aceita "150", "150,50", "R$ 1.500,00" e "1500.50".
 * Espelha as regras de `amount` do StoreOrderRequest no Laravel.
 */
export function parseAmount(input: string): Validated<number> {
    const cleaned = input
        .replace(/r\$/gi, '')
        .replace(/\s/g, '')
        .replace(/[^\d.,-]/g, '');

    if (cleaned === '') {
        return {
            ok: false,
            error: 'Não entendi o valor. Envie apenas números, ex.: *150*',
        };
    }

    let normalized = cleaned;

    const lastComma = normalized.lastIndexOf(',');
    const lastDot = normalized.lastIndexOf('.');

    if (lastComma > -1 && lastDot > -1) {
        // O separador decimal é o que aparece por último ("1.500,00" ou "1,500.00").
        normalized =
            lastComma > lastDot
                ? normalized.replace(/\./g, '').replace(',', '.')
                : normalized.replace(/,/g, '');
    } else if (lastComma > -1) {
        // Vírgula isolada: decimal em pt-BR, salvo quando é separador de milhar ("1,500").
        normalized =
            normalized.length - lastComma === 4
                ? normalized.replace(',', '')
                : normalized.replace(',', '.');
    }

    const value = Number(normalized);

    if (!Number.isFinite(value) || value <= 0) {
        return {
            ok: false,
            error: 'Não entendi o valor. Envie apenas números, ex.: *150*',
        };
    }

    if (value < config.MIN_ORDER_AMOUNT) {
        return {
            ok: false,
            error: `O valor mínimo é *${formatBrl(config.MIN_ORDER_AMOUNT)}*. Envie um valor maior.`,
        };
    }

    if (value > config.MAX_ORDER_AMOUNT) {
        return {
            ok: false,
            error: `O valor máximo é *${formatBrl(config.MAX_ORDER_AMOUNT)}*. Envie um valor menor.`,
        };
    }

    return { ok: true, value: Math.round(value * 100) / 100 };
}

export function formatBrl(value: number): string {
    return value.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
    });
}
