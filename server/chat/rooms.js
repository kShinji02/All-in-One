import { EMPTY_ROOM_TTL_MS, HISTORY_LIMIT } from "./config.js";

/**
 * Salas em memória, uma por instanceId VALIDADO (vem do autenticador, nunca do cliente).
 *
 * - Cada sala tem seus próprios clientes e histórico; não há caminho de dados entre salas.
 * - Histórico circular de `historyLimit` mensagens.
 * - Sala vazia é removida após `emptyRoomTtlMs` (o histórico vai junto). Se alguém
 *   entrar antes disso, a remoção é cancelada e o histórico é mantido.
 * - Sem banco de dados: reiniciar o servidor apaga todas as salas.
 */
export function createRoomRegistry({
  historyLimit = HISTORY_LIMIT,
  emptyRoomTtlMs = EMPTY_ROOM_TTL_MS,
  timers = { setTimeout, clearTimeout },
} = {}) {
  const rooms = new Map(); // instanceId -> { clients: Set, history: [], cleanup: timer|null }

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
        room = { clients: new Set(), history: [], cleanup: null };
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

    /** Guarda a mensagem no histórico da sala, descartando a mais antiga acima do limite. */
    append(instanceId, message) {
      const room = rooms.get(instanceId);
      if (!room) return;
      room.history.push(message);
      while (room.history.length > historyLimit) room.history.shift();
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
