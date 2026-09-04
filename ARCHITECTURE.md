# Arquitetura — SecretPay P2P Bot

Documentação técnica do serviço de WhatsApp. Descreve o que o código faz hoje,
incluindo limitações conhecidas. Para instalar e rodar, veja o [README](README.md);
para publicar, o [DEPLOY.md](../secretpay/DEPLOY.md) do painel.

---

## 1. Escopo e fronteiras

O bot é um processo Node que mantém **N conexões simultâneas com o WhatsApp**, uma
por vendedor do painel, e conduz por chat a criação de cobranças Pix.

O que ele **não** faz, de propósito:

- Não fala com o OmoPix nem conhece o ciclo da cobrança. Ele monta um payload e
  pede ao painel que crie a cobrança; o QR e o copia-e-cola vêm de lá prontos.
- Não guarda API key de vendedor. O dono da cobrança é resolvido pela sessão.
- Não inicia conversa. Só responde a quem mandou mensagem primeiro.
- Não tem interface. Todo controle vem do painel pela API interna.

A fronteira é deliberada: o WhatsApp é um **transporte** e o painel continua sendo
a autoridade sobre dinheiro, validação e permissão.

---

## 2. Topologia

```
┌──────────────────────── secretpay (Laravel) ─────────────────────────┐
│                                                                      │
│  /dashboard/whatsapp ──► WhatsappController ──► WhatsappBotService ───┼──┐
│         ▲ polling 2,5s                                               │  │
│         │                                                            │  │
│  Cache (QR, TTL 60s)                                                 │  │
│         ▲                                                            │  │
│  BotCallbackController ◄── middleware `bot` (HMAC) ◄─────────────────┼──┼─┐
│         │                                                            │  │ │
│  whatsapp_sessions · orders(source=WHATSAPP)                         │  │ │
│         │                                                            │  │ │
│  OmoPixWebhookController ──► NotifyWhatsappOrder (queue) ────────────┼──┘ │
└──────────────────────────────────────────────────────────────────────┘    │
                                    │                                       │
                    HMAC-SHA256 nas duas direções                           │
                                    ▼                                       │
┌──────────────────────── secretpay-bot (Node) ────────────────────────┐    │
│                                                                      │    │
│  Fastify /internal/*  ──►  SessionManager                            │    │
│                              ├── WaSession(A) ──┐                    │    │
│                              ├── WaSession(B) ──┼── Baileys ──► WA   │    │
│                              └── WaSession(C) ──┘                    │    │
│                                     │                                │    │
│                              ConversationMachine ────────────────────┼────┘
│                                     │                                │
│  SQLite: sessions · auth_creds · auth_keys · conversations           │
└──────────────────────────────────────────────────────────────────────┘
```

Quem inicia o quê:

| Direção | Gatilho | Rota |
|---|---|---|
| painel → bot | vendedor clica "Conectar" | `POST /internal/sessions` |
| painel → bot | vendedor clica "Desconectar" | `DELETE /internal/sessions/:id` |
| painel → bot | job de mudança de status | `POST /internal/notify` |
| bot → painel | Baileys emitiu um QR | `POST /api/bot/qr` |
| bot → painel | conexão abriu/caiu | `POST /api/bot/status` |
| bot → painel | cliente confirmou a cobrança | `POST /api/bot/orders` |
| bot → painel | cliente pediu "status" | `POST /api/bot/orders/{id}/status` |

---

