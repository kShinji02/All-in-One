import { afterEach, describe, expect, it } from 'vitest';
import { readLaunchContext } from '@/lib/launch-context';

describe('readLaunchContext', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('fora do Discord (sem frame_id): isDiscord falso e campos nulos', () => {
    expect(readLaunchContext('')).toEqual({
      isDiscord: false,
      platform: 'unknown',
      instanceId: null,
      guildId: null,
      channelId: null,
    });
  });

  it('dentro do Discord: lê os parâmetros que o cliente adiciona à URL', () => {
    const context = readLaunchContext('?frame_id=f1&instance_id=i-1-gc-2-3&platform=mobile&guild_id=2&channel_id=3');
    expect(context).toEqual({
      isDiscord: true,
      platform: 'mobile',
      instanceId: 'i-1-gc-2-3',
      guildId: '2',
      channelId: '3',
    });
  });

  it('isDiscord depende só do frame_id', () => {
    expect(readLaunchContext('?instance_id=i-1&platform=desktop').isDiscord).toBe(false);
    expect(readLaunchContext('?frame_id=x').isDiscord).toBe(true);
  });

  it('plataforma desconhecida vira "unknown"', () => {
    expect(readLaunchContext('?frame_id=f&platform=tv').platform).toBe('unknown');
    expect(readLaunchContext('?frame_id=f&platform=desktop').platform).toBe('desktop');
  });

  it('sem argumento, lê window.location.search', () => {
    window.history.replaceState(null, '', '/?frame_id=f2&platform=desktop');
    expect(readLaunchContext()).toMatchObject({ isDiscord: true, platform: 'desktop' });
  });
});
