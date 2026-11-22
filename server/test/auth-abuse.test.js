/*
 * Fase 5.1 — abuso na autenticação do WebSocket.
 *
 * Servidor REAL (attachChat + createDiscordAuthenticator) com o Discord simulado; nenhum
 * segredo real. O relógio dos limitadores é injetado, então janelas e bloqueios "passam"
 * sem espera real. Vários IPs são simulados com X-Forwarded-For atrás de um proxy
 * confiável (loopback), exatamente como TRUST_PROXY faria em produção.
 */
import { test, afterEach, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { setImmediate as tick } from "node:timers/promises";
import express from "express";
import { WebSocket } from "ws";
import { attachChat } from "../chat/index.js";
import { createDiscordAuthenticator } from "../chat/authenticator.js";
import { clientIp, TRUST_NONE } from "../chat/client-ip.js";
import { createRetryGate, parseRateLimit } from "../chat/discord-api.js";
import { createSlidingWindowLimiter } from "../chat/rate-limit.js";
import {
  AUTH_FAILURE_LIMIT,
  CloseCode,
  DISCORD_MAX_RETRY_AFTER_MS,
  MAX_PENDING_AUTH_PER_IP,
  TOKEN_VALIDATION_RATE_LIMIT,
  UPGRADE_RATE_LIMIT,
} from "../chat/config.js";
import { APP_ID, BOT_TOKEN, captureLogger, createFakeFetch, INSTANCE_1, json } from "./helpers/fake-discord.js";

const ORIGIN = "http://localhost:5173";
const servers = [];

/** Função de confiança compilada pelo Express, a mesma que server.js passa ao chat. */
function trust(setting) {
  const app = express();
  app.set("trust proxy", setting);
  return app.get("trust proxy fn");
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** Usuário legítimo número n: token "valid-n", id numérico próprio. */
const legitUser = (n) => ({ id: String(300000000000000000n + BigInt(n)), username: `u${n}`, global_name: null, avatar: null, discriminator: "0" });
const LEGIT_IDS = Array.from({ length: 200 }, (_, n) => legitUser(n).id);

/**
 * Discord simulado: "valid-n" é válido e está em INSTANCE_1; qualquer outro token → 401.
 * `override(call)` pode responder antes (ex.: 429).
 */
function fakeDiscord(override = () => null) {
  return createFakeFetch((call) => {
    const forced = override(call);
    if (forced) return forced;
    if (call.path === "/api/v10/users/@me") {
      const match = /^Bearer valid-(\d+)$/.exec(call.authorization ?? "");
      return match ? json(200, legitUser(Number(match[1]))) : json(401, { message: "401: Unauthorized", code: 0 });
    }
    const instance = call.path.match(/activity-instances\/([^/]+)$/);
    if (instance && call.authorization === `Bot ${BOT_TOKEN}` && decodeURIComponent(instance[1]) === INSTANCE_1) {
      return json(200, { application_id: APP_ID, instance_id: INSTANCE_1, users: LEGIT_IDS });
    }
    return json(404, { message: "Unknown Activity Instance", code: 10000 });
  });
}

const userCalls = (calls) => calls.filter((c) => c.path === "/api/v10/users/@me").length;
const botCalls = (calls) => calls.filter((c) => c.authorization?.startsWith("Bot ")).length;

async function startServer({ fetchImpl, time = clock(), chatOptions = {}, tokenOptions = {} }) {
  const { logger } = captureLogger();
  const authenticate = createDiscordAuthenticator({ applicationId: APP_ID, botToken: BOT_TOKEN, fetchImpl, now: time.now, logger, tokenOptions });
  const server = http.createServer();
  const chat = attachChat(server, { authenticate, now: time.now, logger, authTimeoutMs: 2_000, ...chatOptions });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push({ server, chat });
  return { url: `ws://127.0.0.1:${server.address().port}/api/chat`, chat, authenticate, time };
}

afterEach(async () => {
  for (const { server, chat } of servers.splice(0)) {
    chat.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

/**
 * Uma tentativa de conexão. Resolve com:
 * { rejected, retryAfter } — upgrade recusado em HTTP (nunca virou WebSocket);
 * { close: { code, reason } } — fechado pelo servidor;
 * { ready, ws } — autenticado (o socket fica aberto).
 */
function attempt(url, { token, instanceId = INSTANCE_1, xff, send = true } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { origin: ORIGIN, headers: xff ? { "x-forwarded-for": xff } : {} });
    ws.on("unexpected-response", (req, res) => {
      resolve({ rejected: res.statusCode, retryAfter: res.headers["retry-after"] });
      res.resume();
      req.destroy();
    });
    ws.on("error", () => {});
    ws.once("open", () => {
      if (send) ws.send(JSON.stringify({ type: "auth", accessToken: token, instanceId }));
      else resolve({ open: true, ws });
    });
    ws.on("message", (data) => {
      const message = JSON.parse(data.toString());
      if (message.type === "ready") resolve({ ready: message, ws });
    });
    ws.once("close", (code, reason) => resolve({ close: { code, reason: reason.toString() } }));
  });
}

/** Espera o servidor processar os fechamentos até restarem `open` sockets (sem atraso fixo). */
async function settle(chat, open = 0) {
  while (chat.wss.clients.size > open) await tick();
  await tick();
}

/** n tentativas em sequência, cada uma depois que a anterior terminou no servidor. */
async function sequential(n, url, chat, optionsFor) {
  const results = [];
  for (let i = 0; i < n; i += 1) {
    results.push(await attempt(url, optionsFor(i)));
    await settle(chat);
  }
  return results;
}

const tally = (results) => {
  const counts = {};
  for (const r of results) {
    const key = r.rejected ? `HTTP ${r.rejected}` : r.ready ? "ready" : `${r.close.code} ${r.close.reason}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
};

describe("enxurrada de tokens inválidos", () => {
  test("de um único IP, em sequência: após AUTH_FAILURE_LIMIT falhas o upgrade é recusado (429) sem chamar o Discord", async () => {
    const { fetchImpl, calls } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl });
    const n = AUTH_FAILURE_LIMIT.limit + 30;
    const results = await sequential(n, url, chat, (i) => ({ token: `falso-${i}` }));

    assert.deepEqual(tally(results), { [`${CloseCode.UNAUTHORIZED} invalid_token`]: AUTH_FAILURE_LIMIT.limit, "HTTP 429": 30 });
    assert.equal(userCalls(calls), AUTH_FAILURE_LIMIT.limit, "cada chamada ao Discord corresponde a uma falha permitida");
    assert.equal(botCalls(calls), 0, "token inválido nunca provoca chamada com o token de bot");
    const retry = Number(results.at(-1).retryAfter);
    assert.ok(retry >= 1 && retry <= AUTH_FAILURE_LIMIT.windowMs / 1000, `Retry-After coerente: ${retry}`);
  });

  test("de um único IP, simultâneas: sockets pendentes e chamadas ao Discord ficam limitados", async () => {
    const { fetchImpl, calls } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl });
    const n = 300;
    let peak = 0;
    const sampler = setInterval(() => (peak = Math.max(peak, chat.wss.clients.size)), 1);
    const results = await Promise.all(Array.from({ length: n }, (_, i) => attempt(url, { token: `falso-${i}` })));
    clearInterval(sampler);
    await settle(chat);

    const counts = tally(results);
    assert.equal(results.length, n);
    assert.ok(peak <= MAX_PENDING_AUTH_PER_IP, `pico de sockets ${peak} ≤ ${MAX_PENDING_AUTH_PER_IP}`);
    assert.ok(userCalls(calls) <= Math.min(UPGRADE_RATE_LIMIT.limit, MAX_PENDING_AUTH_PER_IP), `chamadas: ${userCalls(calls)}`);
    assert.equal(counts.ready, undefined);
    // "1006" = conexão TCP descartada pelo próprio sistema operacional (fila do listen) — também recusada.
    const refused = (counts["HTTP 429"] ?? 0) + (counts["1006 "] ?? 0);
    assert.ok(refused >= n - UPGRADE_RATE_LIMIT.limit, JSON.stringify(counts));
    assert.ok((counts[`${CloseCode.UNAUTHORIZED} invalid_token`] ?? 0) <= MAX_PENDING_AUTH_PER_IP, JSON.stringify(counts));
    assert.equal(botCalls(calls), 0);

    // O IP ficou bloqueado: a próxima tentativa nem vira WebSocket.
    assert.equal((await attempt(url, { token: "falso-depois" })).rejected, 429);
  });

  test("repetir o mesmo token inválido gera uma única chamada (cache negativo), inclusive em paralelo", async () => {
    const { fetchImpl, calls } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl });
    const parallel = await Promise.all(Array.from({ length: 10 }, () => attempt(url, { token: "sempre-o-mesmo" })));
    await settle(chat);
    const serial = await sequential(5, url, chat, () => ({ token: "sempre-o-mesmo" }));
    for (const r of [...parallel, ...serial]) assert.deepEqual(r.close, { code: CloseCode.UNAUTHORIZED, reason: "invalid_token" });
    assert.equal(userCalls(calls), 1);
  });

  test("tentativas simultâneas com o mesmo token válido compartilham uma chamada e todas autenticam", async () => {
    const { fetchImpl, calls } = fakeDiscord();
    const { url } = await startServer({ fetchImpl, chatOptions: { maxConnectionsPerUser: 20 } });
    const results = await Promise.all(Array.from({ length: 10 }, () => attempt(url, { token: "valid-1" })));
    assert.ok(results.every((r) => r.ready));
    assert.equal(userCalls(calls), 1);
  });
});

describe("vários IPs e o teto global", () => {
  const behindProxy = { trustProxyFn: trust("loopback") };

  test("alternar IPs e tokens inválidos nunca passa do teto global de validações", async () => {
    const { fetchImpl, calls } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl, chatOptions: behindProxy });
    const ips = TOKEN_VALIDATION_RATE_LIMIT.limit + 50;
    const results = await sequential(ips, url, chat, (i) => ({ token: `falso-${i}`, xff: `198.51.100.${i % 250}, 10.0.${i >> 8}.${i & 255}` }));

    assert.equal(userCalls(calls), TOKEN_VALIDATION_RATE_LIMIT.limit);
    assert.deepEqual(tally(results), {
      [`${CloseCode.UNAUTHORIZED} invalid_token`]: TOKEN_VALIDATION_RATE_LIMIT.limit,
      [`${CloseCode.TRY_AGAIN_LATER} discord_unavailable`]: 50,
    });
    // Garantia: no máximo limit/janela, ou seja 6.000 em 10 min (o Discord bane a partir de 10.000).
    assert.ok((TOKEN_VALIDATION_RATE_LIMIT.limit * 600_000) / TOKEN_VALIDATION_RATE_LIMIT.windowMs < 10_000);
  });

  test("com o teto esgotado, usuários com token já validado continuam entrando (cache positivo)", async () => {
    const { fetchImpl, calls } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl, chatOptions: behindProxy, tokenOptions: { validationRateLimit: { limit: 5, windowMs: 10_000 } } });
    const first = await attempt(url, { token: "valid-7", xff: "203.0.113.70" });
    assert.ok(first.ready);
    first.ws.close();
    await settle(chat);
    await sequential(10, url, chat, (i) => ({ token: `falso-${i}`, xff: `198.51.100.${i}` }));
    const before = userCalls(calls);

    const again = await attempt(url, { token: "valid-7", xff: "203.0.113.70" });
    assert.ok(again.ready, "reconexão com token em cache não depende do teto");
    assert.equal(userCalls(calls), before);
    const fresh = await attempt(url, { token: "valid-8", xff: "203.0.113.80" });
    assert.deepEqual(fresh.close, { code: CloseCode.TRY_AGAIN_LATER, reason: "discord_unavailable" }, "token novo: tente mais tarde (o cliente faz backoff)");
  });

  test("a janela do teto global passa e as validações voltam", async () => {
    const { fetchImpl } = fakeDiscord();
    const limit = { limit: 3, windowMs: 10_000 };
    const { url, chat, time } = await startServer({ fetchImpl, chatOptions: behindProxy, tokenOptions: { validationRateLimit: limit } });
    await sequential(3, url, chat, (i) => ({ token: `falso-${i}`, xff: `198.51.100.${i}` }));
    assert.equal((await attempt(url, { token: "valid-1", xff: "203.0.113.1" })).close.reason, "discord_unavailable");
    await settle(chat);
    time.advance(limit.windowMs);
    assert.ok((await attempt(url, { token: "valid-1", xff: "203.0.113.1" })).ready);
  });

  test("falha de um IP não bloqueia outro", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl, chatOptions: behindProxy });
    await sequential(AUTH_FAILURE_LIMIT.limit, url, chat, (i) => ({ token: `falso-${i}`, xff: "198.51.100.66" }));
    assert.equal((await attempt(url, { token: "falso-x", xff: "198.51.100.66" })).rejected, 429);
    assert.ok((await attempt(url, { token: "valid-2", xff: "198.51.100.67" })).ready);
  });
});

describe("rede compartilhada (vários usuários atrás do mesmo IP)", () => {
  test("40 usuários legítimos entrando ao mesmo tempo pelo mesmo IP: todos autenticam", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url } = await startServer({ fetchImpl });
    const results = await Promise.all(Array.from({ length: 40 }, (_, n) => attempt(url, { token: `valid-${n}` })));
    assert.deepEqual(tally(results), { ready: 40 });
  });

  test("algumas falhas no mesmo IP (abaixo do limite) não afetam os demais usuários", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl });
    await sequential(AUTH_FAILURE_LIMIT.limit - 1, url, chat, (i) => ({ token: `expirado-${i}` }));
    const results = await Promise.all(Array.from({ length: 30 }, (_, n) => attempt(url, { token: `valid-${n}` })));
    assert.deepEqual(tally(results), { ready: 30 });
  });

  test("autenticar libera a vaga de pendente: muitos usuários ao longo do tempo não esbarram no limite de pendentes", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url, chat, time } = await startServer({ fetchImpl, chatOptions: { maxPendingPerIp: 3 } });
    for (let n = 0; n < 12; n += 1) {
      const r = await attempt(url, { token: `valid-${n}` });
      assert.ok(r.ready, `usuário ${n}`);
      time.advance(1_000);
    }
    assert.equal(chat.wss.clients.size, 12);
  });

  test("falhas do Discord/servidor (discord_unavailable, auth_timeout) não contam como falha do IP", async () => {
    let down = true;
    const { fetchImpl } = fakeDiscord(() => (down ? json(503, {}) : null));
    const { url, chat } = await startServer({ fetchImpl, chatOptions: { authTimeoutMs: 50 } });
    const n = AUTH_FAILURE_LIMIT.limit + 5;
    const unavailable = await sequential(n, url, chat, (i) => ({ token: `valid-${i}` }));
    assert.ok(unavailable.every((r) => r.close?.reason === "discord_unavailable"));
    // Sem frame de auth: o servidor fecha com auth_timeout (sequential espera cada fechamento).
    const silent = await sequential(n, url, chat, () => ({ send: false }));
    assert.ok(silent.every((r) => r.open));
    down = false;
    assert.ok((await attempt(url, { token: "valid-1" })).ready, "o IP não foi bloqueado");
  });
});

describe("limites do upgrade", () => {
  test("sockets ainda não autenticados por IP e no total são limitados; vagas voltam ao fechar", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url, chat } = await startServer({
      fetchImpl,
      chatOptions: { trustProxyFn: trust("loopback"), maxPendingPerIp: 3, maxPendingTotal: 5, authTimeoutMs: 10_000 },
    });
    const idleA = await Promise.all(Array.from({ length: 3 }, () => attempt(url, { send: false, xff: "198.51.100.1" })));
    assert.ok(idleA.every((r) => r.open));
    const extraA = await attempt(url, { send: false, xff: "198.51.100.1" });
    assert.equal(extraA.rejected, 429);
    assert.ok(Number(extraA.retryAfter) >= 1);

    const idleB = await Promise.all(Array.from({ length: 2 }, () => attempt(url, { send: false, xff: "198.51.100.2" })));
    assert.ok(idleB.every((r) => r.open));
    const overTotal = await attempt(url, { send: false, xff: "198.51.100.3" });
    assert.equal(overTotal.rejected, 503, "teto total de pendentes");

    for (const r of [...idleA, ...idleB]) r.ws.close();
    await settle(chat);
    assert.ok((await attempt(url, { token: "valid-3", xff: "198.51.100.1" })).ready);
  });

  test("autenticar e depois fechar libera a vaga de pendente uma única vez (o teto total não se desfaz)", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl, chatOptions: { maxPendingTotal: 2, authTimeoutMs: 10_000 } });
    for (let n = 0; n < 4; n += 1) {
      const r = await attempt(url, { token: `valid-${n}` });
      assert.ok(r.ready);
      r.ws.close();
      await settle(chat);
    }
    const idle = await Promise.all([attempt(url, { send: false }), attempt(url, { send: false })]);
    assert.ok(idle.every((r) => r.open));
    assert.equal((await attempt(url, { send: false })).rejected, 503, "continua valendo o teto de 2 pendentes");
  });

  test("erro de protocolo de quem JÁ autenticou não conta como falha de autenticação do IP", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl, chatOptions: { authFailureLimit: { limit: 1, windowMs: 60_000 } } });
    const r = await attempt(url, { token: "valid-1" });
    assert.ok(r.ready);
    const closed = once(r.ws, "close");
    r.ws.send("isto não é JSON");
    const [code, reason] = await closed;
    assert.deepEqual([code, reason.toString()], [CloseCode.BAD_REQUEST, "invalid_json"]);
    await settle(chat);
    assert.ok((await attempt(url, { token: "valid-2" })).ready, "o IP não foi bloqueado");
  });

  test("taxa de upgrades por IP: acima do limite → 429 com Retry-After; a janela passa e volta a aceitar", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url, chat, time } = await startServer({ fetchImpl, chatOptions: { upgradeRateLimit: { limit: 4, windowMs: 60_000 } } });
    const ok = [];
    for (let n = 0; n < 4; n += 1) ok.push(await attempt(url, { token: `valid-${n}` }));
    assert.ok(ok.every((r) => r.ready));
    for (const r of ok) r.ws.close();
    await settle(chat);
    const over = await attempt(url, { token: "valid-9" });
    assert.equal(over.rejected, 429);
    assert.equal(over.retryAfter, "60");
    time.advance(60_000);
    assert.ok((await attempt(url, { token: "valid-9" })).ready);
  });
});

describe("bloqueio temporário e reconexão legítima", () => {
  test("após o bloqueio expirar, um usuário legítimo do mesmo IP reconecta normalmente", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url, chat, time } = await startServer({ fetchImpl });
    await sequential(AUTH_FAILURE_LIMIT.limit, url, chat, (i) => ({ token: `falso-${i}` }));

    const blocked = await attempt(url, { token: "valid-5" });
    assert.equal(blocked.rejected, 429, "durante o bloqueio, recusa antes de consultar o Discord");
    time.advance(AUTH_FAILURE_LIMIT.windowMs - 1);
    assert.equal((await attempt(url, { token: "valid-5" })).rejected, 429);
    time.advance(1);
    assert.ok((await attempt(url, { token: "valid-5" })).ready);
  });

  test("usuários já autenticados continuam conversando enquanto o IP deles está bloqueado", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl });
    const ana = await attempt(url, { token: "valid-1" });
    const bia = await attempt(url, { token: "valid-2" });
    assert.ok(ana.ready && bia.ready);

    // O atacante usa o mesmo IP (rede compartilhada) até bloqueá-lo.
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit; i += 1) {
      await attempt(url, { token: `falso-${i}` });
      while (chat.wss.clients.size > 2) await tick();
    }
    assert.equal((await attempt(url, { token: "falso-x" })).rejected, 429);

    const received = new Promise((resolve) => {
      bia.ws.on("message", (data) => {
        const message = JSON.parse(data.toString());
        if (message.type === "message") resolve(message);
      });
    });
    ana.ws.send(JSON.stringify({ type: "send", text: "ainda aqui", nonce: "n-1" }));
    const message = await received;
    assert.equal(message.message.text, "ainda aqui");
    assert.equal(ana.ws.readyState, WebSocket.OPEN);
  });
});

describe("X-Forwarded-For", () => {
  test("sem proxy confiável (padrão), X-Forwarded-For forjado é ignorado: o bloqueio pega o IP real", async () => {
    const { fetchImpl, calls } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl });
    const results = await sequential(AUTH_FAILURE_LIMIT.limit + 10, url, chat, (i) => ({ token: `falso-${i}`, xff: `203.0.113.${i}` }));
    assert.equal(tally(results)["HTTP 429"], 10);
    assert.equal(userCalls(calls), AUTH_FAILURE_LIMIT.limit);
  });

  test("com 1 proxy confiável, valores forjados à esquerda não mudam o IP considerado", async () => {
    const { fetchImpl, calls } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl, chatOptions: { trustProxyFn: trust(1) } });
    // O proxy acrescenta o IP real (198.51.100.9) no fim; o atacante forja o começo.
    const results = await sequential(AUTH_FAILURE_LIMIT.limit + 5, url, chat, (i) => ({ token: `falso-${i}`, xff: `10.9.9.${i}, 198.51.100.9` }));
    assert.equal(tally(results)["HTTP 429"], 5);
    assert.equal(userCalls(calls), AUTH_FAILURE_LIMIT.limit);
  });

  test("clientIp segue a regra do Express (trust proxy)", () => {
    const req = (remoteAddress, xff) => ({ socket: { remoteAddress }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } });
    assert.equal(clientIp(req("127.0.0.1", "1.1.1.1")), "127.0.0.1", "padrão: ignora o cabeçalho");
    assert.equal(clientIp(req("127.0.0.1", "1.1.1.1"), TRUST_NONE), "127.0.0.1");
    assert.equal(clientIp(req("127.0.0.1", "6.6.6.6, 2.2.2.2"), trust(1)), "2.2.2.2");
    assert.equal(clientIp(req("127.0.0.1", "6.6.6.6, 2.2.2.2, 10.0.0.1"), trust(2)), "2.2.2.2");
    assert.equal(clientIp(req("127.0.0.1", "6.6.6.6,2.2.2.2"), trust("loopback")), "2.2.2.2", "só o loopback é confiável");
    assert.equal(clientIp(req("203.0.113.5", "1.1.1.1"), trust("loopback")), "203.0.113.5", "socket não confiável: ignora o cabeçalho");
    assert.equal(clientIp(req("127.0.0.1"), trust(1)), "127.0.0.1", "sem cabeçalho");
    assert.equal(clientIp(req("127.0.0.1", ["6.6.6.6", "2.2.2.2"]), trust(1)), "2.2.2.2", "cabeçalho repetido");
    assert.equal(clientIp(req("127.0.0.1", " , ,"), trust(1)), "127.0.0.1", "cabeçalho vazio");
    assert.equal(clientIp({ headers: {} }), "unknown");
  });
});

describe("429 do Discord e Retry-After", () => {
  test("429 global: nenhuma validação chama o Discord até o Retry-After passar", async () => {
    let limited = true;
    const { fetchImpl, calls } = fakeDiscord((call) =>
      limited && call.path === "/api/v10/users/@me" ? json(429, { message: "You are being rate limited.", retry_after: 2.5, global: true }) : null,
    );
    const { url, chat, time } = await startServer({ fetchImpl });
    assert.deepEqual((await attempt(url, { token: "valid-1" })).close, { code: CloseCode.TRY_AGAIN_LATER, reason: "discord_unavailable" });
    await settle(chat);
    limited = false;
    time.advance(2_499);
    const during = await sequential(5, url, chat, (n) => ({ token: `valid-${n + 2}` }));
    assert.ok(during.every((r) => r.close?.reason === "discord_unavailable"));
    assert.equal(userCalls(calls), 1, "durante o bloqueio, nenhuma chamada");
    time.advance(1);
    assert.ok((await attempt(url, { token: "valid-1" })).ready);
  });

  test("429 de um token (não global): só esse token espera; os outros seguem", async () => {
    const { fetchImpl, calls } = fakeDiscord((call) =>
      call.authorization === "Bearer valid-1" ? json(429, { retry_after: 30, global: false }) : null,
    );
    const { url, chat, time } = await startServer({ fetchImpl });
    assert.equal((await attempt(url, { token: "valid-1" })).close.reason, "discord_unavailable");
    await settle(chat);
    assert.equal((await attempt(url, { token: "valid-1" })).close.reason, "discord_unavailable");
    assert.equal(userCalls(calls), 1);
    assert.ok((await attempt(url, { token: "valid-2" })).ready);
    time.advance(30_000);
    await attempt(url, { token: "valid-1" });
    assert.equal(calls.filter((c) => c.authorization === "Bearer valid-1").length, 2, "após o Retry-After, tenta de novo");
  });

  test("429 sem corpo JSON (bloqueio por IP/Cloudflare) usa o cabeçalho Retry-After e vale para todos", async () => {
    let limited = true;
    const { fetchImpl, calls } = fakeDiscord(() =>
      limited ? new Response("<html>banned</html>", { status: 429, headers: { "Retry-After": "7" } }) : null,
    );
    const { url, chat, time } = await startServer({ fetchImpl });
    await attempt(url, { token: "valid-1" });
    await settle(chat);
    limited = false;
    time.advance(6_999);
    assert.equal((await attempt(url, { token: "valid-2" })).close.reason, "discord_unavailable");
    assert.equal(calls.length, 1);
    await settle(chat);
    time.advance(1);
    assert.ok((await attempt(url, { token: "valid-2" })).ready);
  });

  test("429 na consulta da instância (token de bot): respeita o Retry-After e o cache válido continua servindo", async () => {
    let limited = false;
    const { fetchImpl, calls } = fakeDiscord((call) =>
      limited && call.authorization?.startsWith("Bot ") ? json(429, { retry_after: 10, global: false }) : null,
    );
    const { url, chat, time, authenticate } = await startServer({ fetchImpl });
    assert.ok((await attempt(url, { token: "valid-1" })).ready, "instância em cache");
    limited = true;
    assert.ok((await attempt(url, { token: "valid-2" })).ready, "membro presente no cache: sem nova consulta");

    time.advance(30_000); // cache da instância venceu
    assert.equal((await attempt(url, { token: "valid-3" })).close.reason, "discord_unavailable");
    const before = botCalls(calls);
    await settle(chat, 2);
    await assert.rejects(authenticate.instances.getSnapshot(INSTANCE_1, { fresh: true }), (error) => error.reason === "discord_unavailable");
    assert.equal(botCalls(calls), before, "revalidação durante o bloqueio também não chama o Discord");
    limited = false;
    time.advance(10_000);
    assert.ok((await attempt(url, { token: "valid-3" })).ready);
  });

  test("parseRateLimit: corpo, cabeçalhos, limite máximo e valores inválidos", () => {
    const headers = (entries) => new Headers(entries);
    assert.deepEqual(parseRateLimit({ retry_after: 1.234, global: false }, headers({})), { retryAfterMs: 1234, global: false, scope: null });
    assert.deepEqual(parseRateLimit({ retry_after: 0.5, global: true }, headers({})), { retryAfterMs: 500, global: true, scope: null });
    assert.equal(parseRateLimit({ retry_after: 1, global: false }, headers({ "x-ratelimit-scope": "global" })).global, true);
    assert.equal(parseRateLimit({ global: false }, headers({ "x-ratelimit-global": "true" })).global, true);
    assert.equal(parseRateLimit({ global: false }, headers({ "x-ratelimit-scope": "shared", "retry-after": "3" })).retryAfterMs, 3000);
    assert.deepEqual(parseRateLimit(null, headers({ "retry-after": "9" })), { retryAfterMs: 9000, global: true, scope: null });
    assert.equal(parseRateLimit({ retry_after: 1e9 }, headers({})).retryAfterMs, DISCORD_MAX_RETRY_AFTER_MS, "valor absurdo é limitado");
    assert.equal(parseRateLimit({ retry_after: "abc" }, headers({})).retryAfterMs, 1_000, "sem valor válido: espera padrão");
    assert.equal(parseRateLimit({ retry_after: -5 }, headers({ "retry-after": "2" })).retryAfterMs, 2000);
  });

  test("createRetryGate: o maior bloqueio vale, e expira", () => {
    const time = clock();
    const gate = createRetryGate({ now: time.now });
    gate.block("a", 1_000);
    gate.block("a", 500); // não encurta
    assert.equal(gate.remaining("a"), 1_000);
    gate.block("b", 3_000);
    assert.equal(gate.remaining("a", "b"), 3_000);
    assert.equal(gate.remaining("c"), 0);
    time.advance(1_000);
    assert.equal(gate.remaining("a"), 0);
    assert.equal(gate.size(), 1, "entrada vencida removida");
  });
});

describe("isolamento", () => {
  test("bloqueios de uma instância do servidor não afetam outra", async () => {
    const a = await startServer({ fetchImpl: fakeDiscord().fetchImpl });
    const b = await startServer({ fetchImpl: fakeDiscord().fetchImpl });
    await sequential(AUTH_FAILURE_LIMIT.limit, a.url, a.chat, (i) => ({ token: `falso-${i}` }));
    assert.equal((await attempt(a.url, { token: "valid-1" })).rejected, 429);
    assert.ok((await attempt(b.url, { token: "valid-1" })).ready);
  });

  test("tokens inválidos repetidos numa sala não afetam usuários autenticados de outra sala", async () => {
    const { fetchImpl } = fakeDiscord();
    const { url, chat } = await startServer({ fetchImpl, chatOptions: { trustProxyFn: trust("loopback") } });
    const member = await attempt(url, { token: "valid-1", xff: "203.0.113.1" });
    assert.ok(member.ready);
    for (let i = 0; i < AUTH_FAILURE_LIMIT.limit + 3; i += 1) {
      await attempt(url, { token: `falso-${i}`, instanceId: "i-outra-instancia-gc-1-2", xff: "198.51.100.200" });
      while (chat.wss.clients.size > 1) await tick();
    }
    assert.equal(member.ws.readyState, WebSocket.OPEN);
    assert.equal(chat.rooms.clients(INSTANCE_1).length, 1);
  });
});

test("rate-limit.peek consulta sem registrar", () => {
  const time = clock();
  const limiter = createSlidingWindowLimiter({ limit: 2, windowMs: 1_000, now: time.now });
  assert.deepEqual(limiter.peek("k"), { allowed: true, retryAfterMs: 0 });
  limiter.peek("k");
  limiter.peek("k");
  assert.ok(limiter.hit("k").allowed, "peek não consome");
  limiter.hit("k");
  time.advance(400);
  assert.deepEqual(limiter.peek("k"), { allowed: false, retryAfterMs: 600 });
  time.advance(600);
  assert.equal(limiter.peek("k").allowed, true);
});
