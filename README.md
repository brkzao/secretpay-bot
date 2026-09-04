# SecretPay P2P Bot

Serviço de WhatsApp multi-sessão do painel [SecretPay P2P](../secretpay). Cada
usuário aprovado conecta o próprio número lendo um QR Code no painel; o número
conectado vira um bot que gera cobranças Pix: pergunta o valor, cria a
cobrança no Laravel e devolve o QR Code e o copia-e-cola na conversa.

Para o funcionamento interno em detalhe — ciclo de vida da sessão, protocolo HMAC,
persistência das credenciais, máquina de conversa e limitações conhecidas — veja
[ARCHITECTURE.md](ARCHITECTURE.md).

## Stack

Node 22+ · TypeScript (CommonJS) · [Baileys](https://github.com/WhiskeySockets/Baileys) 6.7 · Fastify 5 · SQLite (`node:sqlite`, embutido) · pino · zod

## Como roda

```
Painel Laravel  ──POST /internal/sessions──▶  SessionManager  ──▶  Baileys (1 socket por usuário)
      ▲                                              │
      └──── POST /api/bot/{qr,status,orders} ─────────┘
```

- **Credenciais** (`creds` + chaves do Signal) ficam no SQLite do bot, não em
  disco solto: container efêmero perderia a sessão a cada deploy. O Laravel
  guarda apenas metadados (status, número, erro).
- **Autenticação** nas duas direções: HMAC-SHA256 de `timestamp.body` com
  `BOT_SHARED_SECRET`, nos headers `X-Bot-Timestamp` e `X-Bot-Signature`.
  Requisições com mais de 5 minutos são rejeitadas.
- **Conversa**: máquina de estados por `(sessão, contato)` no SQLite, com TTL de
  15 min e fila serial por contato (mensagens em rajada não pulam passos).
- **Validação** espelha a faixa de valor do `StoreOrderRequest` do painel para
  dar erro instantâneo; o Laravel revalida na criação, que continua sendo a
  autoridade, e o adquirente do OmoPix é quem decide a faixa de fato.

## Setup

```bash
npm install
cp .env.example .env   # preencha LARAVEL_URL e BOT_SHARED_SECRET
npm run dev
```

`BOT_SHARED_SECRET` precisa ser idêntico ao do `.env` do Laravel. Gere com:

```bash
openssl rand -hex 32
```

## Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | tsx em watch mode |
| `npm run build` | compila para `dist/` |
| `npm start` | roda o build |
| `npm run types:check` | `tsc --noEmit` |

## API interna

Todas exigem HMAC, exceto `/health`.

| Rota | Descrição |
|---|---|
| `GET /health` | healthcheck (público) |
| `POST /internal/sessions` | cria/abre a sessão e começa a emitir QR |
| `GET /internal/sessions/:id` | status atual |
| `DELETE /internal/sessions/:id` | logout no aparelho + apaga credenciais |
| `POST /internal/notify` | envia uma mensagem avulsa numa sessão |

## Comprovantes

`src/receipt/` gera a imagem de comprovante Pix a partir dos dados da ordem. É um
módulo isolado e puro — recebe dados, devolve bytes; não conhece sessão, banco
nem WhatsApp. **O envio ainda não está implementado.**

```ts
import { renderReceipt } from './receipt';

const imagem = await renderReceipt({
    amount: 1500,
    payerName: 'Maria Aparecida da Silva',
    payerDocument: '279.957.530-74',
    endToEndId: 'E00416968202608061847ABCD5678EFGH',
    orderCode: '019FCEC7',
}, { format: 'jpeg' });
```

Só `amount` é obrigatório; as demais seções aparecem conforme os dados existirem,
e a altura da imagem se ajusta. Para ver o resultado:

```bash
npm run receipt:preview
```

Grava três exemplos em `preview/`. Renderização via `@napi-rs/canvas` (binário
pré-compilado, sem toolchain de build).

**Fontes:** o texto usa fontes do sistema. O `nixpacks.toml` instala
`fontconfig` + `dejavu_fonts` para o container ter alguma — sem isso o
comprovante sai sem texto. Para fixar a tipografia em qualquer ambiente, coloque
um `.ttf` em `src/assets/fonts/`, que ele passa a ter prioridade.

O comprovante é **acessório**: o `@napi-rs/canvas` entra por carga preguiçosa e
qualquer falha dele (binário incompatível, fonte ausente, logo faltando) desativa
só o comprovante. O bot continua atendendo, criando ordens e avisando por texto.

## Diagnóstico de inicialização

Todo boot imprime uma verificação legível antes de restaurar as sessões:

```
SecretPay P2P Bot — verificação de inicialização

  ✓ node          v22.13.1
  ✓ servidor      :::3333
  ✓ painel        https://secretpay.com.br
  ✓ segredo HMAC  definido (64 caracteres)
  ✓ banco         /data/bot.db
  ✓ simulação     desativada
  ✓ comprovantes  fonte DejaVu Sans · logo ok · teste 31 KB
  ✓ sessões       3 a restaurar

  tudo pronto
```

A linha de comprovantes renderiza uma imagem de teste de verdade — checar só se o
módulo carrega não pegaria a falha mais provável em container, que é fonte
ausente. O relatório também avisa quando o `DATABASE_PATH` cai dentro do
diretório da aplicação (sessões somem no deploy), quando o `HOST` é IPv4 em rede
IPv6, e quando a simulação está ligada.

## Testar sem WhatsApp

Com `SIMULATION_ENABLED=true` no `.env`, dá para conversar com o bot pelo
terminal. O caminho exercitado é o real — máquina de estados, validações,
criação da cobrança no Laravel e avisos assíncronos. O único pedaço fora do
circuito é o Baileys.

```bash
# no painel: marca a conta como conectada e registra a sessão no bot
php artisan whatsapp:simular

# aqui: abre a conversa (o comando acima imprime o session-id)
npm run simulate -- <session-id>
```

No REPL, `/reset` limpa a conversa e `/sair` encerra. Para desfazer:
`php artisan whatsapp:simular --desconectar`.

⚠️ Confirmar com *1* no resumo cria uma ordem **real** na API do provedor — não
existe sandbox. Percorra o fluxo à vontade e pare no resumo se não quiser isso.

## Deploy (Railway)

Serviço separado do Laravel, **sem porta pública** — só a rede privada do
projeto precisa alcançá-lo.

1. `DATABASE_PATH=/data/bot.db` e **anexe um volume** em `/data`. Sem volume,
   todas as sessões caem a cada deploy e cada usuário precisa reler o QR.
2. Configure `LARAVEL_URL` e `BOT_SHARED_SECRET`.
3. No Laravel, aponte `BOT_URL` para a URL interna deste serviço.

## Escala

Um processo segura confortavelmente 100–300 sessões; o limite é memória
(~30–80 MB por socket), não CPU. Passando disso, rode réplicas e filtre por
`hash(session_id) % réplicas` no `bootAll()` — o estado já está no banco.

No boot as sessões são reconectadas em lotes (`SESSION_BOOT_BATCH`, padrão 5,
com `SESSION_BOOT_DELAY_MS` entre eles) para não tomar rate-limit do WhatsApp.

## Aviso

O Baileys é engenharia reversa do WhatsApp Web, não uma API oficial. Contas
podem ser banidas — especialmente números novos que passam a responder muitos
desconhecidos. O bot nunca inicia conversa: só responde a quem mandou mensagem
primeiro. Para volume alto, o caminho oficial é a WhatsApp Cloud API.
