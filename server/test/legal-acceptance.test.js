/*
 * Aceite dos documentos legais (Termos de Uso + ciência da Política de Privacidade).
 *
 * - Armazenamento testado contra um PostgreSQL REAL (PGlite atrás de um servidor TCP),
 *   pelo driver `pg`, como em produção com o Neon; inclusive reinícios do servidor e do banco.
 * - Rotas /api/legal e o chat testados com o app/servidor reais e o Discord simulado.
 * Nenhuma credencial real é usada.
 */
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { createApp } from "../app.js";
import { createTokenValidator } from "../chat/auth.js";
import { createDiscordAuthenticator } from "../chat/authenticator.js";
import { attachChat } from "../chat/index.js";
import { DatabaseConfigError, resolveAcceptanceStoreKind, resolveDatabaseConfig } from "../db/config.js";
import { runMigrations } from "../db/migrate.js";
import { buildPoolOptions, createDbPool, DB_POOL_DEFAULTS, FORBIDDEN_STARTUP_OPTIONS } from "../db/pool.js";
import pg from "pg";
import {
  AcceptanceStoreUnavailableError,
  createMemoryAcceptanceStore,
  createPostgresAcceptanceStore,
  createUnavailableAcceptanceStore,
} from "../legal/acceptance-store.js";
import { DEFAULT_LEGAL_URLS, LEGAL_DOCUMENT_VERSIONS, resolveAppVersion, resolveLegalDocuments } from "../legal/config.js";
import { createLegalGate } from "../legal/gate.js";
import { createLegalRouter } from "../legal/routes.js";
import { APP_ID, BOT_TOKEN, captureLogger, defaultDiscord, INSTANCE_1, TOKEN_A, TOKEN_B, USER_A, USER_B } from "./helpers/fake-discord.js";
import { freePort, startPgServer } from "./helpers/pglite-server.js";

const ORIGIN = "http://localhost:5173";
const SERVER_JS = fileURLToPath(new URL("../server.js", import.meta.url));
const docs = (terms = "t-1", privacy = "p-1") => resolveLegalDocuments({}, { terms, privacy });
const quietLogger = () => captureLogger().logger;

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

