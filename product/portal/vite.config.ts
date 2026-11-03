import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/portal/',
  plugins: [react()],
  build: {
    target: 'es2022',
    outDir: '../../dist/portal',
    emptyOutDir: true,
  },
});
