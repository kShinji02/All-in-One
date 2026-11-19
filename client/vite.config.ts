import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // O .env fica na raiz do projeto, compartilhado com o servidor Express.
  // Apenas variáveis com prefixo VITE_ chegam ao bundle do cliente.
  envDir: '../',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    // Hosts externos aceitos pelo servidor de desenvolvimento.
    // O ponto inicial libera todos os subdomínios do Cloudflare Tunnel (a URL muda
    // a cada execução), mantendo a proteção contra DNS rebinding para outros hosts.
    // Não use `allowedHosts: true`.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
    hmr: {
      // Necessário quando o app é servido pelo túnel HTTPS dentro do Discord.
      clientPort: 443,
    },
  },
});
