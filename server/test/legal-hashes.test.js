import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.js";
import { createTokenValidator } from "../chat/auth.js";
import { resolveDatabaseConfig } from "../db/config.js";
import { loadMigrations, runMigrations } from "../db/migrate.js";
import { createDbPool } from "../db/pool.js";
import { createMemoryAcceptanceStore, createPostgresAcceptanceStore } from "../legal/acceptance-store.js";
import { LEGAL_DOCUMENT_HASHES, LEGAL_DOCUMENT_VERSIONS, resolveLegalDocuments, SHA256_PATTERN } from "../legal/config.js";
import { createLegalGate } from "../legal/gate.js";
import { createDocumentIntegrity, sha256Hex, verifyPublishedDocuments } from "../legal/integrity.js";
import { createLegalRouter } from "../legal/routes.js";
import { APP_ID, captureLogger, defaultDiscord, TOKEN_A, USER_A, USER_B } from "./helpers/fake-discord.js";
import { startPgServer } from "./helpers/pglite-server.js";

/*
 * Fase 2 — identificação exata (SHA-256) dos documentos aceitos.
 *
 * Cada aceite grava o hash do conteúdo publicado de cada documento. Versões sem hash
 * registrado (rascunhos atuais) continuam gravando NULL: nenhum hash é inventado, e os
 * registros anteriores nunca são alterados.
 */

const HASH_A = sha256Hex(Buffer.from("<html>Termos v1</html>"));
const HASH_B = sha256Hex(Buffer.from("<html>Termos v1 (texto alterado)</html>"));
const HASH_P = sha256Hex(Buffer.from("<html>Privacidade v1</html>"));
const quiet = () => captureLogger().logger;
const withHashes = (terms = HASH_A, privacy = HASH_P) =>
  resolveLegalDocuments({}, { terms: "t-1", privacy: "p-1" }, { terms: { "t-1": terms }, privacy: { "p-1": privacy } });

describe("configuração dos hashes", () => {
  test("registro atual: as versões de rascunho NÃO mudaram e não têm hash (nada inventado)", () => {
    assert.deepEqual(LEGAL_DOCUMENT_VERSIONS, { terms: "2026-11-22-rascunho", privacy: "2026-11-22-rascunho" });
    assert.deepEqual(LEGAL_DOCUMENT_HASHES, { terms: {}, privacy: {} });
    const documents = resolveLegalDocuments({});
    assert.equal(documents.terms.sha256, null);
    assert.equal(documents.privacy.sha256, null);
  });

  test("todo hash registrado tem o formato SHA-256 (64 hex minúsculos)", () => {
    for (const registry of Object.values(LEGAL_DOCUMENT_HASHES)) {
      for (const hash of Object.values(registry)) assert.match(hash, SHA256_PATTERN);
    }
  });

  test("hash registrado entra no documento; hash inválido impede a inicialização", () => {
    const documents = withHashes();
    assert.equal(documents.terms.sha256, HASH_A);
    assert.equal(documents.privacy.sha256, HASH_P);
    for (const bad of ["abc", HASH_A.toUpperCase(), `${HASH_A}0`, 123]) {
      assert.throws(() => resolveLegalDocuments({}, { terms: "t-1", privacy: "p-1" }, { terms: { "t-1": bad }, privacy: {} }), /Hash SHA-256 inválido/);
    }
  });

  test("hash de outra versão não é usado (registro por versão)", () => {
    const documents = resolveLegalDocuments({}, { terms: "t-2", privacy: "p-1" }, { terms: { "t-1": HASH_A }, privacy: {} });
    assert.equal(documents.terms.sha256, null);
  });
});

