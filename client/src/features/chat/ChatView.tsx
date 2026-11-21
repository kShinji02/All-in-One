import { useCallback } from 'react';
import { getDiscordSdk } from '@/discord/sdk';
import { useDiscord } from '@/discord/useDiscord';
import { ChatPanel } from '@/features/chat/components/ChatPanel';
import { reloadPage } from '@/lib/reload-page';
import { useChat } from '@/realtime/useChat';

/**
 * Seção CHAT da Activity. Consome apenas o useChat: a store, a conexão e a
 * reconciliação ficam na camada realtime.
 */
export function ChatView() {
  const chat = useChat();
  const { sdkReady } = useDiscord();

  // Dentro do Discord, links externos passam pelo SDK, que mostra a confirmação de
  // saída do próprio Discord (o iframe da Activity não deve abrir abas por conta própria).
  const openLink = useCallback((href: string) => {
    getDiscordSdk()
      .commands.openExternalLink({ url: href })
      .catch(() => undefined);
  }, []);

  return <ChatPanel chat={chat} onReload={reloadPage} onOpenLink={sdkReady ? openLink : undefined} />;
}
