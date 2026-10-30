import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React's scheduler runs its work through a MessageChannel unless setImmediate exists. Safari on
// iPad can lose a message on that channel (seen while a download prompt or the file picker was
// open); the scheduler then waits for it forever, and Excalidraw never renders again until a
// reload. A timer is only delayed there, never lost, so the scheduler gets one before it loads.
const SCHEDULER_TIMER = `if (typeof globalThis.setImmediate !== 'function') {
  globalThis.setImmediate = function (fn) { var args = Array.prototype.slice.call(arguments, 1); return setTimeout(function () { fn.apply(null, args); }, 0); };
  globalThis.clearImmediate = function (id) { clearTimeout(id); };
}`;

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
        intro: SCHEDULER_TIMER,
      },
    },
    // Inline the Excalidraw UI fonts referenced by its CSS so the bundle has no absolute asset URLs.
    assetsInlineLimit: 64 * 1024,
    chunkSizeWarningLimit: 8000,
  },
});
