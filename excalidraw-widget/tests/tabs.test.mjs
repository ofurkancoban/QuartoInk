// Several presentations in tabs: separate ink, instant switching, memory limit.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fixture, launch, openApp, waitForDeck, waitForSlide, openDecks, drawStroke, appInfo, deckFrame, clickDeckTab } from './helpers.mjs';

describe('Presentation tabs', () => {
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

    const clickTab = (page, n) => page.click(`.qi-doc-tab:nth-child(${n}) .qi-doc-tab-main`);

    it('keeps ink per deck and switches back instantly to the same slide', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['a.html', deckA], ['b.html', deckB]]);
            await waitForDeck(page, 'a.html');
            assert.deepEqual((await appInfo(page)).tabs, ['*a.html', 'b.html']);

            await drawStroke(page, 0.7);
            await page.evaluate(() => goToSlide(state.slides[2]));
            await page.waitForFunction(() => /Slide: 3 \/ 5/.test(document.getElementById('slide-indicator').textContent));

            await clickTab(page, 2);
            await waitForDeck(page, 'b.html');
            let info = await appInfo(page);
            assert.equal(info.count, 0, 'b has no ink from a');
            assert.equal(await page.evaluate(() => document.querySelector('.qi-doc-tab:nth-child(1) .qi-doc-tab-slide')?.textContent), '3');
            await drawStroke(page, 0.5);

            // Mark a's iframe: an instant switch must show the same, not reloaded, document.
            for (const parked of await page.$$('#editor-stage iframe.qi-parked-frame')) {
                await (await parked.contentFrame()).evaluate(() => { window.__qiMark = true; });
            }
            const started = Date.now();
            await clickTab(page, 1);
            await page.waitForFunction(() => state.currentFileName === 'a.html'
                && /Slide: 3 \/ 5/.test(document.getElementById('slide-indicator').textContent)
                && !!window.QuartoInkExcalidraw.getAPI());
            const elapsed = Date.now() - started;
            assert.ok(elapsed < 1500, `switch took ${elapsed} ms`);
            assert.equal(await (await deckFrame(page)).evaluate(() => !!window.__qiMark), true);
            await page.waitForTimeout(600);
            info = await appInfo(page);
            assert.equal(info.elements['0-0'].length, 1, 'a keeps its stroke');

            // Drawing still works after an instant switch.
            await page.evaluate(() => goToSlide(state.slides[0]));
            await waitForSlide(page, 1);
            await drawStroke(page, 0.4);
            assert.equal((await appInfo(page)).elements['0-0'].length, 2);

            await clickTab(page, 2);
            await page.waitForFunction(() => state.currentFileName === 'b.html');
            await page.waitForTimeout(600);
            assert.equal((await appInfo(page)).count, 1, 'b keeps its stroke');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('reuses the tab of an already open file and closes tabs', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['a.html', deckA], ['b.html', deckB]]);
            await waitForDeck(page, 'a.html');
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            assert.deepEqual((await appInfo(page)).tabs, ['*a.html', 'b.html']);

            await page.click('.qi-doc-tab.is-active .qi-doc-tab-close');
            await waitForDeck(page, 'b.html');
            assert.deepEqual((await appInfo(page)).tabs, ['*b.html']);

            await page.click('.qi-doc-tab.is-active .qi-doc-tab-close');
            await page.waitForFunction(() => getComputedStyle(document.getElementById('drop-zone')).display !== 'none');
            assert.equal(await page.evaluate(() => document.getElementById('qi-doc-tabs').hidden), true);
            assert.equal(await page.evaluate(() => document.getElementById('app-document-name').textContent), 'Quarto Ink');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('keeps at most four decks loaded and reloads a released one', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            const decks = [1, 2, 3, 4, 5].map((n) => [`d${n}.html`, deckA.replace('<title>Ethnic Diversity in Europe</title>', `<title>Deck ${n}</title>`)]);
            await openDecks(page, decks);
            await waitForDeck(page, 'd1.html');
            await drawStroke(page, 0.7);
            for (const n of [2, 3, 4, 5]) {
                await clickTab(page, n);
                await waitForDeck(page, `d${n}.html`);
            }
            const frames = await page.evaluate(() => document.querySelectorAll('#editor-stage iframe:not(#zoomple-lens-iframe)').length);
            const list = await page.evaluate(() => window.QuartoInkDocs.list());
            assert.ok(frames <= 4, `${frames} frames`);
            assert.equal(list.find((d) => d.name === 'd1.html').live, false);

            await clickTab(page, 1);
            await waitForDeck(page, 'd1.html');
            assert.equal((await appInfo(page)).count, 1, 'released deck keeps its ink');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('reopens the Quarto tab a released deck had selected', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            const decks = [1, 2, 3, 4, 5].map((n) => [`d${n}.html`, deckA.replace('<title>Ethnic Diversity in Europe</title>', `<title>Deck ${n}</title>`)]);
            await openDecks(page, decks);
            await waitForDeck(page, 'd1.html');
            await page.evaluate(() => goToSlide(state.slides[1]));
            await waitForSlide(page, 2);
            // Click where the tab is on screen: the app's tab proxy layer forwards it to the deck.
            await clickDeckTab(page, '#t2');
            await page.waitForFunction(() => state.currentTabScope === '#p2');

            for (const n of [2, 3, 4, 5]) {
                await clickTab(page, n);
                await waitForDeck(page, `d${n}.html`);
            }
            const list = await page.evaluate(() => window.QuartoInkDocs.list());
            assert.equal(list.find((d) => d.name === 'd1.html').live, false, 'd1 was released');

            await clickTab(page, 1);
            await page.waitForFunction(() => state.currentFileName === 'd1.html' && state.currentTabScope === '#p2', null, { timeout: 20000 });
            await waitForSlide(page, 2);
            const selected = await page.frameLocator('#content-frame').locator('[role="tab"][aria-selected="true"]').textContent();
            assert.equal(selected, 'Table');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });
});
