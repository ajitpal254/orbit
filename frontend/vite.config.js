import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

// App version shown in the UI (Home footer) and shared by the About
// section. Read from package.json so a version bump is one edit; the
// app is in beta, so this tracks the beta number (0.1.0), not a 1.x
// release. Falls back to 'dev' if package.json can't be read.
let appVersion = 'dev';
try {
  appVersion = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf8')
  ).version || 'dev';
} catch {}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion)
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt' (not 'autoUpdate'): a new service worker installs and
      // waits instead of taking over + auto-reloading the page — an
      // auto-reload mid-call would drop a live voice call. The app
      // registers the SW itself (src/pwa.js) and shows an update toast;
      // the user taps Update when ready.
      registerType: 'prompt',
      // No auto-injected registration script: src/pwa.js registers via
      // virtual:pwa-register so it can pass onNeedRefresh.
      injectRegister: false,
      includeAssets: ['icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Orbit — voice rooms for friends',
        short_name: 'Orbit',
        description: 'Drop into a room and talk. Friends as floating orbs.',
        theme_color: '#0a0618',
        background_color: '#0a0618',
        display: 'standalone',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
      }
    })
  ],
  build: {
    outDir: '../public',
    emptyOutDir: true
  },
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': { target: 'http://localhost:3000', ws: true }
    }
  }
});
