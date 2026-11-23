/**
 * Protocolo do chat em tempo real (client ↔ server em /api/chat).
 *
 * Espelha server/chat/protocol.js, server/chat/index.js e server/chat/config.js.
 * Tudo o que chega do servidor passa por `parseServerFrame`, que valida a forma e
 * os limites e devolve objetos limpos (campos desconhecidos são descartados).
 * O teste test/realtime/chat-protocol.compat.test.ts compara este arquivo com o
 * servidor real e falha se os dois divergirem.
 */

/* ------------------------------------------------------------------ *
 * Limites (iguais a server/chat/config.js)
 * ------------------------------------------------------------------ */
export const MAX_MESSAGE_LENGTH = 500; // code points
export const MAX_NONCE_LENGTH = 64;
export const HISTORY_LIMIT = 100;

/** Teto defensivo para um frame recebido (100 mensagens de 500 caracteres cabem com folga). */
export const MAX_SERVER_FRAME_BYTES = 512 * 1024;
/** Teto defensivo para o tempo de espera do rate limit (o servidor usa janelas de 10 s). */
export const MAX_RETRY_AFTER_MS = 60_000;

const NONCE_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${MAX_NONCE_LENGTH}}$`);
const SNOWFLAKE_PATTERN = /^\d{1,20}$/;
const MESSAGE_ID_PATTERN = /^[0-9a-f-]{36}$/;
const ERROR_CODE_PATTERN = /^[a-z_]{1,64}$/;
const AVATAR_PREFIX = 'https://cdn.discordapp.com/';
const MAX_NAME_LENGTH = 100;

/* ------------------------------------------------------------------ *
 * Tipos
 * ------------------------------------------------------------------ */
export interface ChatAuthor {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
}

export interface ChatMessage {
  id: string;
  author: ChatAuthor;
  text: string;
  /** ISO 8601, definido pelo servidor. */
  createdAt: string;
  /** Somente no histórico e somente nas mensagens do próprio usuário (Etapa 4.1). */
  nonce?: string;
}

/** Códigos de `{type:"error"}` que o servidor envia hoje. */
export const KNOWN_ERROR_CODES = [
  'empty_message',
  'invalid_message',
  'invalid_nonce',
  'message_too_long',
  'repeated_message',
  'unsupported_message',
] as const;
export type KnownErrorCode = (typeof KNOWN_ERROR_CODES)[number];

export type ServerFrame =
  | { type: 'ready'; self: ChatAuthor }
  | { type: 'history'; messages: ChatMessage[] }
  /** `nonce` só vem para a conexão que enviou (confirmação ou reenvio idempotente). */
  | { type: 'message'; message: ChatMessage; nonce?: string }
  | { type: 'rate_limited'; retryAfterMs: number; nonce?: string }
  /** `code` aceita valores futuros; `known` indica se é um dos códigos atuais. */
  | { type: 'error'; code: string; known: boolean; nonce?: string };

export type ServerFrameType = ServerFrame['type'];
export const SERVER_FRAME_TYPES: readonly ServerFrameType[] = ['ready', 'history', 'message', 'rate_limited', 'error'];

export type ClientFrame =
  | { type: 'auth'; accessToken: string; instanceId: string }
  | { type: 'send'; text: string; nonce?: string };

export type ParseFailure =
  | 'not_text'
  | 'too_large'
  | 'invalid_json'
  | 'not_object'
  | 'unknown_type'
  | 'invalid_fields';

export type ParseResult = { ok: true; frame: ServerFrame } | { ok: false; reason: ParseFailure; detail?: string };

/* ------------------------------------------------------------------ *
 * Validação
 * ------------------------------------------------------------------ */
type Json = Record<string, unknown>;

class FieldError extends Error {}

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

function field(condition: boolean, path: string): void {
  if (!condition) throw new FieldError(path);
}

function codePointLength(text: string): number {
  let count = 0;
  for (const _char of text) count += 1;
  return count;
}

function boundedString(value: unknown, path: string, max: number, min = 1): string {
  field(typeof value === 'string', path);
  const text = value as string;
  const length = codePointLength(text);
  field(length >= min && length <= max, path);
  return text;
}

function optionalNonce(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  field(typeof value === 'string' && NONCE_PATTERN.test(value), path);
  return value as string;
}

function parseAuthor(value: unknown, path: string): ChatAuthor {
  field(isObject(value), path);
  const author = value as Json;
  field(typeof author.id === 'string' && SNOWFLAKE_PATTERN.test(author.id), `${path}.id`);
  const avatarUrl = boundedString(author.avatarUrl, `${path}.avatarUrl`, 512);
  field(avatarUrl.startsWith(AVATAR_PREFIX), `${path}.avatarUrl`);
  return {
    id: author.id as string,
    username: boundedString(author.username, `${path}.username`, MAX_NAME_LENGTH),
    displayName: boundedString(author.displayName, `${path}.displayName`, MAX_NAME_LENGTH),
    avatarUrl,
  };
}

function parseMessage(value: unknown, path: string): ChatMessage {
  field(isObject(value), path);
  const message = value as Json;
  field(typeof message.id === 'string' && MESSAGE_ID_PATTERN.test(message.id), `${path}.id`);
  const createdAt = boundedString(message.createdAt, `${path}.createdAt`, 40);
  field(!Number.isNaN(Date.parse(createdAt)) && /^\d{4}-\d{2}-\d{2}T/.test(createdAt), `${path}.createdAt`);
  const parsed: ChatMessage = {
    id: message.id as string,
    author: parseAuthor(message.author, `${path}.author`),
    text: boundedString(message.text, `${path}.text`, MAX_MESSAGE_LENGTH),
    createdAt,
  };
  const nonce = optionalNonce(message.nonce, `${path}.nonce`);
  if (nonce !== undefined) parsed.nonce = nonce;
  return parsed;
}

function withNonce<T extends object>(frame: T, nonce: string | undefined): T & { nonce?: string } {
  return nonce === undefined ? frame : { ...frame, nonce };
}

function parseByType(data: Json): ServerFrame | null {
  switch (data.type) {
    case 'ready':
      return { type: 'ready', self: parseAuthor(data.self, 'self') };

    case 'history': {
      field(Array.isArray(data.messages), 'messages');
      const list = data.messages as unknown[];
      field(list.length <= HISTORY_LIMIT, 'messages.length');
      return { type: 'history', messages: list.map((m, i) => parseMessage(m, `messages[${i}]`)) };
    }

    case 'message':
      return withNonce({ type: 'message' as const, message: parseMessage(data.message, 'message') }, optionalNonce(data.nonce, 'nonce'));

    case 'rate_limited': {
      const ms = data.retryAfterMs;
      field(typeof ms === 'number' && Number.isInteger(ms) && ms > 0 && ms <= MAX_RETRY_AFTER_MS, 'retryAfterMs');
      return withNonce({ type: 'rate_limited' as const, retryAfterMs: ms as number }, optionalNonce(data.nonce, 'nonce'));
    }

    case 'error': {
      field(typeof data.code === 'string' && ERROR_CODE_PATTERN.test(data.code), 'code');
      const code = data.code as string;
      return withNonce(
        { type: 'error' as const, code, known: (KNOWN_ERROR_CODES as readonly string[]).includes(code) },
        optionalNonce(data.nonce, 'nonce'),
      );
    }

    default:
      return null;
  }
}

/**
 * Valida um frame recebido do servidor. Nunca lança erro: frames inválidos
 * devolvem { ok:false, reason } para serem descartados sem derrubar a interface.
 */
export function parseServerFrame(raw: unknown): ParseResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_text' };
  if (raw.length > MAX_SERVER_FRAME_BYTES) return { ok: false, reason: 'too_large' };

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
  if (!isObject(data) || typeof data.type !== 'string') return { ok: false, reason: 'not_object' };

  try {
    const frame = parseByType(data);
    return frame ? { ok: true, frame } : { ok: false, reason: 'unknown_type', detail: data.type.slice(0, 64) };
  } catch (error) {
    if (error instanceof FieldError) return { ok: false, reason: 'invalid_fields', detail: error.message };
    throw error;
  }
}

/* ------------------------------------------------------------------ *
 * Frames do cliente
 * ------------------------------------------------------------------ */
export function encodeAuth(accessToken: string, instanceId: string): string {
  const frame: ClientFrame = { type: 'auth', accessToken, instanceId };
  return JSON.stringify(frame);
}

export function isValidNonce(nonce: string): boolean {
  return NONCE_PATTERN.test(nonce);
}

/** Codifica um envio. Lança se o nonce for inválido (erro de programação do cliente). */
export function encodeSend(text: string, nonce?: string): string {
  if (nonce !== undefined && !isValidNonce(nonce)) throw new Error('nonce inválido');
  const frame: ClientFrame = nonce === undefined ? { type: 'send', text } : { type: 'send', text, nonce };
  return JSON.stringify(frame);
}