## 3. Mapa de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `src/index.ts` | boot, shutdown gracioso, timer de expurgo, handlers globais de erro |
| `src/config.ts` | leitura e validação das envs com zod; encerra o processo se faltar algo |
| `src/logger.ts` | pino; logger separado e silenciado para o Baileys |
| `src/db.ts` | schema SQLite, statements preparados, repositórios, transação |
| `src/server.ts` | Fastify, verificação de HMAC, rotas internas |
| `src/util/hmac.ts` | assinatura e verificação com janela anti-replay |
| `src/util/mutex.ts` | fila serial por chave |
| `src/laravel/client.ts` | chamadas assinadas ao painel |
| `src/wa/session-manager.ts` | registro de sessões, boot em lotes, shutdown |
| `src/wa/session.ts` | um socket Baileys: conexão, reconexão, recepção |
| `src/wa/auth-state.ts` | `AuthenticationState` do Baileys persistido em SQLite |
| `src/wa/simulator.ts` | sessões de teste sem WhatsApp |
| `src/conversation/machine.ts` | máquina de estados do diálogo |
| `src/conversation/store.ts` | estado por conversa, com TTL |
| `src/conversation/validators.ts` | espelho das regras de validação do painel |
| `src/simulate.ts` | REPL de teste (processo separado) |

---

## 4. Modelo de dados

### 4.1 SQLite do bot

`PRAGMA journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
`foreign_keys=ON`. Todas as tabelas filhas caem em cascata com a sessão.

**`sessions`** — espelho local do estado da sessão.

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | TEXT PK | o mesmo UUID de `whatsapp_sessions.id` no painel |
| `user_id` | TEXT | referência lógica ao usuário do painel |
| `status` | TEXT | `pending` · `qr` · `connected` · `disconnected` · `logged_out` |
| `phone_number` | TEXT | número pareado, sem o sufixo de dispositivo |
| `last_error` | TEXT | motivo legível da última queda |
| `auto_start` | INTEGER | `0` impede religar no próximo boot |
| `created_at` / `updated_at` | TEXT | UTC, `datetime('now')` |

**`auth_creds`** — uma linha por sessão, `data` é o objeto `creds` do Baileys
serializado com `BufferJSON.replacer`.

**`auth_keys`** — chave primária composta `(session_id, type, key_id)`. Guarda o
material do protocolo Signal: `pre-key`, `session`, `sender-key`,
`app-state-sync-key`, entre outros. É a tabela mais quente do sistema.

**`conversations`** — PK `(session_id, jid)`, com `step`, `data` (JSON do rascunho),
`updated_at` e `expires_at`. Há índice em `expires_at` para o expurgo.

### 4.2 Tabelas do painel

**`whatsapp_sessions`** — `user_id` é **único**: um vendedor, uma conta de WhatsApp.
Guarda `status`, `phone_number`, `last_error`, `connected_at`. Nenhuma credencial.

**`orders`** — colunas acrescentadas: `source` (`API` por padrão, `WHATSAPP` quando
nasce aqui), `wa_session_id`, `wa_jid` e `idempotency_key`, com índice único
`(wa_session_id, idempotency_key)`.

### 4.3 Onde cada coisa mora, e por quê

| Dado | Onde | Motivo |
|---|---|---|
| credenciais do Baileys | SQLite do bot | `saveCreds()` dispara dezenas de vezes por minuto; trafegar isso por HTTP seria latência e ponto de falha |
| estado da conversa | SQLite do bot | volátil, alta escrita, irrelevante para o painel |
| status da sessão | ambos | o bot precisa para decidir; o painel precisa para exibir |
| QR corrente | Cache do painel (TTL 60s) | expira em ~20s e rotaciona; gravar no banco seria lixo |
| cobrança | apenas painel | é a autoridade sobre dinheiro |

O status existe nos dois lados e pode divergir por instantes — o painel é
eventualmente consistente, atualizado por push do bot. O painel nunca decide
sobre a conexão; só reflete.

---

## 5. Autenticação: HMAC bidirecional

Um único segredo (`BOT_SHARED_SECRET`) assina as chamadas nos dois sentidos.

```
assinatura = HMAC_SHA256(segredo, "<timestamp>.<corpo cru>")

