import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ToastProvider } from './ui/components/ui';
import './styles.css';

// La app instalable (PWA) avisa cuando hay versión nueva; en la demo no hay service worker.
if (import.meta.env.MODE !== 'demo') {
  import('virtual:pwa-register').then(({ registerSW }) => {
    const actualizar = registerSW({
      onNeedRefresh() {
        const b = document.createElement('button');
        b.textContent = 'Hay una versión nueva. Toca para actualizar';
        b.className = 'btn primary';
        b.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:max(16px, env(safe-area-inset-bottom, 0px));z-index:70';
        b.onclick = () => actualizar(true);
        document.body.appendChild(b);
      },
    });
  }).catch(() => { /* sin service worker */ });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);