describe("migration 002 sobre um banco com aceites anteriores (PostgreSQL real)", () => {
  let pg;
  let pool;

  before(async () => {
    pg = await startPgServer();
    pool = createDbPool(resolveDatabaseConfig({ DATABASE_URL: pg.url }), { logger: quiet() });
    // Estado de produção ANTES desta fase: só a migration 001, com aceites gravados.
    const [first] = await loadMigrations();
    assert.equal(first.version, 1);
    assert.deepEqual(await runMigrations(pool, { migrations: [first] }), [1]);
    await pool.query(
      `INSERT INTO legal_acceptances (discord_user_id, terms_version, privacy_version, accepted_at, app_version)
       VALUES ($1, 't-1', 'p-1', '2026-11-22T10:00:00Z', '1.0.0+e10985f'), ($2, 'velha', 'velha', '2026-11-01T09:00:00Z', NULL)`,
      [USER_A.id, USER_B.id],
    );
  });
  after(async () => {
    await pool.end();
    await pg.stop();
  });

  test("aplica só a 002, preserva os registros exatamente e não inventa hashes", async () => {
    const before = await pool.query("SELECT * FROM legal_acceptances ORDER BY discord_user_id");
    assert.deepEqual(await runMigrations(pool), [2]);
    assert.deepEqual(await runMigrations(pool), [], "idempotente");
    const { rows } = await pool.query("SELECT * FROM legal_acceptances ORDER BY discord_user_id");
    assert.equal(rows.length, 2);
    for (const [index, row] of rows.entries()) {
      const old = before.rows[index];
      assert.deepEqual(
        { ...row, terms_sha256: undefined, privacy_sha256: undefined },
        { ...old, terms_sha256: undefined, privacy_sha256: undefined },
        "colunas antigas idênticas",
      );
      assert.equal(row.terms_sha256, null);
      assert.equal(row.privacy_sha256, null);
    }
  });

  test("a garantia de unicidade continua (agora incluindo os hashes) e a chave antiga saiu", async () => {
    const { rows: indexes } = await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'legal_acceptances'");
    assert.deepEqual(indexes.map((i) => i.indexname), ["legal_acceptances_identity"]);
    assert.match(indexes[0].indexdef, /UNIQUE/);
    await assert.rejects(
      pool.query("INSERT INTO legal_acceptances (discord_user_id, terms_version, privacy_version) VALUES ($1, 't-1', 'p-1')", [USER_A.id]),
      (error) => error.code === "23505",
      "mesmo usuário, versões e hashes (NULL) continua duplicado",
    );
    await assert.rejects(
      pool.query("INSERT INTO legal_acceptances (discord_user_id, terms_version, privacy_version, terms_sha256) VALUES ($1, 't-1', 'p-1', 'XYZ')", [USER_A.id]),
      (error) => error.code === "23514",
      "o banco recusa hash fora do formato",
    );
  });

  test("aceite antigo (sem hash) só vale enquanto a versão não tiver hash; com hash, exige novo aceite sem tocar no antigo", async () => {
    const store = createPostgresAcceptanceStore({ pool, logger: quiet() });
    const noHash = createLegalGate({ store, documents: resolveLegalDocuments({}, { terms: "t-1", privacy: "p-1" }) });
    assert.ok(await noHash.findCurrent(USER_A.id), "mesma situação de quando aceitou: continua valendo");

    const hashed = createLegalGate({ store, documents: withHashes() });
    assert.equal(await hashed.findCurrent(USER_A.id), null, "documento identificado por hash ≠ aceite sem hash");

    const result = await hashed.accept(USER_A.id, "1.0.0+test");
    assert.equal(result.created, true);
    assert.ok(await hashed.findCurrent(USER_A.id));

    const { rows } = await pool.query(
      "SELECT terms_sha256, privacy_sha256, app_version, accepted_at FROM legal_acceptances WHERE discord_user_id = $1 ORDER BY accepted_at",
      [USER_A.id],
    );
    assert.equal(rows.length, 2, "o registro antigo continua lá");
    assert.deepEqual([rows[0].terms_sha256, rows[0].app_version], [null, "1.0.0+e10985f"]);
    assert.deepEqual([rows[1].terms_sha256, rows[1].privacy_sha256], [HASH_A, HASH_P]);
  });

  test("mesmo rótulo de versão com conteúdo diferente é outro documento: novo registro", async () => {
    const store = createPostgresAcceptanceStore({ pool, logger: quiet() });
    const changed = createLegalGate({ store, documents: withHashes(HASH_B) });
    assert.equal(await changed.findCurrent(USER_A.id), null);
    assert.equal((await changed.accept(USER_A.id, null)).created, true);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM legal_acceptances WHERE discord_user_id = $1", [USER_A.id]);
    assert.equal(rows[0].n, 3);
  });

  test("cliques simultâneos com hash: um único registro", async () => {
    const store = createPostgresAcceptanceStore({ pool, logger: quiet() });
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.recordAcceptance({ userId: USER_B.id, terms: "t-1", privacy: "p-1", termsSha256: HASH_A, privacySha256: HASH_P })),
    );
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.acceptedAt)).size, 1);
  });

  test("o armazenamento recusa hash malformado antes de consultar o banco", async () => {
    const store = createPostgresAcceptanceStore({ pool, logger: quiet() });
    await assert.rejects(store.recordAcceptance({ userId: USER_B.id, terms: "t-1", privacy: "p-1", termsSha256: "nao-e-hash" }), TypeError);
    await assert.rejects(store.findAcceptance(USER_B.id, { terms: "t-1", privacy: "p-1", privacySha256: 42 }), TypeError);
  });
});

