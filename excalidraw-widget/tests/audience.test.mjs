// The audience window (audience.html): follows the presenter's slide and shows the ink.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fixture, launch, openApp, waitForDeck, waitForSlide, openDecks, drawStroke } from './helpers.mjs';

describe('Audience window', () => {
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

    it('hides "add a blank page" on a computer', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            assert.equal(await page.isVisible('#btn-add-page'), false);
            assert.equal(await page.isVisible('#btn-audience'), true);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('mirrors slides, blank pages and ink, and passes keys back', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['talk.html', deckA]]);
            await waitForDeck(page, 'talk.html');
            const [audience] = await Promise.all([context.waitForEvent('page'), page.click('#btn-audience')]);
            const audienceErrors = [];
            audience.on('pageerror', (e) => audienceErrors.push(e.message));
            await audience.waitForLoadState();
            const deck = async () => (await audience.$('#audience-frame')).contentFrame();
            await audience.waitForFunction(() => document.body.classList.contains('has-deck'));
            const inkPixels = () => audience.evaluate(() => {
                const c = document.getElementById('audience-ink');
                if (!c.width) return 0;
                const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
                let n = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++;
                return n;
            });

            await drawStroke(page, 0.6);
            await audience.waitForFunction(() => {
                const c = document.getElementById('audience-ink');
                const d = c.width ? c.getContext('2d').getImageData(0, 0, c.width, c.height).data : [];
                for (let i = 3; i < d.length; i += 4) if (d[i] > 100) return true;
                return false;
            }, null, { timeout: 10000 });
            assert.ok((await inkPixels()) > 200, 'the stroke shows');

            await page.evaluate(() => goToSlide(state.slides[1]));
            await waitForSlide(page, 2);
            for (let i = 0; i < 50; i++) {
                const at = await (await deck()).evaluate(() => window.Reveal && Reveal.getIndices().h).catch(() => null);
                if (at === 1) break;
                await audience.waitForTimeout(100);
            }
            assert.equal(await (await deck()).evaluate(() => Reveal.getIndices().h), 1, 'follows the slide');

            await page.keyboard.press('b');
            await audience.waitForFunction(() => getComputedStyle(document.getElementById('audience-sheet')).display === 'block');

            await audience.keyboard.press('ArrowRight');
            await waitForSlide(page, 3);
            assert.equal(await page.evaluate(() => document.getElementById('btn-audience').classList.contains('active')), true);
            assert.deepEqual(errors, []);
            assert.deepEqual(audienceErrors, []);
        } finally {
            await context.close();
        }
    });

    it('shows the laser trail and the magnifier lens', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['talk.html', deckA]]);
            await waitForDeck(page, 'talk.html');
            const [audience] = await Promise.all([context.waitForEvent('page'), page.click('#btn-audience')]);
            const audienceErrors = [];
            audience.on('pageerror', (e) => audienceErrors.push(e.message));
            await audience.waitForFunction(() => document.body.classList.contains('has-deck'));
            await audience.waitForTimeout(1500);
            const box = await (await page.$('#editor-stage')).boundingBox();

            await page.click('#btn-laser');
            await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
            await page.mouse.down();
            for (let i = 1; i <= 20; i++) {
                await page.mouse.move(box.x + box.width * 0.3 + i * 15, box.y + box.height * 0.5 + Math.sin(i / 3) * 25);
                await page.waitForTimeout(16);
            }
            await audience.waitForFunction(() => {
                const c = document.getElementById('audience-laser');
                const d = c.width ? c.getContext('2d').getImageData(0, 0, c.width, c.height).data : [];
                for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 80 && d[i + 3] > 80) return true;
                return false;
            }, null, { timeout: 5000 });
            await page.mouse.up();

            await page.click('#btn-magnifier');
            await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
            await audience.waitForFunction(() => document.getElementById('audience-lens').classList.contains('visible')
                && !!document.getElementById('audience-lens-frame').getAttribute('src'), null, { timeout: 5000 });
            await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
            await audience.waitForFunction(() => !document.getElementById('audience-lens').classList.contains('visible'), null, { timeout: 5000 });
            assert.deepEqual(errors, []);
            assert.deepEqual(audienceErrors, []);
        } finally {
            await context.close();
        }
    });

    it('shows "add a blank page" in place of the audience button on an iPad', async () => {
        // iPadOS Safari reports itself as a Mac with a touch screen.
        const context = await browser.newContext({
            viewport: { width: 1180, height: 820 },
            hasTouch: true,
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        });
        await context.addInitScript(() => {
            Object.defineProperty(Navigator.prototype, 'maxTouchPoints', { get: () => 5 });
            Object.defineProperty(Navigator.prototype, 'platform', { get: () => 'MacIntel' });
        });
        const { page, errors } = await openApp(browser, server, { context });
        try {
            assert.equal(await page.isVisible('#btn-audience'), false);
            assert.equal(await page.isVisible('#btn-record'), true, 'other buttons stay');
            await openDecks(page, [['talk.html', deckA]]);
            await waitForDeck(page, 'talk.html');
            await page.evaluate(() => window.closeIOSPopup && window.closeIOSPopup()); // "Add to Home Screen" prompt
            await page.waitForTimeout(400);
            await page.click('#btn-add-page');
            await page.waitForFunction(() => window.QuartoInkWhiteboard.pages('0-0').length === 1 && !!window.QuartoInkWhiteboard.current());
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });
});
