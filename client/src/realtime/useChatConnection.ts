import { useContext } from 'react';
import { ChatConnectionContext, type ChatConnectionContextValue } from '@/realtime/ChatConnectionProvider';

export function useChatConnection(): ChatConnectionContextValue {
  const context = useContext(ChatConnectionContext);
  if (!context) {
    throw new Error('useChatConnection deve ser usado dentro de <ChatConnectionProvider>.');
  }
  return context;
}
