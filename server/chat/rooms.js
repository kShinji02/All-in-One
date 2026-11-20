import { EMPTY_ROOM_TTL_MS, HISTORY_LIMIT } from "./config.js";

/**
 * Salas em memória, uma por instanceId VALIDADO (vem do autenticador, nunca do cliente).
 *
 * - Cada sala tem seus próprios clientes e histórico; não há caminho de dados entre salas.
 * - Histórico circular de `historyLimit` mensagens.
 * - Sala vazia é removida após `emptyRoomTtlMs` (o histórico vai junto). Se alguém
 *   entrar antes disso, a remoção é cancelada e o histórico é mantido.
 * - Sem banco de dados: reiniciar o servidor apaga todas as salas.
 *
 * Idempotência (Etapa 4.1): cada mensagem pode ter um nonce do autor, guardado num
 * índice PRIVADO da sala (chave autor + nonce), nunca no objeto da mensagem. O índice
 * acompanha o histórico: quando a mensagem sai do buffer circular, ou a sala é
 * removida, o nonce deixa de valer e um reenvio passa a ser tratado como envio novo.
 */
export function createRoomRegistry({
  historyLimit = HISTORY_LIMIT,
  emptyRoomTtlMs = EMPTY_ROOM_TTL_MS,
  timers = { setTimeout, clearTimeout },
} = {}) {
  // instanceId -> {
  //   clients: Set, history: ChatMessage[], cleanup: timer|null,
  //   nonceByMessageId: Map<messageId, nonce>, messageByNonce: Map<"autor\u0000nonce", ChatMessage>
  // }
  const rooms = new Map();

  const nonceKey = (authorId, nonce) => `${authorId}\u0000${nonce}`;

  function cancelCleanup(room) {
    if (room.cleanup) {
      timers.clearTimeout(room.cleanup);
      room.cleanup = null;
    }
  }

  function scheduleCleanup(instanceId, room) {
    cancelCleanup(room);
    room.cleanup = timers.setTimeout(() => {
      if (rooms.get(instanceId) === room && room.clients.size === 0) rooms.delete(instanceId);
    }, emptyRoomTtlMs);
    room.cleanup?.unref?.();
  }

  return {
    /** Adiciona o cliente e devolve uma cópia do histórico atual. */
    join(instanceId, client) {
      let room = rooms.get(instanceId);
      if (!room) {
        room = { clients: new Set(), history: [], cleanup: null, nonceByMessageId: new Map(), messageByNonce: new Map() };
        rooms.set(instanceId, room);
      }
      cancelCleanup(room);
      room.clients.add(client);
      return room.history.slice();
    },

    leave(instanceId, client) {
      const room = rooms.get(instanceId);
      if (!room || !room.clients.delete(client)) return;
      if (room.clients.size === 0) scheduleCleanup(instanceId, room);
    },

    /**
     * Guarda a mensagem no histórico da sala, descartando a mais antiga acima do limite.
     * Com `nonce`, registra a mensagem no índice de idempotência do autor.
     */
    append(instanceId, message, nonce) {
      const room = rooms.get(instanceId);
      if (!room) return;
      room.history.push(message);
      if (nonce) {
        room.nonceByMessageId.set(message.id, nonce);
        room.messageByNonce.set(nonceKey(message.author.id, nonce), message);
      }
      while (room.history.length > historyLimit) {
        const evicted = room.history.shift();
        const evictedNonce = room.nonceByMessageId.get(evicted.id);
        if (evictedNonce !== undefined) {
          room.nonceByMessageId.delete(evicted.id);
          room.messageByNonce.delete(nonceKey(evicted.author.id, evictedNonce));
        }
      }
    },

    /** Mensagem já enviada por `authorId` com este `nonce` (ainda no histórico), ou undefined. */
    findByNonce(instanceId, authorId, nonce) {
      return rooms.get(instanceId)?.messageByNonce.get(nonceKey(authorId, nonce));
    },

    /**
     * Histórico como `viewerId` deve vê-lo: o nonce aparece SOMENTE nas mensagens do
     * próprio viewer (para ele reconciliar envios pendentes após reconectar).
     */
    historyFor(instanceId, viewerId) {
      const room = rooms.get(instanceId);
      if (!room) return [];
      return room.history.map((message) => {
        const nonce = message.author.id === viewerId ? room.nonceByMessageId.get(message.id) : undefined;
        return nonce !== undefined ? { ...message, nonce } : message;
      });
    },

    /** Tamanho do índice de idempotência da sala (para testes e diagnóstico). */
    nonceCount(instanceId) {
      return rooms.get(instanceId)?.messageByNonce.size ?? 0;
    },

    /** Clientes conectados à sala (cópia). */
    clients(instanceId) {
      return [...(rooms.get(instanceId)?.clients ?? [])];
    },

    clientCount(instanceId) {
      return rooms.get(instanceId)?.clients.size ?? 0;
    },

    history(instanceId) {
      return rooms.get(instanceId)?.history.slice() ?? [];
    },

    has: (instanceId) => rooms.has(instanceId),
    ids: () => [...rooms.keys()],
    size: () => rooms.size,

    /** Remove todas as salas e cancela os timers (encerramento do servidor). */
    clear() {
      for (const room of rooms.values()) cancelCleanup(room);
      rooms.clear();
    },
  };
}
