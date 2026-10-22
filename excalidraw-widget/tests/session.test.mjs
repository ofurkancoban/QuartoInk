// Storage in IndexedDB and restoring the open tabs after a reload.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fixture, launch, openApp, waitForDeck, openDecks, drawStroke, appInfo } from './helpers.mjs';

describe('Session and storage', () => {
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

    const reload = async (page) => {
        await page.reload();
        await page.waitForFunction(() => !!window.QuartoInkDocs && !!window.QuartoInkStore);
        await page.evaluate(() => window.QuartoInkStore.ready);
    };

    it('restores tabs, ink and positions after a reload', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            assert.equal(await page.evaluate(async () => { await window.QuartoInkStore.ready; return window.QuartoInkStore.available; }), true);

            await openDecks(page, [['a.html', deckA], ['b.html', deckB]]);
            await waitForDeck(page, 'a.html');
            await drawStroke(page, 0.7);
            await page.evaluate(() => goToSlide(state.slides[2]));
            await page.waitForFunction(() => /Slide: 3 \/ 5/.test(document.getElementById('slide-indicator').textContent));
            await page.click('.qi-doc-tab:nth-child(2) .qi-doc-tab-main');
            await waitForDeck(page, 'b.html');
            await drawStroke(page, 0.5);
            await page.waitForTimeout(700);

            assert.equal(await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('quarto_anns_')).length), 0,
                'annotations are not in localStorage');

            await reload(page);
            await waitForDeck(page, 'b.html');
            let info = await appInfo(page);
            assert.deepEqual(info.tabs, ['a.html', '*b.html']);
            assert.equal(info.count, 1, 'b ink restored');
            assert.equal(await page.evaluate(() => document.querySelector('.qi-doc-tab:nth-child(1) .qi-doc-tab-slide')?.textContent), '3');

            await page.click('.qi-doc-tab:nth-child(1) .qi-doc-tab-main');
            await waitForDeck(page, 'a.html');
            await page.waitForFunction(() => /Slide: 3 \/ 5/.test(document.getElementById('slide-indicator').textContent));
            info = await appInfo(page);
            assert.equal(info.elements['0-0'].length, 1, 'a ink restored');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('migrates annotations from localStorage', async () => {
        const { page, context } = await openApp(browser, server);
        try {
            await page.evaluate(() => localStorage.setItem('quarto_anns_legacy.html', JSON.stringify({ v: 2, annotations: [], excalidrawScenes: [], annotationEngine: 'excalidraw' })));
            await reload(page);
            const result = await page.evaluate(() => ({
                left: localStorage.getItem('quarto_anns_legacy.html'),
                stored: window.QuartoInkStore.getAnnotations('quarto_anns_legacy.html'),
            }));
            assert.equal(result.left, null);
            assert.ok(result.stored && result.stored.includes('"v":2'));
        } finally {
            await context.close();
        }
    });

    it('forgets closed tabs but keeps their annotations', async () => {
        const { page, context } = await openApp(browser, server);
        try {
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await drawStroke(page, 0.7);
            const annotationKey = await page.evaluate(() => getStorageKey());
            const key = 'a.html|' + Buffer.byteLength(deckA, 'utf8');
            await page.waitForFunction(async (k) => !!(await window.QuartoInkStore.getDeck(k)), key);

            await page.click('.qi-doc-tab.is-active .qi-doc-tab-close');
            await page.waitForTimeout(700);
            await reload(page);
            await page.waitForTimeout(800);
            assert.equal(await page.evaluate(() => window.QuartoInkDocs.list().length), 0);
            assert.equal(await page.evaluate(async (k) => !!(await window.QuartoInkStore.getDeck(k)), key), false);
            assert.ok(await page.evaluate((k) => !!window.QuartoInkStore.getAnnotations(k), annotationKey));
        } finally {
            await context.close();
        }
    });
});
