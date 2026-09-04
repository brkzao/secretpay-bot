import makeWASocket, {
    Browsers,
    DisconnectReason,
    fetchLatestBaileysVersion,
    isJidBroadcast,
    isJidGroup,
    isJidNewsletter,
    isJidStatusBroadcast,
    makeCacheableSignalKeyStore,
    type WAMessage,
    type WASocket,
} from 'baileys';

import { handleMessage } from '../conversation/machine';
import { authRepo, sessionsRepo, type SessionStatus } from '../db';
import { pushQr, pushStatus } from '../laravel/client';
import { baileysLogger, logger } from '../logger';
import { KeyedMutex } from '../util/mutex';
import { useSqliteAuthState, type PersistentAuthState } from './auth-state';

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 120_000;

/**
 * Quedas não-fatais são retentadas **indefinidamente**, com o intervalo travado
 * em RECONNECT_MAX_MS. Desistir depois de N tentativas significaria que uma
 * indisponibilidade do WhatsApp ou da rede mais longa que a janela de tentativas
 * mataria todas as sessões de vez, exigindo que cada vendedor lesse o QR outra
 * vez. O custo de insistir é uma tentativa de conexão a cada 2 minutos.
 */
const RECONNECT_LOG_EVERY = 10;

/**
 * O Baileys já mantém o socket vivo sozinho (padrão de 30s). Deixamos explícito
 * e um pouco mais curto: atrás de proxy/NAT, uma conexão ociosa por 30s tem mais
 * chance de ser descartada silenciosamente pelo caminho.
 */
const KEEP_ALIVE_MS = 25_000;

type ConnectionState = 'closed' | 'connecting' | 'open';

/**
 * Códigos que significam "essa credencial morreu, precisa de QR novo".
 *
 * `badSession` (500) **não** entra aqui, apesar do nome. No Baileys ele é o
 * valor de fallback quando o `<stream:error>` vem sem atributo `code`
 * (`Utils/generics.js`: `node.attrs.code || CODE_MAP[reason] || badSession`),
 * então qualquer erro de stream não mapeado — inclusive transitório e do lado
 * do servidor — cai nele. Tratá-lo como fatal apagava credenciais boas.
 */
const FATAL_CODES = new Set<number>([
    DisconnectReason.loggedOut,
    DisconnectReason.forbidden,
    DisconnectReason.multideviceMismatch,
]);

/**
 * Quantos erros de stream seguidos, sem nenhuma conexão bem-sucedida no meio,
 * até considerar a credencial suspeita. Retenta primeiro, condena depois.
 */
const MAX_CONSECUTIVE_STREAM_ERRORS = 5;

export class WaSession {
    private socket: WASocket | null = null;

    private auth: PersistentAuthState | null = null;

    /**
     * Estado real da conexão, alimentado pelo `connection.update`.
     *
     * Não dá para inferir isso de `socket.user`: no Baileys ele é um getter para
     * `authState.creds.me`, que numa sessão pareada existe desde a construção do
     * socket e nunca some. Confiar nele fazia o `start()` desistir na primeira
     * linha e a reconexão automática jamais reabrir o socket.
     */
    private connectionState: ConnectionState = 'closed';

    /** Incrementa a cada socket aberto; eventos de gerações antigas são ignorados. */
    private generation = 0;

    /** Momento do último `connection: open`, para medir quanto a sessão durou. */
    private connectedSince: number | null = null;

    /** Erros de stream (500) seguidos, sem conectar no meio. Zera ao conectar. */
    private consecutiveStreamErrors = 0;

    private reconnectAttempts = 0;

    private reconnectTimer: NodeJS.Timeout | null = null;

    private stopping = false;

    private starting = false;

    private readonly chatLocks = new KeyedMutex();

    private readonly log: ReturnType<typeof logger.child>;

    constructor(
        readonly id: string,
        readonly userId: string,
    ) {
        this.log = logger.child({ sessionId: id });
    }

    get connected(): boolean {
        return this.connectionState === 'open';
    }

    async start(): Promise<void> {
        if (this.starting || this.connectionState === 'open') {
            return;
        }

        // Um retry pendente dispararia no meio do handshake e descartaria o
        // socket que está justamente abrindo.
        this.clearReconnectTimer();

        this.starting = true;
        this.stopping = false;

        try {
            await this.openSocket();
        } finally {
            this.starting = false;
        }
    }

    /** Encerra o socket sem apagar credenciais — a sessão volta no próximo boot. */
    async stop(): Promise<void> {
        this.stopping = true;
        this.clearReconnectTimer();
        this.discardSocket();
    }

