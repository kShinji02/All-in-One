# Como testar o All-in-One dentro do Discord

Guia baseado na documentação oficial ["Building an Activity"](https://docs.discord.com/developers/activities/building-an-activity).

Visão técnica em [ARQUITETURA.md](ARQUITETURA.md); protocolo do chat em [CHAT-PROTOCOL.md](CHAT-PROTOCOL.md).

## Roteiro de ponta a ponta

| # | Cenário | Onde está o roteiro | Coberto também por testes automatizados |
|---|---|---|---|
| 1 | Abrir a Activity no Discord | [5. Abrir a Activity](#5-abrir-a-activity) | `client/test/lib/launch-context.test.ts` |
| 2 | Autenticar o usuário | [O que deve acontecer](#o-que-deve-acontecer), [Diagnóstico de erros](#diagnóstico-de-erros) | `client/test/discord/` (fluxo simulado) |
| 3 | Carregar os participantes | [Participantes](#participantes) | `client/test/discord/participants-decoupling.test.tsx`, `client/test/participants/` |
| 4 | Abrir o chat | [Chat: abrir e conversar](#chat-abrir-e-conversar) | `client/test/chat/ChatView.integration.test.tsx` |
| 5 | Enviar e receber mensagens em tempo real | [Chat: abrir e conversar](#chat-abrir-e-conversar) | `client/test/realtime/*.server.test.ts*` (servidor real) |
| 6 | Desconectar e reconectar a internet | [Chat: queda de internet](#chat-queda-de-internet) | `client/test/realtime/network-recovery.test.ts` |
| 7 | Recuperar pendentes sem duplicar | [Chat: queda de internet](#chat-queda-de-internet) | `client/test/realtime/message-store*.test.ts`, `network-recovery.test.ts` |
| 8 | Sair da instância | [Chat: sair da instância](#chat-sair-da-instância) | `client/test/realtime/chat-connection.server.test.ts` (revalidação real) |
| 9 | Abrir links externos | [Chat: links externos](#chat-links-externos) | `client/test/chat/external-links.test.tsx` |
| 10 | Recuperar um painel após erro | [Painéis com erro](#painéis-com-erro) | `client/test/home/HomeView.test.tsx` (só automatizado) |
| 11 | Aceitar os Termos e a Política | [Aceite dos documentos legais](#aceite-dos-documentos-legais) | `client/test/legal/`, `server/test/legal-acceptance.test.js` |
| 12 | Backend lento ou acordando | [Backend lento ou acordando](#backend-lento-ou-acordando) | `client/test/lib/http.test.ts`, `client/test/legal/LegalGate.test.tsx`, `client/test/discord/participants-decoupling.test.tsx` |
| 13 | Convidar, compartilhar tela e ocultar mensagens | [Convite, tela e moderação local](#convite-tela-e-moderação-local) | `client/test/participants/invite-and-screenshare.test.tsx`, `client/test/chat/ChatPanel.test.tsx` |

Os testes automatizados rodam com `npm test` em `server/` e em `client/`.

## 1. Configurar a aplicação no Developer Portal

1. Acesse <https://discord.com/developers/applications> e abra (ou crie) a aplicação.
2. **OAuth2**
   - Copie o **Client ID** e gere/copie o **Client Secret**.
   - Em **Redirects**, adicione `https://127.0.0.1` e salve. Esse valor é apenas um placeholder:
     o Embedded App SDK cuida do redirecionamento durante o `authorize()`.
3. **Activities → Settings**: habilite as Activities para a aplicação.

## 2. Criar o `.env` na raiz do projeto

```bash
cp example.env .env
```

```env
VITE_DISCORD_CLIENT_ID=<seu client id>
DISCORD_CLIENT_SECRET=<seu client secret>
DISCORD_BOT_TOKEN=<token do bot da aplicação>
```

- O `.env` está no `.gitignore` e **nunca** deve ser commitado.
- Só variáveis com prefixo `VITE_` vão para o navegador. O secret e o token do bot ficam apenas no Express.
- `DISCORD_BOT_TOKEN` é exigido pelo chat: o servidor o usa para confirmar, na API do Discord,
  que a instância da Activity existe e que o usuário participa dela. Obtenha-o em **Bot → Reset Token**
  na mesma aplicação do Client ID. O valor aparece uma única vez; não o cole em issues, logs,
  capturas de tela ou mensagens. Se vazar, gere outro em **Reset Token**.
- Sem o token (ou com o valor de exemplo do `example.env`), o backend sobe normalmente, mas avisa
  `Chat indisponível` no console e recusa as conexões em `/api/chat` (`4001 auth_unavailable`).
  O OAuth e a lista de participantes não dependem dele.
- **Aceite dos documentos legais:** o chat só abre para quem aceitou os Termos de Uso e declarou
  ciência da Política de Privacidade, e o servidor precisa de um lugar para registrar esse aceite.
  Escolha **uma** das opções da [seção 2.1](#21-onde-registrar-os-aceites).
- **Permissões:** o token é usado só como credencial da aplicação numa chamada REST
  (`GET /applications/{id}/activity-instances/{instance_id}`). O chat não usa o Gateway do
  Discord, intents nem permissões de servidor; nenhuma opção extra da página **Bot** é necessária.
  Se o Discord recusar o token, o backend registra `DISCORD_BOT_TOKEN recusado pelo Discord`
  (sem o valor) e o chat mostra **Chat indisponível**.

### 2.1 Onde registrar os aceites

Sem nenhuma das duas variáveis, o backend local sobe, avisa
`DATABASE_URL não definido: o aceite dos documentos legais fica indisponível` e a Activity fica
na tela **Não foi possível verificar o aceite**; o chat recusa com `1013 acceptance_unavailable`.
Nada é liberado sem registro.

| Opção | No `.env` | Quando usar | Observações |
|---|---|---|---|
| Memória | `LEGAL_STORE=memory` | Teste local rápido, sem banco | Os aceites somem a cada reinício do backend (a tela de aceite volta). **Recusado** com `NODE_ENV=production` ou no Render: o servidor nem inicia |
| PostgreSQL | `DATABASE_URL=postgresql://…` | Testar o mesmo caminho da produção | Use um banco **de desenvolvimento**, nunca o de produção. O TLS é obrigatório e verificado; `sslmode=disable` só é aceito fora de produção (ex.: PostgreSQL local). No Neon, use a string **direta** (sem `-pooler`); ver [ACEITE-LEGAL.md](ACEITE-LEGAL.md#conexão-e-compatibilidade-com-o-pooler-do-neon) |

```env
# Escolha UMA linha:
LEGAL_STORE=memory
# DATABASE_URL=postgresql://<usuário>:<senha>@<host>/<banco>?sslmode=require
```

- O valor de `DATABASE_URL` é uma credencial: fica só no `.env` (que não vai para o Git) e nunca
  aparece nos logs; o backend registra apenas o host.
- Com `DATABASE_URL`, o backend cria a tabela na primeira execução e registra
  `[db] migrations aplicadas: 1.` (nas seguintes, `[db] schema atualizado`).
- `LEGAL_STORE` aceita só `memory` ou `postgres`. Com `LEGAL_STORE=postgres` sem `DATABASE_URL`,
  o armazenamento fica indisponível, como sem nenhuma variável.
- Para ver a tela de aceite de novo: com `memory`, reinicie o backend; com PostgreSQL, apague o
  registro de teste seguindo [ACEITE-LEGAL.md](ACEITE-LEGAL.md#exclusão-administrativa-ex-pedido-de-eliminação-de-um-titular).
- Os links da tela de aceite apontam para os endereços padrão do GitHub Pages
  (`server/legal/config.js`). Enquanto o site não estiver publicado, eles respondem 404; para testar
  com outra cópia, defina `LEGAL_TERMS_URL` e `LEGAL_PRIVACY_URL` (somente `https://`).

## 3. Subir backend, frontend e túnel (3 terminais)

```bash
cd server && npm install && npm run dev      # http://localhost:3001
```

```bash
cd client && npm install && npm run dev      # http://localhost:5173
```

> **Testes no celular ou com queda de internet:** use `npm run dev:discord` no lugar de
> `npm run dev` (mesma porta 5173, mesmo túnel). Ele gera o build de produção, serve com
> `vite preview` e refaz o build a cada alteração (reabra a Activity para ver as mudanças).
> Motivo: no `npm run dev`, o cliente do Vite recarrega a página inteira quando a rede volta
> (o Discord Mobile mostra "Erro ao recarregar a atividade"), e qualquer WebSocket do Vite
> preso no host da página bloqueia o WebSocket do chat (o navegador só abre um por vez por
> host). Sem o cliente do Vite na página, a queda de rede afeta só o chat, que reconecta sozinho.

```bash
cloudflared tunnel --url http://localhost:5173
```

Confira o backend com `curl http://localhost:3001/api/health`. Ele deve responder
`{"ok":true,"oauthConfigured":true,"chatConfigured":true,"legalStore":"memory"}` (ou
`"legalStore":"postgres"` com `DATABASE_URL`). `"legalStore":"unavailable"` significa que a
[seção 2.1](#21-onde-registrar-os-aceites) não foi feita. Se algum campo aparecer `false`, o
`.env` não foi lido ou contém os valores de exemplo (`oauthConfigured` depende do Client ID e do
Client Secret; `chatConfigured`, do Client ID e do `DISCORD_BOT_TOKEN`). A resposta nunca mostra
os valores configurados.

## 4. Mapear a URL

Em **Activities → URL Mappings**, configure:

| PREFIX | TARGET |
|---|---|
| `/` | `<subdominio>.trycloudflare.com` (sem `https://`) |

A URL do túnel muda a cada execução do `cloudflared`; atualize o mapeamento quando isso ocorrer.

Com só o mapeamento `/`, todas as chamadas a `/api` (token, aceite e chat) passam pelo túnel e
chegam ao backend **local** pelo proxy do Vite (`client/vite.config.ts`).

**Backend no Render:** se a aplicação também tiver o mapeamento `/api` → `<serviço>.onrender.com/api`,
o Discord envia `/api` direto ao Render (o prefixo mais específico vence) e o backend local é
ignorado: o `.env` local não vale, e o aceite fica no banco do Render. Para testar o backend local,
remova temporariamente esse mapeamento ou use outra aplicação de teste no Developer Portal.

## 5. Abrir a Activity

1. Entre em um canal de voz de um servidor onde você pode usar Activities.
2. Clique no ícone de **Activities** (foguete) e escolha a aplicação.
3. Na primeira vez, o Discord mostra o modal de consentimento com os escopos `identify` e `guilds`.

## O que deve acontecer

O painel **Sessão Discord** percorre as etapas:

1. Handshake com o Discord (`ready()`)
2. Autorização OAuth2 (`commands.authorize`)
3. Troca de código no servidor (`POST /api/token`)
4. Autenticação do usuário (`commands.authenticate`)
5. Contexto do canal e servidor (`commands.getChannel` + `/users/@me/guilds`)

Ao final, mostra seu nome e avatar, o servidor, o canal, a plataforma, o ID da instância e os escopos concedidos.

## Diagnóstico de erros

| Código exibido | Causa provável |
|---|---|
| `ready_timeout` | A página não está rodando dentro do Discord, ou o Client ID não corresponde à aplicação da Activity. Clique em **Recarregar Activity**. |
| `sdk_init_failed` | Faltam parâmetros de inicialização na URL (`frame_id`, `instance_id`, `platform`). Clique em **Recarregar Activity**. |
| `authorize_failed` | O usuário recusou ou fechou o modal de autorização. |
| `server_misconfigured` | O Express iniciou sem `VITE_DISCORD_CLIENT_ID` ou `DISCORD_CLIENT_SECRET` no `.env`. |
| `token_exchange_failed · invalid_client` | O Client Secret está incorreto. |
| `token_exchange_failed · invalid_grant` | O código expirou ou já foi usado. Clique em **Tentar novamente**. |
| `backend_unreachable` | O Express não está rodando na porta 3001. |
| `backend_timeout` | O backend não respondeu à troca do código em 30 s (no Render Free, o serviço pode estar acordando). Aguarde e clique em **Tentar novamente**. |
| `backend_unavailable` | O proxy respondeu 502/503/504 sem passar pelo backend (Render acordando ou fora do ar, ou URL Mapping `/api` errado). A sessão tenta sozinha 3 vezes antes de mostrar o erro. |
| `authenticate_failed` | O token foi rejeitado pelo cliente do Discord. |

Os erros de handshake (`ready_timeout`, `sdk_init_failed`) mostram **Recarregar Activity** em vez de
**Tentar novamente**: o SDK envia o handshake uma única vez, ao ser criado, então só uma nova
página consegue repeti-lo. Os demais erros mantêm **Tentar novamente**.

### Teste: "Recarregar Activity" após `ready_timeout`

O jeito mais simples de provocar o timeout é fazer o handshake não ser respondido: trocar
temporariamente o Client ID por outro que não corresponda à Activity aberta.

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | No `.env`, troque `VITE_DISCORD_CLIENT_ID` pelo ID de outra aplicação sua (anote o original) e reinicie o frontend | — |
| 2 | Abra a Activity no Discord | Após o prazo do handshake, o painel **Sessão Discord** mostra o erro `ready_timeout`, com a mensagem sugerindo recarregar e conferir o Client ID |
| 3 | Observe o botão do painel | Aparece **Recarregar Activity** (não **Tentar novamente**) |
| 4 | Restaure o Client ID original no `.env` e reinicie o frontend | — |
| 5 | Clique em **Recarregar Activity** | A página recarrega dentro do Discord, sem fechar a Activity, e o fluxo percorre as 5 etapas até o fim |

A seção **Participantes**, enquanto o handshake não termina, mostra "Conectando ao Discord"; com o
`ready_timeout`, mostra "Não foi possível conectar ao Discord" com o código do erro.

O servidor e o canal aparecem como **Indisponível** quando a consulta não é permitida no
contexto (por exemplo, em mensagens diretas, que exigiriam `dm_channels.read`, um escopo que
depende de aprovação do Discord).

## Aceite dos documentos legais

Pré-requisito: [seção 2.1](#21-onde-registrar-os-aceites) feita. O fluxo completo está em
[ACEITE-LEGAL.md](ACEITE-LEGAL.md).

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | A abre a Activity pela primeira vez | Depois da sessão do Discord, aparece **Antes de começar**, com os links dos dois documentos; o chat não abre |
| 2 | A clica em **Aceitar e continuar** sem marcar a caixa | O botão está desabilitado |
| 3 | A marca a caixa e aceita | "Registrando…" e, em seguida, a Home com o chat **Conectado** |
| 4 | A fecha e reabre a Activity | Entra direto, sem a tela de aceite (com `memory`, só até o backend reiniciar) |
| 5 | B abre a Activity e clica em **Recusar** | **O uso depende do aceite**, com **Rever documentos** e **Sair da Activity**; nada é liberado |
| 6 | Pare o banco (ou remova `DATABASE_URL`/`LEGAL_STORE` e reinicie o backend) e reabra como B | **Não foi possível verificar o aceite** com **Tentar novamente**; nunca libera sem confirmação |

## Backend lento ou acordando

As chamadas HTTP do cliente têm prazo (`client/src/lib/http.ts`): 30 s para a troca do código
(`/api/token`), 20 s para a verificação e o registro do aceite (`/api/legal`) e 5 s para o nome do
servidor. No Render Free, o primeiro acesso depois de um período sem uso pode levar cerca de um
minuto, porque o serviço precisa acordar.

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | Com o backend parado ou suspenso, abra a Activity | **Sessão Discord** mostra "O servidor está iniciando ou instável. Tentando de novo automaticamente (1 de 3)…" e tenta sozinha até 3 vezes (esperas de ~1,5–3 s, 3–6 s e 6–12 s) |
| 2 | Se o backend voltar durante as tentativas | A sessão conclui sozinha, sem clicar em nada |
| 3 | Se continuar fora depois das 3 tentativas | Aparece o erro (`backend_unavailable`, `backend_timeout` ou `backend_unreachable`) com **Tentar novamente**, que recomeça com um novo código OAuth |
| 4 | Se o servidor demorar na verificação do aceite | Depois de 5 s, a tela explica que ele pode estar iniciando; falhas passageiras também repetem sozinhas até 3 vezes antes de **Não foi possível verificar o aceite** |
| 5 | Se o prazo estourar ao clicar em **Aceitar e continuar** | A tela continua com a caixa marcada e a mensagem de demora; clicar de novo é seguro (o servidor não duplica o registro) |

## Convite, tela e moderação local

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | Em **Participantes**, clique em **Convidar participantes** (no topo da seção) | Abre a tela de convite do próprio Discord (no celular, depende do app; se não abrir, aparece a orientação de usar o convite do Discord) |
| 2 | Leia o painel **Compartilhar tela** no computador e no celular | Mostra só o caminho do dispositivo atual; o compartilhamento é feito pelos controles da chamada de voz do Discord |
| 3 | Com A e B no chat, A clica em **Ocultar** numa mensagem de B | As mensagens de B somem só na tela de A ("… ocultada(s) só para você", com **Mostrar**); B e os demais continuam vendo tudo |
| 4 | B envia a mesma mensagem 4 vezes em menos de 1 minuto | A 4ª fica "Não enviada: mesma mensagem enviada muitas vezes seguidas"; ninguém a recebe |

## Participantes

A seção **Participantes** lista os usuários conectados à **mesma instância** da Activity
(`getActivityInstanceConnectedParticipants` + evento `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`).
Quem está no canal de voz sem abrir a Activity **não** aparece. Nenhum escopo OAuth2 extra é
necessário: a lista depende só do handshake (`ready()`). Se a autorização, a troca de token ou o
backend falharem, a lista continua funcionando, com o aviso **Autenticação incompleta** e sem o
selo "Você".

Roteiro com duas contas (A e B):

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | A abre a Activity num canal de voz | A aparece primeiro, com o selo "Você"; contador "1 na Activity" |
| 2 | B entra no mesmo canal e abre a mesma Activity | B aparece na tela de A sem recarregar; contador "2 na Activity" nas duas telas |
| 3 | B fecha a Activity | B sai com animação na tela de A; contador volta a 1 |
| 4 | B abre e fecha a Activity algumas vezes | Nenhuma duplicação; a lista continua atualizando |
| 5 | B fica no canal sem abrir a Activity | B não aparece na lista |

Se o Discord não responder a um comando em 10 s, a seção mostra o erro com **Tentar novamente**.

### Teste: participantes com o backend indisponível

A lista depende só do handshake do SDK, não do Express. Este roteiro confirma que ela continua
funcionando quando a troca de token falha.

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | Pare o backend (`Ctrl+C` no terminal do `server/`); mantenha frontend e túnel no ar | — |
| 2 | A abre (ou recarrega) a Activity | **Sessão Discord** mostra `backend_unreachable`, orientando a iniciar o backend com `npm run dev` em `server/`, e o botão **Tentar novamente** |
| 3 | Observe a seção **Participantes** | A lista aparece com A, o aviso **Autenticação incompleta** e **sem** o selo "Você" |
| 4 | B abre e depois fecha a mesma Activity | B entra e sai da lista de A em tempo real, sem duplicação |
| 5 | Suba o backend de novo e clique em **Tentar novamente** | A autenticação conclui; o aviso some e A ganha o selo "Você", sem recarregar a página |

Se no passo 2 o Discord pedir autorização, aceite: o erro só aparece na etapa seguinte, a troca de
código em `/api/token`.

## Chat: abrir e conversar

Pré-requisito: `DISCORD_BOT_TOKEN` configurado (`/api/health` com `"chatConfigured":true`).
Duas contas (A e B) no mesmo canal de voz, com a mesma Activity aberta.

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | A abre a Activity | O painel **Chat** mostra "Conectando" → "Carregando histórico" → **Conectado**; sem mensagens, "Nenhuma mensagem ainda" |
| 2 | A envia "oi" com **Enter** | A mensagem aparece na hora com "Enviando…" e, em seguida, com o horário |
| 3 | Observe a tela de B | "oi" aparece uma única vez, com o nome e o avatar de A |
| 4 | B responde | Aparece para A em tempo real, sem recarregar |
| 5 | A quebra a linha com **Shift+Enter** e envia | As linhas são preservadas |
| 6 | A rola para cima e B envia outra mensagem | A posição de A não muda; aparece o indicador "1 nova mensagem" |
| 7 | B fecha e reabre a Activity | O histórico (até 100 mensagens) volta, sem duplicações |

## Chat: queda de internet

Use `npm run dev:discord` (veja a seção 3). Com o `npm run dev`, o Vite recarrega a Activity
quando a rede volta e o teste não é válido.

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | A (celular) espera **Conectado** e deixa aberto por 2 a 3 minutos | Continua **Conectado**, sem alternar |
| 2 | A desliga a internet | O chat mostra **Sem internet** (ou **Reconectando…**, se o celular não avisar a queda); o histórico continua visível |
| 3 | A envia uma mensagem | Fica com "Enviando…" |
| 4 | B envia uma mensagem enquanto A está sem internet | Nada muda na tela de A |
| 5 | A religa a internet | Em segundos, volta a **Conectado** sozinho; a mensagem de B aparece (recuperada pelo histórico) |
| 6 | Observe a mensagem de A | Passa a enviada **uma única vez**, na tela de A e na de B |
| 7 | Espere alguns minutos | Continua **Conectado** |

Se a conexão não voltar (por exemplo, com o servidor fora do ar), depois de 8 tentativas o chat
mostra **Sem conexão** com **Reconectar**. Mensagens enviadas nesse meio-tempo ficam aguardando
ou com **Tentar de novo** (o reenvio usa o mesmo identificador e não duplica).

## Chat: sair da instância

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | A e B com o chat **Conectado** | Nada a observar ainda |
| 2 | B fecha a Activity | B some da lista de **Participantes** de A; o chat de A continua **Conectado** |
| 3 | B sai do canal de voz com a Activity ainda aberta em outro dispositivo e espera até 1 min | O servidor revalida os membros a cada 60 s: o chat de B mostra **Fora da Activity** com **Recarregar Activity**, sem novas tentativas |

O passo 3 é difícil de reproduzir à mão; a revalidação é coberta por
`client/test/realtime/chat-connection.server.test.ts`, com o servidor real.

## Chat: links externos

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | Envie `https://example.com/teste-link` | Aparece como link |
| 2 | Clique com o botão esquerdo | O Discord mostra a confirmação de saída (o navegador não abre direto) |
| 3 | Cancele | Nada abre |
| 4 | Clique com o botão do meio | O mesmo modal do Discord, sem rolagem automática nem abertura direta |

Domínios marcados como **Trust this Domain** abrem sem o modal (comportamento do Discord). Para
este teste, use um domínio que você ainda não marcou como confiável. Se algo falhar, o console
(Ctrl+Shift+I) mostra `[chat] openExternalLink falhou (<código>)`, sem a URL.

## Painéis com erro

Cada painel da Home (Ambiente, Chat, Participantes, Sessão Discord) é isolado: se um deles falhar
ao renderizar, aparece "<Painel> indisponível no momento" com **Tentar novamente**, e os demais
continuam funcionando. Esse cenário não é reproduzível manualmente sem alterar o código; ele é
coberto por `client/test/home/HomeView.test.tsx`.

## Observação sobre HMR

O `vite.config.ts` usa `hmr.clientPort: 443` para funcionar através do túnel HTTPS. Ao abrir
`http://localhost:5173` diretamente com `npm run dev`, o console mostra erros de WebSocket para a
porta 443 e o recarregamento automático não funciona — use F5. Com `npm run dev:discord` não há
HMR: depois de editar o código, espere `[dev:discord] rebuild concluído` e reabra a Activity.
