/**
 * Lê o contexto de inicialização a partir da URL.
 *
 * Quando a Activity é aberta dentro do Discord, o cliente adiciona
 * parâmetros de query (frame_id, instance_id, platform, ...). Fora do
 * Discord eles não existem. Esta leitura é passiva e não substitui o
 * Embedded App SDK, que será integrado na próxima fase.
 */
export type LaunchPlatform = 'desktop' | 'mobile' | 'unknown';

export interface LaunchContext {
  /** true quando a página foi carregada pelo Discord (frame_id presente). */
  isDiscord: boolean;
  platform: LaunchPlatform;
  instanceId: string | null;
  guildId: string | null;
  channelId: string | null;
}

export function readLaunchContext(search: string = window.location.search): LaunchContext {
  const params = new URLSearchParams(search);
  const rawPlatform = params.get('platform');
  const platform: LaunchPlatform =
    rawPlatform === 'desktop' || rawPlatform === 'mobile' ? rawPlatform : 'unknown';

  return {
    isDiscord: params.has('frame_id'),
    platform,
    instanceId: params.get('instance_id'),
    guildId: params.get('guild_id'),
    channelId: params.get('channel_id'),
  };
}
