/*
 * Quarto Ink: PDF and PNG export.
 *
 * - PDF with or without ink: every slide in order, all fragments shown. A slide with Quarto
 *   tabs gets one page per tab, or, as chosen in the menu, only for the tabs with ink or
 *   only for the tab it shows. Every page carries its words as invisible text.
 *   On request, the user's notes go below the slide on its (first) page. The blank pages
 *   after a slide (assets/ui/quarto-ink-whiteboard.js) follow it in a PDF with ink.
 * - PNG: the current slide as it is shown, with its ink.
 *
 * For an exact copy of the deck, the deck iframe is laid out at the slide size with the deck's
 * own margin (as a full-screen presentation of that size would be). The deck is sandboxed, so
 * the rendering happens inside it: this file sends the export agent
 * (assets/ui/quarto-ink-export-agent.js) with the slide renderer (html-to-image, vendored into
 * excalidraw-widget/dist/vendor/ by the widget build) through the bridge and calls it with
 * messages. Pages come back as images; the ink is drawn on top here from the saved Excalidraw
 * scenes, mapped from the normal on-screen layout it was drawn in.
 * The PDF writer below only needs JPEG pages, so no PDF library is required.
 */
(function () {
    'use strict';

    const RENDERER_URL = 'excalidraw-widget/dist/vendor/html-to-image.js';
    const AGENT_URL = 'assets/ui/quarto-ink-export-agent.js';
    const RENDER_SCALE = 2; // output pixels per slide pixel
    const JPEG_QUALITY = 0.92;
    const PX_TO_PT = 0.75; // CSS px (96 dpi) to PDF points (72 dpi)
    const TABS_SETTING_KEY = 'qi-export-tabs';
    const NOTES_SETTING_KEY = 'qi-export-notes';
    const NOTES_FONT_FAMILY = 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
    const TAB_MODES = ['all', 'ink', 'shown'];

    let agentSource = null;
    let job = null; // the running export: { cancelled }

    // --- Small helpers ----------------------------------------------------------

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function waitFor(test, timeout) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            if (test()) return true;
            await sleep(40);
        }
        return test();
    }

    function setStatus(text) {
        const el = document.getElementById('status-left');
        if (el) el.textContent = text;
    }

    function baseFileName() {
        const name = (state.currentFileName || 'presentation').replace(/\.html?$/i, '');
        return name.replace(/[\\/:*?"<>|]+/g, '_') || 'presentation';
    }

    function download(blob, fileName) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Safari needs the URL a little longer than the click.
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }

    /**
     * Give a canvas's pixels back at once. Safari on iPad allows a page little canvas memory
     * and frees it late: a whole deck of slide-sized canvases left to the garbage collector
     * used it up, and Excalidraw then could not create its own canvas until a reload.
     */
    function releaseCanvas(canvas) {
        if (!canvas) return;
        canvas.width = 0;
        canvas.height = 0;
    }

    /** A rendered page's size and slide box, without its pixels (for its blank pages). */
    function pageTemplate(page) {
        return { canvas: { width: page.canvas.width, height: page.canvas.height }, width: page.width, height: page.height, slideRect: page.slideRect };
    }

    function canvasToBlob(canvas, type, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The slide image could not be encoded.'))), type, quality);
        });
    }

    // --- The export agent inside the deck ------------------------------------------

    const pending = new Map(); // call id (or 'load') -> { resolve, reject, timer }
    let nextCallId = 1;

    function deckFrame() {
        return document.getElementById('content-frame');
    }

    window.addEventListener('message', (e) => {
        const frame = deckFrame();
        if (!frame || e.source !== frame.contentWindow || !e.data) return;
        const { type } = e.data;
        if (type !== 'QI_AGENT_RESULT' && type !== 'QI_AGENT_READY') return;
        const key = type === 'QI_AGENT_READY' ? 'load' : e.data.id;
        const call = pending.get(key);
        if (!call) return;
        pending.delete(key);
        clearTimeout(call.timer);
        if (type === 'QI_AGENT_READY') {
            if (e.data.ok) call.resolve(true);
            else call.reject(new Error('The export could not start inside the presentation.'));
        } else if (e.data.ok) {
            call.resolve(e.data.result);
        } else {
            call.reject(new Error(e.data.error || 'The presentation did not answer.'));
        }
    });

    function awaitReply(key, timeout, send) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(key);
                reject(new Error('The presentation did not answer in time.'));
            }, timeout);
            pending.set(key, { resolve, reject, timer });
            try {
                send();
            } catch (err) {
                clearTimeout(timer);
                pending.delete(key);
                reject(err);
            }
        });
    }

    /** html-to-image as a global, also when the deck uses an AMD loader (e.g. htmlwidgets). */
    function wrapRenderer(source) {
        return '(function (define, exports, module) {\nvar __qiPrev = window.htmlToImage;\n'
            + source
            + '\nwindow.__qiHtmlToImage = window.htmlToImage;\nwindow.htmlToImage = __qiPrev;\n}).call(window);';
    }

    /** Load the renderer and the agent into the deck (once per deck document). */
    async function loadAgent() {
        if (!agentSource) {
            const [renderer, agent] = await Promise.all([RENDERER_URL, AGENT_URL].map(async (url) => {
                const res = await fetch(new URL(url, location.href));
                if (!res.ok) throw new Error(`The export code is missing (${res.status}). Rebuild excalidraw-widget.`);
                return res.text();
            }));
            agentSource = `${wrapRenderer(renderer)}\n${agent}`;
        }
        const frame = deckFrame();
        if (!frame || !frame.contentWindow) throw new Error('No presentation is open.');
        await awaitReply('load', 15000, () => frame.contentWindow.postMessage({ type: 'QI_AGENT_LOAD', source: agentSource }, qiTargetOrigin()));
    }

    /** Call a method of the agent (see window.__qiExportAgent in the agent). */
    function agentCall(method, ...args) {
        const frame = deckFrame();
        if (!frame || !frame.contentWindow) return Promise.reject(new Error('No presentation is open.'));
        const id = nextCallId++;
        return awaitReply(id, method === 'render' ? 60000 : 15000,
            () => frame.contentWindow.postMessage({ type: 'QI_AGENT_CALL', id, method, args }, qiTargetOrigin()));
    }

    /**
     * The slide box (the scaled .slides element; `rect` in deck viewport px) in #canvas-overlay
     * coordinates. Excalidraw scenes and classic ink are stored in those screen coordinates,
     * so this maps them onto the slide.
     */
    function slideBoxInOverlay(rect) {
        const frame = deckFrame();
        const overlay = document.getElementById('canvas-overlay');
        const fr = frame.getBoundingClientRect();
        const or = overlay ? overlay.getBoundingClientRect() : { left: 0, top: 0 };
        return {
            x: fr.left + frame.clientLeft + rect.x - or.left,
            y: fr.top + frame.clientTop + rect.y - or.top,
            width: rect.width,
            height: rect.height,
        };
    }

    function slideKeyOf(slide) {
        return `${slide.h}-${slide.v || 0}`;
    }

    // --- Print layout --------------------------------------------------------------

    /**
     * Lay the deck out at its slide size (iframe = slide size, the deck's own margin), as a
     * full-screen presentation of that size would look. Returns what leavePrintLayout needs,
     * including the slide box of the normal layout, which the ink is mapped from.
     */
    async function enterPrintLayout() {
        const frame = deckFrame();
        const { width, height } = await agentCall('slideSize');
        const saved = {
            frame,
            style: frame.getAttribute('style'),
            box: slideBoxInOverlay(await agentCall('slidesRect')),
            size: { width, height },
        };
        frame.style.setProperty('width', `${width}px`, 'important');
        frame.style.setProperty('height', `${height}px`, 'important');
        frame.style.setProperty('flex', 'none', 'important');
        await agentCall('layout', width);
        return saved;
    }

    async function leavePrintLayout(saved) {
        if (saved.style == null) saved.frame.removeAttribute('style');
        else saved.frame.setAttribute('style', saved.style);
        try {
            await agentCall('layout');
        } catch (_e) {}
    }

    /** Render the current slide of the deck as a page: { canvas, width, height, words, slideRect }. */
    async function renderSlide() {
        const result = await agentCall('render', RENDER_SCALE);
        const canvas = document.createElement('canvas');
        canvas.width = result.bitmap.width;
        canvas.height = result.bitmap.height;
        canvas.getContext('2d').drawImage(result.bitmap, 0, 0);
        result.bitmap.close();
        return { canvas, width: result.width, height: result.height, words: result.words || [], slideRect: result.slideRect };
    }

    function svgToImage(svg, width, height) {
        const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
        const root = doc.documentElement;
        root.setAttribute('width', String(Math.max(1, Math.round(width))));
        root.setAttribute('height', String(Math.max(1, Math.round(height))));
        root.removeAttribute('style');
        const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(root)], { type: 'image/svg+xml' }));
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('The ink could not be drawn.')); };
            img.src = url;
        });
    }

    function sceneHasInk(scene) {
        if (!scene) return false;
        try {
            const parsed = typeof scene === 'string' ? JSON.parse(scene) : scene;
            return (parsed.elements || []).some((e) => !e.isDeleted);
        } catch (_e) {
            return false;
        }
    }

    /**
     * Draw the ink saved under `annotationKey` onto a rendered slide. `box` is the slide box of
     * the normal layout (see enterPrintLayout), in which the Excalidraw scenes were drawn.
     */
    async function drawInk(page, slideKey, annotationKey, box) {
        const { canvas, slideRect } = page;
        const ctx = canvas.getContext('2d');
        if (!(box.width > 4 && box.height > 4)) return;
        // Target: the slide box on the rendered page, in canvas pixels.
        const k = canvas.width / page.width;
        const tx = slideRect.x * k;
        const ty = slideRect.y * k;
        const tw = slideRect.width * k;
        const th = slideRect.height * k;
        const scene = state.excalidrawScenes.get(annotationKey);
        if (sceneHasInk(scene) && window.QuartoInkExcalidraw && typeof window.QuartoInkExcalidraw.exportSerializedToSvg === 'function') {
            const serialized = typeof scene === 'string' ? scene : JSON.stringify(scene);
            const out = await window.QuartoInkExcalidraw.exportSerializedToSvg(serialized, box.width, box.height, box.x, box.y);
            if (out) {
                // [svg, x, y, w, h] relative to the slide; a bare string covers the whole slide.
                const [svg, rx, ry, rw, rh] = Array.isArray(out) ? out : [out, 0, 0, 1, 1];
                const img = await svgToImage(svg, rw * tw, rh * th);
                ctx.drawImage(img, tx + rx * tw, ty + ry * th, rw * tw, rh * th);
            }
        }
        // Ink from the classic (non-Excalidraw) engine is on the overlay canvas.
        const classic = state.annotations.get(annotationKey);
        const overlay = document.getElementById('canvas-overlay');
        // Only for what is on screen now, as the overlay shows just that.
        if (classic && classic.length && overlay && overlay.clientWidth && state.currentSlide === slideKey && annotationKey === getCurrentAnnotationKey()) {
            // The overlay follows the current (print) layout.
            redraw();
            const now = slideBoxInOverlay(await agentCall('slidesRect'));
            const r = overlay.width / overlay.clientWidth;
            ctx.drawImage(overlay, now.x * r, now.y * r, now.width * r, now.height * r, tx, ty, tw, th);
        }
    }

    // --- The user's notes below a slide -----------------------------------------------

    /** On unless turned off: notes the user wrote are meant to be kept with the slides. */
    function getNotesInPdf() {
        try { return localStorage.getItem(NOTES_SETTING_KEY) !== '0'; } catch (_e) { return true; }
    }

    function setNotesInPdf(on) {
        try { localStorage.setItem(NOTES_SETTING_KEY, on ? '1' : '0'); } catch (_e) {}
    }

    /**
     * The page with a notes area added below the slide: the note drawn into the image and its
     * words added to the text layer, so they stay selectable and searchable in the PDF.
     */
    function appendNotes(page, text) {
        const k = page.canvas.width / page.width; // canvas px per page px
        const pad = 28;
        const labelHeight = 24;
        const fontPx = 17;
        const lineHeight = 25;
        const maxWidth = page.width - pad * 2;
        const font = `400 ${fontPx}px ${NOTES_FONT_FAMILY}`;
        const measure = document.createElement('canvas').getContext('2d');
        measure.font = font;

        // Wrap at word boundaries; empty lines are kept, trailing ones dropped.
        const lines = [];
        for (const paragraph of String(text).replace(/\r/g, '').split('\n')) {
            let line = '';
            for (const word of paragraph.split(/\s+/).filter(Boolean)) {
                const trial = line ? `${line} ${word}` : word;
                if (!line || measure.measureText(trial).width <= maxWidth) line = trial;
                else {
                    lines.push(line);
                    line = word;
                }
            }
            lines.push(line);
        }
        while (lines.length && !lines[lines.length - 1]) lines.pop();
        if (!lines.length) return page;

        const areaHeight = Math.ceil(pad + labelHeight + lines.length * lineHeight + pad * 0.8);
        const height = page.height + areaHeight;
        const canvas = document.createElement('canvas');
        canvas.width = page.canvas.width;
        canvas.height = Math.round(height * k);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(page.canvas, 0, 0);
        ctx.scale(k, k);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, page.height, page.width, areaHeight);
        ctx.fillStyle = '#d8d2c6';
        ctx.fillRect(0, page.height, page.width, 1);
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#8d877a';
        ctx.font = `600 11px ${NOTES_FONT_FAMILY}`;
        ctx.fillText('NOTES', pad, page.height + pad);
        ctx.fillStyle = '#1d1b17';
        ctx.font = font;
        const words = [...page.words];
        lines.forEach((line, i) => {
            const top = page.height + pad + labelHeight + i * lineHeight;
            const y = top + (lineHeight - fontPx * 1.2) / 2;
            ctx.fillText(line, pad, y);
            const re = /\S+/g;
            let m;
            while ((m = re.exec(line))) {
                words.push({
                    text: m[0],
                    x: pad + measure.measureText(line.slice(0, m.index)).width,
                    y,
                    width: measure.measureText(m[0]).width,
                    height: fontPx * 1.2,
                });
            }
        });
        return { ...page, canvas, height, words };
    }

    // --- Navigation for the PDF -------------------------------------------------

    /** Show `slide` with all its fragments, and wait until the app follows. */
    async function showSlide(slide) {
        await agentCall('showSlide', slide.h, slide.v || 0);
        await waitFor(() => state.currentSlide === slideKeyOf(slide), 3000);
    }

    /** Which tabs the PDF gets pages for: 'all', 'ink' (shown tab + tabs with ink) or 'shown'. */
    function getTabMode() {
        try {
            const mode = localStorage.getItem(TABS_SETTING_KEY);
            if (TAB_MODES.includes(mode)) return mode;
        } catch (_e) {}
        return 'all';
    }

    function setTabMode(mode) {
        if (!TAB_MODES.includes(mode)) return;
        try { localStorage.setItem(TABS_SETTING_KEY, mode); } catch (_e) {}
    }

    /** Tab scopes to export for the current slide, in order (a slide without tabs gives ['']). */
    async function tabScopesToExport(slideKey, mode, annotations) {
        let scopes;
        if (mode === 'all') scopes = await agentCall('allTabScopes');
        else scopes = [await agentCall('activeTabScope')];
        // Any tab scope with ink (also a combination of several tabsets) when the ink is wanted.
        if (mode === 'ink' || (mode === 'all' && annotations)) {
            inkedTabScopes(slideKey).forEach((s) => { if (!scopes.includes(s)) scopes.push(s); });
        }
        return scopes;
    }

    /** Tab scopes of a slide that carry ink, e.g. ["#p2"] for "1-0::tab:#p2". */
    function inkedTabScopes(slideKey) {
        const prefix = `${slideKey}::tab:`;
        const scopes = new Set();
        for (const [key, scene] of state.excalidrawScenes) {
            if (key.startsWith(prefix) && sceneHasInk(scene)) scopes.add(key.slice(prefix.length));
        }
        for (const [key, list] of state.annotations) {
            if (key.startsWith(prefix) && list && list.length) scopes.add(key.slice(prefix.length));
        }
        return Array.from(scopes);
    }

    // --- PDF writer -------------------------------------------------------------

    function pdfTextString(text) {
        let hex = 'FEFF';
        for (const ch of String(text)) {
            const code = ch.codePointAt(0);
            if (code > 0xffff) {
                const c = code - 0x10000;
                hex += (0xd800 + (c >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (c & 0x3ff)).toString(16).padStart(4, '0');
            } else {
                hex += code.toString(16).padStart(4, '0');
            }
        }
        return `<${hex.toUpperCase()}>`;
    }

    function pdfDate(d) {
        const p = (n) => String(n).padStart(2, '0');
        return `(D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())})`;
    }

    // Invisible text layer: a font without glyphs whose codes are Unicode code points
    // (Identity-H, two bytes per character), so viewers can select, search and copy the text.
    const TEXT_ADVANCE = 0.5; // advance of every character, in em (the font's /DW 500)

    function toUnicodeCMap() {
        const ranges = [];
        for (let hi = 0; hi < 256; hi++) {
            if (hi >= 0xd8 && hi <= 0xdf) continue; // surrogates
            const h = hi.toString(16).padStart(2, '0').toUpperCase();
            ranges.push(`<${h}00> <${h}FF> <${h}00>`);
        }
        let blocks = '';
        for (let i = 0; i < ranges.length; i += 100) {
            const part = ranges.slice(i, i + 100);
            blocks += `${part.length} beginbfrange\n${part.join('\n')}\nendbfrange\n`;
        }
        return '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n'
            + '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n'
            + '/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n'
            + '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'
            + blocks
            + 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend';
    }

    /** Content stream operators for the invisible words of a page (page px -> PDF pt, y up). */
    function textLayer(words, pageHeight) {
        let out = 'BT\n3 Tr\n';
        for (const word of words) {
            let hex = '';
            for (const ch of word.text) {
                const code = ch.codePointAt(0);
                hex += (code > 0xffff || (code >= 0xd800 && code <= 0xdfff) ? 0xfffd : code).toString(16).padStart(4, '0');
            }
            const count = hex.length / 4;
            // Glyph height ~ the line box, baseline near its bottom.
            const size = word.height * PX_TO_PT * 0.8;
            const x = word.x * PX_TO_PT;
            const y = (pageHeight - word.y - word.height * 0.78) * PX_TO_PT;
            const scale = (100 * word.width * PX_TO_PT) / (count * TEXT_ADVANCE * size);
            out += `/F1 ${size.toFixed(2)} Tf ${scale.toFixed(2)} Tz 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm <${hex.toUpperCase()}> Tj\n`;
        }
        return `${out}ET\n`;
    }

    /**
     * pages: [{ jpeg: Uint8Array, pixelWidth, pixelHeight, width, height, words? }] (width/height
     * in CSS px; words from collectWords, drawn as invisible text over the page image).
     */
    function buildPdf(pages, title) {
        const encoder = new TextEncoder();
        const chunks = [];
        const offsets = [];
        let length = 0;
        const write = (data) => {
            const bytes = typeof data === 'string' ? encoder.encode(data) : data;
            chunks.push(bytes);
            length += bytes.length;
        };
        const object = (num, ...parts) => {
            offsets[num] = length;
            write(`${num} 0 obj\n`);
            parts.forEach(write);
            write('\nendobj\n');
        };

        write('%PDF-1.4\n%âãÏÓ\n');
        const pageNum = (i) => 4 + i * 3;
        // Shared font of the text layer, after the pages.
        const fontNum = pageNum(pages.length);
        const hasText = pages.some((page) => page.words && page.words.length);
        object(1, '<< /Type /Catalog /Pages 2 0 R >>');
        object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_p, i) => `${pageNum(i)} 0 R`).join(' ')}] >>`);
        object(3, `<< /Title ${pdfTextString(title)} /Producer (Quarto Ink) /CreationDate ${pdfDate(new Date())} >>`);
        pages.forEach((page, i) => {
            const w = (page.width * PX_TO_PT).toFixed(2);
            const h = (page.height * PX_TO_PT).toFixed(2);
            const n = pageNum(i);
            const words = page.words || [];
            const draw = `q\n${w} 0 0 ${h} 0 0 cm\n/Im0 Do\nQ\n${words.length ? textLayer(words, page.height) : ''}`;
            const font = words.length ? ` /Font << /F1 ${fontNum} 0 R >>` : '';
            object(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${n + 2} 0 R >>${font} >> /Contents ${n + 1} 0 R >>`);
            object(n + 1, `<< /Length ${encoder.encode(draw).length} >>\nstream\n${draw}endstream`);
            object(n + 2,
                `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
                page.jpeg,
                '\nendstream');
        });
        if (hasText) {
            const cmap = toUnicodeCMap();
            object(fontNum, `<< /Type /Font /Subtype /Type0 /BaseFont /QuartoInkText /Encoding /Identity-H /DescendantFonts [${fontNum + 1} 0 R] /ToUnicode ${fontNum + 3} 0 R >>`);
            object(fontNum + 1, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /QuartoInkText /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${fontNum + 2} 0 R /DW ${TEXT_ADVANCE * 1000} /CIDToGIDMap /Identity >>`);
            object(fontNum + 2, '<< /Type /FontDescriptor /FontName /QuartoInkText /Flags 4 /FontBBox [0 -200 1000 800] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>');
            object(fontNum + 3, `<< /Length ${encoder.encode(cmap).length} >>\nstream\n${cmap}\nendstream`);
        }

        const count = offsets.length;
        const xref = length;
        let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
        for (let i = 1; i < count; i++) table += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
        write(table);
        write(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
        return new Blob(chunks, { type: 'application/pdf' });
    }

    // --- Progress overlay -------------------------------------------------------

    function showProgress(title, onCancel) {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay qi-export-progress';
        overlay.style.display = 'flex';
        overlay.innerHTML = '<div class="modal-content qi-dialog-card" role="status" aria-live="polite">'
            + '<div class="modal-header"></div><p class="qi-dialog-message"></p>'
            + '<div class="qi-export-bar"><span></span></div>'
            + '<div class="qi-dialog-actions"><button type="button" class="qi-dialog-btn qi-dialog-cancel">Cancel</button></div></div>';
        overlay.querySelector('.modal-header').textContent = title;
        const message = overlay.querySelector('.qi-dialog-message');
        const bar = overlay.querySelector('.qi-export-bar span');
        const cancel = overlay.querySelector('.qi-dialog-cancel');
        if (onCancel) cancel.addEventListener('click', onCancel);
        else cancel.parentElement.remove();
        // Keep the app's shortcuts (arrows, tools) away from the deck while exporting.
        const onKey = (e) => {
            if (e.key === 'Escape' && onCancel) onCancel();
            if (e.key !== 'Tab') e.preventDefault();
            e.stopPropagation();
        };
        document.addEventListener('keydown', onKey, true);
        document.body.appendChild(overlay);
        if (onCancel) cancel.focus();
        return {
            update(done, total, text) {
                message.textContent = text;
                bar.style.width = `${total ? Math.round((done / total) * 100) : 0}%`;
            },
            close() {
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
            },
        };
    }

    // --- Export entry points ----------------------------------------------------

    /** Check that a deck is open and ready, and load the export agent into it. */
    async function prepare() {
        if (!state.htmlContent) {
            qiAlert('Nothing to export', 'Open a presentation first.');
            return false;
        }
        let ready = false;
        try {
            await loadAgent();
            // A deck shown a moment ago (or on a slow iPad) may still be starting Reveal.
            const until = Date.now() + 8000;
            while (!(ready = await agentCall('isReady')) && Date.now() < until) await new Promise((r) => setTimeout(r, 250));
        } catch (e) {
            console.warn('[QuartoInkExport] agent', e);
        }
        if (!ready) {
            qiAlert('Presentation not ready', 'Wait until the presentation has finished loading, then try again.');
            return false;
        }
        if (typeof ensureExcalidrawRuntime === 'function') await ensureExcalidrawRuntime();
        if (state.annotationEngine === 'excalidraw') {
            try { flushExcalidrawSceneToStorageForCurrentKey(); } catch (_e) {}
        }
        return true;
    }

    /** Render the current slide as shown (current fragments and tab), optionally with its ink. */
    async function renderCurrentSlide({ annotations = true } = {}) {
        await loadAgent();
        await agentCall('begin');
        const saved = await enterPrintLayout();
        try {
            const whiteboard = window.QuartoInkWhiteboard && window.QuartoInkWhiteboard.current();
            let page;
            let box = saved.box;
            if (whiteboard) {
                // A blank page: its paper, sized like a rendered slide page.
                const { width, height } = saved.size;
                const template = {
                    canvas: { width: Math.round(width * RENDER_SCALE), height: Math.round(height * RENDER_SCALE) },
                    width,
                    height,
                    slideRect: await agentCall('slidesRect'),
                };
                // All of the page's ink, also what lies outside the slide area.
                const fit = annotations
                    ? window.QuartoInkWhiteboard.exportBox(whiteboard.slideKey, whiteboard.id, saved.box)
                    : { box, factor: 1 };
                box = fit.box;
                page = window.QuartoInkWhiteboard.renderPage(template, whiteboard.page.style, width, { ...fit, slideBox: saved.box });
            } else {
                page = await renderSlide();
            }
            if (annotations) await drawInk(page, state.currentSlide, getCurrentAnnotationKey(), box);
            return page.canvas;
        } finally {
            await leavePrintLayout(saved);
            await agentCall('end').catch(() => {});
        }
    }

    function isBusy() {
        if (job) setStatus('An export is already running');
        return !!job;
    }

    async function exportPng() {
        if (isBusy()) return;
        if (!(await prepare())) return;
        job = { cancelled: false };
        // The deck is briefly laid out at slide size: keep it covered while that happens.
        const progress = showProgress('Exporting PNG', null);
        progress.update(0, 1, 'Rendering the current slide...');
        try {
            setStatus('Exporting the current slide as PNG...');
            const canvas = await renderCurrentSlide({ annotations: true });
            const blob = await canvasToBlob(canvas, 'image/png');
            releaseCanvas(canvas);
            const index = (state.slides || []).findIndex((s) => slideKeyOf(s) === state.currentSlide);
            download(blob, `${baseFileName()}-slide-${index >= 0 ? index + 1 : state.currentSlide}.png`);
            setStatus('Exported the current slide as PNG');
        } catch (e) {
            console.error('[QuartoInkExport] PNG export failed', e);
            qiAlert('Export failed', `The slide image could not be created. ${e && e.message ? e.message : ''}`.trim());
        } finally {
            progress.close();
            job = null;
        }
    }

    async function exportPdf({ annotations = true } = {}) {
        if (isBusy()) return;
        const slides = (state.slides || []).slice();
        if (state.htmlContent && !slides.length) {
            qiAlert('Nothing to export', 'The presentation has no slides yet.');
            return;
        }
        // Shown at once: loading the export code can take a few seconds on an iPad.
        const current = job = { cancelled: false };
        const progress = showProgress(annotations ? 'Exporting PDF with ink' : 'Exporting PDF', () => { current.cancelled = true; });
        progress.update(0, 1, 'Preparing the presentation...');
        if (!(await prepare()) || current.cancelled) {
            progress.close();
            job = null;
            if (current.cancelled) setStatus('PDF export cancelled');
            return false;
        }
        const tabMode = getTabMode();
        const withNotes = getNotesInPdf();
        let start;
        let startScope;
        try {
            start = await agentCall('indices');
            startScope = await agentCall('activeTabScope');
        } catch (e) {
            progress.close();
            job = null;
            qiAlert('Export failed', `The PDF could not be created. ${e && e.message ? e.message : ''}`.trim());
            return false;
        }
        const pages = [];
        let pdf = null;
        let layout = null;
        try {
            await agentCall('begin');
            layout = await enterPrintLayout();
            for (let i = 0; i < slides.length && !current.cancelled; i++) {
                const slide = slides[i];
                const slideKey = slideKeyOf(slide);
                progress.update(i, slides.length, `Slide ${i + 1} of ${slides.length}`);
                setStatus(`Exporting PDF: slide ${i + 1} of ${slides.length}`);
                await showSlide(slide);

                const scopes = await tabScopesToExport(slideKey, tabMode, annotations);
                // The note goes on the first page of the slide only.
                let note = withNotes && state.slideNotes ? (state.slideNotes.get(slideKey) || '').trim() : '';
                let template = null; // a rendered page of this slide, for its blank pages
                for (const scope of scopes) {
                    if (current.cancelled) break;
                    if (scope !== (await agentCall('activeTabScope')) && !(await agentCall('showTabScope', scope))) continue;
                    let page = await renderSlide();
                    template = template || pageTemplate(page);
                    if (annotations) await drawInk(page, slideKey, getCurrentAnnotationKey(slideKey, scope), layout.box);
                    if (note) {
                        const withNote = appendNotes(page, note);
                        if (withNote !== page) releaseCanvas(page.canvas);
                        page = withNote;
                        note = '';
                    }
                    // Encoded while the next slide renders; awaited before the PDF is written.
                    const done = page.canvas;
                    const jpeg = canvasToBlob(done, 'image/jpeg', JPEG_QUALITY)
                        .then(async (blob) => new Uint8Array(await blob.arrayBuffer()))
                        .finally(() => releaseCanvas(done));
                    jpeg.catch(() => {}); // reported when awaited; ignored after a cancel
                    pages.push({ jpeg, pixelWidth: page.canvas.width, pixelHeight: page.canvas.height, width: page.width, height: page.height, words: page.words });
                }
                // The slide's blank pages, after it (only with ink: without, they are empty).
                const whiteboards = annotations && template && window.QuartoInkWhiteboard ? window.QuartoInkWhiteboard.pages(slideKey) : [];
                for (const board of whiteboards) {
                    if (current.cancelled) break;
                    // All of the page's ink, also what lies outside the slide area.
                    const fit = window.QuartoInkWhiteboard.exportBox(slideKey, board.id, layout.box);
                    const page = window.QuartoInkWhiteboard.renderPage(template, board.style, layout.size.width, { ...fit, slideBox: layout.box });
                    await drawInk(page, slideKey, window.QuartoInkWhiteboard.keyOf(slideKey, board.id), fit.box);
                    const done = page.canvas;
                    const jpeg = canvasToBlob(done, 'image/jpeg', JPEG_QUALITY)
                        .then(async (blob) => new Uint8Array(await blob.arrayBuffer()))
                        .finally(() => releaseCanvas(done));
                    jpeg.catch(() => {});
                    pages.push({ jpeg, pixelWidth: page.canvas.width, pixelHeight: page.canvas.height, width: page.width, height: page.height, words: [] });
                }
            }
            if (!current.cancelled) {
                progress.update(slides.length, slides.length, 'Writing the PDF...');
                for (const page of pages) page.jpeg = await page.jpeg;
                const title = (await agentCall('title')) || (state.slides[0] && state.slides[0].title) || baseFileName();
                pdf = buildPdf(pages, title);
            }
        } catch (e) {
            console.error('[QuartoInkExport] PDF export failed', e);
            qiAlert('Export failed', `The PDF could not be created. ${e && e.message ? e.message : ''}`.trim());
        } finally {
            // Return to the user's layout, slide and tab before the export counts as finished.
            if (layout) await leavePrintLayout(layout);
            await agentCall('end').catch(() => {});
            progress.update(slides.length, slides.length, 'Returning to your slide...');
            try {
                await agentCall('goto', start.h, start.v, start.f);
                if (startScope && (await agentCall('activeTabScope')) !== startScope) {
                    await waitFor(() => state.currentSlide === `${start.h}-${start.v || 0}`, 3000);
                    await agentCall('showTabScope', startScope);
                }
            } catch (_e) {}
            progress.close();
            job = null;
        }
        if (current.cancelled) {
            setStatus('PDF export cancelled');
        } else if (pdf) {
            download(pdf, `${baseFileName()}${annotations ? '-annotated' : ''}.pdf`);
            setStatus(`Exported PDF: ${pages.length} page${pages.length === 1 ? '' : 's'}`);
            if (annotations) window.dispatchEvent(new CustomEvent('quartoink:ink-saved'));
            return true;
        }
        return false;
    }

    // --- Menu -------------------------------------------------------------------

    function initMenu() {
        const button = document.getElementById('btn-export');
        const menu = document.getElementById('export-menu');
        if (!button || !menu) return;
        const close = () => {
            menu.classList.add('hidden');
            button.setAttribute('aria-expanded', 'false');
        };
        button.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = menu.classList.toggle('hidden') === false;
            button.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) {
                const first = menu.querySelector('button');
                if (first) first.focus();
            }
        });
        menu.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.stopPropagation();
                close();
                button.focus();
            }
        });
        document.addEventListener('click', (e) => {
            if (!menu.classList.contains('hidden') && !menu.contains(e.target) && !button.contains(e.target)) close();
        });
        const actions = {
            'btn-export-pdf-ink': () => exportPdf({ annotations: true }),
            'btn-export-pdf-plain': () => exportPdf({ annotations: false }),
            'btn-export-png': () => exportPng(),
        };
        Object.entries(actions).forEach(([id, run]) => {
            const item = document.getElementById(id);
            if (item) item.addEventListener('click', () => { close(); void run(); });
        });
        // Tabs choice: stays open, so it can be set before picking a PDF.
        const tabButtons = Array.from(menu.querySelectorAll('[data-tabs]'));
        const syncTabButtons = () => {
            const mode = getTabMode();
            tabButtons.forEach((b) => b.setAttribute('aria-checked', b.dataset.tabs === mode ? 'true' : 'false'));
        };
        tabButtons.forEach((b) => b.addEventListener('click', (e) => {
            e.stopPropagation();
            setTabMode(b.dataset.tabs);
            syncTabButtons();
        }));
        syncTabButtons();
        const notesSwitch = document.getElementById('qi-export-notes');
        if (notesSwitch) {
            const syncNotes = () => notesSwitch.setAttribute('aria-checked', getNotesInPdf() ? 'true' : 'false');
            notesSwitch.addEventListener('click', (e) => {
                e.stopPropagation();
                setNotesInPdf(!getNotesInPdf());
                syncNotes();
            });
            syncNotes();
        }
    }

    window.QuartoInkExport = { exportPdf, exportPng, renderCurrentSlide, buildPdf };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMenu);
    } else {
        initMenu();
    }
})();
