import { DISCORD_CDN_BASE } from '@/discord/config';

/**
 * URLs de imagem conforme a referência "Image Formatting" da documentação do Discord.
 * O avatar padrão usa (id >> 22) % 6 para o sistema novo de nomes (discriminator "0")
 * e discriminator % 5 para o sistema legado.
 */
export function userAvatarUrl(user: {
  id: string;
  avatar?: string | null;
  discriminator: string;
}): string {
  if (user.avatar) {
    return `${DISCORD_CDN_BASE}/avatars/${user.id}/${user.avatar}.png?size=128`;
  }
  const index =
    user.discriminator === '0'
      ? Number((BigInt(user.id) >> 22n) % 6n)
      : Number(user.discriminator) % 5;
  return `${DISCORD_CDN_BASE}/embed/avatars/${index}.png`;
}

export function guildIconUrl(guild: { id: string; icon?: string | null }): string | null {
  return guild.icon ? `${DISCORD_CDN_BASE}/icons/${guild.id}/${guild.icon}.webp?size=128` : null;
}
