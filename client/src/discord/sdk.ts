import { DiscordSDK } from '@discord/embedded-app-sdk';
import { env } from '@/config/env';
import { DiscordSessionError, describeUnknownError } from '@/discord/errors';

let instance: DiscordSDK | null = null;

/**
 * Instância única do SDK. Só pode ser criada dentro do Discord: o construtor
 * exige os parâmetros frame_id, instance_id e platform na URL.
 */
export function getDiscordSdk(): DiscordSDK {
  if (instance) return instance;
  try {
    instance = new DiscordSDK(env.discordClientId);
  } catch (error) {
    throw new DiscordSessionError('sdk_init_failed', describeUnknownError(error));
  }
  return instance;
}
