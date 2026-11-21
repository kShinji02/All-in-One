/**
 * Store das mensagens do chat (sem React).
 *
 * Duas coleções, com chaves diferentes:
 * - confirmadas: vindas do servidor ("history" e "message"), indexadas pelo `id`
 *   do servidor. Deduplicação por id; no máximo HISTORY_LIMIT (as mais recentes).
 * - locais: envios otimistas ainda não confirmados ("pending") ou que falharam
 *   ("failed"), indexados pelo nonce gerado aqui.
 *
 * Reconciliação usa apenas a evidência do servidor, a mesma da idempotência do
 * backend (server/chat/rooms.js): o `nonce` que volta na confirmação para a conexão
 * que enviou, ou no histórico, só nas mensagens do próprio usuário. Reenviar usa o
 * MESMO nonce; se o servidor já tinha publicado, devolve a mensagem original em vez
 * de publicar outra. Não há um segundo mecanismo de idempotência no cliente.
 *
 * A store não conhece o token nem o WebSocket: recebe frames já validados por
 * parseServerFrame (via ChatConnection) e envia por um `MessageTransport`.
 */
import type { ChatConnectionState, Timers } from '@/realtime/chat-connection';
import {
  HISTORY_LIMIT,
  isValidNonce,
  MAX_MESSAGE_LENGTH,
  type ChatAuthor,
  type ChatMessage,
  type ServerFrame,
} from '@/realtime/chat-protocol';

/* ------------------------------------------------------------------ *
 * Limites
 * ------------------------------------------------------------------ */
/** Envios automáticos por mensagem (1º envio + reenvios após queda ou rate limit). */
export const MAX_SEND_ATTEMPTS = 3;
/** Sem resposta do servidor nesse prazo, com a conexão aberta, o envio é dado como falho. */
export const ACK_TIMEOUT_MS = 10_000;
/** Mensagens locais (pendentes + falhas) ao mesmo tempo. */
export const MAX_OUTSTANDING = 20;

/* ------------------------------------------------------------------ *
 * Tipos públicos
 * ------------------------------------------------------------------ */
export type SendStatus = 'pending' | 'sent' | 'failed';

export type FailureReason =
  /** O servidor recusou o conteúdo ({type:"error"} com o nonce). Repetir não adianta. */
  | 'rejected'
  /** Limite de envio do servidor e as tentativas automáticas acabaram. */
  | 'rate_limited'
  /** A conexão estava aberta, mas o servidor não respondeu no prazo. */
  | 'timeout'
  /** A conexão parou de vez (sessão expirada, saiu da Activity...). */
  | 'connection_lost'
  /** Enviada, a conexão caiu antes da resposta e as tentativas acabaram sem prova de publicação. */
  | 'unconfirmed';

export interface SendFailure {
  reason: FailureReason;
  /** Código do servidor quando reason = "rejected" (ex.: "message_too_long"). */
  code: string | null;
  /** Se `retry(key)` faz sentido (o reenvio usa o mesmo nonce). */
  retryable: boolean;
}

export interface ChatEntry {
  /** Chave estável para a interface: não muda quando a mensagem local é confirmada. */
  key: string;
  status: SendStatus;
  /** id do servidor; null enquanto não confirmada. */
  id: string | null;
  /** Nonce das mensagens do próprio usuário (quando conhecido). */
  nonce: string | null;
  text: string;
  /** Autor confirmado pelo servidor; nas locais, o próprio usuário (null antes do "ready"). */
  author: ChatAuthor | null;
  own: boolean;
  /** Horário do servidor nas confirmadas; horário local nas pendentes. */
  createdAt: string;
  /** Vezes que o frame foi entregue ao socket. */
  attempts: number;
  failure: SendFailure | null;
}

export interface MessageStoreSnapshot {
  /** Confirmadas em ordem cronológica, seguidas das locais na ordem de envio. */
  messages: readonly ChatEntry[];
  self: ChatAuthor | null;
}

