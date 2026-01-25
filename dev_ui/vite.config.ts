import { defineConfig } from 'vite';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig({
  root: resolve(__dirname, '..'), // Serve from project root so data/derived/ is accessible
  server: {
    port: 3000,
    open: '/dev_ui/index.html'
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, '../src')
    }
  }
});