    /** Desconecta de verdade: derruba o vínculo no celular e apaga as credenciais. */
    async logout(): Promise<void> {
        this.stopping = true;
        this.clearReconnectTimer();

        try {
            await this.socket?.logout();
        } catch (error) {
            this.log.warn(
                { err: (error as Error).message },
                'logout remoto falhou; limpando credenciais localmente',
            );
        }

        this.discardSocket();
        authRepo.clear(this.id);
        this.auth = null;

        this.setStatus('logged_out');
    }

    /**
     * O estado de autenticação vive enquanto a sessão viver, e é compartilhado
     * por todos os sockets dela — é o padrão do Baileys, que cria o auth state
     * fora do laço de reconexão.
     *
     * Recriá-lo a cada reconexão causava corrupção: o Baileys grava chaves do
     * Signal chamando `keys.set()` direto, sem passar por evento, então o socket
     * anterior continuava escrevendo mesmo depois de removermos os listeners.
     * Com dois estados distintos sobre as mesmas linhas, o socket que estava
     * morrendo sobrescrevia o que o handshake novo acabara de gravar, e o
     * WhatsApp derrubava a sessão com badSession.
     */
    private ensureAuth(): PersistentAuthState {
        if (this.auth === null) {
            this.auth = useSqliteAuthState(this.id);
        }

        return this.auth;
    }

    /**
     * Encerra o socket corrente e o desconecta dos handlers. Sem isso, um socket
     * morto continua emitindo eventos que mexeriam no estado do socket novo.
     */
    private discardSocket(): void {
        const socket = this.socket;

        this.socket = null;
        this.connectionState = 'closed';

        if (socket === null) {
            return;
        }

        try {
            socket.ev.removeAllListeners('connection.update');
            socket.ev.removeAllListeners('messages.upsert');
            socket.ev.removeAllListeners('creds.update');
        } catch {
            // emissor já descartado
        }

        try {
            socket.end(undefined);
        } catch {
            // socket já estava morto
        }
    }

    async sendText(jid: string, text: string): Promise<void> {
        if (this.socket === null || !this.connected) {
            throw new Error('Sessão não está conectada.');
        }

        await this.socket.sendMessage(jid, { text });
    }

    /**
     * O mimetype é parâmetro porque o comprovante sai em JPEG (arquivo bem
     * menor) e o QR do Pix em PNG — a compressão com perdas do JPEG suja as
     * bordas dos módulos e atrapalha a leitura do código.
     */
    async sendImage(
        jid: string,
        image: Buffer,
        caption?: string,
        mimetype = 'image/jpeg',
    ): Promise<void> {
        if (this.socket === null || !this.connected) {
            throw new Error('Sessão não está conectada.');
        }

        await this.socket.sendMessage(jid, {
            image,
            mimetype,
            ...(caption !== undefined ? { caption } : {}),
        });
    }

    private async openSocket(): Promise<void> {
        // Uma reconexão sempre abre um socket novo; o anterior precisa sair de cena.
        this.discardSocket();

        const generation = ++this.generation;
        const auth = this.ensureAuth();

        this.connectionState = 'connecting';

        const version = await this.resolveVersion();

        const socket = makeWASocket({
            version,
            logger: baileysLogger as never,
            auth: {
                creds: auth.state.creds,
                keys: makeCacheableSignalKeyStore(
                    auth.state.keys,
                    baileysLogger as never,
                ),
            },
            browser: Browsers.ubuntu('Chrome'),
            // Manter offline: com `true`, o WhatsApp para de mandar push
            // para o celular do usuário e ele acha que o app quebrou.
            markOnlineOnConnect: false,
            syncFullHistory: false,
            generateHighQualityLinkPreview: false,
            keepAliveIntervalMs: KEEP_ALIVE_MS,
            shouldIgnoreJid: (jid: string) =>
                isJidBroadcast(jid) ||
                isJidStatusBroadcast(jid) ||
                isJidNewsletter(jid),
            getMessage: async () => undefined,
        });

        this.socket = socket;

        socket.ev.on('creds.update', auth.saveCreds);

        socket.ev.on('connection.update', (update) => {
            if (generation !== this.generation) {
                return; // evento de um socket já descartado
            }

            void this.onConnectionUpdate(update);
        });

        socket.ev.on('messages.upsert', (event) => {
            if (generation !== this.generation || event.type !== 'notify') {
                return;
            }

            for (const message of event.messages) {
                void this.onMessage(message);
            }
        });
    }

    private async resolveVersion(): Promise<
        [number, number, number] | undefined
    > {
        try {
            const { version } = await fetchLatestBaileysVersion();

            return version;
        } catch {
            // Sem acesso para consultar: o Baileys cai na versão embutida.
            return undefined;
        }
    }