/** O mínimo que a store precisa da conexão. `ChatConnection` satisfaz este contrato. */
export interface MessageTransport {
  /** true = frame entregue ao socket (não é confirmação). */
  send(text: string, nonce: string): boolean;
}

export type SendResult =
  | { ok: true; key: string; nonce: string }
  | { ok: false; reason: 'empty' | 'too_long' | 'too_many_pending' | 'disposed' };

export interface MessageStore {
  getSnapshot(): MessageStoreSnapshot;
  /** O listener é chamado após cada mudança. Devolve a função que cancela. */
  subscribe(listener: () => void): () => void;
  /** Envio otimista: entra na lista como "pending" na hora. */
  send(text: string): SendResult;
  /** Nova tentativa de uma mensagem "failed" com retryable = true, com o MESMO nonce. */
  retry(key: string): boolean;
  /** Remove da lista uma mensagem "failed" (só localmente). */
  discard(key: string): boolean;
  /** Frames já validados por parseServerFrame. */
  handleFrame(frame: ServerFrame): void;
  handleConnectionState(state: ChatConnectionState): void;
  /** Cancela timers e assinaturas. Depois disso, nada mais muda. */
  dispose(): void;
}

export interface MessageStoreOptions {
  transport: MessageTransport;
  generateNonce?: () => string;
  timers?: Timers;
  now?: () => number;
  /** Prazo da confirmação com a conexão aberta (padrão ACK_TIMEOUT_MS). */
  ackTimeoutMs?: number;
}

/* ------------------------------------------------------------------ *
 * Implementação
 * ------------------------------------------------------------------ */
interface ConfirmedRecord {
  key: string;
  seq: number;
  message: ChatMessage;
  nonce: string | null;
  attempts: number;
  view: ChatEntry | null;
}

interface LocalRecord {
  key: string;
  seq: number;
  nonce: string;
  text: string;
  createdAt: string;
  status: 'pending' | 'failed';
  failure: SendFailure | null;
  attempts: number;
  /** Frame entregue ao socket e ainda sem resposta nesta conexão. */
  inFlight: boolean;
  ackTimer: unknown;
  retryTimer: unknown;
  view: ChatEntry | null;
}

const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

const defaultNonce = () => globalThis.crypto.randomUUID();

const EMPTY: MessageStoreSnapshot = Object.freeze({ messages: Object.freeze([]), self: null });

