import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { viteSingleFile } from 'vite-plugin-singlefile';
import pkg from './package.json' with { type: 'json' };

// mode 'demo' = un solo archivo HTML autocontenido (para la demo publicada).
// mode normal  = app instalable (PWA) para Cloudflare Pages.
export default defineConfig(({ mode }) => ({
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    mode === 'demo'
      ? viteSingleFile()
      : VitePWA({
          registerType: 'prompt',
          includeAssets: ['icon.svg'],
          manifest: {
            name: 'POS Repuestos',
            short_name: 'POS',
            lang: 'es',
            start_url: '/',
            display: 'standalone',
            background_color: '#ffffff',
            theme_color: '#1f3864',
            icons: [{ src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
          },
          workbox: { clientsClaim: true, globPatterns: ['**/*.{js,css,html,svg,json}'], maximumFileSizeToCacheInBytes: 5_000_000 },
        }),
  ],
  build: { outDir: mode === 'demo' ? 'dist-demo' : 'dist' },
  test: { environment: 'node' },
}));
