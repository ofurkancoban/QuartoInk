/*
 * Quarto Ink: the audience window (audience.html), e.g. on a projector.
 *
 * It shows the presenter's deck (the same sandboxed copy, driven through its bridge like the
 * magnifier lens) and the presenter's ink, which arrives as images of the drawing layers
 * (assets/ui/quarto-ink-audience.js) and is fitted onto this window's slide area.
 * The laser trail and the magnifier lens arrive as pointer positions in slide units and are
 * drawn here: the trail on its own canvas, the lens with a second copy of the deck.
 * Only the window that opened it, from the same origin, can drive it.
 */
(function () {
    'use strict';

    const frame = document.getElementById('audience-frame');
    const sheet = document.getElementById('audience-sheet');
    const canvas = document.getElementById('audience-ink');
    const hint = document.getElementById('audience-hint');
    const laserCanvas = document.getElementById('audience-laser');
    const lensEl = document.getElementById('audience-lens');
    const lensFrame = document.getElementById('audience-lens-frame');
    const lensInk = document.getElementById('audience-lens-ink');
    const SPACING = 40; // blank page grid, in slide px (as in quarto-ink-whiteboard.js)
    const LASER_LIFE_MS = 1000; // a laser point fades out over this time
    const LASER_COLOR = '255, 0, 0'; // Excalidraw's laser red

    let target = null; // { h, v, f, scope, whiteboard }
    let slidesBox = null; // the deck's slide area, in this window's px
    let slideWidth = 0;
    let lastInk = null; // { bitmap, box, stage }
    let laserStrokes = []; // [[{ u, v, t }]]
    let laserRaf = null;
    let lens = { active: false }; // { active, u, v, size, zoom } from the presenter

    const presenter = () => window.opener;

    function toPresenter(message) {
        try { presenter().postMessage(message, location.origin); } catch (_e) {}
    }

    function toDeck(message) {
        try { frame.contentWindow.postMessage(message, '*'); } catch (_e) {}
    }

    // --- Slide -------------------------------------------------------------------------

    function targetMessages() {
        if (!target) return [];
        const goto = { type: 'GOTO', h: target.h, v: target.v };
        if (typeof target.f === 'number') goto.f = target.f;
        return target.scope ? [goto, { type: 'ACTIVATE_TAB_SCOPE', scope: target.scope }] : [goto];
    }

    function showTarget() {
        if (!target) return;
        targetMessages().forEach(toDeck);
        syncLensDeck();
        renderSheet();
    }

    /** Slide units (fractions of the slide width, from its top-left) -> this window's px. */
    function fromSlideUnits(u, v) {
        if (!slidesBox || !(slidesBox.width > 0)) return null;
        return { x: slidesBox.x + u * slidesBox.width, y: slidesBox.y + v * slidesBox.width };
    }

    function renderSheet() {
        const board = target && target.whiteboard;
        sheet.style.display = board ? 'block' : 'none';
        if (!board) return;
        const box = slidesBox || { x: 0, y: 0, width: window.innerWidth };
        // The presenter may have zoomed and panned the page: the lines follow.
        const zoom = board.zoom || 1;
        const step = SPACING * (slideWidth ? box.width / slideWidth : 1) * zoom;
        const x = box.x + (board.dx || 0) * box.width;
        const y = box.y + (board.dy || 0) * box.width;
        const line = 'rgba(29, 27, 23, 0.09)';
        if (board.style === 'grid') {
            sheet.style.backgroundImage = `linear-gradient(${line} 1px, transparent 1px), linear-gradient(90deg, ${line} 1px, transparent 1px)`;
            sheet.style.backgroundSize = `${step}px ${step}px`;
            sheet.style.backgroundPosition = `${x}px ${y}px`;
        } else if (board.style === 'lines') {
            sheet.style.backgroundImage = `linear-gradient(${line} 1px, transparent 1px)`;
            sheet.style.backgroundSize = `100% ${step}px`;
            sheet.style.backgroundPosition = `0 ${y}px`;
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

    // --- Laser ---------------------------------------------------------------------------

    function addLaser(points) {
        const now = performance.now();
        points.forEach((p) => {
            if (!Number.isFinite(p.u) || !Number.isFinite(p.v)) return;
            if (p.start || !laserStrokes.length) laserStrokes.push([]);
            laserStrokes[laserStrokes.length - 1].push({ u: p.u, v: p.v, t: now });
        });
        if (!laserRaf) laserRaf = requestAnimationFrame(drawLaser);
    }

    /** A glowing red trail that thins and fades with age, like the presenter's. */
    function drawLaser() {
        laserRaf = null;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.round(window.innerWidth * dpr);
        const h = Math.round(window.innerHeight * dpr);
        if (laserCanvas.width !== w || laserCanvas.height !== h) {
            laserCanvas.width = w;
            laserCanvas.height = h;
        }
        const ctx = laserCanvas.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
        const now = performance.now();
        laserStrokes = laserStrokes
            .map((stroke) => stroke.filter((p) => now - p.t < LASER_LIFE_MS))
            .filter((stroke) => stroke.length);
        const width = slidesBox ? Math.max(2.5, 5 * slidesBox.width / 1050) : 4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.shadowColor = `rgba(${LASER_COLOR}, 0.9)`;
        ctx.shadowBlur = width * 2.5;
        laserStrokes.forEach((stroke) => {
            for (let i = 0; i < stroke.length; i++) {
                const b = fromSlideUnits(stroke[i].u, stroke[i].v);
                const a = i > 0 ? fromSlideUnits(stroke[i - 1].u, stroke[i - 1].v) : b;
                if (!a || !b) continue;
                const life = 1 - (now - stroke[i].t) / LASER_LIFE_MS;
                ctx.globalAlpha = Math.max(0, life);
                ctx.strokeStyle = `rgb(${LASER_COLOR})`;
                ctx.lineWidth = width * (0.3 + 0.7 * life);
                ctx.beginPath();
                ctx.moveTo(a.x, a.y);
                ctx.lineTo(b.x + (a === b ? 0.01 : 0), b.y);
                ctx.stroke();
            }
        });
        ctx.globalAlpha = 1;
        if (laserStrokes.length) laserRaf = requestAnimationFrame(drawLaser);
    }

    // --- Magnifier lens ------------------------------------------------------------------

    function syncLensDeck() {
        if (!lensFrame.getAttribute('src') || !lensFrame.contentWindow) return;
        targetMessages().forEach((m) => {
            try { lensFrame.contentWindow.postMessage(m, '*'); } catch (_e) {}
        });
    }

    /** Same geometry as the presenter's lens: the pointed spot, zoomed, in a circle around it. */
    function renderLens() {
        const p = lens.active ? fromSlideUnits(lens.u, lens.v) : null;
        if (!p) {
            lensEl.classList.remove('visible');
            return;
        }
        // The lens loads the deck once, when it is first used, then follows the slide.
        const src = frame.getAttribute('src');
        if (src && lensFrame.getAttribute('src') !== src) lensFrame.setAttribute('src', src);
        const zoom = lens.zoom > 0 ? lens.zoom : 2;
        const size = Math.max(80, (lens.size > 0 ? lens.size : 0.24) * slidesBox.width);
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const half = size / 2;
        lensEl.style.width = size + 'px';
        lensEl.style.height = size + 'px';
        lensEl.style.left = Math.max(0, Math.min(vw - size, p.x - half)) + 'px';
        lensEl.style.top = Math.max(0, Math.min(vh - size, p.y - half)) + 'px';
        const left = -(p.x * zoom) + half;
        const top = -(p.y * zoom) + half;
        [lensFrame, lensInk].forEach((el) => {
            el.style.width = vw + 'px';
            el.style.height = vh + 'px';
            el.style.left = left + 'px';
            el.style.top = top + 'px';
            el.style.transform = `scale(${zoom})`;
        });
        if (lensInk.width !== canvas.width || lensInk.height !== canvas.height) {
            lensInk.width = canvas.width;
            lensInk.height = canvas.height;
        }
        const ctx = lensInk.getContext('2d');
        ctx.clearRect(0, 0, lensInk.width, lensInk.height);
        if (canvas.width && canvas.height) ctx.drawImage(canvas, 0, 0);
        lensEl.classList.add('visible');
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
                if (lens.active) renderLens();
            } else if (data.type === 'qi-audience-laser' && Array.isArray(data.points)) {
                addLaser(data.points);
            } else if (data.type === 'qi-audience-lens') {
                lens = data.active
                    ? { active: true, u: Number(data.u), v: Number(data.v), size: Number(data.size), zoom: Number(data.zoom) }
                    : { active: false };
                renderLens();
            }
            return;
        }

        if (e.source === lensFrame.contentWindow) {
            if (data.type === 'INIT_STATE' || data.type === 'BRIDGE_READY_FOR_FOCUS') syncLensDeck();
            return;
        }

        if (e.source === frame.contentWindow) {
            if (data.type === 'METRICS_UPDATE') {
                if (data.slidesBox) slidesBox = data.slidesBox;
                if (data.computedSlideSize && data.computedSlideSize.width) slideWidth = data.computedSlideSize.width;
                renderSheet();
                drawInk();
                renderLens();
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
        renderLens();
        if (laserStrokes.length && !laserRaf) laserRaf = requestAnimationFrame(drawLaser);
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
