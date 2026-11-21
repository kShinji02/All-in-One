/**
 * Lista de origens aceitas para o upgrade do WebSocket.
 *
 * Navegadores sempre enviam o cabeçalho Origin em WebSockets, então esta
 * verificação impede que uma página de terceiros abra conexões em nome do
 * usuário (Cross-Site WebSocket Hijacking). Clientes fora do navegador podem
 * forjar o Origin; por isso a identidade é validada à parte (Etapa 2).
 *
 * Perfis (ORIGIN_PROFILE):
 * - "production": SOMENTE https://<client_id>.discordsays.com (o proxy oficial das
 *   Activities) e origens exatas listadas em `extraOrigins` (ex.: um domínio próprio).
 * - "local":      production + http(s)://localhost | 127.0.0.1 | [::1] em qualquer porta.
 * - "tunnel":     local + https://<subdomínio>.trycloudflare.com (Quick Tunnel; um único
 *   rótulo antes do domínio, como o cloudflared gera). Padrão fora de produção.
 *
 * Dentro do Discord o navegador envia sempre o Origin do discordsays.com, inclusive em
 * desenvolvimento pelo túnel: o trycloudflare.com só aparece ao abrir a URL do túnel
 * diretamente no navegador.
 */
export const ORIGIN_PROFILES = Object.freeze(["production", "local", "tunnel"]);

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
/** Quick Tunnel: "<palavras-separadas-por-hífen>.trycloudflare.com" (um rótulo DNS válido). */
const QUICK_TUNNEL_HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/;

export function isAllowedOrigin(origin, { discordClientId = null, profile = "tunnel", extraOrigins = [] } = {}) {
  if (typeof origin !== "string" || origin === "" || origin === "null") return false;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const { protocol, hostname } = url;
  if (protocol !== "https:" && protocol !== "http:") return false;
  // Origin é só esquema + host + porta; qualquer outra coisa não é um Origin de navegador.
  if (url.origin !== origin) return false;

  if (extraOrigins.includes(origin)) return true;

  const allowLocal = profile === "local" || profile === "tunnel";
  if (allowLocal && LOCAL_HOSTS.has(hostname)) return true;

  // Fora do ambiente local, somente HTTPS na porta padrão.
  if (protocol !== "https:" || url.port !== "") return false;

  if (profile === "tunnel" && QUICK_TUNNEL_HOST.test(hostname)) return true;

  if (discordClientId && hostname === `${discordClientId}.discordsays.com`) return true;

  return false;
}

/**
 * Perfil a partir do ambiente: ORIGIN_PROFILE explícito; senão "production" quando
 * NODE_ENV=production e "tunnel" (compatível com o desenvolvimento atual) nos demais casos.
 */
export function resolveOriginProfile({ ORIGIN_PROFILE, NODE_ENV } = {}) {
  const explicit = ORIGIN_PROFILE?.trim();
  if (explicit) {
    if (!ORIGIN_PROFILES.includes(explicit)) {
      throw new Error(`ORIGIN_PROFILE inválido: "${explicit}". Use: ${ORIGIN_PROFILES.join(", ")}.`);
    }
    return explicit;
  }
  return NODE_ENV === "production" ? "production" : "tunnel";
}

/** CHAT_EXTRA_ORIGINS: lista separada por vírgulas de origens HTTPS exatas (sem curingas). */
export function parseExtraOrigins(raw) {
  if (!raw?.trim()) return [];
  return raw.split(",").map((value) => {
    const origin = value.trim();
    let url;
    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CHAT_EXTRA_ORIGINS contém uma origem inválida: "${origin}".`);
    }
    if (url.protocol !== "https:" || url.origin !== origin || origin.includes("*")) {
      throw new Error(`CHAT_EXTRA_ORIGINS aceita só origens HTTPS exatas, como "https://exemplo.com": "${origin}".`);
    }
    return origin;
  });
}