    private async onConnectionUpdate(update: {
        connection?: string;
        lastDisconnect?: { error?: Error | undefined } | undefined;
        qr?: string;
    }): Promise<void> {
        const { connection, lastDisconnect, qr } = update;

        if (qr !== undefined) {
            this.setStatus('qr');
            await pushQr(this.id, qr);
        }

        if (connection === 'connecting') {
            this.connectionState = 'connecting';

            return;
        }

        if (connection === 'open') {
            this.connectionState = 'open';
            this.reconnectAttempts = 0;
            this.consecutiveStreamErrors = 0;
            this.connectedSince = Date.now();

            const phone = this.socket?.user?.id?.split(':')[0] ?? null;

            this.log.info({ phone }, 'sessão conectada');
            this.setStatus('connected', phone);
            await pushStatus(this.id, 'connected', { phone_number: phone });

            return;
        }

        if (connection !== 'close') {
            return;
        }

        this.connectionState = 'closed';

        const failure = describeDisconnect(lastDisconnect?.error);
        const { statusCode } = failure;

        if (this.stopping) {
            this.log.info('sessão encerrada localmente');

            return;
        }

        const uptimeMs =
            this.connectedSince === null ? null : Date.now() - this.connectedSince;

        this.connectedSince = null;

        if (statusCode === DisconnectReason.badSession) {
            this.consecutiveStreamErrors += 1;
        }

        // O motivo vem no texto do Boom (`Stream Errored (<reason>)`) e no nó
        // binário. Sem registrar isso, um 500 é indistinguível de outro.
        const context = {
            statusCode,
            reason: failure.reason,
            node: failure.node,
            uptimeMs,
            reconnectAttempts: this.reconnectAttempts,
            consecutiveStreamErrors: this.consecutiveStreamErrors,
            generation: this.generation,
        };

        const exhausted =
            statusCode === DisconnectReason.badSession &&
            this.consecutiveStreamErrors >= MAX_CONSECUTIVE_STREAM_ERRORS;

        if ((statusCode !== null && FATAL_CODES.has(statusCode)) || exhausted) {
            this.log.warn(
                context,
                exhausted
                    ? 'erros de stream seguidos; credencial considerada inválida'
                    : 'sessão invalidada pelo WhatsApp',
            );

            const description = exhausted
                ? `O WhatsApp recusou a sessão ${this.consecutiveStreamErrors} vezes seguidas. Leia o QR Code novamente.`
                : describeCode(statusCode);

            this.discardSocket();
            // Direto no repositório: não pode depender de o auth state em
            // memória existir, senão sobra credencial morta no banco e a
            // próxima conexão tenta reusá-la em vez de emitir QR.
            authRepo.clear(this.id);
            this.auth = null;

            sessionsRepo.setAutoStart(this.id, false);
            this.setStatus('logged_out', null, description);
            await pushStatus(this.id, 'logged_out', { error: description });

            return;
        }

        this.log.info(context, 'conexão encerrada; reconectando');

        const description = describeCode(statusCode);

        this.setStatus('disconnected', null, description);
        await pushStatus(this.id, 'disconnected', { error: description });

        this.scheduleReconnect(statusCode);
    }

    private scheduleReconnect(statusCode: number | null): void {
        this.reconnectAttempts += 1;

        // 515 (restartRequired) é parte normal do pareamento: reconecta já.
        const delay =
            statusCode === DisconnectReason.restartRequired
                ? 0
                : Math.min(
                      RECONNECT_BASE_MS * 2 ** (this.reconnectAttempts - 1),
                      RECONNECT_MAX_MS,
                  );

        // As primeiras tentativas em info; depois só de tempos em tempos, para
        // uma queda longa não inundar o log de uma linha a cada 2 minutos.
        if (this.reconnectAttempts <= 5) {
            this.log.info(
                { attempt: this.reconnectAttempts, delay },
                'agendando reconexão',
            );
        } else if (this.reconnectAttempts % RECONNECT_LOG_EVERY === 0) {
            this.log.warn(
                { attempt: this.reconnectAttempts, delay },
                'sessão segue fora do ar; continuando a tentar',
            );
        }

        this.clearReconnectTimer();

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;

            void this.start().catch((error: Error) => {
                this.log.error({ err: error.message }, 'falha ao reconectar');
            });
        }, delay);

        this.reconnectTimer.unref();
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer !== null) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    private async onMessage(message: WAMessage): Promise<void> {
        const jid = message.key.remoteJid;

        if (
            message.key.fromMe === true ||
            jid === null ||
            jid === undefined ||
            isJidGroup(jid) ||
            isJidBroadcast(jid) ||
            isJidStatusBroadcast(jid) ||
            isJidNewsletter(jid)
        ) {
            return;
        }

        const text = extractText(message);

        if (text === null || text.trim() === '') {
            return;
        }

        // Uma conversa por vez: mensagens em rajada não podem pular passos.
        await this.chatLocks.run(jid, async () => {
            try {
                const replies = await handleMessage(this.id, jid, text);

                for (const reply of replies) {
                    if (reply.kind === 'image') {
                        await this.sendImage(
                            jid,
                            reply.image,
                            reply.caption,
                            'image/png',
                        );

                        continue;
                    }

                    await this.sendText(jid, reply.text);
                }
            } catch (error) {
                this.log.error(
                    { jid, err: (error as Error).message },
                    'erro ao processar mensagem',
                );

                try {
                    await this.sendText(
                        jid,
                        'Tive um problema por aqui. Envie *menu* para recomeçar.',
                    );
                } catch {
                    // sessão pode ter caído no meio — nada a fazer
                }
            }
        });
    }

    private setStatus(
        status: SessionStatus,
        phone: string | null = null,
        error: string | null = null,
    ): void {
        sessionsRepo.updateStatus(this.id, status, phone, error);
    }
}

