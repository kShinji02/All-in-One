import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLegalStatus, LegalApiError, submitLegalAcceptance } from '@/legal/api';
import { HTTP_TIMEOUTS } from '@/lib/http';

/* M2: prazo, cancelamento e mapeamento de erros das rotas /api/legal. */

const DOCS = {
  terms: { version: 't-1', url: 'https://exemplo.test/terms.html' },
  privacy: { version: 'p-1', url: 'https://exemplo.test/privacy.html' },
};
const seen: RequestInit[] = [];

function hangingFetch() {
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    seen.push(init);
    return new Promise<Response>((_, reject) =>
      init.signal!.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError'))),
    );
  });
}

async function code(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LegalApiError);
    return (error as LegalApiError).code;
  }
  throw new Error('esperava falha');
}

beforeEach(() => {
  seen.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('cliente /api/legal', () => {
  it('status sem resposta em 20 s → timeout', async () => {
    hangingFetch();
    const pending = code(fetchLegalStatus('tok'));
    await vi.advanceTimersByTimeAsync(HTTP_TIMEOUTS.legal);
    expect(await pending).toBe('timeout');
    expect(seen[0]!.signal!.aborted).toBe(true);
  });

  it('aceite sem resposta no prazo → timeout; prazo configurável', async () => {
    hangingFetch();
    const pending = code(submitLegalAcceptance('tok', DOCS, { timeoutMs: 3_000 }));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await pending).toBe('timeout');
  });

  it('cancelamento pelo chamador → aborted', async () => {
    hangingFetch();
    const controller = new AbortController();
    const pending = code(fetchLegalStatus('tok', { signal: controller.signal }));
    controller.abort();
    expect(await pending).toBe('aborted');
  });

  it('sem rede → unavailable; 502/504 do proxy (HTML) → unavailable', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    expect(await code(fetchLegalStatus('tok'))).toBe('unavailable');
    vi.stubGlobal('fetch', async () => new Response('<html>Gateway Timeout</html>', { status: 504 }));
    expect(await code(fetchLegalStatus('tok'))).toBe('unavailable');
  });

  it('mantém o mapeamento existente (401, 409 com documentos, 429) e o cabeçalho Authorization', async () => {
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      seen.push(init);
      return new Response(JSON.stringify({ error: 'invalid_token' }), { status: 401 });
    });
    expect(await code(fetchLegalStatus('tok'))).toBe('session_expired');
    expect(new Headers(seen[0]!.headers).get('Authorization')).toBe('Bearer tok');
    expect(seen[0]!.cache).toBe('no-store');

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'version_mismatch', documents: DOCS }), { status: 409 }));
    await expect(submitLegalAcceptance('tok', DOCS)).rejects.toMatchObject({ code: 'version_mismatch', documents: DOCS });

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }));
    expect(await code(fetchLegalStatus('tok'))).toBe('rate_limited');
  });

  it('sucesso dentro do prazo', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ documents: DOCS, accepted: true, acceptedAt: '2026-11-22T00:00:00.000Z' }), { status: 200 }));
    await expect(fetchLegalStatus('tok')).resolves.toEqual({ documents: DOCS, accepted: true, acceptedAt: '2026-11-22T00:00:00.000Z' });
  });
});

describe('cliente /api/legal — hashes SHA-256 dos documentos (Fase 2)', () => {
  const HASH_T = 'a'.repeat(64);
  const HASH_P = 'b'.repeat(64);
  const HASHED = {
    terms: { ...DOCS.terms, sha256: HASH_T },
    privacy: { ...DOCS.privacy, sha256: HASH_P },
  };

  it('aceita sha256 válido ou null; recusa hash malformado (resposta inesperada)', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ documents: HASHED, accepted: false, acceptedAt: null }), { status: 200 }));
    expect((await fetchLegalStatus('tok')).documents).toEqual(HASHED);
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ documents: { terms: { ...DOCS.terms, sha256: null }, privacy: DOCS.privacy }, accepted: false, acceptedAt: null }), { status: 200 }));
    expect((await fetchLegalStatus('tok')).documents.terms.sha256).toBeNull();
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ documents: { terms: { ...DOCS.terms, sha256: 'xyz' }, privacy: DOCS.privacy }, accepted: false, acceptedAt: null }), { status: 200 }));
    expect(await code(fetchLegalStatus('tok'))).toBe('unexpected');
  });

  it('o aceite envia os hashes exibidos (e null quando a versão não tem hash); sem o campo, não envia', async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ accepted: true, acceptedAt: '2026-11-23T00:00:00.000Z' }), { status: 201 });
    });
    await submitLegalAcceptance('tok', HASHED);
    await submitLegalAcceptance('tok', { terms: { ...DOCS.terms, sha256: null }, privacy: { ...DOCS.privacy, sha256: null } });
    await submitLegalAcceptance('tok', DOCS);
    expect(bodies).toEqual([
      { termsVersion: 't-1', privacyVersion: 'p-1', termsSha256: HASH_T, privacySha256: HASH_P },
      { termsVersion: 't-1', privacyVersion: 'p-1', termsSha256: null, privacySha256: null },
      { termsVersion: 't-1', privacyVersion: 'p-1' },
    ]);
  });
});
