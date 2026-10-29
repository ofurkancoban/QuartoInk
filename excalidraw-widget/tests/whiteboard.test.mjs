// Blank pages after a slide: drawn on like slides, walked through with Next/Prev, kept with the
// deck and exported after their slide.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { startServer, fixture, launch, openApp, waitForDeck, openDecks, drawStroke } from './helpers.mjs';

describe('Blank pages', () => {
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

    const where = (page) => page.evaluate(() => {
        const wb = window.QuartoInkWhiteboard.current();
        return `${state.currentSlide}${wb ? ` page ${wb.index + 1}` : ''}`;
    });

    async function waitWhere(page, expected) {
        for (let i = 0; i < 40; i++) {
            if ((await where(page)) === expected) return;
            await page.waitForTimeout(100);
        }
        assert.equal(await where(page), expected);
    }

    it('adds, walks through, keeps and exports blank pages', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['talk.html', deckA]]);
            await waitForDeck(page, 'talk.html');

            await page.keyboard.press('b');
            await waitWhere(page, '0-0 page 1');
            assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('qi-whiteboard')).display), 'block');
            await drawStroke(page, 0.5);
            const keys = await page.evaluate(() => [...state.excalidrawScenes.keys()].filter((k) => k.includes('::wb:')).length);
            assert.equal(keys, 1, 'the page has its own ink');
            assert.equal(await page.evaluate(() => {
                const scene = state.excalidrawScenes.get('0-0');
                return !scene || !JSON.parse(scene).elements.some((e) => !e.isDeleted);
            }), true, 'the slide keeps no ink of the page');

            // Next from the page: the next slide; Prev: back onto the page, then the slide.
            await page.keyboard.press('ArrowRight');
            await waitWhere(page, '1-0');
            await page.keyboard.press('ArrowLeft');
            await waitWhere(page, '0-0 page 1');
            await page.keyboard.press('ArrowLeft');
            await waitWhere(page, '0-0');

            // With the keyboard in the deck, Reveal must not skip the page.
            await page.click('#btn-nav-mode');
            const frame = await (await page.$('#content-frame')).boundingBox();
            await page.mouse.click(frame.x + frame.width / 2, frame.y + frame.height / 2);
            await page.keyboard.press('ArrowRight');
            await waitWhere(page, '0-0 page 1');
            await page.click('#btn-nav-mode');

            // The navigator lists the page under its slide.
            await page.click('#btn-sidebar-toggle');
            assert.equal(await page.locator('#annotation-list .qi-wb-item').count(), 1);

            // Kept with the deck.
            await page.reload();
            await waitForDeck(page, 'talk.html');
            assert.equal(await page.evaluate(() => window.QuartoInkWhiteboard.pages('0-0').length), 1);

            // Exported after its slide in a PDF with ink, not in one without.
            await page.click('#btn-export');
            await page.click('[data-tabs="shown"]');
            const pdfPages = async (item) => {
                if (!(await page.locator('#export-menu:not(.hidden)').count())) await page.click('#btn-export');
                const [download] = await Promise.all([page.waitForEvent('download'), page.click(item)]);
                const text = fs.readFileSync(await download.path()).toString('latin1');
                return Number(/\/Type \/Pages \/Count (\d+)/.exec(text)[1]);
            };
            assert.equal(await pdfPages('#btn-export-pdf-ink'), 6, 'five slides and the blank page');
            assert.equal(await pdfPages('#btn-export-pdf-plain'), 5, 'no empty page without ink');

            // Deleting it asks first, as it has ink.
            await page.evaluate(() => window.QuartoInkWhiteboard.enter('0-0', window.QuartoInkWhiteboard.pages('0-0')[0].id));
            await waitWhere(page, '0-0 page 1');
            assert.equal(await page.isVisible('#qi-whiteboard-chip .qi-wb-delete'), false, 'the page tab starts folded');
            await page.click('#qi-whiteboard-chip .qi-wb-toggle');
            await page.click('#qi-whiteboard-chip .qi-wb-delete');
            await page.locator('.qi-dialog-card button', { hasText: 'Delete page' }).click();
            await waitWhere(page, '0-0');
            assert.equal(await page.evaluate(() => window.QuartoInkWhiteboard.pages('0-0').length), 0);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('keeps added pages and the text written on them across reloads', async () => {
        const { page, context, errors } = await openApp(browser, server);
        const inkOnPage = () => page.evaluate(() => {
            const key = [...state.excalidrawScenes.keys()].find((k) => k.includes('::wb:'));
            if (!key) return [];
            return JSON.parse(state.excalidrawScenes.get(key)).elements.filter((e) => !e.isDeleted).map((e) => e.type === 'text' ? `text:${e.text}` : e.type);
        });
        try {
            await openDecks(page, [['notes.html', deckA]]);
            await waitForDeck(page, 'notes.html');

            // A page with nothing on it yet is kept too.
            await page.keyboard.press('b');
            await waitWhere(page, '0-0 page 1');
            await page.waitForTimeout(800); // the store writes to IndexedDB in the background
            await page.reload();
            await waitForDeck(page, 'notes.html');
            assert.equal(await page.evaluate(() => window.QuartoInkWhiteboard.pages('0-0').length), 1, 'empty page kept');

            // Text written on the page.
            await page.evaluate(() => window.QuartoInkWhiteboard.enter('0-0', window.QuartoInkWhiteboard.pages('0-0')[0].id));
            await waitWhere(page, '0-0 page 1');
            await page.click('#btn-text');
            await page.waitForTimeout(300);
            const box = await (await page.$('#editor-stage')).boundingBox();
            await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4);
            await page.waitForSelector('#excalidraw-host .excalidraw-wysiwyg');
            await page.keyboard.type('Hello page');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(900);
            assert.deepEqual(await inkOnPage(), ['text:Hello page']);

            await page.reload();
            await waitForDeck(page, 'notes.html');
            await page.evaluate(() => window.QuartoInkWhiteboard.enter('0-0', window.QuartoInkWhiteboard.pages('0-0')[0].id));
            await waitWhere(page, '0-0 page 1');
            assert.deepEqual(await inkOnPage(), ['text:Hello page'], 'text kept after a reload');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });
});