type DisconnectFailure = {
    statusCode: number | null;
    /** Texto do Boom, no formato `Stream Errored (<motivo>)`. */
    reason: string | null;
    /** Resumo do nó binário do WhatsApp: tag, atributos e filhos. */
    node: Record<string, unknown> | null;
};

/**
 * Extrai tudo o que o erro de desconexão carrega. O código sozinho não basta:
 * o 500 é um guarda-chuva, e o motivo real só aparece no texto e no nó.
 */
function describeDisconnect(error: Error | undefined): DisconnectFailure {
    const boom = error as unknown as
        | { output?: { statusCode?: number }; data?: unknown; message?: string }
        | undefined;

    return {
        statusCode:
            typeof boom?.output?.statusCode === 'number'
                ? boom.output.statusCode
                : null,
        reason: typeof boom?.message === 'string' ? boom.message : null,
        node: summarizeNode(boom?.data),
    };
}

function summarizeNode(data: unknown): Record<string, unknown> | null {
    if (data === null || typeof data !== 'object') {
        return null;
    }

    const node = data as {
        tag?: unknown;
        attrs?: unknown;
        content?: unknown;
    };

    const children = Array.isArray(node.content)
        ? node.content
              .map((child) => (child as { tag?: unknown } | null)?.tag)
              .filter((tag): tag is string => typeof tag === 'string')
        : undefined;

    return {
        tag: typeof node.tag === 'string' ? node.tag : null,
        attrs: node.attrs ?? null,
        ...(children !== undefined ? { children } : {}),
    };
}

function describeCode(statusCode: number | null): string | null {
    if (statusCode === null) {
        return null;
    }

    switch (statusCode) {
        case DisconnectReason.loggedOut:
            return 'Sessão encerrada no aparelho. Leia o QR Code novamente.';
        case DisconnectReason.badSession:
            // 500 é o fallback do Baileys para erro de stream sem código, e não
            // um veredito sobre a credencial — a mensagem não pode afirmar isso.
            return 'Conexão encerrada pelo WhatsApp. Tentando reconectar.';
        case DisconnectReason.forbidden:
            return 'Conta bloqueada pelo WhatsApp.';
        case DisconnectReason.multideviceMismatch:
            return 'Incompatibilidade multi-dispositivo. Leia o QR Code novamente.';
        case DisconnectReason.connectionReplaced:
            return 'Outra sessão assumiu a conexão.';
        case DisconnectReason.restartRequired:
            return 'Reinício exigido pelo WhatsApp.';
        case DisconnectReason.timedOut:
            return 'Tempo de conexão esgotado.';
        default:
            return `Conexão encerrada (código ${statusCode}).`;
    }
}

function extractText(message: WAMessage): string | null {
    let content = message.message;

    // Desembrulha mensagens efêmeras / "ver uma vez".
    content =
        content?.ephemeralMessage?.message ??
        content?.viewOnceMessage?.message ??
        content?.viewOnceMessageV2?.message ??
        content;

    if (!content) {
        return null;
    }

    return (
        content.conversation ??
        content.extendedTextMessage?.text ??
        content.imageMessage?.caption ??
        content.videoMessage?.caption ??
        content.buttonsResponseMessage?.selectedButtonId ??
        content.listResponseMessage?.singleSelectReply?.selectedRowId ??
        content.templateButtonReplyMessage?.selectedId ??
        null
    );
}
