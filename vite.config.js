import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

// Builds the extension's HTML pages: the toolbar popup and the approval window.
// The service worker / content script / inpage script are built separately by
// build.scripts.mjs because they must be plain IIFE files, not ES modules.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        popup: r('index.html'),
        approval: r('approval.html'),
      },
    },
  },
});
