# Protocolo do chat (WebSocket `/api/chat`)

Contrato entre `client/src/realtime/` e `server/chat/`. O teste
`client/test/realtime/chat-protocol.compat.test.ts` compara os dois lados (limites, tipos de
frame, códigos de erro e pares de fechamento) e roda o servidor real: se divergirem, falha.

## Conexão

- URL: `wss://<host da página>/api/chat` (mesma origem da Activity; `ws://` em `http`).
- O upgrade só é aceito com `Origin` permitido pelo perfil do ambiente (`ORIGIN_PROFILE`):
  `production` aceita só `https://<client_id>.discordsays.com` (e origens extras exatas);
  `local` também `localhost` / `127.0.0.1` / `[::1]`; `tunnel` (padrão fora de produção) também
  `https://<subdomínio>.trycloudflare.com`. Caso contrário: HTTP 403. Rota diferente de
  `/api/chat`: 404. Detalhes em [SEGURANCA.md](SEGURANCA.md#configuração-de-produção).
- Proteção contra abuso, antes de aceitar o socket: um IP com 20 falhas de autenticação em
  5 min, mais de 60 upgrades por minuto ou 50 sockets ainda não autenticados recebe HTTP 429
  com `Retry-After`; acima de 500 sockets não autenticados no total, HTTP 503. O navegador vê
  `1006` e o cliente reconecta com backoff. Detalhes em
  [SEGURANCA.md](SEGURANCA.md#proteção-da-autenticação-do-websocket-fase-51).
- Frames só de texto (JSON), até 4 KiB cada. Binário fecha com `4000 binary_not_supported`;
  acima do limite, 1009.
- O primeiro frame deve ser `auth`, em até 5 s (senão `4008 auth_timeout`).
- Heartbeat do servidor: ping a cada 30 s; sem pong no ciclo seguinte, a conexão é encerrada
  (o navegador responde aos pings sozinho).

## Frames do cliente

```jsonc
{ "type": "auth", "accessToken": "<token OAuth do usuário>", "instanceId": "<instanceId do SDK>" }
{ "type": "send", "text": "<até 500 code points>", "nonce": "<opcional, [A-Za-z0-9_-]{1,64}>" }
```

- `auth` uma única vez. `accessToken` com até 512 caracteres; `instanceId` com até 200 e
  `[A-Za-z0-9-]`. Qualquer outro tipo antes do auth fecha com `4001 auth_required`.
- `send`: o servidor normaliza o texto (quebras de linha, remove controles e caracteres bidi,
  limita linhas em branco seguidas, apara as pontas) e conta o limite depois disso. O autor é
  sempre o usuário autenticado; o cliente nunca o informa.

## Frames do servidor

```jsonc
{ "type": "ready", "self": ChatAuthor }                          // após o auth
{ "type": "history", "messages": ChatMessage[] }                 // logo após o ready (até 100)
{ "type": "message", "message": ChatMessage, "nonce"?: string }  // nonce só para a conexão que enviou
{ "type": "rate_limited", "retryAfterMs": number, "nonce"?: string }
{ "type": "error", "code": string, "nonce"?: string }
```

```ts
ChatAuthor  = { id: string; username: string; displayName: string; avatarUrl: string }  // avatar sempre em cdn.discordapp.com
ChatMessage = { id: string; author: ChatAuthor; text: string; createdAt: string /* ISO 8601 */; nonce?: string }
```

- No `history`, o `nonce` aparece **somente** nas mensagens do próprio usuário (para
  reconciliar envios pendentes após reconectar).
- Códigos de `error`: `empty_message`, `message_too_long`, `invalid_message`, `invalid_nonce`
  (sem eco do nonce inválido) e `unsupported_message` (tipo desconhecido após o auth). Não
  encerram a conexão.
- O cliente valida todo frame com `parseServerFrame` e descarta o que não confere (campos
  desconhecidos são removidos; avatar fora de `https://cdn.discordapp.com/` é recusado).

## Idempotência

Reenviar `send` com um `nonce` já usado pelo **mesmo autor** na **mesma sala** devolve, só a
essa conexão, a mensagem original (`{ type: "message", message, nonce }`). Nada é retransmitido
à sala, o texto do reenvio é ignorado e o limite de envio não é consumido. O nonce vale enquanto
a mensagem estiver no histórico (100 mensagens) e a sala existir.

## Salas e limites

| Item | Valor |
|---|---|
| Sala | `instanceId` **validado** no Discord (nunca o informado pelo cliente sem validação) |
| Histórico por sala | 100 mensagens (buffer circular) |
| Sala vazia | removida após 10 min, com o histórico |
| Envio | 5 mensagens por usuário a cada 10 s (somando as conexões dele) → `rate_limited` |
| Frames | 30 por conexão a cada 10 s → fecha com `4029 too_many_frames` |
| Conexões | 3 por usuário, 50 por sala |
| Revalidação | a cada 60 s o servidor consulta os membros da instância; quem saiu é desconectado |
| Caches no servidor | `/users/@me` por 60 s (chave: SHA-256 do token); token recusado (401/403) por 60 s; membros da instância por 20 s |

## Códigos de fechamento

Classificação no cliente: `client/src/realtime/chat-close-codes.ts`.

| Código | Motivo | Categoria | O cliente |
|---|---|---|---|
| 4008 | `auth_timeout` | transient | reconecta com backoff |
| 1013 | `discord_unavailable` (inclui 429 do Discord e teto de validações) | transient | reconecta com backoff |
| 4029 | `too_many_frames` | transient | reconecta com backoff |
| 4001 | `auth_failed` (falha inesperada no autenticador) | transient | reconecta com backoff |
| 4001 | `invalid_token`, `auth_required` | session_expired | para; "Recarregar Activity" |
| 4003 | `not_in_instance`, `instance_not_found` | left_instance | para; "Recarregar Activity" |
| 4029 | `too_many_connections`, `room_full` | limit | para; "Reconectar" |
| 4001 | `auth_unavailable` (chat sem Bot Token) | unavailable | para |
| 1011 | `server_misconfigured` (Bot Token recusado) | unavailable | para |
| 4000 | `invalid_json`, `invalid_message`, `binary_not_supported`, `invalid_auth`, `auth_in_progress`, `invalid_instance` | protocol | para |
| 1000 | — | client_closed | para |
| 1001–1015 (exceto 1009 e 1011) | — | transient | reconecta com backoff |
| 1009 | — (frame acima do limite) | protocol | para |
| 4000–4999 desconhecido | — | protocol | para (evita laço) |

Fechamentos iniciados pelo **cliente**: `1000` (descarte da conexão), `4900 handshake_timeout`
(sem `ready` em 15 s) e `4902 stalled` (sem confirmação de envio em 10 s com a sala aberta).
A política de reconexão está em [ARQUITETURA.md](ARQUITETURA.md#reconexão).