describe("rotas /api/legal com hashes", () => {
  const running = [];
  afterEach(async () => {
    for (const stop of running.splice(0)) await stop();
  });

  async function start({ documents = withHashes(), integrity } = {}) {
    const logger = quiet();
    const discord = defaultDiscord();
    const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl: discord.fetchImpl, logger });
    const store = createMemoryAcceptanceStore();
    const gate = createLegalGate({ store, documents });
    const router = createLegalRouter({ validateToken: (t) => tokens.validate(t), gate, documents, logger, ...(integrity && { integrity }) });
    const app = createApp({ logger, legalRouter: router });
    const server = http.createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    running.push(async () => {
      router.close();
      app.locals.close();
      await new Promise((resolve) => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/legal`;
    const call = async (method, p, body) => {
      const res = await fetch(`${base}${p}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN_A}`, ...(body && { "Content-Type": "application/json" }) },
        body: body && JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };
    return { call, store, gate };
  }

  test("status informa o sha256 de cada documento", async () => {
    const { call } = await start();
    const { body } = await call("GET", "/status");
    assert.equal(body.documents.terms.sha256, HASH_A);
    assert.equal(body.documents.privacy.sha256, HASH_P);
  });

  test("aceite com os hashes exibidos: grava o hash; hash diferente → 409 com os documentos atuais; malformado → 400", async () => {
    const { call, gate } = await start();
    const base = { termsVersion: "t-1", privacyVersion: "p-1" };
    const wrong = await call("POST", "/acceptance", { ...base, termsSha256: HASH_B, privacySha256: HASH_P });
    assert.equal(wrong.status, 409);
    assert.equal(wrong.body.documents.terms.sha256, HASH_A);
    assert.equal((await call("POST", "/acceptance", { ...base, termsSha256: "abc" })).status, 400);
    assert.equal(await gate.findCurrent(USER_A.id), null, "nada registrado");

    const ok = await call("POST", "/acceptance", { ...base, termsSha256: HASH_A, privacySha256: HASH_P });
    assert.equal(ok.status, 201);
    assert.ok(await gate.findCurrent(USER_A.id));
  });

  test("cliente antigo (sem enviar hashes): o servidor grava os hashes atuais", async () => {
    const { call, store } = await start();
    assert.equal((await call("POST", "/acceptance", { termsVersion: "t-1", privacyVersion: "p-1" })).status, 201);
    assert.ok(await store.findAcceptance(USER_A.id, { terms: "t-1", privacy: "p-1", termsSha256: HASH_A, privacySha256: HASH_P }));
  });

  test("versão sem hash: o cliente pode enviar null; enviar um hash inexistente é recusado", async () => {
    const { call } = await start({ documents: resolveLegalDocuments({}, { terms: "t-1", privacy: "p-1" }) });
    assert.equal((await call("POST", "/acceptance", { termsVersion: "t-1", privacyVersion: "p-1", termsSha256: HASH_A })).status, 409);
    assert.equal((await call("POST", "/acceptance", { termsVersion: "t-1", privacyVersion: "p-1", termsSha256: null, privacySha256: null })).status, 201);
  });

  test("documento publicado diferente do hash registrado: novos aceites bloqueados (503); o status continua respondendo", async () => {
    const integrity = createDocumentIntegrity();
    integrity.apply({ terms: "mismatch", privacy: "ok" });
    const { call, gate } = await start({ integrity });
    const res = await call("POST", "/acceptance", { termsVersion: "t-1", privacyVersion: "p-1", termsSha256: HASH_A, privacySha256: HASH_P });
    assert.deepEqual([res.status, res.body], [503, { error: "documents_unverified" }]);
    assert.equal(await gate.findCurrent(USER_A.id), null);
    assert.equal((await call("GET", "/status")).status, 200);
  });
});

describe("conferência do conteúdo publicado", () => {
  const fetchReturning = (bodies) => {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(url);
      const body = bodies[url];
      if (body instanceof Error) throw body;
      return body === undefined ? new Response("", { status: 404 }) : new Response(body, { status: 200 });
    };
    return { fetchImpl, calls };
  };
  const docsAt = () =>
    resolveLegalDocuments(
      { LEGAL_TERMS_URL: "https://docs.exemplo.test/terms.html", LEGAL_PRIVACY_URL: "https://docs.exemplo.test/privacy.html" },
      { terms: "t-1", privacy: "p-1" },
      { terms: { "t-1": HASH_A }, privacy: { "p-1": HASH_P } },
    );

  test("bytes publicados iguais ao hash → ok; diferentes → mismatch (bloqueia); fora do ar → unreachable (não bloqueia)", async () => {
    const { logger, lines } = captureLogger();
    const ok = fetchReturning({ "https://docs.exemplo.test/terms.html": "<html>Termos v1</html>", "https://docs.exemplo.test/privacy.html": "<html>Privacidade v1</html>" });
    const integrity = createDocumentIntegrity();
    assert.deepEqual(integrity.apply(await verifyPublishedDocuments(docsAt(), { fetchImpl: ok.fetchImpl, logger })), { terms: "ok", privacy: "ok" });
    assert.equal(integrity.blocked(), false);

    const changed = fetchReturning({ "https://docs.exemplo.test/terms.html": "<html>Termos v1 (editado)</html>", "https://docs.exemplo.test/privacy.html": new Error("rede") });
    assert.deepEqual(integrity.apply(await verifyPublishedDocuments(docsAt(), { fetchImpl: changed.fetchImpl, logger })), { terms: "mismatch", privacy: "unreachable" });
    assert.equal(integrity.blocked(), true);

    const down = fetchReturning({});
    assert.deepEqual(integrity.apply(await verifyPublishedDocuments(docsAt(), { fetchImpl: down.fetchImpl, logger })), { terms: "unreachable", privacy: "unreachable" });
    assert.equal(integrity.blocked(), false, "falha de rede não bloqueia: vale o hash registrado");
    assert.ok(!lines.join("\n").includes("Termos v1"), "o log não traz o conteúdo");
  });

  test("versões sem hash registrado: nada é baixado", async () => {
    const spy = fetchReturning({});
    const result = await verifyPublishedDocuments(resolveLegalDocuments({}), { fetchImpl: spy.fetchImpl, logger: quiet() });
    assert.deepEqual(result, { terms: "no_hash", privacy: "no_hash" });
    assert.equal(spy.calls.length, 0);
  });
});

describe("npm run legal:hash", () => {
  test("calcula o SHA-256 dos bytes exatos do arquivo (sem alterá-lo)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "legal-hash-"));
    try {
      const file = path.join(dir, "termos.html");
      const content = "<!doctype html>\r\n<p>Olá — termos</p>\n";
      await writeFile(file, content);
      const script = fileURLToPath(new URL("../scripts/legal-hash.mjs", import.meta.url));
      const child = spawn(process.execPath, [script, file], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      const [code] = await once(child, "exit");
      assert.equal(code, 0);
      assert.match(out, new RegExp(`^${createHash("sha256").update(Buffer.from(content)).digest("hex")}  `));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