describe("configuração do banco (DATABASE_URL)", () => {
  const URL_NEON = "postgresql://usuario:SENHA-SECRETA@ep-exemplo-123.sa-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

  test("sem DATABASE_URL: 'unavailable' só em desenvolvimento; em produção/Render a inicialização falha", () => {
    assert.equal(resolveDatabaseConfig({}), null);
    assert.equal(resolveAcceptanceStoreKind({}, null), "unavailable");
    for (const env of [{ NODE_ENV: "production" }, { RENDER: "true" }, { NODE_ENV: "production", LEGAL_STORE: "postgres" }]) {
      assert.throws(() => resolveAcceptanceStoreKind(env, null), /DATABASE_URL é obrigatório em produção/);
    }
  });

  test("conexão compatível com PgBouncer (pooler do Neon): só usuário, banco e application_name na inicialização", () => {
    const config = resolveDatabaseConfig({ DATABASE_URL: URL_NEON.replace("ep-exemplo-123", "ep-exemplo-123-pooler"), NODE_ENV: "production" });
    const options = buildPoolOptions(config);
    for (const key of FORBIDDEN_STARTUP_OPTIONS) assert.equal(options[key], undefined, `${key} não pode ir na inicialização`);
    assert.equal(options.query_timeout, DB_POOL_DEFAULTS.queryTimeoutMs, "prazo da consulta continua no lado do Node");

    // O pacote de inicialização que o driver realmente enviaria.
    const client = new pg.Client(options);
    assert.deepEqual(Object.keys(client.getStartupConf()).sort(), ["application_name", "database", "user"]);
    assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: true }, "TLS com verificação do certificado");
  });

  test("TLS não pode ser enfraquecido pela URL (ssl=false, sslmode=no-verify etc.)", () => {
    for (const query of ["ssl=false", "sslmode=no-verify", "sslmode=prefer", "sslmode=allow", ""]) {
      const config = resolveDatabaseConfig({ DATABASE_URL: `postgresql://u:p@db.exemplo.com/neondb?${query}`, NODE_ENV: "production" });
      const client = new pg.Client(buildPoolOptions(config));
      assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: true }, query || "sem parâmetro");
    }
  });

  test("TLS sempre ativo com verificação de certificado; parâmetros SSL da URL são substituídos", () => {
    const config = resolveDatabaseConfig({ DATABASE_URL: URL_NEON, NODE_ENV: "production" });
    assert.deepEqual(config.ssl, { rejectUnauthorized: true });
    assert.doesNotMatch(config.connectionString, /sslmode/);
    assert.match(config.connectionString, /channel_binding=require/);
    assert.equal(config.host, "ep-exemplo-123.sa-east-1.aws.neon.tech");
  });

  test("sslmode=disable é recusado em produção e no Render; aceito só em desenvolvimento", () => {
    const url = "postgresql://u:p@localhost:5432/db?sslmode=disable";
    for (const env of [{ NODE_ENV: "production" }, { RENDER: "true" }]) {
      assert.throws(() => resolveDatabaseConfig({ DATABASE_URL: url, ...env }), DatabaseConfigError);
    }
    assert.equal(resolveDatabaseConfig({ DATABASE_URL: url }).ssl, false);
  });

  test("erros de configuração nunca contêm a URL nem a senha", () => {
    for (const DATABASE_URL of ["nao-e-url SENHA-SECRETA", "mysql://u:SENHA-SECRETA@h/db", `${URL_NEON.replace("require", "disable")}`]) {
      try {
        resolveDatabaseConfig({ DATABASE_URL, NODE_ENV: "production" });
        assert.fail("deveria recusar");
      } catch (error) {
        assert.ok(error instanceof DatabaseConfigError);
        assert.doesNotMatch(error.message, /SENHA-SECRETA|neon\.tech|usuario/);
      }
    }
  });

  test("LEGAL_STORE=memory só por opção explícita e nunca em produção", () => {
    assert.equal(resolveAcceptanceStoreKind({ LEGAL_STORE: "memory" }, null), "memory");
    assert.throws(() => resolveAcceptanceStoreKind({ LEGAL_STORE: "memory", NODE_ENV: "production" }, null), /não é permitido em produção/);
    assert.throws(() => resolveAcceptanceStoreKind({ LEGAL_STORE: "memory", RENDER: "true" }, null), /não é permitido em produção/);
    assert.throws(() => resolveAcceptanceStoreKind({ LEGAL_STORE: "redis" }, null), DatabaseConfigError);
  });
});

describe("documentos e versões", () => {
  test("versões independentes e URLs centralizadas, alteráveis pelo ambiente (somente HTTPS)", () => {
    const current = resolveLegalDocuments({});
    assert.equal(current.terms.version, LEGAL_DOCUMENT_VERSIONS.terms);
    assert.equal(current.privacy.version, LEGAL_DOCUMENT_VERSIONS.privacy);
    assert.equal(current.terms.url, DEFAULT_LEGAL_URLS.terms);
    const custom = resolveLegalDocuments({ LEGAL_TERMS_URL: "https://exemplo.com/termos", LEGAL_PRIVACY_URL: "https://exemplo.com/privacidade" });
    assert.equal(custom.terms.url, "https://exemplo.com/termos");
    assert.throws(() => resolveLegalDocuments({ LEGAL_TERMS_URL: "http://exemplo.com/termos" }), /HTTPS/);
    assert.throws(() => resolveLegalDocuments({}, { terms: "versão com espaço", privacy: "p" }), /Versão inválida/);
  });

  test("versão da aplicação: package.json + commit do Render, quando existir", () => {
    assert.equal(resolveAppVersion({}, "1.0.0"), "1.0.0");
    assert.equal(resolveAppVersion({ RENDER_GIT_COMMIT: "43a887ebb94d1022ff00e7b595acc4ce640a0830" }, "1.0.0"), "1.0.0+43a887e");
    assert.equal(resolveAppVersion({ RENDER_GIT_COMMIT: "<script>" }, "1.0.0"), "1.0.0");
  });
});

// ---------------------------------------------------------------------------
// Armazenamento PostgreSQL real (PGlite + driver pg)
// ---------------------------------------------------------------------------

