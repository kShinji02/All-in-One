import type { ChatAuthor } from '@/realtime/chat-protocol';
import type { ChatEntry } from '@/realtime/message-store';

/** Mensagens seguidas do mesmo autor, nesse intervalo, compartilham o cabeçalho. */
export const GROUP_WINDOW_MS = 5 * 60_000;

export interface MessageGroup {
  /** Chave estável: a da primeira mensagem do grupo. */
  key: string;
  author: ChatAuthor | null;
  own: boolean;
  messages: ChatEntry[];
  /** Rótulo do dia quando este grupo inicia um dia novo na lista. */
  dayLabel: string | null;
}

const dayFormatter = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long' });
const dayWithYearFormatter = new Intl.DateTimeFormat('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' });

const localDayKey = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export function dayLabel(date: Date, now: Date): string {
  if (localDayKey(date) === localDayKey(now)) return 'Hoje';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (localDayKey(date) === localDayKey(yesterday)) return 'Ontem';
  return (date.getFullYear() === now.getFullYear() ? dayFormatter : dayWithYearFormatter).format(date);
}

/** Identidade do autor para agrupar: mensagens locais pertencem ao próprio usuário. */
function authorKey(entry: ChatEntry, self: ChatAuthor | null): string {
  if (entry.own) return `self:${self?.id ?? entry.author?.id ?? ''}`;
  return `user:${entry.author?.id ?? ''}`;
}

export function groupMessages(messages: readonly ChatEntry[], self: ChatAuthor | null, now: Date = new Date()): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let lastDay: string | null = null;
  let lastAuthor: string | null = null;
  let lastTime = 0;

  for (const entry of messages) {
    const date = new Date(entry.createdAt);
    const time = date.getTime();
    const day = localDayKey(date);
    const author = authorKey(entry, self);
    const newDay = day !== lastDay;
    const current = groups.at(-1);

    // Diferença absoluta: uma local (horário do aparelho) pode vir logo após uma confirmada
    // com horário do servidor um pouco à frente; isso não deve quebrar o grupo.
    if (current && !newDay && author === lastAuthor && Math.abs(time - lastTime) <= GROUP_WINDOW_MS) {
      current.messages.push(entry);
    } else {
      groups.push({
        key: entry.key,
        author: entry.author ?? (entry.own ? self : null),
        own: entry.own,
        messages: [entry],
        dayLabel: newDay ? dayLabel(date, now) : null,
      });
    }
    lastDay = day;
    lastAuthor = author;
    lastTime = time;
  }
  return groups;
}
