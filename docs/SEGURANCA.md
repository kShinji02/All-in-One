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
| Identidade | O WebSocket e as rotas `/api/legal` validam o token em `GET /oauth2/@me`: `application.id` precisa ser o Client ID desta aplicação e os escopos precisam incluir `identify` (token de outra aplicação ou sem o escopo → `invalid_token`; sem Client ID configurado, tudo é recusado sem chamar o Discord). id, nome e avatar vêm só da resposta do Discord. Cache em memória por 60 s (nunca além do vencimento do token) indexado pelo **SHA-256** do token (o token não é guardado) | `server/chat/auth.js`; `server/test/auth.test.js`, `hardening.test.js`, `token-application.test.js` |
| Participação na instância | `GET /applications/{id}/activity-instances/{instanceId}` com o Bot Token; o usuário precisa estar entre os membros (com nova consulta se o cache estiver desatualizado). Revalidação a cada 60 s desconecta quem saiu | `server/chat/instances.js`, `index.js`; `instances.test.js`, `chat-messages.test.js` |
| Isolamento de salas | O `instanceId` é validado por padrão (`[A-Za-z0-9-]`, até 200) antes de entrar na URL; a sala é a devolvida pelo autenticador. Mensagens e histórico só circulam na sala; o nonce de um autor nunca reconcilia mensagens de outro | `server/chat/rooms.js`; `rooms.test.js`, `chat-idempotency.test.js`; `message-store.test.ts` |
| Validação de mensagens | Texto normalizado no servidor (controles e caracteres bidi removidos), até 500 code points; nonce `[A-Za-z0-9_-]{1,64}` sem eco quando inválido; frames até 4 KiB; binário recusado. No cliente, todo frame passa por `parseServerFrame` (avatar só de `cdn.discordapp.com`) | `server/chat/protocol.js`; `protocol.test.js`; `chat-protocol.test.ts` |
| Rate limits | 5 mensagens / 10 s por usuário; 30 frames / 10 s por conexão; 3 conexões por usuário; 50 por sala; auth em até 5 s | `server/chat/config.js`, `rate-limit.js`; `rate-limit.test.js`, `chat-messages.test.js` (limites de conexão), `chat-connection.test.js` (prazo do auth) |
| Conexões indevidas | Upgrade só em `/api/chat` e com `Origin` permitido pelo perfil do ambiente (403 caso contrário). A autenticação é um frame dentro do socket (não cookie), então uma página de terceiros não consegue se passar pelo usuário sem o token dele | `server/chat/origin.js`; `origin.test.js`, `hardening.test.js` |
| Logs | Revisados todos os `console.*`/`logger.*` do backend: só status HTTP, códigos públicos e tipos de erro. No cliente, o `FeatureBoundary` e o módulo de links registram só o tipo/código do erro | `server/chat/*.js`, `app.js`; `routes.test.js`, `external-links.test.tsx`, `HomeView.test.tsx` |
| Tratamento de erros | Express responde erros e caminhos desconhecidos (`404 {"error":"not_found"}`) em JSON, sem stack trace, sem `x-powered-by` e sem ETag; o chat fecha com códigos estáveis; painéis isolados por `FeatureBoundary` | `server/app.js`; `routes.test.js`, `token-application.test.js`, `HomeView.test.tsx` |
| Cabeçalhos HTTP | Todas as respostas do backend: `X-Content-Type-Options: nosniff`, `Cache-Control: no-store` (inclui o `access_token`), `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`. Valem só para as respostas JSON da API: a página da Activity vem do frontend (Cloudflare, `client/public/_headers`), que não pode ter `frame-ancestors`/`X-Frame-Options`. Sem CORS: o frontend chama a API pela mesma origem | `server/app.js` (`SECURITY_HEADERS`); `token-application.test.js` |
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
| `TOKEN_RATE_LIMIT` | 120 | Trocas de código OAuth por minuto, por cliente (IP); alto porque o proxy do Discord faz muitos usuários compartilharem um IP |
| `TOKEN_GLOBAL_RATE_LIMIT` | 240 | Trocas de código OAuth por minuto, no total (por instância) |
| `PORT` | 3001 | Porta HTTP e WebSocket (o Render define a sua) |
| `HOST` | `0.0.0.0` com `NODE_ENV=production` ou no Render; senão o padrão do Node | Interface de escuta |
| `PROXY_DIAGNOSTICS` | desligado | `true` registra quantas entradas o `X-Forwarded-For` tem em `/api/health` (nunca os IPs), para escolher `TRUST_PROXY` |