describe("armazenamento PostgreSQL (driver pg contra Postgres real)", () => {
  let pg;
  let pool;
  let store;

  before(async () => {
    pg = await startPgServer();
    pool = createDbPool(resolveDatabaseConfig({ DATABASE_URL: pg.url }), { logger: quietLogger() });
    store = createPostgresAcceptanceStore({ pool, logger: quietLogger() });
  });
  after(async () => {
    await store.close();
    await pg.stop();
  });

  test("migrations criam o schema e são idempotentes", async () => {
    await store.ready();
    assert.deepEqual(await runMigrations(pool), [], "segunda execução não aplica nada");
    const { rows } = await pool.query("SELECT version, name FROM schema_migrations ORDER BY version");
    assert.deepEqual(rows, [
      { version: 1, name: "001_legal_acceptances.sql" },
      { version: 2, name: "002_legal_document_hashes.sql" },
    ]);
  });

  test("o registro guarda só o necessário: nenhuma coluna de token, IP ou nome", async () => {
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'legal_acceptances' ORDER BY ordinal_position",
    );
    assert.deepEqual(
      rows.map((r) => r.column_name),
      ["discord_user_id", "terms_version", "privacy_version", "accepted_at", "app_version", "terms_sha256", "privacy_sha256"],
    );
  });

  test("aceite válido: grava uma vez; repetir devolve o registro original (sem duplicar)", async () => {
    const first = await store.recordAcceptance({ userId: USER_A.id, terms: "t-1", privacy: "p-1", appVersion: "1.0.0" });
    assert.equal(first.created, true);
    assert.match(first.acceptedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "data e hora em UTC (ISO 8601)");
    const again = await store.recordAcceptance({ userId: USER_A.id, terms: "t-1", privacy: "p-1", appVersion: "1.0.0" });
    assert.deepEqual(again, { acceptedAt: first.acceptedAt, created: false });
    assert.deepEqual(await store.findAcceptance(USER_A.id, { terms: "t-1", privacy: "p-1" }), { acceptedAt: first.acceptedAt });
  });

  test("cliques duplicados simultâneos geram um único registro", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.recordAcceptance({ userId: USER_B.id, terms: "t-1", privacy: "p-1" })),
    );
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.acceptedAt)).size, 1);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM legal_acceptances WHERE discord_user_id = $1", [USER_B.id]);
    assert.equal(rows[0].n, 1);
  });

  test("aceite de outra versão (Termos ou Política) não vale para a versão atual", async () => {
    await store.recordAcceptance({ userId: "333333333333333333", terms: "t-1", privacy: "p-1" });
    assert.equal(await store.findAcceptance("333333333333333333", { terms: "t-2", privacy: "p-1" }), null);
    assert.equal(await store.findAcceptance("333333333333333333", { terms: "t-1", privacy: "p-2" }), null);
  });

  test("consultas parametrizadas: entradas maliciosas são recusadas antes do banco ou tratadas como dado", async () => {
    await assert.rejects(store.findAcceptance("1' OR '1'='1", { terms: "t", privacy: "p" }), TypeError);
    assert.equal(await store.findAcceptance(USER_A.id, { terms: "t-1' OR '1'='1", privacy: "p-1" }), null);
  });
});

