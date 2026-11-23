/*
 * Limites com IP compartilhado: o proxy das Activities do Discord esconde o IP dos usuários,
 * então no Render muitas pessoas chegam com o MESMO IP. Aqui todos os clientes saem de
 * 127.0.0.1 e os testes usam os valores PADRÃO de produção (sem afrouxar limites), com o
 * Discord simulado e o servidor real (createApp + attachChat + rotas /api/legal).
 */
import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { WebSocket } from "ws";
import express from "express";
import { createApp, TOKEN_GLOBAL_RATE_LIMIT, TOKEN_RATE_LIMIT } from "../app.js";
import { createTokenValidator } from "../chat/auth.js";
import { createDiscordAuthenticator } from "../chat/authenticator.js";
import {
  AUTH_FAILURE_LIMIT,
  MAX_CONNECTIONS_PER_ROOM,
  MAX_PENDING_AUTH_PER_IP,
  TOKEN_VALIDATION_RATE_LIMIT,
  UPGRADE_GLOBAL_RATE_LIMIT,
  UPGRADE_RATE_LIMIT,
  USER_AUTH_RATE_LIMIT,
} from "../chat/config.js";
import { attachChat } from "../chat/index.js";
import { createMemoryAcceptanceStore } from "../legal/acceptance-store.js";
import { resolveLegalDocuments } from "../legal/config.js";
import { createLegalGate } from "../legal/gate.js";
import { createLegalRouter, LEGAL_ACCEPT_IP_RATE_LIMIT, LEGAL_STATUS_IP_RATE_LIMIT } from "../legal/routes.js";
import { authorizationInfo, captureLogger, json, OAUTH_ME_PATH } from "./helpers/fake-discord.js";

const ORIGIN = "http://localhost:5173";
const APP = "1215413995645968394";
const BOT = "fake-bot-token-not-real";
const instance = (n) => `i-12765800724002243${String(n).padStart(2, "0")}-gc-912952092627435520-912954213460484116`;
const uid = (n) => String(300000000000000000n + BigInt(n));
const quiet = () => captureLogger().logger;

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

/** Discord simulado: tok-<n> é o usuário n; cada instância contém os usuários informados. */
function fakeDiscord(rooms) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const authorization = init.headers?.Authorization ?? init.headers?.authorization;
    calls.push(pathname);
    if (pathname === "/api/oauth2/token") return json(200, { access_token: `tok-${calls.length}` });
    if (pathname === OAUTH_ME_PATH) {
      const m = /^Bearer tok-(\d+)$/.exec(authorization ?? "");
      return m ? json(200, authorizationInfo({ id: uid(+m[1]), username: `u${m[1]}`, global_name: null, avatar: null }, { applicationId: APP })) : json(401, { message: "401: Unauthorized" });
    }
    const match = /\/activity-instances\/([^/]+)$/.exec(pathname);
    if (match) {
      if (authorization !== `Bot ${BOT}`) return json(401, {});
      const id = decodeURIComponent(match[1]);
      const users = rooms[id];
      if (!users) return json(404, { code: 10000 });
      return json(200, {
        application_id: APP,
        instance_id: id,
        launch_id: "1276580072400224306",
        location: { id: "gc-912952092627435520-912954213460484116", kind: "gc", channel_id: "912954213460484116", guild_id: "912952092627435520" },
        users,
      });
    }
    return json(404, {});
  };
  return { fetchImpl, calls };
}

const running = [];
afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
});

/**
 * Sobe o backend como server.js faz: UM validador de token compartilhado pelo chat e pelas
 * rotas legais, UM app (limites do /api/token) e UM attachChat (limites do WebSocket).
 */
