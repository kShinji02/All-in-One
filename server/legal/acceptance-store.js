import { describeDbError } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";

/**
 * Armazenamento dos aceites dos documentos legais.
 *
 * Interface (qualquer provedor futuro implementa os mesmos métodos):
 *   findAcceptance(userId, { terms, privacy, termsSha256?, privacySha256? }) → Promise<{ acceptedAt: string } | null>
 *   recordAcceptance({ userId, terms, privacy, termsSha256?, privacySha256?, appVersion })
 *     → Promise<{ acceptedAt: string, created: boolean }>
 *
 * Um aceite vale para o par de versões E para os hashes SHA-256 do conteúdo (null quando a
 * versão não tem hash registrado). Documentos com o mesmo rótulo e hash diferente NÃO são
 * equivalentes: um aceite antigo sem hash não vale para uma versão que passou a ter hash.
 *   ready() → Promise<void>   (prepara o armazenamento; ex.: migrations)
 *   close() → Promise<void>
 *   kind: "postgres" | "memory" | "unavailable"
 *
 * Toda falha de infraestrutura vira AcceptanceStoreUnavailableError: quem chama trata como
 * "aceite não confirmado" e NUNCA libera o acesso por causa de um erro.
 */
export class AcceptanceStoreUnavailableError extends Error {
  constructor(detail = "unavailable") {
    super(`Armazenamento de aceites indisponível (${detail}).`);
    this.name = "AcceptanceStoreUnavailableError";
    this.detail = detail;
  }
}

const USER_ID = /^[0-9]{17,20}$/;

const SHA256 = /^[0-9a-f]{64}$/;

function assertKey(userId, { terms, privacy, termsSha256 = null, privacySha256 = null }) {
  if (typeof userId !== "string" || !USER_ID.test(userId)) throw new TypeError("userId inválido");
  if (typeof terms !== "string" || typeof privacy !== "string") throw new TypeError("versões inválidas");
  for (const hash of [termsSha256, privacySha256]) {
    if (hash !== null && (typeof hash !== "string" || !SHA256.test(hash))) throw new TypeError("hash inválido");
  }
}

/** Hashes normalizados (undefined → null), na ordem das colunas. */
const hashesOf = ({ termsSha256 = null, privacySha256 = null }) => [termsSha256, privacySha256];

const toIso = (value) => (value instanceof Date ? value : new Date(value)).toISOString();

/**
 * PostgreSQL (ex.: Neon). As migrations rodam na primeira operação (ou em ready()); se
 * falharem, a próxima operação tenta de novo. Consultas sempre parametrizadas.
 */
export function createPostgresAcceptanceStore({ pool, logger = console, migrate = runMigrations }) {
  let readyPromise = null;

  function ready() {
    if (!readyPromise) {
      readyPromise = migrate(pool)
        .then((applied) => {
          if (applied.length > 0) logger.log(`[db] migrations aplicadas: ${applied.join(", ")}.`);
          else logger.log("[db] schema atualizado (nenhuma migration pendente).");
        })
        .catch((error) => {
          readyPromise = null; // permite nova tentativa na próxima operação
          logger.warn(`[db] falha ao preparar o schema (${describeDbError(error)}).`);
          throw new AcceptanceStoreUnavailableError(describeDbError(error));
        });
    }
    return readyPromise;
  }

  async function query(text, values) {
    await ready();
    try {
      return await pool.query(text, values);
    } catch (error) {
      logger.warn(`[db] consulta de aceite falhou (${describeDbError(error)}).`);
      throw new AcceptanceStoreUnavailableError(describeDbError(error));
    }
  }

  return {
    kind: "postgres",
    ready,

    async findAcceptance(userId, versions) {
      assertKey(userId, versions);
      // IS NOT DISTINCT FROM: NULL só casa com NULL (aceite sem hash só vale enquanto a versão não tiver hash).
      const { rows } = await query(
        `SELECT accepted_at FROM legal_acceptances
          WHERE discord_user_id = $1 AND terms_version = $2 AND privacy_version = $3
            AND terms_sha256 IS NOT DISTINCT FROM $4 AND privacy_sha256 IS NOT DISTINCT FROM $5`,
        [userId, versions.terms, versions.privacy, ...hashesOf(versions)],
      );
      return rows.length > 0 ? { acceptedAt: toIso(rows[0].accepted_at) } : null;
    },

    async recordAcceptance({ userId, terms, privacy, termsSha256 = null, privacySha256 = null, appVersion = null }) {
      const key = { terms, privacy, termsSha256, privacySha256 };
      assertKey(userId, key);
      const inserted = await query(
        `INSERT INTO legal_acceptances (discord_user_id, terms_version, privacy_version, terms_sha256, privacy_sha256, app_version)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (discord_user_id, terms_version, privacy_version, (COALESCE(terms_sha256, '')), (COALESCE(privacy_sha256, ''))) DO NOTHING
         RETURNING accepted_at`,
        [userId, terms, privacy, termsSha256, privacySha256, appVersion],
      );
      if (inserted.rows.length > 0) return { acceptedAt: toIso(inserted.rows[0].accepted_at), created: true };
      // Já existia (clique repetido, outra aba ou corrida): devolve o registro original.
      const existing = await this.findAcceptance(userId, key);
      if (!existing) throw new AcceptanceStoreUnavailableError("conflict_without_row");
      return { acceptedAt: existing.acceptedAt, created: false };
    },

    async close() {
      await pool.end();
    },
  };
}

/** Em memória: SOMENTE testes e desenvolvimento local com LEGAL_STORE=memory. */
export function createMemoryAcceptanceStore({ now = Date.now } = {}) {
  const rows = new Map(); // "userId|terms|privacy|termsSha256|privacySha256" -> { acceptedAt, appVersion }
  const key = (userId, versions) => [userId, versions.terms, versions.privacy, ...hashesOf(versions)].join("|");
  return {
    kind: "memory",
    ready: async () => {},
    async findAcceptance(userId, versions) {
      assertKey(userId, versions);
      const row = rows.get(key(userId, versions));
      return row ? { acceptedAt: row.acceptedAt } : null;
    },
    async recordAcceptance({ userId, terms, privacy, termsSha256 = null, privacySha256 = null, appVersion = null }) {
      const versions = { terms, privacy, termsSha256, privacySha256 };
      assertKey(userId, versions);
      const k = key(userId, versions);
      const existing = rows.get(k);
      if (existing) return { acceptedAt: existing.acceptedAt, created: false };
      const row = { acceptedAt: new Date(now()).toISOString(), appVersion };
      rows.set(k, row);
      return { acceptedAt: row.acceptedAt, created: true };
    },
    size: () => rows.size,
    close: async () => {},
  };
}

/** Sem armazenamento configurado: tudo falha como indisponível (o chat não é liberado). */
export function createUnavailableAcceptanceStore(detail = "not_configured") {
  const fail = async () => {
    throw new AcceptanceStoreUnavailableError(detail);
  };
  return { kind: "unavailable", ready: fail, findAcceptance: fail, recordAcceptance: fail, close: async () => {} };
}
