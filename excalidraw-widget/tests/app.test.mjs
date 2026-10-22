// Core app behaviour in a real browser: loading, drawing, navigation, toolbar, export.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fixture, launch, openApp, waitForDeck, waitForSlide, openDecks, drawStroke, appInfo } from './helpers.mjs';

describe('Quarto Ink app', () => {
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

    async function withDeck(fn, options) {
        const app = await openApp(browser, server, options);
        try {
            await openDecks(app.page, [['ethnic-diversity.html', deckA]]);
            await waitForDeck(app.page, 'ethnic-diversity.html');
            await fn(app);
            assert.deepEqual(app.errors, [], 'no page errors');
        } finally {
            await app.context.close();
        }
    }

    it('connects to the deck through the bridge', async () => {
        await withDeck(async ({ page }) => {
            const info = await appInfo(page);
            assert.match(info.indicator, /Slide: 1 \/ 5/);
            assert.equal(await page.evaluate(() => state.slides.length), 5);
        });
    });

    it('records the whole first stroke after opening a deck', async () => {
        // Regression: with the deck iframe focused, Excalidraw finalized the first stroke on pointerdown.
        await withDeck(async ({ page }) => {
            await drawStroke(page, 0.7);
            const info = await appInfo(page);
            const drawn = Object.values(info.elements).flat();
            assert.equal(drawn.length, 1, JSON.stringify(info.elements));
            assert.ok(drawn[0].width >= 300, `stroke width ${drawn[0].width}`);
        });
    });

    it('keeps strokes started right after a slide change', async () => {
        // Regression: the canvas is remounted on every slide change; strokes started in
        // that window were dropped, became selection drags, or were never saved.
        await withDeck(async ({ page }) => {
            await page.click('#btn-pen');
            const box = await (await page.$('#editor-stage')).boundingBox();
            const keys = [];
            for (const delay of [0, 20, 40]) {
                await page.keyboard.press('ArrowRight');
                await page.waitForTimeout(delay);
                const x0 = box.x + box.width * 0.25;
                const y0 = box.y + box.height * 0.65;
                await page.mouse.move(x0, y0);
                await page.mouse.down();
                for (let i = 1; i <= 30; i++) {
                    await page.mouse.move(x0 + i * 12, y0 + Math.sin(i / 3) * 25);
                    await page.waitForTimeout(16);
                }
                await page.mouse.up();
                await page.waitForTimeout(1200);
                keys.push(await page.evaluate(() => getCurrentAnnotationKey()));
            }
            assert.equal(new Set(keys).size, 3, `three different slides: ${keys}`);
            const result = await page.evaluate((list) => list.map((key) => {
                const raw = state.excalidrawScenes.get(key);
                const scene = raw ? JSON.parse(raw) : { elements: [] };
                return scene.elements.filter((e) => !e.isDeleted && e.type === 'freedraw').length;
            }), keys);
            assert.deepEqual(result, [1, 1, 1], `saved strokes per slide for ${keys}`);
        });
    });

    it('moves a stroke drawn across a slide change to the new slide', async () => {
        await withDeck(async ({ page }) => {
            await page.click('#btn-pen');
            const box = await (await page.$('#editor-stage')).boundingBox();
            const x0 = box.x + box.width * 0.25;
            const y0 = box.y + box.height * 0.65;
            await page.mouse.move(x0, y0);
            await page.mouse.down();
            for (let i = 1; i <= 40; i++) {
                if (i === 10) await page.evaluate(() => goToSlide(state.slides[2]));
                await page.mouse.move(x0 + i * 10, y0 + Math.sin(i / 3) * 25);
                await page.waitForTimeout(16);
            }
            await page.mouse.up();
            await page.waitForTimeout(1500);
            const counts = await page.evaluate(() => {
                const count = (key) => {
                    const raw = state.excalidrawScenes.get(key);
                    return raw ? JSON.parse(raw).elements.filter((e) => !e.isDeleted).length : 0;
                };
                return { first: count('0-0'), current: count(getCurrentAnnotationKey()), key: getCurrentAnnotationKey() };
            });
            assert.equal(counts.key, '2-0');
            assert.equal(counts.first, 0, 'nothing left on the first slide');
            assert.equal(counts.current, 1, 'the stroke is on the slide shown when the pen lifted');
        });
    });

    it('keeps the ink on the slide after a two-finger scroll or pinch', async () => {
        // Regression: trackpad scrolling and pinching panned the Excalidraw camera, so the ink moved off the slide.
        await withDeck(async ({ page }) => {
            await drawStroke(page, 0.6);
            const box = await (await page.$('#editor-stage')).boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
            await page.mouse.wheel(40, 120);
            await page.keyboard.down('Control');
            await page.mouse.wheel(0, -50);
            await page.keyboard.up('Control');
            await page.waitForTimeout(300);
            const camera = await page.evaluate(() => {
                const a = window.QuartoInkExcalidraw.getAPI().getAppState();
                return [a.scrollX, a.scrollY, a.zoom.value];
            });
            assert.deepEqual(camera, [0, 0, 1]);
        });
    });

    it('types text notes with spaces and arrow keys, one note per click', async () => {
        // Regression: Space toggled the mode and arrows changed slides while typing, and after
        // one note the next click re-opened that note instead of starting a new one.
        await withDeck(async ({ page }) => {
            const box = await (await page.$('#editor-stage')).boundingBox();
            const texts = () => page.evaluate(() => window.QuartoInkExcalidraw.getAPI().getSceneElements()
                .filter((e) => e.type === 'text').map((e) => e.text));
            await page.click('#btn-text');
            await page.waitForTimeout(300);
            await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
            await page.waitForTimeout(200);
            await page.keyboard.type('Hello note');
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.type('X');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
            await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.8);
            await page.waitForTimeout(200);
            await page.keyboard.type('Second one');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
            assert.deepEqual(await texts(), ['Hello noXte', 'Second one']);
            const styles = await page.evaluate(() => window.QuartoInkExcalidraw.getAPI().getSceneElements()
                .filter((e) => e.type === 'text').map((e) => [e.fontSize, e.fontFamily]));
            // Large size, "Normal" sans font (Excalidraw FONT_FAMILY.Nunito = 6)
            assert.deepEqual(styles, [[28, 6], [28, 6]], 'notes start large, in the sans font');
            // The note being typed looks like the finished note: same font smoothing, and not
            // inverted by Excalidraw's dark theme (black text was near-white while typing).
            await page.click('#btn-theme');
            await page.waitForFunction(() => window.QuartoInkExcalidraw.getAPI().getAppState().theme === 'dark');
            await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4);
            await page.waitForSelector('.excalidraw-wysiwyg');
            const look = await page.evaluate(() => {
                const cs = getComputedStyle(document.querySelector('.excalidraw-wysiwyg'));
                return { smoothing: cs.webkitFontSmoothing, filter: cs.filter, opacity: cs.opacity };
            });
            assert.deepEqual(look, { smoothing: 'auto', filter: 'none', opacity: '1' });
            await page.keyboard.press('Escape');
            const info = await page.evaluate(() => ({ slide: state.currentSlide, drawing: state.isDrawingMode, tool: state.tool }));
            assert.deepEqual(info, { slide: '0-0', drawing: true, tool: 'text' });
        });
    });

    it('sizes text from the toolbar, also the note being typed, and keeps it on the next slide', async () => {
        await withDeck(async ({ page }) => {
            const box = await (await page.$('#editor-stage')).boundingBox();
            await page.click('#btn-text');
            await page.waitForTimeout(300);
            assert.equal(await page.locator('.gn-thickness-group.is-text-size').count(), 1, 'size buttons in text mode');
            await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
            await page.waitForTimeout(200);
            await page.keyboard.type('Grow');
            await page.click('.gn-thickness-btn[data-index="2"]');
            await page.waitForTimeout(300);
            await page.keyboard.type('n');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
            const sizeOf = () => page.evaluate(() => window.QuartoInkExcalidraw.getAPI().getSceneElements()
                .filter((e) => e.type === 'text').map((e) => [e.text, e.fontSize]));
            assert.deepEqual(await sizeOf(), [['Grown', 36]], 'the note kept being typed and grew');

            await page.evaluate(() => goToSlide(state.slides[1]));
            await waitForSlide(page, 2);
            await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.85);
            await page.waitForTimeout(200);
            await page.keyboard.type('next');
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);
            assert.deepEqual(await sizeOf(), [['next', 36]]);

            await page.click('#btn-pen');
            assert.equal(await page.locator('.gn-thickness-group.is-text-size').count(), 0, 'stroke buttons again');
        });
    });

    it('keeps a shape tool active for several shapes', async () => {
        // Regression: Excalidraw fell back to selection after one shape while the toolbar still showed the tool.
        await withDeck(async ({ page }) => {
            const box = await (await page.$('#editor-stage')).boundingBox();
            await page.click('#btn-rect');
            for (const [x, y] of [[0.15, 0.2], [0.55, 0.5]]) {
                await page.mouse.move(box.x + box.width * x, box.y + box.height * y);
                await page.mouse.down();
                await page.mouse.move(box.x + box.width * (x + 0.2), box.y + box.height * (y + 0.2), { steps: 5 });
                await page.mouse.up();
                await page.waitForTimeout(300);
            }
            const types = await page.evaluate(() => window.QuartoInkExcalidraw.getAPI().getSceneElements().map((e) => e.type));
            assert.deepEqual(types, ['rectangle', 'rectangle']);
        });
    });

    it('navigates with the arrows and the slide ruler', async () => {
        await withDeck(async ({ page }) => {
            const indicator = () => page.evaluate(() => document.getElementById('slide-indicator').textContent);
            await page.click('#btn-next');
            await page.waitForFunction(() => /Slide: 2 \/ 5/.test(document.getElementById('slide-indicator').textContent));
            assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('qi-slide-ruler')).getPropertyValue('--qi-progress').trim()), '25%');

            const track = await (await page.$('#qi-slide-ruler .qi-ruler-track')).boundingBox();
            await page.mouse.click(track.x + track.width * 0.76, track.y + track.height / 2);
            await page.waitForFunction(() => /Slide: 4 \/ 5/.test(document.getElementById('slide-indicator').textContent));
            await page.mouse.click(track.x + 1, track.y + track.height / 2);
            await page.waitForFunction(() => /Slide: 1 \/ 5/.test(document.getElementById('slide-indicator').textContent));
            assert.match(await indicator(), /Slide: 1 \/ 5/);
        });
    });

    it('switches tools, modes, theme and dock position', async () => {
        await withDeck(async ({ page }) => {
            for (const id of ['#btn-highlighter', '#btn-rect', '#btn-pen']) {
                await page.click(id);
                assert.ok(await page.evaluate((sel) => document.querySelector(sel).classList.contains('active'), id), id);
            }

            // Ink to Shape starts off, and turning it on is remembered.
            const snap = () => page.evaluate(() => [state.inkToShapeEnabled, document.getElementById('btn-magic-snap').classList.contains('active')]);
            assert.deepEqual(await snap(), [false, false]);
            await page.click('#btn-magic-snap');
            assert.deepEqual(await snap(), [true, true]);
            assert.equal(await page.evaluate(() => localStorage.getItem('gn_ink_to_shape_v2')), '1');

            await page.click('#btn-nav-mode');
            assert.equal(await page.evaluate(() => document.getElementById('mode-badge').textContent), 'NAVIGATING');
            await page.click('#btn-nav-mode');
            assert.equal(await page.evaluate(() => document.getElementById('mode-badge').textContent), 'DRAWING');

            const theme = await page.evaluate(() => document.body.dataset.theme);
            await page.click('#btn-theme');
            assert.notEqual(await page.evaluate(() => document.body.dataset.theme), theme);

            await page.click('.gn-pos-switcher .gn-btn-sm:nth-child(3)');
            assert.equal(await page.evaluate(() => document.getElementById('app').dataset.dockPos), 'left');
            await page.click('.gn-pos-switcher .gn-btn-sm:nth-child(1)');
            assert.equal(await page.evaluate(() => document.getElementById('app').dataset.dockPos), 'top');
        });
    });

    it('opens the property panel without the lavender focus ring', async () => {
        await withDeck(async ({ page }) => {
            await page.click('#btn-tool-settings');
            await page.waitForFunction(() => document.getElementById('app').dataset.quartoExcalToolpanelReady === '1');
            const option = await page.$('#excalidraw-host .selected-shape-actions .buttonList label:nth-child(2)');
            await option.click();
            const style = await option.evaluate((el) => ({ cls: el.className, shadow: getComputedStyle(el).boxShadow }));
            assert.match(style.cls, /active/);
            assert.doesNotMatch(style.shadow, /87, 83, 208/, 'no #5753d0 ring');
        });
    });

    it('rejects HTML that is not a presentation', async () => {
        const { page, context } = await openApp(browser, server);
        try {
            await openDecks(page, [['notes.html', '<!doctype html><html><head><title>x</title></head><body><p>plain</p></body></html>']]);
            await page.waitForSelector('#unsupported-format-popup', { state: 'visible' });
            assert.equal(await page.evaluate(() => window.QuartoInkDocs.list().length), 0);
        } finally {
            await context.close();
        }
    });

    it('shows slide titles as text, not HTML', async () => {
        const deck = deckA.replace('<h2>Conclusion</h2>', '<h2>Wrap &lt;b&gt;up&lt;/b&gt;</h2>');
        const { page, context } = await openApp(browser, server);
        try {
            await openDecks(page, [['titles.html', deck]]);
            await waitForDeck(page, 'titles.html');
            const titles = await page.evaluate(() => [...document.querySelectorAll('.sidebar-slide-title')].map((e) => e.textContent));
            assert.ok(titles.some((t) => t.includes('<b>')), JSON.stringify(titles));
            assert.equal(await page.evaluate(() => document.querySelectorAll('.sidebar-slide-title b').length), 0);
        } finally {
            await context.close();
        }
    });
});
