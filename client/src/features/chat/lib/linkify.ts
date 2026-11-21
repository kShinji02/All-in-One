/**
 * Divide o texto de uma mensagem em trechos de texto e links seguros.
 *
 * Só http:// e https:// viram link (nunca javascript:, data:, etc.). O texto nunca é
 * interpretado como HTML: a interface renderiza cada trecho como texto do React.
 * Nada é pré-carregado (sem prévia de link ou imagem).
 */
export type TextSegment = { type: 'text'; text: string } | { type: 'link'; text: string; href: string };

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/gi;
/** Pontuação comum no fim de frases que não deve fazer parte do link. */
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?', '…', ']', '}']);

const count = (text: string, char: string) => text.split(char).length - 1;

/**
 * Remove a pontuação final que pertence à frase, não ao link. Um ")" só sai se
 * estiver sobrando: "(veja https://ex.com/a_(b))" → o link termina em "b)".
 */
function trimTrailing(raw: string): string {
  let url = raw;
  for (;;) {
    const last = url.at(-1);
    if (last === ')' && count(url, ')') > count(url, '(')) url = url.slice(0, -1);
    else if (last !== undefined && TRAILING_PUNCTUATION.has(last)) url = url.slice(0, -1);
    else return url;
  }
}

function safeHref(candidate: string): string | null {
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function linkify(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let cursor = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const last = segments.at(-1);
    if (last?.type === 'text') last.text += value;
    else segments.push({ type: 'text', text: value });
  };

  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index;
    const raw = trimTrailing(match[0]);

    const href = safeHref(raw);
    pushText(text.slice(cursor, start));
    if (href) segments.push({ type: 'link', text: raw, href });
    else pushText(raw);
    cursor = start + raw.length;
  }
  pushText(text.slice(cursor));
  return segments;
}
