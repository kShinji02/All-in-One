import express from "express";
import { createSlidingWindowLimiter } from "./chat/rate-limit.js";

/** Troca de código OAuth2 → access_token (documentação: "OAuth2 → Authorization Code Grant"). */
export const DISCORD_TOKEN_URL = "https://discord.com/api/oauth2/token";

/**
 * Limites de POST /api/token (antes de existir identidade: o código OAuth não diz quem é).
 *
 * O fluxo legítimo faz UMA troca por abertura da Activity (mais as novas tentativas do botão
 * "Tentar novamente"). Como o proxy do Discord esconde o IP dos usuários, o limite por IP é um
 * teto para ~100 usuários atrás do mesmo IP. O limite global protege a aplicação no Discord
 * mesmo que o atacante troque de IP: no pior caso (todos os códigos inválidos), 2.400 recusas em
 * 10 min, abaixo das 10.000 que levam o Discord a restringir o IP do servidor.
 * Contadores em memória, por instância do servidor.
 */
export const TOKEN_RATE_LIMIT = Object.freeze({ limit: 120, windowMs: 60_000 });
export const TOKEN_GLOBAL_RATE_LIMIT = Object.freeze({ limit: 240, windowMs: 60_000 });
/** Tempo máximo esperando o Discord na troca do código. */
export const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;

/**
 * PROXY_DIAGNOSTICS: ajuda a escolher TRUST_PROXY numa implantação nova. Registra QUANTAS
 * entradas o X-Forwarded-For tem em /api/health (nunca os endereços), no máximo N vezes.
 * Uma requisição feita sem X-Forwarded-For próprio mostra quantos proxies a acrescentaram.
 */
export const PROXY_DIAGNOSTICS_MAX_LOGS = 20;

/**
 * Cabeçalhos de todas as respostas HTTP do backend. Ele só serve JSON (a página da Activity
 * vem do frontend, na Cloudflare), então dá para ser restritivo sem afetar a Activity:
 * - `nosniff`: o navegador não "adivinha" outro tipo para o conteúdo;
 * - `no-store`: nada fica em cache (inclui o access_token de /api/token);
 * - CSP `default-src 'none'; frame-ancestors 'none'` e `X-Frame-Options: DENY`: uma resposta
 *   da API nunca é executada como página nem exibida em iframe (a Activity é a página do
 *   frontend, não estas respostas);
 * - `Referrer-Policy: no-referrer`.
 * Não define CORS: o frontend chama a API pela mesma origem (proxy do Discord ou do Vite).
 */
export const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
});

export function countForwardedFor(header) {
  const raw = Array.isArray(header) ? header.join(",") : header ?? "";
  return raw.split(",").filter((value) => value.trim() !== "").length;
}

/**
 * Cria o app Express (rotas HTTP). Sem efeitos colaterais: não lê o ambiente nem abre
 * portas, para que as rotas possam ser testadas com dependências controladas.
 *
 * `trustProxy` segue a semântica do Express ("trust proxy"): `false` (padrão) usa só o
 * endereço do socket e IGNORA X-Forwarded-For; um número N confia nos N proxies mais
 * próximos; também aceita listas/sub-redes ("loopback", "10.0.0.0/8"). Configure apenas
 * os proxies que você controla: qualquer cliente pode forjar X-Forwarded-For.
 */