export function createMessageStore(options: MessageStoreOptions): MessageStore {
  const {
    transport,
    generateNonce = defaultNonce,
    timers = defaultTimers,
    now = Date.now,
    ackTimeoutMs = ACK_TIMEOUT_MS,
  } = options;

  const confirmed = new Map<string, ConfirmedRecord>(); // id → registro
  const local = new Map<string, LocalRecord>(); // nonce → registro
  const listeners = new Set<() => void>();
  let self: ChatAuthor | null = null;
  let seq = 0;
  /** Sala aberta ("ready") nesta conexão. */
  let connectionReady = false;
  /** O histórico desta conexão já chegou: só então os pendentes são (re)enviados. */
  let historyReceived = false;
  let snapshot = EMPTY;
  let dirty = false;
  let disposed = false;

  const isOwn = (author: ChatAuthor) => self !== null && author.id === self.id;

  /* ---------------- snapshot ---------------- */
  function confirmedView(record: ConfirmedRecord): ChatEntry {
    record.view ??= Object.freeze({
      key: record.key,
      status: 'sent' as const,
      id: record.message.id,
      nonce: record.nonce,
      text: record.message.text,
      author: record.message.author,
      own: isOwn(record.message.author),
      createdAt: record.message.createdAt,
      attempts: record.attempts,
      failure: null,
    });
    return record.view;
  }

  function localView(record: LocalRecord): ChatEntry {
    record.view ??= Object.freeze({
      key: record.key,
      status: record.status,
      id: null,
      nonce: record.nonce,
      text: record.text,
      author: self,
      own: true,
      createdAt: record.createdAt,
      attempts: record.attempts,
      failure: record.failure,
    });
    return record.view;
  }

  function sortedConfirmed(): ConfirmedRecord[] {
    return [...confirmed.values()].sort(
      (a, b) => Date.parse(a.message.createdAt) - Date.parse(b.message.createdAt) || a.seq - b.seq,
    );
  }

  function emit() {
    if (!dirty || disposed) return;
    dirty = false;
    const messages = [
      ...sortedConfirmed().map(confirmedView),
      ...[...local.values()].sort((a, b) => a.seq - b.seq).map(localView),
    ];
    snapshot = Object.freeze({ messages: Object.freeze(messages), self });
    for (const listener of [...listeners]) listener();
  }

  function touchLocal(record: LocalRecord) {
    record.view = null;
    dirty = true;
  }

  /* ---------------- confirmadas ---------------- */
  /** Aplica uma mensagem confirmada pelo servidor; reconcilia a local de mesmo nonce. */
  function acceptConfirmed(message: ChatMessage, frameNonce: string | undefined) {
    const nonce = frameNonce ?? message.nonce ?? null;
    const own = isOwn(message.author);
    const pendingLocal = nonce !== null && own ? local.get(nonce) : undefined;
    const existing = confirmed.get(message.id);

    if (pendingLocal) {
      clearTimers(pendingLocal);
      local.delete(pendingLocal.nonce);
      dirty = true;
    }
    // Duplicata (mesmo id): mantém o registro e a chave que já estão na lista.
    if (existing && !pendingLocal) return;

    confirmed.set(message.id, {
      key: existing?.key ?? pendingLocal?.key ?? `m:${message.id}`,
      seq: existing?.seq ?? ++seq,
      message,
      nonce: own ? nonce : null,
      attempts: pendingLocal?.attempts ?? existing?.attempts ?? 0,
      view: null,
    });
    dirty = true;
    enforceLimit();
  }

  function enforceLimit() {
    if (confirmed.size <= HISTORY_LIMIT) return;
    for (const record of sortedConfirmed().slice(0, confirmed.size - HISTORY_LIMIT)) {
      confirmed.delete(record.message.id);
    }
  }

  /* ---------------- locais ---------------- */
  function clearTimers(record: LocalRecord) {
    if (record.ackTimer !== null) timers.clearTimeout(record.ackTimer);
    if (record.retryTimer !== null) timers.clearTimeout(record.retryTimer);
    record.ackTimer = null;
    record.retryTimer = null;
  }

  function fail(record: LocalRecord, reason: FailureReason, code: string | null, retryable: boolean) {
    clearTimers(record);
    record.inFlight = false;
    record.status = 'failed';
    record.failure = { reason, code, retryable };
    touchLocal(record);
  }

  /** Entrega o frame ao socket se a sala estiver aberta e o histórico já tiver chegado. */
  function transmit(record: LocalRecord) {
    if (!connectionReady || !historyReceived || record.status !== 'pending' || record.inFlight) return;
    let delivered = false;
    try {
      delivered = transport.send(record.text, record.nonce);
    } catch {
      delivered = false;
    }
    if (!delivered) return; // continua pendente; a próxima abertura da sala tenta de novo
    record.attempts += 1;
    record.inFlight = true;
    record.ackTimer = timers.setTimeout(() => {
      record.ackTimer = null;
      if (record.status === 'pending' && record.inFlight) {
        fail(record, 'timeout', null, true);
        emit();
      }
    }, ackTimeoutMs);
    touchLocal(record);
  }

  /** Depois do histórico: reenvia o que não foi confirmado, dentro do limite de tentativas. */
  function flush() {
    for (const record of [...local.values()].sort((a, b) => a.seq - b.seq)) {
      if (record.status !== 'pending' || record.inFlight || record.retryTimer !== null) continue;
      if (record.attempts >= MAX_SEND_ATTEMPTS) {
        fail(record, 'unconfirmed', null, true);
        continue;
      }
      transmit(record);
    }
  }

  function localByKey(key: string): LocalRecord | undefined {
    for (const record of local.values()) if (record.key === key) return record;
    return undefined;
  }

  /* ---------------- frames ---------------- */
  function onRateLimited(record: LocalRecord, retryAfterMs: number) {
    if (record.status !== 'pending') return;
    clearTimers(record);
    record.inFlight = false;
    // O servidor não publicou nem registrou o nonce: reenviar é seguro.
    if (record.attempts >= MAX_SEND_ATTEMPTS) {
      fail(record, 'rate_limited', null, true);
      return;
    }
    record.retryTimer = timers.setTimeout(() => {
      record.retryTimer = null;
      transmit(record);
      emit();
    }, retryAfterMs);
    touchLocal(record);
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    send(text) {
      if (disposed) return { ok: false, reason: 'disposed' };
      const trimmed = text.trim();
      if (trimmed === '') return { ok: false, reason: 'empty' };
      if ([...trimmed].length > MAX_MESSAGE_LENGTH) return { ok: false, reason: 'too_long' };
      if (local.size >= MAX_OUTSTANDING) return { ok: false, reason: 'too_many_pending' };

      const nonce = generateNonce();
      if (!isValidNonce(nonce) || local.has(nonce)) throw new Error('gerador de nonce produziu um valor inválido ou repetido');

      const record: LocalRecord = {
        key: `l:${nonce}`,
        seq: ++seq,
        nonce,
        text: trimmed,
        createdAt: new Date(now()).toISOString(),
        status: 'pending',
        failure: null,
        attempts: 0,
        inFlight: false,
        ackTimer: null,
        retryTimer: null,
        view: null,
      };
      local.set(nonce, record);
      dirty = true;
      transmit(record);
      emit();
      return { ok: true, key: record.key, nonce };
    },

    retry(key) {
      if (disposed) return false;
      const record = localByKey(key);
      if (!record || record.status !== 'failed' || !record.failure?.retryable) return false;
      record.status = 'pending';
      record.failure = null;
      record.attempts = 0; // ação do usuário: novo ciclo de tentativas, mesmo nonce
      touchLocal(record);
      transmit(record);
      emit();
      return true;
    },

    discard(key) {
      if (disposed) return false;
      const record = localByKey(key);
      if (!record || record.status !== 'failed') return false;
      clearTimers(record);
      local.delete(record.nonce);
      dirty = true;
      emit();
      return true;
    },

    handleFrame(frame) {
      if (disposed) return;
      switch (frame.type) {
        case 'ready':
          if (self?.id !== frame.self.id) {
            self = frame.self;
            for (const record of confirmed.values()) record.view = null;
            for (const record of local.values()) record.view = null;
            dirty = true;
          }
          break;
        case 'history':
          for (const message of frame.messages) acceptConfirmed(message, undefined);
          if (connectionReady) {
            historyReceived = true;
            flush();
          }
          break;
        case 'message':
          acceptConfirmed(frame.message, frame.nonce);
          break;
        case 'rate_limited': {
          const record = frame.nonce ? local.get(frame.nonce) : undefined;
          if (record) onRateLimited(record, frame.retryAfterMs);
          break;
        }
        case 'error': {
          const record = frame.nonce ? local.get(frame.nonce) : undefined;
          if (record && record.status === 'pending') fail(record, 'rejected', frame.code, false);
          break;
        }
      }
      emit();
    },

    handleConnectionState(state) {
      if (disposed) return;
      if (state.status === 'ready') {
        connectionReady = true;
        historyReceived = false; // espera o histórico desta conexão antes de reenviar
        return;
      }
      connectionReady = false;
      historyReceived = false;
      for (const record of local.values()) {
        if (record.status !== 'pending') continue;
        if (state.status === 'stopped') {
          fail(record, 'connection_lost', null, true);
        } else if (record.inFlight || record.ackTimer !== null || record.retryTimer !== null) {
          // Resultado desconhecido: continua pendente até o próximo histórico decidir.
          clearTimers(record);
          record.inFlight = false;
          touchLocal(record);
        }
      }
      emit();
    },

    dispose() {
      if (disposed) return;
      for (const record of local.values()) clearTimers(record);
      local.clear();
      confirmed.clear();
      listeners.clear();
      disposed = true;
    },
  };
}
