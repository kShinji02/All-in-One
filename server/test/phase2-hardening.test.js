import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import { addressKind, createApp, describeProxyChain, JSON_BODY_LIMIT, PROXY_IP_HEADERS } from "../app.js";
import { REPEATED_MESSAGE_LIMIT } from "../chat/config.js";
import { ChatCloseError } from "../chat/errors.js";
import { attachChat } from "../chat/index.js";

/*
 * Fase 2 — proteções adicionais: anti-spam de texto repetido no chat, limite de tamanho dos
 * corpos JSON e diagnóstico de proxy sem endereços.
 */

const ORIGIN = "http://localhost:5173";
const INSTANCE = "i-1-gc-2-3";
const USERS = {
  "tok-ana": { id: "205519959982473217", username: "ana", displayName: "Ana", avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png" },
  "tok-bia": { id: "175928847299117063", username: "bia", displayName: "Bia", avatarUrl: "https://cdn.discordapp.com/embed/avatars/1.png" },
};

const running = [];
afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
});

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

async function startChat(options = {}) {
  const server = http.createServer();
  const chat = attachChat(server, {
    authenticate: async ({ accessToken, instanceId }) => {
      const user = USERS[accessToken];
      if (!user) throw new ChatCloseError(4001, "invalid_token");
      return { user, instanceId };
    },
    logger: { log() {}, warn() {}, error() {} },
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  running.push(async () => {
    chat.close();
    await new Promise((resolve) => server.close(resolve));
  });
  return `ws://127.0.0.1:${server.address().port}/api/chat`;
}

/** Conecta, autentica e devolve um cliente que guarda os frames recebidos. */
async function connect(url, token) {
  const ws = new WebSocket(url, { origin: ORIGIN });
  const frames = [];
  ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "auth", accessToken: token, instanceId: INSTANCE }));
  while (!frames.some((f) => f.type === "history")) await new Promise((r) => setTimeout(r, 5));
  running.push(async () => ws.close());
  return {
    frames,
    send: (text, nonce) => ws.send(JSON.stringify({ type: "send", text, ...(nonce && { nonce }) })),
    /** Espera até `count` frames que passem em `filter`. */
    async waitFor(filter, count = 1) {
      for (let i = 0; i < 200 && frames.filter(filter).length < count; i += 1) await new Promise((r) => setTimeout(r, 5));
      return frames.filter(filter);
    },
  };
}

