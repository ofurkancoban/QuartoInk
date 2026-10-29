// Saving the ink as a file before it is left behind: closing a deck's tab asks (HTML, PDF,
// both, or close without saving), and leaving the page warns.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fixture, launch, openApp, waitForDeck, openDecks, drawStroke } from './helpers.mjs';

describe('Save before leaving', () => {
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

    const dialog = '.qi-leave-dialog';
    const openCount = (page) => page.evaluate(() => window.QuartoInkDocs.list().length);
    const closeTab = (page) => page.click('.qi-doc-tab.is-active .qi-doc-tab-close');

    it('closes a deck without ink straight away', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await closeTab(page);
            await page.waitForFunction(() => window.QuartoInkDocs.list().length === 0);
            assert.equal(await page.locator(dialog).count(), 0);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('asks before closing a deck with unsaved ink', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await drawStroke(page, 0.6);

            // Cancel keeps the tab.
            await closeTab(page);
            await page.waitForSelector(dialog);
            await page.click(`${dialog} [data-leave="cancel"]`);
            assert.equal(await openCount(page), 1);

            // HTML: the deck with its ink is downloaded, then the tab closes.
            await closeTab(page);
            await page.waitForSelector(dialog);
            const [download] = await Promise.all([page.waitForEvent('download'), page.click(`${dialog} [data-leave="html"]`)]);
            assert.equal(download.suggestedFilename(), 'a-with-ink.html');
            await page.waitForFunction(() => window.QuartoInkDocs.list().length === 0);

            // Saved: opening it again and closing it does not ask.
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await closeTab(page);
            await page.waitForFunction(() => window.QuartoInkDocs.list().length === 0);

            // New ink after the save asks again; "Close without saving" closes.
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await drawStroke(page, 0.3);
            await closeTab(page);
            await page.waitForSelector(dialog);
            await page.click(`${dialog} [data-leave="discard"]`);
            await page.waitForFunction(() => window.QuartoInkDocs.list().length === 0);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('saves a PDF with ink from the dialog', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await drawStroke(page, 0.6);
            await closeTab(page);
            await page.waitForSelector(dialog);
            const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(`${dialog} [data-leave="pdf"]`)]);
            assert.equal(download.suggestedFilename(), 'a-annotated.pdf');
            await page.waitForFunction(() => window.QuartoInkDocs.list().length === 0);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('asks for a deck in the background with unsaved ink', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await drawStroke(page, 0.6);
            await openDecks(page, [['b.html', deckB]]);
            await waitForDeck(page, 'b.html');
            await page.click('.qi-doc-tab:not(.is-active) .qi-doc-tab-close');
            await page.waitForSelector(dialog);
            assert.equal(await page.evaluate(() => state.currentFileName), 'a.html', 'shown to be saved');
            await page.click(`${dialog} [data-leave="discard"]`);
            await page.waitForFunction(() => window.QuartoInkDocs.list().length === 1);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('warns when the page is left with unsaved ink, and offers to save on staying', async () => {
        const { page, context } = await openApp(browser, server);
        try {
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await drawStroke(page, 0.6);
            // Stay on the page this time.
            const types = [];
            page.removeAllListeners('dialog');
            page.on('dialog', (d) => { types.push(d.type()); d.dismiss(); });
            await page.reload({ timeout: 3000 }).catch(() => {});
            assert.deepEqual(types, ['beforeunload']);
            await page.waitForSelector(dialog);
            assert.equal(await page.locator(`${dialog} [data-leave="discard"]`).count(), 0, 'nothing to discard when staying');
            await page.click(`${dialog} [data-leave="cancel"]`);
        } finally {
            await context.close();
        }
    });
});