X-Bot-Timestamp: 1785881864          # segundos, UTC
X-Bot-Signature: <hex>
```

Regras:

- **O corpo é o texto cru.** Reserializar o JSON mudaria os bytes e quebraria a
  assinatura. No bot, um `contentTypeParser` guarda o `rawBody`; no Laravel, usa-se
  `$request->getContent()` e o `WhatsappBotService` envia com `withBody()`.
- **Sem corpo, assina-se string vazia.** Vale para `GET` e `DELETE`.
- **Janela de 5 minutos** (`MAX_SKEW_SECONDS = 300`) nos dois lados. O timestamp
  entra no cálculo, então uma requisição capturada não pode ser reenviada depois.
- **Comparação em tempo constante**: `timingSafeEqual` no bot, `hash_equals` no PHP.
- No bot, a verificação é um hook `preValidation` — **não** `onRequest`, porque o
  corpo cru só existe depois do parse. Esse detalhe já causou um bug: com
  `onRequest`, toda requisição assinada corretamente respondia 401.
- `GET /health` é a única rota isenta.

Falha de assinatura devolve `401` dos dois lados. Se o painel não tiver
`BOT_SHARED_SECRET` configurado, o middleware devolve `503` em vez de `401` — a
distinção entre "não configurado" e "credencial errada" facilita o diagnóstico.

---

## 6. Ciclo de vida da sessão

### 6.1 Estados

```
                    ┌─────────┐
                    │ pending │  socket abrindo
                    └────┬────┘
                         ▼
                    ┌─────────┐   QR emitido (rotaciona a cada ~20s)
              ┌────►│   qr    │
              │     └────┬────┘
              │          │ celular leu
              │          ▼
              │   ┌─────────────┐
              │   │  connected  │  atendendo
              │   └──────┬──────┘
              │          │ conexão caiu
              │          ▼
              │  ┌──────────────┐  backoff exponencial
              └──┤ disconnected │──────────┐
                 └──────────────┘          │ 20 tentativas
                         │ código fatal    ▼
                         ▼          auto_start = 0
                 ┌──────────────┐   (espera intervenção)
                 │  logged_out  │   credenciais apagadas
                 └──────────────┘
```

### 6.2 Conexão inicial

```
vendedor    painel                    bot                   WhatsApp
   │  clica   │                        │                       │
   ├─────────►│ POST /internal/sessions│                       │
   │          ├───────────────────────►│ makeWASocket()        │
   │          │◄─── 202 pending ───────┤──────────────────────►│
   │          │                        │◄──── qr ──────────────┤
   │          │◄── POST /api/bot/qr ───┤                       │
   │          │ Cache::put(60s)        │                       │
   │◄─ polling 2,5s devolve o qr ──────┤                       │
   │  lê no celular ──────────────────────────────────────────►│
   │          │                        │◄─ connection: open ───┤
   │          │◄ POST /api/bot/status ─┤                       │
   │          │ connected_at, telefone │                       │
   │◄─ polling passa a 15s ────────────┤                       │
