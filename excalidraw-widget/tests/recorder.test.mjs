// Lecture recording: screen capture plus microphone into a video file. Chromium's fake
// capture devices stand in for the tab and the microphone (a real tab capture needs a prompt).
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { chromium } from 'playwright';
import { startServer, fixture, openApp, waitForDeck, openDecks, drawStroke } from './helpers.mjs';

describe('Lecture recording', { skip: process.env.QI_BROWSER === 'webkit' && 'needs Chromium capture flags' }, () => {
    let server;
    let browser;

    before(async () => {
        server = await startServer();
        browser = await chromium.launch({
            args: ['--auto-accept-this-tab-capture', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
        });
    });

    after(async () => {
        await browser.close();
        await server.close();
    });

    it('records video and microphone and saves the file on stop', async () => {
        const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, permissions: ['microphone'] });
        try {
            const { page, errors } = await openApp(browser, server, { context });
            await openDecks(page, [['talk.html', fixture('deck-a.html', server.origin)]]);
            await waitForDeck(page, 'talk.html');
            await page.click('#btn-record');
            await page.waitForFunction(() => window.QuartoInkRecorder.isRecording());
            assert.equal(await page.evaluate(() => document.getElementById('btn-record').classList.contains('recording')), true);
            await drawStroke(page, 0.6);
            await page.waitForTimeout(1500);
            const [download] = await Promise.all([page.waitForEvent('download'), page.click('#btn-record')]);
            assert.equal(download.suggestedFilename(), 'talk-recording.webm');
            const data = fs.readFileSync(await download.path());
            assert.ok(data.length > 10000, `a video (${data.length} bytes)`);
            assert.equal(data.readUInt32BE(0), 0x1a45dfa3, 'WebM (EBML) file');
            assert.equal(await page.evaluate(() => window.QuartoInkRecorder.isRecording()), false);
            assert.deepEqual(errors, []);
        } finally {
            await context.close();
        }
    });
});
