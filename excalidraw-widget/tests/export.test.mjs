// PDF (with and without ink) and PNG export of the open deck.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { startServer, fixture, launch, openApp, waitForDeck, waitForSlide, openDecks, drawStroke, deckFrame, clickDeckTab } from './helpers.mjs';

/** Choose an entry of the export menu and return the downloaded file. */
async function exportVia(page, itemId) {
    await page.click('#btn-export');
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60000 }),
        page.click(itemId),
    ]);
    return { name: download.suggestedFilename(), data: fs.readFileSync(await download.path()) };
}

/** Pages of a PDF written by the exporter: checks the xref table and returns the JPEG of each page. */
function readPdf(data) {
    const text = data.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.4'), 'PDF header');
    assert.ok(text.trimEnd().endsWith('%%EOF'), 'PDF trailer');
    const startxref = Number(/startxref\n(\d+)/.exec(text)[1]);
    assert.ok(text.startsWith('xref', startxref), 'startxref points at the xref table');
    const entries = text.slice(startxref).split('\n').filter((l) => / 00000 n $/.test(l));
    entries.forEach((line, i) => {
        const offset = Number(line.slice(0, 10));
        assert.ok(text.startsWith(`${i + 1} 0 obj`, offset), `xref entry ${i + 1}`);
    });
    const pages = [];
    const re = /\/DCTDecode \/Length (\d+) >>\nstream\n/g;
    let m;
    while ((m = re.exec(text))) pages.push(data.subarray(m.index + m[0].length, m.index + m[0].length + Number(m[1])));
    const count = Number(/\/Type \/Pages \/Count (\d+)/.exec(text)[1]);
    assert.equal(pages.length, count, 'one image per page');
    return { pages, text };
}

/** Pixel statistics of an image (data URL), measured in the page. */
function imageStats(page, dataUrl) {
    return page.evaluate(async (src) => {
        const img = new Image();
        img.src = src;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let dark = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] < 100 && d[i + 1] < 100 && d[i + 2] < 100) dark++;
        return { width: c.width, height: c.height, dark, corner: [d[0], d[1], d[2]] };
    }, dataUrl);
}

