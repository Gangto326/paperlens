import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';

const shared = resolve(__dirname, 'src/shared');

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { output: { format: 'cjs' } } },
  },
  preload: {
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { output: { format: 'cjs' } } },
  },
  renderer: {
    resolve: { alias: { '@shared': shared } },
  },
});
