/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** ID público da aplicação no Discord Developer Portal. */
  readonly VITE_DISCORD_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
