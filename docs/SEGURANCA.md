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
| OAuth | O frontend recebe só o `code` do `authorize`; `POST /api/token` troca o código usando o Client Secret no servidor e devolve só o `access_token`. Erros repassam apenas o código público do OAuth (ex.: `invalid_grant`). Rate limit por cliente e global | `server/app.js`; `server/test/routes.test.js` |
| Identidade | O WebSocket valida o token em `GET /users/@me`; id, nome e avatar vêm só da resposta do Discord. Cache em memória por 60 s indexado pelo **SHA-256** do token (o token não é guardado) | `server/chat/auth.js`; `server/test/auth.test.js`, `hardening.test.js` |
| Participação na instância | `GET /applications/{id}/activity-instances/{instanceId}` com o Bot Token; o usuário precisa estar entre os membros (com nova consulta se o cache estiver desatualizado). Revalidação a cada 60 s desconecta quem saiu | `server/chat/instances.js`, `index.js`; `instances.test.js`, `chat-messages.test.js` |
| Isolamento de salas | O `instanceId` é validado por padrão (`[A-Za-z0-9-]`, até 200) antes de entrar na URL; a sala é a devolvida pelo autenticador. Mensagens e histórico só circulam na sala; o nonce de um autor nunca reconcilia mensagens de outro | `server/chat/rooms.js`; `rooms.test.js`, `chat-idempotency.test.js`; `message-store.test.ts` |
| Validação de mensagens | Texto normalizado no servidor (controles e caracteres bidi removidos), até 500 code points; nonce `[A-Za-z0-9_-]{1,64}` sem eco quando inválido; frames até 4 KiB; binário recusado. No cliente, todo frame passa por `parseServerFrame` (avatar só de `cdn.discordapp.com`) | `server/chat/protocol.js`; `protocol.test.js`; `chat-protocol.test.ts` |
| Rate limits | 5 mensagens / 10 s por usuário; 30 frames / 10 s por conexão; 3 conexões por usuário; 50 por sala; auth em até 5 s | `server/chat/config.js`, `rate-limit.js`; `rate-limit.test.js`, `chat-messages.test.js` (limites de conexão), `chat-connection.test.js` (prazo do auth) |
| Conexões indevidas | Upgrade só em `/api/chat` e com `Origin` permitido pelo perfil do ambiente (403 caso contrário). A autenticação é um frame dentro do socket (não cookie), então uma página de terceiros não consegue se passar pelo usuário sem o token dele | `server/chat/origin.js`; `origin.test.js`, `hardening.test.js` |
| Logs | Revisados todos os `console.*`/`logger.*` do backend: só status HTTP, códigos públicos e tipos de erro. No cliente, o `FeatureBoundary` e o módulo de links registram só o tipo/código do erro | `server/chat/*.js`, `app.js`; `routes.test.js`, `external-links.test.tsx`, `HomeView.test.tsx` |
| Tratamento de erros | Express responde erros em JSON sem stack trace (sem `x-powered-by`); o chat fecha com códigos estáveis; painéis isolados por `FeatureBoundary` | `server/app.js`; `routes.test.js`, `HomeView.test.tsx` |
| Links externos | Só `http`/`https` viram link; texto nunca vira HTML (sem `innerHTML`/Markdown); dentro do Discord, abertura só por `commands.openExternalLink` (confirmação do Discord), sem `href` no iframe; sem pré-carregamento de link ou imagem | `client/src/features/chat/lib/linkify.ts`, `discord/external-link.ts`; `chat-lib.test.ts`, `external-links.test.tsx` |
| Segredos no bundle | Verificado na auditoria: os valores de `DISCORD_CLIENT_SECRET` e `DISCORD_BOT_TOKEN` não aparecem em nenhum arquivo de `client/dist` | build de produção |
| Armazenamento no cliente | Nenhum `localStorage`/`sessionStorage`; o token OAuth fica só em memória | `message-store.test.ts`, `useChat.test.tsx` |

## Bot Token

O Bot Token é usado **somente** como credencial da aplicação (`Authorization: Bot …`) numa
chamada REST: `GET /applications/{application_id}/activity-instances/{instance_id}`. O chat não
usa o Gateway do Discord, intents nem permissões de servidor. Se o token for recusado (401/403),
o servidor registra `DISCORD_BOT_TOKEN recusado pelo Discord (HTTP 401)` — sem o token — e
fecha as conexões com `1011 server_misconfigured`. Se vazar, gere outro em **Bot → Reset Token**.

## Configuração de produção

Variáveis opcionais do backend (todas com padrão seguro; nenhuma é segredo):

