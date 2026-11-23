import pg from "pg";

/**
 * Limites da conexão: o Neon suspende a computação ociosa e pode demorar a acordar.
 *
 * Compatibilidade com poolers (PgBouncer, como o pooler do Neon): NADA além de usuário,
 * banco e application_name vai no pacote de inicialização. Parâmetros como
 * `statement_timeout`, `lock_timeout` ou `options` na inicialização são recusados pelo
 * PgBouncer ("unsupported startup parameter") e derrubariam todas as conexões.
 *
 * - `queryTimeoutMs`: prazo de cada consulta medido no Node (o driver desiste e devolve erro).
 * - No PostgreSQL, as migrations usam `SET LOCAL` dentro da própria transação (compatível com
 *   PgBouncer em modo transação). As consultas de aceite são buscas e inserções pela chave
 *   primária; para um teto também no servidor, veja docs/ACEITE-LEGAL.md
 *   ("Limite de duração no PostgreSQL").
 */
export const DB_POOL_DEFAULTS = Object.freeze({
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  queryTimeoutMs: 6_000,
});

/** Parâmetros que NÃO podem ir no pacote de inicialização (incompatíveis com PgBouncer). */
export const FORBIDDEN_STARTUP_OPTIONS = Object.freeze(["statement_timeout", "lock_timeout", "idle_in_transaction_session_timeout", "options"]);

/** Descrição segura de um erro do banco para logs: só o tipo e o código (nunca a mensagem). */
export function describeDbError(error) {
  const code = typeof error?.code === "string" ? error.code : null;
  const name = error?.name ?? "erro";
  return code ? `${name}/${code}` : name;
}

/** Opções do pg.Pool a partir de resolveDatabaseConfig() (exportado para testes). */
export function buildPoolOptions(config, overrides = {}) {
  const options = { ...DB_POOL_DEFAULTS, ...overrides };
  return {
    connectionString: config.connectionString,
    ssl: config.ssl,
    max: options.max,
    idleTimeoutMillis: options.idleTimeoutMillis,
    connectionTimeoutMillis: options.connectionTimeoutMillis,
    query_timeout: options.queryTimeoutMs,
    application_name: "all-in-one",
  };
}

/**
 * Cria o pool do PostgreSQL. Erros de conexões ociosas (ex.: o Neon encerrou a conexão ao
 * suspender) são registrados sem detalhes e não derrubam o processo; a próxima consulta abre
 * uma conexão nova.
 */
export function createDbPool(config, { logger = console, ...overrides } = {}) {
  const pool = new pg.Pool(buildPoolOptions(config, overrides));
  pool.on("error", (error) => logger.warn(`[db] conexão ociosa encerrada (${describeDbError(error)}).`));
  return pool;
}