```

O QR **rotaciona**: o Baileys emite um novo a cada ~20 s e cada um é publicado no
painel. O TTL de 60 s no cache cobre a rotação com folga. A página redesenha o
código a cada resposta do polling — não há WebSocket em nenhum ponto.

### 6.3 Configuração do socket

```ts
makeWASocket({
    version,                       // fetchLatestBaileysVersion(), com fallback
    logger: baileysLogger,         // silencioso salvo LOG_LEVEL=trace
    auth: { creds, keys: makeCacheableSignalKeyStore(keys, logger) },
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false,
    keepAliveIntervalMs: 25_000,   // Baileys já faz isso sozinho (padrão 30s)
    shouldIgnoreJid: broadcast | status | newsletter,
    getMessage: async () => undefined,
})
```

Duas escolhas com consequência prática:

- **`markOnlineOnConnect: false`** é o parâmetro mais importante do arquivo. Com
  `true`, o WhatsApp entende que o dispositivo web está em primeiro plano e **para
  de enviar notificações push para o celular do vendedor**. Ele concluiria que o
  bot quebrou o WhatsApp dele.
- **`syncFullHistory: false`** evita baixar o histórico inteiro a cada conexão.
  Junto com a ausência de store em memória, é o que mantém o consumo em ~30–80 MB
  por sessão em vez de várias centenas.

`fetchLatestBaileysVersion()` faz uma requisição de rede; se falhar, `resolveVersion`
devolve `undefined` e o Baileys usa a versão embutida. Sem internet no boot, a
sessão ainda sobe.

### 6.4 Queda e reconexão

Ao receber `connection: 'close'`, extrai-se `error.output.statusCode` (formato Boom):

| Código | Constante | Tratamento |
|---|---|---|
| 401 | `loggedOut` | **fatal** — credenciais apagadas, `auto_start=0` |
| 403 | `forbidden` | **fatal** — conta bloqueada |
| 411 | `multideviceMismatch` | **fatal** |
| 500 | `badSession` | retenta; fatal só na **5ª seguida** (ver abaixo) |
| 515 | `restartRequired` | reconecta **imediatamente** (parte normal do pareamento) |
| 440 | `connectionReplaced` | reconecta com backoff |
| 428 | `connectionClosed` | reconecta com backoff |
| 408 | `timedOut` / `connectionLost` | reconecta com backoff |
| 503 | `unavailableService` | reconecta com backoff |
| outros / ausente | — | reconecta com backoff |

**O 500 não é um veredito.** Apesar do nome `badSession`, ele é o *fallback* do
Baileys quando o `<stream:error>` chega sem atributo `code`:

```js
// Utils/generics.js
const statusCode = +(node.attrs.code || CODE_MAP[reason] || DisconnectReason.badSession)
```

Qualquer erro de stream não mapeado — inclusive transitório e do lado do
servidor — vira 500. Tratá-lo como fatal apagava credenciais de sessões
saudáveis: houve caso em produção de conta com 52 minutos de conexão estável e
zero reconexões sendo destruída por um único 500.

A política é retentar e só condenar na repetição: cinco 500 seguidos **sem
nenhuma conexão bem-sucedida no meio** (`MAX_CONSECUTIVE_STREAM_ERRORS`) marcam
a credencial como suspeita. O contador zera a cada `connection: open`, e só o
500 o incrementa — quedas de código conhecido, como 428, nunca escalam.

O motivo real do erro está no texto do Boom (`Stream Errored (<motivo>)`) e no
nó binário, ambos registrados em toda queda nos campos `reason` e `node`. Sem
eles, um 500 é indistinguível de outro.

Atenção ao ler o log: no enum do Baileys, `timedOut` e `connectionLost` têm **o
mesmo valor 408**. A mensagem que o bot grava em `last_error` diz "Tempo de
conexão esgotado" nos dois casos — são indistinguíveis pelo código.

Quando a queda vem de um `socket.end()` local (parada ou desligamento), não há
`statusCode`; a flag `stopping` faz o handler apenas registrar e sair, sem
agendar reconexão.

O backoff é `2s × 2^(tentativa-1)`, limitado a 120 s: 2, 4, 8, 16, 32, 64, 120, 120…

Quedas não-fatais são retentadas **indefinidamente**, sem teto de tentativas. Um
limite faria uma indisponibilidade do WhatsApp ou da rede mais longa que a janela
de tentativas matar todas as sessões de uma vez, obrigando cada vendedor a ler o
QR de novo. Insistir custa uma tentativa de conexão a cada 2 minutos por sessão
parada. Para não inundar o log, as cinco primeiras tentativas saem em `info` e
depois só uma a cada dez, em `warn`.

`auto_start` só vai a zero num caso: código fatal. Ali a credencial morreu de
fato e insistir seria inútil.

Códigos fatais recebem tratamento distinto porque insistir seria inútil: a
credencial não vale mais. O bot apaga `auth_creds` e `auth_keys`, marca
`logged_out` e avisa o painel, que exibe o motivo em `last_error` e oferece um QR
novo.

O timer de reconexão usa `unref()`, para não segurar o processo vivo no shutdown.

### 6.6 Estado da conexão e gerações de socket

O estado real vive em `connectionState` (`closed` · `connecting` · `open`),
alimentado pelo próprio `connection.update`. Isso **não** pode ser inferido de
`socket.user`: no Baileys ele é um getter para `authState.creds.me`, que numa
sessão pareada existe desde a construção do socket e nunca some. Uma versão
anterior deste código usava `socket.user` como sinal de "conectado", e o efeito
era grave — o `start()` desistia na primeira linha e **a reconexão automática
jamais reabria o socket**. A sessão só voltava reiniciando o processo.

Cada `openSocket()` descarta o socket anterior (remove os listeners e chama
`end()`) e incrementa um contador de geração. Os handlers capturam a geração em
que foram registrados e ignoram eventos de gerações antigas, para que um socket
moribundo não altere o estado do socket novo — por exemplo agendando uma
reconexão que competiria com a conexão recém-aberta.

### 6.5 Boot

`SessionManager.bootAll()` carrega as sessões com `auto_start=1` e status diferente
de `logged_out`, e as abre em **lotes de 5 com 2 s de intervalo**
(`SESSION_BOOT_BATCH`, `SESSION_BOOT_DELAY_MS`). Subir 200 sockets de uma vez é
pedido de rate-limit.

O boot roda **em segundo plano**: `index.ts` não o aguarda, para que o healthcheck
responda de imediato. Uma falha ao restaurar uma sessão é registrada e não impede
as demais.

---

## 7. Persistência do `AuthenticationState`

O Baileys espera um objeto com `creds` e um key store com `get`/`set`. O
`useMultiFileAuthState` oficial grava em disco local — inviável em container
efêmero. `useSqliteAuthState` implementa o mesmo contrato sobre SQLite:

```
creds  ── JSON.stringify(creds, BufferJSON.replacer) ──► auth_creds.data
keys   ── get(type, ids)  ──► SELECT ... WHERE (session_id, type, key_id)
       ── set(data)       ──► UPSERT/DELETE dentro de uma transação
