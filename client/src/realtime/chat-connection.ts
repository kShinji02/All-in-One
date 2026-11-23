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
import { encodeAuth, encodeSend, parseServerFrame, type ChatAuthor, type ParseFailure, type ServerFrame } from '@/realtime/chat-protocol';
import { backoffDelay } from '@/lib/backoff';

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
/**
 * Uma sala só conta como restabelecida depois de ficar aberta por este tempo. Antes
 * disso, uma queda conta como tentativa falha: o backoff cresce e o limite vale.
 * (Sem isso, conexões que caem logo após o "ready" zeravam o contador para sempre.)
 */
export const STABLE_CONNECTION_MS = 30_000;
/** O evento "online" só zera o contador de tentativas uma vez por este intervalo. */
export const ONLINE_RESET_COOLDOWN_MS = 60_000;
/**
 * Sem rede segundo o navegador, ainda tentamos de vez em quando: navigator.onLine pode
 * estar errado no webview. Essas tentativas contam no limite.
 */
export const OFFLINE_PROBE_MS = 30_000;
/**
 * Um prazo que dispara muito depois do previsto indica app suspenso (segundo plano).
 * Nesse caso o prazo é renovado uma vez em vez de encerrar a conexão.
 */
export const TIMER_DRIFT_TOLERANCE_MS = 5_000;

/** Código usado quando o próprio cliente desiste do handshake (faixa 4000–4999 da aplicação). */
const CLIENT_HANDSHAKE_TIMEOUT_CODE = 4900;
/** O cliente fecha um socket que parou de responder (meio aberto). */
const CLIENT_STALLED_CODE = 4902;
/** Queda de rede vista pelo cliente (sem código do servidor). */
const NETWORK_LOSS: CloseInfo = { code: 1006, reason: '', category: 'transient' };
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
  return backoffDelay(attempt, { baseMs: RECONNECT_BASE_DELAY_MS, maxMs: RECONNECT_MAX_DELAY_MS }, random);
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
  /**
   * Sem internet (o navegador informa navigator.onLine = false): nenhuma tentativa é
   * feita nem contada. Quando a rede volta ("online"), reconecta na hora.
   */
  | { status: 'offline'; lastClose: CloseInfo | null }
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

/** Estado da rede do aparelho. Padrão: navigator.onLine + eventos online/offline. */
export interface NetworkMonitor {
  /** false só quando o navegador tem certeza de que não há rede. */
  isOnline(): boolean;
  subscribe(listener: (online: boolean) => void): () => void;
}

export const browserNetwork: NetworkMonitor = {
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  subscribe(listener) {
    if (typeof window === 'undefined') return () => undefined;
    const online = () => listener(true);
    const offline = () => listener(false);
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  },
};

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
  network?: NetworkMonitor;
  /** Relógio (detecta prazos atrasados pela suspensão do app). */
  now?: () => number;
}

