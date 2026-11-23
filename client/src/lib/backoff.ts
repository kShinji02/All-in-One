/**
 * Espera antes da tentativa `attempt` (1, 2, 3...): backoff exponencial com jitter.
 * teto = min(maxMs, baseMs · 2^(attempt−1)); espera ∈ [teto/2, teto].
 * A metade fixa garante um intervalo mínimo; a metade aleatória espalha clientes que
 * falharam juntos (ex.: servidor reiniciando), evitando que todos voltem ao mesmo tempo.
 */
export function backoffDelay(
  attempt: number,
  { baseMs, maxMs }: { baseMs: number; maxMs: number },
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempt - 1);
  const cap = Math.min(maxMs, baseMs * 2 ** exponent);
  const jitter = Math.min(Math.max(random(), 0), 1);
  return Math.round(cap / 2 + (cap / 2) * jitter);
}
