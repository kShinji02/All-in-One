/**
 * Lista de origens aceitas para o upgrade do WebSocket.
 *
 * Navegadores sempre enviam o cabeçalho Origin em WebSockets, então esta
 * verificação impede que uma página de terceiros abra conexões em nome do
 * usuário (Cross-Site WebSocket Hijacking). Clientes fora do navegador podem
 * forjar o Origin; por isso a identidade é validada à parte (Etapa 2).
 *
 * Origens aceitas:
 * - https://<client_id>.discordsays.com  → proxy oficial das Activities
 * - https://*.trycloudflare.com          → Cloudflare Tunnel em desenvolvimento
 * - http(s)://localhost | 127.0.0.1 | [::1] em qualquer porta → desenvolvimento local
 */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isAllowedOrigin(origin, { discordClientId = null } = {}) {
  if (typeof origin !== "string" || origin === "" || origin === "null") return false;

  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const { protocol, hostname } = url;
  if (protocol !== "https:" && protocol !== "http:") return false;

  if (LOCAL_HOSTS.has(hostname)) return true;

  // Fora do ambiente local, somente HTTPS.
  if (protocol !== "https:") return false;

  if (hostname.endsWith(".trycloudflare.com")) return true;

  if (discordClientId && hostname === `${discordClientId}.discordsays.com`) return true;

  return false;
}
