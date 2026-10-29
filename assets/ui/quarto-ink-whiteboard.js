/*
 * Quarto Ink: blank pages (whiteboards) between slides.
 *
 * A blank page belongs to the slide it follows; a slide can have several. They live in the
 * app, not in the deck, so the deck's slide numbers (which key all ink) never change. While
 * one is shown, a paper sheet covers the deck and the ink goes to its own key,
 * "<slide>::wb:<id>" (see getCurrentAnnotationKey in index.html).
 *
 * Next/Prev walk through a slide's pages before moving on; the bridge keeps Reveal from
 * skipping them when the deck has the keyboard (QI_NAV_LOCK). The PDF export puts each
 * page after its slide, with all of its ink fitted onto the page.
 *
 * Unlike slides, a page can be zoomed and panned: a two-finger pinch on a touch screen (done
 * here, as a one-finger touch is a swipe to the next slide) or the trackpad (Excalidraw's own).
 */
(function () {
    'use strict';

    const STYLES = ['plain', 'grid', 'lines'];
    const STYLE_LABELS = { plain: 'Plain', grid: 'Grid', lines: 'Lines' };
    // Grid and line spacing, in slide px (scaled with the slide on screen and in the export).
    const SPACING = 40;
    const MIN_ZOOM = 0.3;
    const MAX_ZOOM = 5;

    let sheet = null;
    let chip = null;

    // --- Model ----------------------------------------------------------------------

    function pages(slideKey) {
        return (state.whiteboards && state.whiteboards.get(slideKey)) || [];
    }

    function keyOf(slideKey, id) {
        return `${slideKey}::wb:${id}`;
    }

    /** The page shown now: { slideKey, id, index, page } or null. */
    function current() {
        const wb = state.currentWhiteboard;
        if (!wb || wb.slideKey !== state.currentSlide) return null;
        const list = pages(wb.slideKey);
        const index = list.findIndex((p) => p.id === wb.id);
        return index === -1 ? null : { slideKey: wb.slideKey, id: wb.id, index, page: list[index] };
    }

    /** The ink key of the page shown now, or null on a slide. */
    function currentKey() {
        const cur = current();
        return cur ? keyOf(cur.slideKey, cur.id) : null;
    }

    function slideIndex(key) {
        return (state.slides || []).findIndex((s) => `${s.h}-${s.v || 0}` === key);
    }

    function newId() {
        return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }

    // --- Moving between slides and pages -------------------------------------------------

    function show(slideKey, id) {
        qiSwitchAnnotationTarget(() => {
            state.currentWhiteboard = id ? { slideKey, id } : null;
        });
        render();
    }

    /** Show a page of a slide; for another slide, the deck moves there first. */
    function enter(slideKey, id) {
        if (slideKey === state.currentSlide) {
            show(slideKey, id);
            return;
        }
        state.currentWhiteboard = { slideKey, id };
        const slide = state.slides[slideIndex(slideKey)];
        if (slide) goToSlide(slide);
    }

    function leave() {
        if (state.currentWhiteboard) show(state.currentSlide, null);
    }

    /** Add a blank page right after the slide or page shown now, and show it. */
    function add(style) {
        if (!state.htmlContent) return;
        if (!state.whiteboards) state.whiteboards = new Map();
        const slideKey = state.currentSlide;
        const list = pages(slideKey).slice();
        const cur = current();
        const page = { id: newId(), style: STYLES.includes(style) ? style : (cur ? cur.page.style : 'grid') };
        list.splice(cur ? cur.index + 1 : 0, 0, page);
        state.whiteboards.set(slideKey, list);
        show(slideKey, page.id);
        // Saved now: a page with nothing drawn on it yet would otherwise be lost on a reload.
        try { saveToLocalStorage(); } catch (_e) {}
    }

    function setStyle(style) {
        const cur = current();
        if (!cur || !STYLES.includes(style)) return;
        cur.page.style = style;
        try { saveToLocalStorage(); } catch (_e) {}
        render();
    }

    async function remove() {
        const cur = current();
        if (!cur) return;
        const key = keyOf(cur.slideKey, cur.id);
        const sceneHasInk = () => {
            try {
                const scene = state.excalidrawScenes.get(key);
                const parsed = typeof scene === 'string' ? JSON.parse(scene) : scene;
                return !!parsed && (parsed.elements || []).some((e) => !e.isDeleted);
            } catch (_e) {
                return false;
            }
        };
        const hasInk = (state.annotations.get(key) || []).length > 0 || sceneHasInk();
        if (hasInk) {
            const ok = await qiConfirm('Delete this blank page?', 'Its ink is deleted with it.', { confirmText: 'Delete page', danger: true });
            if (!ok) return;
        }
        const list = pages(cur.slideKey).filter((p) => p.id !== cur.id);
        const next = list[cur.index] || list[cur.index - 1] || null;
        qiSwitchAnnotationTarget(() => {
            if (list.length) state.whiteboards.set(cur.slideKey, list);
            else state.whiteboards.delete(cur.slideKey);
            state.annotations.delete(key);
            state.excalidrawScenes.delete(key);
            state.currentWhiteboard = next ? { slideKey: cur.slideKey, id: next.id } : null;
        });
        try { saveToLocalStorage(); } catch (_e) {}
        render();
    }

    /**
     * Next/Prev from the app (keys, buttons, swipes). Returns true when it moved within the
     * blank pages, false to let the deck navigate as usual.
     */
    function handleNavigate(dir) {
        const cur = current();
        const fragments = state.fragmentsAvailable || {};
        const index = slideIndex(state.currentSlide);
        if (dir === 'Next') {
            if (cur) {
                const list = pages(cur.slideKey);
                if (cur.index + 1 < list.length) show(cur.slideKey, list[cur.index + 1].id);
                else {
                    // Past the last page: the slide after it, from its start.
                    const next = state.slides[index + 1];
                    leave();
                    if (next) goToSlide(next);
                }
                return true;
            }
            const list = pages(state.currentSlide);
            if (list.length && !fragments.next) {
                show(state.currentSlide, list[0].id);
                return true;
            }
            return false;
        }
        if (dir === 'Prev') {
            if (cur) {
                if (cur.index > 0) show(cur.slideKey, pages(cur.slideKey)[cur.index - 1].id);
                else leave();
                return true;
            }
            const prev = state.slides[index - 1];
            const prevKey = prev && `${prev.h}-${prev.v || 0}`;
            if (prev && pages(prevKey).length && !fragments.prev) {
                const list = pages(prevKey);
                enter(prevKey, list[list.length - 1].id);
                return true;
            }
        }
        return false;
    }

    /** A slide change in the deck: a page of another slide is no longer shown. */
    function onSlideChange(slideKey) {
        if (state.currentWhiteboard && state.currentWhiteboard.slideKey !== slideKey) state.currentWhiteboard = null;
    }

    // --- Sheet over the deck --------------------------------------------------------------

    /** CSS background of a page style, for a slide shown at `scale` px per slide px. */
    function cssBackground(style, scale, offsetX, offsetY) {
        const step = SPACING * scale;
        const line = 'rgba(29, 27, 23, 0.09)';
        if (style === 'grid') {
            return {
                backgroundImage: `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`,
                backgroundSize: `${step}px ${step}px`,
                backgroundPosition: `${offsetX}px ${offsetY}px`,
            };
        }
        if (style === 'lines') {
            return {
                backgroundImage: `linear-gradient(${line} 1px, transparent 1px)`,
                backgroundSize: `100% ${step}px`,
                backgroundPosition: `0 ${offsetY}px`,
            };
        }
        return { backgroundImage: 'none', backgroundSize: '', backgroundPosition: '' };
    }

    function ensureElements() {
        if (sheet) return;
        const stage = document.getElementById('editor-stage');
        if (!stage) return;
        sheet = document.createElement('div');
        sheet.id = 'qi-whiteboard';
        sheet.setAttribute('aria-hidden', 'true');
        sheet.innerHTML = '<div class="qi-wb-slide-box"></div>';
        stage.insertBefore(sheet, document.getElementById('canvas-overlay'));

        chip = document.createElement('div');
        chip.id = 'qi-whiteboard-chip';
        chip.setAttribute('role', 'toolbar');
        chip.setAttribute('aria-label', 'Blank page');
        // Folded to a small tab in the sheet's corner, so it does not cover the page: a tap on
        // it shows the paper styles and delete.
        chip.innerHTML = '<button type="button" class="qi-wb-toggle" aria-expanded="false" title="Page options">'
            + '<span class="qi-wb-title"></span>'
            + '<svg class="qi-wb-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>'
            + '<span class="qi-wb-styles">' + STYLES.map((s) => `<button type="button" data-style="${s}">${STYLE_LABELS[s]}</button>`).join('') + '</span>'
            + '<button type="button" class="qi-wb-zoom" title="Back to 100%"></button>'
            + '<button type="button" class="qi-wb-delete" title="Delete this blank page" aria-label="Delete this blank page">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>';
        stage.appendChild(chip);
        chip.querySelector('.qi-wb-toggle').addEventListener('click', () => setChipOpen(!chip.classList.contains('is-open')));
        chip.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => {
            setStyle(b.dataset.style);
            setChipOpen(false);
        }));
        chip.querySelector('.qi-wb-zoom').addEventListener('click', () => {
            setCamera(0, 0, 1);
            setChipOpen(false);
        });
        chip.querySelector('.qi-wb-delete').addEventListener('click', () => {
            setChipOpen(false);
            void remove();
        });
        document.addEventListener('pointerdown', (e) => {
            if (chip.classList.contains('is-open') && !chip.contains(e.target)) setChipOpen(false);
        }, true);
    }

    function setChipOpen(open) {
        if (!chip) return;
        chip.classList.toggle('is-open', !!open);
        chip.querySelector('.qi-wb-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    /** Show or hide the sheet and fit it to the slide box; tell the deck which keys to hold back. */
    function render() {
        ensureElements();
        const cur = current();
        document.body.classList.toggle('qi-on-whiteboard', !!cur);
        const excal = window.QuartoInkExcalidraw;
        if (excal && excal.setCameraFree) excal.setCameraFree(!!cur);
        if (sheet) sheet.style.display = cur ? 'block' : 'none';
        if (chip) chip.style.display = cur ? 'flex' : 'none';
        if (!cur) setChipOpen(false);
        if (cur && sheet) {
            // The whole slide area: the export maps the page's ink onto it.
            const m = state.slidesBox || state.slideMetrics || { x: 0, y: 0, width: 0, height: 0 };
            const base = (state.baseSlideSize && state.baseSlideSize.width) || m.width || 1;
            const scale = m.width / base || 1;
            // The lines follow the page's zoom and pan (scene -> screen: (p + scroll) * zoom).
            const cam = camera();
            Object.assign(sheet.style, cssBackground(cur.page.style, scale * cam.zoom, (m.x + cam.scrollX) * cam.zoom, (m.y + cam.scrollY) * cam.zoom));
            const box = sheet.firstElementChild;
            Object.assign(box.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.width}px`, height: `${m.height}px` });
            // The sheet's top-left corner, outside the slide area where the ink goes.
            chip.style.left = '8px';
            chip.style.top = '8px';
            const percent = Math.round(cam.zoom * 100);
            chip.querySelector('.qi-wb-title').textContent = `Page ${cur.index + 1}${percent === 100 ? '' : ` · ${percent}%`}`;
            const zoomBtn = chip.querySelector('.qi-wb-zoom');
            zoomBtn.textContent = '100%';
            zoomBtn.hidden = percent === 100 && cam.scrollX === 0 && cam.scrollY === 0;
            chip.querySelectorAll('[data-style]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.style === cur.page.style ? 'true' : 'false'));
        }
        updateIndicator(cur);
        sendNavLock();
    }

    function updateIndicator(cur) {
        const el = document.getElementById('slide-indicator');
        const index = slideIndex(state.currentSlide);
        if (!el || index === -1) return;
        el.textContent = `Slide: ${index + 1} / ${state.slideCount}${cur ? ` + page ${cur.index + 1}` : ''}`;
    }

    /** The deck holds back Next/Prev keys and swipes where they lead into or within pages. */
    function sendNavLock() {
        const frame = document.getElementById('content-frame');
        if (!frame || !frame.contentWindow) return;
        const cur = current();
        const fragments = state.fragmentsAvailable || {};
        const index = slideIndex(state.currentSlide);
        const prev = state.slides && state.slides[index - 1];
        const lock = {
            next: !!cur || (pages(state.currentSlide).length > 0 && !fragments.next),
            prev: !!cur || (!!prev && pages(`${prev.h}-${prev.v || 0}`).length > 0 && !fragments.prev),
        };
        try { frame.contentWindow.postMessage({ type: 'QI_NAV_LOCK', next: lock.next, prev: lock.prev }, qiTargetOrigin()); } catch (_e) {}
    }

    // --- Zoom and pan --------------------------------------------------------------------------

    function excalApi() {
        const excal = window.QuartoInkExcalidraw;
        return excal && excal.getAPI ? excal.getAPI() : null;
    }

    function camera() {
        const api = excalApi();
        const a = api && api.getAppState();
        if (!a || !current()) return { scrollX: 0, scrollY: 0, zoom: 1 };
        return { scrollX: a.scrollX || 0, scrollY: a.scrollY || 0, zoom: (a.zoom && a.zoom.value) || 1 };
    }

    function setCamera(scrollX, scrollY, zoom) {
        const api = excalApi();
        if (!api || !current()) return;
        try {
            api.updateScene({ appState: { scrollX, scrollY, zoom: { value: zoom } }, commitToHistory: false });
        } catch (_e) {}
        render();
    }

    let pinch = null;
    let pinchFrame = 0;
    let holdUntilLift = false; // a finger stays down after a pinch: it must not draw or swipe

    const isStylus = (t) => t.touchType === 'stylus';

    function touchCenter(touches, rect) {
        const a = touches[0];
        const b = touches[1];
        return {
            x: (a.clientX + b.clientX) / 2 - rect.left,
            y: (a.clientY + b.clientY) / 2 - rect.top,
            d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1,
        };
    }

    function onTouchStart(e) {
        if (!current() || !e.touches || e.touches.length !== 2) return;
        if (Array.prototype.some.call(e.touches, isStylus)) return;
        const host = document.getElementById('excalidraw-host');
        const stage = document.getElementById('editor-stage');
        if (!host || !stage || !stage.contains(e.target)) return;
        // Two fingers: a pinch, not the swipe to the next slide that the first finger started.
        if (typeof onFingerSwipeTouchCancelCapture === 'function') onFingerSwipeTouchCancelCapture();
        if (typeof setExcalidrawCanvasInputBlocked === 'function') setExcalidrawCanvasInputBlocked(true);
        e.preventDefault();
        e.stopImmediatePropagation();
        const rect = host.getBoundingClientRect();
        const c = touchCenter(e.touches, rect);
        const cam = camera();
        // The page point under the fingers stays under them.
        pinch = { rect, d0: c.d, zoom0: cam.zoom, px: c.x / cam.zoom - cam.scrollX, py: c.y / cam.zoom - cam.scrollY };
    }

    function onTouchMove(e) {
        if (!pinch) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (!e.touches || e.touches.length < 2) return;
        const c = touchCenter(e.touches, pinch.rect);
        const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, pinch.zoom0 * (c.d / pinch.d0)));
        const next = { scrollX: c.x / zoom - pinch.px, scrollY: c.y / zoom - pinch.py, zoom };
        cancelAnimationFrame(pinchFrame);
        pinchFrame = requestAnimationFrame(() => setCamera(next.scrollX, next.scrollY, next.zoom));
    }

    function onTouchEnd(e) {
        if (!pinch) return;
        if (e.touches && e.touches.length >= 2) return;
        pinch = null;
        e.stopImmediatePropagation();
        holdUntilLift = true;
        onTouchEndRest(e);
    }

    function onTouchEndRest(e) {
        if (!holdUntilLift || pinch || (e.touches && e.touches.length)) return;
        holdUntilLift = false;
        if (typeof setExcalidrawCanvasInputBlocked === 'function') setExcalidrawCanvasInputBlocked(false);
    }

    /**
     * The scene area to put on the exported page: the slide box, grown to hold all of the
     * page's ink (it may be drawn outside it, zoomed out), with the slide's proportions.
     * Returns { box, factor } (factor: how much larger than the slide box).
     */
    function exportBox(slideKey, id, box) {
        const excal = window.QuartoInkExcalidraw;
        const scene = state.excalidrawScenes.get(keyOf(slideKey, id));
        const serialized = typeof scene === 'string' ? scene : (scene ? JSON.stringify(scene) : null);
        const bounds = excal && excal.getSceneBounds ? excal.getSceneBounds(serialized) : null;
        if (!bounds || !(box.width > 0 && box.height > 0)) return { box, factor: 1 };
        const pad = 16;
        const minX = Math.min(box.x, bounds[0] - pad);
        const minY = Math.min(box.y, bounds[1] - pad);
        const maxX = Math.max(box.x + box.width, bounds[2] + pad);
        const maxY = Math.max(box.y + box.height, bounds[3] + pad);
        const factor = Math.max((maxX - minX) / box.width, (maxY - minY) / box.height, 1);
        const width = box.width * factor;
        const height = box.height * factor;
        return {
            box: { x: (minX + maxX) / 2 - width / 2, y: (minY + maxY) / 2 - height / 2, width, height },
            factor,
        };
    }

    // --- Export -----------------------------------------------------------------------------

    /**
     * A blank page for the PDF/PNG export, like the rendered slide pages: `template` gives the
     * page size and where the slide box sits ({ canvas, width, height, slideRect }). With `fit`
     * (from exportBox), the lines are drawn as they lie under the ink fitted onto the page.
     */
    function renderPage(template, style, slideWidth, fit) {
        const canvas = document.createElement('canvas');
        canvas.width = template.canvas.width;
        canvas.height = template.canvas.height;
        const k = canvas.width / template.width;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const rect = template.slideRect;
        const factor = (fit && fit.factor) || 1;
        const step = SPACING * (rect.width / ((slideWidth || rect.width) * factor)) * k;
        if (style === 'grid' || style === 'lines') {
            ctx.fillStyle = 'rgba(29, 27, 23, 0.09)';
            // Where the slide box's corner (the lines' origin on screen) lands on the page.
            let originX = rect.x;
            let originY = rect.y;
            if (fit && fit.slideBox && fit.box) {
                const s = rect.width / fit.box.width;
                originX = rect.x + (fit.slideBox.x - fit.box.x) * s;
                originY = rect.y + (fit.slideBox.y - fit.box.y) * s;
            }
            const ox = (((originX * k) % step) + step) % step;
            const oy = (((originY * k) % step) + step) % step;
            const w = Math.max(1, Math.round(k));
            for (let y = oy; y < canvas.height; y += step) ctx.fillRect(0, Math.round(y), canvas.width, w);
            if (style === 'grid') for (let x = ox; x < canvas.width; x += step) ctx.fillRect(Math.round(x), 0, w, canvas.height);
        }
        return { canvas, width: template.width, height: template.height, words: [], slideRect: rect };
    }

    function init() {
        if (!state.whiteboards) state.whiteboards = new Map();
        const stage = document.getElementById('editor-stage');
        if (stage && 'ResizeObserver' in window) new ResizeObserver(() => { if (current()) render(); }).observe(stage);
        window.addEventListener('touchstart', onTouchStart, { capture: true, passive: false });
        window.addEventListener('touchmove', onTouchMove, { capture: true, passive: false });
        window.addEventListener('touchend', onTouchEnd, { capture: true });
        window.addEventListener('touchcancel', onTouchEnd, { capture: true });
        window.addEventListener('touchend', onTouchEndRest);
        window.addEventListener('touchcancel', onTouchEndRest);
        window.addEventListener('quartoink:camera', () => { if (current()) render(); });
    }

    window.QuartoInkWhiteboard = {
        STYLES, pages, keyOf, current, currentKey, add, enter, leave, setStyle, remove,
        handleNavigate, onSlideChange, render, renderPage, exportBox, camera, setCamera,
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
