# All-in-One — Discord Activity

Activity do Discord que reúne, num só lugar, **participantes em tempo real** e **chat em
tempo real** da instância, com a base preparada para os próximos módulos (comunicação e
player de mídia).

Baseado no template oficial [Building an Activity](https://docs.discord.com/developers/activities/building-an-activity)
do Discord (Embedded App SDK), reescrito em React + TypeScript + Tailwind no frontend e
Express + `ws` no backend.

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/TESTE-NO-DISCORD.md](docs/TESTE-NO-DISCORD.md) | Configuração do Developer Portal, `.env`, Bot Token, túnel, execução dentro do Discord e roteiros de teste manual |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Arquitetura: autenticação, chat em tempo real, reconexão, store de mensagens, Home e registro de módulos, tratamento de erros, limitações |
| [docs/CHAT-PROTOCOL.md](docs/CHAT-PROTOCOL.md) | Protocolo do WebSocket do chat: frames, limites e códigos de fechamento |
| [docs/SEGURANCA.md](docs/SEGURANCA.md) | Modelo de segurança e resultado da auditoria |
| [docs/DEPLOY-RENDER.md](docs/DEPLOY-RENDER.md) | Implantação do backend no Render: comandos, variáveis de ambiente e `TRUST_PROXY` |

## Requisitos

- **Node.js 20 ou mais recente** (o projeto é testado com Node 26) e npm.
- Uma conta no Discord e uma aplicação no [Developer Portal](https://discord.com/developers/applications)
  com Activities habilitadas.
- [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  para expor o servidor local ao Discord durante o desenvolvimento.

## Estrutura

```
.
├── client/            Frontend (Vite + React + TypeScript + Tailwind)
│   ├── src/
│   │   ├── app/           Raiz da aplicação (providers)
│   │   ├── discord/       Embedded App SDK, OAuth, sessão, participantes, links externos
│   │   ├── realtime/      Chat: protocolo, conexão WebSocket, store de mensagens, useChat
│   │   ├── features/      Módulos (chat, participants, session, home) e o registro
│   │   └── components/    UI compartilhada (painéis, indicadores, FeatureBoundary)
│   ├── scripts/           dev-discord.mjs (servidor para testar dentro do Discord)
│   └── test/              Testes (Vitest + Testing Library)
├── server/            Backend (Express + ws)
│   ├── server.js          Entrada: lê o ambiente, monta o app e o chat, abre a porta 3001
│   ├── app.js             Rotas HTTP (/api/health, /api/token com rate limit)
│   ├── chat/              Chat: autenticação, salas, protocolo, limites
│   └── test/              Testes (node:test)
├── docs/              Documentação
└── example.env        Modelo do .env (sem valores reais)
```

## Instalação

```bash
cd server && npm install
cd ../client && npm install
```

## Configuração

1. Copie o modelo e preencha com os valores da **sua** aplicação (nunca commite o `.env`):

   ```bash
   cp example.env .env
   ```

   | Variável | Onde obter | Usada por |
   |---|---|---|
   | `VITE_DISCORD_CLIENT_ID` | Developer Portal → OAuth2 → Client ID | frontend (SDK) e backend |
   | `DISCORD_CLIENT_SECRET` | Developer Portal → OAuth2 → Client Secret | só o backend (troca do código OAuth) |
   | `DISCORD_BOT_TOKEN` | Developer Portal → Bot → Reset Token | só o backend (validação da instância no chat) |

   Só variáveis com prefixo `VITE_` chegam ao navegador. Para produção há variáveis opcionais
   do backend (`NODE_ENV`, `ORIGIN_PROFILE`, `CHAT_EXTRA_ORIGINS`, `TRUST_PROXY`,
   `TOKEN_RATE_LIMIT`, `TOKEN_GLOBAL_RATE_LIMIT`), descritas em
   [docs/SEGURANCA.md](docs/SEGURANCA.md#configuração-de-produção). O passo a passo completo do Developer
   Portal, do Bot Token e do túnel está em [docs/TESTE-NO-DISCORD.md](docs/TESTE-NO-DISCORD.md).

2. Confira o backend: `curl http://localhost:3001/api/health` deve responder
   `{"ok":true,"oauthConfigured":true,"chatConfigured":true}` (a resposta nunca mostra os valores).

## Executar

Três terminais:

```bash
cd server && npm run dev            # backend em http://localhost:3001
```

```bash
cd client && npm run dev            # frontend em http://localhost:5173 (com HMR)
```

```bash
cloudflared tunnel --url http://localhost:5173
```

Para testar **dentro do Discord no celular ou com quedas de internet**, use
`npm run dev:discord` no lugar de `npm run dev` (mesma porta). Ele serve o build de produção
(sem o cliente HMR do Vite, que recarregaria a Activity e bloquearia o WebSocket do chat) e
refaz o build a cada alteração. Detalhes em [docs/TESTE-NO-DISCORD.md](docs/TESTE-NO-DISCORD.md).

Fora do Discord (abrindo `http://localhost:5173` no navegador) a interface carrega, mas a
sessão, os participantes e o chat ficam indisponíveis: eles dependem do Embedded App SDK.

## Scripts

| Pasta | Comando | O que faz |
|---|---|---|
| `server/` | `npm start` | Inicia o backend (`node server.js`) na `PORT` do ambiente ou na 3001 |
| `server/` | `npm run dev` | O mesmo que `npm start` |
| `server/` | `npm test` | Testes do backend (`node --test`) |
| `client/` | `npm run dev` | Vite com HMR na porta 5173 |
| `client/` | `npm run dev:discord` | Build de produção em watch + `vite preview` na porta 5173 |
| `client/` | `npm test` | Verifica os tipos dos testes e roda o Vitest |
| `client/` | `npm run test:watch` | Vitest em modo watch |
| `client/` | `npm run typecheck` | `tsc -b` |
| `client/` | `npm run build` | `tsc -b` + build de produção em `client/dist` |
| `client/` | `npm run preview` | Serve o build de `client/dist` |

## Testes

```bash
cd server && npm test
cd ../client && npm test
```

A suíte do client falha se houver testes ignorados (`skip`), pendentes (`todo`) ou `.only`
esquecido (reporter estrito em `client/test/reporters/strict-reporter.ts`). Os testes de
integração do chat sobem o `attachChat` **real** do servidor; só o autenticador externo do
Discord é substituído. Verificação adicional antes de entregar: `git diff --check`.

## Build de produção

```bash
cd client && npm run build      # gera client/dist
```

O backend não serve o `client/dist`: em produção, publique o build num servidor de arquivos
estáticos com `/api` (HTTP e WebSocket) encaminhado ao backend, e mapeie esse endereço no
URL Mapping da Activity. Inicie o backend com `NODE_ENV=production` (só o `discordsays.com`
da aplicação é aceito no chat) e ajuste `TRUST_PROXY` aos seus proxies. Para o Render, veja
[docs/DEPLOY-RENDER.md](docs/DEPLOY-RENDER.md).
