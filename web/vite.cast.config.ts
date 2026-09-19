import { defineConfig } from 'vite';

export default defineConfig({
  root: 'cast',
  publicDir: false,
  build: {
    outDir: '../dist-cast',
    emptyOutDir: true,
    target: 'es2020',
  },
});
