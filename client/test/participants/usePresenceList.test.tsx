import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePresenceList } from '@/features/participants/hooks/usePresenceList';

type Item = { id: string };
const key = (item: Item) => item.id;
const items = (...ids: string[]): Item[] => ids.map((id) => ({ id }));

function setup(initial: Item[], exitMs?: number) {
  return renderHook(({ list }) => usePresenceList(list, key, exitMs), { initialProps: { list: initial } });
}

const view = (entries: { item: Item; leaving: boolean }[]) =>
  entries.map((e) => (e.leaving ? `${e.item.id}*` : e.item.id));

describe('usePresenceList (Fase 3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('itens iniciais aparecem sem animação de saída', () => {
    const { result } = setup(items('a', 'b'));
    expect(view(result.current)).toEqual(['a', 'b']);
  });

  it('item removido fica marcado como saindo, na mesma posição, e some após 260 ms', () => {
    const { result, rerender } = setup(items('a', 'b', 'c'));
    rerender({ list: items('a', 'c') });
    expect(view(result.current)).toEqual(['a', 'b*', 'c']);

    act(() => vi.advanceTimersByTime(259));
    expect(view(result.current)).toEqual(['a', 'b*', 'c']);

    act(() => vi.advanceTimersByTime(1));
    expect(view(result.current)).toEqual(['a', 'c']);
  });

  it('eventos frequentes não adiam a remoção (correção da auditoria da Fase 3)', () => {
    const { result, rerender } = setup(items('a', 'b'));
    rerender({ list: items('a') });
    // Nova lista (mesmo conteúdo, nova referência) a cada 80 ms, como eventos do SDK.
    for (let elapsed = 80; elapsed < 260; elapsed += 80) {
      act(() => vi.advanceTimersByTime(80));
      rerender({ list: items('a') });
    }
    act(() => vi.advanceTimersByTime(260 - 240));
    expect(view(result.current)).toEqual(['a']);
  });

  it('quem volta durante a animação de saída deixa de sair e não é removido', () => {
    const { result, rerender } = setup(items('a', 'b'));
    rerender({ list: items('a') });
    act(() => vi.advanceTimersByTime(100));
    rerender({ list: items('a', 'b') });
    expect(view(result.current)).toEqual(['a', 'b']);
    act(() => vi.advanceTimersByTime(1_000));
    expect(view(result.current)).toEqual(['a', 'b']);
  });

  it('nova saída durante outra reinicia o prazo para as duas', () => {
    const { result, rerender } = setup(items('a', 'b', 'c'));
    rerender({ list: items('a', 'c') });
    act(() => vi.advanceTimersByTime(200));
    rerender({ list: items('a') });
    expect(view(result.current)).toEqual(['a', 'b*', 'c*']);
    act(() => vi.advanceTimersByTime(259));
    expect(view(result.current)).toEqual(['a', 'b*', 'c*']);
    act(() => vi.advanceTimersByTime(1));
    expect(view(result.current)).toEqual(['a']);
  });

  it('respeita o tempo de saída personalizado', () => {
    const { result, rerender } = setup(items('a', 'b'), 50);
    rerender({ list: items('a') });
    act(() => vi.advanceTimersByTime(50));
    expect(view(result.current)).toEqual(['a']);
  });

  it('desmontar com saída pendente não deixa timers ativos', () => {
    const { rerender, unmount } = setup(items('a', 'b'));
    rerender({ list: items('a') });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
