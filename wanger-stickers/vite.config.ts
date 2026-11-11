import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The Mini App is served from the host root (https://app<app_id>.tgcloud.ai/), so the default
// base '/' is right. Heavy libraries (codecs, models) are loaded with dynamic import() and end up
// in their own chunks; they are fetched only when a feature needs them.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 600,
  },
  // ffmpeg.wasm creates its own module worker; pre-bundling breaks it in dev.
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util'] },
});
