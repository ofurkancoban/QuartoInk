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
});
