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
 * page after its slide.
 */
(function () {
    'use strict';

    const STYLES = ['plain', 'grid', 'lines'];
    const STYLE_LABELS = { plain: 'Plain', grid: 'Grid', lines: 'Lines' };
    // Grid and line spacing, in slide px (scaled with the slide on screen and in the export).
    const SPACING = 40;

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
        chip.innerHTML = '<span class="qi-wb-title"></span>'
            + '<span class="qi-wb-styles">' + STYLES.map((s) => `<button type="button" data-style="${s}">${STYLE_LABELS[s]}</button>`).join('') + '</span>'
            + '<button type="button" class="qi-wb-delete" title="Delete this blank page" aria-label="Delete this blank page">'
            + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg></button>';
        stage.appendChild(chip);
        chip.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => setStyle(b.dataset.style)));
        chip.querySelector('.qi-wb-delete').addEventListener('click', () => { void remove(); });
    }

    /** Show or hide the sheet and fit it to the slide box; tell the deck which keys to hold back. */
    function render() {
        ensureElements();
        const cur = current();
        document.body.classList.toggle('qi-on-whiteboard', !!cur);
        if (sheet) sheet.style.display = cur ? 'block' : 'none';
        if (chip) chip.style.display = cur ? 'flex' : 'none';
        if (cur && sheet) {
            // The whole slide area: the export maps the page's ink onto it.
            const m = state.slidesBox || state.slideMetrics || { x: 0, y: 0, width: 0, height: 0 };
            const base = (state.baseSlideSize && state.baseSlideSize.width) || m.width || 1;
            const scale = m.width / base || 1;
            Object.assign(sheet.style, cssBackground(cur.page.style, scale, m.x, m.y));
            const box = sheet.firstElementChild;
            Object.assign(box.style, { left: `${m.x}px`, top: `${m.y}px`, width: `${m.width}px`, height: `${m.height}px` });
            chip.style.left = `${Math.max(8, m.x + 10)}px`;
            chip.style.top = `${Math.max(8, m.y + 10)}px`;
            chip.querySelector('.qi-wb-title').textContent = `Blank page ${cur.index + 1}`;
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

    // --- Export -----------------------------------------------------------------------------

    /**
     * A blank page for the PDF/PNG export, like the rendered slide pages: `template` gives the
     * page size and where the slide box sits ({ canvas, width, height, slideRect }).
     */
    function renderPage(template, style, slideWidth) {
        const canvas = document.createElement('canvas');
        canvas.width = template.canvas.width;
        canvas.height = template.canvas.height;
        const k = canvas.width / template.width;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const rect = template.slideRect;
        const step = SPACING * (rect.width / (slideWidth || rect.width)) * k;
        if (style === 'grid' || style === 'lines') {
            ctx.fillStyle = 'rgba(29, 27, 23, 0.09)';
            const ox = (rect.x * k) % step;
            const oy = (rect.y * k) % step;
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
    }

    window.QuartoInkWhiteboard = {
        STYLES, pages, keyOf, current, currentKey, add, enter, leave, setStyle, remove,
        handleNavigate, onSlideChange, render, renderPage,
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
