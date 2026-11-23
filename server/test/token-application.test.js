import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import { createApp, SECURITY_HEADERS } from "../app.js";
import { createTokenValidator, REQUIRED_SCOPE, tokenCacheKey } from "../chat/auth.js";
import { createDiscordAuthenticator } from "../chat/authenticator.js";
import { CloseCode } from "../chat/config.js";
import { ChatCloseError } from "../chat/errors.js";
import { attachChat } from "../chat/index.js";
import { createMemoryAcceptanceStore } from "../legal/acceptance-store.js";
import { createLegalGate } from "../legal/gate.js";
import { createLegalRouter } from "../legal/routes.js";
import {
  APP_ID,
  authorizationInfo,
  BOT_TOKEN,
  captureLogger,
  createFakeFetch,
  INSTANCE_1,
  json,
  OAUTH_ME_PATH,
  TOKEN_A,
  USER_A,
} from "./helpers/fake-discord.js";

/*
 * Fase 1 da auditoria pré-lançamento.
 *
 * A1 — o token precisa ter sido emitido para ESTA aplicação (GET /oauth2/@me →
 * application.id) e ter o escopo "identify". Vale para o validador compartilhado e,
 * portanto, para as rotas /api/legal e para o WebSocket do chat.
 * B4 — cabeçalhos de segurança e 404 em JSON em todas as respostas HTTP do backend.
 */

const OTHER_APP_ID = "999999999999999999";
const TOKEN_OTHER_APP = "fake-token-of-another-app";
const TOKEN_NO_IDENTIFY = "fake-token-without-identify";
const TOKEN_EXPIRED = "fake-token-expired";
const TOKEN_REVOKED = "fake-token-revoked";
const TOKEN_SHORT = "fake-token-expires-soon";
const ORIGIN = "http://localhost:5173";

function clock(start = Date.parse("2026-11-22T12:00:00.000Z")) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** Discord simulado com um token para cada cenário. */
function scenarioDiscord(time = clock()) {
  // Vencimentos fixos, como num token real (não se renovam a cada consulta).
  const expired = new Date(time.now() - 1_000).toISOString();
  const expiresSoon = new Date(time.now() + 5_000).toISOString();
  return createFakeFetch(({ path, authorization }) => {
    if (path === OAUTH_ME_PATH) {
      switch (authorization) {
        case `Bearer ${TOKEN_A}`:
          return json(200, authorizationInfo(USER_A));
        case `Bearer ${TOKEN_OTHER_APP}`:
          return json(200, authorizationInfo(USER_A, { applicationId: OTHER_APP_ID }));
        case `Bearer ${TOKEN_NO_IDENTIFY}`:
          return json(200, authorizationInfo(USER_A, { scopes: ["guilds"] }));
        case `Bearer ${TOKEN_EXPIRED}`:
          // Defesa extra: mesmo que o Discord respondesse 200, o vencimento no passado é recusado.
          return json(200, authorizationInfo(USER_A, { expires: expired }));
        case `Bearer ${TOKEN_SHORT}`:
          return json(200, authorizationInfo(USER_A, { expires: expiresSoon }));
        default:
          // Token inexistente, revogado ou vencido: o Discord responde 401.
          return json(401, { message: "401: Unauthorized", code: 0 });
      }
    }
    if (path.startsWith(`/api/v10/applications/${APP_ID}/activity-instances/`) && authorization === `Bot ${BOT_TOKEN}`) {
      return json(200, { application_id: APP_ID, instance_id: INSTANCE_1, users: [USER_A.id] });
    }
    return json(404, { message: "Unknown" });
  });
}

async function rejectsWith(promise, closeCode, reason) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof ChatCloseError, `esperado ChatCloseError, recebido ${error}`);
    assert.deepEqual({ closeCode: error.closeCode, reason: error.reason }, { closeCode, reason });
    return true;
  });
}

