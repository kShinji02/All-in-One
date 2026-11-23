import { fetchJson, HTTP_TIMEOUTS, HttpRequestError } from '@/lib/http';

/**
 * Cliente das rotas /api/legal. O servidor é a única fonte das versões e URLs dos
 * documentos e da confirmação do aceite: nada aqui é guardado no navegador.
 * O token OAuth vai só no cabeçalho Authorization e nunca é registrado.
 */
export interface LegalDocument {
  version: string;
  url: string;
}

export interface LegalDocuments {
  terms: LegalDocument;
  privacy: LegalDocument;
}

export interface LegalStatus {
  documents: LegalDocuments;
  accepted: boolean;
  acceptedAt: string | null;
}

export type LegalErrorCode =
  /** Sem token ou token recusado: sessão do Discord expirada. */
  | 'session_expired'
  /** Os documentos mudaram enquanto a tela estava aberta (409). */
  | 'version_mismatch'
  /** Muitas tentativas (429). */
  | 'rate_limited'
  /** Servidor, banco ou Discord indisponível, ou sem rede. */
  | 'unavailable'
  /** O servidor não respondeu dentro do prazo (ex.: backend acordando). */
  | 'timeout'
  /** A chamada foi cancelada (tela desmontada ou nova verificação): não é exibido. */
  | 'aborted'
  /** Resposta inesperada. */
  | 'unexpected';

export class LegalApiError extends Error {
  constructor(
    readonly code: LegalErrorCode,
    readonly documents: LegalDocuments | null = null,
  ) {
    super(code);
    this.name = 'LegalApiError';
  }
}

function isDocument(value: unknown): value is LegalDocument {
  if (typeof value !== 'object' || value === null) return false;
  const { version, url } = value as Record<string, unknown>;
  return typeof version === 'string' && version !== '' && typeof url === 'string' && /^https:\/\//.test(url);
}

function parseDocuments(value: unknown): LegalDocuments | null {
  if (typeof value !== 'object' || value === null) return null;
  const { terms, privacy } = value as Record<string, unknown>;
  return isDocument(terms) && isDocument(privacy) ? { terms, privacy } : null;
}

export interface LegalRequestOptions {
  /** Cancela a chamada (ex.: a tela foi desmontada). */
  signal?: AbortSignal;
  /** Prazo da chamada inteira; padrão HTTP_TIMEOUTS.legal. */
  timeoutMs?: number;
}

async function request(
  path: string,
  accessToken: string,
  init: RequestInit,
  { signal, timeoutMs = HTTP_TIMEOUTS.legal }: LegalRequestOptions,
): Promise<{ status: number; body: Record<string, unknown> }> {
  let response;
  try {
    response = await fetchJson(
      `/api/legal${path}`,
      { ...init, headers: { ...init.headers, Authorization: `Bearer ${accessToken}` }, cache: 'no-store' },
      { timeoutMs, signal },
    );
  } catch (error) {
    if (error instanceof HttpRequestError && error.kind !== 'network') throw new LegalApiError(error.kind);
    throw new LegalApiError('unavailable');
  }
  const { status, body } = response;
  if (status === 401) throw new LegalApiError('session_expired');
  if (status === 409) throw new LegalApiError('version_mismatch', parseDocuments(body.documents));
  if (status === 429) throw new LegalApiError('rate_limited');
  // 502/504 do proxy do Discord também chegam aqui (backend fora ou demorando).
  if (status >= 500) throw new LegalApiError('unavailable');
  return { status, body };
}

/** GET /api/legal/status: documentos atuais e se o usuário já os aceitou. */
export async function fetchLegalStatus(accessToken: string, options: LegalRequestOptions = {}): Promise<LegalStatus> {
  const { status, body } = await request('/status', accessToken, {}, options);
  const documents = parseDocuments(body.documents);
  if (status !== 200 || !documents || typeof body.accepted !== 'boolean') throw new LegalApiError('unexpected');
  return { documents, accepted: body.accepted, acceptedAt: typeof body.acceptedAt === 'string' ? body.acceptedAt : null };
}

/** POST /api/legal/acceptance: registra o aceite das versões exibidas ao usuário. */
export async function submitLegalAcceptance(
  accessToken: string,
  documents: LegalDocuments,
  options: LegalRequestOptions = {},
): Promise<{ acceptedAt: string }> {
  // Repetir depois de um timeout é seguro: o servidor registra o aceite sem duplicar.
  const { status, body } = await request(
    '/acceptance',
    accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ termsVersion: documents.terms.version, privacyVersion: documents.privacy.version }),
    },
    options,
  );
  if ((status !== 200 && status !== 201) || body.accepted !== true || typeof body.acceptedAt !== 'string') {
    throw new LegalApiError('unexpected');
  }
  return { acceptedAt: body.acceptedAt };
}
