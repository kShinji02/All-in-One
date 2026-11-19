import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Fontes empacotadas localmente: o iframe do Discord bloqueia CDNs externos por CSP.
import '@fontsource-variable/inter';
import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import '@/styles/globals.css';

import { App } from '@/app/App';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Elemento #root não encontrado em index.html');
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