describe("A1 — validador: aplicação de origem e escopo do token", () => {
  test("token válido desta aplicação com identify: identidade vem do Discord, por /oauth2/@me", async () => {
    const { fetchImpl, calls } = scenarioDiscord();
    const user = await createTokenValidator({ applicationId: APP_ID, fetchImpl }).validate(TOKEN_A);
    assert.equal(user.id, USER_A.id);
    assert.equal(user.displayName, "Ana");
    assert.deepEqual(calls.map((c) => c.url), ["https://discord.com/api/v10/oauth2/@me"]);
    assert.equal(calls[0].authorization, `Bearer ${TOKEN_A}`);
    assert.equal(REQUIRED_SCOPE, "identify");
  });

  test("token válido de OUTRA aplicação: recusado como inválido, entra no cache negativo, log sem token nem IDs", async () => {
    const { fetchImpl, calls } = scenarioDiscord();
    const { logger, lines } = captureLogger();
    const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl, logger });
    await rejectsWith(tokens.validate(TOKEN_OTHER_APP), CloseCode.UNAUTHORIZED, "invalid_token");
    await rejectsWith(tokens.validate(TOKEN_OTHER_APP), CloseCode.UNAUTHORIZED, "invalid_token");
    assert.equal(calls.length, 1, "a segunda tentativa não consulta o Discord");
    assert.deepEqual(tokens.invalidKeys(), [tokenCacheKey(TOKEN_OTHER_APP)]);
    assert.equal(tokens.size(), 0, "nada entra no cache positivo");
    assert.deepEqual(lines, ["[auth] token emitido para outra aplicação recusado."]);
    for (const secret of [TOKEN_OTHER_APP, OTHER_APP_ID, APP_ID, USER_A.id]) assert.ok(!lines.join("\n").includes(secret));
  });

  test("token sem o escopo identify: recusado como inválido", async () => {
    const { fetchImpl } = scenarioDiscord();
    const { logger, lines } = captureLogger();
    const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl, logger });
    await rejectsWith(tokens.validate(TOKEN_NO_IDENTIFY), CloseCode.UNAUTHORIZED, "invalid_token");
    assert.deepEqual(lines, ['[auth] token sem o escopo "identify" recusado.']);
  });

  test("token inválido ou revogado (401 do Discord): recusado, sem log", async () => {
    const { fetchImpl } = scenarioDiscord();
    const { logger, lines } = captureLogger();
    await rejectsWith(createTokenValidator({ applicationId: APP_ID, fetchImpl, logger }).validate(TOKEN_REVOKED), CloseCode.UNAUTHORIZED, "invalid_token");
    assert.deepEqual(lines, []);
  });

  test("token vencido: recusado mesmo que a resposta viesse com 200", async () => {
    const time = clock();
    const { fetchImpl } = scenarioDiscord(time);
    await rejectsWith(createTokenValidator({ applicationId: APP_ID, fetchImpl, now: time.now }).validate(TOKEN_EXPIRED), CloseCode.UNAUTHORIZED, "invalid_token");
  });

  test("o cache positivo nunca passa do vencimento do token", async () => {
    const time = clock();
    const { fetchImpl, calls } = scenarioDiscord(time);
    const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl, now: time.now, ttlMs: 60_000 });
    await tokens.validate(TOKEN_SHORT);
    time.advance(4_000);
    await tokens.validate(TOKEN_SHORT);
    assert.equal(calls.length, 1, "ainda dentro do vencimento: cache");
    time.advance(1_500); // passou do `expires` (5 s), bem antes do TTL de 60 s
    await rejectsWith(tokens.validate(TOKEN_SHORT), CloseCode.UNAUTHORIZED, "invalid_token");
    assert.equal(calls.length, 2, "consultou de novo e recusou o vencido");
  });

  test("sem applicationId configurado: recusa tudo (1011 server_misconfigured) sem chamar o Discord", async () => {
    const { fetchImpl, calls } = scenarioDiscord();
    for (const applicationId of [null, undefined, ""]) {
      await rejectsWith(createTokenValidator({ applicationId, fetchImpl }).validate(TOKEN_A), CloseCode.INTERNAL_ERROR, "server_misconfigured");
    }
    assert.equal(calls.length, 0);
  });

  test("resposta 200 malformada (sem application/escopos, ou usuário inválido): indisponível, nunca aceita", async () => {
    for (const body of [{}, { application: {}, scopes: ["identify"], user: USER_A }, { application: { id: APP_ID }, scopes: "identify", user: USER_A }, authorizationInfo({ id: "abc", username: "x" })]) {
      const { fetchImpl } = createFakeFetch(() => json(200, body));
      await rejectsWith(
        createTokenValidator({ applicationId: APP_ID, fetchImpl, logger: captureLogger().logger }).validate(TOKEN_A),
        CloseCode.TRY_AGAIN_LATER,
        "discord_unavailable",
      );
    }
  });

  test("cache, chamadas simultâneas e teto global continuam valendo com /oauth2/@me", async () => {
    const { fetchImpl, calls } = scenarioDiscord();
    const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl, validationRateLimit: { limit: 2, windowMs: 10_000 }, logger: captureLogger().logger });
    await Promise.all(Array.from({ length: 5 }, () => tokens.validate(TOKEN_A)));
    assert.equal(calls.length, 1, "uma consulta para 5 chamadas simultâneas");
    await tokens.validate(TOKEN_A);
    assert.equal(calls.length, 1, "cache positivo");
    await assert.rejects(tokens.validate("fake-1"));
    await rejectsWith(tokens.validate("fake-2"), CloseCode.TRY_AGAIN_LATER, "discord_unavailable");
    assert.equal(calls.length, 2, "o teto (2 por janela) barrou a terceira consulta");
  });
});

