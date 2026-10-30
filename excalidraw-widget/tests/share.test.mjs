// "Deck with ink": one HTML file that is the plain deck in a browser and brings its ink,
// notes and blank pages back when opened in Quarto Ink.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { startServer, fixture, launch, openApp, waitForDeck, waitForSlide, openDecks, drawStroke, appInfo } from './helpers.mjs';

describe('Deck with ink', () => {
    let server;
    let browser;
    let deckA;

    before(async () => {
        server = await startServer();
        browser = await launch();
        deckA = fixture('deck-a.html', server.origin);
    });

    after(async () => {
        await browser.close();
        await server.close();
    });

    it('saves the deck with its ink and brings it back elsewhere', async () => {
        // Presenter: ink, a note and a blank page, saved as one file.
        const presenter = await openApp(browser, server);
        let shared;
        try {
            const { page } = presenter;
            await openDecks(page, [['talk.html', deckA]]);
            await waitForDeck(page, 'talk.html');
            await drawStroke(page, 0.6);
            await page.click('#btn-sidebar-toggle');
            await page.click('#qi-slide-notes');
            await page.keyboard.type('Shared note');
            await page.evaluate(() => document.activeElement.blur());
            await page.evaluate(() => goToSlide(state.slides[1]));
            await waitForSlide(page, 2);
            await page.keyboard.press('b');
            await page.waitForFunction(() => !!window.QuartoInkWhiteboard.current());
            await page.waitForTimeout(800);
            await page.click('#btn-export');
            const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-shared')]);
            assert.equal(download.suggestedFilename(), 'talk-with-ink.html');
            shared = fs.readFileSync(await download.path(), 'utf8');
            assert.ok(shared.includes('<section'), 'still the deck');
            assert.ok(shared.includes('id="quarto-ink-data"'), 'with the ink block');
            assert.ok(!shared.includes('keyboard: { 32'), 'not the copy prepared for the frame');
            assert.deepEqual(presenter.errors, []);
        } finally {
            await presenter.context.close();
        }

        // Someone else, with nothing stored: the ink, note and blank page come back.
        const viewer = await openApp(browser, server);
        try {
            const { page } = viewer;
            await openDecks(page, [['talk-with-ink.html', shared]]);
            await waitForDeck(page, 'talk-with-ink.html');
            await page.waitForTimeout(600);
            const info = await appInfo(page);
            assert.equal(info.elements['0-0'].length, 1, 'the stroke is back');
            assert.deepEqual(await page.evaluate(() => [...state.slideNotes.entries()]), [['0-0', 'Shared note']]);
            assert.equal(await page.evaluate(() => window.QuartoInkWhiteboard.pages('1-0').length), 1);
            assert.equal(await page.evaluate(() => state.htmlContent.includes('quarto-ink-data')), false, 'the block is taken out');

            // Opened again with other ink here: asks before replacing it.
            await drawStroke(page, 0.3);
            await page.waitForTimeout(800);
            // openFiles waits for the answer, so the question is answered while it runs.
            const reopened = page.evaluate((html) => window.QuartoInkDocs.openFiles([new File([html], 'talk-with-ink.html', { type: 'text/html' })]), shared);
            await page.locator('.qi-dialog-card button', { hasText: 'Keep mine' }).click();
            await reopened;
            await page.waitForTimeout(800);
            assert.equal((await appInfo(page)).elements['0-0'].length, 2, 'kept the local ink');
            await drawStroke(page, 0.8);
            assert.equal((await appInfo(page)).elements['0-0'].length, 3, 'still draws after the question');

            // Opened again, taking the file's ink: it replaces the ink here, and the pen still draws.
            const replaced = page.evaluate((html) => window.QuartoInkDocs.openFiles([new File([html], 'talk-with-ink.html', { type: 'text/html' })]), shared);
            await page.locator('.qi-dialog-card button', { hasText: 'Use the file' }).click();
            await replaced;
            await waitForDeck(page, 'talk-with-ink.html');
            await page.waitForFunction(() => {
                const raw = state.excalidrawScenes.get('0-0');
                const scene = typeof raw === 'string' ? JSON.parse(raw) : raw;
                return !!scene && (scene.elements || []).filter((e) => !e.isDeleted).length === 1;
            }, null, { timeout: 10000 });
            await page.waitForTimeout(800);
            await drawStroke(page, 0.3);
            assert.equal((await appInfo(page)).elements['0-0'].length, 2, 'the file\u2019s stroke and the new one');
            assert.deepEqual(viewer.errors, []);
        } finally {
            await viewer.context.close();
        }
    });
});
