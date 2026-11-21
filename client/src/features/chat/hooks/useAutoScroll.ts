import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Distância do fim (px) em que o usuário ainda é considerado "no fim" da lista. */
export const BOTTOM_THRESHOLD_PX = 48;

export interface ScrollItem {
  key: string;
  own: boolean;
}

export interface AutoScroll {
  /** O usuário está acompanhando o fim da lista. */
  atBottom: boolean;
  /** Mensagens novas que chegaram enquanto ele lia mensagens antigas. */
  unseen: number;
  onScroll: () => void;
  scrollToBottom: () => void;
}

function distanceFromBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
}

function prefersReducedMotion() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Rolagem do histórico:
 * - ao abrir (primeira leva de itens), vai para o fim;
 * - no fim, acompanha mensagens novas e mudanças de altura (reconciliação, teclado);
 * - lendo mensagens antigas, não mexe na posição e conta as novas que chegaram;
 * - uma mensagem própria nova sempre leva ao fim.
 *
 * As chaves das mensagens otimistas não mudam ao serem confirmadas, então a
 * reconciliação não conta como mensagem nova nem provoca salto.
 */
export function useAutoScroll(
  containerRef: RefObject<HTMLElement | null>,
  items: readonly ScrollItem[],
  /** Muda quando algo ao redor altera a altura da lista (ex.: banner de reconexão). */
  layoutKey?: unknown,
): AutoScroll {
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const atBottomRef = useRef(true);
  const knownRef = useRef<Set<string> | null>(null);

  const stick = useCallback(() => {
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [containerRef]);

  useLayoutEffect(() => {
    const known = knownRef.current;
    if (items.length === 0) {
      knownRef.current = null; // lista vazia: a próxima leva conta como abertura
      return;
    }
    knownRef.current = new Set(items.map((item) => item.key));

    // Itens novos depois do último item já conhecido (chegadas no fim da lista).
    let lastKnownIndex = -1;
    if (known) items.forEach((item, index) => known.has(item.key) && (lastKnownIndex = index));
    const arrived = known ? items.slice(lastKnownIndex + 1).filter((item) => !known.has(item.key)) : [];

    if (!known || atBottomRef.current || arrived.some((item) => item.own)) {
      stick();
      atBottomRef.current = true;
      setAtBottom(true);
      setUnseen(0);
    } else if (arrived.length > 0) {
      setUnseen((count) => count + arrived.length);
    }
  }, [items, stick]);

  // Algo ao redor mudou a altura da lista: quem estava no fim continua no fim, antes da pintura.
  useLayoutEffect(() => {
    if (atBottomRef.current) stick();
  }, [layoutKey, stick]);

  // Mudança de altura do contêiner (teclado virtual, redimensionamento): mantém o fim.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) stick();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [containerRef, stick]);

  const onScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const bottom = distanceFromBottom(el) <= BOTTOM_THRESHOLD_PX;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
    if (bottom) setUnseen(0);
  }, [containerRef]);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    atBottomRef.current = true;
    setAtBottom(true);
    setUnseen(0);
    if (typeof el.scrollTo === 'function') {
      el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [containerRef]);

  return { atBottom, unseen, onScroll, scrollToBottom };
}