async function startBackend({ rooms, accepted = [], time = clock(), chatOptions = {}, tokenOptions = {} }) {
  const logger = quiet();
  const discord = fakeDiscord(rooms);
  const documents = resolveLegalDocuments({});
  const store = createMemoryAcceptanceStore();
  for (const id of accepted) await store.recordAcceptance({ userId: id, terms: documents.terms.version, privacy: documents.privacy.version });
  const tokens = createTokenValidator({ applicationId: APP, fetchImpl: discord.fetchImpl, logger, now: time.now, ...tokenOptions });
  const gate = createLegalGate({ store, documents, now: time.now });
  const router = createLegalRouter({ validateToken: (t) => tokens.validate(t), gate, documents, logger, now: time.now });
  const app = createApp({ clientId: APP, clientSecret: "fake-secret", fetchImpl: discord.fetchImpl, logger, now: time.now, legalRouter: router });
  const server = http.createServer(app);
  const authenticate = createDiscordAuthenticator({ applicationId: APP, botToken: BOT, fetchImpl: discord.fetchImpl, logger, now: time.now, tokens });
  const chat = attachChat(server, { authenticate, logger, now: time.now, requireLegalAcceptance: gate.requireAccepted, ...chatOptions });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  running.push(async () => {
    chat.close();
    router.close();
    app.locals.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `127.0.0.1:${server.address().port}`;
  return { base, chat, discord, time, wsUrl: `ws://${base}/api/chat` };
}

const exchange = (base) =>
  fetch(`http://${base}/api/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "codigo" }) }).then((r) => r.status);
const legalStatus = (base, n) => fetch(`http://${base}/api/legal/status`, { headers: { Authorization: `Bearer tok-${n}` } }).then((r) => r.status);

/** Uma conexão do chat: "ready", "HTTP <status>" (upgrade recusado) ou "<código> <motivo>". */
function connect(wsUrl, { token, instanceId, keepOpen = false, headers = {} }) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, { origin: ORIGIN, headers });
    ws.on("unexpected-response", (req, res) => {
      resolve({ result: `HTTP ${res.statusCode}` });
      res.resume();
      req.destroy();
    });
    ws.on("error", () => {});
    ws.once("open", () => ws.send(JSON.stringify({ type: "auth", accessToken: token, instanceId })));
    ws.on("message", (data) => {
      if (JSON.parse(data.toString()).type !== "history") return;
      if (!keepOpen) ws.close();
      resolve({ result: "ready", ws });
    });
    ws.once("close", (code, reason) => resolve({ result: `${code} ${reason}` }));
  });
}

const tally = (list) => list.reduce((acc, item) => ((acc[item] = (acc[item] ?? 0) + 1), acc), {});
const range = (n, from = 0) => Array.from({ length: n }, (_, i) => i + from);

async function settle(chat, open = 0) {
  for (let i = 0; i < 400 && chat.wss.clients.size > open; i += 1) await new Promise((r) => setTimeout(r, 5));
}

// ---------------------------------------------------------------------------

describe("usuários legítimos atrás do mesmo IP (valores padrão)", () => {
  for (const n of [10, 30, 50, 100]) {
    test(`${n} usuários entrando ao mesmo tempo: token, aceite e chat funcionam para todos`, async () => {
      // Salas de até MAX_CONNECTIONS_PER_ROOM: com 100, duas instâncias da Activity de 50.
      const perRoom = Math.min(n, MAX_CONNECTIONS_PER_ROOM);
      const rooms = {};
      for (const i of range(n)) (rooms[instance(Math.floor(i / perRoom))] ??= []).push(uid(i));
      const { base, wsUrl, chat } = await startBackend({ rooms, accepted: range(n).map(uid) });

      const tokens = await Promise.all(range(n).map(() => exchange(base)));
      assert.deepEqual(tally(tokens), { 200: n }, "/api/token");
      const statuses = await Promise.all(range(n).map((i) => legalStatus(base, i)));
      assert.deepEqual(tally(statuses), { 200: n }, "/api/legal/status");
      const sockets = await Promise.all(range(n).map((i) => connect(wsUrl, { token: `tok-${i}`, instanceId: instance(Math.floor(i / perRoom)) })));
      assert.deepEqual(tally(sockets.map((s) => s.result)), { ready: n }, "WebSocket");
      await settle(chat);
    });
  }

  test("100 usuários na MESMA instância: o limite de sala (50) continua valendo", async () => {
    const { wsUrl } = await startBackend({ rooms: { [instance(1)]: range(100).map(uid) }, accepted: range(100).map(uid) });
    const sockets = await Promise.all(range(100).map((i) => connect(wsUrl, { token: `tok-${i}`, instanceId: instance(1), keepOpen: true })));
    const counts = tally(sockets.map((s) => s.result));
    assert.deepEqual(counts, { ready: MAX_CONNECTIONS_PER_ROOM, "4029 room_full": 100 - MAX_CONNECTIONS_PER_ROOM });
    for (const s of sockets) s.ws?.close();
  });

  test("reconexão simultânea de 50 usuários depois de uma queda: todos voltam", async () => {
    const rooms = { [instance(1)]: range(50).map(uid) };
    const { wsUrl, chat } = await startBackend({ rooms, accepted: range(50).map(uid) });
    const first = await Promise.all(range(50).map((i) => connect(wsUrl, { token: `tok-${i}`, instanceId: instance(1), keepOpen: true })));
    assert.equal(first.filter((s) => s.result === "ready").length, 50);
    for (const ws of chat.wss.clients) ws.terminate(); // queda: todos caem juntos
    await settle(chat);
    const again = await Promise.all(range(50).map((i) => connect(wsUrl, { token: `tok-${i}`, instanceId: instance(1) })));
    assert.deepEqual(tally(again.map((s) => s.result)), { ready: 50 });
    await settle(chat);
  });
});

