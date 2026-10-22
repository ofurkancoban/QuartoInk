/*
 * Quarto Ink: the audience window, presenter side.
 *
 * The toolbar button opens audience.html in a second window (for a projector). This keeps it
 * on the presenter's deck, slide, fragment, tab and blank page, and streams the ink: images of
 * the drawing layers, a few times a second and smoothly while drawing, transferred without a
 * copy. The audience view (assets/ui/quarto-ink-audience-view.js) fits them onto its slide.
 */
(function () {
    'use strict';

    const IDLE_MS = 250; // ink image interval while nothing is drawn
    const ACTIVE_MS = 33; // while the pointer moves on the slide
    const ACTIVE_WINDOW_MS = 400;

    let popup = null;
    let timer = null;
    let lastDeck = null;
    let lastSlide = null;
    let lastInkAt = 0;
    let lastPointerAt = 0;
    let capturing = false;

    const isOpen = () => !!popup && !popup.closed;

    function send(message, transfer) {
        if (!isOpen()) return;
        try { popup.postMessage(message, location.origin, transfer || []); } catch (_e) {}
    }

    function syncButton() {
        const btn = document.getElementById('btn-audience');
        if (!btn) return;
        btn.classList.toggle('active', isOpen());
        btn.setAttribute('aria-pressed', isOpen() ? 'true' : 'false');
    }

    function deckSrc() {
        const frame = document.getElementById('content-frame');
        return frame ? (frame.getAttribute('src') || '') : '';
    }

    function slideState() {
        const [h, v] = String(state.currentSlide || '0-0').split('-').map((n) => parseInt(n, 10) || 0);
        const board = window.QuartoInkWhiteboard && window.QuartoInkWhiteboard.current();
        return {
            type: 'qi-audience-slide',
            h,
            v,
            f: typeof state.currentFragment === 'number' ? state.currentFragment : undefined,
            scope: state.currentTabScope || '',
            whiteboard: board ? { style: board.page.style } : null,
        };
    }

    /** Images of every drawing layer of the stage, as one bitmap the size of the stage. */
    async function captureInk() {
        const stage = document.getElementById('editor-stage');
        if (!stage) return null;
        const sr = stage.getBoundingClientRect();
        if (!(sr.width > 0 && sr.height > 0)) return null;
        const dpr = window.devicePixelRatio || 1;
        const out = document.createElement('canvas');
        out.width = Math.round(sr.width * dpr);
        out.height = Math.round(sr.height * dpr);
        const ctx = out.getContext('2d');
        stage.querySelectorAll('canvas').forEach((c) => {
            if (c.id === 'zoomple-lens-canvas' || c.closest('#zoomple-lens')) return;
            const r = c.getBoundingClientRect();
            if (!(r.width > 0 && r.height > 0) || getComputedStyle(c).visibility === 'hidden' || c.offsetParent === null) return;
            try {
                ctx.drawImage(c, (r.left - sr.left) * dpr, (r.top - sr.top) * dpr, r.width * dpr, r.height * dpr);
            } catch (_e) {}
        });
        const bitmap = await createImageBitmap(out);
        const box = state.slidesBox || state.slideMetrics;
        return { bitmap, box: { x: box.x, y: box.y, width: box.width, height: box.height }, stage: { width: sr.width, height: sr.height } };
    }

    async function tick() {
        if (!isOpen()) {
            stop();
            return;
        }
        const src = deckSrc();
        if (src && src !== lastDeck) {
            lastDeck = src;
            lastSlide = null;
            send({ type: 'qi-audience-deck', src });
        }
        const slide = slideState();
        const key = JSON.stringify(slide);
        if (key !== lastSlide) {
            lastSlide = key;
            send(slide);
        }
        const now = performance.now();
        const active = now - lastPointerAt < ACTIVE_WINDOW_MS;
        if (!capturing && now - lastInkAt >= (active ? ACTIVE_MS : IDLE_MS)) {
            capturing = true;
            lastInkAt = now;
            try {
                const ink = await captureInk();
                if (ink) send({ type: 'qi-audience-ink', ...ink }, [ink.bitmap]);
            } catch (_e) {
            } finally {
                capturing = false;
            }
        }
    }

    function start() {
        if (timer) return;
        lastDeck = null;
        lastSlide = null;
        timer = setInterval(() => { void tick(); }, ACTIVE_MS);
        syncButton();
    }

    function stop() {
        clearInterval(timer);
        timer = null;
        syncButton();
    }

    function open() {
        if (isOpen()) {
            popup.focus();
            return;
        }
        popup = window.open('audience.html', 'quarto-ink-audience', 'popup,width=1280,height=760');
        if (!popup) {
            qiAlert('Audience window blocked', 'Allow pop-ups for this site to open the audience window.');
            return;
        }
        start();
    }

    window.addEventListener('message', (e) => {
        if (!isOpen() || e.source !== popup || e.origin !== location.origin || !e.data) return;
        if (e.data.type === 'qi-audience-ready') {
            lastDeck = null;
            lastSlide = null;
            start();
        } else if (e.data.type === 'qi-audience-nav' && (e.data.dir === 'Next' || e.data.dir === 'Prev')) {
            navigateSlide(e.data.dir);
        }
    });

    // Draw smoothly in the audience window while the pointer moves on the slide.
    document.addEventListener('pointermove', (e) => {
        if (timer && e.target && e.target.closest && e.target.closest('#editor-stage')) lastPointerAt = performance.now();
    }, true);

    function init() {
        const btn = document.getElementById('btn-audience');
        if (btn) btn.addEventListener('click', open);
    }

    window.QuartoInkAudience = { open, isOpen };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
