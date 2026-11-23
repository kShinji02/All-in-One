import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createTokenValidator, tokenCacheKey } from "../chat/auth.js";
import { CloseCode, INVALID_TOKEN_CACHE_TTL_MS, MEMBERSHIP_REVALIDATE_MS, TOKEN_CACHE_TTL_MS } from "../chat/config.js";
import { ChatCloseError } from "../chat/errors.js";
import { attachChat } from "../chat/index.js";
import { isAllowedOrigin, parseExtraOrigins, resolveOriginProfile } from "../chat/origin.js";
import { APP_ID, authorizationInfo, createFakeFetch, defaultDiscord, json, TOKEN_A, USER_A } from "./helpers/fake-discord.js";

/*
 * Fase 4.9 — origens por ambiente e cache de tokens OAuth.
 */

const CLIENT_ID = "123456789012345678";
const DISCORD = `https://${CLIENT_ID}.discordsays.com`;
const TUNNEL = "https://critical-purchasing-reducing-urw.trycloudflare.com";

describe("origens: perfis local, tunnel e production", () => {
  const allowed = (origin, profile, extraOrigins) => isAllowedOrigin(origin, { discordClientId: CLIENT_ID, profile, extraOrigins });

  test("production aceita SOMENTE o discordsays.com da aplicação", () => {
    assert.equal(allowed(DISCORD, "production"), true);
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:3001", "http://[::1]:5173", "https://localhost", TUNNEL]) {
      assert.equal(allowed(origin, "production"), false, origin);
    }
  });

  test("production com origens extras: só a origem exata listada", () => {
    const extra = ["https://app.exemplo.com"];
    assert.equal(allowed("https://app.exemplo.com", "production", extra), true);
    for (const origin of ["https://exemplo.com", "https://x.app.exemplo.com", "http://app.exemplo.com", "https://app.exemplo.com:8443"]) {
      assert.equal(allowed(origin, "production", extra), false, origin);
    }
  });

  test("local aceita localhost e o Discord, mas não o túnel", () => {
    assert.equal(allowed("http://localhost:5173", "local"), true);
    assert.equal(allowed("http://127.0.0.1:3001", "local"), true);
    assert.equal(allowed(DISCORD, "local"), true);
    assert.equal(allowed(TUNNEL, "local"), false);
  });

  test("tunnel (padrão do desenvolvimento atual) aceita local, Discord e Quick Tunnel", () => {
    for (const origin of ["http://localhost:5173", DISCORD, TUNNEL, "https://novo.trycloudflare.com"]) {
      assert.equal(allowed(origin, "tunnel"), true, origin);
      assert.equal(isAllowedOrigin(origin, { discordClientId: CLIENT_ID }), true, `${origin} sem perfil explícito`);
    }
  });

  test("subdomínios e variações inesperadas são recusados em todos os perfis", () => {
    const hostile = [
      `https://evil.${CLIENT_ID}.discordsays.com`,
      `https://${CLIENT_ID}.discordsays.com.evil.com`,
      `https://${CLIENT_ID}.discordsays.com:8443`,
      `https://999${CLIENT_ID}.discordsays.com`,
      "https://a.b.trycloudflare.com",
      "https://-inicio.trycloudflare.com",
      "https://fim-.trycloudflare.com",
      "https://trycloudflare.com",
      "https://novo.trycloudflare.com:444",
      "https://novo.trycloudflare.com.evil.com",
      "https://localhost.evil.com",
      `${DISCORD}/caminho`,
      `${DISCORD}?q=1`,
    ];
    for (const profile of ["production", "local", "tunnel"]) {
      for (const origin of hostile) assert.equal(allowed(origin, profile), false, `${profile}: ${origin}`);
    }
  });

  test("resolveOriginProfile: NODE_ENV=production restringe; desenvolvimento mantém o túnel", () => {
    assert.equal(resolveOriginProfile({ NODE_ENV: "production" }), "production");
    assert.equal(resolveOriginProfile({}), "tunnel");
    assert.equal(resolveOriginProfile({ NODE_ENV: "development" }), "tunnel");
    assert.equal(resolveOriginProfile({ ORIGIN_PROFILE: "local", NODE_ENV: "production" }), "local");
    assert.throws(() => resolveOriginProfile({ ORIGIN_PROFILE: "qualquer" }), /ORIGIN_PROFILE inválido/);
  });

  test("parseExtraOrigins: só origens HTTPS exatas", () => {
    assert.deepEqual(parseExtraOrigins(undefined), []);
    assert.deepEqual(parseExtraOrigins(" https://a.com , https://b.com "), ["https://a.com", "https://b.com"]);
    for (const raw of ["http://a.com", "https://*.a.com", "https://a.com/caminho", "nao-e-url"]) {
      assert.throws(() => parseExtraOrigins(raw), /CHAT_EXTRA_ORIGINS/, raw);
    }
  });
});

