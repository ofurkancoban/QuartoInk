// Builds the Excalidraw bundle used by Quarto Ink and keeps the host page in sync:
//  1. Runs the Vite build (src/embed.jsx -> dist/quarto-ink-excalidraw.js).
//  2. Derives a content-based version from the bundle and writes it into the bundle.
//  3. Copies fonts and locales into dist/.
//  4. Copies html-to-image into dist/vendor/ (used by the PDF/PNG export inside the deck).
//  5. Updates the "?v=" cache-busting token in ../index.html.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(widgetRoot, '..');
const distDir = path.join(widgetRoot, 'dist');
const prodDist = path.join(widgetRoot, 'node_modules', '@excalidraw', 'excalidraw', 'dist', 'prod');

const BUNDLE_NAME = 'quarto-ink-excalidraw.js';
const VERSION_PLACEHOLDER = '__QI_BUNDLE_VER__';

function main() {
  // 1. Vite build
  execSync('npx vite build', { cwd: widgetRoot, stdio: 'inherit' });

  // 2. Content-based bundle version
  const bundlePath = path.join(distDir, BUNDLE_NAME);
  let bundle = fs.readFileSync(bundlePath, 'utf8');
  if (!bundle.includes(VERSION_PLACEHOLDER)) {
    throw new Error(`Version placeholder "${VERSION_PLACEHOLDER}" missing from ${BUNDLE_NAME}`);
  }
  const version = crypto.createHash('sha256').update(bundle).digest('hex').slice(0, 10);
  bundle = bundle.split(VERSION_PLACEHOLDER).join(version);
  fs.writeFileSync(bundlePath, bundle, 'utf8');

  // 3. Copy fonts and locales (kept in dist/ for the host page)
  const assetsDir = path.join(distDir, 'excalidraw-assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  for (const sub of ['fonts', 'locales']) {
    const src = path.join(prodDist, sub);
    if (!fs.existsSync(src)) throw new Error(`Missing ${src}; reinstall dependencies with npm install.`);
    fs.cpSync(src, path.join(distDir, sub), { recursive: true });
    fs.cpSync(src, path.join(assetsDir, sub), { recursive: true });
  }

  // 4. Slide renderer for the PDF/PNG export (loaded into the deck iframe on demand)
  const vendorDir = path.join(distDir, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  // html-to-image shrinks every copied font size (25.6px -> 24.9px), which changes where lines
  // wrap; the export must match the deck exactly, so keep font sizes as they are.
  const rendererSource = fs.readFileSync(
    path.join(widgetRoot, 'node_modules', 'html-to-image', 'dist', 'html-to-image.js'),
    'utf8'
  );
  const FONT_SHRINK = '"font-size"===n&&o.endsWith("px")';
  if (rendererSource.split(FONT_SHRINK).length !== 2) {
    throw new Error('html-to-image changed: the font-size patch no longer applies (see scripts/build.mjs).');
  }
  fs.writeFileSync(
    path.join(vendorDir, 'html-to-image.js'),
    rendererSource.replace(FONT_SHRINK, '!1&&' + FONT_SHRINK),
    'utf8'
  );
  fs.copyFileSync(
    path.join(widgetRoot, 'node_modules', 'html-to-image', 'LICENSE'),
    path.join(vendorDir, 'html-to-image.LICENSE.txt')
  );

  // 5. Cache-busting tokens in the host page
  const indexPath = path.join(repoRoot, 'index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  const tokenPattern = /(quarto-ink-excalidraw\.js\?v=)[A-Za-z0-9]+/g;
  const matches = indexHtml.match(tokenPattern) || [];
  if (matches.length < 1) {
    throw new Error('Expected a cache-busting token for the bundle in index.html, found none');
  }
  fs.writeFileSync(indexPath, indexHtml.replace(tokenPattern, `$1${version}`), 'utf8');

  console.log(`Build completed. Bundle version: ${version}`);
}

try {
  main();
} catch (err) {
  console.error('[build] Failed:', err.message);
  process.exit(1);
}
