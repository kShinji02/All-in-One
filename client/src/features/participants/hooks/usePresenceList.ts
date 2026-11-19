import { useEffect, useState } from 'react';
import type { PresenceEntry } from '@/features/participants/types';

/**
 * Mantém por alguns instantes os itens que saíram da lista, marcados como
 * `leaving`, para que a animação de saída aconteça antes da remoção.
 */
export function usePresenceList<T>(items: readonly T[], getKey: (item: T) => string, exitMs = 260): PresenceEntry<T>[] {
  const [entries, setEntries] = useState<PresenceEntry<T>[]>(() => items.map((item) => ({ item, leaving: false })));

  useEffect(() => {
    setEntries((previous) => {
      const next: PresenceEntry<T>[] = items.map((item) => ({ item, leaving: false }));
      const currentKeys = new Set(items.map(getKey));
      previous.forEach((entry, index) => {
        if (!currentKeys.has(getKey(entry.item))) {
          next.splice(Math.min(index, next.length), 0, { item: entry.item, leaving: true });
        }
      });
      return next;
    });
    // getKey deve ser estável (função definida no módulo); a lista é a dependência real.
  }, [items]);

  // O temporizador reinicia só quando o conjunto de itens saindo muda, e não a
  // cada evento; assim eventos frequentes não adiam a remoção indefinidamente.
  const leavingSignature = entries
    .filter((entry) => entry.leaving)
    .map((entry) => getKey(entry.item))
    .join('|');
  useEffect(() => {
    if (leavingSignature === '') return;
    const timer = setTimeout(() => {
      setEntries((previous) => previous.filter((entry) => !entry.leaving));
    }, exitMs);
    return () => clearTimeout(timer);
  }, [leavingSignature, exitMs]);

  return entries;
}