// ---------------------------------------------------------------------------
// Uso nas rotas /api/legal e no WebSocket
// ---------------------------------------------------------------------------

const running = [];
afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
});

const DOCS = { terms: { version: "t-1", url: "https://exemplo.test/terms.html" }, privacy: { version: "p-1", url: "https://exemplo.test/privacy.html" } };

async function startBackend({ applicationId = APP_ID } = {}) {
  const { logger } = captureLogger();
  const discord = scenarioDiscord();
  const tokens = createTokenValidator({ applicationId, fetchImpl: discord.fetchImpl, logger });
  const store = createMemoryAcceptanceStore();
  const gate = createLegalGate({ store, documents: DOCS });
  const router = createLegalRouter({ validateToken: (token) => tokens.validate(token), gate, documents: DOCS, logger });
  const app = createApp({ clientId: APP_ID, clientSecret: "fake-secret", logger, legalRouter: router, legalStore: "memory" });
  const server = http.createServer(app);
  const authenticate = createDiscordAuthenticator({ applicationId: APP_ID, botToken: BOT_TOKEN, fetchImpl: discord.fetchImpl, logger, tokens });
  const chat = attachChat(server, { authenticate, logger, requireLegalAcceptance: gate.requireAccepted });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  running.push(async () => {
    chat.close();
    router.close();
    app.locals.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, { token, body } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token && { Authorization: `Bearer ${token}` }), ...(body && { "Content-Type": "application/json" }) },
      body: body && JSON.stringify(body),
    });
    return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) };
  };
  return { base, call, store, discord, wsUrl: `ws://127.0.0.1:${server.address().port}/api/chat` };
}

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

const accept = { termsVersion: "t-1", privacyVersion: "p-1" };

