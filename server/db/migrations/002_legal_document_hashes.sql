-- Identificação exata (SHA-256) do conteúdo dos documentos aceitos.
--
-- Compatível e sem perda de dados:
-- * as colunas novas começam NULL em todos os registros existentes (aceites feitos antes do
--   registro de hashes); nenhum registro histórico é alterado e nenhum hash é inventado;
-- * a unicidade passa a incluir os hashes: o mesmo rótulo de versão com conteúdo diferente
--   é OUTRO documento e exige um aceite novo (os dois registros convivem);
-- * o índice único novo é criado ANTES de remover a chave primária antiga, então a tabela
--   nunca fica sem a garantia de "um registro por usuário e documentos";
-- * roda dentro da transação das migrations (tudo ou nada), sob o advisory lock.
ALTER TABLE legal_acceptances
  ADD COLUMN terms_sha256 text CHECK (terms_sha256 IS NULL OR terms_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN privacy_sha256 text CHECK (privacy_sha256 IS NULL OR privacy_sha256 ~ '^[0-9a-f]{64}$');

CREATE UNIQUE INDEX legal_acceptances_identity ON legal_acceptances (
  discord_user_id,
  terms_version,
  privacy_version,
  (COALESCE(terms_sha256, '')),
  (COALESCE(privacy_sha256, ''))
);

ALTER TABLE legal_acceptances DROP CONSTRAINT legal_acceptances_pkey;
