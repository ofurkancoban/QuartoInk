# Excalidraw bundle for Quarto Ink

Builds `dist/quarto-ink-excalidraw.js` (loaded by `../index.html`) and copies
`dist/vendor/html-to-image.js`, which the PDF/PNG export loads into the presentation to render slides.

## Build

```bash
cd excalidraw-widget
npm ci
npm run build
```

`npm run build` will:

1. Apply the palette patches to `node_modules/@excalidraw/excalidraw` (`scripts/patch-excalidraw-palette.mjs`).
2. Run the Vite build from `src/embed.jsx`.
3. Set the bundle version to a content hash and update the `?v=` cache-busting tokens in `../index.html`.
4. Copy fonts and locales into `dist/`, and html-to-image into `dist/vendor/`.

Commit the updated `dist/` and `../index.html` together with your source changes.

## Other commands

```bash
npm run check      # syntax-check the build and UI scripts
npm test           # browser tests in tests/ (run `npx playwright install chromium` once)
```

The tests serve the repository root and the fixture decks in `tests/fixtures/` with reveal.js from
`node_modules`, so they need no network access.
