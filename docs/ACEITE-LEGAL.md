# Aceite dos documentos legais

Na primeira entrada, a Activity pede o **aceite dos Termos de Uso** e a **declaração de ciência
da Política de Privacidade**. Sem isso, o chat e os demais recursos ficam bloqueados, e o
bloqueio é verificado **no servidor**.

> **Não libere esta funcionalidade aos usuários** enquanto a Política de Privacidade não
> descrever o registro dos aceites (finalidade, dados, prazo de guarda e o provedor do banco) e
> não estiver publicada. A implementação não altera os textos jurídicos.

O checkbox **não** é um consentimento para tratamento de dados: ele registra o aceite dos
Termos e a ciência da Política. As bases legais de cada tratamento continuam descritas na
Política de Privacidade, e o registro do aceite não garante, sozinho, a validade delas.

## Fluxo

1. O `DiscordProvider` autentica no Discord como antes (`authorize` → `/api/token` → `authenticate`).
2. O `LegalGate` (`client/src/legal/LegalGate.tsx`) consulta `GET /api/legal/status` com o token.
3. Sem aceite das versões atuais, mostra a tela de aceite; o `ChatConnectionProvider` e a Home
   ficam **dentro** do `LegalGate`, então nenhum WebSocket do chat é aberto e os participantes
   não aparecem.
4. "Aceitar e continuar" (habilitado só com o checkbox marcado) envia `POST /api/legal/acceptance`
   com as versões exibidas. A Activity só é liberada depois da resposta do servidor.
5. "Recusar" não registra nada: explica que o uso depende do aceite e oferece "Rever documentos"
   ou "Sair da Activity" (`sdk.close`).
6. Se o servidor fechar o chat com `legal_acceptance_required` (documentos atualizados durante a
   sessão), o `LegalChatWatcher` faz o `LegalGate` consultar de novo e a tela reaparece.

Fora do Discord (navegador comum) não há sessão nem recursos, e a Home aparece como antes.

## Rotas

| Rota | Autenticação | Resposta |
|---|---|---|
| `GET /api/legal/status` | `Authorization: Bearer <token OAuth>` | `{ documents, accepted, acceptedAt }` |
| `POST /api/legal/acceptance` | idem; corpo `{ termsVersion, privacyVersion }` | `201` (registrado) ou `200` (já existia) com `{ accepted: true, acceptedAt, documents }` |

- A identidade vem **somente** do token, validado no Discord pelo mesmo validador do chat
  (mesmo cache, cache negativo e teto de chamadas). IDs enviados no corpo são ignorados.
- Versões diferentes das atuais: `409 version_mismatch` com os documentos atuais.
- Sem token ou token inválido: `401`. Banco ou Discord indisponível: `503`. Respostas com
  `Cache-Control: no-store`.

### Limites (`429` com `Retry-After`)

| Camada | Status | Aceite | Quando é aplicada |
|---|---|---|---|
| Por usuário autenticado (ID do Discord) | 20/min | 6/min | depois de validar o token: a cota de cada pessoa |
| Por IP (`req.ip`, regra do `TRUST_PROXY`) | 300/min | 300/min | antes de validar o token: só contra enxurradas |

O proxy das Activities do Discord existe, segundo a documentação do Discord, para **esconder o
IP dos usuários**. No Render, portanto, muitas pessoas podem chegar com o mesmo IP (o do proxy),
e um limite baixo por IP bloquearia todos juntos. Por isso a cota justa é por usuário, e o teto
por IP é alto. O teto global de validações de token no Discord (`chat/config.js`) continua valendo.

