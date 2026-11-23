-- Aceites dos documentos legais (Termos de Uso e ciência da Política de Privacidade).
-- Um registro por usuário e par de versões: aceitar de novo as mesmas versões não duplica.
-- Não guarda token, IP, nome ou qualquer outro dado além destes campos.
CREATE TABLE legal_acceptances (
  discord_user_id text NOT NULL CHECK (discord_user_id ~ '^[0-9]{17,20}$'),
  terms_version text NOT NULL CHECK (char_length(terms_version) BETWEEN 1 AND 64),
  privacy_version text NOT NULL CHECK (char_length(privacy_version) BETWEEN 1 AND 64),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  app_version text CHECK (app_version IS NULL OR char_length(app_version) <= 64),
  PRIMARY KEY (discord_user_id, terms_version, privacy_version)
);
