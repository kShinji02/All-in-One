/**
 * Ciclo de vida da conexão WebSocket do chat (sem React).
 *
 * Uma instância corresponde a UM par de credenciais (token + instância). Trocar de
 * sessão é descartar a conexão (`dispose`) e criar outra: assim nada da conexão
 * antiga consegue atualizar o estado da nova.
 *
 * Fluxo: socket aberto → { type:"auth" } → servidor responde "ready" → "history"...
 * Todo frame recebido passa por `parseServerFrame`; frames inválidos são descartados
 * e nunca chegam ao consumidor. Fechamentos são decididos por `classifyClose`.
 */
import { classifyClose, type CloseCategory } from '@/realtime/chat-close-codes';
import { encodeAuth, parseServerFrame, type ChatAuthor, type ParseFailure, type ServerFrame } from '@/realtime/chat-protocol';

/* ------------------------------------------------------------------ *
 * Política de reconexão
 * ------------------------------------------------------------------ */
/** Intervalo base: a 1ª nova tentativa espera entre 0,5 s e 1 s. */
export const RECONNECT_BASE_DELAY_MS = 1_000;
/** Teto do intervalo: nenhuma espera passa de 30 s. */
export const RECONNECT_MAX_DELAY_MS = 30_000;
/**
 * Tentativas seguidas sem chegar ao "ready". Depois disso a conexão para e espera
 * uma ação do usuário (`retry`): um fechamento 1006 não distingue queda de rede de
 * recusa permanente do upgrade (origem, rota, proxy), então não tentamos para sempre.
 */
export const MAX_RECONNECT_ATTEMPTS = 8;
/**
 * Prazo para receber o "ready" depois de criar o socket. Cobre conexões que ficam
 * presas sem resposta (o servidor já encerra autenticações lentas em 5 s).
 */
export const HANDSHAKE_TIMEOUT_MS = 15_000;

/** Código usado quando o próprio cliente desiste do handshake (faixa 4000–4999 da aplicação). */
const CLIENT_HANDSHAKE_TIMEOUT_CODE = 4900;
const NORMAL_CLOSURE = 1000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * Espera antes da tentativa `attempt` (1, 2, 3...): backoff exponencial com jitter.
 * teto = min(MAX, BASE · 2^(attempt−1)); espera ∈ [teto/2, teto].
 * Metade fixa garante um intervalo mínimo; metade aleatória espalha clientes que
 * caíram juntos (ex.: reinício do servidor).
 */
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, attempt - 1);
  const cap = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** exponent);
  const jitter = Math.min(Math.max(random(), 0), 1);
  return Math.round(cap / 2 + (cap / 2) * jitter);
}

/* ------------------------------------------------------------------ *
 * Tipos
 * ------------------------------------------------------------------ */
export interface ChatCredentials {
  /** Token OAuth do usuário. Fica só em memória; nunca é registrado em log. */
  accessToken: string;
  /** instanceId informado pelo SDK do Discord. */
  instanceId: string;
}

/** Motivo de uma parada definitiva (sem reconexão automática). */
export type ChatStopReason =
  | Exclude<CloseCategory, 'transient'>
  /** Esgotou MAX_RECONNECT_ATTEMPTS sem conseguir entrar na sala. */
  | 'retries_exhausted';

export type ChatConnectionState =
  | { status: 'idle' }
  | { status: 'connecting'; attempt: number }
  | { status: 'authenticating'; attempt: number }
  | { status: 'ready'; self: ChatAuthor }
  | { status: 'reconnecting'; attempt: number; delayMs: number; lastClose: CloseInfo }
  | { status: 'stopped'; reason: ChatStopReason; lastClose: CloseInfo | null };

export interface CloseInfo {
  code: number;
  reason: string;
  category: CloseCategory;
}

/** Eventos do WebSocket usados aqui, com só os campos lidos. */
export interface SocketEventMap {
  open: unknown;
  error: unknown;
  message: { data: unknown };
  close: { code: number; reason: string };
}

/** Subconjunto da API WebSocket do navegador usado aqui (permite injetar o `ws` do Node nos testes). */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void;
  removeEventListener<K extends keyof SocketEventMap>(type: K, listener: (event: SocketEventMap[K]) => void): void;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ChatConnectionOptions {
  url: string;
  credentials: ChatCredentials;
  onStateChange?: (state: ChatConnectionState) => void;
  /** Recebe apenas frames válidos (já passados por parseServerFrame). */
  onFrame?: (frame: ServerFrame) => void;
  /** Frame descartado. Recebe só o motivo, nunca o conteúdo. */
  onInvalidFrame?: (reason: ParseFailure) => void;
  createSocket?: (url: string) => WebSocketLike;
  timers?: Timers;
  random?: () => number;
}

export interface ChatConnection {
  /** Abre a conexão. Chamadas repetidas enquanto há conexão ou tentativa agendada não fazem nada. */
  start(): void;
  /** Reinicia depois de uma parada definitiva ou durante a espera de uma nova tentativa. */
  retry(): void;
  /** Encerra tudo: fecha o socket, cancela timers e remove listeners. Irreversível. */
  dispose(): void;
  getState(): ChatConnectionState;
}

/* ------------------------------------------------------------------ *
 * URL
 * ------------------------------------------------------------------ */
/** Caminho do chat no servidor (server/chat/config.js → CHAT_PATH). */
export const CHAT_PATH = '/api/chat';

