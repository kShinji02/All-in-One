/**
 * Documentos legais exigidos para usar a Activity (fonte única: o frontend recebe
 * versões e URLs do servidor e nunca as define sozinho).
 *
 * Versionamento: cada documento tem a sua versão. Ao publicar uma alteração do texto,
 * troque a versão correspondente aqui; um aceite registrado para outra versão deixa de
 * valer e o usuário vê a tela de aceite de novo na próxima entrada.
 *
 * As URLs podem ser trocadas por LEGAL_TERMS_URL / LEGAL_PRIVACY_URL sem mudar o código
 * (os documentos ainda não estão publicados: os padrões são os endereços previstos).
 *
 * Identificação exata (SHA-256): LEGAL_DOCUMENT_HASHES liga cada versão ao hash do arquivo
 * PUBLICADO (os bytes que o usuário abre). O registro é só de inclusão: um hash registrado
 * nunca muda; texto novo = versão nova + hash novo. Calcule com `npm run legal:hash`
 * (docs/ACEITE-LEGAL.md). Versões sem hash registrado (ex.: rascunhos não publicados)
 * gravam o aceite sem hash: nenhum hash é inventado.
 */
export const LEGAL_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export const LEGAL_DOCUMENT_VERSIONS = Object.freeze({
  terms: "2026-11-22-rascunho",
  privacy: "2026-11-22-rascunho",
});

/** SHA-256 em hexadecimal minúsculo (64 caracteres). */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Hashes SHA-256 do conteúdo publicado de cada versão: { terms: { [versão]: hash }, privacy: {...} }.
 * Vazio enquanto nenhum documento final foi publicado (os rascunhos atuais não têm hash).
 */
export const LEGAL_DOCUMENT_HASHES = Object.freeze({
  terms: Object.freeze({}),
  privacy: Object.freeze({}),
});

export const DEFAULT_LEGAL_URLS = Object.freeze({
  terms: "https://kshinji02.github.io/All-in-One/terms.html",
  privacy: "https://kshinji02.github.io/All-in-One/privacy.html",
});

function parseDocumentUrl(raw, fallback, name) {
  const value = raw?.trim();
  if (!value) return fallback;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} deve ser uma URL HTTPS válida.`);
  }
  if (url.protocol !== "https:") throw new Error(`${name} deve usar HTTPS.`);
  return url.href;
}

function hashFor(hashes, key, version) {
  const hash = Object.hasOwn(hashes[key] ?? {}, version) ? hashes[key][version] : null;
  if (hash !== null && (typeof hash !== "string" || !SHA256_PATTERN.test(hash))) {
    throw new Error(`Hash SHA-256 inválido para o documento "${key}" versão "${version}".`);
  }
  return hash;
}

/**
 * Documentos atuais: { terms: { version, url, sha256 }, privacy: { version, url, sha256 } }.
 * `sha256` é o hash registrado para a versão, ou null se ainda não houver.
 */
export function resolveLegalDocuments(env = {}, versions = LEGAL_DOCUMENT_VERSIONS, hashes = LEGAL_DOCUMENT_HASHES) {
  for (const [key, version] of Object.entries(versions)) {
    if (!LEGAL_VERSION_PATTERN.test(version)) throw new Error(`Versão inválida para o documento "${key}".`);
  }
  return Object.freeze({
    terms: Object.freeze({
      version: versions.terms,
      url: parseDocumentUrl(env.LEGAL_TERMS_URL, DEFAULT_LEGAL_URLS.terms, "LEGAL_TERMS_URL"),
      sha256: hashFor(hashes, "terms", versions.terms),
    }),
    privacy: Object.freeze({
      version: versions.privacy,
      url: parseDocumentUrl(env.LEGAL_PRIVACY_URL, DEFAULT_LEGAL_URLS.privacy, "LEGAL_PRIVACY_URL"),
      sha256: hashFor(hashes, "privacy", versions.privacy),
    }),
  });
}

/**
 * Identificador da versão da aplicação gravado com o aceite: versão do package.json e,
 * no Render, o commit implantado (RENDER_GIT_COMMIT, definido pelo próprio Render).
 */
export function resolveAppVersion(env = {}, packageVersion = "0.0.0") {
  const commit = env.RENDER_GIT_COMMIT?.trim();
  const short = commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit.slice(0, 7) : null;
  return short ? `${packageVersion}+${short}` : packageVersion;
}
