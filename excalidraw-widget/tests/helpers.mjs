// Shared helpers for the browser tests: a static server for the repository root,
// fixture decks (reveal.js served locally, no network), and small page utilities.
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium, webkit } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..');
const REVEAL_DIST = path.resolve(here, '..', 'node_modules', 'reveal.js', 'dist');

const TYPES = {
    '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
};

/** Serve the repository root, plus reveal.js under /__reveal/. Resolves to { url, close }. */
export function startServer() {
    const server = http.createServer((req, res) => {
        const urlPath = decodeURIComponent(req.url.split('?')[0]);
        const isReveal = urlPath.startsWith('/__reveal/');
        const base = isReveal ? REVEAL_DIST : REPO_ROOT;
        const rel = isReveal ? urlPath.slice('/__reveal/'.length) : urlPath;
        let file = path.join(base, rel);
        if (!file.startsWith(base)) {
            res.writeHead(403);
            res.end();
            return;
        }
        if (file.endsWith(path.sep) || file === base) file = path.join(file, 'index.html');
        fs.readFile(file, (err, body) => {
            if (err) {
                res.writeHead(404);
                res.end();
                return;
            }
            // Decks run in sandboxed iframes (opaque origin): reveal.js assets need CORS, as from a CDN.
            const cors = isReveal ? { 'Access-Control-Allow-Origin': '*' } : {};
            res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', ...cors });
            res.end(body);
        });
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const origin = `http://127.0.0.1:${server.address().port}`;
            resolve({ origin, url: `${origin}/index.html`, close: () => new Promise((r) => server.close(r)) });
        });
    });
}

/** Fixture deck HTML with reveal.js pointing at the test server. */
export function fixture(name, origin) {
    const html = fs.readFileSync(path.join(here, 'fixtures', name), 'utf8');
    return html.split('{{REVEAL}}').join(`${origin}/__reveal`);
}

/** Chromium by default; QI_BROWSER=webkit runs the tests in WebKit (Safari, iPad). */
export function launch() {
    return (process.env.QI_BROWSER === 'webkit' ? webkit : chromium).launch();
}

/** New page on the app with error collection. `errors` ignores Reveal's blob-URL history warning. */
export async function openApp(browser, server, options = {}) {
    const context = options.context || await browser.newContext({
        viewport: options.viewport || { width: 1440, height: 900 },
        colorScheme: options.colorScheme || 'light',
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => { if (!/replaceState/.test(e.message)) errors.push(e.message); });
    page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    await page.goto(server.url);
    await page.waitForFunction(() => typeof window.processFileContent === 'function' && !!window.QuartoInkDocs);
    return { context, page, errors };
}

/** Wait until the visible deck's bridge has reported its slides. */
export async function waitForDeck(page, fileName, timeout = 20000) {
    await page.waitForFunction((name) => state.currentFileName === name && state.bridgeAlive
        && /Slide: \d+/.test(document.getElementById('slide-indicator').textContent)
        && !!(window.QuartoInkExcalidraw && window.QuartoInkExcalidraw.getAPI())
        && state.lastMountedSlideKey === getCurrentAnnotationKey(), fileName, { timeout });
    await page.waitForTimeout(400);
}

/** Wait until slide `n` (1-based, as in the status bar) is shown and its annotations are mounted. */
export async function waitForSlide(page, n, timeout = 15000) {
    await page.waitForFunction((num) => new RegExp(`Slide: ${num} /`).test(document.getElementById('slide-indicator').textContent)
        && !!(window.QuartoInkExcalidraw && window.QuartoInkExcalidraw.getAPI())
        && state.lastMountedSlideKey === getCurrentAnnotationKey(), n, { timeout });
    await page.waitForTimeout(400);
}

/** Open decks as if picked together in the file dialog. */
export async function openDecks(page, decks) {
    await page.evaluate((list) => window.QuartoInkDocs.openFiles(list.map(([n, c]) => new File([c], n, { type: 'text/html' }))), decks);
}

/** Draw one wavy stroke on the slide; `at` is the vertical position (0..1). */
export async function drawStroke(page, at = 0.7) {
    const box = await (await page.$('#editor-stage')).boundingBox();
    const x0 = box.x + box.width * 0.3;
    const y0 = box.y + box.height * at;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) {
        await page.mouse.move(x0 + i * 15, y0 + Math.sin(i / 3) * 25);
        await page.waitForTimeout(16);
    }
    await page.mouse.up();
    await page.waitForTimeout(900);
}

/** Snapshot of the app state that tests assert on. */
export function appInfo(page) {
    return page.evaluate(() => {
        const elements = {};
        for (const [key, raw] of state.excalidrawScenes) {
            try {
                const scene = typeof raw === 'string' ? JSON.parse(raw) : raw;
                elements[key] = (scene.elements || []).filter((e) => !e.isDeleted)
                    .map((e) => ({ type: e.type, points: (e.points || []).length, width: Math.round(e.width) }));
            } catch (_e) {}
        }
        const count = Object.values(elements).reduce((n, list) => n + list.length, 0);
        return {
            file: state.currentFileName,
            slide: state.currentSlide,
            indicator: document.getElementById('slide-indicator').textContent,
            tabs: window.QuartoInkDocs.list().map((d) => (d.active ? '*' : '') + d.name),
            elements,
            count,
        };
    });
}

/**
 * The document of a deck iframe (default: the visible deck). Decks run sandboxed, so the app page
 * cannot reach into them; tests evaluate code inside them through Playwright's frame instead.
 */
export async function deckFrame(page, selector = '#content-frame') {
    const handle = await page.$(selector);
    return handle && handle.contentFrame();
}

/**
 * Click a tab of the visible deck (by CSS selector) the way a user does: on the app's tab proxy
 * over it, once the proxies have followed the slide transition onto the tabs.
 */
export async function clickDeckTab(page, selector) {
    let box = null;
    for (let i = 0; i < 50; i++) {
        box = await page.frameLocator('#content-frame').locator(selector).boundingBox();
        const settled = box && await page.evaluate((b) => state.tabRects.some((r) => Math.abs(r.x - b.x) < 1 && Math.abs(r.y - b.y) < 1), box);
        if (settled) break;
        await page.waitForTimeout(100);
    }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
