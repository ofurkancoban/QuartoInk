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
    const problems = []; // errors and Excalidraw mounts, kept apart from the busy input list
    let panel = null;

    function describe(el) {
        if (!el || !el.tagName) return String(el);
        const id = el.id ? `#${el.id}` : '';
        const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
        return `${el.tagName.toLowerCase()}${id}${cls}`;
    }

    function note(text) {
        events.push(`${(performance.now() / 1000).toFixed(1)} ${text}`);
        if (events.length > 8) events.shift();
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

    function problem(text) {
        problems.push(`${(performance.now() / 1000).toFixed(1)} ${String(text).slice(0, 160)}`);
        if (problems.length > 6) problems.shift();
    }
    window.addEventListener('error', (e) => problem(`error: ${e.message || (e.error && e.error.message) || e}`));
    window.addEventListener('unhandledrejection', (e) => problem(`rejection: ${(e.reason && e.reason.message) || e.reason}`));
    ['error', 'warn'].forEach((level) => {
        const original = console[level];
        console[level] = function (...args) {
            try { problem(`${level}: ${args.map((a) => (a && a.message) || String(a)).join(' ')}`); } catch (_e) {}
            return original.apply(this, args);
        };
    });

    /** Note each Excalidraw mount and whether its API arrived (the bundle loads late). */
    function watchMounts() {
        const excal = window.QuartoInkExcalidraw;
        if (!excal || excal.__qiDebugWrapped) return;
        excal.__qiDebugWrapped = true;
        const mount = excal.mount;
        excal.mount = function (host, props) {
            const key = props && props.slideKey;
            let result;
            try {
                result = mount.apply(this, arguments);
            } catch (e) {
                problem(`mount ${key} threw: ${e && e.message}`);
                throw e;
            }
            setTimeout(() => problem(`mount ${key}: api ${excal.getAPI() ? 'ok' : 'MISSING'} after 1s`), 1000);
            return result;
        };
    }

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
        watchMounts();
        panel.textContent = `${lines.join('\n')}\n-- problems\n${problems.join('\n') || 'none'}\n-- input\n${events.join('\n')}`;
    }

    function start() {
        render();
        setInterval(render, 400);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
