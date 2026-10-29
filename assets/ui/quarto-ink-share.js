/*
 * Quarto Ink: a deck with its ink in one file, to share.
 *
 * "Deck with ink" saves the presentation's own HTML with the ink, notes and blank pages in a
 * JSON block (<script type="application/json" id="quarto-ink-data">). In a browser the file is
 * the plain deck; opened in Quarto Ink, the block is taken out again (so the deck is the same
 * as the original) and its ink is restored, after asking if the deck already has ink here.
 */
(function () {
    'use strict';

    const FORMAT = 'quarto-ink';
    const VERSION = 1;
    const BLOCK = /<script type="application\/json" id="quarto-ink-data">([\s\S]*?)<\/script>\s*/;

    /** The embedded ink of a file: { html (without the block), annotations (payload string) } or null. */
    function extract(html) {
        const m = BLOCK.exec(String(html || ''));
        if (!m) return null;
        try {
            const data = JSON.parse(m[1]);
            if (!data || data.format !== FORMAT || typeof data.annotations !== 'string') return null;
            return { html: html.slice(0, m.index) + html.slice(m.index + m[0].length), annotations: data.annotations };
        } catch (_e) {
            return null;
        }
    }

    function hasInk(payload) {
        if (!payload) return false;
        try {
            const o = JSON.parse(payload);
            const scenes = (o.excalidrawScenes || []).some(([, raw]) => {
                try {
                    const scene = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    return (scene.elements || []).some((e) => !e.isDeleted);
                } catch (_e) {
                    return false;
                }
            });
            return scenes || (o.annotations || []).some(([, list]) => list && list.length)
                || (o.slideNotes || []).length > 0 || (o.whiteboards || []).length > 0;
        } catch (_e) {
            return false;
        }
    }

    /**
     * Put a shared file's ink where the deck's ink is kept (file name + content fingerprint,
     * as getStorageKey in index.html), so opening it shows the ink. Asks before replacing ink.
     */
    async function importInk(name, html, annotations) {
        const key = `${APP_ANNOTATION_PREFIX}${name}#${qiContentFingerprint(html)}`;
        if (window.QuartoInkStore) await window.QuartoInkStore.ready;
        const existing = qiGetAnnotations(key);
        if (existing && existing !== annotations && hasInk(existing)) {
            const replace = await qiConfirm(
                'This file brings its own ink',
                `"${name}" already has ink in this browser. Replace it with the ink saved in the file?`,
                { confirmText: 'Use the file\u2019s ink', cancelText: 'Keep mine' },
            );
            if (!replace) return false;
        }
        qiSetAnnotations(key, annotations);
        return true;
    }

    /** The open deck's original HTML with its ink, notes and blank pages embedded. */
    function build() {
        const html = window.QuartoInkDocs && window.QuartoInkDocs.activeContent();
        if (!html) return null;
        try { flushExcalidrawSceneToStorageForCurrentKey(); } catch (_e) {}
        const data = {
            format: FORMAT,
            version: VERSION,
            app: 'Quarto Ink',
            savedAt: new Date().toISOString(),
            annotations: stringifyAnnotationsPayload(),
        };
        // "<" escaped, so nothing in the ink can end the script element early.
        const block = `<script type="application/json" id="quarto-ink-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>\n`;
        const at = html.toLowerCase().lastIndexOf('</body>');
        return at === -1 ? html + block : html.slice(0, at) + block + html.slice(at);
    }

    function download() {
        const html = build();
        if (!html) {
            qiAlert('Nothing to save', 'Open a presentation first.');
            return;
        }
        const name = (state.currentFileName || 'presentation').replace(/\.html?$/i, '').replace(/[\\/:*?"<>|]+/g, '_');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        a.download = `${name}-with-ink.html`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
        const status = document.getElementById('status-left');
        if (status) status.textContent = 'Saved the deck with its ink';
        window.dispatchEvent(new CustomEvent('quartoink:ink-saved'));
    }

    function init() {
        const item = document.getElementById('btn-export-shared');
        if (item) {
            item.addEventListener('click', () => {
                const menu = document.getElementById('export-menu');
                if (menu) menu.classList.add('hidden');
                download();
            });
        }
    }

    window.QuartoInkShare = { extract, importInk, build, download };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
