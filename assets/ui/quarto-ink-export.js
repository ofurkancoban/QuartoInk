/*
 * Quarto Ink: PDF and PNG export.
 *
 * - PDF with or without ink: every slide in order, all fragments shown. A slide with Quarto
 *   tabs gets one page per tab.
 * - PNG: the current slide as it is shown, with its ink.
 *
 * For an exact copy of the deck, the deck iframe is laid out at the slide size with the deck's
 * own margin (as a full-screen presentation of that size would be), and the whole presentation surface
 * (slide, background, logo, footer...) is rendered inside the iframe with html-to-image
 * (vendored into excalidraw-widget/dist/vendor/ by the widget build). Ink is drawn on top from
 * the saved Excalidraw scenes, mapped from the normal on-screen layout it was drawn in.
 * The PDF writer below only needs JPEG pages, so no PDF library is required.
 */
(function () {
    'use strict';

    const RENDERER_URL = 'excalidraw-widget/dist/vendor/html-to-image.js';
    const RENDER_SCALE = 2; // output pixels per slide pixel
    const JPEG_QUALITY = 0.92;
    const PX_TO_PT = 0.75; // CSS px (96 dpi) to PDF points (72 dpi)
    const SETTLE_MS = 120; // let charts and fonts settle after a slide change
    const CAPTURE_STYLE_ID = 'qi-export-capture-style';

    let rendererSource = null;
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

    function nextFrames(win) {
        return new Promise((resolve) => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    }

    function setStatus(text) {
        const el = document.getElementById('status-left');
        if (el) el.textContent = text;
    }

    function isTransparent(color) {
        return !color || color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color);
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

    function canvasToBlob(canvas, type, quality) {
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('The slide image could not be encoded.'))), type, quality);
        });
    }

    // --- Deck access ------------------------------------------------------------

    function deckWindow() {
        const frame = document.getElementById('content-frame');
        const win = frame && frame.contentWindow;
        const reveal = win && win.Reveal;
        if (!reveal || typeof reveal.getCurrentSlide !== 'function' || (reveal.isReady && !reveal.isReady())) return null;
        return win;
    }

    /** Reveal.slide() also rewrites the URL hash, which throws in blob documents after the slide has changed. */
    function revealSlide(reveal, h, v, f) {
        try {
            reveal.slide(h, v || 0, f);
        } catch (_e) {}
    }

    /**
     * The slide box (the scaled .slides element) in #canvas-overlay coordinates. Excalidraw scenes
     * and classic ink are stored in those screen coordinates, so this maps them onto the slide.
     */
    function slideBoxInOverlay(win) {
        const frame = document.getElementById('content-frame');
        const overlay = document.getElementById('canvas-overlay');
        const fr = frame.getBoundingClientRect();
        const or = overlay ? overlay.getBoundingClientRect() : { left: 0, top: 0 };
        const b = win.Reveal.getSlidesElement().getBoundingClientRect();
        return {
            x: fr.left + frame.clientLeft + b.left - or.left,
            y: fr.top + frame.clientTop + b.top - or.top,
            width: b.width,
            height: b.height,
        };
    }

    function slideKeyOf(slide) {
        return `${slide.h}-${slide.v || 0}`;
    }

    function activeTabScope(win) {
        try {
            return typeof win.__annotatorGetActiveTabScope === 'function' ? String(win.__annotatorGetActiveTabScope() || '').trim() : '';
        } catch (_e) {
            return '';
        }
    }

    /** Load html-to-image into the deck as a global, also when the deck uses an AMD loader (e.g. htmlwidgets). */
    async function ensureRenderer(win) {
        if (win.__qiHtmlToImage) return win.__qiHtmlToImage;
        if (!rendererSource) {
            const res = await fetch(new URL(RENDERER_URL, location.href));
            if (!res.ok) throw new Error(`The slide renderer is missing (${res.status}). Rebuild excalidraw-widget.`);
            rendererSource = await res.text();
        }
        const doc = win.document;
        const script = doc.createElement('script');
        script.textContent = '(function (define, exports, module) {\nvar __qiPrev = window.htmlToImage;\n'
            + rendererSource
            + '\nwindow.__qiHtmlToImage = window.htmlToImage;\nwindow.htmlToImage = __qiPrev;\n}).call(window);';
        (doc.head || doc.documentElement).appendChild(script);
        script.remove();
        if (!win.__qiHtmlToImage) throw new Error('The slide renderer could not start inside the presentation.');
        return win.__qiHtmlToImage;
    }

    /** Turn off transitions in the deck so slide and fragment changes are final at once. */
    function setCaptureMode(win, on) {
        const doc = win.document;
        const existing = doc.getElementById(CAPTURE_STYLE_ID);
        if (on && !existing) {
            const style = doc.createElement('style');
            style.id = CAPTURE_STYLE_ID;
            style.textContent = '*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important}';
            (doc.head || doc.documentElement).appendChild(style);
        } else if (!on && existing) {
            existing.remove();
        }
    }

    async function waitForImages(root) {
        const pending = Array.from(root.querySelectorAll('img')).filter((img) => !img.complete);
        await Promise.all(pending.map((img) => Promise.race([
            new Promise((resolve) => {
                img.addEventListener('load', resolve, { once: true });
                img.addEventListener('error', resolve, { once: true });
            }),
            sleep(3000),
        ])));
    }

    // --- Fonts -------------------------------------------------------------------
    // html-to-image's own font collection misses fonts loaded through @import (as Reveal themes
    // do) and writes into the deck's stylesheets, so the export collects @font-face rules itself.

    const RULE_IMPORT = 3;
    const RULE_MEDIA = 4;
    const RULE_FONT_FACE = 5;
    const RULE_SUPPORTS = 12;

    const normalizeFamily = (family) => family.trim().replace(/^["']|["']$/g, '').toLowerCase();

    async function readSheetRules(win, sheet) {
        try {
            return sheet.cssRules;
        } catch (_e) {
            // Cross-origin stylesheet (e.g. Google Fonts): fetch and parse it here instead.
            if (!sheet.href) return [];
            try {
                const text = await (await fetch(sheet.href)).text();
                const parsed = new win.CSSStyleSheet();
                parsed.replaceSync(text.replace(/@import[^;]*;/g, ''));
                return parsed.cssRules;
            } catch (_err) {
                return [];
            }
        }
    }

    /** Every @font-face rule of the deck as { family, src, descriptors, base }. */
    async function collectFontFaces(win) {
        const faces = [];
        const doc = win.document;
        const visit = async (rules, base) => {
            for (const rule of Array.from(rules || [])) {
                if (rule.type === RULE_FONT_FACE) {
                    const descriptors = [];
                    for (let i = 0; i < rule.style.length; i++) {
                        const name = rule.style[i];
                        if (name !== 'src') descriptors.push(`${name}: ${rule.style.getPropertyValue(name)}`);
                    }
                    faces.push({
                        family: normalizeFamily(rule.style.getPropertyValue('font-family')),
                        src: rule.style.getPropertyValue('src'),
                        descriptors,
                        base,
                    });
                } else if (rule.type === RULE_IMPORT && rule.styleSheet) {
                    const href = rule.styleSheet.href || new URL(rule.href, base).href;
                    await visit(await readSheetRules(win, rule.styleSheet), href);
                } else if (rule.type === RULE_MEDIA || rule.type === RULE_SUPPORTS) {
                    await visit(rule.cssRules, base);
                }
            }
        };
        for (const sheet of Array.from(doc.styleSheets)) {
            await visit(await readSheetRules(win, sheet), sheet.href || doc.baseURI);
        }
        return faces;
    }

    /**
     * Deck rules for pseudo-elements html-to-image does not copy (it handles ::before/::after
     * only), e.g. coloured list bullets via li::marker. The rendered copy keeps the deck's
     * classes, so these selectors still match there.
     */
    async function pseudoElementCss(win, cache) {
        if (cache.pseudoCss != null) return cache.pseudoCss;
        const css = [];
        const visit = async (rules) => {
            for (const rule of Array.from(rules || [])) {
                if (rule.type === RULE_IMPORT && rule.styleSheet) {
                    await visit(await readSheetRules(win, rule.styleSheet));
                } else if (rule.type === RULE_MEDIA || rule.type === RULE_SUPPORTS) {
                    const inner = [];
                    const before = css.length;
                    await visit(rule.cssRules);
                    inner.push(...css.splice(before));
                    if (inner.length) css.push(`@${rule.type === RULE_MEDIA ? 'media' : 'supports'} ${rule.conditionText} { ${inner.join(' ')} }`);
                } else if (rule.selectorText && /::?(marker|first-letter|first-line)\b/.test(rule.selectorText)) {
                    css.push(rule.cssText);
                }
            }
        };
        for (const sheet of Array.from(win.document.styleSheets)) await visit(await readSheetRules(win, sheet));
        cache.pseudoCss = css.join('\n');
        return cache.pseudoCss;
    }

    /** Font families used by the given elements and their descendants. */
    function usedFamilies(win, roots) {
        const families = new Set();
        let budget = 20000;
        for (const root of roots) {
            for (const el of [root, ...root.querySelectorAll('*')]) {
                if (budget-- <= 0) return families;
                win.getComputedStyle(el).fontFamily.split(',').forEach((f) => families.add(normalizeFamily(f)));
            }
        }
        return families;
    }

    /** First source a browser can use in an SVG image (no EOT/SVG fonts), as an absolute URL. */
    function pickFontSource(face) {
        const re = /url\(\s*(['"]?)(.*?)\1\s*\)\s*(?:format\(\s*['"]?([^'")]+)['"]?\s*\))?/g;
        let m;
        while ((m = re.exec(face.src))) {
            const url = m[2];
            const format = (m[3] || '').toLowerCase();
            if (format === 'embedded-opentype' || format === 'svg' || /\.eot(\?|#|$)/i.test(url)) continue;
            try {
                return { url: url.startsWith('data:') ? url : new URL(url, face.base).href, format };
            } catch (_e) {}
        }
        return null;
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    /** @font-face CSS with embedded files for the fonts `roots` use. `cache` lives for one export. */
    async function fontCssFor(win, roots, cache) {
        if (!cache.faces) {
            cache.faces = await collectFontFaces(win);
            cache.fontData = new Map();
        }
        const families = usedFamilies(win, roots);
        const css = [];
        for (const face of cache.faces) {
            if (!families.has(face.family)) continue;
            const source = pickFontSource(face);
            if (!source) continue;
            if (!cache.fontData.has(source.url)) {
                let data = null;
                if (source.url.startsWith('data:')) {
                    data = source.url;
                } else {
                    try {
                        const res = await fetch(source.url);
                        if (res.ok) data = await blobToDataUrl(await res.blob());
                    } catch (_e) {}
                }
                cache.fontData.set(source.url, data);
            }
            const data = cache.fontData.get(source.url);
            if (!data) continue;
            // Rebuilt from its descriptors: data: URLs contain ';', so editing cssText is unsafe.
            const format = source.format ? ` format("${source.format}")` : '';
            css.push(`@font-face { ${face.descriptors.join('; ')}; src: url("${data}")${format}; }`);
        }
        return css.join('\n');
    }

    // --- Slide rendering --------------------------------------------------------

    /**
     * Lay the deck out at its slide size (iframe = slide size, the deck's own margin), as a
     * full-screen presentation of that size would look. Returns what leavePrintLayout needs,
     * including the slide box of the normal layout, which the ink is mapped from.
     */
    async function enterPrintLayout(win) {
        const frame = document.getElementById('content-frame');
        const reveal = win.Reveal;
        const size = reveal.getComputedSlideSize();
        const width = Math.round(size.width);
        const height = Math.round(size.height);
        const saved = {
            frame,
            style: frame.getAttribute('style'),
            box: slideBoxInOverlay(win),
        };
        frame.style.setProperty('width', `${width}px`, 'important');
        frame.style.setProperty('height', `${height}px`, 'important');
        frame.style.setProperty('flex', 'none', 'important');
        reveal.layout();
        // Extensions may keep room for their own bars, so the slide need not fill the page:
        // wait until the deck has the new size and its slide box stops moving.
        const slidesEl = reveal.getSlidesElement();
        const revealEl = reveal.getRevealElement();
        let last = '';
        await waitFor(() => {
            const b = slidesEl.getBoundingClientRect();
            const now = [b.left, b.top, b.width, b.height].map((v) => v.toFixed(1)).join();
            const settled = now === last && Math.abs(revealEl.clientWidth - width) < 1;
            last = now;
            return settled;
        }, 3000);
        await nextFrames(win);
        await sleep(SETTLE_MS);
        return saved;
    }

    async function leavePrintLayout(win, saved) {
        if (saved.style == null) saved.frame.removeAttribute('style');
        else saved.frame.setAttribute('style', saved.style);
        try {
            win.Reveal.layout();
        } catch (_e) {}
        await nextFrames(win);
    }

    // Interactive parts of a deck that are not part of the slide (Quarto's PDF leaves them out too).
    const UI_ONLY = '.controls, .progress, .slide-menu-button, .pause-overlay, .playback, .slide-chalkboard-buttons, .aria-status, .speaker-notes';

    // Text that is in the DOM but not on the page.
    const HIDDEN_TEXT = 'script, style, noscript, template, mjx-assistive-mml, .sr-only, .visually-hidden';

    /**
     * The visible words under `roots` with their boxes on the page (page px), for the PDF's
     * invisible text layer that makes the text selectable and searchable.
     */
    function collectWords(win, roots, width, height) {
        const doc = win.document;
        const visible = new Map();
        const isVisible = (el) => {
            if (!el || el === doc.body || el === doc.documentElement) return true;
            if (visible.has(el)) return visible.get(el);
            let ok = !el.matches(HIDDEN_TEXT) && !el.matches(UI_ONLY);
            if (ok) {
                const cs = win.getComputedStyle(el);
                ok = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05 && isVisible(el.parentElement);
            }
            visible.set(el, ok);
            return ok;
        };
        const words = [];
        const range = doc.createRange();
        for (const root of roots) {
            const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                const text = node.nodeValue;
                if (!text || !text.trim() || !isVisible(node.parentElement)) continue;
                const re = /\S+/g;
                let m;
                while ((m = re.exec(text))) {
                    range.setStart(node, m.index);
                    range.setEnd(node, m.index + m[0].length);
                    const r = range.getClientRects()[0];
                    if (!r || r.width < 1 || r.height < 2) continue;
                    if (r.right <= 0 || r.bottom <= 0 || r.left >= width || r.top >= height) continue;
                    words.push({ text: m[0], x: r.left, y: r.top, width: r.width, height: r.height });
                }
            }
        }
        return words;
    }

    /**
     * Render the current slide, in print layout, as a canvas of this page: the whole page of the
     * deck (backgrounds, logo, footer, navigation bars of extensions, ...) with only the current
     * slide and its background. `cache` keeps the deck's fonts and CSS between slides of one export.
     */
    async function renderSlide(win, cache) {
        const h2i = await ensureRenderer(win);
        const reveal = win.Reveal;
        const revealEl = reveal.getRevealElement();
        const body = win.document.body;
        const slideEl = reveal.getCurrentSlide();
        const background = typeof reveal.getSlideBackground === 'function' ? reveal.getSlideBackground(slideEl) : null;
        const size = reveal.getComputedSlideSize();
        const width = Math.round(size.width);
        const height = Math.round(size.height);

        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * RENDER_SCALE);
        canvas.height = Math.round(height * RENDER_SCALE);
        const ctx = canvas.getContext('2d');

        // Page colour: the theme background (Reveal puts it on the viewport), else white.
        const viewport = typeof reveal.getViewportElement === 'function' ? reveal.getViewportElement() : win.document.body;
        let pageColor = win.getComputedStyle(viewport).backgroundColor;
        if (isTransparent(pageColor)) pageColor = win.getComputedStyle(win.document.body).backgroundColor;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!isTransparent(pageColor)) {
            ctx.fillStyle = pageColor;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        // Fonts of the slide and of everything around it (logo, footer, ...), plus pseudo-element rules.
        const chrome = [
            ...Array.from(revealEl.children).filter((el) => !el.matches('.slides, .backgrounds')),
            ...Array.from(body.children).filter((el) => el !== revealEl && !el.matches('script, style, link, template, noscript')),
        ];
        let fontEmbedCSS = '';
        try {
            fontEmbedCSS = `${await fontCssFor(win, [slideEl, ...chrome], cache)}\n${await pseudoElementCss(win, cache)}`;
        } catch (e) {
            console.warn('[QuartoInkExport] fonts', e);
        }

        const keep = (node) => {
            if (node.nodeType !== 1) return true;
            if (node.tagName === 'SECTION' && node.closest('.slides')) return node === slideEl || node.contains(slideEl);
            if (node.classList.contains('slide-background')) return !!background && (node === background || node.contains(background));
            return !node.matches(UI_ONLY);
        };
        const content = await h2i.toCanvas(body, {
            width,
            height,
            pixelRatio: RENDER_SCALE,
            skipAutoScale: true,
            // Always a string, so html-to-image never runs its own font collection.
            fontEmbedCSS,
            filter: keep,
            // Patched renderer (excalidraw-widget/scripts/renderer-patches.mjs): copy only the
            // styles the copy would not compute by itself, which makes each page several times faster.
            qiCompactStyles: true,
            qiRoot: body,
        });
        ctx.drawImage(content, 0, 0, canvas.width, canvas.height);
        let words = [];
        try {
            words = collectWords(win, [slideEl, ...chrome], width, height);
        } catch (e) {
            console.warn('[QuartoInkExport] text layer', e);
        }
        // Where the slide sits on the page (in page px): the ink is mapped onto this box.
        const b = reveal.getSlidesElement().getBoundingClientRect();
        return { canvas, width, height, words, slideRect: { x: b.left, y: b.top, width: b.width, height: b.height } };
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
    async function drawInk(win, page, slideKey, annotationKey, box) {
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
        if (classic && classic.length && overlay && overlay.clientWidth && state.currentSlide === slideKey) {
            // The overlay follows the current (print) layout.
            redraw();
            const now = slideBoxInOverlay(win);
            const r = overlay.width / overlay.clientWidth;
            ctx.drawImage(overlay, now.x * r, now.y * r, now.width * r, now.height * r, tx, ty, tw, th);
        }
    }

    // --- Navigation for the PDF -------------------------------------------------

    /** Show `slide` with all its fragments, and wait until the app follows. */
    async function showSlide(win, slide) {
        const reveal = win.Reveal;
        revealSlide(reveal, slide.h, slide.v);
        const slideEl = reveal.getCurrentSlide();
        const indices = Array.from(slideEl.querySelectorAll('.fragment[data-fragment-index]'))
            .map((f) => parseInt(f.getAttribute('data-fragment-index'), 10))
            .filter(Number.isFinite);
        if (indices.length) revealSlide(reveal, slide.h, slide.v, Math.max(...indices));
        await waitFor(() => state.currentSlide === slideKeyOf(slide), 3000);
        await waitForImages(slideEl);
        await nextFrames(win);
        await sleep(SETTLE_MS);
    }

    async function showTabScope(win, scope) {
        if (activeTabScope(win) === scope) return true;
        try { win.postMessage({ type: 'ACTIVATE_TAB_SCOPE', scope }, qiTargetOrigin()); } catch (_e) {}
        const ok = await waitFor(() => activeTabScope(win) === scope, 2500);
        await nextFrames(win);
        await sleep(SETTLE_MS);
        return ok;
    }

    // Same selectors and tab keys as the deck bridge (getActiveTabScope / ACTIVATE_TAB_SCOPE in index.html).
    const TABLIST_SELECTOR = '[role="tablist"], ul.panel-tabset-tabby, .nav-tabs';
    const TAB_SELECTOR = '[role="tab"], a[href^="#"], button, .tabby-toggle';
    const ACTIVE_TAB_SELECTOR = '[aria-selected="true"], .active[role="tab"], a.active, button.active, .tabby-toggle[aria-expanded="true"]';

    function tabKeyOf(tab) {
        return tab.getAttribute('href') || tab.getAttribute('id') || (tab.textContent || '').trim().substring(0, 40);
    }

    /**
     * Every tab scope of the current slide, in tab order: each tab of each tabset, with the
     * other tabsets on the tab they show now. A slide without tabs gives [''].
     */
    function allTabScopes(win) {
        const slideEl = win.Reveal.getCurrentSlide();
        if (!slideEl) return [''];
        // Tabsets the bridge counts: the ones with an active tab.
        const lists = Array.from(slideEl.querySelectorAll(TABLIST_SELECTOR))
            .map((list) => ({ list, active: list.querySelector(ACTIVE_TAB_SELECTOR) }))
            .filter((t) => t.active);
        if (!lists.length) return [''];
        const shown = lists.map((t) => tabKeyOf(t.active));
        const scopes = [shown.join('::')];
        lists.forEach((t, i) => {
            for (const tab of t.list.querySelectorAll(TAB_SELECTOR)) {
                const key = tabKeyOf(tab);
                if (!key) continue;
                const parts = shown.slice();
                parts[i] = key;
                const scope = parts.join('::');
                if (!scopes.includes(scope)) scopes.push(scope);
            }
        });
        // In tab order: the first tabset's tabs come first, starting with its first tab.
        const firstKeys = Array.from(lists[0].list.querySelectorAll(TAB_SELECTOR)).map(tabKeyOf);
        if (lists.length === 1) scopes.sort((a, b) => firstKeys.indexOf(a) - firstKeys.indexOf(b));
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

    async function prepare() {
        if (!state.htmlContent) {
            qiAlert('Nothing to export', 'Open a presentation first.');
            return null;
        }
        const win = deckWindow();
        if (!win) {
            qiAlert('Presentation not ready', 'Wait until the presentation has finished loading, then try again.');
            return null;
        }
        if (typeof ensureExcalidrawRuntime === 'function') await ensureExcalidrawRuntime();
        if (state.annotationEngine === 'excalidraw') {
            try { flushExcalidrawSceneToStorageForCurrentKey(); } catch (_e) {}
        }
        return win;
    }

    /** Render the current slide as shown (current fragments and tab), optionally with its ink. */
    async function renderCurrentSlide({ annotations = true } = {}) {
        const win = deckWindow();
        if (!win) throw new Error('No presentation is ready.');
        setCaptureMode(win, true);
        const saved = await enterPrintLayout(win);
        try {
            const page = await renderSlide(win, {});
            if (annotations) await drawInk(win, page, state.currentSlide, getCurrentAnnotationKey(), saved.box);
            return page.canvas;
        } finally {
            await leavePrintLayout(win, saved);
            setCaptureMode(win, false);
        }
    }

    function isBusy() {
        if (job) setStatus('An export is already running');
        return !!job;
    }

    async function exportPng() {
        if (isBusy()) return;
        const win = await prepare();
        if (!win) return;
        job = { cancelled: false };
        // The deck is briefly laid out at slide size: keep it covered while that happens.
        const progress = showProgress('Exporting PNG', null);
        progress.update(0, 1, 'Rendering the current slide...');
        try {
            setStatus('Exporting the current slide as PNG...');
            const canvas = await renderCurrentSlide({ annotations: true });
            const blob = await canvasToBlob(canvas, 'image/png');
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
        const win = await prepare();
        if (!win) return;
        const slides = (state.slides || []).slice();
        if (!slides.length) {
            qiAlert('Nothing to export', 'The presentation has no slides yet.');
            return;
        }
        const current = job = { cancelled: false };
        const reveal = win.Reveal;
        const start = reveal.getIndices();
        const startScope = activeTabScope(win);
        const progress = showProgress(annotations ? 'Exporting PDF with ink' : 'Exporting PDF', () => { current.cancelled = true; });
        const pages = [];
        const cache = {};
        let pdf = null;
        let layout = null;
        try {
            setCaptureMode(win, true);
            layout = await enterPrintLayout(win);
            for (let i = 0; i < slides.length && !current.cancelled; i++) {
                const slide = slides[i];
                const slideKey = slideKeyOf(slide);
                progress.update(i, slides.length, `Slide ${i + 1} of ${slides.length}`);
                setStatus(`Exporting PDF: slide ${i + 1} of ${slides.length}`);
                await showSlide(win, slide);

                // One page per tab, so the content of every tab is in the PDF; then any other tab
                // scope that carries ink (e.g. a tab combination of several tabsets).
                const scopes = allTabScopes(win);
                if (annotations) inkedTabScopes(slideKey).forEach((s) => { if (!scopes.includes(s)) scopes.push(s); });
                for (const scope of scopes) {
                    if (current.cancelled) break;
                    if (scope !== activeTabScope(win) && !(await showTabScope(win, scope))) continue;
                    const page = await renderSlide(win, cache);
                    if (annotations) await drawInk(win, page, slideKey, getCurrentAnnotationKey(slideKey, scope), layout.box);
                    // Encoded while the next slide renders; awaited before the PDF is written.
                    const jpeg = canvasToBlob(page.canvas, 'image/jpeg', JPEG_QUALITY)
                        .then(async (blob) => new Uint8Array(await blob.arrayBuffer()));
                    jpeg.catch(() => {}); // reported when awaited; ignored after a cancel
                    pages.push({ jpeg, pixelWidth: page.canvas.width, pixelHeight: page.canvas.height, width: page.width, height: page.height, words: page.words });
                }
            }
            if (!current.cancelled) {
                progress.update(slides.length, slides.length, 'Writing the PDF...');
                for (const page of pages) page.jpeg = await page.jpeg;
                const title = win.document.title || (state.slides[0] && state.slides[0].title) || baseFileName();
                pdf = buildPdf(pages, title);
            }
        } catch (e) {
            console.error('[QuartoInkExport] PDF export failed', e);
            qiAlert('Export failed', `The PDF could not be created. ${e && e.message ? e.message : ''}`.trim());
        } finally {
            // Return to the user's layout, slide and tab before the export counts as finished.
            if (layout) await leavePrintLayout(win, layout);
            setCaptureMode(win, false);
            progress.update(slides.length, slides.length, 'Returning to your slide...');
            try {
                revealSlide(reveal, start.h, start.v, start.f);
                if (startScope && activeTabScope(win) !== startScope) {
                    await waitFor(() => state.currentSlide === `${start.h}-${start.v || 0}`, 3000);
                    await showTabScope(win, startScope);
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
        }
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
    }

    window.QuartoInkExport = { exportPdf, exportPng, renderCurrentSlide, buildPdf };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMenu);
    } else {
        initMenu();
    }
})();
