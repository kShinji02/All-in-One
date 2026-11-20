import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin } from "../chat/origin.js";

const CLIENT_ID = "123456789012345678";

test("aceita origens locais em qualquer porta", () => {
  for (const origin of ["http://localhost:5173", "http://127.0.0.1:3001", "http://[::1]:5173", "https://localhost"]) {
    assert.equal(isAllowedOrigin(origin), true, origin);
  }
});

test("aceita subdomínios do Cloudflare Tunnel apenas com HTTPS", () => {
  assert.equal(isAllowedOrigin("https://critical-purchasing-reducing-urw.trycloudflare.com"), true);
  assert.equal(isAllowedOrigin("https://novo.trycloudflare.com"), true);
  assert.equal(isAllowedOrigin("http://novo.trycloudflare.com"), false);
});

test("aceita somente o discordsays.com da própria aplicação", () => {
  assert.equal(isAllowedOrigin(`https://${CLIENT_ID}.discordsays.com`, { discordClientId: CLIENT_ID }), true);
  assert.equal(isAllowedOrigin("https://999.discordsays.com", { discordClientId: CLIENT_ID }), false);
  assert.equal(isAllowedOrigin(`https://${CLIENT_ID}.discordsays.com`), false, "sem client id configurado");
  assert.equal(isAllowedOrigin(`http://${CLIENT_ID}.discordsays.com`, { discordClientId: CLIENT_ID }), false);
});

test("recusa origens ausentes, inválidas ou de terceiros", () => {
  for (const origin of [
    undefined,
    "",
    "null",
    "not a url",
    "https://evil.com",
    "https://trycloudflare.com.evil.com",
    "https://eviltrycloudflare.com",
    "https://localhost.evil.com",
    "file:///etc/passwd",
    "ws://localhost:5173",
  ]) {
    assert.equal(isAllowedOrigin(origin, { discordClientId: CLIENT_ID }), false, String(origin));
  }
});
