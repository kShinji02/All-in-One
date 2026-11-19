import { useMemo } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { HomeView } from '@/features/home/HomeView';
import { readLaunchContext } from '@/lib/launch-context';

export function App() {
  const launch = useMemo(() => readLaunchContext(), []);

  return (
    <AppShell launch={launch}>
      <HomeView launch={launch} />
    </AppShell>
  );
}
