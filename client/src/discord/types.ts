export interface DiscordUser {
  id: string;
  username: string;
  globalName: string | null;
  avatarUrl: string;
}

export interface DiscordGuild {
  id: string;
  name: string;
  iconUrl: string | null;
}

export interface DiscordChannel {
  id: string;
  name: string | null;
}

/** Dados de contexto que o Discord fornece ao abrir a Activity. */
export interface ActivityContext {
  instanceId: string;
  platform: 'desktop' | 'mobile';
  guildId: string | null;
  channelId: string | null;
  locationId: string | null;
}

export interface DiscordSession {
  user: DiscordUser;
  scopes: string[];
  /** Data de expiração do token (ISO 8601), informada pelo Discord. */
  expires: string;
  context: ActivityContext;
  /** null quando indisponível (ex.: DM) ou quando a consulta falhou. */
  channel: DiscordChannel | null;
  guild: DiscordGuild | null;
}

export type ConnectionStep = 'ready' | 'authorize' | 'token' | 'authenticate' | 'context';

export type DiscordState =
  | { status: 'unavailable' }
  | { status: 'misconfigured' }
  | { status: 'connecting'; step: ConnectionStep }
  | { status: 'ready'; session: DiscordSession }
  | { status: 'error'; code: string; message: string; detail: string | null };
