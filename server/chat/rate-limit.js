/**
 * Limitador por janela deslizante: no máximo `limit` eventos por chave a cada `windowMs`.
 * Guarda apenas os horários dentro da janela; chaves sem eventos recentes são removidas.
 */
export function createSlidingWindowLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map(); // key -> number[] (horários em ordem crescente)

  function prune(key, at) {
    const list = hits.get(key);
    if (!list) return [];
    while (list.length > 0 && list[0] <= at - windowMs) list.shift();
    if (list.length === 0) hits.delete(key);
    return list;
  }

  return {
    /** Registra um evento. Devolve { allowed, retryAfterMs }. Eventos recusados não contam. */
    hit(key) {
      const at = now();
      const list = prune(key, at);
      if (list.length >= limit) {
        return { allowed: false, retryAfterMs: Math.max(1, list[0] + windowMs - at) };
      }
      if (list.length === 0) hits.set(key, list);
      list.push(at);
      return { allowed: true, retryAfterMs: 0 };
    },
    /** Consulta sem registrar: o próximo hit(key) seria aceito? */
    peek(key) {
      const at = now();
      const list = prune(key, at);
      if (list.length >= limit) return { allowed: false, retryAfterMs: Math.max(1, list[0] + windowMs - at) };
      return { allowed: true, retryAfterMs: 0 };
    },
    /** Remove chaves sem eventos dentro da janela (chamado periodicamente). */
    sweep() {
      const at = now();
      for (const key of [...hits.keys()]) prune(key, at);
    },
    size: () => hits.size,
  };
}
