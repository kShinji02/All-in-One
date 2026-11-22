import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_PORT,
  PRODUCTION_HOST,
  deploymentWarnings,
  describeListen,
  resolveHost,
  resolveListenOptions,
  resolvePort,
} from "../runtime-config.js";
import { countForwardedFor, createApp, PROXY_DIAGNOSTICS_MAX_LOGS } from "../app.js";

const SERVER_JS = fileURLToPath(new URL("../server.js", import.meta.url));

describe("resolvePort", () => {
  test("sem PORT usa 3001 (desenvolvimento local)", () => {
    assert.equal(DEFAULT_PORT, 3001);
    assert.equal(resolvePort(undefined), 3001);
    assert.equal(resolvePort(""), 3001);
    assert.equal(resolvePort("   "), 3001);
  });

  test("usa a PORT do ambiente (o Render define 10000 por padrão)", () => {
    assert.equal(resolvePort("10000"), 10000);
    assert.equal(resolvePort(" 8080 "), 8080);
  });

  test("PORT inválida encerra a inicialização com mensagem clara", () => {
    for (const value of ["abc", "0", "65536", "-1", "3001.5", "1e3"]) {
      assert.throws(() => resolvePort(value), /PORT deve ser um inteiro entre 1 e 65535/, value);
    }
  });
});

describe("resolveHost", () => {
  test("produção e Render escutam em 0.0.0.0", () => {
    assert.equal(PRODUCTION_HOST, "0.0.0.0");
    assert.equal(resolveHost({ NODE_ENV: "production" }), "0.0.0.0");
    assert.equal(resolveHost({ RENDER: "true" }), "0.0.0.0");
  });

  test("desenvolvimento mantém o padrão do Node (IPv4 e IPv6, compatível com o proxy do Vite)", () => {
    assert.equal(resolveHost({}), undefined);
    assert.equal(resolveHost({ NODE_ENV: "development" }), undefined);
  });

  test("HOST explícito tem prioridade", () => {
    assert.equal(resolveHost({ HOST: "127.0.0.1", NODE_ENV: "production" }), "127.0.0.1");
  });

  test("resolveListenOptions combina porta e interface", () => {
    assert.deepEqual(resolveListenOptions({ PORT: "10000", RENDER: "true", NODE_ENV: "production" }), { port: 10000, host: "0.0.0.0" });
    assert.deepEqual(resolveListenOptions({}), { port: 3001, host: undefined });
    assert.equal(describeListen({ port: 10000, host: "0.0.0.0" }), "0.0.0.0:10000");
    assert.match(describeListen({ port: 3001, host: undefined }), /porta 3001/);
  });
});

describe("deploymentWarnings", () => {
  test("nenhum aviso no desenvolvimento local", () => {
    assert.deepEqual(deploymentWarnings({}), []);
  });

  test("produção sem TRUST_PROXY avisa (todos compartilhariam o IP do proxy)", () => {
    const warnings = deploymentWarnings({ NODE_ENV: "production" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /TRUST_PROXY/);
  });

  test("Render sem NODE_ENV=production avisa que o chat aceitaria origens de desenvolvimento", () => {
    const warnings = deploymentWarnings({ RENDER: "true", TRUST_PROXY: "1" });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /NODE_ENV/);
  });

  test("configuração de produção completa não gera avisos", () => {
    assert.deepEqual(deploymentWarnings({ RENDER: "true", NODE_ENV: "production", TRUST_PROXY: "1" }), []);
  });
});

describe("PROXY_DIAGNOSTICS", () => {
  test("countForwardedFor conta entradas sem expor endereços", () => {
    assert.equal(countForwardedFor(undefined), 0);
    assert.equal(countForwardedFor(""), 0);
    assert.equal(countForwardedFor("203.0.113.7"), 1);
    assert.equal(countForwardedFor("203.0.113.7, 10.0.0.1"), 2);
    assert.equal(countForwardedFor(["203.0.113.7", "10.0.0.1, 10.0.0.2"]), 3);
  });

  test("ligado: registra só a contagem, no máximo N vezes; desligado: nada", async () => {
    for (const enabled of [true, false]) {
      const logs = [];
      const logger = { log: (line) => logs.push(line), warn() {}, error() {} };
      const app = createApp({ logger, proxyDiagnostics: enabled });
      const server = app.listen(0, "127.0.0.1");
      await once(server, "listening");
      const { port } = server.address();
      try {
        for (let i = 0; i < PROXY_DIAGNOSTICS_MAX_LOGS + 3; i += 1) {
          const response = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { "x-forwarded-for": "203.0.113.7, 198.51.100.9" } });
          assert.equal(response.status, 200);
        }
      } finally {
        server.close();
      }
      if (!enabled) {
        assert.deepEqual(logs, []);
        continue;
      }
      assert.equal(logs.length, PROXY_DIAGNOSTICS_MAX_LOGS);
      assert.ok(logs.every((line) => line.includes("2 entrada(s)")));
      assert.ok(logs.every((line) => !line.includes("203.0.113.7") && !line.includes("198.51.100.9")), "nenhum IP no log");
    }
  });
});

// ---------------------------------------------------------------------------
// Inicialização real de server.js (processo separado), como no Render.
// ---------------------------------------------------------------------------

