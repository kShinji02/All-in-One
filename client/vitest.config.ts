import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

/**
 * Configuração de testes do client.
 *
 * Reaproveita o vite.config.ts (alias "@", plugins), que continua sendo a única
 * configuração usada por `npm run dev` e `npm run build`.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      include: ['test/**/*.test.{ts,tsx}'],
      setupFiles: ['./test/setup.ts'],
      // Garantias de que a suíte realmente executa tudo:
      allowOnly: false, // `.only` esquecido faz a execução falhar
      passWithNoTests: false, // nenhum teste encontrado é falha
      restoreMocks: true,
      unstubGlobals: true,
      unstubEnvs: true,
      testTimeout: 10_000,
      // O reporter estrito reprova a execução se houver testes ignorados ou pendentes.
      reporters: ['default', './test/reporters/strict-reporter.ts'],
    },
  }),
);