describe("A1 — rotas /api/legal e WebSocket usam a validação da aplicação", () => {
  test("rotas legais: token de outra aplicação ou sem identify → 401 e NADA é registrado", async () => {
    const { call, store } = await startBackend();
    for (const token of [TOKEN_OTHER_APP, TOKEN_NO_IDENTIFY, TOKEN_EXPIRED, TOKEN_REVOKED]) {
      assert.deepEqual((await call("GET", "/api/legal/status", { token })).status, 401, token);
      const res = await call("POST", "/api/legal/acceptance", { token, body: accept });
      assert.deepEqual([res.status, res.body], [401, { error: "invalid_token" }], token);
    }
    assert.equal(await store.findAcceptance(USER_A.id, { terms: "t-1", privacy: "p-1" }), null, "nenhum aceite forjado");

    const ok = await call("POST", "/api/legal/acceptance", { token: TOKEN_A, body: accept });
    assert.equal(ok.status, 201, "o token legítimo desta aplicação continua funcionando");
  });

  test("rotas legais sem Client ID configurado: 503 server_misconfigured, sem chamar o Discord", async () => {
    const { call, discord } = await startBackend({ applicationId: null });
    const res = await call("GET", "/api/legal/status", { token: TOKEN_A });
    assert.deepEqual([res.status, res.body], [503, { error: "server_misconfigured" }]);
    assert.equal(discord.calls.length, 0);
  });

  test("WebSocket: token de outra aplicação → 4001 invalid_token, sem entrar na sala; o legítimo entra", async () => {
    const { wsUrl, call } = await startBackend();
    for (const token of [TOKEN_OTHER_APP, TOKEN_NO_IDENTIFY]) {
      assert.deepEqual(await connect(wsUrl, token), { frames: [], close: { code: 4001, reason: "invalid_token" } }, token);
    }
    await call("POST", "/api/legal/acceptance", { token: TOKEN_A, body: accept });
    assert.deepEqual((await connect(wsUrl, TOKEN_A)).frames, ["ready", "history"]);
  });

  test("server.js e o autenticador repassam o Client ID ao validador", async () => {
    const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
    assert.match(source, /createTokenValidator\(\{ applicationId: clientId, gate: retryGate \}\)/);
    const authenticator = await readFile(new URL("../chat/authenticator.js", import.meta.url), "utf8");
    assert.match(authenticator, /createTokenValidator\(\{ applicationId, /);
  });
});

// ---------------------------------------------------------------------------
// B4 — cabeçalhos de segurança e 404 em JSON
// ---------------------------------------------------------------------------

function assertSecurityHeaders(headers, where) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) assert.equal(headers.get(name), value, `${where}: ${name}`);
  assert.equal(headers.get("x-powered-by"), null, `${where}: X-Powered-By`);
  assert.equal(headers.get("etag"), null, `${where}: ETag`);
  assert.equal(headers.get("access-control-allow-origin"), null, `${where}: sem CORS`);
}

describe("B4 — cabeçalhos e respostas 404", () => {
  test("cabeçalhos definidos: nosniff, no-store, CSP restritiva, sem iframe, sem referrer", () => {
    assert.deepEqual(SECURITY_HEADERS, {
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
  });

  test("todas as respostas trazem os cabeçalhos: health, token (inclusive erros), rotas legais, 404 e JSON inválido", async () => {
    const { base, call } = await startBackend();
    const cases = [
      ["GET /api/health", await call("GET", "/api/health")],
      ["POST /api/token sem code", await call("POST", "/api/token", { body: {} })],
      ["GET /api/legal/status sem token", await call("GET", "/api/legal/status")],
      ["GET /api/legal/status com token", await call("GET", "/api/legal/status", { token: TOKEN_A })],
      ["GET /api/nao-existe", await call("GET", "/api/nao-existe")],
    ];
    const invalid = await fetch(`${base}/api/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{x" });
    cases.push(["JSON inválido", { status: invalid.status, headers: invalid.headers }]);
    for (const [where, res] of cases) assertSecurityHeaders(res.headers, where);
    assert.equal(invalid.status, 400);
  });

  test("404 em JSON para caminho, método e prefixo desconhecidos, sem a página do Express", async () => {
    const { base } = await startBackend();
    for (const [method, path] of [
      ["GET", "/api/nao-existe"],
      ["GET", "/api/token"],
      ["DELETE", "/api/health"],
      ["GET", "/api/legal/outra"],
      ["PUT", "/api/legal/acceptance"],
      ["GET", "/"],
      ["GET", "/index.html"],
    ]) {
      const res = await fetch(`${base}${path}`, { method });
      const text = await res.text();
      assert.equal(res.status, 404, `${method} ${path}`);
      assert.match(res.headers.get("content-type") ?? "", /^application\/json/, `${method} ${path}`);
      assert.deepEqual(JSON.parse(text), { error: "not_found" }, `${method} ${path}`);
      assert.doesNotMatch(text, /Cannot|Express|<html/i);
    }
  });

  test("as rotas existentes continuam respondendo como antes", async () => {
    const { call } = await startBackend();
    assert.deepEqual((await call("GET", "/api/health")).body, { ok: true, oauthConfigured: true, chatConfigured: false, legalStore: "memory" });
    assert.deepEqual((await call("GET", "/api/legal/status")).body, { error: "auth_required" });
    assert.equal((await call("POST", "/api/token", { body: {} })).status, 400);
  });
});
