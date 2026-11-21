import { useId, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { SendHorizontal } from 'lucide-react';
import { cn } from '@/lib/cn';
import { MAX_MESSAGE_LENGTH } from '@/realtime/chat-protocol';
import type { ChatSendResult } from '@/realtime/useChat';

/** A partir de quantos caracteres restantes o contador aparece. */
const COUNTER_THRESHOLD = 50;
const MAX_HEIGHT_PX = 160;

const codePoints = (text: string) => [...text].length;
const clampCodePoints = (text: string, max: number) => (codePoints(text) <= max ? text : [...text].slice(0, max).join(''));

const SEND_ERRORS: Partial<Record<Exclude<ChatSendResult, { ok: true }>['reason'], string>> = {
  too_long: `A mensagem passou de ${MAX_MESSAGE_LENGTH} caracteres.`,
  too_many_pending: 'Há mensagens demais aguardando envio. Espere algumas serem confirmadas.',
  no_session: 'O chat ainda não está disponível.',
  disposed: 'O chat foi reiniciado. Tente de novo.',
};

interface ComposerProps {
  onSend: (text: string) => ChatSendResult;
  /** Motivo para desabilitar o campo (ex.: sem sessão). */
  disabledReason: string | null;
}

/** Campo de mensagem: Enter envia, Shift+Enter quebra linha, limite de 500 code points. */
export function Composer({ onSend, disabledReason }: ComposerProps) {
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  // Espelho síncrono do rascunho: Enter e clique no mesmo instante não enviam duas vezes.
  const draftRef = useRef('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const inputId = useId();

  const disabled = disabledReason !== null;
  const length = codePoints(draft);
  const remaining = MAX_MESSAGE_LENGTH - length;
  const canSend = !disabled && draft.trim() !== '';

  // Altura automática até um máximo; acima disso o campo rola.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [draft]);

  function update(value: string) {
    const clamped = clampCodePoints(value, MAX_MESSAGE_LENGTH);
    draftRef.current = clamped;
    setDraft(clamped);
    setNotice(clamped !== value ? `Limite de ${MAX_MESSAGE_LENGTH} caracteres atingido.` : null);
  }

  function submit() {
    const text = draftRef.current;
    if (disabled || text.trim() === '') return;
    const result = onSend(text);
    if (result.ok) {
      draftRef.current = '';
      setDraft('');
      setNotice(null);
    } else {
      // Recusa local: o texto fica no campo para o usuário ajustar.
      setNotice(SEND_ERRORS[result.reason] ?? null);
    }
    textareaRef.current?.focus();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    submit();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  return (
    <form onSubmit={onSubmit} className="border-t border-white/[0.06] px-3 pt-3 pb-3 sm:px-4" aria-label="Enviar mensagem">
      <div
        className={cn(
          'flex items-end gap-2 rounded-2xl border bg-graphite-950/60 py-1.5 pr-1.5 pl-3.5 transition-colors',
          disabled
            ? 'border-white/[0.05] opacity-70'
            : 'border-white/[0.08] focus-within:border-electric-400/45 focus-within:bg-graphite-950/80 hover:border-white/[0.14]',
        )}
      >
        <label htmlFor={inputId} className="sr-only">
          Mensagem
        </label>
        <textarea
          id={inputId}
          ref={textareaRef}
          rows={1}
          value={draft}
          disabled={disabled}
          placeholder={disabled ? 'Chat indisponível' : 'Escreva uma mensagem…'}
          aria-describedby={hintId}
          enterKeyHint="send"
          onChange={(event) => update(event.target.value)}
          onKeyDown={onKeyDown}
          className="scrollbar-subtle max-h-40 min-h-9 flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed text-graphite-100 placeholder:text-graphite-400 focus:outline-none focus-visible:outline-none disabled:cursor-not-allowed"
        />
        <button
          type="submit"
          disabled={!canSend}
          aria-label="Enviar mensagem"
          className={cn(
            'grid size-9 shrink-0 place-items-center rounded-xl transition',
            canSend
              ? 'bg-gradient-to-br from-neon-500 to-electric-500 text-white shadow-[0_4px_16px_-4px_rgb(168_85_247/0.6)] hover:brightness-110 active:scale-95'
              : 'bg-white/[0.04] text-graphite-400',
          )}
        >
          <SendHorizontal className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div id={hintId} className="mt-1.5 flex min-h-4 items-center justify-between gap-3 px-1 text-[11px] text-graphite-400">
        <p aria-live="polite" className={cn('min-w-0 truncate', notice && 'text-signal-warn')}>
          {disabledReason ?? notice ?? (
            <span className="hidden sm:inline">
              <kbd className="font-mono">Enter</kbd> envia · <kbd className="font-mono">Shift</kbd>+<kbd className="font-mono">Enter</kbd> quebra
              linha
            </span>
          )}
        </p>
        {remaining <= COUNTER_THRESHOLD && (
          <span className={cn('shrink-0 font-mono tabular-nums', remaining === 0 && 'text-signal-warn')} aria-label={`${remaining} caracteres restantes`}>
            {length}/{MAX_MESSAGE_LENGTH}
          </span>
        )}
      </div>
    </form>
  );
}
