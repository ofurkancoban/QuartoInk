/*
 * Quarto Ink: an input diagnostics panel, only with ?debug=1 in the address.
 *
 * For problems seen on a device but not in the tests (an iPad and its Pencil): it shows where
 * pointer and touch input goes and the state that decides whether it draws. A screenshot of
 * the panel is the report. It takes no input itself (pointer-events: none).
 */
(function () {
    'use strict';

    if (!/[?&]debug=1(&|$)/.test(location.search)) return;

    const events = [];
    let panel = null;

    function describe(el) {
        if (!el || !el.tagName) return String(el);
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`;
    }

    function note(text) {
        events.push(`${(performance.now() / 1000).toFixed(1)} ${text}`);
        if (events.length > 12) events.shift();
    }

    // Seen first (capture) and last (bubble): whether it was stopped or prevented in between.
    ['pointerdown', 'pointerup', 'pointercancel'].forEach((type) => {
        let last = null;
        window.addEventListener(type, (e) => {
            const entry = { target: describe(e.target), bubbled: false };
            last = entry;
            setTimeout(() => {
                note(`${type} ${e.pointerType} ${entry.target}${entry.bubbled ? '' : ' stopped'}${e.defaultPrevented ? ' prevented' : ''}`);
            }, 0);
        }, true);
        window.addEventListener(type, () => { if (last) last.bubbled = true; });
    });
    window.addEventListener('touchstart', (e) => {
        const t = e.changedTouches && e.changedTouches[0];
        note(`touchstart ${t && t.touchType ? t.touchType : '?'} x${e.touches.length} ${describe(e.target)}`);
    }, true);

    function flag(name, value) {
        return `${name}: ${value === undefined ? '-' : (typeof value === 'object' && value !== null ? 'set' : String(value))}`;
    }

    function stateLines() {
        if (typeof state === 'undefined') return ['no state yet'];
        const host = document.getElementById('excalidraw-host');
        const canvases = host ? Array.from(host.querySelectorAll('canvas.excalidraw__canvas')) : [];
        const excal = window.QuartoInkExcalidraw;
        const api = excal && excal.getAPI ? excal.getAPI() : null;
        let app = null;
        try { app = api && api.getAppState(); } catch (_e) {}
        const box = host ? host.getBoundingClientRect() : null;
        const mid = box ? document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) : null;
        return [
            `file: ${state.currentFileName || '-'}  slide: ${state.currentSlide || '-'}  bridge: ${!!state.bridgeAlive}`,
            `${flag('drawing', state.isDrawingMode)}  ${flag('tool', state.tool)}  ${flag('engine', state.annotationEngine)}`,
            `${flag('blocked', state._fingerGestureBlocksExcalCanvas)}  ${flag('swipe', state._fingerSwipe)}  ${flag('touchSwipe', state._fingerSwipeTouch)}  ${flag('pinching', state._qiPinching)}  ${flag('dragging', state.isDragging)}`,
            `host: ${host ? `${getComputedStyle(host).display} pe=${getComputedStyle(host).pointerEvents} ${Math.round(box.width)}x${Math.round(box.height)}` : 'none'}  canvases: ${canvases.map((c) => c.style.pointerEvents || 'auto').join(',') || 'none'}`,
            `excalidraw: ${api ? `${app ? app.activeTool.type : '?'} view=${app && app.viewModeEnabled} pen=${app && app.penMode}/${app && app.penDetected} elements=${api.getSceneElements().length}` : 'not mounted'}`,
            `middle: ${describe(mid)}  focus: ${describe(document.activeElement)}`,
            `overlays: ${Array.from(document.querySelectorAll('.modal-overlay')).filter((o) => getComputedStyle(o).display !== 'none').map(describe).join(', ') || 'none'}`,
        ];
    }

    function render() {
        if (!panel) {
            panel = document.createElement('pre');
            panel.id = 'qi-debug-panel';
            Object.assign(panel.style, {
                position: 'fixed', left: '8px', bottom: '8px', zIndex: '2147483647', margin: '0',
                maxWidth: 'min(620px, calc(100vw - 16px))', padding: '8px 10px', borderRadius: '8px',
                background: 'rgba(0, 0, 0, 0.78)', color: '#d7ffd9', font: '11px/1.35 ui-monospace, Menlo, monospace',
                whiteSpace: 'pre-wrap', pointerEvents: 'none',
            });
            document.body.appendChild(panel);
        }
        let lines;
        try { lines = stateLines(); } catch (e) { lines = [`state error: ${e && e.message}`]; }
        panel.textContent = `${lines.join('\n')}\n--\n${events.join('\n')}`;
    }

    function start() {
        render();
        setInterval(render, 400);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