export interface ChatConnection {
  /** Abre a conexão. Chamadas repetidas enquanto há conexão ou tentativa agendada não fazem nada. */
  start(): void;
  /**
   * Tentativa manual: depois de uma parada definitiva, durante a espera do backoff ou
   * sem rede (nesse caso tenta mesmo assim: navigator.onLine pode estar errado).
   */
  retry(): void;
  /**
   * A sala parece aberta, mas o servidor parou de responder (socket meio aberto, comum
   * no celular quando a rede cai). Fecha o socket e reconecta pela política normal.
   * Devolve false se não havia sala aberta para reciclar.
   */
  recycle(): boolean;
  /** Encerra tudo: fecha o socket, cancela timers e remove listeners. Irreversível. */
  dispose(): void;
  getState(): ChatConnectionState;
  /**
   * Escreve um { type:"send" } no socket, somente com a sala aberta ("ready").
   * Devolve true se o frame foi entregue ao socket — isso NÃO é confirmação do
   * servidor (ela chega como "message" com o mesmo nonce). Lança se o nonce for
   * inválido (erro de programação, ver encodeSend).
   */
  send(text: string, nonce: string): boolean;
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
    network = browserNetwork,
    now = Date.now,
  } = options;

  let state: ChatConnectionState = { status: 'idle' };
  let socket: WebSocketLike | null = null;
  let detachSocket: (() => void) | null = null;
  let reconnectTimer: unknown = null;
  let handshakeTimer: unknown = null;
  /** Tentativas seguidas sem uma sala estável (zera após STABLE_CONNECTION_MS aberta). */
  let attempt = 0;
  let stableTimer: unknown = null;
  let probeTimer: unknown = null;
  let lastOnlineReset = Number.NEGATIVE_INFINITY;
  /** Último estado de rede visto (para distinguir transição real de evento repetido). */
  let networkOnline = true;
  let disposed = false;
  let unsubscribeNetwork: (() => void) | null = null;

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

  function clearStable() {
    clearTimer(stableTimer);
    stableTimer = null;
  }

  function clearProbe() {
    clearTimer(probeTimer);
    probeTimer = null;
  }

  /**
   * Prazo que tolera suspensão: se disparar mais de TIMER_DRIFT_TOLERANCE_MS atrasado
   * (timers congelados com o app em segundo plano), renova a janela uma vez — os eventos
   * do socket podem estar na fila logo atrás.
   */
  function deadline(ms: number, onExpire: () => void, store: (handle: unknown) => void) {
    let extended = false;
    const arm = () => {
      const armedAt = now();
      store(
        timers.setTimeout(() => {
          const late = now() - armedAt - ms;
          if (!extended && late > TIMER_DRIFT_TOLERANCE_MS) {
            extended = true;
            arm();
            return;
          }
          store(null);
          onExpire();
        }, ms),
      );
    };
    arm();
  }

  /** Desliga o socket atual: depois disso, nenhum evento dele altera o estado. */
  function releaseSocket(code: number, reason: string) {
    clearHandshake();
    clearStable();
    const current = socket;
    socket = null;
    detachSocket?.();
    detachSocket = null;
    if (current && (current.readyState === WS_CONNECTING || current.readyState === WS_OPEN)) {
      current.close(code, reason);
    }
  }

  /**
   * Sem rede segundo o navegador: espera o evento "online", mas não confia só nele —
   * a cada OFFLINE_PROBE_MS tenta mesmo assim, contando no limite de tentativas.
   */
  function goOffline(lastClose: CloseInfo | null) {
    clearReconnect();
    clearProbe();
    if (attempt >= MAX_RECONNECT_ATTEMPTS) {
      setState({ status: 'stopped', reason: 'retries_exhausted', lastClose });
      return;
    }
    setState({ status: 'offline', lastClose });
    probeTimer = timers.setTimeout(() => {
      probeTimer = null;
      open({ force: true });
    }, OFFLINE_PROBE_MS);
  }

  function open({ force = false }: { force?: boolean } = {}) {
    if (disposed || socket) return;
    clearProbe();
    if (!force && !network.isOnline()) {
      networkOnline = false;
      goOffline(state.status === 'reconnecting' || state.status === 'offline' ? state.lastClose : null);
      return;
    }
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
        // O contador só zera se a sala continuar aberta (conexões que caem logo contam).
        clearStable();
        stableTimer = timers.setTimeout(() => {
          stableTimer = null;
          attempt = 0;
        }, STABLE_CONNECTION_MS);
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

    deadline(
      HANDSHAKE_TIMEOUT_MS,
      () => {
        if (socket !== ws) return;
        releaseSocket(CLIENT_HANDSHAKE_TIMEOUT_CODE, 'handshake_timeout');
        // Sem resposta do servidor no prazo: mesma política de uma queda de rede.
        scheduleOrStop(NETWORK_LOSS, true);
      },
      (handle) => (handshakeTimer = handle),
    );
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
    // A queda veio da falta de rede: as tentativas esperam a rede voltar, sem gastar o limite.
    if (!network.isOnline()) {
      networkOnline = false;
      goOffline(lastClose);
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

  function onNetworkChange(online: boolean) {
    if (disposed) return;
    if (!online) {
      // navigator.onLine não é prova: um socket vivo continua até falhar de fato (o
      // fechamento, o prazo do handshake ou a falta de confirmação decidem).
      // Só a espera do backoff é suspensa, para não gastar tentativas à toa.
      networkOnline = false;
      if (state.status === 'reconnecting') goOffline(state.lastClose);
      return;
    }
    // Só uma transição real (sem rede → com rede) conta. Um "online" repetido com a rede
    // já "online" não prova nada (o webview do Discord Mobile pode dispará-lo à toa).
    const transitioned = !networkOnline;
    networkOnline = true;
    if (!transitioned) return;
    const waiting = state.status === 'offline' || state.status === 'reconnecting';
    const exhausted = state.status === 'stopped' && state.reason === 'retries_exhausted';
    if (!waiting && !exhausted) return;
    // A rede voltou: tenta já. O contador só zera uma vez por ONLINE_RESET_COOLDOWN_MS,
    // para que uma rede instável (oscilando) não anule o limite de tentativas.
    const t = now();
    if (t - lastOnlineReset >= ONLINE_RESET_COOLDOWN_MS) {
      lastOnlineReset = t;
      attempt = 0;
    } else if (exhausted) {
      return;
    }
    clearReconnect();
    open();
  }

  return {
    start() {
      if (disposed || socket || reconnectTimer !== null || state.status === 'stopped') return;
      if (!unsubscribeNetwork) {
        networkOnline = network.isOnline();
        unsubscribeNetwork = network.subscribe(onNetworkChange);
      }
      open();
    },

    retry() {
      if (disposed) return;
      if (state.status !== 'stopped' && state.status !== 'reconnecting' && state.status !== 'offline') return;
      if (!unsubscribeNetwork) {
        networkOnline = network.isOnline();
        unsubscribeNetwork = network.subscribe(onNetworkChange);
      }
      clearReconnect();
      attempt = 0;
      // Ação do usuário: tenta mesmo que navigator.onLine diga o contrário.
      open({ force: true });
    },

    recycle() {
      if (disposed || !socket || state.status !== 'ready') return false;
      releaseSocket(CLIENT_STALLED_CODE, 'stalled');
      scheduleOrStop(NETWORK_LOSS, true);
      return true;
    },

    dispose() {
      if (disposed) return;
      unsubscribeNetwork?.();
      unsubscribeNetwork = null;
      clearReconnect();
      clearProbe();
      clearStable();
      releaseSocket(NORMAL_CLOSURE, '');
      state = { status: 'idle' };
      disposed = true;
    },

    getState: () => state,

    send(text, nonce) {
      const frame = encodeSend(text, nonce);
      if (disposed || !socket || state.status !== 'ready' || socket.readyState !== WS_OPEN) return false;
      try {
        socket.send(frame);
        return true;
      } catch {
        return false;
      }
    },
  };
}
