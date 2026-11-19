/**
 * Acesso tipado às variáveis de ambiente do cliente.
 *
 * Somente variáveis com prefixo VITE_ são incluídas no bundle. Segredos
 * (como DISCORD_CLIENT_SECRET) ficam exclusivamente no servidor Express.
 */
const PLACEHOLDER_CLIENT_ID = 'YOUR_DISCORD_CLIENT_ID_HERE';

const rawClientId = import.meta.env.VITE_DISCORD_CLIENT_ID?.trim() ?? '';

export const env = {
  discordClientId: rawClientId,
  /** true quando o .env tem um Client ID real (não vazio e não o placeholder do example.env). */
  isDiscordClientIdConfigured: rawClientId !== '' && rawClientId !== PLACEHOLDER_CLIENT_ID,
  isDev: import.meta.env.DEV,
  mode: import.meta.env.MODE,
} as const;
