import { useContext } from 'react';
import { DiscordContext, type DiscordContextValue } from '@/discord/DiscordProvider';

export function useDiscord(): DiscordContextValue {
  const context = useContext(DiscordContext);
  if (!context) {
    throw new Error('useDiscord deve ser usado dentro de <DiscordProvider>.');
  }
  return context;
}