```

Três detalhes obrigatórios:

- **`BufferJSON`**: as credenciais contêm `Buffer`s (chaves criptográficas). O
  `replacer`/`reviver` do Baileys preserva esses bytes; `JSON.stringify` puro os
  corromperia silenciosamente e a sessão falharia no handshake seguinte.
- **`app-state-sync-key`** precisa ser reidratado com
  `proto.Message.AppStateSyncKeyData.fromObject(value)` na leitura. Sem isso o
  Baileys recebe um objeto simples onde espera uma mensagem protobuf.
- **`set()` é transacional.** O Baileys grava chaves em lote; escrever uma a uma
  deixaria o estado inconsistente se o processo morresse no meio. Valor `null`
  significa remoção, não gravação de nulo.

`makeCacheableSignalKeyStore` envolve o store com um cache em memória, reduzindo
bastante a leitura no SQLite durante a troca de mensagens.

---

## 8. Caminho de uma mensagem recebida

```
messages.upsert (type: 'notify')
   │
   ├─ descarta: fromMe · grupo · broadcast · status · newsletter
   │
   ├─ extractText():  desembrulha ephemeral / viewOnce / viewOnceV2
   │                  conversation → extendedText → caption → botão → lista
   │
   ├─ descarta: texto vazio
   │
   ├─ chatLocks.run(jid, …)        ◄── fila serial por contato
   │      │
   │      ├─ handleMessage(sessionId, jid, text) → string[]
   │      │
   │      └─ para cada resposta: socket.sendMessage(jid, { text })
   │
   └─ erro → log + "Tive um problema por aqui. Envie *menu* para recomeçar."
