// Quarto Ink "Atelier" UI layer: small behaviours that only enhance the existing
// interface. Everything here is optional; the app works without this file.
(function () {
    'use strict';

    // --- Slide ruler -------------------------------------------------------
    // Mirrors "#slide-indicator" (written by the app as "Slide: X / Y") into a
    // ruler in the status bar, and lets the user click or drag to jump.
    function initSlideRuler() {
        const ruler = document.getElementById('qi-slide-ruler');
        const indicator = document.getElementById('slide-indicator');
        if (!ruler || !indicator) return;
        const track = ruler.querySelector('.qi-ruler-track');

        const tip = document.createElement('div');
        tip.className = 'qi-ruler-tip';
        track.appendChild(tip);

        let current = 1;
        let total = 1;

        function render() {
            const m = /(\d+)\s*\/\s*(\d+)/.exec(indicator.textContent || '');
            const visible = indicator.style.display !== 'none' && !!m;
            if (m) {
                current = Math.max(1, parseInt(m[1], 10));
                total = Math.max(1, parseInt(m[2], 10));
            }
            const ready = visible && total > 1;
            ruler.classList.toggle('is-ready', ready);
            const steps = Math.max(total - 1, 1);
            ruler.style.setProperty('--qi-slides', String(steps));
            ruler.style.setProperty('--qi-progress', ((Math.min(current, total) - 1) / steps) * 100 + '%');
            ruler.setAttribute('aria-valuemax', String(total));
            ruler.setAttribute('aria-valuenow', String(current));
            ruler.setAttribute('aria-valuetext', 'Slide ' + current + ' of ' + total);
        }

        function slideList() {
            // `state` and `goToSlide` are top-level bindings of the main script.
            try {
                return (typeof state !== 'undefined' && Array.isArray(state.slides)) ? state.slides : [];
            } catch (_e) {
                return [];
            }
        }

        function indexAt(clientX) {
            const r = track.getBoundingClientRect();
            const t = Math.min(1, Math.max(0, (clientX - r.left) / Math.max(r.width, 1)));
            return { index: Math.round(t * (total - 1)), x: t * r.width };
        }

        function showTip(clientX) {
            const hit = indexAt(clientX);
            const slide = slideList()[hit.index];
            const title = slide && slide.title ? ' · ' + slide.title : '';
            tip.textContent = (hit.index + 1) + ' / ' + total + title;
            tip.style.left = hit.x + 'px';
        }

        function jump(clientX) {
            const slides = slideList();
            const slide = slides[indexAt(clientX).index];
            if (slide && typeof goToSlide === 'function') goToSlide(slide);
        }

        // On a tablet the ruler sits where the hand rests while writing: the Pencil never moves
        // the slide, and a finger only by a quick tap or a sideways drag, not while the Pencil
        // was just writing (the palm).
        const PALM_AFTER_PEN_MS = 1000;
        const TAP_MS = 400;
        const MOVE_PX = 10;
        let lastPenAt = 0;
        window.addEventListener('pointerdown', function (e) { if (e.pointerType === 'pen') lastPenAt = performance.now(); }, true);
        window.addEventListener('pointerup', function (e) { if (e.pointerType === 'pen') lastPenAt = performance.now(); }, true);

        let press = null; // { id, x, t, touch, dragging }
        let lastIndex = -1;
        ruler.addEventListener('pointerdown', function (e) {
            if (!ruler.classList.contains('is-ready')) return;
            if (e.pointerType === 'pen') return;
            const touch = e.pointerType === 'touch';
            if (touch && performance.now() - lastPenAt < PALM_AFTER_PEN_MS) return;
            press = { id: e.pointerId, x: e.clientX, t: performance.now(), touch: touch, dragging: !touch };
            lastIndex = indexAt(e.clientX).index;
            try { ruler.setPointerCapture(e.pointerId); } catch (_e) {}
            // A mouse jumps at once; a finger waits to show it meant to.
            if (!touch) jump(e.clientX);
        });
        ruler.addEventListener('pointermove', function (e) {
            if (e.pointerType !== 'pen') showTip(e.clientX);
            if (!press || e.pointerId !== press.id) return;
            if (!press.dragging) {
                // A resting palm hardly moves; a finger scrubbing the ruler moves sideways.
                if (Math.abs(e.clientX - press.x) < MOVE_PX) return;
                press.dragging = true;
            }
            const i = indexAt(e.clientX).index;
            if (i !== lastIndex) {
                lastIndex = i;
                jump(e.clientX);
            }
        });
        ruler.addEventListener('pointerup', function (e) {
            if (!press || e.pointerId !== press.id) return;
            const tap = press.touch && !press.dragging && performance.now() - press.t < TAP_MS;
            press = null;
            if (tap) jump(e.clientX);
        });
        ruler.addEventListener('pointercancel', function () { press = null; });

        new MutationObserver(render).observe(indicator, {
            childList: true,
            characterData: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style'],
        });
        render();
    }

    // --- Accessible state for toolbar toggles ----------------------------------
    // The app marks the current tool, colour and stroke width with the "active" class.
    // Mirror that into aria-pressed, and name colour swatches after their colour.
    const COLOR_NAMES = {
        '#000000': 'Black', '#e03131': 'Red', '#2f9e44': 'Green', '#1971c2': 'Blue', '#f08c00': 'Orange',
    };
    function colorName(hex) {
        const h = String(hex || '').toLowerCase();
        return COLOR_NAMES[h] || ('Color ' + h);
    }
    function syncToggle(el) {
        el.setAttribute('aria-pressed', el.classList.contains('active') ? 'true' : 'false');
        if (el.classList.contains('gn-color-swatch') && el.dataset.color) {
            const name = colorName(el.dataset.color);
            if (el.getAttribute('aria-label') !== name) {
                el.setAttribute('aria-label', name);
                el.title = name;
            }
        }
    }
    function initToggleSemantics() {
        const toggles = document.querySelectorAll('.gn-tool-btn, #btn-nav-mode, #btn-magic-snap, .gn-thickness-btn, button.gn-color-swatch');
        toggles.forEach(syncToggle);
        const observer = new MutationObserver((records) => {
            records.forEach((r) => syncToggle(r.target));
        });
        toggles.forEach((el) => observer.observe(el, { attributes: true, attributeFilter: ['class', 'data-color'] }));
    }

    // --- Excalidraw property panel tweaks --------------------------------------
    // Opacity is fixed per tool by the app (100, or 30 for the highlighter, which is also
    // how the highlighter is recognised), so the panel's opacity slider never had an effect:
    // hide it. For pen and highlighter, "Background" only fills strokes that close into a
    // loop (and shapes made with Ink to Shape), so label it accordingly.
    // Pen and highlighter: "Layers" (the order of selected shapes) has nothing to act on while
    // writing, so a thickness slider takes its place, for widths between the three presets.
    const THICKNESS_ID = 'qi-panel-thickness';
    function syncThicknessSlider(panel, freehand) {
        const layers = Array.from(panel.querySelectorAll('fieldset')).find((f) => {
            const legend = f.querySelector(':scope > legend, :scope > h3');
            return legend && legend.textContent.trim() === 'Layers';
        });
        if (layers) {
            if (freehand && layers.dataset.qiHidden !== '1') {
                layers.dataset.qiHidden = '1';
                layers.style.setProperty('display', 'none', 'important');
            } else if (!freehand && layers.dataset.qiHidden === '1') {
                delete layers.dataset.qiHidden;
                layers.style.removeProperty('display');
            }
        }
        let box = panel.querySelector('#' + THICKNESS_ID);
        const api = window.qiStrokeWidth;
        if (!freehand || !api) {
            if (box) box.remove();
            return;
        }
        if (!box) {
            box = document.createElement('fieldset');
            box.id = THICKNESS_ID;
            box.className = 'qi-panel-thickness';
            box.dataset.qiOwn = '1';
            box.innerHTML = '<legend>Thickness</legend>'
                + '<div class="qi-thickness-row">'
                + '<input type="range" id="stroke-width-slider" aria-label="Thickness">'
                + '<span id="thickness-val" class="qi-thickness-val" aria-hidden="true"></span>'
                + '</div>';
            const slider = box.querySelector('input');
            slider.addEventListener('input', () => api.set(parseFloat(slider.value)));
            // Arrow keys move the slider, not the slides.
            slider.addEventListener('keydown', (e) => e.stopPropagation());
            const column = (layers && layers.parentElement) || panel.querySelector('.panelColumn') || panel;
            column.insertBefore(box, layers ? layers.nextSibling : null);
        }
        const range = api.range();
        const slider = box.querySelector('input');
        slider.min = String(range.min);
        slider.max = String(range.max);
        slider.step = String(range.step);
        if (document.activeElement !== slider) slider.value = String(range.value);
        // Only when it changed: this runs from a MutationObserver on the panel.
        const label = box.querySelector('.qi-thickness-val');
        const text = (Math.round(range.value * 10) / 10) + ' pt';
        if (label.textContent !== text) label.textContent = text;
    }

    const FILL_LABEL = 'Fill (closed strokes)';
    const FILL_HINT = 'Fills the inside of a stroke that closes into a loop, and of shapes created with Ink to Shape.';
    function tweakPropertyPanel(host) {
        const panel = host.querySelector('.selected-shape-actions');
        if (!panel) return;
        panel.querySelectorAll('.range-input').forEach((input) => {
            const control = input.closest('.control-label');
            if (!control || control.dataset.qiHidden === '1') return;
            // The panel layout forces display:flex !important on every group; the marker makes it skip this one.
            control.dataset.qiHidden = '1';
            control.style.setProperty('display', 'none', 'important');
        });
        const tool = document.body.dataset.tool;
        const freehand = tool === 'pen' || tool === 'highlighter';
        syncThicknessSlider(panel, freehand);
        panel.querySelectorAll('h3').forEach((h) => {
            const text = h.textContent.trim();
            if (freehand && text === 'Background') {
                h.textContent = FILL_LABEL;
                h.title = FILL_HINT;
            } else if (!freehand && text === FILL_LABEL) {
                h.textContent = 'Background';
                h.removeAttribute('title');
            }
        });
    }
    function initPropertyPanelTweaks() {
        const host = document.getElementById('excalidraw-host');
        if (!host) return;
        let queued = false;
        const run = () => {
            queued = false;
            tweakPropertyPanel(host);
        };
        const schedule = () => {
            if (!queued) {
                queued = true;
                requestAnimationFrame(run);
            }
        };
        new MutationObserver(schedule).observe(host, { childList: true, subtree: true, characterData: true });
        new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['data-tool'] });
    }

    function init() {
        initSlideRuler();
        initToggleSemantics();
        initPropertyPanelTweaks();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