No Render, os valores recomendados e a verificação do `TRUST_PROXY` estão em
[DEPLOY-RENDER.md](DEPLOY-RENDER.md#proxy-confiável-no-render).

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
| `POST /api/token` sem rate limit | Abuso podia consumir a cota OAuth da aplicação | Janela deslizante por cliente e global (hoje 120/min e 240/min; originalmente 10 e 120, revistos para o IP compartilhado do proxy do Discord); 429 com `Retry-After` e `retryAfterMs`; requisições inválidas também contam; bloqueadas não estendem o bloqueio; prazo de 10 s na chamada ao Discord | `server/app.js`; `server/test/routes.test.js` |
| `*.trycloudflare.com` em todos os ambientes | Qualquer túnel (e subdomínios de vários níveis) era aceito também em produção | Perfis `production` / `local` / `tunnel`; o túnel só no perfil `tunnel` e com um único rótulo; Origin com caminho, consulta ou porta não padrão é recusado | `server/chat/origin.js`; `server/test/hardening.test.js` |
| Cache de 5 min de `/users/@me` | Token revogado aceito por até 5 min em novas conexões | TTL de 60 s, igual à revalidação dos membros; chave continua sendo o SHA-256 (desde a fase 5.1, 401/403 entram num cache negativo de 60 s — ver abaixo) | `server/chat/config.js`; `server/test/hardening.test.js` |
| Rotas HTTP sem teste | `/api/token` e `/api/health` só eram validadas manualmente | App Express extraído para `server/app.js` (sem efeitos colaterais) e coberto com Discord simulado: sucesso, configuração ausente, parâmetros inválidos, JSON inválido, corpo grande, recusa do Discord, 5xx, falha de rede, lentidão | `server/test/routes.test.js` |
| Log de falha de rede no OAuth | A mensagem do erro de rede era registrada (pode conter a URL) | Registra só o tipo do erro | `server/test/routes.test.js` |

Uma invalidação manual do cache de tokens **não** foi criada: o Discord não notifica o servidor
sobre revogações, então ela não teria quem a chamasse. Uma conexão do chat já autenticada não
revalida o token; quem a encerra é a revalidação de membros (60 s) ou o próprio fechamento.

## Proteção da autenticação do WebSocket (fase 5.1)

Antes, cada conexão com um token falso gerava duas chamadas ao Discord (`/users/@me` com o
token e `activity-instances` com o Bot Token), sem limite. O Discord restringe temporariamente
o IP do servidor a partir de 10.000 respostas 401/403/429 em 10 minutos, o que derrubaria o
chat de todos. Medição com o servidor real e o Discord simulado (300 conexões de um único
cliente): antes 232 + 232 chamadas e 159 sockets abertos; depois 50 + 0 e no máximo 50 sockets.

| Camada | Limite | Por quê |
|---|---|---|
| Upgrade: falhas por IP | 200 falhas em 5 min (era 20; ver a seção seguinte) → upgrade recusado com HTTP 429 + `Retry-After` até a janela passar | Bloqueia a enxurrada de um IP **antes** de aceitar o socket. Só contam erros anteriores à identidade (`invalid_token`, protocolo); `discord_unavailable`, `auth_timeout`, falhas do servidor e erros de quem tem token válido (`not_in_instance`) não contam |
| Upgrade: taxa por IP | 300 upgrades por minuto (era 60) e 1.200 no total do processo → HTTP 429 / 503 | Limita conexões abertas antes de qualquer falha ser registrada |
| Sockets não autenticados | 200 por IP (era 50) e 500 no total → HTTP 429 / 503 | Cada um vive no máximo 5 s (`auth_timeout`); a vaga é liberada ao autenticar ou fechar |
| Validações reais de token | 100 a cada 10 s no total (cache miss) → `1013 discord_unavailable` | Teto independente de IP e de token: no pior caso 6.000 chamadas em 10 min, abaixo dos 10.000 do Discord |
| Cache negativo | 401/403 de `/oauth2/@me` (e tokens de outra aplicação ou sem `identify`) guardados por 60 s (chave: SHA-256, até 5.000 entradas) | Repetir o mesmo token inválido não chama o Discord; um token recusado não volta a ser válido |
| Ordem das consultas | `activity-instances` (Bot Token) só depois de o token do usuário ser válido | Token falso nunca consome a cota do bot |
| 429 do Discord | Respeita `retry_after` / `Retry-After` (teto de 5 min): global ou sem JSON (bloqueio por IP) → nenhuma validação até passar; por token → só aquele token; bot → nenhuma consulta de instância (o cache válido continua servindo) | Insistir durante um 429 é o que leva à restrição do IP |

**Usuários legítimos.** Quem já está conectado continua conversando mesmo que o IP seja
bloqueado depois. As recusas de upgrade chegam ao navegador como `1006`, que o cliente trata como
queda passageira (reconecta com backoff); `1013` também. Quem reconecta com um token já validado
(cache de 60 s) não depende do teto global.

## Limites com IP compartilhado (proxy do Discord)

O proxy das Activities do Discord existe para **esconder o IP dos usuários**: no Render, muitas
pessoas podem chegar com o mesmo IP. Com os valores originais, medidos com o código real e todos
no mesmo IP, o `/api/token` bloqueava a partir do 11º usuário por minuto, 100 entradas simultâneas
estouravam o limite de 50 sockets pendentes, e **20 tokens falsos de uma pessoa bloqueavam novas
conexões de todos por 5 min**. Os limites foram reorganizados assim:

- **Antes da autenticação** só existem tetos por IP dimensionados para ~100 usuários atrás de um
  IP, mais tetos **globais** do processo (um contador por instância, compartilhado por todos os
  pontos que o usam: o validador de token é o mesmo no chat e nas rotas `/api/legal`).
- **Depois da autenticação**, a cota é de cada conta, pelo ID do Discord devolvido pela validação
  do token no servidor (nunca um ID enviado pelo cliente).

| Momento | Limite | Valor | Por quê |
|---|---|---|---|
| Antes (sem identidade) | `/api/token` por IP | 120/min | 100 entradas + novas tentativas no mesmo IP; o código OAuth não identifica a pessoa |
| | `/api/token` global | 240/min | Pior caso com códigos inválidos: 2.400 recusas em 10 min, abaixo das 10.000 que restringem o IP do servidor |
| | Upgrades por IP / global | 300/min / 1.200/min | 100 usuários com reconexões; o global segura enxurradas de muitos IPs |
| | Sockets pendentes por IP / total | 200 / 500 | 100 entradas simultâneas; cada socket vive até 5 s |
| | Falhas por IP | 200 em 5 min | Uma pessoa sozinha não bloqueia todos; uma enxurrada ainda é cortada |
| | Rotas `/api/legal` por IP | 300/min (status e aceite) | Teto contra enxurradas antes de validar o token |
| | Validações de token no Discord (global) | 100 a cada 10 s (mantido) | Garantia contra a restrição do IP do servidor (≤ 6.000 em 10 min), compartilhada por chat e rotas legais |
| | Cache negativo / positivo de tokens | 60 s | Token repetido não chama o Discord |
| Depois (por conta) | Autenticações no chat | 30/min → `4029 too_many_auth_attempts` | Contém a tempestade de reconexões de uma conta |
| | Conexões simultâneas | 3 | — |
| | Mensagens / frames | 5 a cada 10 s / 30 a cada 10 s por conexão | — |
| | Rotas `/api/legal` | 20/min (status), 6/min (aceite) | — |
| Produto | Conexões por sala | 50 (mantido) | Limite da instância da Activity |

**Custo aceito.** Antes da autenticação não há como distinguir um atacante de um usuário quando
os dois chegam pelo mesmo IP. Com o teto de falhas mais alto, uma enxurrada de tokens falsos de um
único IP pode esgotar o teto global de validações (100 a cada 10 s) por alguns segundos antes de o
IP ser bloqueado: nesse intervalo, quem chega com um token **novo** recebe `1013` e reconecta com
backoff (quem tem token em cache entra normalmente). É o preço de não bloquear uma sala inteira
por causa de uma pessoa.

**Por instância.** Todos esses contadores ficam em memória: valem **por instância do servidor**.
Com várias instâncias no Render, cada uma tem os próprios contadores e os tetos "globais" se
multiplicam pelo número de instâncias. Hoje o serviço roda com uma instância.

**Depende do deploy.** Quantos usuários de fato compartilham um IP só pode ser medido no Render
(`PROXY_DIAGNOSTICS=true`; ver [DEPLOY-RENDER.md](DEPLOY-RENDER.md#proxy-confiável-no-render)).
Os valores acima partem do pior caso (todos no mesmo IP).

Evidência: `server/test/shared-ip-limits.test.js` (10, 30, 50 e 100 usuários no mesmo IP, 20 e 200
tokens inválidos, reconexões simultâneas, tempestade de uma conta, tetos globais compartilhados).

**IP do cliente.** O chat usa a mesma regra do `/api/token`: `app.get("trust proxy fn")`,
compilada a partir de `TRUST_PROXY` (`server/chat/client-ip.js`). Sem proxy confiável, o IP é o
do socket e `X-Forwarded-For` é ignorado; com proxies confiáveis, vale o valor mais à direita
não confiável, e o que o cliente forja à esquerda é ignorado.

Evidência: `server/test/auth-abuse.test.js` (servidor real, Discord simulado, relógio injetado).

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
   Express enxerga antes de reduzir `TOKEN_RATE_LIMIT`. O mesmo vale para os limites por IP do
   WebSocket: atrás de um proxy (como o do Discord), todos compartilham um IP; os valores atuais
   foram dimensionados para isso (ver "Limites com IP compartilhado").
   O teto global de validações também pode ser esgotado de propósito: nesse caso, quem chega com
   um token novo recebe `1013` e tenta de novo com backoff até a janela de 10 s passar — preço
   aceito para nunca arriscar a restrição do IP do servidor.
3. **Janela de revogação.** Um token revogado continua aceito em novas conexões por até 60 s
   (cache de `/oauth2/@me`), e quem sai da instância pode continuar conectado por até 60 s.
4. **Limites por processo.** Rate limits, caches e salas vivem em memória de um único processo;
   com várias instâncias do backend, os limites valem por instância.
5. **Sem persistência nem criptografia em repouso** porque nada é persistido: as mensagens
   vivem só em memória no backend.
