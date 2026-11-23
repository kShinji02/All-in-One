import { env } from '@/config/env';
import { exchangeCodeForToken, fetchCurrentGuild } from '@/discord/api';
import { userAvatarUrl } from '@/discord/cdn';
import { COMMAND_TIMEOUT_MS, OAUTH_SCOPES, READY_TIMEOUT_MS } from '@/discord/config';
import { DiscordSessionError, describeUnknownError } from '@/discord/errors';
import { getDiscordSdk } from '@/discord/sdk';
import type { ConnectionStep, DiscordChannel, DiscordSession } from '@/discord/types';
import { withTimeout as withCommandTimeout } from '@/lib/with-timeout';

/** Token mantido apenas em memória, para uso futuro dos módulos. Nunca é exibido nem persistido. */
let accessToken: string | null = null;
let pending: Promise<DiscordSession> | null = null;
let currentStep: ConnectionStep = 'ready';
let stepListener: ((step: ConnectionStep) => void) | null = null;

function emitStep(step: ConnectionStep) {
  currentStep = step;
  stepListener?.(step);
}

export function getAccessToken(): string | null {
  return accessToken;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DiscordSessionError('ready_timeout')), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Fluxo oficial: ready() → authorize() → POST /api/token → authenticate().
 *
 * A chamada é memorizada para que o StrictMode (que executa efeitos duas vezes
 * em desenvolvimento) não abra dois modais de autorização nem reutilize o código.
 */
export function startDiscordSession(onStep: (step: ConnectionStep) => void): Promise<DiscordSession> {
  // O ouvinte mais recente substitui o anterior e recebe a etapa atual.
  stepListener = onStep;
  if (pending) {
    onStep(currentStep);
  } else {
    pending = runSession().catch((error: unknown) => {
      pending = null; // permite tentar novamente
      throw error;
    });
  }
  return pending;
}

async function runSession(): Promise<DiscordSession> {
  const onStep = emitStep;
  const sdk = getDiscordSdk();

  onStep('ready');
  await withTimeout(sdk.ready(), READY_TIMEOUT_MS);

  onStep('authorize');
  let code: string;
  try {
    ({ code } = await sdk.commands.authorize({
      client_id: env.discordClientId,
      response_type: 'code',
      state: '',
      prompt: 'none',
      scope: [...OAUTH_SCOPES],
    }));
  } catch (error) {
    throw new DiscordSessionError('authorize_failed', describeUnknownError(error));
  }

  onStep('token');
  const token = await exchangeCodeForToken(code);

  onStep('authenticate');
  let auth: Awaited<ReturnType<typeof sdk.commands.authenticate>>;
  try {
    // O SDK não rejeita comandos sem resposta: sem prazo, a sessão ficaria presa em "Autenticação".
    auth = await withCommandTimeout(sdk.commands.authenticate({ access_token: token }), COMMAND_TIMEOUT_MS, 'AUTHENTICATE');
  } catch (error) {
    throw new DiscordSessionError('authenticate_failed', describeUnknownError(error));
  }
  accessToken = auth.access_token;

  onStep('context');
  const { guildId, channelId } = sdk;
  const [channel, guild] = await Promise.all([
    channelId && guildId ? fetchChannel(channelId) : Promise.resolve(null),
    guildId ? fetchCurrentGuild(auth.access_token, guildId) : Promise.resolve(null),
  ]);

  return {
    user: {
      id: auth.user.id,
      username: auth.user.username,
      globalName: auth.user.global_name ?? null,
      avatarUrl: userAvatarUrl(auth.user),
    },
    scopes: auth.scopes.filter((s): s is Exclude<typeof s, -1> => s !== -1),
    expires: auth.expires,
    context: {
      instanceId: sdk.instanceId,
      platform: sdk.platform,
      guildId,
      channelId,
      locationId: sdk.locationId,
    },
    channel,
    guild,
  };

  async function fetchChannel(id: string): Promise<DiscordChannel | null> {
    try {
      // Dado opcional: sem resposta no prazo, segue sem o nome do canal.
      const result = await withCommandTimeout(sdk.commands.getChannel({ channel_id: id }), COMMAND_TIMEOUT_MS, 'GET_CHANNEL');
      return { id: result.id, name: result.name ?? null };
    } catch {
      return null;
    }
  }
}
