/**
 * Configuração da conexão PostgreSQL a partir de DATABASE_URL (somente no backend).
 *
 * - TLS é obrigatório, com verificação do certificado (rejectUnauthorized), sempre que o
 *   ambiente for de produção (NODE_ENV=production) ou o Render. `sslmode=disable` só é
 *   aceito fora desses ambientes (bancos locais de desenvolvimento e testes).
 * - Os parâmetros de SSL da URL são removidos e substituídos pela configuração explícita:
 *   o driver `pg` deixaria a URL sobrescrever a opção `ssl`.
 * - Mensagens de erro nunca incluem a URL (que contém a senha).
 */
const SSL_URL_PARAMS = ["sslmode", "ssl", "sslcert", "sslkey", "sslrootcert", "sslnegotiation", "uselibpqcompat"];

export class DatabaseConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

function isDeployed(env) {
  return env.NODE_ENV === "production" || env.RENDER === "true";
}

/**
 * Devolve `null` sem DATABASE_URL, ou `{ connectionString, ssl, host }`.
 * `host` serve apenas para logs (nunca usuário, senha ou banco).
 */
export function resolveDatabaseConfig(env = {}) {
  const raw = env.DATABASE_URL?.trim();
  if (!raw) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseConfigError("DATABASE_URL não é uma URL válida.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseConfigError('DATABASE_URL deve começar com "postgresql://" ou "postgres://".');
  }
  if (!url.hostname) throw new DatabaseConfigError("DATABASE_URL não informa o servidor.");

  const sslmode = url.searchParams.get("sslmode")?.toLowerCase() ?? null;
  for (const param of SSL_URL_PARAMS) url.searchParams.delete(param);

  const tlsDisabled = sslmode === "disable";
  if (tlsDisabled && isDeployed(env)) {
    throw new DatabaseConfigError("DATABASE_URL com sslmode=disable não é aceita em produção: a conexão precisa usar TLS.");
  }

  return Object.freeze({
    connectionString: url.toString(),
    ssl: tlsDisabled ? false : Object.freeze({ rejectUnauthorized: true }),
    host: url.hostname,
  });
}

/**
 * Armazenamento dos aceites:
 * - "postgres" (padrão quando DATABASE_URL existe);
 * - "memory" somente por opção explícita (LEGAL_STORE=memory) e nunca em produção;
 * - "unavailable" sem DATABASE_URL, SOMENTE fora de produção: o aceite fica indisponível e o
 *   chat não é liberado. Em produção/Render, a falta de DATABASE_URL encerra a inicialização.
 */
export function resolveAcceptanceStoreKind(env = {}, databaseConfig = null) {
  const explicit = env.LEGAL_STORE?.trim();
  if (explicit && explicit !== "memory" && explicit !== "postgres") {
    throw new DatabaseConfigError('LEGAL_STORE aceita apenas "postgres" ou "memory".');
  }
  if (explicit === "memory") {
    if (isDeployed(env)) throw new DatabaseConfigError("LEGAL_STORE=memory não é permitido em produção: os aceites precisam ser persistentes.");
    return "memory";
  }
  if (databaseConfig) return "postgres";
  // Produção (ou Render) sem banco: a inicialização falha, para que o deploy não fique
  // "saudável" sem conseguir registrar aceites.
  if (isDeployed(env)) {
    throw new DatabaseConfigError("DATABASE_URL é obrigatório em produção: sem ele os aceites legais não podem ser registrados.");
  }
  return "unavailable";
}
