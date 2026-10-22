/*
 * Quarto Ink: export agent. Runs inside the presentation iframe, which is sandboxed (opaque
 * origin), so the host cannot reach its DOM: the host (assets/ui/quarto-ink-export.js) sends
 * this script with the slide renderer through the bridge (QI_AGENT_LOAD) and calls the methods
 * of window.__qiExportAgent with QI_AGENT_CALL messages.
 *
 * The agent lays out, shows and renders slides of this deck; the host draws the ink and writes
 * the PDF/PNG. Pages come back as ImageBitmaps with the words of the page for the text layer.
 */
(function () {
    'use strict';

    if (window.__qiExportAgent) return;

    const win = window;
    const SETTLE_MS = 120; // let charts and fonts settle after a slide change
    const CAPTURE_STYLE_ID = 'qi-export-capture-style';

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function waitFor(test, timeout) {
        const end = Date.now() + timeout;
        while (Date.now() < end) {
            if (test()) return true;
            await sleep(40);
        }
        return test();
    }

    function nextFrames() {
        return new Promise((resolve) => win.requestAnimationFrame(() => win.requestAnimationFrame(resolve)));
    }

    function isTransparent(color) {
        return !color || color === 'transparent' || /^rgba\(.*,\s*0\)$/.test(color);
    }

    /** Reveal.slide() also rewrites the URL hash, which throws in blob documents after the slide has changed. */
    function revealSlide(reveal, h, v, f) {
        try {
            reveal.slide(h, v || 0, f);
        } catch (_e) {}
    }

    function activeTabScope() {
        try {
            return typeof win.__annotatorGetActiveTabScope === 'function' ? String(win.__annotatorGetActiveTabScope() || '').trim() : '';
        } catch (_e) {
            return '';
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

    /**
     * Rules of a stylesheet this document cannot read (another origin: a CDN theme, Google Fonts,
     * or any sheet, as this sandboxed deck has an opaque origin), fetched and parsed here.
     * Constructed sheets cannot hold @import, so imports become stand-in import rules whose
     * sheet carries its own URL, which relative font URLs resolve against.
     */
    async function fetchSheetRules(win, url, depth) {
        try {
            const text = await (await fetch(url)).text();
            const imports = [];
            const body = text.replace(/@import\s+(?:url\(\s*)?['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/g, (_m, href) => {
                try { imports.push(new URL(href, url).href); } catch (_e) {}
                return '';
            });
            const parsed = new win.CSSStyleSheet();
            parsed.replaceSync(body);
            const nested = depth < 4
                ? await Promise.all(imports.map(async (href) => ({
                    type: RULE_IMPORT,
                    href,
                    styleSheet: { href, cssRules: await fetchSheetRules(win, href, depth + 1) },
                })))
                : [];
            return [...nested, ...Array.from(parsed.cssRules)];
        } catch (_err) {
            return [];
        }
    }

    async function readSheetRules(win, sheet) {
        try {
            return sheet.cssRules;
        } catch (_e) {
            return sheet.href ? fetchSheetRules(win, sheet.href, 0) : [];
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

    // --- Tabs --------------------------------------------------------------------

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

    /** A full click as a user makes it (as the bridge's clickSequence): some tab scripts listen to pointer events. */
    function clickSequence(el) {
        try { el.focus({ preventScroll: true }); } catch (_e) {}
        const opts = { bubbles: true, cancelable: true, view: win, buttons: 1, composed: true };
        try { el.dispatchEvent(new PointerEvent('pointerdown', opts)); } catch (_e) {}
        try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch (_e) {}
        try { el.dispatchEvent(new PointerEvent('pointerup', opts)); } catch (_e) {}
        try { el.dispatchEvent(new MouseEvent('mouseup', opts)); } catch (_e) {}
        try { el.click(); } catch (_e) {}
        if (win.jQuery) {
            try { win.jQuery(el).trigger('click'); } catch (_e) {}
        }
    }

    /** Click the tabs of `scope` (format: see getActiveTabScope in the bridge) and wait until they show. */
    async function showTabScope(scope) {
        if (activeTabScope() === scope) return true;
        const slideEl = win.Reveal.getCurrentSlide();
        const wanted = String(scope || '').split('::');
        for (const list of Array.from(slideEl ? slideEl.querySelectorAll(TABLIST_SELECTOR) : [])) {
            for (const tab of Array.from(list.querySelectorAll(TAB_SELECTOR))) {
                const isActive = tab.getAttribute('aria-selected') === 'true' || tab.classList.contains('active');
                if (wanted.includes(tabKeyOf(tab)) && !isActive) {
                    clickSequence(tab);
                    break;
                }
            }
        }
        const ok = await waitFor(() => activeTabScope() === scope, 2500);
        await nextFrames();
        await sleep(SETTLE_MS);
        return ok;
    }

    // --- Slide rendering --------------------------------------------------------

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
     * Render the current slide, in print layout, as a page: the whole page of the deck
     * (backgrounds, logo, footer, navigation bars of extensions, ...) with only the current
     * slide and its background. `cache` keeps the deck's fonts and CSS between slides of one export.
     */
    async function renderSlide(win, cache, scale) {
        const h2i = win.__qiHtmlToImage;
        if (!h2i) throw new Error('The slide renderer is not loaded in the presentation.');
        const reveal = win.Reveal;
        const revealEl = reveal.getRevealElement();
        const body = win.document.body;
        const slideEl = reveal.getCurrentSlide();
        const background = typeof reveal.getSlideBackground === 'function' ? reveal.getSlideBackground(slideEl) : null;
        const size = reveal.getComputedSlideSize();
        const width = Math.round(size.width);
        const height = Math.round(size.height);

        const canvas = win.document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
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
            pixelRatio: scale,
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
        // An ImageBitmap is transferred to the host without a copy.
        const bitmap = await win.createImageBitmap(canvas);
        return { bitmap, width, height, words, slideRect: { x: b.left, y: b.top, width: b.width, height: b.height } };
    }

    // --- Methods for the host ----------------------------------------------------

    let cache = {};

    window.__qiExportAgent = {
        /** Start an export: fresh font cache, no transitions. */
        begin() {
            cache = {};
            this.setCaptureMode(true);
            return true;
        },
        end() {
            this.setCaptureMode(false);
            cache = {};
            return true;
        },
        isReady() {
            const reveal = win.Reveal;
            return !!(reveal && typeof reveal.getCurrentSlide === 'function' && (!reveal.isReady || reveal.isReady()));
        },
        /** Turn off transitions so slide and fragment changes are final at once. */
        setCaptureMode(on) {
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
            return true;
        },
        slideSize() {
            const size = win.Reveal.getComputedSlideSize();
            return { width: Math.round(size.width), height: Math.round(size.height) };
        },
        /** Box of the scaled .slides element in this viewport (px). */
        slidesRect() {
            const b = win.Reveal.getSlidesElement().getBoundingClientRect();
            return { x: b.left, y: b.top, width: b.width, height: b.height };
        },
        /**
         * Lay out again after the host resized the iframe; with `width` (print layout), wait until
         * the deck has that width and its slide box stops moving (extensions may keep room for bars).
         */
        async layout(width) {
            const reveal = win.Reveal;
            try {
                reveal.layout();
            } catch (_e) {}
            if (typeof width === 'number') {
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
                await nextFrames();
                await sleep(SETTLE_MS);
            } else {
                await nextFrames();
            }
            return true;
        },
        indices() {
            const i = win.Reveal.getIndices();
            return { h: i.h, v: i.v || 0, f: typeof i.f === 'number' ? i.f : undefined };
        },
        goto(h, v, f) {
            revealSlide(win.Reveal, h, v, f);
            return true;
        },
        /** Show a slide with all its fragments. */
        async showSlide(h, v) {
            const reveal = win.Reveal;
            revealSlide(reveal, h, v);
            const slideEl = reveal.getCurrentSlide();
            const indices = Array.from(slideEl.querySelectorAll('.fragment[data-fragment-index]'))
                .map((f) => parseInt(f.getAttribute('data-fragment-index'), 10))
                .filter(Number.isFinite);
            if (indices.length) revealSlide(reveal, h, v, Math.max(...indices));
            await waitForImages(slideEl);
            await nextFrames();
            await sleep(SETTLE_MS);
            return true;
        },
        title() {
            return win.document.title || '';
        },
        activeTabScope,
        allTabScopes() {
            return allTabScopes(win);
        },
        showTabScope,
        render(scale) {
            return renderSlide(win, cache, scale || 2);
        },
    };
})();