```

Só `type: 'notify'` é processado. O `append` traz sincronizações de histórico, que
reprocessadas fariam o bot responder a mensagens antigas ao reconectar.

O **mutex por `jid`** existe porque a máquina de estados é ler-modificar-gravar.
Duas mensagens em rajada processadas em paralelo leriam o mesmo estado e uma
sobrescreveria a outra — o cliente veria um passo ser pulado. As filas são
descartadas do mapa quando esvaziam, então o custo de memória é proporcional às
conversas ativas, não ao histórico.

O `try/catch` em volta do handler é isolamento de falha: sem ele, uma exceção
derrubaria o processo inteiro e com ele **todas** as sessões dos outros vendedores.

---

## 9. Máquina de conversa

### 9.1 Estados

```
MENU ──"1"──► AMOUNT ──► CONFIRM
 ▲                                                                          │
 └──────────────── "2"/cancelar ◄──────────────────────────────────── "1" ──┘
                                                                      cria a ordem
```

O estado vive em `conversations`, chaveado por `(session_id, jid)`, com **TTL de 15
minutos** de inatividade (`CONVERSATION_TTL_MINUTES`). O carregamento verifica a
expiração e descarta; além disso, um timer a cada 5 minutos remove as linhas
vencidas do banco.

O rascunho (`draft`) guarda só o `amount`: valor é o único dado que a conversa
coleta. O `lastOrderId` sobrevive
ao reset, para que o comando `status` continue funcionando depois de criada a
cobrança.

### 9.2 Comandos globais

Avaliados **antes** do passo atual, em qualquer ponto do fluxo:

| Comando | Efeito |
|---|---|
| `cancelar` · `cancela` · `sair` · `parar` | descarta o rascunho, volta ao menu |
| `menu` · `inicio` · `oi` · `olá` · `bom dia`… | reinicia e mostra o menu |
| `ajuda` · `help` · `?` | lista de comandos |
| `status` (ou `2` no menu) | consulta a última cobrança no painel |
| `voltar` | volta um passo **e limpa o campo daquele passo e os seguintes** |

O `voltar` limpar os campos posteriores é intencional: manter um valor que o
usuário está prestes a trocar faria o resumo de confirmação mentir.

### 9.3 Validação

`validators.ts` reproduz em TypeScript as regras do painel:

| Campo | Regra espelhada |
|---|---|
| `amount` | `numeric`, entre `MIN_ORDER_AMOUNT` e `MAX_ORDER_AMOUNT` |

O parser de valor aceita `150`, `150,50`, `R$ 1.500,00` e `1500.50`, resolvendo a
ambiguidade entre separador decimal e de milhar pela posição do último símbolo.

**Isso é duplicação consciente.** O objetivo é erro instantâneo no chat, sem
round-trip. A autoridade continua sendo o painel, que revalida na criação; se as
duas divergirem, o painel devolve 422 e o bot exibe as mensagens dele. O risco é
a duplicata envelhecer: mudou uma `Rule` no Laravel, revise `validators.ts`.

### 9.4 Idempotência

A `idempotency_key` (UUID) é gerada ao **entrar** no passo `CONFIRM`, não ao
confirmar. Assim, tocar "1" duas vezes envia a mesma chave e o painel devolve a
cobrança já existente com `200` em vez de criar outra com `201`. O índice único
`(wa_session_id, idempotency_key)` garante isso no banco, não só na aplicação.

---

## 10. Criação da cobrança

```
CONFIRM + "1"
   │
   ├─ POST /api/bot/orders  { session_id, wa_jid, idempotency_key, amount }
   │
   ▼ BotCallbackController::storeOrder
   ├─ resolve o dono pela sessão  ◄── o bot não carrega API key
   ├─ recusa conta banida (403) ou não aprovada (403)
   ├─ cobrança já existente com essa chave? devolve 200
   ├─ Order::create(source=WHATSAPP, wa_session_id, wa_jid, …)
   ├─ ChargeService::generate() ──► OmoPix POST /v1/charges
   │     └─ falhou? apaga a cobrança e devolve 502
   └─ 201 com pix_code (copia e cola), prazo e checkout_url
