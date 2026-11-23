import { useMemo } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { DiscordProvider } from '@/discord/DiscordProvider';
import { HomeView } from '@/features/home/HomeView';
import { LegalChatWatcher } from '@/legal/LegalChatWatcher';
import { LegalGate } from '@/legal/LegalGate';
import { readLaunchContext } from '@/lib/launch-context';
import { ChatConnectionProvider } from '@/realtime/ChatConnectionProvider';

export function App() {
  const launch = useMemo(() => readLaunchContext(), []);

  return (
    <DiscordProvider launch={launch}>
      <AppShell launch={launch}>
        {/* Chat e participantes só são montados depois que o servidor confirma o aceite. */}
        <LegalGate>
          <ChatConnectionProvider>
            <LegalChatWatcher />
            <HomeView launch={launch} />
          </ChatConnectionProvider>
        </LegalGate>
      </AppShell>
    </DiscordProvider>
  );
}