describe("indisponibilidade do banco nunca libera o acesso", () => {
  test("banco fora do ar (ou limite de computação): AcceptanceStoreUnavailableError, sem dados da conexão no log", async () => {
    const pg = await startPgServer();
    const { logger, lines } = captureLogger();
    const pool = createDbPool(resolveDatabaseConfig({ DATABASE_URL: pg.url }), { logger, connectionTimeoutMillis: 1_000 });
    const store = createPostgresAcceptanceStore({ pool, logger });
    await store.ready();
    await pg.stop();

    await assert.rejects(store.findAcceptance(USER_A.id, { terms: "t-1", privacy: "p-1" }), AcceptanceStoreUnavailableError);
    await assert.rejects(store.recordAcceptance({ userId: USER_A.id, terms: "t-1", privacy: "p-1" }), AcceptanceStoreUnavailableError);
    const gate = createLegalGate({ store, documents: docs() });
    await assert.rejects(gate.requireAccepted(USER_A), (error) => error.reason === "acceptance_unavailable");

    const logged = lines.join("\n");
    assert.match(logged, /\[db\] consulta de aceite falhou/, "a falha é registrada (só tipo/código)");
    assert.doesNotMatch(logged, /postgres:postgres|127\.0\.0\.1:\d+\/postgres/, "nem usuário/senha nem URL nos logs");
    await pool.end().catch(() => {});
  });

  test("migration falhando: a próxima operação tenta de novo", async () => {
    let calls = 0;
    const migrate = async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return [];
    };
    const pool = { query: async () => ({ rows: [] }), end: async () => {} };
    const store = createPostgresAcceptanceStore({ pool, migrate, logger: quietLogger() });
    await assert.rejects(store.findAcceptance(USER_A.id, { terms: "t", privacy: "p" }), AcceptanceStoreUnavailableError);
    assert.equal(await store.findAcceptance(USER_A.id, { terms: "t", privacy: "p" }), null);
    assert.equal(calls, 2);
  });

  test("sem armazenamento configurado: tudo indisponível", async () => {
    const store = createUnavailableAcceptanceStore();
    await assert.rejects(store.findAcceptance(USER_A.id, { terms: "t", privacy: "p" }), AcceptanceStoreUnavailableError);
  });
});