```

O bot manda o QR como imagem (PNG — o JPEG suja as bordas dos módulos e atrapalha
a leitura) e, logo depois, o copia-e-cola **sozinho numa mensagem própria**: no
WhatsApp, copiar uma mensagem copia o texto inteiro dela, e qualquer palavra a
mais viria grudada no código. O horário de expiração sai em `America/Sao_Paulo`,
explicitamente — o `TZ` do container não influencia.

Em erro de validação (422), o bot exibe as mensagens que o painel devolveu, campo
a campo. Em erro de rede, devolve uma mensagem genérica e mantém o estado, para
que o cliente possa tentar de novo.

**Resolver o dono pela sessão** é a decisão de segurança central deste caminho: se
o bot guardasse a API key do vendedor, um comprometimento do bot exporia uma
credencial de longa vida com acesso total à API, e revogar a chave quebraria o
WhatsApp silenciosamente.

---

## 11. Notificação assíncrona

```
OmoPix ──charge.paid──► POST /api/webhooks/omopix
                            │ HMAC conferido, entrega deduplicada
                            │ update atômico (só um chamador "vence")
                            ├─ credita o saldo do vendedor
                            ├─ webhook do integrador (se webhook_url)
                            └─ NotifyWhatsappOrder (se wa_session_id)
                                     │ fila
                                     ▼
                            POST /internal/notify ──► sessão ──► cliente
```

O job é **separado** do `SendOrderWebhook` porque aquele webhook pertence ao
integrador e aponta para o sistema dele. São destinos e formatos diferentes.

A transição de status usa um `UPDATE ... WHERE status != novo` e só dispara os
avisos se `$claimed === 1`. Isso garante aviso único mesmo com o cron e a tela de
checkout consultando ao mesmo tempo.

Consequência operacional: **o job depende de um worker**. Sem `queue:work`, a
cobrança é criada e paga normalmente, mas a confirmação nunca chega ao chat.

Se a sessão estiver desconectada no momento do aviso, `/internal/notify` devolve
`409` e o `WhatsappBotService::notify` registra um warning e devolve `false` — o
job **não** é retentado por isso. Uma mensagem de confirmação entregue horas
depois teria pouco valor e a cobrança está visível no `checkout_url`.

---

## 12. API interna (referência)

Todas exigem HMAC, exceto `/health`. Base: `http://<bot>:3333`.

| Método | Rota | Corpo | Respostas |
|---|---|---|---|
| GET | `/health` | — | `200 {status:"ok"}` |
| POST | `/internal/sessions` | `{session_id, user_id}` | `202` estado · `422` |
| GET | `/internal/sessions/:id` | — | `200` estado · `404` |
| DELETE | `/internal/sessions/:id` | — | `200 {status:"logged_out"}` |
| POST | `/internal/notify` | `{session_id, jid, text}` | `200` · `409` desconectada · `422` |

Objeto de estado:

```json
{
  "session_id": "019fcec7-…",
  "status": "connected",
  "phone_number": "5527999999999",
  "last_error": null,
  "connected": true
}
```

Rotas de simulação (`SIMULATION_ENABLED=true`): `POST /internal/simulate/sessions`,
`DELETE /internal/simulate/sessions/:id`, `POST /internal/simulate/messages`,
`POST /internal/simulate/outbox`, `POST /internal/simulate/reset`.

O texto de `notify` é limitado a 4096 caracteres.

---

## 13. Concorrência e isolamento

