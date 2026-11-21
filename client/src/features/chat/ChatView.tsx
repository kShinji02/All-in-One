import { useCallback } from 'react';
import { openExternalLink } from '@/discord/external-link';
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
  const { state, sdkReady } = useDiscord();

  // Dentro do Discord (qualquer estado exceto "unavailable"), links SEMPRE passam pelo
  // SDK — mesmo antes do handshake, quando simplesmente não abrem — e nunca pela
  // navegação nativa do iframe, que pularia a confirmação do Discord.
  const insideDiscord = state.status !== 'unavailable';
  const openLink = useCallback((href: string) => void openExternalLink(href, { sdkReady }), [sdkReady]);

  return <ChatPanel chat={chat} onReload={reloadPage} onOpenLink={insideDiscord ? openLink : undefined} />;
}