const FAKE = Object.freeze({
  VITE_DISCORD_CLIENT_ID: "123456789012345678",
  DISCORD_CLIENT_SECRET: "fake-client-secret-never-logged",
  DISCORD_BOT_TOKEN: "fake-bot-token-never-logged",
});

const DEPLOY_KEYS = ["NODE_ENV", "RENDER", "PORT", "HOST", "TRUST_PROXY", "ORIGIN_PROFILE", "CHAT_EXTRA_ORIGINS", "TOKEN_RATE_LIMIT", "TOKEN_GLOBAL_RATE_LIMIT", "PROXY_DIAGNOSTICS"];

async function freePort() {
  const probe = net.createServer().listen(0, "127.0.0.1");
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Inicia server.js com um ambiente controlado. As credenciais são sempre definidas aqui
 * (falsas ou vazias), então o .env local nunca é usado: o dotenv não sobrescreve variáveis
 * já presentes no ambiente.
 */
function startServer(overrides) {
  const env = { ...process.env };
  for (const key of DEPLOY_KEYS) delete env[key];
  Object.assign(env, FAKE, overrides);
  const child = spawn(process.execPath, [SERVER_JS], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const waitFor = (pattern, timeoutMs = 8_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`sem "${pattern}" na saída:\n${output}`)), timeoutMs);
      const check = () => {
        if (pattern.test(output)) {
          clearTimeout(timer);
          child.stdout.off("data", check);
          resolve(output);
        }
      };
      child.stdout.on("data", check);
      check();
    });
  return { child, waitFor, output: () => output };
}

describe("server.js em modo de produção (Render)", () => {
  test("escuta em 0.0.0.0 na PORT recebida, responde /api/health e não registra segredos", async () => {
    const port = await freePort();
    const server = startServer({ NODE_ENV: "production", RENDER: "true", PORT: String(port), TRUST_PROXY: "1" });
    try {
      await server.waitFor(new RegExp(`Server listening on 0\\.0\\.0\\.0:${port}`));
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { ok: true, oauthConfigured: true, chatConfigured: true });

      const output = server.output();
      assert.match(output, /perfil "production"/);
      assert.doesNotMatch(output, /\[config\] TRUST_PROXY não definido/);
      for (const secret of [FAKE.DISCORD_CLIENT_SECRET, FAKE.DISCORD_BOT_TOKEN]) {
        assert.ok(!output.includes(secret), "segredo não aparece no log");
      }
    } finally {
      server.child.kill();
      await once(server.child, "exit");
    }
  });

  test("WebSocket do chat responde na mesma porta e recusa origem fora do discordsays.com", async () => {
    const port = await freePort();
    const server = startServer({ NODE_ENV: "production", RENDER: "true", PORT: String(port), TRUST_PROXY: "1" });
    try {
      await server.waitFor(/Server listening on/);
      const status = async (origin) => {
        const socket = net.connect(port, "127.0.0.1");
        await once(socket, "connect");
        socket.write(
          "GET /api/chat HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
            `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`,
        );
        const [chunk] = await once(socket, "data");
        socket.destroy();
        return chunk.toString().split("\r\n")[0];
      };
      assert.match(await status(`https://${FAKE.VITE_DISCORD_CLIENT_ID}.discordsays.com`), /101 Switching Protocols/);
      assert.match(await status("http://localhost:5173"), /403/, "produção não aceita origem local");
      assert.match(await status("https://abc.trycloudflare.com"), /403/, "produção não aceita túnel");
    } finally {
      server.child.kill();
      await once(server.child, "exit");
    }
  });

  test("sem TRUST_PROXY e sem NODE_ENV no Render, avisa na inicialização", async () => {
    const port = await freePort();
    const server = startServer({ RENDER: "true", PORT: String(port) });
    try {
      const output = await server.waitFor(/Server listening on 0\.0\.0\.0/);
      assert.match(output, /\[config\] TRUST_PROXY não definido/);
      assert.match(output, /\[config\] NODE_ENV não é "production"/);
    } finally {
      server.child.kill();
      await once(server.child, "exit");
    }
  });

  test("PORT inválida encerra o processo com erro (não escuta numa porta inesperada)", async () => {
    const server = startServer({ NODE_ENV: "production", PORT: "abc" });
    const [code] = await once(server.child, "exit");
    assert.notEqual(code, 0);
    assert.match(server.output(), /PORT deve ser um inteiro/);
  });

  test("TRUST_PROXY=true continua recusado em produção", async () => {
    const server = startServer({ NODE_ENV: "production", PORT: String(await freePort()), TRUST_PROXY: "true" });
    const [code] = await once(server.child, "exit");
    assert.notEqual(code, 0);
    assert.match(server.output(), /TRUST_PROXY=true/);
  });

  test("SIGTERM (parada do Render) encerra de forma limpa", { skip: process.platform === "win32" && "sinais POSIX indisponíveis no Windows" }, async () => {
    const port = await freePort();
    const server = startServer({ NODE_ENV: "production", PORT: String(port), TRUST_PROXY: "1" });
    await server.waitFor(/Server listening on/);
    server.child.kill("SIGTERM");
    const [code] = await once(server.child, "exit");
    assert.equal(code, 0);
    assert.match(server.output(), /SIGTERM recebido/);
  });
});
