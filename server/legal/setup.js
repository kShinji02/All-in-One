import { readFileSync } from "node:fs";
import { createDbPool } from "../db/pool.js";
import { resolveAcceptanceStoreKind, resolveDatabaseConfig } from "../db/config.js";
import { createMemoryAcceptanceStore, createPostgresAcceptanceStore, createUnavailableAcceptanceStore } from "./acceptance-store.js";
import { resolveAppVersion, resolveLegalDocuments } from "./config.js";
import { createLegalGate } from "./gate.js";
import { createLegalRouter } from "./routes.js";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/**
 * Monta o aceite dos documentos legais a partir do ambiente:
 * documentos e versões, armazenamento (Postgres via DATABASE_URL), verificação usada
 * pelo chat e rotas /api/legal. Nunca registra DATABASE_URL; só o host aparece no log.
 *
 * Sem DATABASE_URL (e sem LEGAL_STORE=memory fora de produção), o armazenamento fica
 * "unavailable": o aceite não pode ser registrado e o chat recusa as conexões (1013).
 */
export function createLegalSetup({ env = process.env, validateToken, logger = console, createPool = createDbPool }) {
  const documents = resolveLegalDocuments(env);
  const databaseConfig = resolveDatabaseConfig(env);
  const kind = resolveAcceptanceStoreKind(env, databaseConfig);

  let store;
  if (kind === "postgres") {
    store = createPostgresAcceptanceStore({ pool: createPool(databaseConfig, { logger }), logger });
    logger.log(`[config] Aceites legais: PostgreSQL em ${databaseConfig.host}${databaseConfig.ssl ? " (TLS)" : " (sem TLS, apenas desenvolvimento)"}.`);
  } else if (kind === "memory") {
    store = createMemoryAcceptanceStore();
    logger.warn("[config] Aceites legais em MEMÓRIA (LEGAL_STORE=memory): só para desenvolvimento; tudo se perde ao reiniciar.");
  } else {
    store = createUnavailableAcceptanceStore();
    logger.warn("[config] DATABASE_URL não definido: o aceite dos documentos legais fica indisponível e o chat recusará conexões.");
  }

  const gate = createLegalGate({ store, documents });
  const router = createLegalRouter({ validateToken, gate, documents, appVersion: resolveAppVersion(env, PACKAGE_VERSION), logger });
  return { documents, store, gate, router };
}
