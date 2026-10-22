// The deck runs in a sandboxed iframe (opaque origin): it cannot reach the app, and the app
// drives it only through the bridge. These tests check the isolation and what depends on it.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fixture, launch, openApp, waitForDeck, waitForSlide, openDecks, deckFrame, clickDeckTab } from './helpers.mjs';

describe('Deck isolation', () => {
    let server;
    let browser;
    let deckA;
    let deckB;

    before(async () => {
        server = await startServer();
        browser = await launch();
        deckA = fixture('deck-a.html', server.origin);
        deckB = fixture('deck-b.html', server.origin);
    });

    after(async () => {
        await browser.close();
        await server.close();
    });

    async function withDeck(name, html, fn) {
        const app = await openApp(browser, server);
        try {
            await openDecks(app.page, [[name, html]]);
            await waitForDeck(app.page, name);
            await fn(app);
            assert.deepEqual(app.errors, [], 'no page errors');
        } finally {
            await app.context.close();
        }
    }

    it('keeps deck scripts away from the app', async () => {
        await withDeck('talk.html', deckA, async ({ page }) => {
            const sandbox = await page.evaluate(() => document.getElementById('content-frame').getAttribute('sandbox'));
            assert.ok(sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin'), sandbox);
            const reach = await (await deckFrame(page)).evaluate(() => {
                const tries = {
                    state: () => window.parent.state,
                    store: () => window.parent.QuartoInkStore,
                    document: () => window.parent.document.title,
                    storage: () => window.parent.localStorage,
                };
                const out = {};
                for (const [name, read] of Object.entries(tries)) {
                    try {
                        out[name] = read() === undefined ? 'undefined' : 'reached';
                    } catch (e) {
                        out[name] = e.name;
                    }
                }
                return { out, origin: window.origin };
            });
            assert.equal(reach.origin, 'null', 'opaque origin');
            assert.deepEqual(reach.out, { state: 'SecurityError', store: 'SecurityError', document: 'SecurityError', storage: 'SecurityError' });
        });
    });

    it('gives the deck working storage', async () => {
        await withDeck('talk.html', deckA, async ({ page }) => {
            const result = await (await deckFrame(page)).evaluate(() => {
                localStorage.setItem('k', 'v');
                sessionStorage.setItem('s', '1');
                document.cookie = 'a=b';
                return [localStorage.getItem('k'), sessionStorage.getItem('s'), localStorage.length, typeof document.cookie];
            });
            assert.deepEqual(result, ['v', '1', 1, 'string']);
        });
    });

    it('shows the current slide and tab in the magnifier lens', async () => {
        await withDeck('talk.html', deckA, async ({ page }) => {
            await page.evaluate(() => goToSlide(state.slides[1]));
            await waitForSlide(page, 2);
            await clickDeckTab(page, '#t2');
            await page.waitForFunction(() => state.currentTabScope === '#p2');
            await page.click('#btn-magnifier');
            const box = await (await page.$('#editor-stage')).boundingBox();
            await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
            const lens = await deckFrame(page, '#zoomple-lens-iframe');
            await page.waitForFunction(() => document.getElementById('zoomple-lens').classList.contains('zp-visible'));
            const shown = async () => lens.evaluate(() => {
                if (!window.Reveal || !Reveal.isReady()) return null;
                const i = Reveal.getIndices();
                const active = document.querySelector('[role="tab"][aria-selected="true"]');
                return `${i.h}-${i.v || 0} ${active ? active.id : ''}`;
            }).catch(() => null);
            let last = null;
            for (let i = 0; i < 50 && last !== '1-0 t2'; i++) {
                last = await shown();
                await page.waitForTimeout(100);
            }
            assert.equal(last, '1-0 t2');
        });
    });

    it('opens slide links through the drawing layer', async () => {
        await withDeck('notes.html', deckB, async ({ page, context }) => {
            await page.evaluate(() => goToSlide(state.slides[state.slides.length - 1]));
            await waitForSlide(page, 6);
            await page.waitForFunction(() => Array.isArray(state.linkRects) && state.linkRects.length > 0);
            assert.equal(await page.evaluate(() => state.isDrawingMode), true);
            const link = await page.frameLocator('#content-frame').locator('#source-link').boundingBox();
            const [popup] = await Promise.all([
                context.waitForEvent('page', { timeout: 10000 }),
                page.mouse.click(link.x + link.width / 2, link.y + link.height / 2),
            ]);
            assert.match(popup.url(), /example\.com\/source/);
            await popup.close();

            // In-deck links: hash navigation is blocked in the sandbox, the bridge moves the slide instead.
            const back = await page.frameLocator('#content-frame').locator('#back-link').boundingBox();
            await page.mouse.click(back.x + back.width / 2, back.y + back.height / 2);
            await waitForSlide(page, 1);
        });
    });
});