describe("persistência após reinicialização", () => {
  test("reinício do servidor da aplicação: novo pool e novo armazenamento encontram o aceite", async () => {
    const pg = await startPgServer();
    try {
      const config = resolveDatabaseConfig({ DATABASE_URL: pg.url });
      const first = createPostgresAcceptanceStore({ pool: createDbPool(config, { logger: quietLogger() }), logger: quietLogger() });
      const { acceptedAt } = await first.recordAcceptance({ userId: USER_A.id, terms: "t-1", privacy: "p-1", appVersion: "1.0.0" });
      await first.close(); // "processo" encerrado: nada fica em memória

      const second = createPostgresAcceptanceStore({ pool: createDbPool(config, { logger: quietLogger() }), logger: quietLogger() });
      assert.deepEqual(await second.findAcceptance(USER_A.id, { terms: "t-1", privacy: "p-1" }), { acceptedAt });
      await second.close();
    } finally {
      await pg.stop();
    }
  });

  test("reinício do próprio banco (dados em disco): o aceite continua registrado", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "aio-pg-"));
    try {
      const port = await freePort();
      let pg = await startPgServer({ dataDir, port });
      const config = resolveDatabaseConfig({ DATABASE_URL: pg.url });
      let store = createPostgresAcceptanceStore({ pool: createDbPool(config, { logger: quietLogger() }), logger: quietLogger() });
      const { acceptedAt } = await store.recordAcceptance({ userId: USER_B.id, terms: "t-9", privacy: "p-9" });
      await store.close();
      await pg.stop();

      pg = await startPgServer({ dataDir, port });
      store = createPostgresAcceptanceStore({ pool: createDbPool(config, { logger: quietLogger() }), logger: quietLogger() });
      assert.deepEqual(await store.findAcceptance(USER_B.id, { terms: "t-9", privacy: "p-9" }), { acceptedAt });
      await store.close();
      await pg.stop();
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("server.js real: aplica as migrations na 1ª inicialização, não reaplica na 2ª e informa o armazenamento", async () => {
    const pg = await startPgServer();
    try {
      const run = async () => {
        const port = await freePort();
        const env = { ...process.env, PORT: String(port), DATABASE_URL: pg.url, VITE_DISCORD_CLIENT_ID: "", DISCORD_CLIENT_SECRET: "", DISCORD_BOT_TOKEN: "" };
        for (const key of ["NODE_ENV", "RENDER", "HOST", "LEGAL_STORE", "TRUST_PROXY"]) delete env[key];
        const child = spawn(process.execPath, [SERVER_JS], { env, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        child.stdout.on("data", (d) => (output += d));
        child.stderr.on("data", (d) => (output += d));
        // Espera o schema ficar pronto (log da inicialização) e o HTTP responder.
        const deadline = Date.now() + 15_000;
        let health = null;
        while (Date.now() < deadline && !(health && /migrations aplicadas|schema atualizado/.test(output))) {
          try {
            health = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
          } catch {
            /* ainda subindo */
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        child.kill();
        await once(child, "exit");
        return { output, health };
      };

      const first = await run();
      assert.deepEqual(first.health, { ok: true, oauthConfigured: false, chatConfigured: false, legalStore: "postgres" });
      assert.match(first.output, /Aceites legais: PostgreSQL em 127\.0\.0\.1/);
      assert.doesNotMatch(first.output, /postgres:postgres/, "credenciais nunca aparecem no log");

      const { rows } = await (async () => {
        const pool = createDbPool(resolveDatabaseConfig({ DATABASE_URL: pg.url }), { logger: quietLogger() });
        try {
          return await pool.query("SELECT version FROM schema_migrations");
        } finally {
          await pool.end();
        }
      })();
      assert.deepEqual(rows.map((r) => r.version).sort(), [1, 2], "a 1ª inicialização criou o schema");

      const second = await run();
      assert.doesNotMatch(second.output, /migrations aplicadas/, "a 2ª inicialização não reaplica");
      assert.equal(second.health.legalStore, "postgres");
    } finally {
      await pg.stop();
    }
  });

  test("server.js em produção sem DATABASE_URL, ou com DATABASE_URL inválida/sem TLS: não inicia", async () => {
    const cases = [
      { NODE_ENV: "production" },
      { RENDER: "true" },
      { NODE_ENV: "production", DATABASE_URL: "nao-e-url" },
      { NODE_ENV: "production", DATABASE_URL: "postgresql://u:SENHA-SECRETA@db.exemplo.com/db?sslmode=disable" },
    ];
    for (const overrides of cases) {
      const env = { ...process.env, PORT: String(await freePort()), TRUST_PROXY: "1", ...overrides };
      if (!("DATABASE_URL" in overrides)) delete env.DATABASE_URL;
      delete env.LEGAL_STORE;
      const child = spawn(process.execPath, [SERVER_JS], { env, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.on("data", (d) => (output += d));
      child.stderr.on("data", (d) => (output += d));
      const [code] = await once(child, "exit");
      assert.notEqual(code, 0, JSON.stringify(Object.keys(overrides)));
      assert.doesNotMatch(output, /Server listening/, "nunca chega a escutar");
      assert.doesNotMatch(output, /SENHA-SECRETA/, "a URL não aparece no erro");
    }
  });

  test("server.js em produção: LEGAL_STORE=memory é recusado (sem armazenamento volátil em produção)", async () => {
    const env = { ...process.env, NODE_ENV: "production", PORT: String(await freePort()), LEGAL_STORE: "memory", TRUST_PROXY: "1" };
    delete env.DATABASE_URL;
    const child = spawn(process.execPath, [SERVER_JS], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stderr.on("data", (d) => (output += d));
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0);
    assert.match(output, /LEGAL_STORE=memory não é permitido em produção/);
  });
});

// ---------------------------------------------------------------------------
// Rotas /api/legal (app real, Discord simulado)
// ---------------------------------------------------------------------------

const running = [];
afterEach(async () => {
  for (const item of running.splice(0)) await item();
});

async function startLegalApp({ store = createMemoryAcceptanceStore(), documents = docs(), discord = defaultDiscord(), routerOptions = {} } = {}) {
  const logger = quietLogger();
  const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl: discord.fetchImpl, logger });
  const gate = createLegalGate({ store, documents });
  const router = createLegalRouter({ validateToken: (t) => tokens.validate(t), gate, documents, appVersion: "1.0.0+test", logger, ...routerOptions });
  const app = createApp({ logger, legalRouter: router, legalStore: store.kind });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  running.push(async () => {
    router.close();
    app.locals.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/legal`;
  const call = async (method, route, { token, body, headers = {} } = {}) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { "Content-Type": "application/json" }), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
  };
  return { store, gate, documents, discord, call, accept: (token, versions = documents) => call("POST", "/acceptance", { token, body: { termsVersion: versions.terms.version, privacyVersion: versions.privacy.version } }) };
}

describe("rotas /api/legal", () => {
  test("1. primeiro acesso sem aceite: status informa documentos atuais e accepted=false", async () => {
    const { call } = await startLegalApp();
    const res = await call("GET", "/status", { token: TOKEN_A });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(res.body, {
      documents: {
        terms: { version: "t-1", url: DEFAULT_LEGAL_URLS.terms, sha256: null },
        privacy: { version: "p-1", url: DEFAULT_LEGAL_URLS.privacy, sha256: null },
      },
      accepted: false,
      acceptedAt: null,
    });
  });

  test("2. aceite válido: registra (201) e o status passa a accepted=true", async () => {
    const { call, accept, store } = await startLegalApp();
    const res = await accept(TOKEN_A);
    assert.equal(res.status, 201);
    assert.equal(res.body.accepted, true);
    assert.equal(store.size(), 1);
    const status = await call("GET", "/status", { token: TOKEN_A });
    assert.equal(status.body.accepted, true);
    assert.equal(status.body.acceptedAt, res.body.acceptedAt);
  });

  test("3. aceite anterior válido: não precisa aceitar de novo", async () => {
    const store = createMemoryAcceptanceStore();
    await store.recordAcceptance({ userId: USER_A.id, terms: "t-1", privacy: "p-1" });
    const { call } = await startLegalApp({ store });
    assert.equal((await call("GET", "/status", { token: TOKEN_A })).body.accepted, true);
  });

  test("4. versão dos Termos alterada: aceite antigo deixa de valer e a versão antiga é recusada (409)", async () => {
    const store = createMemoryAcceptanceStore();
    await store.recordAcceptance({ userId: USER_A.id, terms: "t-1", privacy: "p-1" });
    const { call, accept } = await startLegalApp({ store, documents: docs("t-2", "p-1") });
    assert.equal((await call("GET", "/status", { token: TOKEN_A })).body.accepted, false);
    const stale = await accept(TOKEN_A, docs("t-1", "p-1"));
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "version_mismatch");
    assert.equal(stale.body.documents.terms.version, "t-2");
    assert.equal((await accept(TOKEN_A)).status, 201);
  });

  test("5. versão da Política alterada: aceite antigo deixa de valer", async () => {
    const store = createMemoryAcceptanceStore();
    await store.recordAcceptance({ userId: USER_A.id, terms: "t-1", privacy: "p-1" });
    const { call, accept } = await startLegalApp({ store, documents: docs("t-1", "p-2") });
    assert.equal((await call("GET", "/status", { token: TOKEN_A })).body.accepted, false);
    assert.equal((await accept(TOKEN_A, docs("t-1", "p-1"))).status, 409);
  });

  test("8. contornar pelo frontend: o usuário vem só do token; IDs no corpo são ignorados; versões forjadas recusadas", async () => {
    const { call, store } = await startLegalApp();
    const forged = await call("POST", "/acceptance", {
      token: TOKEN_A,
      body: { termsVersion: "t-1", privacyVersion: "p-1", userId: USER_B.id, discordUserId: USER_B.id },
    });
    assert.equal(forged.status, 201);
    assert.notEqual(await store.findAcceptance(USER_A.id, { terms: "t-1", privacy: "p-1" }), null);
    assert.equal(await store.findAcceptance(USER_B.id, { terms: "t-1", privacy: "p-1" }), null, "o ID do corpo não foi usado");

    assert.equal((await call("POST", "/acceptance", { token: TOKEN_A, body: { termsVersion: "qualquer", privacyVersion: "p-1" } })).status, 409);
    assert.equal((await call("POST", "/acceptance", { token: TOKEN_A, body: { termsVersion: 1, privacyVersion: ["p-1"] } })).status, 400);
    assert.equal((await call("POST", "/acceptance", { token: TOKEN_A, body: {} })).status, 400);
  });

  test("9. não autenticado: sem token ou token inválido → 401, nada é registrado", async () => {
    const { call, store } = await startLegalApp();
    const body = { termsVersion: "t-1", privacyVersion: "p-1" };
    assert.deepEqual((await call("POST", "/acceptance", { body })).body, { error: "auth_required" });
    assert.equal((await call("POST", "/acceptance", { body, headers: { Authorization: "Basic abc" } })).status, 401);
    assert.equal((await call("POST", "/acceptance", { body, headers: { Authorization: `Bearer ${"x".repeat(600)}` } })).status, 401);
    const invalid = await call("POST", "/acceptance", { token: "token-falso", body });
    assert.deepEqual([invalid.status, invalid.body], [401, { error: "invalid_token" }]);
    assert.equal((await call("GET", "/status")).status, 401);
    assert.equal(store.size(), 0);
  });

  test("10. clique duplicado: requisições simultâneas resultam em um único registro", async () => {
    const { accept, store } = await startLegalApp();
    const results = await Promise.all([accept(TOKEN_A), accept(TOKEN_A), accept(TOKEN_A)]);
    assert.ok(results.every((r) => r.body.accepted === true));
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.equal(store.size(), 1);
  });

  test("11. armazenamento indisponível → 503, nunca accepted=true; Discord fora → 503", async () => {
    const { call, accept } = await startLegalApp({ store: createUnavailableAcceptanceStore() });
    assert.deepEqual((await call("GET", "/status", { token: TOKEN_A })).body, { error: "acceptance_unavailable" });
    assert.equal((await accept(TOKEN_A)).status, 503);

    const down = { fetchImpl: async () => new Response("", { status: 502 }) };
    const other = await startLegalApp({ discord: down });
    assert.deepEqual((await other.call("GET", "/status", { token: TOKEN_A })).body, { error: "discord_unavailable" });
  });

  test("limite por usuário: esgotar a cota de um usuário não afeta outro usuário no MESMO IP (proxy do Discord)", async () => {
    const { accept, call } = await startLegalApp({
      routerOptions: { acceptUserRateLimit: { limit: 2, windowMs: 60_000 }, statusUserRateLimit: { limit: 2, windowMs: 60_000 } },
    });
    await accept(TOKEN_A);
    await accept(TOKEN_A);
    const third = await accept(TOKEN_A);
    assert.equal(third.status, 429);
    assert.ok(Number(third.headers.get("retry-after")) >= 1);
    assert.equal((await accept(TOKEN_B)).status, 201, "B, no mesmo IP, continua com a própria cota");

    await call("GET", "/status", { token: TOKEN_A });
    await call("GET", "/status", { token: TOKEN_A });
    assert.equal((await call("GET", "/status", { token: TOKEN_A })).status, 429);
    assert.equal((await call("GET", "/status", { token: TOKEN_B })).status, 200);
  });

  test("teto por IP continua valendo, antes de validar o token (enxurrada com tokens falsos)", async () => {
    const discord = defaultDiscord();
    const { call } = await startLegalApp({ discord, routerOptions: { statusIpRateLimit: { limit: 3, windowMs: 60_000 } } });
    for (let i = 0; i < 3; i += 1) assert.equal((await call("GET", "/status", { token: `falso-${i}` })).status, 401);
    const blocked = await call("GET", "/status", { token: "falso-x" });
    assert.equal(blocked.status, 429);
    assert.equal(discord.calls.length, 3, "a requisição bloqueada não chegou a consultar o Discord");
  });

  test("os tetos padrão por IP comportam muitos usuários atrás do mesmo proxy", async () => {
    const { LEGAL_STATUS_IP_RATE_LIMIT, LEGAL_STATUS_USER_RATE_LIMIT, LEGAL_ACCEPT_IP_RATE_LIMIT, LEGAL_ACCEPT_USER_RATE_LIMIT } = await import(
      "../legal/routes.js"
    );
    assert.ok(LEGAL_STATUS_IP_RATE_LIMIT.limit >= 10 * LEGAL_STATUS_USER_RATE_LIMIT.limit);
    assert.ok(LEGAL_ACCEPT_IP_RATE_LIMIT.limit >= 10 * LEGAL_ACCEPT_USER_RATE_LIMIT.limit);
  });

  test("/api/health informa o tipo de armazenamento (sem valores de configuração)", async () => {
    const store = createMemoryAcceptanceStore();
    const app = createApp({ legalStore: store.kind });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    running.push(async () => {
      app.locals.close();
      await new Promise((resolve) => server.close(resolve));
    });
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/health`)).json();
    assert.equal(body.legalStore, "memory");
  });
});

// ---------------------------------------------------------------------------
// Chat: o servidor exige o aceite antes de entrar na sala
// ---------------------------------------------------------------------------

async function startChat({ store, documents = docs() }) {
  const logger = quietLogger();
  const discord = defaultDiscord();
  const authenticate = createDiscordAuthenticator({ applicationId: APP_ID, botToken: BOT_TOKEN, fetchImpl: discord.fetchImpl, logger });
  const gate = createLegalGate({ store, documents });
  const server = http.createServer();
  const chat = attachChat(server, { authenticate, logger, requireLegalAcceptance: gate.requireAccepted });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  running.push(async () => {
    chat.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return { url: `ws://127.0.0.1:${server.address().port}/api/chat`, chat };
}

/** Conecta e autentica; resolve com { frames, close } quando o servidor fecha ou após "history". */
function connect(url, token) {
  return new Promise((resolve) => {
    const frames = [];
    const ws = new WebSocket(url, { origin: ORIGIN });
    ws.on("error", () => {});
    ws.once("open", () => ws.send(JSON.stringify({ type: "auth", accessToken: token, instanceId: INSTANCE_1 })));
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame.type);
      if (frame.type === "history") {
        ws.close();
        resolve({ frames, close: null });
      }
    });
    ws.once("close", (code, reason) => resolve({ frames, close: { code, reason: reason.toString() } }));
  });
}

