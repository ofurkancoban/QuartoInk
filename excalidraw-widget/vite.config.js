import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: 'src/embed.jsx',
      output: {
        format: 'iife',
        name: '_QuartoInkExcalidrawBundle',
        entryFileNames: 'quarto-ink-excalidraw.js',
        inlineDynamicImports: true,
        assetFileNames: 'quarto-ink-excalidraw.[ext]',
      },
    },
    chunkSizeWarningLimit: 4500,
  },
});
