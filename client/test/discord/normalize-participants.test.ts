import { describe, expect, it } from 'vitest';
import { normalizeParticipants } from '@/discord/participants';

const raw = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  username: `user${id}`,
  discriminator: '0',
  bot: false,
  ...extra,
});

describe('normalizeParticipants (Fase 3)', () => {
  it('remove duplicados por id, mantendo os dados da última ocorrência', () => {
    const result = normalizeParticipants([
      raw('10', { global_name: 'Antigo' }),
      raw('20'),
      raw('10', { global_name: 'Novo' }),
    ]);
    expect(result.map((p) => p.id)).toEqual(['10', '20']);
    expect(result[0]?.displayName).toBe('Novo');
  });

  it('nome exibido: apelido, depois nome global, depois username', () => {
    const [withNick, withGlobal, onlyUsername, emptyNick] = normalizeParticipants([
      raw('1', { nickname: 'Apelido', global_name: 'Global' }),
      raw('2', { global_name: 'Global' }),
      raw('3'),
      raw('4', { nickname: '', global_name: null }),
    ]);
    expect(withNick?.displayName).toBe('Apelido');
    expect(withGlobal?.displayName).toBe('Global');
    expect(onlyUsername?.displayName).toBe('user3');
    expect(emptyNick?.displayName).toBe('user4');
    expect(emptyNick?.globalName).toBeNull();
  });

  it('avatar personalizado usa o CDN oficial com o hash do avatar', () => {
    const [p] = normalizeParticipants([raw('80351110224678912', { avatar: 'abc123' })]);
    expect(p?.avatarUrl).toBe('https://cdn.discordapp.com/avatars/80351110224678912/abc123.png?size=128');
  });

  it('avatar padrão: (id >> 22) % 6 no sistema novo e discriminator % 5 no legado', () => {
    const id = '175928847299117063';
    const expectedNew = Number((BigInt(id) >> 22n) % 6n);
    const [novo, legado] = normalizeParticipants([raw(id), raw('2', { discriminator: '1234' })]);
    expect(novo?.avatarUrl).toBe(`https://cdn.discordapp.com/embed/avatars/${expectedNew}.png`);
    expect(legado?.avatarUrl).toBe('https://cdn.discordapp.com/embed/avatars/4.png');
  });

  it('preserva a marcação de bot', () => {
    const [human, bot] = normalizeParticipants([raw('1'), raw('2', { bot: true })]);
    expect(human?.bot).toBe(false);
    expect(bot?.bot).toBe(true);
  });

  it('lista vazia continua vazia', () => {
    expect(normalizeParticipants([])).toEqual([]);
  });
});
