/*
 * Quarto Ink: the user's own notes per slide.
 *
 * Notes are typed in the box at the bottom of the slide navigator, kept per slide (shared by
 * its tabs) in state.slideNotes and saved with the deck's ink (see stringifyAnnotationsPayload
 * in index.html). The slide search finds them, and the PDF export can add them below slides.
 */
(function () {
    'use strict';

    const SAVE_DELAY_MS = 400;
    let saveTimer = null;
    let shownKey = null;

    function box() {
        return document.getElementById('qi-slide-notes');
    }

    function noteFor(slideKey) {
        return (state.slideNotes && state.slideNotes.get(slideKey)) || '';
    }

    /** Show the note of the current slide (after a slide change or a deck switch). */
    function sync() {
        const el = box();
        if (!el) return;
        const key = state.currentSlide;
        const label = document.getElementById('qi-notes-slide');
        const slide = (state.slides || []).find((s) => `${s.h}-${s.v || 0}` === key);
        if (label) label.textContent = slide ? `slide ${slide.v ? `${slide.h + 1}.${slide.v}` : slide.h + 1}` : '';
        el.disabled = !state.htmlContent;
        // Keep what is being typed if only the list was refreshed.
        if (key === shownKey && document.activeElement === el) return;
        shownKey = key;
        el.value = noteFor(key);
    }

    function save() {
        clearTimeout(saveTimer);
        saveTimer = null;
        try { saveToLocalStorage(); } catch (_e) {}
    }

    function init() {
        const el = box();
        if (!el) return;
        el.addEventListener('input', () => {
            if (!state.slideNotes) state.slideNotes = new Map();
            const key = shownKey || state.currentSlide;
            const text = el.value;
            if (text.trim()) state.slideNotes.set(key, text);
            else state.slideNotes.delete(key);
            clearTimeout(saveTimer);
            saveTimer = setTimeout(save, SAVE_DELAY_MS);
            // The navigator marks slides with notes.
            const item = document.querySelector(`#annotation-list .sidebar-item[data-slide="${CSS.escape(key)}"]`);
            if (item) item.classList.toggle('has-note', !!text.trim());
        });
        el.addEventListener('blur', () => { if (saveTimer) save(); });
        sync();
    }

    window.QuartoInkNotes = { sync, noteFor };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
