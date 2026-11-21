import { useMemo } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { DiscordProvider } from '@/discord/DiscordProvider';
import { HomeView } from '@/features/home/HomeView';
import { readLaunchContext } from '@/lib/launch-context';
import { ChatConnectionProvider } from '@/realtime/ChatConnectionProvider';

export function App() {
  const launch = useMemo(() => readLaunchContext(), []);

  return (
    <DiscordProvider launch={launch}>
      <ChatConnectionProvider>
        <AppShell launch={launch}>
          <HomeView launch={launch} />
        </AppShell>
      </ChatConnectionProvider>
    </DiscordProvider>
  );
}
