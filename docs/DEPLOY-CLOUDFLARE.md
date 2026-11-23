# Frontend na Cloudflare (Workers Static Assets)

> **Situação:** configuração preparada e verificada localmente. **Ainda não publicada nem
> testada no Discord**; a migração só está concluída depois do [roteiro de teste](#6-testar-no-discord).

Só o frontend (build do Vite) vai para a Cloudflare. O backend continua no Render
([DEPLOY-RENDER.md](DEPLOY-RENDER.md)) e o desenvolvimento local continua com o Quick Tunnel
([TESTE-NO-DISCORD.md](TESTE-NO-DISCORD.md)).

```
Discord (https://<client_id>.discordsays.com)
 ├─ /      → all-in-one-frontend.<subdomínio>.workers.dev   (Cloudflare: index.html, /assets/*)
 └─ /api   → all-in-one-5lek.onrender.com/api                (Render: /api/token, /api/legal, /api/chat)
```

## 1. Por que é compatível

| Ponto | Situação no código | Consequência |
|---|---|---|
| Build | `vite build` gera arquivos estáticos em `client/dist` (`base` padrão `/`) | Nada roda na Cloudflare: Worker sem `main` |
| Rotas | Uma única página, sem roteador; o Discord abre `/?instance_id=…&frame_id=…` | O fallback de SPA cobre qualquer outro caminho |
| Caminhos dos arquivos | `index.html` usa `/assets/…` (raiz) | Funcionam em qualquer caminho servido pelo fallback |
| API | `fetch('/api/token')`, `/api/legal/*`: relativos à página | O Discord repassa `/api` ao Render; nenhuma URL do backend no bundle |
| WebSocket | `chatUrl()` usa `location.host` + `/api/chat` | Dentro do Discord: `wss://<client_id>.discordsays.com/api/chat` → Render |
| Origem no backend | O chat aceita `https://<client_id>.discordsays.com` (`server/chat/origin.js`) | Independe de onde o frontend está; o Render não muda |
| Variáveis | Só `VITE_DISCORD_CLIENT_ID` (público), embutida no build | Nenhum segredo no bundle (conferido pelo `verify-dist`) |
| Iframe | Nenhum `X-Frame-Options`/`frame-ancestors` | O Discord consegue exibir a Activity |

Dependências de servidor que **não** vão para a Cloudflare: o proxy `/api` e o `allowedHosts` do
`vite.config.ts` valem só para `npm run dev`, `npm run dev:discord` e o Quick Tunnel.

## 2. Arquivos

| Arquivo | Função |
|---|---|
| `client/wrangler.jsonc` | Worker só de arquivos (`assets.directory: ./dist`, `not_found_handling: single-page-application`, `preview_urls: false`) |
| `client/public/_headers` | `nosniff`, `Referrer-Policy`; `/assets/*` com cache imutável; `/` e `/index.html` com `no-cache` |
| `client/public/.assetsignore` | Nunca envia source maps (`*.map`) |
| `client/scripts/verify-dist.mjs` | Recusa o `dist/` com segredo do `.env`, endereço de desenvolvimento, caminho relativo, source map, sem `_headers` ou sem o Client ID |
| `client/package.json` | `build:cloudflare`, `cf:dev`, `cf:dry-run`, `cf:deploy` (Wrangler com versão fixa, via `npx`) |

Os scripts `dev`, `dev:discord`, `build` e `preview` não mudaram.

## 3. Comportamento verificado localmente (`npm run cf:dev`)

Com o próprio Wrangler (simulador local, sem publicar):

| Requisição | Resposta |
|---|---|
| `GET /?instance_id=…` | `200` `index.html`, `Cache-Control: no-cache` |
| `GET /qualquer/rota` | `200` `index.html` (fallback de SPA) |
| `GET /index.html` | `307` → `/` |
| `GET /assets/index-<hash>.js` | `200`, `Cache-Control: public, max-age=31536000, immutable` |
| `GET /_headers`, `GET /.assetsignore` | não são servidos (caem no fallback) |
| `GET /api/health` | `200` **`index.html`** (a Cloudflare não tem `/api`) |
| `POST /api/token` | `405` |
| WebSocket `/api/chat` | sem `101`: não abre |

**Por isso o URL Mapping `/api` → Render é obrigatório.** Sem ele, nada é liberado: a troca do
código vira `backend_unreachable`, o aceite vira "resposta inesperada" e o chat não conecta.

Ressalva conhecida: um arquivo inexistente em `/assets/` também recebe o `index.html` com o
cabeçalho de cache imutável. Só acontece com endereços que nunca existiram (o `index.html` é
sempre revalidado e aponta para arquivos publicados), e o navegador recusa HTML como script.

## 4. Configuração necessária na Cloudflare

Nada precisa ser criado no painel antes: o primeiro `cf:deploy` cria o Worker.

1. Conta Cloudflare (plano Free). Requisições a arquivos estáticos são gratuitas e ilimitadas.
2. Um subdomínio `workers.dev` da conta (o painel pede para escolher no primeiro uso de Workers).
3. Login do Wrangler na sua máquina: `npx --yes wrangler@4.158.0 login` (abre o navegador; o
   token fica no seu perfil local, fora do projeto).
4. Nenhuma variável ou segredo no painel da Cloudflare: o build é feito na sua máquina e o
   Client ID vem do `.env` da raiz.

## 5. Publicação manual

No PowerShell, na pasta `client/`:

1. Conferir o `.env` da raiz: `VITE_DISCORD_CLIENT_ID` da aplicação **de produção**.
2. Instalar dependências e rodar os testes:
   ```powershell
   npm ci
   npm test
   ```
3. Simular o envio (não publica):
   ```powershell
   npm run cf:dry-run
   ```
   Esperado: `[verify-dist] ok`, `Read N files from the assets directory`, `--dry-run: exiting now.`
4. (Opcional) Testar localmente em `http://127.0.0.1:8787`:
   ```powershell
   npm run cf:dev
   ```
5. Publicar:
   ```powershell
   npm run cf:deploy
   ```
   Anote a URL exibida, `https://all-in-one-frontend.<subdomínio>.workers.dev`, e o **Version ID**.
6. Conferir sem o Discord: abrir a URL → a página carrega (fora do Discord, mostra a Home sem
   sessão). `…/api/health` mostra a própria página, não JSON: é o esperado.
7. No Developer Portal, **Activities → URL Mappings**:

   | PREFIX | TARGET |
   |---|---|
   | `/` | `all-in-one-frontend.<subdomínio>.workers.dev` (sem `https://`) |
   | `/api` | `all-in-one-5lek.onrender.com/api` (**sem mudança**) |

   Anote antes o destino atual de `/` (o `*.trycloudflare.com`), para a reversão.

## 6. Testar no Discord

A migração só está concluída depois deste roteiro, no computador e no celular:

| Passo | Resultado esperado |
|---|---|
| Abrir a Activity com o túnel local **desligado** | A página carrega (prova que vem da Cloudflare) |
| Sessão Discord | As 5 etapas concluem; `backend_timeout` só se o Render estiver acordando (Tentar novamente resolve) |
| Aceite | Tela de aceite ou entrada direta, conforme o registro no banco |
| Chat | **Conectado**; mensagens entre duas contas em tempo real |
| Reabrir depois de um novo `cf:deploy` | A versão nova aparece (o `index.html` não fica em cache) |
| Celular: queda de internet | O chat reconecta sozinho |

## 7. Reverter

| Situação | Como reverter |
|---|---|
| Voltar ao Quick Tunnel | Subir `npm run dev:discord` (ou `npm run dev`) e `cloudflared tunnel --url http://localhost:5173`; no URL Mapping, `/` → `<novo>.trycloudflare.com`. `/api` continua no Render |
| Versão nova com defeito | `npx --yes wrangler@4.158.0 deployments list` e `npx --yes wrangler@4.158.0 rollback <VERSION_ID>` (na pasta `client/`), ou republicar o commit anterior com `npm run cf:deploy` |
| Abandonar a Cloudflare | Reverter o URL Mapping (primeira linha) e, depois, `npx --yes wrangler@4.158.0 delete` |

Nenhuma reversão mexe no Render, no Neon ou no código do backend.

## 8. Antes de abrir para usuários

- A Política de Privacidade descreve a interface servida pelo Quick Tunnel no computador do
  responsável; com a Cloudflare Workers, esse trecho precisa ser revisto (decisão sua; os
  documentos jurídicos não foram alterados).
- Trocar o Client ID exige novo `cf:deploy` (o valor entra no build).
