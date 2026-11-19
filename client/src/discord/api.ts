import { DISCORD_API_BASE } from '@/discord/config';
import { DiscordSessionError } from '@/discord/errors';
import { guildIconUrl } from '@/discord/cdn';
import type { DiscordGuild } from '@/discord/types';

/**
 * Troca o código OAuth2 por um access_token através do backend Express.
 * O Client Secret existe apenas no servidor; o cliente só envia o código.
 */
export async function exchangeCodeForToken(code: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch('/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new DiscordSessionError('backend_unreachable');
  }

  const data: unknown = await response.json().catch(() => null);
  const body = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;

  if (response.ok && typeof body.access_token === 'string') {
    return body.access_token;
  }

  if (body.error === 'server_misconfigured') {
    throw new DiscordSessionError('server_misconfigured');
  }
  if (typeof body.error !== 'string') {
    // Resposta sem o formato do nosso backend: o proxy não alcançou o Express.
    throw new DiscordSessionError('backend_unreachable', `HTTP ${response.status}`);
  }
  const detail = typeof body.discordError === 'string' ? body.discordError : body.error;
  throw new DiscordSessionError('token_exchange_failed', `HTTP ${response.status} · ${detail}`);
}

/**
 * Busca o servidor atual na lista de servidores do usuário (escopo "guilds"),
 * como no guia oficial "Building an Activity". Falhas retornam null.
 */
export async function fetchCurrentGuild(accessToken: string, guildId: string): Promise<DiscordGuild | null> {
  try {
    const response = await fetch(`${DISCORD_API_BASE}/users/@me/guilds`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return null;
    const guilds = (await response.json()) as Array<{ id: string; name: string; icon?: string | null }>;
    const guild = guilds.find((g) => g.id === guildId);
    return guild ? { id: guild.id, name: guild.name, iconUrl: guildIconUrl(guild) } : null;
  } catch {
    return null;
  }
}