describe("abuso atrás do mesmo IP (valores padrão)", () => {
  test("20 tokens inválidos NÃO bloqueiam os usuários legítimos do mesmo IP", async () => {
    const { wsUrl, chat } = await startBackend({ rooms: { [instance(1)]: range(5).map(uid) }, accepted: range(5).map(uid) });
    for (const i of range(20)) assert.equal((await connect(wsUrl, { token: `falso-${i}`, instanceId: instance(1) })).result, "4001 invalid_token");
    const legit = await Promise.all(range(5).map((i) => connect(wsUrl, { token: `tok-${i}`, instanceId: instance(1) })));
    assert.deepEqual(tally(legit.map((s) => s.result)), { ready: 5 });
    await settle(chat);
  });

  test(`${AUTH_FAILURE_LIMIT.limit} falhas de token inválido em 5 min: o IP é bloqueado (429) sem chamar o Discord`, async () => {
    const time = clock();
    const { wsUrl, chat, discord } = await startBackend({ rooms: { [instance(1)]: [uid(0)] }, accepted: [uid(0)], time });
    for (const i of range(AUTH_FAILURE_LIMIT.limit)) {
      const { result } = await connect(wsUrl, { token: `falso-${i}`, instanceId: instance(1) });
      assert.equal(result, "4001 invalid_token", `tentativa ${i}`);
      await settle(chat);
      time.advance(150); // ~7/s: abaixo do teto global de validações (100 a cada 10 s)
    }
    const calls = discord.calls.length;
    assert.equal((await connect(wsUrl, { token: "falso-x", instanceId: instance(1) })).result, "HTTP 429");
    assert.equal(discord.calls.length, calls, "a tentativa bloqueada não chegou ao Discord");
    time.advance(AUTH_FAILURE_LIMIT.windowMs);
    assert.equal((await connect(wsUrl, { token: "tok-0", instanceId: instance(1) })).result, "ready", "a janela passa e o IP volta");
    await settle(chat);
  });

  test("usuários com token válido que saíram da instância NÃO contam como falha do IP", async () => {
    const { wsUrl, chat } = await startBackend({ rooms: { [instance(1)]: [uid(999)] }, accepted: [uid(999)], chatOptions: { authFailureLimit: { limit: 3, windowMs: 300_000 } } });
    for (const i of range(10)) assert.equal((await connect(wsUrl, { token: `tok-${i}`, instanceId: instance(1) })).result, "4003 not_in_instance");
    for (const i of range(3)) await connect(wsUrl, { token: `tok-${i}`, instanceId: instance(9) }); // instância inexistente
    assert.equal((await connect(wsUrl, { token: "tok-999", instanceId: instance(1) })).result, "ready");
    await settle(chat);
  });

  test("tempestade de reconexões de UMA conta: acima de 30/min fecha com 4029; outras contas seguem", async () => {
    const { wsUrl, chat } = await startBackend({ rooms: { [instance(1)]: [uid(1), uid(2)] }, accepted: [uid(1), uid(2)] });
    const results = [];
    for (const _ of range(USER_AUTH_RATE_LIMIT.limit + 3)) {
      results.push((await connect(wsUrl, { token: "tok-1", instanceId: instance(1) })).result);
      await settle(chat);
    }
    assert.deepEqual(tally(results), { ready: USER_AUTH_RATE_LIMIT.limit, "4029 too_many_auth_attempts": 3 });
    assert.equal((await connect(wsUrl, { token: "tok-2", instanceId: instance(1) })).result, "ready", "outra conta não é afetada");
    await settle(chat);
  });

  test("o ID da conta vem do Discord: variar o que o cliente envia não renova a cota", async () => {
    const { wsUrl, chat } = await startBackend({
      rooms: { [instance(1)]: [uid(1)] },
      accepted: [uid(1)],
      chatOptions: { userAuthRateLimit: { limit: 2, windowMs: 60_000 } },
    });
    const sent = [];
    for (const extra of [{}, { userId: uid(5) }, { user: { id: uid(6) } }]) {
      const ws = new WebSocket(wsUrl, { origin: ORIGIN });
      ws.on("error", () => {});
      sent.push(
        await new Promise((resolve) => {
          ws.once("open", () => ws.send(JSON.stringify({ type: "auth", accessToken: "tok-1", instanceId: instance(1), ...extra })));
          ws.on("message", (d) => JSON.parse(d.toString()).type === "history" && (ws.close(), resolve("ready")));
          ws.once("close", (c, r) => resolve(`${c} ${r}`));
        }),
      );
      await settle(chat);
    }
    assert.deepEqual(sent, ["ready", "ready", "4029 too_many_auth_attempts"]);
  });
});

