import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Pasta com as migrations (`NNN_descricao.sql`), aplicadas em ordem numérica. */
export const MIGRATIONS_DIR = fileURLToPath(new URL("./migrations/", import.meta.url));

/** Chave do advisory lock: impede que duas instâncias apliquem migrations ao mesmo tempo. */
const MIGRATION_LOCK_KEY = 7_340_021_118;

const MIGRATION_FILE = /^(\d{3,})_[a-z0-9_]+\.sql$/;

/** Lê as migrations da pasta: [{ version, name, sql }], em ordem. */
export async function loadMigrations(dir = MIGRATIONS_DIR) {
  const files = (await readdir(dir)).filter((name) => MIGRATION_FILE.test(name)).sort();
  const migrations = [];
  for (const name of files) {
    const version = Number(MIGRATION_FILE.exec(name)[1]);
    if (migrations.some((m) => m.version === version)) throw new Error(`Migration duplicada: versão ${version}.`);
    migrations.push({ version, name, sql: await readFile(path.join(dir, name), "utf8") });
  }
  return migrations;
}

/**
 * Aplica as migrations pendentes numa única transação (tudo ou nada), sob advisory lock,
 * registrando-as em `schema_migrations`. Idempotente: rodar de novo não altera nada.
 * Devolve as versões aplicadas nesta execução.
 */
export async function runMigrations(pool, { migrations } = {}) {
  const list = migrations ?? (await loadMigrations());
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query("BEGIN");
    // Prazos no próprio PostgreSQL, válidos só nesta transação (compatível com PgBouncer).
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const { rows } = await client.query("SELECT version FROM schema_migrations");
    const done = new Set(rows.map((row) => Number(row.version)));
    for (const migration of list) {
      if (done.has(migration.version)) continue;
      await client.query(migration.sql);
      await client.query("INSERT INTO schema_migrations (version, name) VALUES ($1, $2)", [migration.version, migration.name]);
      applied.push(migration.version);
    }
    await client.query("COMMIT");
    return applied;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
