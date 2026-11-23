import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { createApp, DISCORD_TOKEN_URL, parsePerMinute, parseTrustProxy, TOKEN_RATE_LIMIT } from "../app.js";

/*
 * Rotas HTTP do Express (GET /api/health e POST /api/token) com o app REAL e o Discord
 * substituído por um fetch controlado: nenhuma chamada externa durante a suíte.
 */

const CLIENT_ID = "1215413995645968394";
const CLIENT_SECRET = "fake-client-secret-not-real-0123456789";
const ACCESS_TOKEN = "fake-access-token-not-real";

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** fetch do Discord simulado: registra as chamadas e responde com `handler`. */
function fakeDiscord(handler = () => json(200, { access_token: ACCESS_TOKEN, token_type: "Bearer" })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: new URLSearchParams(init.body), headers: init.headers, signal: init.signal });
    return handler(calls.at(-1));
  };
  return { calls, fetchImpl };
}

function silentLogger() {
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(" "));
  return { lines, error: log, warn: log, info: log, log };
}

const servers = [];
after(async () => {
  for (const { server, app } of servers) {
    app.locals.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function start(options = {}) {
  const logger = options.logger ?? silentLogger();
  const app = createApp({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, chatConfigured: true, logger, ...options });
  const server = http.createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push({ server, app });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = {}) =>
    fetch(`${base}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { base, post, logger };
}

const read = async (response) => ({ status: response.status, body: await response.json(), headers: response.headers });

describe("GET /api/health", () => {
  test("configurado: ok, OAuth e chat disponíveis, sem revelar valores", async () => {
    const { base } = await start();
    const { status, body } = await read(await fetch(`${base}/api/health`));
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, oauthConfigured: true, chatConfigured: true });
  });

  test("sem credenciais: continua no ar e informa o que falta", async () => {
    const { base } = await start({ clientId: null, clientSecret: null, chatConfigured: false });
    const { status, body } = await read(await fetch(`${base}/api/health`));
    assert.equal(status, 200);
    assert.deepEqual(body, { ok: true, oauthConfigured: false, chatConfigured: false });
  });

  test("não expõe cabeçalho x-powered-by", async () => {
    const { base } = await start();
    const response = await fetch(`${base}/api/health`);
    assert.equal(response.headers.get("x-powered-by"), null);
  });
});

describe("POST /api/token", () => {
  test("sucesso: troca o código no Discord e devolve só o access_token", async () => {
    const discord = fakeDiscord();
    const { post } = await start({ fetchImpl: discord.fetchImpl });
    const { status, body } = await read(await post({ code: "codigo-valido" }));

    assert.equal(status, 200);
    assert.deepEqual(body, { access_token: ACCESS_TOKEN });
    assert.equal(discord.calls.length, 1);
    const [call] = discord.calls;
    assert.equal(call.url, DISCORD_TOKEN_URL);
    assert.equal(call.headers["Content-Type"], "application/x-www-form-urlencoded");
    assert.deepEqual(Object.fromEntries(call.body), {
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "authorization_code",
      code: "codigo-valido",
    });
    assert.ok(call.signal instanceof AbortSignal, "a chamada ao Discord tem prazo");
  });

  test("sem credenciais OAuth: 500 server_misconfigured, sem chamar o Discord", async () => {
    const discord = fakeDiscord();
    const { post } = await start({ clientSecret: null, fetchImpl: discord.fetchImpl });
    const { status, body } = await read(await post({ code: "x" }));
    assert.equal(status, 500);
    assert.equal(body.error, "server_misconfigured");
    assert.equal(discord.calls.length, 0);
  });

  test("parâmetros inválidos: 400 invalid_request, sem chamar o Discord", async () => {
    const discord = fakeDiscord();
    const { post } = await start({ fetchImpl: discord.fetchImpl });
    for (const body of [{}, { code: "" }, { code: "   " }, { code: 123 }, { code: null }, { code: ["a"] }]) {
      const result = await read(await post(body));
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(result.body.error, "invalid_request");
    }
    assert.equal(discord.calls.length, 0);
  });

  test("JSON inválido: 400; corpo grande demais: 413 (sem stack trace)", async () => {
    const { post } = await start({ fetchImpl: fakeDiscord().fetchImpl });
    const invalid = await read(await post("{não é json"));
    assert.equal(invalid.status, 400);
    assert.deepEqual(Object.keys(invalid.body).sort(), ["error", "message"]);
    const large = await read(await post({ code: "x".repeat(200_000) }));
    assert.equal(large.status, 413);
    assert.equal(large.body.error, "payload_too_large");
  });

  test("código recusado (invalid_grant): 400 com só o código público do OAuth", async () => {
    const discord = fakeDiscord(() => json(400, { error: "invalid_grant", error_description: "Invalid code" }));
    const { post, logger } = await start({ fetchImpl: discord.fetchImpl });
    const { status, body } = await read(await post({ code: "usado" }));
    assert.equal(status, 400);
    assert.deepEqual(body, { error: "token_exchange_failed", discordError: "invalid_grant", message: body.message });
    assert.ok(!JSON.stringify(body).includes("Invalid code"), "não repassa a descrição do Discord");
    assert.ok(logger.lines.every((line) => !line.includes(CLIENT_SECRET)));
  });

  test("Discord indisponível (5xx): 502 token_exchange_failed", async () => {
    const discord = fakeDiscord(() => new Response("bad gateway", { status: 503 }));
    const { post } = await start({ fetchImpl: discord.fetchImpl });
    const { status, body } = await read(await post({ code: "x" }));
    assert.equal(status, 502);
    assert.equal(body.error, "token_exchange_failed");
    assert.equal(body.discordError, "unknown_error");
  });

  test("Discord responde 200 sem access_token: 502", async () => {
    const discord = fakeDiscord(() => json(200, { token_type: "Bearer" }));
    const { post } = await start({ fetchImpl: discord.fetchImpl });
    const { status } = await read(await post({ code: "x" }));
    assert.equal(status, 502);
  });

  test("falha de rede ao contatar o Discord: 502 discord_unreachable; log sem detalhes", async () => {
    const discord = fakeDiscord(() => {
      throw new TypeError(`request to ${DISCORD_TOKEN_URL} failed, reason: getaddrinfo ENOTFOUND client_secret=${CLIENT_SECRET}`);
    });
    const { post, logger } = await start({ fetchImpl: discord.fetchImpl });
    const { status, body } = await read(await post({ code: "x" }));
    assert.equal(status, 502);
    assert.equal(body.error, "discord_unreachable");
    assert.deepEqual(logger.lines, ["[oauth] Falha de rede ao contatar o Discord (TypeError)."]);
  });

  test("Discord lento: a troca respeita o prazo e responde 502", async () => {
    const discord = fakeDiscord(
      ({ signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );
    const { post } = await start({ fetchImpl: discord.fetchImpl, tokenExchangeTimeoutMs: 50 });
    const { status, body } = await read(await post({ code: "x" }));
    assert.equal(status, 502);
    assert.equal(body.error, "discord_unreachable");
  });

  test("respostas nunca contêm o Client Secret", async () => {
    const discord = fakeDiscord((call) => json(400, { error: "invalid_client", echoed: call.body.get("client_secret") }));
    const { post } = await start({ fetchImpl: discord.fetchImpl });
    const response = await post({ code: "x" });
    assert.ok(!(await response.text()).includes(CLIENT_SECRET));
  });
});

describe("POST /api/token — rate limit", () => {
  /** Relógio controlado pelo teste. */
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms) => (t += ms) };
  };

  test("uso normal (algumas aberturas e novas tentativas) nunca é bloqueado", async () => {
    const time = clock();
    const discord = fakeDiscord();
    const { post } = await start({ fetchImpl: discord.fetchImpl, now: time.now });
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await post({ code: `c${i}` })).status, 200);
      time.advance(5_000);
    }
  });

  test(`acima de ${TOKEN_RATE_LIMIT.limit} por minuto do mesmo cliente: 429 com Retry-After; o Discord não é chamado`, async () => {
    const time = clock();
    const discord = fakeDiscord();
    const { post } = await start({ fetchImpl: discord.fetchImpl, now: time.now });
    for (let i = 0; i < TOKEN_RATE_LIMIT.limit; i += 1) assert.equal((await post({ code: `c${i}` })).status, 200);

    const blocked = await read(await post({ code: "excedente" }));
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error, "rate_limited");
    assert.equal(blocked.body.retryAfterMs, TOKEN_RATE_LIMIT.windowMs);
    assert.equal(blocked.headers.get("retry-after"), String(TOKEN_RATE_LIMIT.windowMs / 1000));
    assert.equal(discord.calls.length, TOKEN_RATE_LIMIT.limit);
  });

  test("requisições inválidas também contam (não dá para sondar a rota à vontade)", async () => {
    const time = clock();
    const { post } = await start({ fetchImpl: fakeDiscord().fetchImpl, now: time.now });
    for (let i = 0; i < TOKEN_RATE_LIMIT.limit; i += 1) assert.equal((await post({})).status, 400);
    assert.equal((await post({ code: "x" })).status, 429);
  });

  test("reset: a janela desliza e libera conforme as tentativas antigas expiram", async () => {
    const time = clock();
    const { post } = await start({ fetchImpl: fakeDiscord().fetchImpl, now: time.now });
    for (let i = 0; i < TOKEN_RATE_LIMIT.limit; i += 1) await post({ code: `c${i}` });
    assert.equal((await post({ code: "x" })).status, 429);
    time.advance(TOKEN_RATE_LIMIT.windowMs - 1);
    assert.equal((await post({ code: "x" })).status, 429);
    time.advance(1);
    assert.equal((await post({ code: "x" })).status, 200);
  });

  test("tentativas bloqueadas não estendem o bloqueio", async () => {
    const time = clock();
    const { post } = await start({ fetchImpl: fakeDiscord().fetchImpl, now: time.now });
    for (let i = 0; i < TOKEN_RATE_LIMIT.limit; i += 1) await post({ code: `c${i}` });
    for (let i = 0; i < 20; i += 1) await post({ code: "insistente" });
    time.advance(TOKEN_RATE_LIMIT.windowMs);
    assert.equal((await post({ code: "x" })).status, 200);
  });

  test("concorrência: rajada simultânea deixa passar exatamente o limite", async () => {
    const time = clock();
    const discord = fakeDiscord(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20)); // Discord "lento": requisições sobrepostas
      return json(200, { access_token: ACCESS_TOKEN });
    });
    const { post } = await start({ fetchImpl: discord.fetchImpl, now: time.now });
    const burst = TOKEN_RATE_LIMIT.limit + 15;
    const statuses = (await Promise.all(Array.from({ length: burst }, (_, i) => post({ code: `c${i}` })))).map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, TOKEN_RATE_LIMIT.limit);
    assert.equal(statuses.filter((s) => s === 429).length, burst - TOKEN_RATE_LIMIT.limit);
    assert.equal(discord.calls.length, TOKEN_RATE_LIMIT.limit);
  });

  test("sem proxy confiável (padrão), X-Forwarded-For forjado NÃO dribla o limite", async () => {
    const time = clock();
    const { post } = await start({ fetchImpl: fakeDiscord().fetchImpl, now: time.now });
    for (let i = 0; i < TOKEN_RATE_LIMIT.limit; i += 1) {
      assert.equal((await post({ code: `c${i}` }, { "X-Forwarded-For": `203.0.113.${i}` })).status, 200);
    }
    assert.equal((await post({ code: "x" }, { "X-Forwarded-For": "198.51.100.77" })).status, 429);
  });

  test("com 1 proxy confiável: o limite é por cliente real e um X-Forwarded-For forjado à esquerda é ignorado", async () => {
    const time = clock();
    const { post } = await start({ fetchImpl: fakeDiscord().fetchImpl, now: time.now, trustProxy: 1 });
    // O proxy acrescenta o IP real ao final; o que o cliente mandou fica à esquerda.
    const via = (real, forged) => ({ "X-Forwarded-For": forged ? `${forged}, ${real}` : real });
    for (let i = 0; i < TOKEN_RATE_LIMIT.limit; i += 1) {
      assert.equal((await post({ code: `a${i}` }, via("203.0.113.10", `10.0.0.${i}`))).status, 200);
    }
    assert.equal((await post({ code: "a" }, via("203.0.113.10", "1.2.3.4"))).status, 429, "mesmo cliente, forjando outro IP");
    assert.equal((await post({ code: "b" }, via("203.0.113.20"))).status, 200, "outro cliente não é bloqueado");
  });

  test("limite global protege a cota OAuth da aplicação mesmo com muitos IPs", async () => {
    const time = clock();
    const { post } = await start({
      fetchImpl: fakeDiscord().fetchImpl,
      now: time.now,
      trustProxy: 1,
      tokenGlobalRateLimit: { limit: 15, windowMs: 60_000 },
    });
    const statuses = [];
    for (let i = 0; i < 20; i += 1) statuses.push((await post({ code: `c${i}` }, { "X-Forwarded-For": `198.51.100.${i}` })).status);
    assert.deepEqual(statuses.slice(0, 15), Array(15).fill(200));
    assert.deepEqual(statuses.slice(15), Array(5).fill(429));
  });
});

describe("parseTrustProxy (TRUST_PROXY)", () => {
  test("padrão seguro: vazio, false ou 0 → não confia em proxy", () => {
    for (const raw of [undefined, "", "  ", "false", "0"]) assert.equal(parseTrustProxy(raw), false);
  });
  test("número de proxies e sub-redes", () => {
    assert.equal(parseTrustProxy("1"), 1);
    assert.equal(parseTrustProxy("2"), 2);
    assert.equal(parseTrustProxy("loopback"), "loopback");
    assert.equal(parseTrustProxy("10.0.0.0/8"), "10.0.0.0/8");
  });
  test('"true" é recusado (confiaria em qualquer X-Forwarded-For)', () => {
    assert.throws(() => parseTrustProxy("true"), /TRUST_PROXY=true/);
  });
});

describe("parsePerMinute (TOKEN_RATE_LIMIT / TOKEN_GLOBAL_RATE_LIMIT)", () => {
  test("vazio usa o padrão; inteiro vira limite por minuto", () => {
    assert.equal(parsePerMinute(undefined, TOKEN_RATE_LIMIT), TOKEN_RATE_LIMIT);
    assert.equal(parsePerMinute("  ", TOKEN_RATE_LIMIT), TOKEN_RATE_LIMIT);
    assert.deepEqual(parsePerMinute("60", TOKEN_RATE_LIMIT), { limit: 60, windowMs: 60_000 });
  });
  test("valores inválidos são recusados", () => {
    for (const raw of ["0", "-1", "abc", "1.5", "10001"]) {
      assert.throws(() => parsePerMinute(raw, TOKEN_RATE_LIMIT, "TOKEN_RATE_LIMIT"), /TOKEN_RATE_LIMIT/, raw);
    }
  });
});