describe("origens: upgrade real do WebSocket (attachChat)", () => {
  const servers = [];
  afterEach(async () => {
    for (const { server, chat } of servers.splice(0)) {
      chat.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  async function start(options) {
    const server = http.createServer();
    const chat = attachChat(server, {
      discordClientId: CLIENT_ID,
      authenticate: async () => {
        throw new ChatCloseError(CloseCode.UNAUTHORIZED, "invalid_token");
      },
      logger: { error() {}, warn() {} },
      ...options,
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    servers.push({ server, chat });
    return `ws://127.0.0.1:${server.address().port}/api/chat`;
  }

  /** "open" se o upgrade foi aceito; o status HTTP se foi recusado. */
  const upgrade = (url, origin) =>
    new Promise((resolve) => {
      const ws = new WebSocket(url, { origin });
      ws.once("open", () => {
        ws.terminate();
        resolve("open");
      });
      ws.once("unexpected-response", (_req, res) => {
        resolve(res.statusCode);
        ws.terminate();
      });
      ws.once("error", () => undefined);
    });

  test("production: Discord aceito; localhost e túnel recebem 403", async () => {
    const url = await start({ originProfile: "production" });
    assert.equal(await upgrade(url, DISCORD), "open");
    assert.equal(await upgrade(url, "http://localhost:5173"), 403);
    assert.equal(await upgrade(url, TUNNEL), 403);
  });

  test("padrão (tunnel): desenvolvimento atual continua funcionando", async () => {
    const url = await start({});
    assert.equal(await upgrade(url, "http://localhost:5173"), "open");
    assert.equal(await upgrade(url, TUNNEL), "open");
    assert.equal(await upgrade(url, DISCORD), "open");
    assert.equal(await upgrade(url, "https://a.b.trycloudflare.com"), 403);
  });
});

describe("cache de tokens OAuth", () => {
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms) => (t += ms) };
  }

  test("TTL padrão de 60 s, igual à revalidação dos membros", () => {
    assert.equal(TOKEN_CACHE_TTL_MS, 60_000);
    assert.equal(TOKEN_CACHE_TTL_MS, MEMBERSHIP_REVALIDATE_MS);
  });

  test("reutilização: dentro do TTL padrão, uma única chamada ao Discord", async () => {
    const { fetchImpl, calls } = defaultDiscord();
    const time = clock();
    const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl, now: time.now });
    await tokens.validate(TOKEN_A);
    time.advance(TOKEN_CACHE_TTL_MS - 1);
    await tokens.validate(TOKEN_A);
    assert.equal(calls.length, 1);
  });

  test("expiração: token revogado deixa de ser aceito assim que o cache expira", async () => {
    let revoked = false;
    const { fetchImpl, calls } = createFakeFetch(() => (revoked ? json(401, { message: "401: Unauthorized" }) : json(200, authorizationInfo(USER_A))));
    const time = clock();
    const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl, now: time.now });
    await tokens.validate(TOKEN_A);

    revoked = true; // o usuário revoga o acesso da aplicação no Discord
    time.advance(TOKEN_CACHE_TTL_MS);
    await assert.rejects(tokens.validate(TOKEN_A), (error) => error instanceof ChatCloseError && error.reason === "invalid_token");
    assert.equal(calls.length, 2);
    assert.equal(tokens.size(), 0, "a entrada expirada saiu do cache");
  });

  // Fase 5.1: o 401 fica em cache negativo por INVALID_TOKEN_CACHE_TTL_MS e depois expira.
  test("invalidação de respostas negativas: 401 fica em cache só pelo TTL curto e depois consulta de novo", async () => {
    let valid = false;
    const { fetchImpl, calls } = createFakeFetch(() => (valid ? json(200, authorizationInfo(USER_A)) : json(401, { message: "401: Unauthorized" })));
    const time = clock();
    const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl, now: time.now });
    await assert.rejects(tokens.validate(TOKEN_A));
    valid = true;
    time.advance(INVALID_TOKEN_CACHE_TTL_MS - 1);
    await assert.rejects(tokens.validate(TOKEN_A), (error) => error.reason === "invalid_token");
    assert.equal(calls.length, 1, "dentro do TTL o Discord não é consultado");
    time.advance(1);
    await tokens.validate(TOKEN_A);
    assert.equal(calls.length, 2);
    assert.deepEqual(tokens.invalidKeys(), [], "a entrada vencida saiu do cache negativo");
  });

  test("chamadas simultâneas com o mesmo token compartilham uma única consulta", async () => {
    const { fetchImpl, calls } = defaultDiscord();
    const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl });
    await Promise.all(Array.from({ length: 10 }, () => tokens.validate(TOKEN_A)));
    assert.equal(calls.length, 1);
  });

  test("o cache guarda só o hash do token, nunca o token", async () => {
    const { fetchImpl } = defaultDiscord();
    const tokens = createTokenValidator({ applicationId: APP_ID, fetchImpl });
    await tokens.validate(TOKEN_A);
    assert.deepEqual(tokens.keys(), [tokenCacheKey(TOKEN_A)]);
    assert.ok(!tokens.keys().some((key) => key.includes(TOKEN_A)));
  });
});