describe("anti-spam: mesmo texto repetido", () => {
  test("padrão: até 3 vezes por minuto e por usuário", () => {
    assert.deepEqual(REPEATED_MESSAGE_LIMIT, { limit: 3, windowMs: 60_000 });
  });

  test("a 4ª mensagem igual (ignorando maiúsculas e espaços) é recusada com repeated_message e não é publicada", async () => {
    const url = await startChat({ messageRateLimit: { limit: 50, windowMs: 10_000 } });
    const ana = await connect(url, "tok-ana");
    const bia = await connect(url, "tok-bia");
    ana.send("Compre já!", "n-1");
    ana.send("compre   JÁ!", "n-2");
    ana.send(" Compre já! ", "n-3");
    ana.send("COMPRE JÁ!", "n-4");
    const [error] = await ana.waitFor((f) => f.type === "error");
    assert.deepEqual(error, { type: "error", code: "repeated_message", nonce: "n-4" });
    const delivered = await bia.waitFor((f) => f.type === "message", 3);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(bia.frames.filter((f) => f.type === "message").length, 3, "a repetida não chegou à sala");
    assert.equal(delivered.length, 3);
  });

  test("textos diferentes não são afetados; outro usuário com o mesmo texto tem a própria cota", async () => {
    const url = await startChat({ repeatedMessageLimit: { limit: 1, windowMs: 60_000 } });
    const ana = await connect(url, "tok-ana");
    const bia = await connect(url, "tok-bia");
    ana.send("oi", "a-1");
    ana.send("tudo bem?", "a-2");
    bia.send("oi", "b-1");
    const mine = await ana.waitFor((f) => f.type === "message" && f.nonce, 2);
    assert.deepEqual(mine.map((f) => f.nonce), ["a-1", "a-2"]);
    const biaOwn = await bia.waitFor((f) => f.type === "message" && f.nonce === "b-1");
    assert.equal(biaOwn.length, 1);
    assert.equal(ana.frames.filter((f) => f.type === "error").length, 0);
  });

  test("reenvio idempotente (mesmo nonce) não conta como repetição; a janela passa e o texto volta a valer", async () => {
    const time = clock();
    const url = await startChat({ now: time.now, repeatedMessageLimit: { limit: 1, windowMs: 60_000 } });
    const ana = await connect(url, "tok-ana");
    ana.send("bom dia", "n-1");
    ana.send("bom dia", "n-1"); // reenvio: devolve a original
    const echoes = await ana.waitFor((f) => f.type === "message" && f.nonce === "n-1", 2);
    assert.equal(echoes.length, 2);
    assert.equal(echoes[0].message.id, echoes[1].message.id);

    ana.send("bom dia", "n-2");
    assert.equal((await ana.waitFor((f) => f.type === "error" && f.nonce === "n-2")).length, 1);
    time.advance(60_000);
    ana.send("bom dia", "n-3");
    assert.equal((await ana.waitFor((f) => f.type === "message" && f.nonce === "n-3")).length, 1);
  });

  test("repetições recusadas não consomem o limite de envio", async () => {
    const url = await startChat({ messageRateLimit: { limit: 2, windowMs: 10_000 }, repeatedMessageLimit: { limit: 1, windowMs: 60_000 } });
    const ana = await connect(url, "tok-ana");
    ana.send("x", "n-1");
    for (let i = 0; i < 5; i += 1) ana.send("x", `r-${i}`);
    ana.send("y", "n-2");
    assert.equal((await ana.waitFor((f) => f.type === "message" && f.nonce === "n-2")).length, 1);
    assert.equal(ana.frames.filter((f) => f.type === "rate_limited").length, 0);
  });
});

describe("corpos JSON", () => {
  test(`limite de ${JSON_BODY_LIMIT}: acima → 413 em JSON; abaixo segue normal`, async () => {
    const app = createApp({ logger: { log() {}, warn() {}, error() {} } });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    running.push(async () => {
      app.locals.close();
      await new Promise((resolve) => server.close(resolve));
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const big = await fetch(`${base}/api/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "a".repeat(9 * 1024) }) });
    assert.deepEqual([big.status, (await big.json()).error], [413, "payload_too_large"]);
    const small = await fetch(`${base}/api/token`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code: "a".repeat(1024) }) });
    assert.notEqual(small.status, 413);
  });
});

describe("diagnóstico de proxy (PROXY_DIAGNOSTICS)", () => {
  test("classifica endereços sem expô-los", () => {
    assert.equal(addressKind("127.0.0.1"), "loopback");
    assert.equal(addressKind("::1"), "loopback");
    assert.equal(addressKind("::ffff:10.1.2.3"), "private");
    assert.equal(addressKind("172.20.0.1"), "private");
    assert.equal(addressKind("192.168.0.9"), "private");
    assert.equal(addressKind("100.64.1.1"), "cgnat");
    assert.equal(addressKind("203.0.113.7"), "public");
    assert.equal(addressKind("2001:db8::1"), "public");
    assert.equal(addressKind("fd00::1"), "private");
    assert.equal(addressKind("não é ip"), "invalid");
    assert.equal(addressKind(undefined), "invalid");
  });

  test("a linha traz contagem, tipos e cabeçalhos presentes, nunca os endereços", () => {
    const req = {
      headers: { "x-forwarded-for": "203.0.113.7, 10.0.0.5", "cf-connecting-ip": "203.0.113.7" },
      socket: { remoteAddress: "10.0.0.9" },
      ip: "203.0.113.7",
    };
    const line = describeProxyChain(req);
    assert.equal(
      line,
      "X-Forwarded-For com 2 entrada(s) (da direita para a esquerda: private, public); socket: private; req.ip: public; outros cabeçalhos de IP: cf-connecting-ip.",
    );
    for (const ip of ["203.0.113.7", "10.0.0.5", "10.0.0.9"]) assert.ok(!line.includes(ip));
    assert.ok(PROXY_IP_HEADERS.includes("forwarded"));
  });
});
