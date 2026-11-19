# Como testar o All-in-One dentro do Discord

Guia baseado na documentação oficial ["Building an Activity"](https://docs.discord.com/developers/activities/building-an-activity).

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
```

- O `.env` está no `.gitignore` e **nunca** deve ser commitado.
- Só variáveis com prefixo `VITE_` vão para o navegador. O secret fica apenas no Express.

## 3. Subir backend, frontend e túnel (3 terminais)

```bash
cd server && npm install && npm run dev      # http://localhost:3001
```

```bash
cd client && npm install && npm run dev      # http://localhost:5173
```

```bash
cloudflared tunnel --url http://localhost:5173
```

Confira o backend com `curl http://localhost:3001/api/health`. Ele deve responder
`{"ok":true,"oauthConfigured":true}`. Se aparecer `false`, o `.env` não foi lido ou contém os
valores de exemplo.

## 4. Mapear a URL

Em **Activities → URL Mappings**, configure:

| PREFIX | TARGET |
|---|---|
| `/` | `<subdominio>.trycloudflare.com` (sem `https://`) |

A URL do túnel muda a cada execução do `cloudflared`; atualize o mapeamento quando isso ocorrer.

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
| `ready_timeout` | A página não está rodando dentro do Discord, ou o Client ID não corresponde à aplicação da Activity. |
| `sdk_init_failed` | Faltam parâmetros de inicialização na URL (`frame_id`, `instance_id`, `platform`). |
| `authorize_failed` | O usuário recusou ou fechou o modal de autorização. |
| `server_misconfigured` | O Express iniciou sem `VITE_DISCORD_CLIENT_ID` ou `DISCORD_CLIENT_SECRET` no `.env`. |
| `token_exchange_failed · invalid_client` | O Client Secret está incorreto. |
| `token_exchange_failed · invalid_grant` | O código expirou ou já foi usado. Clique em **Tentar novamente**. |
| `backend_unreachable` | O Express não está rodando na porta 3001. |
| `authenticate_failed` | O token foi rejeitado pelo cliente do Discord. |

O servidor e o canal aparecem como **Indisponível** quando a consulta não é permitida no
contexto (por exemplo, em mensagens diretas, que exigiriam `dm_channels.read`, um escopo que
depende de aprovação do Discord).

## Participantes (Fase 3)

A seção **Participantes** lista os usuários conectados à **mesma instância** da Activity
(`getActivityInstanceConnectedParticipants` + evento `ACTIVITY_INSTANCE_PARTICIPANTS_UPDATE`).
Quem está no canal de voz sem abrir a Activity **não** aparece. Nenhum escopo OAuth2 extra é
necessário.

Roteiro com duas contas (A e B):

| Passo | Ação | Resultado esperado |
|---|---|---|
| 1 | A abre a Activity num canal de voz | A aparece primeiro, com o selo "Você"; contador "1 na Activity" |
| 2 | B entra no mesmo canal e abre a mesma Activity | B aparece na tela de A sem recarregar; contador "2 na Activity" nas duas telas |
| 3 | B fecha a Activity | B sai com animação na tela de A; contador volta a 1 |
| 4 | B abre e fecha a Activity algumas vezes | Nenhuma duplicação; a lista continua atualizando |
| 5 | B fica no canal sem abrir a Activity | B não aparece na lista |

Se o Discord não responder a um comando em 10 s, a seção mostra o erro com **Tentar novamente**.

## Observação sobre HMR

O `vite.config.ts` usa `hmr.clientPort: 443` para funcionar através do túnel HTTPS. Ao abrir
`http://localhost:5173` diretamente, o console mostra erros de WebSocket para a porta 443 e o
recarregamento automático não funciona — use F5. Esse comportamento vem do template original.
