# Arquitetura

Visão técnica do All-in-One. Os valores citados (prazos, limites) são os do código; quando
mudarem, atualize este documento junto.

## Visão geral

```
Discord (cliente)                         Backend (Express + ws, porta 3001)
┌──────────────────────────────────┐      ┌───────────────────────────────────────────┐
│ iframe <id>.discordsays.com      │      │ GET  /api/health                          │
│  ├─ Embedded App SDK (postMessage)│      │ POST /api/token  (code → access_token)   │
│  ├─ React app                    │─────▶│ WS   /api/chat   (attachChat)             │
│  │   DiscordProvider             │ URL  │       ├─ autenticador (Discord REST)       │
│  │   ChatConnectionProvider      │ Map  │       ├─ salas por instanceId              │
│  │   Home (registro de módulos)  │ ping │       └─ limites, histórico, idempotência  │
└──────────────────────────────────┘      └───────────────────────────────────────────┘
        │ SDK: participantes, authorize/authenticate, openExternalLink
        ▼
     Discord
```

Em desenvolvimento o caminho é: Discord → URL Mapping `/` → Cloudflare Tunnel → Vite (porta
5173) → proxy `/api` (HTTP e WebSocket) → Express (porta 3001).

## Frontend: providers e sessão

`App` monta, nesta ordem: `DiscordProvider` → `ChatConnectionProvider` → `AppShell` → `HomeView`.

**DiscordProvider** (`client/src/discord/`) executa o fluxo oficial do SDK, uma única vez por
página (`startDiscordSession` é memorizado, compatível com StrictMode):

1. `sdk.ready()` — handshake (prazo de 10 s; erro `ready_timeout`).
2. `commands.authorize` com os escopos `identify` e `guilds`.
3. `POST /api/token` — o backend troca o código pelo `access_token` usando o Client Secret
   (rate limit por cliente e global; acima dele, `429` com `Retry-After`).
4. `commands.authenticate` com o token.
5. Contexto: canal (`commands.getChannel`) e servidor (`/users/@me/guilds`).

Expõe `state` (`connecting` / `ready` / `error` / `unavailable` / `misconfigured`) e
`sdkReady`, verdadeiro assim que o handshake termina, mesmo que o OAuth falhe depois. O token
OAuth fica **só em memória** (`getAccessToken()`), nunca em `localStorage`/`sessionStorage`.

Os erros de handshake (`ready_timeout`, `sdk_init_failed`) oferecem **Recarregar Activity**: o
SDK envia o handshake uma única vez, no construtor, então só uma página nova consegue repeti-lo.

**Participantes** (`features/participants/`) dependem só de `sdkReady`
(`getActivityInstanceConnectedParticipants` + evento `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`),
não do OAuth nem do backend: se a autenticação falhar, a lista continua, sem o selo "Você".

## Chat em tempo real

Camadas no frontend (`client/src/realtime/`), cada uma testada isoladamente:

| Camada | Arquivo | Responsabilidade |
|---|---|---|
| Protocolo | `chat-protocol.ts` | Tipos, limites e `parseServerFrame` (valida todo frame recebido; nunca lança) |
| Fechamentos | `chat-close-codes.ts` | `classifyClose(code, reason)` → categoria e se reconecta |
| Conexão | `chat-connection.ts` | Ciclo de vida de UM WebSocket por par token + instância: auth, backoff, rede, prazos |
| Store | `message-store.ts` | Mensagens confirmadas e locais, envio otimista, reconciliação por nonce (sem React) |
| Provider | `ChatConnectionProvider.tsx` | Cria conexão + store da sessão atual e as descarta juntas |
| Hook | `useChat.ts` | API para a interface, via `useSyncExternalStore` |
| Interface | `features/chat/` | `ChatView` → `ChatPanel` (lista, rolagem, composer, estados) |

### Fluxo de conexão

