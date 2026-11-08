import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'cast',
  publicDir: false,
  build: {
    outDir: '../dist-cast',
    emptyOutDir: true,
    target: 'es2020',
    // The sender page, and Den's Cast receiver (`receiver.html`), a page of its own that the Chromecast loads.
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('./cast/index.html', import.meta.url)),
        receiver: fileURLToPath(new URL('./cast/receiver.html', import.meta.url)),
      },
    },
  },
});
