import { createHash } from "node:crypto";

/** SHA-256 (hex minúsculo) dos bytes exatos de um conteúdo. */
export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export const DOCUMENT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Confere se o conteúdo PUBLICADO de cada documento (os bytes que o usuário abre pela URL)
 * corresponde ao hash SHA-256 registrado para a versão atual.
 *
 * Resultado por documento: "ok" | "mismatch" | "unreachable" | "no_hash" (versão sem hash
 * registrado: nada é baixado). Os logs trazem só o documento e o resultado (sem conteúdo).
 */
export async function verifyPublishedDocuments(documents, { fetchImpl = globalThis.fetch, timeoutMs = DOCUMENT_FETCH_TIMEOUT_MS, logger = console } = {}) {
  const result = {};
  for (const key of ["terms", "privacy"]) {
    const document = documents[key];
    if (!document.sha256) {
      result[key] = "no_hash";
      continue;
    }
    try {
      const response = await fetchImpl(document.url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      if (!response.ok) {
        result[key] = "unreachable";
      } else {
        const bytes = Buffer.from(await response.arrayBuffer());
        result[key] = sha256Hex(bytes) === document.sha256 ? "ok" : "mismatch";
      }
    } catch {
      result[key] = "unreachable";
    }
    if (result[key] === "mismatch") {
      logger.error(`[legal] o documento publicado "${key}" (versão ${document.version}) NÃO corresponde ao hash registrado; novos aceites ficam bloqueados.`);
    } else if (result[key] === "unreachable") {
      logger.warn(`[legal] não foi possível conferir o documento publicado "${key}" (versão ${document.version}).`);
    } else {
      logger.log(`[legal] documento publicado "${key}" (versão ${document.version}) confere com o hash registrado.`);
    }
  }
  return result;
}

/**
 * Estado da conferência, consultado pelas rotas: com um documento publicado DIFERENTE do
 * hash registrado, novos aceites são recusados (o registro apontaria um conteúdo que o
 * usuário não viu). Falha de rede não bloqueia: o hash registrado continua sendo a referência.
 */
export function createDocumentIntegrity() {
  let mismatch = false;
  return {
    apply(result) {
      mismatch = Object.values(result).includes("mismatch");
      return result;
    },
    blocked: () => mismatch,
  };
}