1. O provider só conecta com sessão Discord `ready`, token em memória e `instanceId`.
2. A conexão abre `wss://<host da página>/api/chat` (mesma origem do `/api/token`).
3. No `open`, envia `{ type: "auth", accessToken, instanceId }`.
4. O servidor valida no Discord, nesta ordem: identidade em `/oauth2/@me` (o token precisa ser
   **desta aplicação** e ter o escopo `identify`) e, só se o token for válido, participação na instância em `/applications/{id}/activity-instances/{instanceId}`
   com o Bot Token (limites contra abuso em [SEGURANCA.md](SEGURANCA.md#proteção-da-autenticação-do-websocket-fase-51)). Responde
   `ready` (o próprio usuário) e `history` (até 100 mensagens).
5. Mensagens novas chegam como `message`. O protocolo completo está em [CHAT-PROTOCOL.md](CHAT-PROTOCOL.md).

Trocar o token ou a instância descarta a conexão e a store antigas e cria novas: mensagens e
pendências de uma sessão nunca aparecem em outra, e uma store antiga não envia pela conexão nova.

### Reconexão

| Situação | Comportamento |
|---|---|
| Queda passageira (1006, 1001, 1013, `auth_timeout`, `auth_failed`…) | Backoff exponencial com jitter: espera entre metade e o total de `min(30 s, 1 s · 2^(n−1))` |
| Limite | 8 tentativas seguidas sem uma sala **estável**; depois, `stopped: retries_exhausted` com botão **Reconectar** |
| Sala estável | O contador só zera depois de 30 s com a sala aberta; quedas logo após o `ready` contam como falha |
| Handshake | Sem `ready` em 15 s, o cliente fecha (4900) e conta como queda |
| Sem internet (`navigator.onLine === false`) | Estado `offline` ("Sem internet"): sem backoff; uma tentativa a cada 30 s, contando no limite |
| Evento `online` | Só uma transição real (sem rede → com rede) reconecta na hora e zera o contador, no máximo 1 vez por minuto |
| Evento `offline` | Não derruba um socket vivo (o navegador pode errar); só suspende a espera do backoff |
| App suspenso (timers congelados) | Prazo que dispara mais de 5 s atrasado é renovado uma vez em vez de encerrar |
| Parada definitiva | Sessão expirada, fora da instância, limite de conexões, chat não configurado, protocolo: sem reconexão automática |

A tabela de fechamentos e categorias está em [CHAT-PROTOCOL.md](CHAT-PROTOCOL.md#códigos-de-fechamento).
Nunca existem dois WebSockets do chat vivos ao mesmo tempo.

### Envio otimista e recuperação de mensagens

A store guarda duas coleções: **confirmadas** (indexadas pelo `id` do servidor, no máximo
100) e **locais** (`pending` / `failed`, indexadas por um nonce gerado com `crypto.randomUUID()`).

1. `send(text)` insere a mensagem como `pending` na hora e entrega o frame à conexão, se a sala
   estiver aberta **e o histórico desta conexão já tiver chegado**.
2. Só a evidência do servidor confirma: a `message` com o mesmo nonce (só a conexão que enviou
   recebe) ou o `history`, que traz o nonce apenas nas mensagens do próprio usuário.
3. A confirmada substitui a local com a mesma chave visual (sem duplicar nem "pular" na lista).

Recuperação:

- **Queda antes da confirmação:** a mensagem continua `pending`. Após reconectar, o histórico
  decide: se contém o nonce, confirma sem reenviar; senão, reenvia com o **mesmo** nonce. O
  backend é idempotente por autor + nonce e devolve a mensagem original se ela já tinha sido
  publicada, sem retransmitir à sala.
- **Socket meio aberto** (comum no celular): sem resposta em 10 s com a sala "aberta", a store
  pede `recycle()` à conexão; a mensagem continua `pending` e segue o fluxo acima.
- **Limites:** no máximo 3 envios automáticos por mensagem (depois, `failed: unconfirmed`,
  com **Tentar de novo** usando o mesmo nonce); `rate_limited` reenvia uma vez após o
  `retryAfterMs`; erro do servidor com o nonce vira `failed: rejected` (sem retry); no
  máximo 20 mensagens locais ao mesmo tempo.

## Home e registro de módulos

`client/src/features/registry.ts` é a **fonte única** da Home (chat, participantes e o guia
**Compartilhar tela**, que é `native`: o recurso é do próprio Discord e o roteiro mostra "Pelo Discord"):

- módulo `available` declara a `View` e a área (`slot`): `main` (chat) ou `aside` (coluna lateral);
- módulo `planned` não tem view e aparece só no roteiro ("Módulos").

`HomeView` monta `main` e `aside` a partir do registro (no celular, empilhados nessa ordem) e
fixa o painel **Sessão Discord** na coluna lateral, por ser a infraestrutura dos módulos e não
um item do roteiro. Para adicionar um módulo: crie `features/<id>/`, exponha a view e registre-a
com `status: 'available'` e o `slot`; nenhuma alteração na Home é necessária.

## Tratamento de erros

| Camada | Estratégia |
|---|---|
| Painéis da Home | Cada painel (Ambiente, Chat, Participantes, Sessão) fica num `FeatureBoundary`: um erro de renderização mostra um aviso com **Tentar novamente** só naquele painel; os demais e a conexão do chat continuam |
| Sessão Discord | Códigos estáveis (`ready_timeout`, `backend_unavailable`, …) com mensagens para o usuário final; orientações técnicas (comandos, `.env`) só em desenvolvimento. Falhas passageiras do servidor (`backend_timeout`, `backend_unavailable` para 502/503/504 do proxy, `backend_unreachable`) repetem sozinhas até 3 vezes, com backoff e jitter (1,5–3 s, 3–6 s, 6–12 s), mostrando "Tentando de novo automaticamente (n de 3)"; sair da Activity cancela a espera. Comandos do SDK (`authenticate`, `getChannel`) têm prazo de 10 s |
| Aceite legal | Verificação com prazo de 20 s; `timeout` e `unavailable` repetem sozinhos até 3 vezes (mesma política); depois de 5 s verificando, a tela explica que o servidor pode estar iniciando. Nunca libera sem a confirmação do servidor |
| Chat | Estado da conexão sempre visível (indicador e aviso); mensagens com estado `pending`/`sent`/`failed` e o motivo da falha |
| Frames inválidos | Descartados por `parseServerFrame`, nunca chegam à interface |
| Logs | Nunca contêm token, segredo, texto de mensagem nem URL de link (só códigos e tipos de erro) |

`FeatureBoundary` captura apenas erros de renderização (limitação do React); erros de eventos
e assíncronos são tratados no estado de cada funcionalidade.

## Links externos

Dentro do Discord, links de mensagens abrem **somente** por `commands.openExternalLink`
(`client/src/discord/external-link.ts`), que mostra a confirmação do próprio Discord (pulada
apenas para domínios que o usuário marcou como confiáveis). O link não tem `href` no iframe:
nenhum gesto (clique, clique do meio, Ctrl/Cmd+clique, menu de contexto) navega nativamente.
Só `http`/`https` viram link; o texto nunca é interpretado como HTML. Fora do Discord, é um
link comum (`target="_blank"`, `rel="noopener noreferrer nofollow"`).

## Recursos do Discord usados pela Activity

| Recurso | Como | Observação |
|---|---|---|
| Convite | `commands.openInviteDialog` (botão **Convidar para a Activity** em Participantes) | A tela de convite é do Discord; a Activity não recebe contatos. Se o comando falhar, a interface orienta a usar o convite do próprio Discord |
| Compartilhamento de tela | Nenhum comando: o Embedded App SDK não oferece captura nem transmissão de tela | O painel **Compartilhar tela** só explica onde fica o botão nativo da chamada de voz, conforme `platform` (computador/celular). A Activity nunca acessa tela, câmera ou microfone |
| Links externos | `commands.openExternalLink` | Ver abaixo |

## Moderação no chat

- **Servidor:** limites de envio, de frames e de texto repetido (`repeated_message`); ver
  [CHAT-PROTOCOL.md](CHAT-PROTOCOL.md#salas-e-limites).
- **Ocultar mensagens (local):** em cada grupo de mensagens de outra pessoa, **Ocultar** esconde as
  mensagens dela **só na própria tela** até sair da Activity (não avisa ninguém nem muda o servidor).
- **Não implementado (decisão de produto):** apagar mensagens para todos, silenciar/banir e denúncia.
  Exigem definir quem modera (ex.: permissão de "Gerenciar mensagens" no servidor do Discord, que a
  Activity hoje não consulta), onde ficam as denúncias e por quanto tempo (dados pessoais), e o
  procedimento de atendimento. Até lá, o caminho é a denúncia/moderação do próprio Discord.

## Limitações conhecidas

- **Sem persistência:** salas e histórico ficam em memória no backend; reiniciar o servidor
  apaga tudo. Mensagens pendentes no cliente se perdem se a página recarregar.
- **Idempotência limitada ao histórico:** o nonce vale enquanto a mensagem estiver entre as
  100 da sala; se mais de 100 mensagens forem publicadas entre o envio e a reconexão, um reenvio
  publica uma segunda cópia.
- **Sessão expirada:** o token não é renovado automaticamente; é preciso recarregar a Activity.
- **Instância única do backend:** limites, salas e caches são por processo (sem escala horizontal).
- **Desenvolvimento:** `npm run dev` (HMR) recarrega a Activity quando a rede volta e o HMR só
  funciona pelo túnel; use `npm run dev:discord` para testes no celular e de rede.
- **Produção:** o backend não serve o `client/dist`; o deploy precisa de um servidor estático
  com `/api` (HTTP e WebSocket) encaminhado ao backend. Configure `NODE_ENV=production` (origens
  restritas) e `TRUST_PROXY` conforme os proxies (ver [SEGURANCA.md](SEGURANCA.md#configuração-de-produção)).