| Variável | Padrão | Uso |
|---|---|---|
| `NODE_ENV` | — | `production` ativa o perfil de origens `production` |
| `ORIGIN_PROFILE` | `production` se `NODE_ENV=production`; senão `tunnel` | Origens aceitas no WebSocket do chat: `production` (só `https://<client_id>.discordsays.com`), `local` (+ localhost), `tunnel` (+ `https://<subdomínio>.trycloudflare.com`, um único rótulo) |
| `CHAT_EXTRA_ORIGINS` | vazio | Origens HTTPS **exatas** adicionais, separadas por vírgula (sem curingas) |
| `TRUST_PROXY` | sem proxy confiável | Quantos proxies à frente do Express são confiáveis (`1`, `2`…) ou sub-rede (`loopback`, `10.0.0.0/8`). Sem isso, o IP do cliente é o do socket e `X-Forwarded-For` é ignorado. `true` é recusado |
| `TOKEN_RATE_LIMIT` | 10 | Trocas de código OAuth por minuto, por cliente (IP) |
| `TOKEN_GLOBAL_RATE_LIMIT` | 120 | Trocas de código OAuth por minuto, no total |

**Rate limit e proxies.** O IP usado no limite por cliente é `req.ip` do Express, que só lê
`X-Forwarded-For` dos proxies declarados em `TRUST_PROXY` (o valor mais à direita não
confiável; o que o cliente forja à esquerda é ignorado). Se o Express estiver atrás de proxies
e `TRUST_PROXY` não for configurado, **todos os usuários compartilham o IP do proxy** e o
limite por cliente vira um limite total: configure `TRUST_PROXY` para os proxies que você
controla, ou ajuste `TOKEN_RATE_LIMIT`. Em desenvolvimento (Vite → Express) todos chegam como
`127.0.0.1`, o que é suficiente para os testes.

## Hardening da fase 4.9

| Ponto | Diagnóstico | Solução | Evidência |
|---|---|---|---|
| `POST /api/token` sem rate limit | Abuso podia consumir a cota OAuth da aplicação | Janela deslizante por cliente (10/min) e global (120/min); 429 com `Retry-After` e `retryAfterMs`; requisições inválidas também contam; bloqueadas não estendem o bloqueio; prazo de 10 s na chamada ao Discord | `server/app.js`; `server/test/routes.test.js` |
| `*.trycloudflare.com` em todos os ambientes | Qualquer túnel (e subdomínios de vários níveis) era aceito também em produção | Perfis `production` / `local` / `tunnel`; o túnel só no perfil `tunnel` e com um único rótulo; Origin com caminho, consulta ou porta não padrão é recusado | `server/chat/origin.js`; `server/test/hardening.test.js` |
| Cache de 5 min de `/users/@me` | Token revogado aceito por até 5 min em novas conexões | TTL de 60 s, igual à revalidação dos membros; respostas 401/403 não entram no cache; chave continua sendo o SHA-256 | `server/chat/config.js`; `server/test/hardening.test.js` |
| Rotas HTTP sem teste | `/api/token` e `/api/health` só eram validadas manualmente | App Express extraído para `server/app.js` (sem efeitos colaterais) e coberto com Discord simulado: sucesso, configuração ausente, parâmetros inválidos, JSON inválido, corpo grande, recusa do Discord, 5xx, falha de rede, lentidão | `server/test/routes.test.js` |
| Log de falha de rede no OAuth | A mensagem do erro de rede era registrada (pode conter a URL) | Registra só o tipo do erro | `server/test/routes.test.js` |

Uma invalidação manual do cache de tokens **não** foi criada: o Discord não notifica o servidor
sobre revogações, então ela não teria quem a chamasse. Uma conexão do chat já autenticada não
revalida o token; quem a encerra é a revalidação de membros (60 s) ou o próprio fechamento.

## Pontos de atenção (não são vulnerabilidades exploráveis hoje)

1. **Dependência transitiva `zod` (npm audit: high, GHSA-mrhx-c7xc-m3w5, CVSS 7.5).**
   - Cadeia: `@discord/embedded-app-sdk@2.5.0` → `zod@3.25.76`. O SDK 2.5.0 é a versão mais
     recente publicada e declara `zod: ^3.9.8`; `3.25.76` é a última da série 3.
   - Correção disponível só no `zod` 4.6.6 (major, API diferente). Forçar via `overrides`
     quebraria o SDK, que usa a API da série 3; por isso nada foi alterado.
   - Alcance: o SDK só processa `postMessage` de origens do próprio Discord (`ALLOWED_ORIGINS`
     em `Discord.mjs`), então o `zod` só valida dados do cliente do Discord. O código do projeto
     não importa `zod`.
   - Acompanhamento: o Renovate (`renovate.json`) abre PR quando o SDK publicar versão nova;
     rodar `npm audit` em `client/` a cada atualização do SDK e remover este item quando o SDK
     passar a depender de `zod >= 4.6.6`.
2. **Identificação do cliente atrás de proxies.** O limite por cliente depende de `TRUST_PROXY`
   refletir a topologia real (ver "Rate limit e proxies"). Na implantação, confira qual IP o
   Express enxerga antes de reduzir `TOKEN_RATE_LIMIT`.
3. **Janela de revogação.** Um token revogado continua aceito em novas conexões por até 60 s
   (cache de `/users/@me`), e quem sai da instância pode continuar conectado por até 60 s.
4. **Limites por processo.** Rate limits, caches e salas vivem em memória de um único processo;
   com várias instâncias do backend, os limites valem por instância.
5. **Sem persistência nem criptografia em repouso** porque nada é persistido: as mensagens
   vivem só em memória no backend.
