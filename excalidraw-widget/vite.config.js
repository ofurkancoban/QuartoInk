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
    // Inline the Excalidraw UI fonts referenced by its CSS so the bundle has no absolute asset URLs.
    assetsInlineLimit: 64 * 1024,
    chunkSizeWarningLimit: 8000,
  },
});