export function createApp({
  clientId = null,
  clientSecret = null,
  chatConfigured = false,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = Date.now,
  trustProxy = false,
  tokenRateLimit = TOKEN_RATE_LIMIT,
  tokenGlobalRateLimit = TOKEN_GLOBAL_RATE_LIMIT,
  tokenExchangeTimeoutMs = TOKEN_EXCHANGE_TIMEOUT_MS,
  proxyDiagnostics = false,
  /** Rotas do aceite dos documentos legais (legal/routes.js), montadas em /api/legal. */
  legalRouter = null,
  /** Tipo do armazenamento dos aceites, exibido no /api/health ("postgres", "unavailable"...). */
  legalStore = null,
} = {}) {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.disable("x-powered-by");
  // Respostas dinâmicas e sem cache: ETag não serve para nada e ajuda a identificar o Express.
  app.set("etag", false);
  app.use((req, res, next) => {
    res.set(SECURITY_HEADERS);
    next();
  });

  const oauthConfigured = Boolean(clientId && clientSecret);
  const perClient = createSlidingWindowLimiter({ ...tokenRateLimit, now });
  const global = createSlidingWindowLimiter({ ...tokenGlobalRateLimit, now });
  // Limpeza periódica das chaves inativas (sem acúmulo de memória com muitos IPs).
  const sweeper = setInterval(() => {
    perClient.sweep();
    global.sweep();
  }, tokenRateLimit.windowMs);
  sweeper.unref?.();

  app.use(express.json());

  // Verificação de disponibilidade. Não revela valores de configuração.
  let diagnosticsLeft = proxyDiagnostics ? PROXY_DIAGNOSTICS_MAX_LOGS : 0;
  app.get("/api/health", (req, res) => {
    if (diagnosticsLeft > 0) {
      diagnosticsLeft -= 1;
      logger.log(`[proxy] /api/health: X-Forwarded-For com ${countForwardedFor(req.headers["x-forwarded-for"])} entrada(s).`);
    }
    res.send({ ok: true, oauthConfigured, chatConfigured, ...(legalStore && { legalStore }) });
  });

  if (legalRouter) app.use("/api/legal", legalRouter);

  /** 429 com Retry-After (segundos, arredondado para cima) e o tempo em ms no corpo. */
  function tooManyRequests(res, retryAfterMs) {
    res.set("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
    return res.status(429).send({
      error: "rate_limited",
      retryAfterMs,
      message: "Muitas tentativas de autenticação. Aguarde e tente novamente.",
    });
  }

  app.post("/api/token", async (req, res) => {
    // Primeiro o limite (antes de validar o corpo): requisições inválidas também contam.
    // `req.ip` respeita "trust proxy": sem proxy confiável, é o endereço real do socket.
    const client = perClient.hit(req.ip ?? "unknown");
    if (!client.allowed) return tooManyRequests(res, client.retryAfterMs);
    const overall = global.hit("all");
    if (!overall.allowed) return tooManyRequests(res, overall.retryAfterMs);

    if (!oauthConfigured) {
      return res.status(500).send({
        error: "server_misconfigured",
        message: "O servidor não tem as credenciais OAuth2 configuradas no .env.",
      });
    }

    const code = req.body?.code;
    if (typeof code !== "string" || code.trim() === "") {
      return res.status(400).send({
        error: "invalid_request",
        message: 'O corpo da requisição deve conter "code" (string).',
      });
    }

    let response;
    try {
      response = await fetchImpl(DISCORD_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
        }),
        signal: AbortSignal.timeout(tokenExchangeTimeoutMs),
      });
    } catch (err) {
      // Só o tipo do erro: a mensagem pode conter a URL ou detalhes da requisição.
      logger.error(`[oauth] Falha de rede ao contatar o Discord (${err?.name ?? "erro"}).`);
      return res.status(502).send({
        error: "discord_unreachable",
        message: "Não foi possível contatar a API do Discord.",
      });
    }

    const data = await response.json().catch(() => null);

    if (!response.ok || typeof data?.access_token !== "string") {
      // Repassa apenas o código de erro público do OAuth2 (ex.: invalid_grant).
      const discordError = typeof data?.error === "string" ? data.error : "unknown_error";
      logger.error(`[oauth] Troca de código recusada (${response.status}): ${discordError}`);
      return res.status(response.ok ? 502 : response.status >= 500 ? 502 : 400).send({
        error: "token_exchange_failed",
        discordError,
        message: "O Discord recusou a troca do código de autorização.",
      });
    }

    res.send({ access_token: data.access_token });
  });

  // Qualquer outro caminho ou método: 404 em JSON (sem a página "Cannot GET" do Express).
  app.use((req, res) => {
    res.status(404).send({ error: "not_found" });
  });

  // Erros não tratados respondem em JSON, sem stack trace, preservando o status
  // HTTP definido pelo body-parser (400, 413, 415...). Demais erros viram 500.
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);

    if (err?.type === "entity.parse.failed") {
      return res.status(400).send({
        error: "invalid_request",
        message: "O corpo da requisição não é um JSON válido.",
      });
    }

    if (err?.type === "entity.too.large") {
      return res.status(413).send({
        error: "payload_too_large",
        message: "O corpo da requisição excede o limite permitido.",
      });
    }

    const status = Number(err?.status ?? err?.statusCode);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return res.status(status).send({
        error: "invalid_request",
        message: "A requisição não pôde ser processada.",
      });
    }

    logger.error("[server] Erro inesperado:", err?.message ?? err);
    res.status(500).send({ error: "internal_error", message: "Erro interno do servidor." });
  });

  /** Para os timers internos (testes). */
  app.locals.close = () => clearInterval(sweeper);
  return app;
}

/**
 * Limite por minuto vindo do ambiente (TOKEN_RATE_LIMIT / TOKEN_GLOBAL_RATE_LIMIT).
 * Vazio → `fallback`; precisa ser um inteiro entre 1 e 10000.
 */
export function parsePerMinute(raw, fallback, name = "limite") {
  const value = raw?.trim();
  if (!value) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 10_000) {
    throw new Error(`${name} deve ser um inteiro entre 1 e 10000 (requisições por minuto): "${value}".`);
  }
  return Object.freeze({ limit: Number(value), windowMs: 60_000 });
}

/**
 * Lê TRUST_PROXY do ambiente. Vazio/"false" → false (padrão seguro); "true" é recusado
 * (confiaria em qualquer X-Forwarded-For); número → hops; outros valores → lista/sub-rede.
 */
export function parseTrustProxy(raw) {
  const value = raw?.trim();
  if (!value || value === "false" || value === "0") return false;
  if (value === "true") {
    throw new Error('TRUST_PROXY=true confiaria em qualquer X-Forwarded-For; use um número de proxies ou uma sub-rede (ex.: "1" ou "loopback").');
  }
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}
