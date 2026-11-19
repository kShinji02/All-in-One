import { useMemo } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { DiscordProvider } from '@/discord/DiscordProvider';
import { HomeView } from '@/features/home/HomeView';
import { readLaunchContext } from '@/lib/launch-context';

export function App() {
  const launch = useMemo(() => readLaunchContext(), []);

  return (
    <DiscordProvider launch={launch}>
      <AppShell launch={launch}>
        <HomeView launch={launch} />
      </AppShell>
    </DiscordProvider>
  );
}
