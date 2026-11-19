import type { DiscordSDK } from '@discord/embedded-app-sdk';

type OAuthScope = Parameters<DiscordSDK['commands']['authorize']>[0]['scope'][number];

/**
 * Escopos OAuth2 solicitados ao usuário.
 *
 * - identify: identidade do usuário autenticado (commands.authenticate).
 * - guilds:   exigido por commands.getChannel em canais de servidor e para
 *             listar o servidor atual em /users/@me/guilds.
 *
 * Mantenha esta lista mínima: cada escopo novo aparece no modal de
 * consentimento e alguns exigem aprovação do Discord.
 */
export const OAUTH_SCOPES = ['identify', 'guilds'] as const satisfies readonly OAuthScope[];

/** Tempo máximo aguardando o handshake com o cliente do Discord. */
export const READY_TIMEOUT_MS = 10_000;

/**
 * Tempo máximo para um comando RPC responder. O SDK não rejeita comandos
 * sem resposta (a promessa fica pendente), então limitamos a espera.
 */
export const COMMAND_TIMEOUT_MS = 10_000;

export const DISCORD_API_BASE = 'https://discord.com/api/v10';
export const DISCORD_CDN_BASE = 'https://cdn.discordapp.com';