describe("tetos globais (um contador por processo, compartilhado)", () => {
  const behindProxy = (setting) => {
    const app = express();
    app.set("trust proxy", setting);
    return app.get("trust proxy fn");
  };

  test("upgrades no total do processo: muitos IPs diferentes somam no mesmo teto", async () => {
    const { wsUrl, chat } = await startBackend({
      rooms: { [instance(1)]: range(10).map(uid) },
      accepted: range(10).map(uid),
      chatOptions: { trustProxyFn: behindProxy("loopback"), upgradeGlobalRateLimit: { limit: 5, windowMs: 60_000 } },
    });
    const results = [];
    for (const i of range(7)) {
      results.push((await connect(wsUrl, { token: `tok-${i}`, instanceId: instance(1), headers: { "x-forwarded-for": `198.51.100.${i}` } })).result);
      await settle(chat);
    }
    assert.deepEqual(tally(results), { ready: 5, "HTTP 503": 2 });
  });

  test("validações de token no Discord: chat e rotas legais dividem o MESMO teto (sem contador duplicado)", async () => {
    const { base, wsUrl, chat, discord } = await startBackend({
      rooms: { [instance(1)]: range(10).map(uid) },
      accepted: range(10).map(uid),
      tokenOptions: { validationRateLimit: { limit: 3, windowMs: 10_000 } },
    });
    assert.equal(await legalStatus(base, 1), 200);
    assert.equal(await legalStatus(base, 2), 200);
    assert.equal((await connect(wsUrl, { token: "tok-3", instanceId: instance(1) })).result, "ready");
    // O teto (3) foi atingido somando as duas vias: a 4ª validação nova é recusada nas duas.
    assert.equal((await connect(wsUrl, { token: "tok-4", instanceId: instance(1) })).result, "1013 discord_unavailable");
    assert.equal(await legalStatus(base, 5), 503);
    assert.equal(discord.calls.filter((p) => p === OAUTH_ME_PATH).length, 3);
    await settle(chat);
  });

  test("server.js cria UM único validador de token e o entrega ao chat e às rotas legais", async () => {
    const source = await readFile(new URL("../server.js", import.meta.url), "utf8");
    assert.equal(source.match(/createTokenValidator\(/g)?.length, 1, "um único validador");
    assert.match(source, /createLegalSetup\(\{[^}]*validateToken: \(token\) => tokens\.validate\(token\)/);
    assert.match(source, /createDiscordAuthenticator\(\{[^}]*gate: retryGate, tokens \}\)/);
    assert.equal(source.match(/createApp\(/g)?.length, 1, "um único app (limites do /api/token)");
    assert.equal(source.match(/attachChat\(/g)?.length, 1, "um único attachChat (limites do WebSocket)");
  });

  test(`/api/token: acima de ${TOKEN_RATE_LIMIT.limit}/min no mesmo IP → 429 (o teto global entre IPs está em routes.test.js)`, async () => {
    const { base } = await startBackend({ rooms: {} });
    const statuses = await Promise.all(range(TOKEN_RATE_LIMIT.limit + 5).map(() => exchange(base)));
    assert.equal(statuses.filter((s) => s === 200).length, TOKEN_RATE_LIMIT.limit, "por IP");
    assert.ok(TOKEN_GLOBAL_RATE_LIMIT.limit >= TOKEN_RATE_LIMIT.limit);
  });
});

describe("valores padrão coerentes com ~100 usuários atrás de um IP", () => {
  test("cada teto pré-autenticação comporta 100 entradas com folga, e o teto global de validações continua seguro", () => {
    assert.ok(TOKEN_RATE_LIMIT.limit >= 100);
    assert.ok(UPGRADE_RATE_LIMIT.limit >= 200, "100 entradas + reconexões");
    assert.ok(MAX_PENDING_AUTH_PER_IP >= 100);
    assert.ok(UPGRADE_GLOBAL_RATE_LIMIT.limit >= UPGRADE_RATE_LIMIT.limit);
    assert.ok(LEGAL_STATUS_IP_RATE_LIMIT.limit >= 100 && LEGAL_ACCEPT_IP_RATE_LIMIT.limit >= 100);
    // Pior caso com códigos/tokens inválidos, abaixo das 10.000 recusas em 10 min do Discord.
    assert.ok((TOKEN_GLOBAL_RATE_LIMIT.limit * 600_000) / TOKEN_GLOBAL_RATE_LIMIT.windowMs < 10_000);
    assert.equal(TOKEN_VALIDATION_RATE_LIMIT.limit, 100);
    assert.equal(TOKEN_VALIDATION_RATE_LIMIT.windowMs, 10_000);
    assert.equal(MAX_CONNECTIONS_PER_ROOM, 50);
  });
});
