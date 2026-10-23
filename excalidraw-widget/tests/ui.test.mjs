// In-app dialogs, accessible toolbar state, property panel tweaks and same-name files.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, fixture, launch, openApp, waitForDeck, waitForSlide, openDecks, drawStroke, appInfo } from './helpers.mjs';

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
        await page.click('.qi-doc-tab.is-active .qi-doc-tab-close');
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
});
