/*
 * Quarto Ink: offer to save the ink as a file before it is left behind.
 *
 * The ink is kept in the browser anyway, but only there. A deck counts as unsaved when it has
 * ink (strokes, text, notes or blank pages) that changed since it was last saved as a file: the
 * deck with its ink (.html) or a PDF with ink. Closing such a deck's tab asks first: save as
 * HTML, as PDF, both, or close without saving.
 *
 * Leaving the page (reload, closing the browser tab) can only use the browser's own "Leave
 * site?" warning: browsers do not let a page show its own dialog then. When the user stays,
 * the save dialog follows. iPad Safari shows no warning at all when a page is left.
 */
(function () {
    'use strict';

    const SAVED_KEY = 'gn_saved_ink_v1'; // storage key of a deck -> signature of its ink when saved

    // Open decks other than the visible one that were left with unsaved ink: doc id -> name.
    const unsavedOthers = new Map();
    let dialogOpen = false;

    function hash(text) {
        let h = 2166136261;
        for (let i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(36) + ':' + text.length;
    }

    /** A short signature of the visible deck's ink, or '' when it has none. */
    function signature() {
        if (!state.htmlContent) return '';
        try { if (window.QuartoInkExcalidraw && window.QuartoInkExcalidraw.flush) window.QuartoInkExcalidraw.flush(); } catch (_e) {}
        const parts = [];
        (state.excalidrawScenes || new Map()).forEach((raw, key) => {
            try {
                const scene = typeof raw === 'string' ? JSON.parse(raw) : raw;
                const live = ((scene && scene.elements) || []).filter((e) => !e.isDeleted).map((e) => `${e.id}.${e.version}`);
                if (live.length) parts.push(`${key}=${live.join(',')}`);
            } catch (_e) {}
        });
        (state.annotations || new Map()).forEach((list, key) => {
            if (list && list.length) parts.push(`${key}#${hash(JSON.stringify(list))}`);
        });
        (state.slideNotes || new Map()).forEach((text, key) => {
            if (text) parts.push(`${key}!${hash(String(text))}`);
        });
        (state.whiteboards || new Map()).forEach((pages, key) => {
            if (pages && pages.length) parts.push(`${key}+${pages.map((p) => `${p.id}.${p.style}`).join(',')}`);
        });
        return parts.length ? hash(parts.sort().join('|')) : '';
    }

    function readSaved() {
        try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '{}') || {}; } catch (_e) { return {}; }
    }

    function isUnsaved() {
        const sig = signature();
        return !!sig && readSaved()[getStorageKey()] !== sig;
    }

    /** Called after the visible deck's ink was saved as a file. */
    function markSaved() {
        const sig = signature();
        if (!sig) return;
        try {
            const saved = readSaved();
            saved[getStorageKey()] = sig;
            localStorage.setItem(SAVED_KEY, JSON.stringify(saved));
        } catch (_e) {}
    }

    function activeDoc() {
        const docs = window.QuartoInkDocs ? window.QuartoInkDocs.list() : [];
        return docs.find((d) => d.active) || null;
    }

    /** Called by the tabs before the visible deck changes or closes: remember if it was unsaved. */
    function noteActive() {
        const doc = activeDoc();
        if (!doc) return;
        if (isUnsaved()) unsavedOthers.set(doc.id, doc.name);
        else unsavedOthers.delete(doc.id);
    }

    function anyUnsaved() {
        if (isUnsaved()) return true;
        const open = new Set((window.QuartoInkDocs ? window.QuartoInkDocs.list() : []).filter((d) => !d.active).map((d) => d.id));
        return Array.from(unsavedOthers.keys()).some((id) => open.has(id));
    }

    /**
     * The save dialog. Resolves to 'html', 'pdf', 'both', 'discard' or 'cancel'.
     * `discardText` is null when there is nothing to discard (the user already chose to stay).
     */
    function ask(name, discardText) {
        return new Promise((resolve) => {
            dialogOpen = true;
            const previous = document.activeElement;
            const overlay = document.createElement('div');
            overlay.className = 'modal-overlay qi-dialog qi-leave-dialog';
            overlay.style.display = 'flex';
            const card = document.createElement('div');
            card.className = 'modal-content qi-dialog-card';
            card.setAttribute('role', 'alertdialog');
            card.setAttribute('aria-modal', 'true');
            card.setAttribute('aria-labelledby', 'qi-leave-title');
            card.setAttribute('aria-describedby', 'qi-leave-msg');
            const h = document.createElement('div');
            h.className = 'modal-header';
            h.id = 'qi-leave-title';
            h.textContent = 'Save your ink?';
            const p = document.createElement('p');
            p.className = 'qi-dialog-message';
            p.id = 'qi-leave-msg';
            p.textContent = `The ink on ${name || 'this presentation'} is only kept in this browser. Save it as a file to keep a copy.`;
            const saves = document.createElement('div');
            saves.className = 'qi-dialog-actions qi-leave-saves';
            const actions = document.createElement('div');
            actions.className = 'qi-dialog-actions';

            const close = (result) => {
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                dialogOpen = false;
                if (previous && typeof previous.focus === 'function') previous.focus();
                resolve(result);
            };
            const button = (parent, text, result, cls) => {
                const b = document.createElement('button');
                b.type = 'button';
                b.className = `qi-dialog-btn ${cls}`;
                b.dataset.leave = result;
                b.textContent = text;
                b.addEventListener('click', () => close(result));
                parent.appendChild(b);
                return b;
            };
            const first = button(saves, 'HTML', 'html', 'qi-dialog-ok');
            button(saves, 'PDF', 'pdf', 'qi-dialog-ok');
            button(saves, 'Both', 'both', 'qi-dialog-ok');
            button(actions, 'Cancel', 'cancel', 'qi-dialog-cancel');
            if (discardText) button(actions, discardText, 'discard', 'qi-dialog-cancel is-danger');

            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); close('cancel'); }
                else if (e.key === 'Tab') {
                    const all = card.querySelectorAll('button');
                    if (e.shiftKey && document.activeElement === all[0]) { e.preventDefault(); all[all.length - 1].focus(); }
                    else if (!e.shiftKey && document.activeElement === all[all.length - 1]) { e.preventDefault(); all[0].focus(); }
                }
                e.stopPropagation();
            };
            overlay.addEventListener('click', (e) => { if (e.target === overlay) close('cancel'); });
            card.append(h, p, saves, actions);
            overlay.appendChild(card);
            document.body.appendChild(overlay);
            document.addEventListener('keydown', onKey, true);
            first.focus();
        });
    }

    /** Save the visible deck as the user chose. Resolves true when everything chosen was saved. */
    async function save(choice) {
        if (choice === 'html' || choice === 'both') {
            if (!window.QuartoInkShare) return false;
            window.QuartoInkShare.download();
        }
        if (choice === 'pdf' || choice === 'both') {
            if (!window.QuartoInkExport) return false;
            const ok = await window.QuartoInkExport.exportPdf({ annotations: true });
            if (!ok) return false;
        }
        return true;
    }

    function waitFor(test, timeout) {
        return new Promise((resolve) => {
            const start = Date.now();
            const tick = () => {
                if (test()) resolve(true);
                else if (Date.now() - start > timeout) resolve(false);
                else setTimeout(tick, 100);
            };
            tick();
        });
    }

    /**
     * Before a deck's tab closes. Resolves true to close it. A deck in the background with unsaved
     * ink is shown first, as saving needs it on screen.
     */
    async function beforeClose(id) {
        if (dialogOpen) return false;
        const docs = window.QuartoInkDocs ? window.QuartoInkDocs.list() : [];
        const doc = docs.find((d) => d.id === id);
        if (!doc) return true;
        if (!doc.active) {
            if (!unsavedOthers.has(id)) return true;
            window.QuartoInkDocs.activate(id);
            const shown = await waitFor(() => {
                const now = activeDoc();
                return !!now && now.id === id && state.bridgeAlive && state.currentFileName === doc.name;
            }, 15000);
            if (!shown) return false;
        }
        if (!isUnsaved()) return true;
        const choice = await ask(doc.name, 'Close without saving');
        if (choice === 'cancel') return false;
        if (choice === 'discard') {
            unsavedOthers.delete(id);
            return true;
        }
        const saved = await save(choice);
        if (saved) unsavedOthers.delete(id);
        return saved;
    }

    window.addEventListener('beforeunload', (e) => {
        if (dialogOpen || !anyUnsaved()) return;
        e.preventDefault();
        e.returnValue = '';
        // Runs only if the user stays on the page: then offer to save.
        setTimeout(() => {
            if (dialogOpen || !isUnsaved()) return;
            const doc = activeDoc();
            ask(doc && doc.name, null).then((choice) => {
                if (choice !== 'cancel') void save(choice);
            });
        }, 300);
    });

    // A file saved from the export menu counts as saved too.
    window.addEventListener('quartoink:ink-saved', markSaved);

    window.QuartoInkLeave = { isUnsaved, anyUnsaved, markSaved, noteActive, beforeClose, ask };
})();
