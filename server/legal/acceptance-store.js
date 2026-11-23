import { describeDbError } from "../db/pool.js";
import { runMigrations } from "../db/migrate.js";

/**
 * Armazenamento dos aceites dos documentos legais.
 *
 * Interface (qualquer provedor futuro implementa os mesmos métodos):
 *   findAcceptance(userId, { terms, privacy }) → Promise<{ acceptedAt: string } | null>
 *   recordAcceptance({ userId, terms, privacy, appVersion }) → Promise<{ acceptedAt: string, created: boolean }>
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

function assertKey(userId, { terms, privacy }) {
  if (typeof userId !== "string" || !USER_ID.test(userId)) throw new TypeError("userId inválido");
  if (typeof terms !== "string" || typeof privacy !== "string") throw new TypeError("versões inválidas");
}

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
      const { rows } = await query(
        "SELECT accepted_at FROM legal_acceptances WHERE discord_user_id = $1 AND terms_version = $2 AND privacy_version = $3",
        [userId, versions.terms, versions.privacy],
      );
      return rows.length > 0 ? { acceptedAt: toIso(rows[0].accepted_at) } : null;
    },

    async recordAcceptance({ userId, terms, privacy, appVersion = null }) {
      assertKey(userId, { terms, privacy });
      const inserted = await query(
        `INSERT INTO legal_acceptances (discord_user_id, terms_version, privacy_version, app_version)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (discord_user_id, terms_version, privacy_version) DO NOTHING
         RETURNING accepted_at`,
        [userId, terms, privacy, appVersion],
      );
      if (inserted.rows.length > 0) return { acceptedAt: toIso(inserted.rows[0].accepted_at), created: true };
      // Já existia (clique repetido, outra aba ou corrida): devolve o registro original.
      const existing = await this.findAcceptance(userId, { terms, privacy });
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
  const rows = new Map(); // "userId|terms|privacy" -> { acceptedAt, appVersion }
  const key = (userId, { terms, privacy }) => `${userId}|${terms}|${privacy}`;
  return {
    kind: "memory",
    ready: async () => {},
    async findAcceptance(userId, versions) {
      assertKey(userId, versions);
      const row = rows.get(key(userId, versions));
      return row ? { acceptedAt: row.acceptedAt } : null;
    },
    async recordAcceptance({ userId, terms, privacy, appVersion = null }) {
      assertKey(userId, { terms, privacy });
      const k = key(userId, { terms, privacy });
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
