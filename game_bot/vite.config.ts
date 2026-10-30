import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// app/ is the Mini App; it also imports the pure game rules and the strings from tgcloud/lib/,
// so the server and the client share one copy of each.
export default defineConfig({
  plugins: [preact()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 400,
  },
});
