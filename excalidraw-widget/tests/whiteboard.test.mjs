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

    it('zooms a blank page in with a pinch, never out or past its edges', async (t) => {
        if (process.env.QI_BROWSER === 'webkit') {
            t.skip('touch input is emulated through Chromium');
            return;
        }
        const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, hasTouch: true });
        // iPad Safari takes a finger up as a pointer swipe before its touch events: replay that.
        await context.addInitScript(() => {
            window.addEventListener('pointerdown', (e) => {
                if (e.pointerType !== 'touch' || typeof state === 'undefined' || state._fingerSwipe || state._qiPinching) return;
                state._fingerSwipe = { x0: e.clientX, y0: e.clientY, t0: performance.now(), pid: e.pointerId };
            }, true);
        });
        const { page, errors } = await openApp(browser, server, { context });
        const zoom = () => page.evaluate(() => window.QuartoInkExcalidraw.getAPI().getAppState().zoom.value);
        try {
            await openDecks(page, [['zoom.html', deckA]]);
            await waitForDeck(page, 'zoom.html');
            await page.keyboard.press('b');
            await waitWhere(page, '0-0 page 1');
            assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.qi-wb-slide-box')).outlineStyle), 'none', 'no dashed slide box');

            // Two fingers moving apart zoom in.
            const box = await (await page.$('#editor-stage')).boundingBox();
            const cx = box.x + box.width / 2;
            const cy = box.y + box.height / 2;
            const cdp = await context.newCDPSession(page);
            const send = (type, touchPoints) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
            // As fingers do: one lands first, the other follows; they lift one after the other.
            await send('touchStart', [{ x: cx - 60, y: cy, id: 1 }]);
            await page.waitForTimeout(30);
            await send('touchStart', [{ x: cx - 60, y: cy, id: 1 }, { x: cx + 60, y: cy, id: 2 }]);
            for (let d = 70; d <= 180; d += 10) {
                await send('touchMove', [{ x: cx - d, y: cy, id: 1 }, { x: cx + d, y: cy, id: 2 }]);
                await page.waitForTimeout(16);
            }
            await send('touchEnd', [{ x: cx - 180, y: cy, id: 1 }]);
            await page.waitForTimeout(60);
            await send('touchEnd', []);
            await page.waitForTimeout(400);
            const zoomed = await zoom();
            assert.ok(zoomed > 2.5 && zoomed < 3.5, `pinched to about 3x (${zoomed})`);
            assert.match(await page.textContent('#qi-whiteboard-chip .qi-wb-title'), /Page 1 · \d+%/);
            assert.equal(await page.evaluate(() => state.currentWhiteboard !== null), true, 'the pinch did not swipe to another slide');

            // A pinch whose end never arrives (a system gesture took the fingers): the next lone
            // finger frees the canvas again, so the pen still draws.
            const lost = await page.evaluate(({ x, y }) => {
                const target = document.querySelector('#excalidraw-host canvas');
                const touch = (id, dx) => new Touch({ identifier: id, target, clientX: x + dx, clientY: y });
                const fire = (type, touches, changed) => target.dispatchEvent(new TouchEvent(type, { touches, targetTouches: touches, changedTouches: changed, bubbles: true, cancelable: true }));
                const a = touch(5, -60);
                const b = touch(6, 60);
                fire('touchstart', [a], [a]);
                fire('touchstart', [a, b], [b]);
                const held = state._fingerGestureBlocksExcalCanvas;
                // No touchend for 5 and 6. Then a new finger:
                const c = touch(9, 0);
                fire('touchstart', [c], [c]);
                fire('touchend', [], [c]);
                return { held, blocked: state._fingerGestureBlocksExcalCanvas, pinching: !!state._qiPinching };
            }, { x: cx, y: cy + 100 });
            assert.equal(lost.held, true, 'canvas held during the pinch');
            assert.deepEqual([lost.blocked, lost.pinching], [false, false], 'canvas free again');
            await page.waitForTimeout(600);

            // The page always covers the slide area: a pan stops at its edges.
            await page.evaluate(() => window.QuartoInkWhiteboard.setCamera(-1e5, 1e5, 2));
            await page.waitForFunction(() => window.QuartoInkExcalidraw.getAPI().getAppState().zoom.value === 2);
            const edge = await page.evaluate(() => {
                const m = state.slidesBox;
                const cam = window.QuartoInkWhiteboard.camera();
                // Scene -> screen: (p + scroll) * zoom.
                return { right: (m.x + m.width + cam.scrollX) * cam.zoom, top: (m.y + cam.scrollY) * cam.zoom, m, cam };
            });
            assert.ok(Math.abs(edge.right - (edge.m.x + edge.m.width)) < 1, `right edge on the slide area's right (${JSON.stringify(edge)})`);
            assert.ok(Math.abs(edge.top - edge.m.y) < 1, `top edge on the slide area's top (${edge.top})`);

            // No zoom below 100%, from the host or from Excalidraw itself (trackpad, shortcuts).
            await page.evaluate(() => window.QuartoInkWhiteboard.setCamera(0, 0, 0.4));
            await page.waitForFunction(() => window.QuartoInkExcalidraw.getAPI().getAppState().zoom.value === 1);
            await page.evaluate(() => window.QuartoInkExcalidraw.getAPI().updateScene({ appState: { zoom: { value: 0.5 }, scrollX: 300, scrollY: 0 } }));
            await page.waitForFunction(() => window.QuartoInkExcalidraw.getAPI().getAppState().zoom.value === 1);
            assert.deepEqual(await page.evaluate(() => { const c = window.QuartoInkWhiteboard.camera(); return [c.scrollX, c.scrollY]; }), [0, 0]);

            // Fingers moving together at 100% leave it there.
            await send('touchStart', [{ x: cx - 180, y: cy, id: 3 }, { x: cx + 180, y: cy, id: 4 }]);
            for (let d = 170; d >= 60; d -= 10) {
                await send('touchMove', [{ x: cx - d, y: cy, id: 3 }, { x: cx + d, y: cy, id: 4 }]);
                await page.waitForTimeout(16);
            }
            await send('touchEnd', []);
            await page.waitForTimeout(400);
            assert.equal(await zoom(), 1, 'no zoom out');
            await page.evaluate(() => window.QuartoInkWhiteboard.setCamera(0, 0, 2));

            // Back to 100% from the page tab.
            await page.click('#qi-whiteboard-chip .qi-wb-toggle');
            await page.click('#qi-whiteboard-chip .qi-wb-zoom');
            assert.equal(await zoom(), 1);

            // Ink drawn outside the slide area before (zoomed out) still lands on the exported page.
            const factor = await page.evaluate(() => {
                const m = state.slidesBox;
                const wb = window.QuartoInkWhiteboard.current();
                state.excalidrawScenes.set(window.QuartoInkWhiteboard.keyOf(wb.slideKey, wb.id), JSON.stringify({
                    type: 'excalidraw', version: 2, source: 'test',
                    elements: [{ id: 'far', type: 'rectangle', x: m.x + m.width * 1.5, y: m.y, width: 100, height: 80, angle: 0, strokeColor: '#000', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false }],
                    appState: {}, files: {},
                }));
                const out = window.QuartoInkWhiteboard.exportBox(wb.slideKey, wb.id, m);
                return { factor: out.factor, right: out.box.x + out.box.width, need: m.x + m.width * 1.5 + 100 };
            });
            assert.ok(factor.factor > 1.5, `export area grown to hold the ink (${factor.factor})`);
            assert.ok(factor.right >= factor.need, 'the ink lies inside the exported area');

            // Slides keep their fixed view.
            await page.keyboard.press('ArrowLeft');
            await waitWhere(page, '0-0');
            assert.equal(await zoom(), 1);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });
});
