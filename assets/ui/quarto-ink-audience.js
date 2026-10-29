/*
 * Quarto Ink: the audience window, presenter side.
 *
 * The toolbar button opens audience.html in a second window (for a projector). This keeps it
 * on the presenter's deck, slide, fragment, tab and blank page, and streams the ink: images of
 * the drawing layers, a few times a second and smoothly while drawing, transferred without a
 * copy. The audience view (assets/ui/quarto-ink-audience-view.js) fits them onto its slide.
 * The laser and the magnifier lens are not drawing layers (Excalidraw draws the laser as SVG,
 * the lens is a second copy of the deck), so their pointer positions are sent instead, in slide
 * units, and the audience view draws them itself.
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
    let laserPoints = []; // { u, v, start } in slide units, waiting for the next tick
    let lastLens = null;

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
        const wb = window.QuartoInkWhiteboard;
        const board = wb && wb.current();
        let whiteboard = null;
        if (board) {
            // Where the zoomed and panned page's lines start, in slide widths from the slide's corner.
            const cam = wb.camera();
            const m = state.slidesBox || state.slideMetrics || { x: 0, y: 0, width: 1 };
            const w = m.width || 1;
            whiteboard = {
                style: board.page.style,
                zoom: cam.zoom,
                dx: ((m.x + cam.scrollX) * cam.zoom - m.x) / w,
                dy: ((m.y + cam.scrollY) * cam.zoom - m.y) / w,
            };
        }
        return {
            type: 'qi-audience-slide',
            h,
            v,
            f: typeof state.currentFragment === 'number' ? state.currentFragment : undefined,
            scope: state.currentTabScope || '',
            whiteboard,
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

    /** Client px -> slide units: x and y over the slide width, from the slide's top-left. */
    function toSlideUnits(clientX, clientY) {
        const stage = document.getElementById('editor-stage');
        const box = state.slidesBox || state.slideMetrics;
        if (!stage || !box || !(box.width > 0)) return null;
        const sr = stage.getBoundingClientRect();
        return { u: (clientX - sr.left - box.x) / box.width, v: (clientY - sr.top - box.y) / box.width };
    }

    function lensState() {
        const zoomple = typeof ZOOMPLE !== 'undefined' ? ZOOMPLE : null;
        const lens = document.getElementById('zoomple-lens');
        const box = state.slidesBox || state.slideMetrics;
        if (!zoomple || !zoomple.active || !lens || !lastPointer || !box || !(box.width > 0)) return { active: false };
        const p = toSlideUnits(lastPointer.x, lastPointer.y);
        if (!p) return { active: false };
        return { active: true, u: p.u, v: p.v, size: zoomple.LENS_SIZE / box.width, zoom: zoomple.ZOOM_FACTOR };
    }

    function sendPointers() {
        // A held laser keeps its head on the audience screen even when it does not move.
        if (laserDown && lastPointer && !laserPoints.length) {
            const p = toSlideUnits(lastPointer.x, lastPointer.y);
            if (p) laserPoints.push({ u: p.u, v: p.v, start: false });
        }
        if (laserPoints.length) {
            send({ type: 'qi-audience-laser', points: laserPoints });
            laserPoints = [];
        }
        const lens = lensState();
        const key = JSON.stringify(lens);
        if (key !== lastLens) {
            lastLens = key;
            send({ type: 'qi-audience-lens', ...lens });
        }
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
        sendPointers();
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
        lastLens = null;
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
            lastLens = null;
            start();
        } else if (e.data.type === 'qi-audience-nav' && (e.data.dir === 'Next' || e.data.dir === 'Prev')) {
            navigateSlide(e.data.dir);
        }
    });

    // Draw smoothly in the audience window while the pointer moves on the slide.
    let lastPointer = null;
    let laserDown = false;
    const onStage = (e) => !!(e.target && e.target.closest && e.target.closest('#editor-stage'));

    function addLaserPoint(e, start) {
        const p = toSlideUnits(e.clientX, e.clientY);
        if (p) laserPoints.push({ u: p.u, v: p.v, start: !!start });
    }

    document.addEventListener('pointermove', (e) => {
        if (!timer) return;
        lastPointer = { x: e.clientX, y: e.clientY };
        if (onStage(e)) lastPointerAt = performance.now();
        if (laserDown) {
            const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
            (events.length ? events : [e]).forEach((c) => addLaserPoint(c, false));
        }
    }, true);
    document.addEventListener('pointerdown', (e) => {
        if (!timer) return;
        lastPointer = { x: e.clientX, y: e.clientY };
        laserDown = state.tool === 'laser' && onStage(e);
        if (laserDown) addLaserPoint(e, true);
    }, true);
    const endLaser = () => { laserDown = false; };
    window.addEventListener('pointerup', endLaser, true);
    window.addEventListener('pointercancel', endLaser, true);

    // An iPad opens the window as one more tab and mirrors its own screen to a projector, so
    // there is no second screen to send it to: the button is hidden there. So is recording,
    // which iPad Safari cannot do (no screen capture).
    function isIPad() {
        const ua = navigator.userAgent || '';
        return /iPad/.test(ua) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1);
    }

    function hide(el) {
        if (!el) return;
        el.hidden = true;
        el.style.display = 'none';
    }

    function init() {
        const addPage = document.getElementById('btn-add-page');
        if (addPage) {
            addPage.addEventListener('click', () => {
                if (window.QuartoInkWhiteboard) window.QuartoInkWhiteboard.add();
            });
        }
        const btn = document.getElementById('btn-audience');
        if (!btn) return;
        if (isIPad()) {
            hide(btn);
            hide(document.getElementById('btn-record'));
            return;
        }
        btn.addEventListener('click', open);
    }

    window.QuartoInkAudience = { open, isOpen };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