describe("chat exige o aceite (validação no servidor)", () => {
  test("7. sem aceite: o WebSocket é fechado com 4003 legal_acceptance_required, sem ready nem histórico", async () => {
    const { url } = await startChat({ store: createMemoryAcceptanceStore() });
    const result = await connect(url, TOKEN_A);
    assert.deepEqual(result.frames, []);
    assert.deepEqual(result.close, { code: 4003, reason: "legal_acceptance_required" });
  });

  test("com aceite das versões atuais: entra na sala normalmente", async () => {
    const store = createMemoryAcceptanceStore();
    await store.recordAcceptance({ userId: USER_A.id, terms: "t-1", privacy: "p-1" });
    const { url } = await startChat({ store });
    const result = await connect(url, TOKEN_A);
    assert.deepEqual(result.frames, ["ready", "history"]);
  });

  test("aceite de versão antiga não libera o chat", async () => {
    const store = createMemoryAcceptanceStore();
    await store.recordAcceptance({ userId: USER_A.id, terms: "t-1", privacy: "p-1" });
    const { url } = await startChat({ store, documents: docs("t-2", "p-1") });
    assert.deepEqual((await connect(url, TOKEN_A)).close, { code: 4003, reason: "legal_acceptance_required" });
  });

  test("armazenamento indisponível: 1013 acceptance_unavailable (tentar de novo), nunca libera", async () => {
    const { url } = await startChat({ store: createUnavailableAcceptanceStore() });
    const result = await connect(url, TOKEN_A);
    assert.deepEqual(result.frames, []);
    assert.deepEqual(result.close, { code: 1013, reason: "acceptance_unavailable" });
  });

  test("token inválido continua recusado antes de qualquer consulta de aceite", async () => {
    let lookups = 0;
    const store = createMemoryAcceptanceStore();
    const spy = { ...store, findAcceptance: async (...args) => ((lookups += 1), store.findAcceptance(...args)) };
    const { url } = await startChat({ store: spy });
    assert.deepEqual((await connect(url, "token-falso")).close, { code: 4001, reason: "invalid_token" });
    assert.equal(lookups, 0);
  });

  test("usuário B com aceite e A sem aceite: cada um tem o próprio resultado", async () => {
    const store = createMemoryAcceptanceStore();
    await store.recordAcceptance({ userId: USER_B.id, terms: "t-1", privacy: "p-1" });
    const { url } = await startChat({ store });
    assert.deepEqual((await connect(url, TOKEN_B)).frames, ["ready", "history"]);
    assert.equal((await connect(url, TOKEN_A)).close.reason, "legal_acceptance_required");
  });
});
