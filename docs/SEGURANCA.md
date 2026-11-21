# Segurança

Modelo de segurança do All-in-One e resultado da auditoria da fase 4.8 (fases 4.0–4.7).
Cada item indica onde o comportamento está implementado e onde é testado.

## Princípios

- **Segredos só no backend.** `DISCORD_CLIENT_SECRET` e `DISCORD_BOT_TOKEN` são lidos apenas
  pelo Express. Só variáveis `VITE_*` entram no bundle (o Client ID, que é público).
- **Identidade vem do Discord, nunca do cliente.** O servidor ignora qualquer dado de usuário
  enviado pelo navegador.
- **Sala = instância validada.** A sala do chat é o `instanceId` confirmado pelo Discord.
- **Nada sensível em log.** Logs registram status HTTP e tipos de erro; nunca tokens, segredos,
  texto de mensagens ou URLs de links.

## Resultado da auditoria

Nenhuma vulnerabilidade explorável foi encontrada; nenhuma alteração de segurança foi feita.

| Área | Como é garantido | Evidência |
|---|---|---|
| OAuth | O frontend recebe só o `code` do `authorize`; `POST /api/token` troca o código usando o Client Secret no servidor e devolve só o `access_token`. Erros repassam apenas o código público do OAuth (ex.: `invalid_grant`) | `server/server.js`; **sem teste automatizado da rota** (validada no teste manual; ver ponto de atenção 6) |
| Identidade | O WebSocket valida o token em `GET /users/@me`; id, nome e avatar vêm só da resposta do Discord. Cache em memória por 5 min indexado pelo **SHA-256** do token (o token não é guardado) | `server/chat/auth.js`; `server/test/auth.test.js` |
| Participação na instância | `GET /applications/{id}/activity-instances/{instanceId}` com o Bot Token; o usuário precisa estar entre os membros (com nova consulta se o cache estiver desatualizado). Revalidação a cada 60 s desconecta quem saiu | `server/chat/instances.js`, `index.js`; `instances.test.js`, `chat-messages.test.js` |
| Isolamento de salas | O `instanceId` é validado por padrão (`[A-Za-z0-9-]`, até 200) antes de entrar na URL; a sala é a devolvida pelo autenticador. Mensagens e histórico só circulam na sala; o nonce de um autor nunca reconcilia mensagens de outro | `server/chat/rooms.js`; `rooms.test.js`, `chat-idempotency.test.js`; `message-store.test.ts` |
| Validação de mensagens | Texto normalizado no servidor (controles e caracteres bidi removidos), até 500 code points; nonce `[A-Za-z0-9_-]{1,64}` sem eco quando inválido; frames até 4 KiB; binário recusado. No cliente, todo frame passa por `parseServerFrame` (avatar só de `cdn.discordapp.com`) | `server/chat/protocol.js`; `protocol.test.js`; `chat-protocol.test.ts` |
| Rate limits | 5 mensagens / 10 s por usuário; 30 frames / 10 s por conexão; 3 conexões por usuário; 50 por sala; auth em até 5 s | `server/chat/config.js`, `rate-limit.js`; `rate-limit.test.js`, `chat-messages.test.js` (limites de conexão), `chat-connection.test.js` (prazo do auth) |
| Conexões indevidas | Upgrade só em `/api/chat` e com `Origin` permitido (403 caso contrário). A autenticação é um frame dentro do socket (não cookie), então uma página de terceiros não consegue se passar pelo usuário sem o token dele | `server/chat/origin.js`; `origin.test.js` |
| Logs | Revisados todos os `console.*`/`logger.*` do backend: só status HTTP, códigos públicos e tipos de erro. No cliente, o `FeatureBoundary` e o módulo de links registram só o tipo/código do erro | `server/chat/*.js`, `server.js`; `external-links.test.tsx`, `HomeView.test.tsx` |
| Tratamento de erros | Express responde erros em JSON sem stack trace; o chat fecha com códigos estáveis; painéis isolados por `FeatureBoundary` | `server/server.js`; `HomeView.test.tsx` |
| Links externos | Só `http`/`https` viram link; texto nunca vira HTML (sem `innerHTML`/Markdown); dentro do Discord, abertura só por `commands.openExternalLink` (confirmação do Discord), sem `href` no iframe; sem pré-carregamento de link ou imagem | `client/src/features/chat/lib/linkify.ts`, `discord/external-link.ts`; `chat-lib.test.ts`, `external-links.test.tsx` |
| Segredos no bundle | Verificado na auditoria: os valores de `DISCORD_CLIENT_SECRET` e `DISCORD_BOT_TOKEN` não aparecem em nenhum arquivo de `client/dist` | build de produção |
| Armazenamento no cliente | Nenhum `localStorage`/`sessionStorage`; o token OAuth fica só em memória | `message-store.test.ts`, `useChat.test.tsx` |

## Bot Token

O Bot Token é usado **somente** como credencial da aplicação (`Authorization: Bot …`) numa
chamada REST: `GET /applications/{application_id}/activity-instances/{instance_id}`. O chat não
usa o Gateway do Discord, intents nem permissões de servidor. Se o token for recusado (401/403),
o servidor registra `DISCORD_BOT_TOKEN recusado pelo Discord (HTTP 401)` — sem o token — e
fecha as conexões com `1011 server_misconfigured`. Se vazar, gere outro em **Bot → Reset Token**.

## Pontos de atenção (não são vulnerabilidades exploráveis hoje)

1. **Dependência transitiva `zod` (npm audit: high, GHSA-mrhx-c7xc-m3w5).** Vem do
   `@discord/embedded-app-sdk`, que exige `zod ^3` (não há correção na série 3). O SDK só
   processa `postMessage` de origens do próprio Discord (`ALLOWED_ORIGINS`), então o `zod` só
   valida dados do cliente do Discord; o código do projeto não usa `zod`. Forçar o `zod` 4
   quebraria o SDK. Acompanhar atualizações do SDK (o Renovate está configurado).
2. **`POST /api/token` sem rate limit próprio.** Um código só vale uma vez e a troca é feita
   pelo Discord, mas abuso pode consumir o limite de requisições OAuth da aplicação. Em produção,
   aplicar rate limit por IP no proxy ou no Express.
3. **`*.trycloudflare.com` na lista de origens.** Necessário em desenvolvimento; em produção,
   restrinja a `https://<client_id>.discordsays.com` (`server/chat/origin.js`).
4. **Janela de revogação.** Um token revogado continua aceito por até 5 min (cache de
   `/users/@me`), e quem sai da instância pode continuar conectado por até 60 s (revalidação).
5. **Sem persistência nem criptografia em repouso** porque nada é persistido: as mensagens
   vivem só em memória no backend.
6. **Rotas HTTP do Express sem teste automatizado.** `/api/token` e `/api/health` só são
   validadas manualmente (fluxo de autenticação no Discord). Recomendação: extrair o app Express
   para um módulo testável e cobrir os casos de erro (`server_misconfigured`, `invalid_request`,
   `token_exchange_failed`) sem chamar o Discord.