/**
 * URL do WebSocket na mesma origem da página, como o fetch('/api/token'):
 * passa pelo proxy do Vite em desenvolvimento e pelo URL Mapping do Discord.
 */
export function chatUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${CHAT_PATH}`;
}

/* ------------------------------------------------------------------ *
 * Implementação
 * ------------------------------------------------------------------ */
const defaultTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>),
};

export function createChatConnection(options: ChatConnectionOptions): ChatConnection {
  const {
    url,
    credentials,
    onStateChange,
    onFrame,
    onInvalidFrame,
    createSocket = (target) => new WebSocket(target),
    timers = defaultTimers,
    random = Math.random,
  } = options;

  let state: ChatConnectionState = { status: 'idle' };
  let socket: WebSocketLike | null = null;
  let detachSocket: (() => void) | null = null;
  let reconnectTimer: unknown = null;
  let handshakeTimer: unknown = null;
  /** Tentativas seguidas sem "ready" (zera quando a sala é aberta). */
  let attempt = 0;
  let disposed = false;

  function setState(next: ChatConnectionState) {
    if (disposed) return;
    state = next;
    onStateChange?.(next);
  }

  function clearTimer(handle: unknown) {
    if (handle !== null) timers.clearTimeout(handle);
  }

  function clearReconnect() {
    clearTimer(reconnectTimer);
    reconnectTimer = null;
  }

  function clearHandshake() {
    clearTimer(handshakeTimer);
    handshakeTimer = null;
  }

  /** Desliga o socket atual: depois disso, nenhum evento dele altera o estado. */
  function releaseSocket(code: number, reason: string) {
    clearHandshake();
    const current = socket;
    socket = null;
    detachSocket?.();
    detachSocket = null;
    if (current && (current.readyState === WS_CONNECTING || current.readyState === WS_OPEN)) {
      current.close(code, reason);
    }
  }

  function open() {
    if (disposed || socket) return;
    attempt += 1;
    setState({ status: 'connecting', attempt });

    let ws: WebSocketLike;
    try {
      ws = createSocket(url);
    } catch {
      // URL inválida ou WebSocket indisponível: trata como falha passageira.
      handleClose({ code: 1006, reason: '' });
      return;
    }
    socket = ws;

    const onOpen = () => {
      if (socket !== ws) return;
      setState({ status: 'authenticating', attempt });
      ws.send(encodeAuth(credentials.accessToken, credentials.instanceId));
    };

    const onMessage = (event: { data: unknown }) => {
      if (socket !== ws) return;
      const parsed = parseServerFrame(event.data);
      if (!parsed.ok) {
        onInvalidFrame?.(parsed.reason);
        return;
      }
      const { frame } = parsed;
      if (frame.type === 'ready') {
        clearHandshake();
        attempt = 0;
        setState({ status: 'ready', self: frame.self });
      } else if (state.status !== 'ready') {
        // Antes do "ready" o servidor não envia outros frames; algo fora de ordem é descartado.
        onInvalidFrame?.('invalid_fields');
        return;
      }
      onFrame?.(frame);
    };

    // O evento "close" sempre segue o "error"; a decisão fica toda no "close".
    const onError = () => undefined;

    const onClose = (event: { code: number; reason: string }) => {
      if (socket !== ws) return;
      handleClose(event);
    };

    ws.addEventListener('open', onOpen);
    ws.addEventListener('message', onMessage);
    ws.addEventListener('error', onError);
    ws.addEventListener('close', onClose);
    detachSocket = () => {
      ws.removeEventListener('open', onOpen);
      ws.removeEventListener('message', onMessage);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };

    handshakeTimer = timers.setTimeout(() => {
      handshakeTimer = null;
      if (socket !== ws) return;
      releaseSocket(CLIENT_HANDSHAKE_TIMEOUT_CODE, 'handshake_timeout');
      // Sem resposta do servidor no prazo: mesma política de uma queda de rede.
      scheduleOrStop({ code: 1006, reason: '', category: 'transient' }, true);
    }, HANDSHAKE_TIMEOUT_MS);
  }

  function handleClose(event: { code: number; reason: string }) {
    releaseSocket(NORMAL_CLOSURE, '');
    const { category, reconnect } = classifyClose(event.code, event.reason);
    scheduleOrStop({ code: event.code, reason: event.reason, category }, reconnect);
  }

  function scheduleOrStop(lastClose: CloseInfo, reconnect: boolean) {
    if (disposed) return;
    if (!reconnect) {
      setState({ status: 'stopped', reason: lastClose.category as ChatStopReason, lastClose });
      return;
    }
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setState({ status: 'stopped', reason: 'retries_exhausted', lastClose });
      return;
    }
    // `attempt` falhas seguidas: a 1ª nova tentativa usa a menor espera.
    const delayMs = reconnectDelay(attempt, random);
    clearReconnect();
    setState({ status: 'reconnecting', attempt: attempt + 1, delayMs, lastClose });
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      open();
    }, delayMs);
  }

  return {
    start() {
      if (disposed || socket || reconnectTimer !== null || state.status === 'stopped') return;
      open();
    },

    retry() {
      if (disposed) return;
      if (state.status !== 'stopped' && state.status !== 'reconnecting') return;
      clearReconnect();
      attempt = 0;
      open();
    },

    dispose() {
      if (disposed) return;
      clearReconnect();
      releaseSocket(NORMAL_CLOSURE, '');
      state = { status: 'idle' };
      disposed = true;
    },

    getState: () => state,
  };
}