**Depende do deploy:** quantos usuários de fato compartilham um IP só pode ser medido no Render
(`PROXY_DIAGNOSTICS=true`, ver [DEPLOY-RENDER.md](DEPLOY-RENDER.md#proxy-confiável-no-render)).
Os limites do `/api/token` e do WebSocket foram revistos com a mesma premissa; a tabela completa,
com o que vale antes e depois da autenticação, está em
[SEGURANCA.md](SEGURANCA.md#limites-com-ip-compartilhado-proxy-do-discord). Todos os contadores
ficam em memória e valem **por instância** do servidor.

## Bloqueio no servidor (chat)

Depois de autenticar o usuário e a instância, e **antes** de entrar na sala, o chat chama
`requireLegalAcceptance` (`server/legal/gate.js`):

| Situação | Fechamento | O cliente |
|---|---|---|
| Sem aceite das versões atuais | `4003 legal_acceptance_required` | para e volta à tela de aceite |
| Banco indisponível (fora do ar, limite de computação do Neon, timeout) | `1013 acceptance_unavailable` | reconecta com backoff |

Uma falha do banco **nunca** libera o acesso. Aceites confirmados ficam em cache por 10 min
(um aceite de um par de versões não expira); "não aceitou" e falhas sempre consultam o banco.

**Revalidação no cliente:** quando o chat fecha com `legal_acceptance_required`, o `LegalGate`
volta a consultar o servidor, uma verificação por vez (pedidos simultâneos são ignorados) e com
backoff em repetições seguidas (imediata, depois 1 s, 2 s, 4 s… até 30 s; o contador zera após
60 s liberada). Durante a espera o chat fica desmontado, então não há laço de reconexões, e uma
falha na consulta mantém o bloqueio.

### Impacto do cache de 10 minutos

O cache fica na memória do processo do backend. Se um registro for apagado do banco (exclusão
administrativa abaixo), o usuário ainda entra no chat por **até 10 minutos** nesse processo, e
quem já está conectado continua conectado até a conexão cair. Uma reinicialização do serviço
limpa o cache e encerra todas as conexões na hora.

## Versionamento

Fonte única: `server/legal/config.js` (`LEGAL_DOCUMENT_VERSIONS`), com versões independentes
para os Termos e a Política. Para publicar uma alteração, troque a versão do documento: aceites
de outras versões deixam de valer e todos veem a tela de novo na próxima entrada (e o chat recusa
a entrada na sala). Hoje qualquer mudança de versão exige um novo aceite; distinguir alterações
que só exigem ciência depende de orientação jurídica.

As URLs ficam no mesmo arquivo, alteráveis sem mudar o código por `LEGAL_TERMS_URL` e
`LEGAL_PRIVACY_URL` (somente HTTPS). Os links abrem pela confirmação do Discord (`openExternalLink`).

## Registro

Tabela `legal_acceptances` (migration `server/db/migrations/001_legal_acceptances.sql`):

| Coluna | Conteúdo |
|---|---|
| `discord_user_id` | ID do usuário no Discord (vindo do token validado) |
| `terms_version` / `privacy_version` | versões aceitas |
| `accepted_at` | data e hora (`timestamptz`, UTC) |
| `app_version` | versão do `server/package.json` + commit do Render (`RENDER_GIT_COMMIT`), quando houver |

Chave primária: usuário + versões, então cliques repetidos não duplicam o registro. Não há token,
IP, nome nem outros dados. Recusas não são gravadas. O prazo de guarda dos registros ainda não foi
definido (decisão do responsável, a constar da Política de Privacidade).

### Exclusão administrativa (ex.: pedido de eliminação de um titular)

Não existe rota de exclusão: é um procedimento manual do responsável, no **SQL Editor** do Neon
(ou `psql` com a mesma `DATABASE_URL`).

1. Confirme a identidade de quem pediu e obtenha o **ID do Discord** (17 a 20 dígitos). Nunca
   apague por nome de usuário.
2. Abra uma transação e confira exatamente o que será apagado:

   ```sql
   BEGIN;
   SELECT discord_user_id, terms_version, privacy_version, accepted_at
     FROM legal_acceptances
    WHERE discord_user_id = '<ID_DO_DISCORD>';
   ```

   Se não vier nenhuma linha, ou vierem linhas de outro ID, faça `ROLLBACK;` e pare.
3. Apague só o que foi conferido. Para todas as versões do usuário:

   ```sql
   DELETE FROM legal_acceptances
    WHERE discord_user_id = '<ID_DO_DISCORD>'
   RETURNING discord_user_id, terms_version, privacy_version;
   ```

   Para uma versão específica, acrescente `AND terms_version = '<versão>' AND privacy_version = '<versão>'`.
4. Confira que o número de linhas devolvidas é igual ao do passo 2. Se for, `COMMIT;`; se não,
   `ROLLBACK;`.
5. Para que a exclusão valha na hora, **reinicie o serviço** no Render (Manual Deploy →
   Restart, ou equivalente): isso limpa o cache de 10 min e encerra as conexões abertas. Sem
   reiniciar, o acesso continua por até 10 min.
6. Na próxima entrada, a pessoa verá a tela de aceite de novo; se aceitar, um registro novo é criado.

Não registre o ID em logs, tickets públicos ou mensagens além do necessário para o atendimento.

## Armazenamento

`server/legal/acceptance-store.js` define a interface (`findAcceptance`, `recordAcceptance`,
`ready`, `close`); trocar de provedor é implementar os mesmos métodos.

- **PostgreSQL** (`pg`), configurado por `DATABASE_URL` (somente no backend). TLS obrigatório com
  verificação do certificado em produção e no Render; `sslmode=disable` só é aceito em
  desenvolvimento. Consultas parametrizadas; a URL nunca aparece nos logs (só o host).
- **Migrations** em `server/db/migrations/`, aplicadas na inicialização sob advisory lock e
  registradas em `schema_migrations`; se o banco estiver fora, tenta de novo na primeira operação.
  Duas instâncias subindo juntas não aplicam a mesma migration duas vezes.
- **Em produção (`NODE_ENV=production`) ou no Render, sem `DATABASE_URL`** (ou com ela inválida,
  ou com `sslmode=disable`): **o servidor não inicia**. Assim o Render não marca como saudável um
  serviço que não consegue registrar aceites.
- **Fora de produção, sem `DATABASE_URL`**: o aceite fica indisponível (`"legalStore":"unavailable"`)
  e o chat recusa as conexões. `LEGAL_STORE=memory` (só desenvolvimento local) guarda em memória;
  em produção ele é recusado e não existe nenhuma alternativa em memória.
- **Banco fora do ar em execução** (Neon suspenso, limite do plano, rede): o servidor continua no
  ar, o `/api/health` continua respondendo (ele não consulta o banco, para não manter o Neon
  acordado), as rotas de aceite respondem `503` e o chat fecha com `1013`. O pool reconecta
  sozinho quando o banco volta.

### Conexão e compatibilidade com o pooler do Neon

O pooler do Neon é baseado em PgBouncer, que recusa parâmetros de sessão enviados na abertura da
conexão (erro "unsupported startup parameter"). Por isso o servidor envia na abertura **somente**
usuário, banco e `application_name`:

- o prazo de cada consulta é controlado no Node (`query_timeout`, 6 s) e o de conexão em 10 s;
- as migrations definem `lock_timeout` e `statement_timeout` com `SET LOCAL`, válidos só dentro
  da transação delas (compatível com PgBouncer em modo transação).

**Conexão recomendada: a string direta** (host sem `-pooler`). O backend tem uma única instância
com no máximo 5 conexões, então não precisa do pooler. A string com pooler deve funcionar com
essa configuração, mas **não foi testada com o Neon real**: os testes usam um PostgreSQL local
(PGlite), que **não reproduz o PgBouncer**.

### Limite de duração no PostgreSQL (opcional, manual)

As consultas de aceite são buscas e inserções pela chave primária. Se quiser também um teto no
próprio servidor PostgreSQL, sem depender da abertura da conexão, rode uma vez no SQL Editor do
Neon, com o usuário da aplicação:

```sql
ALTER ROLE CURRENT_USER SET statement_timeout = '5s';
```

Vale para as sessões novas desse usuário (inclusive pelo pooler). Não foi automatizado porque é
uma configuração persistente do banco, fora do controle das migrations, e não foi testado no Neon.

## Neon: criar o banco e configurar o Render

Feito pelo responsável; nada disso é automatizado.

1. Crie uma conta em [neon.tech](https://neon.tech) no plano **Free**.
2. Crie um projeto (ex.: `all-in-one`) na região **AWS South America East 1 (São Paulo)**,
   `aws-sa-east-1`.
3. No painel do projeto, abra **Connect**, **desative o connection pooling** e copie a
   *connection string* **direta** (host sem `-pooler`; formato
   `postgresql://<usuário>:<senha>@<host>.sa-east-1.aws.neon.tech/<banco>?sslmode=require`).
   O servidor força TLS com verificação do certificado de qualquer forma.
4. **Não** coloque essa string no repositório, no frontend, em mensagens ou em logs.
5. No Render, no serviço do backend, abra **Environment** → **Add Environment Variable**:
   chave `DATABASE_URL`, valor = a string copiada. Salve. O Render oferece reimplantar; isso
   publica o serviço, então só faça quando a liberação estiver autorizada.
6. Depois da implantação, confira:
   - `GET https://<serviço>.onrender.com/api/health` → `"legalStore":"postgres"`;
   - os logs mostram `Aceites legais: PostgreSQL em <host> (TLS)` e
     `[db] migrations aplicadas: 1` (nas próximas inicializações, `schema atualizado`).
7. Se a string vazar, troque a senha do usuário no Neon e atualize `DATABASE_URL` no Render.

No plano Free, a computação do Neon é suspensa quando ociosa (a primeira consulta demora um
pouco mais) e tem limite mensal de uso. Quando o banco não responde, o servidor responde `503`
e o chat fecha com `1013`: ninguém entra sem aceite confirmado.

## Testes

- `server/test/legal-acceptance.test.js`: configuração e TLS, migrations, armazenamento contra um
  **PostgreSQL real** (PGlite atrás de um servidor TCP, pelo driver `pg`), cliques simultâneos,
  banco fora do ar, **persistência após reiniciar o servidor e o banco**, `server.js` real
  aplicando as migrations, rotas `/api/legal` (12 cenários) e o bloqueio no WebSocket.
  Também: parâmetros de abertura compatíveis com PgBouncer, TLS que a URL não consegue
  enfraquecer, `server.js` que não inicia em produção sem `DATABASE_URL`, e limites por usuário
  com vários usuários no mesmo IP.
- `client/test/legal/`: tela de aceite, checkbox, links, recusa e saída, clique duplicado, falhas
  de rede e de servidor, documentos atualizados (409), bloqueio sem confirmação do servidor,
  retorno à tela quando o chat informa `legal_acceptance_required`, backoff e verificação única
  contra laços.

**Limitações:** nenhum teste usa o Neon, o pooler (PgBouncer) ou o Discord reais; o PGlite é um
PostgreSQL real, mas não reproduz o pooler. O fechamento da Activity (`sdk.close`) é testado com
simulação.
