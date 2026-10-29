// In-app dialogs, accessible toolbar state, property panel tweaks and same-name files.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fixture, launch, openApp, waitForDeck, waitForSlide, openDecks, drawStroke, appInfo, closeTabWithoutSaving } from './helpers.mjs';

describe('Interface details', () => {
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

    const closeActiveTab = async (page) => {
        await closeTabWithoutSaving(page);
        await page.waitForFunction(() => window.QuartoInkDocs.list().length === 0);
    };

    it('shows in-app dialogs instead of browser popups', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            // Start from a focused control: closing the dialog must return focus to it.
            await page.evaluate(() => {
                const b = document.createElement('button');
                b.id = 'qi-test-origin';
                document.body.appendChild(b);
                b.focus();
                window.__qiResults = [];
                window.qiConfirm('Delete?', 'Gone for good.', { confirmText: 'Delete', danger: true })
                    .then((r) => window.__qiResults.push(r));
            });
            const card = page.locator('.qi-dialog-card');
            await card.waitFor();
            assert.equal(await card.getAttribute('role'), 'alertdialog');
            assert.equal(await card.getAttribute('aria-modal'), 'true');
            assert.equal(await page.locator('.qi-dialog-message').textContent(), 'Gone for good.');
            // A dangerous action starts focused on Cancel.
            assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => window.__qiResults.length === 1);
            assert.equal(await page.locator('.qi-dialog').count(), 0);
            assert.equal(await page.evaluate(() => document.activeElement.id), 'qi-test-origin');

            await page.evaluate(() => { window.qiAlert('Note', 'Saved.').then((r) => window.__qiResults.push(r)); });
            await card.waitFor();
            assert.equal(await card.getAttribute('role'), 'dialog');
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => window.__qiResults.length === 2);
            assert.deepEqual(await page.evaluate(() => window.__qiResults), [false, true]);
            assert.deepEqual(errors, [], 'no native alert/confirm was opened');
        } finally {
            await context.close();
        }
    });

    it('names colours and reports the selected tool, colour and width', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            const swatches = await page.$$eval('button.gn-color-swatch', (list) => list.map((b) => ({
                label: b.getAttribute('aria-label'), pressed: b.getAttribute('aria-pressed'),
            })));
            assert.deepEqual(swatches.map((s) => s.label), ['Black', 'Red', 'Green', 'Blue', 'Orange']);
            assert.equal(swatches.filter((s) => s.pressed === 'true').length, 1, 'exactly one colour selected');

            await page.click('button.gn-color-swatch[data-color="#e03131"]');
            await page.waitForFunction(() => document.querySelector('button.gn-color-swatch[data-color="#e03131"]').getAttribute('aria-pressed') === 'true');
            assert.equal(await page.$$eval('button.gn-color-swatch[aria-pressed="true"]', (l) => l.length), 1);

            const pressedTools = await page.$$eval('.gn-tool-btn[aria-pressed="true"]', (l) => l.length);
            assert.equal(pressedTools, 1, 'exactly one tool selected');
            const widths = await page.$$eval('.gn-thickness-btn', (list) => list.map((b) => ({
                name: b.getAttribute('aria-label') || b.title, pressed: b.getAttribute('aria-pressed'),
            })));
            assert.ok(widths.length > 0 && widths.every((w) => w.name), 'every width button has a name');
            assert.equal(widths.filter((w) => w.pressed === 'true').length, 1, 'exactly one width selected');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('hides the opacity slider and names the pen fill', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await page.click('#btn-tool-settings');
            await page.waitForFunction(() => document.getElementById('app').dataset.quartoExcalToolpanelReady === '1');
            await page.waitForFunction(() => [...document.querySelectorAll('#excalidraw-host .selected-shape-actions h3')]
                .some((h) => h.textContent.trim() === 'Fill (closed strokes)'));
            const sliders = await page.$$eval('#excalidraw-host .selected-shape-actions .range-input',
                (list) => list.map((i) => getComputedStyle(i.closest('.control-label')).display));
            assert.ok(sliders.every((d) => d === 'none'), 'opacity slider hidden');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('inserts a picked image once and keeps it on the slide', async () => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
        // Stands in for the system file picker: one PNG, and a second call while it is open fails as in Chrome.
        await context.addInitScript(() => {
            window.__pickerCalls = 0;
            window.showOpenFilePicker = async () => {
                window.__pickerCalls++;
                if (window.__pickerOpen) throw new DOMException('File picker already active.', 'NotAllowedError');
                window.__pickerOpen = true;
                await new Promise((r) => setTimeout(r, 300));
                window.__pickerOpen = false;
                const blob = await (await fetch('/assets/logo.png')).blob();
                const file = new File([blob], 'logo.png', { type: 'image/png' });
                return [{ kind: 'file', name: 'logo.png', getFile: async () => file }];
            };
        });
        const { page, errors } = await openApp(browser, server, { context });
        try {
            await openDecks(page, [['talk.html', deckA]]);
            await waitForDeck(page, 'talk.html');
            await page.click('#btn-image');
            await page.waitForFunction(() => {
                const els = window.QuartoInkExcalidraw.getAPI().getSceneElements();
                return els.length === 1 && els[0].type === 'image' && els[0].width > 0;
            }, null, { timeout: 5000 });
            await page.waitForTimeout(1500);
            assert.equal(await page.evaluate(() => window.__pickerCalls), 1, 'the picker opens once');

            await page.evaluate(() => goToSlide(state.slides[1]));
            await waitForSlide(page, 2);
            await page.evaluate(() => goToSlide(state.slides[0]));
            await waitForSlide(page, 1);
            const images = await page.evaluate(() => window.QuartoInkExcalidraw.getAPI().getSceneElements()
                .filter((e) => e.type === 'image' && e.width > 0).length);
            assert.equal(images, 1, 'the image is still there after a slide change');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('keeps ink of two different files with the same name apart', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['talk.html', deckA]]);
            await waitForDeck(page, 'talk.html');
            await drawStroke(page, 0.7);
            assert.equal((await appInfo(page)).count, 1);
            await closeActiveTab(page);

            await openDecks(page, [['talk.html', deckB]]);
            await waitForDeck(page, 'talk.html');
            assert.equal((await appInfo(page)).count, 0, 'a different talk.html starts empty');
            await closeActiveTab(page);

            await openDecks(page, [['talk.html', deckA]]);
            await waitForDeck(page, 'talk.html');
            assert.equal((await appInfo(page)).count, 1, 'the original talk.html keeps its ink');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('adopts annotations saved under the bare file name', async () => {
        const { page, context, errors } = await openApp(browser, server);
        try {
            await openDecks(page, [['old.html', deckA]]);
            await waitForDeck(page, 'old.html');
            await drawStroke(page, 0.7);
            const keys = await page.evaluate(() => ({ key: getStorageKey(), legacy: getLegacyStorageKey() }));
            assert.notEqual(keys.key, keys.legacy, 'storage key carries a fingerprint');
            await closeActiveTab(page);
            // Move the saved ink to the key used before content fingerprints existed.
            await page.evaluate(({ key, legacy }) => {
                qiSetAnnotations(legacy, qiGetAnnotations(key));
                qiRemoveAnnotations(key);
            }, keys);

            await openDecks(page, [['old.html', deckA]]);
            await waitForDeck(page, 'old.html');
            assert.equal((await appInfo(page)).count, 1, 'legacy ink is shown');
            const legacyLeft = await page.evaluate((legacy) => qiGetAnnotations(legacy), keys.legacy);
            assert.equal(legacyLeft, null, 'legacy entry moved to the new key');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('keeps the property panel below the toolbar when Excalidraw re-creates it', async () => {
        const { page, context, errors } = await openApp(browser, server, { viewport: { width: 1366, height: 954 } });
        try {
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await page.click('#btn-pen');
            await page.waitForFunction(() => document.getElementById('app').dataset.quartoExcalToolpanelReady === '1');
            // A re-created panel has none of the inline styles set when it opened.
            await page.evaluate(() => document.querySelector('#excalidraw-host .selected-shape-actions').removeAttribute('style'));
            await page.waitForTimeout(500); // the panel slides in for 0.3s
            const pos = await page.evaluate(() => {
                const island = document.querySelector('#excalidraw-host .selected-shape-actions .Island').getBoundingClientRect();
                const bar = document.getElementById('goodnotes-top-bar').getBoundingClientRect();
                const hit = document.elementFromPoint(island.left + 60, island.top + 12);
                return { islandTop: island.top, barBottom: bar.bottom, onTop: !!(hit && hit.closest('.selected-shape-actions')) };
            });
            assert.ok(pos.islandTop >= pos.barBottom, `panel starts below the toolbar (${pos.islandTop} >= ${pos.barBottom})`);
            assert.ok(pos.onTop, 'nothing covers the panel');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('fits a section progress bar of the deck into a narrow frame', async () => {
        const { page, context, errors } = await openApp(browser, server, { viewport: { width: 900, height: 700 } });
        try {
            // The progress-indicator plugin: one fixed row of sections that does not wrap.
            const sections = Array.from({ length: 12 }, (_, i) => `<div class="indicator-section" style="margin:0 15px;width:110px;height:20px;flex-shrink:0">S${i}</div>`).join('');
            const bar = `<div class="progress-indicator" style="position:fixed;left:0;right:0;bottom:0;display:flex;justify-content:center;white-space:nowrap;padding:0 20px">${sections}</div>`;
            await openDecks(page, [['bar.html', deckA.replace('</body>', `${bar}</body>`)]]);
            await waitForDeck(page, 'bar.html');
            const deck = page.frames().find((f) => f.parentFrame() === page.mainFrame() && /blob:|bar/.test(f.url()) && f !== page.mainFrame());
            await deck.waitForFunction(() => document.querySelector('.progress-indicator').style.zoom !== '', null, { timeout: 5000 });
            const fit = await deck.evaluate(() => {
                const kids = [...document.querySelectorAll('.indicator-section')].map((k) => k.getBoundingClientRect());
                return { left: kids[0].left, right: kids[kids.length - 1].right, width: innerWidth };
            });
            assert.ok(fit.left >= 0 && fit.right <= fit.width, `all sections inside the frame (${fit.left}..${fit.right} of ${fit.width})`);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });

    it('keeps the panel settings of each tool across a reload', async () => {
        const { page, context, errors } = await openApp(browser, server);
        const appState = () => page.evaluate(() => {
            const a = window.QuartoInkExcalidraw.getAPI().getAppState();
            return { bg: a.currentItemBackgroundColor, fill: a.currentItemFillStyle, size: a.currentItemFontSize };
        });
        const pick = async (tool) => {
            await page.click(`#btn-${tool}`);
            await page.waitForFunction((t) => state.tool === t, tool);
            await page.waitForTimeout(400);
        };
        try {
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await pick('rect');
            if (!(await page.evaluate(() => state.excalToolPanelOpen))) await page.click('#btn-rect');
            await page.waitForFunction(() => document.getElementById('app').dataset.quartoExcalToolpanelReady === '1');
            await page.waitForTimeout(400);
            await page.click('#excalidraw-host .selected-shape-actions [data-testid="color-top-pick-#a5d8ff"]');
            await page.click('#excalidraw-host .selected-shape-actions [data-testid="fill-cross-hatch"]');
            await page.waitForTimeout(900);
            assert.deepEqual(await appState(), { bg: '#a5d8ff', fill: 'cross-hatch', size: (await appState()).size });
            await pick('pen');
            assert.equal((await appState()).bg, 'transparent', 'the pen keeps its own (empty) fill');
            await page.evaluate(() => window.QuartoInkExcalidraw.setTextFontSize(36));

            await page.reload();
            await page.waitForFunction(() => typeof window.processFileContent === 'function' && !!window.QuartoInkDocs);
            await openDecks(page, [['a.html', deckA]]);
            await waitForDeck(page, 'a.html');
            await pick('rect');
            const rect = await appState();
            assert.equal(rect.bg, '#a5d8ff', 'rectangle fill colour kept');
            assert.equal(rect.fill, 'cross-hatch', 'rectangle fill style kept');
            await pick('pen');
            assert.equal((await appState()).bg, 'transparent');
            assert.equal(await page.evaluate(() => window.QuartoInkExcalidraw.getTextFontSize()), 36, 'text size kept');
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });
});
