/*
 * Quarto Ink: the audience window (audience.html), e.g. on a projector.
 *
 * It shows the presenter's deck (the same sandboxed copy, driven through its bridge like the
 * magnifier lens) and the presenter's ink, which arrives as images of the drawing layers
 * (assets/ui/quarto-ink-audience.js) and is fitted onto this window's slide area.
 * Only the window that opened it, from the same origin, can drive it.
 */
(function () {
    'use strict';

    const frame = document.getElementById('audience-frame');
    const sheet = document.getElementById('audience-sheet');
    const canvas = document.getElementById('audience-ink');
    const hint = document.getElementById('audience-hint');
    const SPACING = 40; // blank page grid, in slide px (as in quarto-ink-whiteboard.js)

    let target = null; // { h, v, f, scope, whiteboard }
    let slidesBox = null; // the deck's slide area, in this window's px
    let slideWidth = 0;
    let lastInk = null; // { bitmap, box, stage }

    const presenter = () => window.opener;

    function toPresenter(message) {
        try { presenter().postMessage(message, location.origin); } catch (_e) {}
    }

    function toDeck(message) {
        try { frame.contentWindow.postMessage(message, '*'); } catch (_e) {}
    }

    // --- Slide -------------------------------------------------------------------------

    function showTarget() {
        if (!target) return;
        const goto = { type: 'GOTO', h: target.h, v: target.v };
        if (typeof target.f === 'number') goto.f = target.f;
        toDeck(goto);
        if (target.scope) toDeck({ type: 'ACTIVATE_TAB_SCOPE', scope: target.scope });
        renderSheet();
    }

    function renderSheet() {
        const board = target && target.whiteboard;
        sheet.style.display = board ? 'block' : 'none';
        if (!board) return;
        const box = slidesBox || { x: 0, y: 0, width: window.innerWidth };
        const step = SPACING * (slideWidth ? box.width / slideWidth : 1);
        const line = 'rgba(29, 27, 23, 0.09)';
        if (board.style === 'grid') {
            sheet.style.backgroundImage = `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`;
            sheet.style.backgroundSize = `${step}px ${step}px`;
            sheet.style.backgroundPosition = `${box.x}px ${box.y}px`;
        } else if (board.style === 'lines') {
            sheet.style.backgroundImage = `linear-gradient(${line} 1px, transparent 1px)`;
            sheet.style.backgroundSize = `100% ${step}px`;
            sheet.style.backgroundPosition = `0 ${box.y}px`;
        } else {
            sheet.style.backgroundImage = 'none';
        }
    }

    // --- Ink -----------------------------------------------------------------------------

    /** Draw the presenter's drawing layers so their slide area lands on this one. */
    function drawInk() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(window.innerWidth * dpr);
        const h = Math.round(window.innerHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        const ctx = canvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        if (!lastInk || !slidesBox || !(lastInk.box.width > 0)) return;
        const s = slidesBox.width / lastInk.box.width;
        ctx.setTransform(s * dpr, 0, 0, s * dpr, (slidesBox.x - lastInk.box.x * s) * dpr, (slidesBox.y - lastInk.box.y * s) * dpr);
        ctx.drawImage(lastInk.bitmap, 0, 0, lastInk.stage.width, lastInk.stage.height);
    }

    // --- Messages ------------------------------------------------------------------------

    window.addEventListener('message', (e) => {
        const data = e.data;
        if (!data || typeof data.type !== 'string') return;

        if (e.source === presenter() && e.origin === location.origin) {
            if (data.type === 'qi-audience-deck' && typeof data.src === 'string') {
                if (frame.getAttribute('src') !== data.src) {
                    slidesBox = null;
                    frame.setAttribute('src', data.src);
                }
                document.body.classList.add('has-deck');
            } else if (data.type === 'qi-audience-slide') {
                target = { h: data.h | 0, v: data.v | 0, f: data.f, scope: data.scope || '', whiteboard: data.whiteboard || null };
                showTarget();
            } else if (data.type === 'qi-audience-ink' && data.bitmap) {
                if (lastInk && lastInk.bitmap && lastInk.bitmap.close) lastInk.bitmap.close();
                lastInk = { bitmap: data.bitmap, box: data.box, stage: data.stage };
                drawInk();
            }
            return;
        }

        if (e.source === frame.contentWindow) {
            if (data.type === 'METRICS_UPDATE') {
                if (data.slidesBox) slidesBox = data.slidesBox;
                if (data.computedSlideSize && data.computedSlideSize.width) slideWidth = data.computedSlideSize.width;
                renderSheet();
                drawInk();
            } else if (data.type === 'INIT_STATE' || data.type === 'BRIDGE_READY_FOR_FOCUS') {
                showTarget();
            } else if (data.type === 'SLIDE_CHANGED' && target
                && (data.indexh !== target.h || (data.indexv || 0) !== target.v)) {
                // The deck moved on its own: follow the presenter again.
                showTarget();
            }
        }
    });

    window.addEventListener('resize', () => {
        renderSheet();
        drawInk();
    });

    // A clicker or the arrow keys pressed here move the presentation in the main window.
    window.addEventListener('keydown', (e) => {
        const next = ['ArrowRight', 'ArrowDown', 'PageDown', ' '];
        const prev = ['ArrowLeft', 'ArrowUp', 'PageUp'];
        if (next.includes(e.key) || prev.includes(e.key)) {
            e.preventDefault();
            toPresenter({ type: 'qi-audience-nav', dir: next.includes(e.key) ? 'Next' : 'Prev' });
        }
    });

    document.addEventListener('click', () => {
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
            document.documentElement.requestFullscreen().catch(() => {});
        }
    });

    // Hide the hint and the cursor while nothing moves.
    let idleTimer = null;
    const wake = () => {
        document.body.classList.remove('idle');
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500);
    };
    document.addEventListener('mousemove', wake);
    wake();
    setTimeout(() => hint.classList.add('hidden'), 5000);

    toPresenter({ type: 'qi-audience-ready' });
})();
