# Implantação do backend no Render

Como publicar o backend (`server/`) num **Web Service** do Render. O frontend não faz parte
deste guia: o backend não serve o `client/dist` (ver [ARQUITETURA.md](ARQUITETURA.md#limitações-conhecidas)).

## Configuração do serviço

| Campo no Render | Valor |
|---|---|
| Tipo | Web Service |
| Repositório / branch | `kShinji02/All-in-One` / `main` |
| Runtime | Node |
| Root Directory | `server` |
| Build Command | `npm ci` |
| Start Command | `npm start` (executa `node server.js`) |
| Health Check Path | `/api/health` |

O `server/package.json` declara `"engines": { "node": ">=20" }`. Para fixar a versão no
Render, defina a variável `NODE_VERSION` (ex.: `22`).

## Porta e interface

`server/runtime-config.js` decide onde o processo escuta:

| Ambiente | Porta | Interface |
|---|---|---|
| Render (`RENDER=true`, definido pelo próprio Render) ou `NODE_ENV=production` | `PORT` do ambiente (o Render a define) | `0.0.0.0` |
| Desenvolvimento local | `PORT`, se definida; senão `3001` | padrão do Node (IPv4 e IPv6, para o proxy do Vite em `localhost:3001`) |

`HOST` sobrescreve a interface. Uma `PORT` inválida encerra o processo na inicialização.
O processo trata `SIGTERM` (parada ou nova implantação no Render) encerrando o chat e o HTTP.

## Variáveis de ambiente

Cadastre em **Environment** no painel do serviço. Nunca coloque valores reais no repositório:
o `.env` é só para desenvolvimento local e não existe no Render (o `dotenv` não sobrescreve
variáveis já definidas no ambiente).

### Obrigatórias

| Variável | Valor | Segredo | Sem ela |
|---|---|---|---|
| `VITE_DISCORD_CLIENT_ID` | Client ID da aplicação (Developer Portal → OAuth2) | não | OAuth e chat indisponíveis |
| `DISCORD_CLIENT_SECRET` | Client Secret (Developer Portal → OAuth2) | **sim** | `POST /api/token` responde 500 |
| `DISCORD_BOT_TOKEN` | Token do bot (Developer Portal → Bot) | **sim** | o chat recusa todas as conexões |
| `NODE_ENV` | `production` | não | o chat aceitaria origens de desenvolvimento (localhost e `trycloudflare.com`) |
| `TRUST_PROXY` | `1` (ver abaixo) | não | todos os clientes compartilham o IP do proxy nos limites por IP |
| `DATABASE_URL` | connection string **direta** do PostgreSQL (Neon), com TLS; ver [ACEITE-LEGAL.md](ACEITE-LEGAL.md#neon-criar-o-banco-e-configurar-o-render) | **sim** | o servidor não inicia (o deploy falha em vez de ficar "saudável" sem registrar aceites) |

O servidor sobe mesmo sem as credenciais, para que o cliente receba um erro claro; o
`/api/health` mostra `oauthConfigured` e `chatConfigured` (nunca os valores). A
inicialização registra um aviso `[config]` para `NODE_ENV` ou `TRUST_PROXY` ausentes no Render.

### Opcionais

| Variável | Padrão | Quando usar |
|---|---|---|
| `NODE_VERSION` | versão padrão do Render | Fixar a versão do Node (ex.: `22`) |
| `ORIGIN_PROFILE` | `production` (com `NODE_ENV=production`) | Não defina em produção |
| `CHAT_EXTRA_ORIGINS` | vazio | Origens HTTPS exatas extras para o chat (ex.: um domínio próprio do frontend) |
| `TOKEN_RATE_LIMIT` | `120` | Trocas de código OAuth por minuto, por IP |
| `TOKEN_GLOBAL_RATE_LIMIT` | `240` | Trocas de código OAuth por minuto, no total |
| `PROXY_DIAGNOSTICS` | desligado | `true` só durante a verificação do `TRUST_PROXY` (abaixo) |

Não defina `PORT` nem `HOST` no Render: a porta vem do próprio Render e a interface já é `0.0.0.0`.

## Proxy confiável no Render

O Render encaminha as requisições por um proxy que **acrescenta** o IP do cliente ao
`X-Forwarded-For` sem apagar o que o cliente enviou. Com `TRUST_PROXY=1`, o Express usa a
entrada mais à direita (a que o proxy do Render acrescentou) e ignora o que o cliente forjou à
esquerda. `true` continua recusado, porque confiaria na entrada mais à esquerda, que o cliente controla.

O número de proxies do Render não é documentado oficialmente. Confirme depois da primeira
implantação:

1. Defina `PROXY_DIAGNOSTICS=true` e reimplante.
2. Abra `https://<serviço>.onrender.com/api/health` no navegador (sem extensões que alterem cabeçalhos).
3. Nos logs do Render, a linha `[proxy] /api/health: X-Forwarded-For com N entrada(s).` mostra
   quantos proxies acrescentaram endereços (o log nunca contém os IPs).
4. Use `TRUST_PROXY=N` e remova `PROXY_DIAGNOSTICS`.

Se em dúvida, mantenha `1`: um valor baixo demais faz usuários compartilharem limites
(menos disponibilidade), enquanto um valor alto demais deixaria o cliente escolher o próprio IP
nos limites (menos segurança). O teto global de validações no Discord não depende de IP.

## Discord Developer Portal

Em **Activities → URL Mappings**, mapeie o prefixo `/api` para o backend, por exemplo
`<serviço>.onrender.com/api`. O proxy do Discord remove o prefixo mapeado, por isso o alvo
inclui `/api`. Confira com `GET /api/health` de dentro da Activity. Com `NODE_ENV=production`,
o chat só aceita a origem `https://<client_id>.discordsays.com`.
O prefixo `/` aponta para o frontend: o Quick Tunnel local ou a Cloudflare
([DEPLOY-CLOUDFLARE.md](DEPLOY-CLOUDFLARE.md)); o backend não muda em nenhum dos casos.

## Limitações do plano gratuito

- O serviço é suspenso após um período sem tráfego e leva cerca de um minuto para voltar; a
  primeira abertura da Activity depois disso pode falhar ou demorar, e o cliente reconecta.
- Salas e histórico do chat ficam em memória: suspensão, reinício ou nova implantação apagam
  tudo (como descrito na Política de Privacidade).
- Uma única instância: os limites e as salas são por processo (ver [SEGURANCA.md](SEGURANCA.md#pontos-de-atenção-não-são-vulnerabilidades-exploráveis-hoje)).

## Verificação após a implantação

1. `GET https://<serviço>.onrender.com/api/health` → `{"ok":true,"oauthConfigured":true,"chatConfigured":true,"legalStore":"postgres"}`.
   Sem `legalStore`, o Render ainda roda uma versão anterior ao aceite legal.
2. Os logs mostram `perfil "production"`, `Aceites legais: PostgreSQL em <host> (TLS)` (host sem
   `-pooler`), `Server listening on 0.0.0.0:<porta>`, `[db] migrations aplicadas: 1.` (na primeira
   implantação; depois, `[db] schema atualizado`) e nenhum aviso `[config]`.
3. `GET https://<serviço>.onrender.com/api/legal/status` sem token → `401 {"error":"auth_required"}`.
4. Dentro do Discord, a Activity autentica, mostra a tela de aceite (ou entra direto) e o chat conecta.
