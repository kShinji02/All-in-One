import { test } from "node:test";
import assert from "node:assert/strict";
import { createMessage, normalizeText, parseSendFrame } from "../chat/protocol.js";

test("normalizeText: quebras de linha, tab, controles, bidi, linhas vazias repetidas e pontas", () => {
  assert.equal(normalizeText("a\r\nb\rc"), "a\nb\nc");
  assert.equal(normalizeText("a\tb"), "a b");
  assert.equal(normalizeText("a\u0000b\u0007c\u001Bd\u007Fe\u0085f"), "abcdef");
  assert.equal(normalizeText("abc‮def⁦g‏h"), "abcdefgh");
  assert.equal(normalizeText("a\n\n\n\n\nb"), "a\n\nb");
  assert.equal(normalizeText("   oi   "), "oi");
});

test("parseSendFrame: mensagem válida com e sem nonce", () => {
  assert.deepEqual(parseSendFrame({ type: "send", text: "  olá  " }), { ok: true, text: "olá", nonce: undefined });
  assert.deepEqual(parseSendFrame({ type: "send", text: "olá", nonce: "abc_123-X" }), { ok: true, text: "olá", nonce: "abc_123-X" });
});

test("parseSendFrame: nonce inválido é recusado e não é ecoado", () => {
  for (const nonce of ["", "com espaço", "<script>", "x".repeat(65), 123, null]) {
    assert.deepEqual(parseSendFrame({ type: "send", text: "oi", nonce }), { ok: false, code: "invalid_nonce" }, String(nonce));
  }
});

test("parseSendFrame: texto ausente ou não textual", () => {
  for (const text of [undefined, null, 1, {}, ["a"]]) {
    assert.equal(parseSendFrame({ type: "send", text }).code, "invalid_message");
  }
});

test("parseSendFrame: texto vazio depois da normalização", () => {
  for (const text of ["", "   ", "\n\n", "\u0000\u0001", "‮⁦", "\t \r\n"]) {
    assert.equal(parseSendFrame({ type: "send", text, nonce: "n1" }).code, "empty_message", JSON.stringify(text));
    assert.equal(parseSendFrame({ type: "send", text, nonce: "n1" }).nonce, "n1");
  }
});

test("parseSendFrame: limite de 500 caracteres contado em code points", () => {
  assert.equal(parseSendFrame({ type: "send", text: "a".repeat(500) }).ok, true);
  assert.equal(parseSendFrame({ type: "send", text: "a".repeat(501) }).code, "message_too_long");
  // Emoji ocupa 2 unidades UTF-16, mas conta como 1 caractere.
  assert.equal(parseSendFrame({ type: "send", text: "😀".repeat(500) }).ok, true);
  assert.equal(parseSendFrame({ type: "send", text: "😀".repeat(501) }).code, "message_too_long");
  // Espaços nas pontas não contam (o limite vale para o texto normalizado).
  assert.equal(parseSendFrame({ type: "send", text: `  ${"a".repeat(500)}  ` }).ok, true);
});

test("parseSendFrame: HTML é preservado como texto (a interface renderiza só texto)", () => {
  assert.equal(parseSendFrame({ type: "send", text: "<img src=x onerror=alert(1)>" }).text, "<img src=x onerror=alert(1)>");
});

test("createMessage: id, horário e autor definidos pelo servidor, só com campos públicos", () => {
  const author = { id: "1", username: "ana", displayName: "Ana", avatarUrl: "https://cdn.discordapp.com/x.png", accessToken: "segredo" };
  const message = createMessage(author, "oi", () => Date.UTC(2026, 10, 19, 12, 0, 0));
  assert.match(message.id, /^[0-9a-f-]{36}$/);
  assert.equal(message.createdAt, "2026-11-19T12:00:00.000Z");
  assert.deepEqual(message.author, { id: "1", username: "ana", displayName: "Ana", avatarUrl: "https://cdn.discordapp.com/x.png" });
  assert.equal(message.text, "oi");
  assert.notEqual(createMessage(author, "oi").id, createMessage(author, "oi").id);
});
