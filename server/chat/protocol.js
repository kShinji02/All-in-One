import { randomUUID } from "node:crypto";
import { MAX_MESSAGE_LENGTH, MAX_NONCE_LENGTH } from "./config.js";

/**
 * Protocolo de mensagens do chat (Etapa 3).
 *
 * Cliente → servidor (após o ready):
 *   { type: "send", text: string, nonce?: string }
 *
 * Servidor → cliente:
 *   { type: "history", messages: ChatMessage[] }            logo após o ready
 *   { type: "message", message: ChatMessage, nonce? }       nonce só para quem enviou
 *   { type: "rate_limited", retryAfterMs, nonce? }
 *   { type: "error", code, nonce? }
 *
 * ChatMessage = { id, author: { id, username, displayName, avatarUrl }, text, createdAt }
 * O autor é sempre o usuário autenticado pelo servidor; o cliente nunca o informa.
 */

// Controles C0/C1 (exceto \n, tratado à parte) e caracteres de direção bidi,
// que permitiriam disfarçar o texto exibido (ex.: inverter trechos).
const CONTROL_CHARS = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;
const BIDI_CHARS = /[؜‎‏‪-‮⁦-⁩]/g;
const NONCE_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_NONCE_LENGTH}}$`);

/** Normaliza o texto: quebras de linha, controles, bidi, linhas em branco repetidas e espaços nas pontas. */
export function normalizeText(raw) {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, " ")
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CHARS, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Valida um frame {type:"send"}.
 * Devolve { ok: true, text, nonce } ou { ok: false, code, nonce }.
 * O nonce só é devolvido se for válido (nunca ecoa conteúdo arbitrário).
 */
export function parseSendFrame(frame) {
  const nonce = typeof frame.nonce === "string" && NONCE_PATTERN.test(frame.nonce) ? frame.nonce : undefined;
  if (frame.nonce !== undefined && nonce === undefined) return { ok: false, code: "invalid_nonce" };
  if (typeof frame.text !== "string") return { ok: false, code: "invalid_message", nonce };

  const text = normalizeText(frame.text);
  if (text.length === 0) return { ok: false, code: "empty_message", nonce };
  if (codePointLength(text) > MAX_MESSAGE_LENGTH) return { ok: false, code: "message_too_long", nonce };

  return { ok: true, text, nonce };
}

/** Cria a mensagem com id, horário e autor definidos pelo servidor. */
export function createMessage(author, text, now = Date.now) {
  return {
    id: randomUUID(),
    author: {
      id: author.id,
      username: author.username,
      displayName: author.displayName,
      avatarUrl: author.avatarUrl,
    },
    text,
    createdAt: new Date(now()).toISOString(),
  };
}

function codePointLength(text) {
  let count = 0;
  for (const _char of text) count += 1;
  return count;
}
