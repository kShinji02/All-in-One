import type { DiscordParticipant } from '@/discord/types';

export type ParticipantsState =
  /** A sessão com o Discord ainda não está autenticada. */
  | { status: 'inactive' }
  | { status: 'loading' }
  | { status: 'ready'; participants: DiscordParticipant[] }
  | { status: 'error'; message: string; detail: string | null };

export interface PresenceEntry<T> {
  item: T;
  /** true durante a animação de saída, antes de o item ser removido. */
  leaving: boolean;
}
