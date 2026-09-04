/**
 * Dados de um comprovante de Pix recebido. Tudo o que o desenho precisa vem
 * daqui — o módulo não consulta banco nem rede, então é trivial de testar e
 * de reaproveitar.
 */
export type ReceiptData = {
    /** Valor pago, em reais. */
    amount: number;

    /** Momento da confirmação. Padrão: agora. */
    paidAt?: Date;

    /** Nome de quem pagou, como veio do arranjo Pix. */
    payerName?: string | null;

    /** Documento de quem pagou, quando o arranjo informa. */
    payerDocument?: string | null;

    /** Identificador fim a fim do Pix — é o comprovante junto ao banco. */
    endToEndId?: string | null;

    /** Código curto da cobrança no painel. */
    orderCode?: string | null;
};

export type ReceiptFormat = 'png' | 'jpeg';

export type ReceiptOptions = {
    /** `jpeg` gera arquivo bem menor — melhor para enviar por WhatsApp. */
    format?: ReceiptFormat;

    /** Qualidade do JPEG, de 0 a 100. Ignorado no PNG. */
    quality?: number;
};