| Risco | Mitigação |
|---|---|
| duas mensagens do mesmo contato em paralelo | `KeyedMutex` por `jid` |
| exceção num handler derruba todas as sessões | `try/catch` por mensagem + `unhandledRejection`/`uncaughtException` |
| dois `start()` na mesma sessão | flag `starting` e checagem de `connected` |
| escrita concorrente no SQLite | WAL + `busy_timeout=5000` + transação em `keys.set` |
| duas ordens pelo mesmo toque duplo | `idempotency_key` + índice único |
| dois avisos pela mesma transição | `UPDATE` atômico com checagem de `$claimed` |
| reconexões simultâneas no boot | lotes com intervalo |

**Duas instâncias do bot com as mesmas sessões não são suportadas.** Ambas
abririam o mesmo socket e o WhatsApp derrubaria as duas com `connectionReplaced`.
Escala horizontal exige shard por `hash(session_id) % réplicas`, com volume
próprio por réplica.

---

## 14. Simulação

Com `SIMULATION_ENABLED=true`, uma sessão pode ser registrada como simulada:
`registerSimulated` grava a linha com `status=connected` e `auto_start=0` (para
não tentar abrir socket no próximo boot) e a coloca num mapa em memória.

A partir daí, `/internal/simulate/messages` chama a **mesma** `handleMessage()` que
o Baileys chamaria, e `/internal/notify` desvia para uma caixa de saída em memória
em vez do socket. O REPL (`npm run simulate`) consome as duas coisas.

O que fica de fora do circuito é apenas o Baileys: estado, validação, criação de
cobrança e avisos são o caminho real. O registro é **em memória**, então reiniciar o
bot exige rodar `php artisan whatsapp:simular` de novo.

Confirmar numa sessão simulada **cria uma cobrança real** no OmoPix — não
existe sandbox nessa API.

---

## 15. Limitações conhecidas

- **Validação duplicada** entre `validators.ts` e as `Rules` do Laravel; divergem
  se alguém alterar um lado só.
- **Sem retry no aviso** de mudança de status quando a sessão está fora do ar.
- **Sem limite de taxa por contato.** Um cliente mandando muitas mensagens é
  processado em série, mas sem descarte.
- **Uma conta de WhatsApp por vendedor**, imposto pelo índice único em
  `whatsapp_sessions.user_id`. Relaxar isso exige revisar a resolução do dono.
- **Ban do WhatsApp é um risco real.** O Baileys é engenharia reversa do WhatsApp
  Web. O bot nunca inicia conversa, o que reduz bastante a exposição, mas não a
  elimina.
- **O QR trafega pelo painel.** Quem tiver acesso à sessão autenticada do vendedor
  no painel durante a janela de pareamento pode ler o código e parear o próprio
  dispositivo. É o mesmo modelo de confiança do WhatsApp Web oficial.

---

## 16. Diagnóstico

| Sintoma | Causa provável | Onde olhar |
|---|---|---|
| tudo em 401 entre os serviços | segredos diferentes ou relógios dessincronizados | `BOT_SHARED_SECRET` dos dois lados |
| QR não aparece na tela | bot não alcança o painel | log do bot: `falha ao publicar QR no painel`; conferir `LARAVEL_URL` |
| sessões caem a cada deploy | `DATABASE_PATH` fora do volume | montagem do volume |
| "integração não configurada" | `BOT_URL`/`BOT_SHARED_SECRET` ausentes no web | lembre do `config:cache`: exige redeploy |
| cliente não recebe confirmação | worker parado | tabela `jobs` do painel |
| vendedor relê o QR sem parar | código fatal do WhatsApp | `whatsapp_sessions.last_error` |
| bot não responde no chat | mensagem filtrada (grupo, sem texto) ou sessão caída | `LOG_LEVEL=trace` liga os logs do Baileys |

Comandos úteis:

```bash
curl http://bot.railway.internal:3333/health
```

```bash
sqlite3 /data/bot.db "SELECT id, status, phone_number, last_error FROM sessions;"
```
