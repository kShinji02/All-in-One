/**
 * API do Discord simulada para os testes.
 *
 * `createFakeFetch(handler)` devolve um fetch que registra as chamadas e
 * delega a resposta a `handler({ path, authorization, signal })`.
 */
export const DISCORD_ORIGIN = "https://discord.com";

export const APP_ID = "1215413995645968394";
export const BOT_TOKEN = "fake-bot-token-not-real";
export const TOKEN_A = "fake-access-token-ana";
export const TOKEN_B = "fake-access-token-bruno";
export const INSTANCE_1 = "i-1276580072400224306-gc-912952092627435520-912954213460484116";
export const INSTANCE_2 = "i-1276580072400224399-gc-912952092627435520-912954213460484999";

export const USER_A = { id: "205519959982473217", username: "ana", global_name: "Ana", avatar: "a1b2c3", discriminator: "0" };
export const USER_B = { id: "175928847299117063", username: "bruno", global_name: null, avatar: null, discriminator: "0" };

/** Caminho de "Get Current Authorization Information" (validação do token do usuário). */
export const OAUTH_ME_PATH = "/api/v10/oauth2/@me";

/**
 * Resposta de GET /oauth2/@me: aplicação do token, escopos, vencimento e usuário.
 * Por padrão, token desta aplicação (APP_ID) com "identify" e "guilds", válido por 7 dias.
 */
export function authorizationInfo(user, { applicationId = APP_ID, scopes = ["identify", "guilds"], expires = new Date(Date.now() + 7 * 86_400_000).toISOString() } = {}) {
  return {
    application: { id: applicationId, name: "All-in-One", bot_public: false, bot_require_code_grant: false },
    scopes,
    expires,
    ...(scopes.includes("identify") && user && { user }),
  };
}

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export function createFakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const { pathname } = new URL(url);
    const call = { url, path: pathname, authorization: init.headers?.Authorization, signal: init.signal };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

/** Cenário padrão: dois usuários válidos; INSTANCE_1 contém os dois, INSTANCE_2 só o B. */
export function defaultDiscord({ instanceUsers = { [INSTANCE_1]: [USER_A.id, USER_B.id], [INSTANCE_2]: [USER_B.id] } } = {}) {
  return createFakeFetch(({ path, authorization }) => {
    if (path === OAUTH_ME_PATH) {
      if (authorization === `Bearer ${TOKEN_A}`) return json(200, authorizationInfo(USER_A));
      if (authorization === `Bearer ${TOKEN_B}`) return json(200, authorizationInfo(USER_B));
      return json(401, { message: "401: Unauthorized", code: 0 });
    }
    const match = path.match(/^\/api\/v10\/applications\/([^/]+)\/activity-instances\/([^/]+)$/);
    if (match) {
      if (authorization !== `Bot ${BOT_TOKEN}`) return json(401, { message: "401: Unauthorized", code: 0 });
      const instanceId = decodeURIComponent(match[2]);
      const users = instanceUsers[instanceId];
      if (match[1] !== APP_ID || !users) return json(404, { message: "Unknown Activity Instance", code: 10000 });
      return json(200, {
        application_id: APP_ID,
        instance_id: instanceId,
        launch_id: "1276580072400224306",
        location: { id: "gc-912952092627435520-912954213460484116", kind: "gc", channel_id: "912954213460484116", guild_id: "912952092627435520" },
        users,
      });
    }
    return json(404, { message: "Not found" });
  });
}

/** fetch que só termina quando o sinal de tempo limite dispara. */
export function hangingFetch() {
  return createFakeFetch(
    ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
  );
}

/** Logger que captura mensagens para verificar que nenhum segredo vaza. */
export function captureLogger() {
  const lines = [];
  const push = (...args) => lines.push(args.map(String).join(" "));
  return { lines, logger: { error: push, warn: push, info: push, log: push } };
}
