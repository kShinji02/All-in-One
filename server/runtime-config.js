/**
 * Configuração de inicialização do processo (porta, interface e avisos de produção).
 *
 * Funções puras sobre um objeto de ambiente, para que a configuração de produção possa ser
 * testada sem abrir portas. `server.js` é o único lugar que lê `process.env` e escuta.
 */

/** Porta local padrão (o proxy do Vite e a documentação usam 3001). */
export const DEFAULT_PORT = 3001;
/** Interface usada em produção: todas as interfaces IPv4, como o Render exige. */
export const PRODUCTION_HOST = "0.0.0.0";

/** O Render define RENDER=true em todos os serviços. */
export function isRender(env = {}) {
  return env.RENDER === "true";
}

export function isProduction(env = {}) {
  return env.NODE_ENV === "production";
}

/**
 * PORT do ambiente (o Render define essa variável) ou 3001. Valor inválido encerra a
 * inicialização com uma mensagem clara, em vez de escutar numa porta inesperada.
 */
export function resolvePort(raw) {
  const value = raw?.trim();
  if (!value) return DEFAULT_PORT;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    throw new Error(`PORT deve ser um inteiro entre 1 e 65535: "${value}".`);
  }
  return Number(value);
}

/**
 * Interface de escuta:
 * - HOST explícito, se definido;
 * - em produção (NODE_ENV=production) ou no Render: 0.0.0.0, para aceitar conexões externas;
 * - no desenvolvimento: `undefined`, o padrão do Node (todas as interfaces, IPv4 e IPv6),
 *   que mantém o proxy do Vite para http://localhost:3001 funcionando mesmo quando
 *   "localhost" resolve para ::1.
 */
export function resolveHost(env = {}) {
  const explicit = env.HOST?.trim();
  if (explicit) return explicit;
  return isProduction(env) || isRender(env) ? PRODUCTION_HOST : undefined;
}

export function resolveListenOptions(env = {}) {
  return { port: resolvePort(env.PORT), host: resolveHost(env) };
}

/**
 * Avisos de configuração para ambientes publicados. Nunca incluem valores de variáveis.
 * (Credenciais ausentes já são avisadas em server.js.)
 */
export function deploymentWarnings(env = {}) {
  const deployed = isProduction(env) || isRender(env);
  if (!deployed) return [];

  const warnings = [];
  if (isRender(env) && !isProduction(env)) {
    warnings.push("NODE_ENV não é \"production\": o chat aceita origens de desenvolvimento (localhost e trycloudflare.com). Defina NODE_ENV=production.");
  }
  if (!env.TRUST_PROXY?.trim()) {
    warnings.push(
      "TRUST_PROXY não definido: atrás do proxy do Render todos os clientes compartilham o mesmo IP nos limites por IP. Defina TRUST_PROXY=1 (ver docs/DEPLOY-RENDER.md).",
    );
  }
  return warnings;
}

/** Endereço para o log de inicialização (sem segredos). */
export function describeListen({ port, host }) {
  return host ? `${host}:${port}` : `porta ${port} (todas as interfaces)`;
}
