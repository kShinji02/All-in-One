import { DISCORD_API_BASE } from '@/discord/config';
import { DiscordSessionError } from '@/discord/errors';
import { guildIconUrl } from '@/discord/cdn';
import type { DiscordGuild } from '@/discord/types';
import { fetchJson, HTTP_TIMEOUTS, HttpRequestError } from '@/lib/http';

/**
 * Troca o código OAuth2 por um access_token através do backend Express.
 * O Client Secret existe apenas no servidor; o cliente só envia o código.
 */
export async function exchangeCodeForToken(code: string, timeoutMs: number = HTTP_TIMEOUTS.tokenExchange): Promise<string> {
  let response;
  try {
    response = await fetchJson(
      '/api/token',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) },
      { timeoutMs },
    );
  } catch (error) {
    // Sem resposta no prazo: backend acordando (Render Free) ou proxy travado. "Tentar novamente"
    // refaz o fluxo inteiro (novo código OAuth), então não há risco de reutilizar o código.
    if (error instanceof HttpRequestError && error.kind === 'timeout') {
      throw new DiscordSessionError('backend_timeout', `sem resposta em ${Math.round(timeoutMs / 1000)} s`);
    }
    throw new DiscordSessionError('backend_unreachable');
  }

  const { body, ok, status } = response;

  if (ok && typeof body.access_token === 'string') {
    return body.access_token;
  }

  if (body.error === 'server_misconfigured') {
    throw new DiscordSessionError('server_misconfigured');
  }
  if (typeof body.error !== 'string') {
    // Resposta sem o formato do nosso backend: o proxy (Discord/Render) não alcançou o Express.
    // 502/503/504 = backend acordando ou fora do ar por instantes (passageiro).
    if (status === 502 || status === 503 || status === 504) throw new DiscordSessionError('backend_unavailable', `HTTP ${status}`);
    throw new DiscordSessionError('backend_unreachable', `HTTP ${status}`);
  }
  const detail = typeof body.discordError === 'string' ? body.discordError : body.error;
  throw new DiscordSessionError('token_exchange_failed', `HTTP ${status} · ${detail}`);
}

/**
 * Busca o servidor atual na lista de servidores do usuário (escopo "guilds"),
 * como no guia oficial "Building an Activity". Falhas retornam null.
 */
export async function fetchCurrentGuild(
  accessToken: string,
  guildId: string,
  timeoutMs: number = HTTP_TIMEOUTS.optional,
): Promise<DiscordGuild | null> {
  try {
    // Com prazo curto: é um dado opcional e a sessão espera por ele na etapa "context".
    const { ok, data } = await fetchJson(
      `${DISCORD_API_BASE}/users/@me/guilds`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
      { timeoutMs },
    );
    if (!ok || !Array.isArray(data)) return null;
    const guilds = data as Array<{ id: string; name: string; icon?: string | null }>;
    const guild = guilds.find((g) => g?.id === guildId);
    return guild ? { id: guild.id, name: guild.name, iconUrl: guildIconUrl(guild) } : null;
  } catch {
    return null;
  }
}
