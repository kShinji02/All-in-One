import express from "express";
import dotenv from "dotenv";
import fetch from "node-fetch";
dotenv.config({ path: "../.env" });

const app = express();
const port = 3001;

// Valores de exemplo do example.env que não são credenciais reais.
const PLACEHOLDERS = new Set([
  "YOUR_DISCORD_CLIENT_ID_HERE",
  "YOUR_DISCORD_CLIENT_SECRET",
]);

function readEnv(name) {
  const value = process.env[name]?.trim();
  return value && !PLACEHOLDERS.has(value) ? value : null;
}

const clientId = readEnv("VITE_DISCORD_CLIENT_ID");
const clientSecret = readEnv("DISCORD_CLIENT_SECRET");
const missingEnv = [
  !clientId && "VITE_DISCORD_CLIENT_ID",
  !clientSecret && "DISCORD_CLIENT_SECRET",
].filter(Boolean);

if (missingEnv.length > 0) {
  // O servidor continua no ar para que o cliente receba um erro claro,
  // mas a troca de token fica indisponível até o .env ser preenchido.
  console.warn(
    `[config] Variáveis ausentes no .env: ${missingEnv.join(", ")}. ` +
      "A rota /api/token responderá 500 até que sejam configuradas.",
  );
}

// Allow express to parse JSON bodies
app.use(express.json());

// Verificação de disponibilidade. Não revela valores de configuração.
app.get("/api/health", (req, res) => {
  res.send({ ok: true, oauthConfigured: missingEnv.length === 0 });
});

app.post("/api/token", async (req, res) => {
  if (missingEnv.length > 0) {
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
    // Exchange the code for an access_token
    response = await fetch(`https://discord.com/api/oauth2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
      }),
    });
  } catch (err) {
    console.error("[oauth] Falha de rede ao contatar o Discord:", err.message);
    return res.status(502).send({
      error: "discord_unreachable",
      message: "Não foi possível contatar a API do Discord.",
    });
  }

  const data = await response.json().catch(() => null);

  if (!response.ok || typeof data?.access_token !== "string") {
    // Repassa apenas o código de erro público do OAuth2 (ex.: invalid_grant).
    const discordError = typeof data?.error === "string" ? data.error : "unknown_error";
    console.error(`[oauth] Troca de código recusada (${response.status}): ${discordError}`);
    return res.status(response.ok ? 502 : response.status >= 500 ? 502 : 400).send({
      error: "token_exchange_failed",
      discordError,
      message: "O Discord recusou a troca do código de autorização.",
    });
  }

  // Return the access_token to our client as { access_token: "..."}
  res.send({ access_token: data.access_token });
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

  console.error("[server] Erro inesperado:", err?.message ?? err);
  res.status(500).send({ error: "internal_error", message: "Erro interno do servidor." });
});

app.listen(port, () => {
  console.log(`Server listening at http://localhost:${port}`);
});