const jpegUrl = (bytes) => `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;

/** Click a Quarto tab inside the deck where it is on screen (the app's tab proxy forwards it). */
describe('PDF and PNG export', () => {
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

    async function withDeck(name, html, fn) {
        const app = await openApp(browser, server);
        try {
            await openDecks(app.page, [[name, html]]);
            await waitForDeck(app.page, name);
            await fn(app);
            assert.deepEqual(app.errors, [], 'no page errors');
        } finally {
            await app.context.close();
        }
    }

    it('exports the current slide as PNG with its ink', async () => {
        await withDeck('talk.html', deckA, async ({ page }) => {
            await drawStroke(page, 0.7);
            const png = await exportVia(page, '#btn-export-png');
            assert.equal(png.name, 'talk-slide-1.png');
            assert.equal(png.data.toString('latin1', 1, 4), 'PNG');
            // IHDR: twice the 960 x 700 slide size
            assert.deepEqual([png.data.readUInt32BE(16), png.data.readUInt32BE(20)], [1920, 1400]);

            const withInk = await imageStats(page, `data:image/png;base64,${png.data.toString('base64')}`);
            const plain = await imageStats(page, await page.evaluate(async () =>
                (await window.QuartoInkExport.renderCurrentSlide({ annotations: false })).toDataURL('image/png')));
            assert.ok(withInk.dark - plain.dark > 1000, `ink adds dark pixels (${withInk.dark} vs ${plain.dark})`);
        });
    });

    it('renders slide text where the screen shows it', async () => {
        await withDeck('talk.html', deckA, async ({ page }) => {
            const deck = await deckFrame(page);
            const fr = await page.evaluate(() => {
                const r = document.getElementById('content-frame').getBoundingClientRect();
                return { left: r.left, top: r.top };
            });
            const b = await deck.evaluate(() => {
                const r = window.Reveal.getSlidesElement().getBoundingClientRect();
                return { left: r.left, top: r.top, width: r.width, height: r.height };
            });
            const box = { x: fr.left + b.left, y: fr.top + b.top, width: b.width, height: b.height };
            const shot = `data:image/png;base64,${(await page.screenshot({ clip: box })).toString('base64')}`;
            const exported = await page.evaluate(async () =>
                (await window.QuartoInkExport.renderCurrentSlide({ annotations: false })).toDataURL('image/png'));
            // The page keeps the deck's margin: Reveal scales the slide by (1 - margin) and centres it.
            const margin = await deck.evaluate(() => window.Reveal.getConfig().margin);
            const fit = 1 - margin;
            const top = (700 * margin) / 2;
            // Vertical extent of the text lines, in slide pixels. Embedded web fonts keep them in place.
            const bands = (src, scale) => page.evaluate(async ([s, k]) => {
                const img = new Image();
                img.src = s;
                await img.decode();
                const c = document.createElement('canvas');
                c.width = img.width;
                c.height = img.height;
                const ctx = c.getContext('2d');
                ctx.drawImage(img, 0, 0);
                const d = ctx.getImageData(0, 0, c.width, c.height).data;
                const out = [];
                let start = -1;
                for (let y = 0; y <= c.height; y++) {
                    let on = false;
                    for (let x = 0; y < c.height && x < c.width && !on; x++) on = d[(y * c.width + x) * 4] < 100;
                    if (on && start < 0) start = y;
                    if (!on && start >= 0) {
                        out.push([start / k, y / k]);
                        start = -1;
                    }
                }
                return out;
            }, [src, scale]);
            const onScreen = await bands(shot, box.width / 960);
            const inExport = (await bands(exported, 2)).map((band) => band.map((y) => (y - top) / fit));
            assert.equal(inExport.length, onScreen.length, 'same text lines');
            inExport.forEach((band, i) => {
                assert.ok(Math.abs(band[0] - onScreen[i][0]) < 2 && Math.abs(band[1] - onScreen[i][1]) < 2,
                    `line ${i + 1}: export ${band} vs screen ${onScreen[i]}`);
            });
        });
    });

    it('exports every slide as PDF, with a page for each tab', async () => {
        await withDeck('talk.html', deckA, async ({ page }) => {
            await page.evaluate(() => goToSlide(state.slides[1]));
            await waitForSlide(page, 2);
            await clickDeckTab(page, '#t2');
            await page.waitForFunction(() => state.currentTabScope === '#p2');
            await waitForSlide(page, 2);
            await drawStroke(page, 0.85);
            await clickDeckTab(page, '#t1');
            await page.waitForFunction(() => state.currentTabScope === '#p1');
            await waitForSlide(page, 2);

            const inked = await exportVia(page, '#btn-export-pdf-ink');
            assert.equal(inked.name, 'talk-annotated.pdf');
            const pdf = readPdf(inked.data);
            assert.equal(pdf.pages.length, 6, 'five slides plus the second (Table) tab');
            assert.match(pdf.text, /\/MediaBox \[0 0 720\.00 525\.00\]/);
            const title = Array.from('Ethnic Diversity in Europe', (c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('');
            assert.ok(pdf.text.includes(`/Title <FEFF${title.toUpperCase()}>`), 'deck title as PDF title');
            // Invisible text layer: words as Unicode code points, mapped back by a ToUnicode CMap.
            const hex = (word) => Array.from(word, (c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();
            assert.match(pdf.text, /\/Encoding \/Identity-H .*\/ToUnicode/);
            for (const word of ['Conclusion', 'Diversity', 'North']) {
                assert.ok(pdf.text.includes(`<${hex(word)}> Tj`), `"${word}" is selectable text`);
            }

            // Page 2 is the Chart tab, page 3 the Table tab with its ink.
            const chart = await imageStats(page, jpegUrl(pdf.pages[1]));
            const table = await imageStats(page, jpegUrl(pdf.pages[2]));
            assert.notEqual(chart.dark, table.dark);

            const plain = await exportVia(page, '#btn-export-pdf-plain');
            assert.equal(plain.name, 'talk.pdf');
            const plainPages = readPdf(plain.data).pages;
            assert.equal(plainPages.length, 6, 'every tab also without ink (default "All")');
            const plainChart = await imageStats(page, jpegUrl(plainPages[1]));
            const plainTable = await imageStats(page, jpegUrl(plainPages[2]));
            assert.notEqual(plainChart.dark, plainTable.dark, 'the Table tab has its own page');
            assert.ok(table.dark > plainTable.dark, 'the ink is on the Table page');

            // Tabs choice in the menu: only the shown tab, or the shown tab plus the inked one.
            const withTabs = async (mode, item) => {
                await page.click('#btn-export');
                await page.click(`[data-tabs="${mode}"]`);
                const [download] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click(item)]);
                return readPdf(fs.readFileSync(await download.path())).pages.length;
            };
            assert.equal(await withTabs('shown', '#btn-export-pdf-ink'), 5, 'shown tabs only');
            assert.equal(await withTabs('ink', '#btn-export-pdf-ink'), 6, 'shown tab + inked Table tab');
            assert.equal(await withTabs('ink', '#btn-export-pdf-plain'), 6, 'same pages without the ink');
            await withTabs('all', '#btn-export-pdf-plain');

            // The deck is back where it was.
            await page.waitForFunction(() => state.currentSlide === '1-0' && state.currentTabScope === '#p1');
            assert.equal(await page.locator('.qi-export-progress').count(), 0);
        });
    });

    it('adds the user\'s notes below their slide when chosen', async () => {
        await withDeck('talk.html', deckA, async ({ page }) => {
            await page.click('#btn-sidebar-toggle');
            await page.evaluate(() => goToSlide(state.slides[3]));
            await waitForSlide(page, 4);
            await page.click('#qi-slide-notes');
            await page.keyboard.type('Remember the İzmir example');
            await page.waitForTimeout(600);
            assert.equal(await page.locator('.sidebar-item.has-note').count(), 1);

            const without = readPdf((await exportVia(page, '#btn-export-pdf-plain')).data);
            const heights = (pdf) => [...pdf.text.matchAll(/\/MediaBox \[0 0 [\d.]+ ([\d.]+)\]/g)].map((m) => Number(m[1]));
            assert.deepEqual(heights(without), [525, 525, 525, 525, 525, 525], 'no notes unless chosen');

            await page.click('#btn-export');
            await page.click('#qi-export-notes');
            const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-export-pdf-plain')]);
            const withNotes = readPdf(fs.readFileSync(await download.path()));
            const h = heights(withNotes);
            assert.equal(h.length, 6);
            assert.ok(h[4] > 525 && h.filter((v) => v === 525).length === 5, `taller page 5 only: ${h}`);
            const hex = (word) => Array.from(word, (c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();
            assert.ok(withNotes.text.includes(`<${hex('İzmir')}> Tj`), 'note text is selectable');
        });
    });

    it('cancels a PDF export and returns to the slide', async () => {
        await withDeck('talk.html', deckA, async ({ page }) => {
            await page.evaluate(() => goToSlide(state.slides[3]));
            await waitForSlide(page, 4);
            let downloaded = false;
            page.on('download', () => { downloaded = true; });
            await page.click('#btn-export');
            await page.click('#btn-export-pdf-ink');
            await page.locator('.qi-export-progress .qi-dialog-cancel').click();
            await page.locator('.qi-export-progress').waitFor({ state: 'detached' });
            await page.waitForFunction(() => state.currentSlide === '2-1');
            await page.waitForTimeout(500);
            assert.equal(downloaded, false, 'no file after cancelling');
        });
    });

    it('renders the same with the compact style copy as with the full one', async () => {
        // The patched renderer leaves out styles the copy computes by itself (scripts/renderer-patches.mjs).
        await withDeck('talk.html', deckA, async ({ page }) => {
            await page.evaluate(() => goToSlide(state.slides[1]));
            await waitForSlide(page, 2);
            // Loads the renderer into the deck.
            await page.evaluate(() => window.QuartoInkExport.renderCurrentSlide({ annotations: false }));
            const result = await (await deckFrame(page)).evaluate(async () => {
                const w = window;
                const slide = w.Reveal.getCurrentSlide();
                const pixels = async (compact) => {
                    const c = await w.__qiHtmlToImage.toCanvas(slide, {
                        pixelRatio: 1, fontEmbedCSS: '', backgroundColor: '#fff', qiCompactStyles: compact, qiRoot: slide,
                    });
                    return { data: c.getContext('2d').getImageData(0, 0, c.width, c.height).data, size: [c.width, c.height] };
                };
                const full = await pixels(false);
                const compact = await pixels(true);
                let differing = 0;
                for (let i = 0; i < full.data.length; i++) if (full.data[i] !== compact.data[i]) differing++;
                const svgLength = async (compact) => (await w.__qiHtmlToImage.toSvg(slide, { fontEmbedCSS: '', qiCompactStyles: compact, qiRoot: slide })).length;
                return { sizes: [full.size, compact.size], differing, ratio: (await svgLength(true)) / (await svgLength(false)) };
            });
            assert.deepEqual(result.sizes[0], result.sizes[1]);
            assert.equal(result.differing, 0, 'identical pixels');
            assert.ok(result.ratio < 0.5, `compact copy is smaller (${result.ratio.toFixed(2)})`);
        });
    });

    it('shows all fragments and the slide background in the PDF', async () => {
        await withDeck('notes.html', deckB, async ({ page }) => {
            await page.evaluate(() => goToSlide(state.slides[4]));
            await waitForSlide(page, 5);
            const asShown = await imageStats(page, await page.evaluate(async () =>
                (await window.QuartoInkExport.renderCurrentSlide({ annotations: false })).toDataURL('image/png')));

            const { pages } = readPdf((await exportVia(page, '#btn-export-pdf-plain')).data);
            // Pages: title, Chart tab, Table tab, Vertical A, Vertical B, Wrap-up.
            const wrapUp = await imageStats(page, jpegUrl(pages[5]));
            // data-background-color="#fff3bf"
            wrapUp.corner.forEach((v, i) => assert.ok(Math.abs(v - [255, 243, 191][i]) <= 6, `background ${wrapUp.corner}`));
            assert.ok(wrapUp.dark > asShown.dark + 200, `fragment shown (${wrapUp.dark} vs ${asShown.dark})`);
        });
    });
});
