// Quarto Ink: several open presentations, switched with tabs.
//
// The app logic works on one presentation at a time: one `state`, and the iframe
// with id "content-frame". Each open deck gets its own iframe; switching tabs hides
// ("parks") the visible iframe, gives the target iframe the "content-frame" id and
// asks its bridge to resend its state, so a deck that was already open appears
// instantly, on the same slide and Quarto tab. Annotations are stored per file name
// in localStorage, so the outgoing deck is saved and the incoming one is loaded.
//
// To bound memory, at most MAX_LIVE_FRAMES decks stay loaded. When a deck's iframe
// is released it is reloaded through the normal `processFileContent` path on its
// next activation and returns to the slide it was left on.
//
// The open decks and the tab session (order, active tab, last slides) are kept in
// IndexedDB (assets/ui/quarto-ink-store.js), so a reload brings the same tabs back.
// Restored decks are read from storage only when their tab is first shown.
(function () {
    'use strict';

    const MAX_LIVE_FRAMES = 4;

    const originalProcess = window.processFileContent;
    if (typeof originalProcess !== 'function') return;

    /**
     * @typedef {{id: number, name: string, size: number, content: string, file: object,
     *   slide: ?{h: number, v: number}, slideLabel: string, frame: ?HTMLIFrameElement,
     *   blobUrl: ?string, htmlContent: string, slides: Array, lastUsed: number,
     *   resynced: boolean, blob: ?Blob}} Doc
     */
    /** @type {Doc[]} */
    const docs = [];
    let activeId = null;
    let nextId = 1;
    let switching = false;
    let restoreTimer = null;

    const bar = document.getElementById('qi-doc-tabs');
    const list = bar && bar.querySelector('.qi-doc-tablist');
    const addBtn = document.getElementById('qi-doc-add');

    function findDoc(id) {
        return docs.find((d) => d.id === id) || null;
    }

    function isPresentation(content) {
        return typeof isQuartoOrRevealPresentationHtml !== 'function' || isQuartoOrRevealPresentationHtml(content);
    }

    function fingerprint(content) {
        return typeof qiContentFingerprint === 'function' && content ? qiContentFingerprint(content) : '';
    }

    function fileInfo(file, content) {
        return {
            name: (file && file.name) || 'presentation.html',
            size: (file && typeof file.size === 'number') ? file.size : -1,
            hash: fingerprint(content),
        };
    }

    /** Same file: same name and, when known, the same content fingerprint (else the same size). */
    function sameFile(doc, info) {
        if (doc.name !== info.name) return false;
        if (doc.hash && info.hash) return doc.hash === info.hash;
        return doc.size === info.size || doc.size < 0 || info.size < 0;
    }

    function newDoc(info, content, file) {
        return {
            id: nextId++, name: info.name, size: info.size, hash: info.hash || '', content, file,
            slide: null, slideLabel: '', frame: null, blobUrl: null, htmlContent: '',
            slides: [], lastUsed: Date.now(), resynced: false, blob: null,
        };
    }

    // --- Session persistence -------------------------------------------------

    const store = window.QuartoInkStore || null;
    let sessionTimer = null;
    let restoring = false;

    function deckKey(doc) {
        return doc.name + '|' + doc.size;
    }

    /** Keep the deck's HTML for the next visit (stored once per opened file). */
    function persistDeck(doc) {
        if (!store || !doc.content) return;
        store.ready.then((ok) => {
            if (!ok) return;
            // The HTML as text: WebKit (Safari) fails to store Blobs in IndexedDB.
            return store.putDeck(deckKey(doc), {
                name: doc.name,
                size: doc.size,
                html: doc.content,
                savedAt: Date.now(),
            });
        }).catch((err) => {
            console.warn('[Tabs] Could not keep deck for the next session:', err);
            if (window.log) window.log(`${doc.name} will not be reopened next time (storage: ${(err && err.name) || 'error'}).`, 'warn');
        });
    }

    function forgetDeck(doc) {
        if (!store) return;
        store.ready.then((ok) => ok && store.deleteDeck(deckKey(doc))).catch(() => {});
    }

    function scheduleSessionSave() {
        if (!store || restoring) return;
        clearTimeout(sessionTimer);
        sessionTimer = setTimeout(() => {
            const active = findDoc(activeId);
            const meta = {
                order: docs.map(deckKey),
                active: active ? deckKey(active) : null,
                slides: Object.fromEntries(docs.map((d) => [deckKey(d), d.slide])),
                labels: Object.fromEntries(docs.map((d) => [deckKey(d), d.slideLabel])),
                scopes: Object.fromEntries(docs.map((d) => [deckKey(d), d.tabScope || ''])),
            };
            store.ready.then((ok) => ok && store.setMeta('session', meta)).catch(() => {});
        }, 250);
    }

    /** Restored decks keep only a Blob until their tab is first shown. */
    async function ensureContent(doc) {
        if (doc.content) return true;
        if (!doc.blob) return false;
        const status = document.getElementById('status-left');
        if (status) status.textContent = 'Opening ' + doc.name + '...';
        doc.content = await doc.blob.text();
        return true;
    }

    // --- Frames -------------------------------------------------------------

    function visibleFrame() {
        return document.getElementById('content-frame');
    }

    function createFrame() {
        const f = document.createElement('iframe');
        f.title = 'Presentation Viewer';
        // Same isolation as the first frame (QI_DECK_SANDBOX in index.html).
        f.setAttribute('sandbox', QI_DECK_SANDBOX);
        f.setAttribute('allow', 'fullscreen');
        const stage = document.getElementById('editor-stage');
        const overlay = document.getElementById('canvas-overlay');
        if (stage) stage.insertBefore(f, overlay || stage.firstChild);
        if (typeof attachPresentationFrameListeners === 'function') attachPresentationFrameListeners(f);
        return f;
    }

    /** Make `f` the frame the app works with. */
    function showFrame(f) {
        f.id = 'content-frame';
        f.classList.remove('qi-parked-frame');
        f.removeAttribute('aria-hidden');
        f.removeAttribute('tabindex');
        frame = f; // top-level binding of the main script
        state.ui.frame = f;
    }

    /** Hide the visible frame of `doc` and keep what is needed to show it again. */
    function park(doc) {
        const f = visibleFrame();
        if (!doc || !f || doc.frame !== f) return;
        doc.blobUrl = state.lastBlobUrl || doc.blobUrl;
        doc.htmlContent = state.htmlContent;
        doc.slides = Array.isArray(state.slides) ? state.slides.slice() : [];
        f.removeAttribute('id');
        f.classList.add('qi-parked-frame');
        f.setAttribute('aria-hidden', 'true');
        f.tabIndex = -1;
        state.lastBlobUrl = null;
    }

    function releaseFrame(doc) {
        if (doc.frame) {
            if (doc.frame === visibleFrame()) {
                doc.blobUrl = state.lastBlobUrl || doc.blobUrl;
                state.lastBlobUrl = null;
            }
            doc.frame.remove();
            doc.frame = null;
        }
        if (doc.blobUrl) {
            try { URL.revokeObjectURL(doc.blobUrl); } catch (_e) {}
            doc.blobUrl = null;
        }
    }

    /** Keep at most MAX_LIVE_FRAMES decks loaded; release the least recently used. */
    function enforceLiveLimit() {
        const live = docs.filter((d) => d.frame && d.id !== activeId).sort((a, b) => a.lastUsed - b.lastUsed);
        while (live.length + 1 > MAX_LIVE_FRAMES) releaseFrame(live.shift());
    }

    // --- State --------------------------------------------------------------

    /** Persist the active deck and remember where the user was. */
    function rememberActive() {
        const doc = findDoc(activeId);
        if (!doc || typeof state === 'undefined') return;
        try { flushExcalidrawSceneToStorageForCurrentKey(); } catch (_e) {}
        try { saveToLocalStorage(); } catch (_e) {}
        const m = /^(\d+)-(\d+)$/.exec(state.currentSlide || '');
        doc.slide = m ? { h: +m[1], v: +m[2] } : null;
        const idx = doc.slide && Array.isArray(state.slides)
            ? state.slides.findIndex((s) => s.h === doc.slide.h && (s.v || 0) === doc.slide.v)
            : -1;
        doc.slideLabel = idx >= 0 ? String(idx + 1) : '';
        doc.tabScope = state.currentTabScope || '';
        scheduleSessionSave();
    }

    /** Re-select the Quarto tabs (tabsets) the deck had open on its slide. */
    function restoreTabScope(doc) {
        if (!doc.tabScope) return;
        const scope = doc.tabScope;
        setTimeout(() => {
            if (activeId !== doc.id || state.currentTabScope === scope) return;
            try { doc.frame.contentWindow.postMessage({ type: 'ACTIVATE_TAB_SCOPE', scope }, qiTargetOrigin()); } catch (_e) {}
        }, 500);
    }

    /** After a fresh load, wait for the bridge and jump back to the deck's last slide and tab. */
    function restoreSlide(doc) {
        clearInterval(restoreTimer);
        const atStart = !doc.slide || (doc.slide.h === 0 && doc.slide.v === 0);
        if (atStart && !doc.tabScope) return;
        const target = doc.slide || { h: 0, v: 0 };
        const started = Date.now();
        restoreTimer = setInterval(() => {
            if (activeId !== doc.id || Date.now() - started > 60000) {
                clearInterval(restoreTimer);
                return;
            }
            if (!state.bridgeAlive || state.currentFileName !== doc.name) return;
            clearInterval(restoreTimer);
            const slide = (state.slides || []).find((s) => s.h === target.h && (s.v || 0) === target.v)
                || { h: target.h, v: target.v };
            // Give Reveal a moment to finish its own initial layout.
            setTimeout(() => {
                if (activeId !== doc.id) return;
                if (!atStart && typeof goToSlide === 'function') goToSlide(slide);
                restoreTabScope(doc);
            }, 350);
        }, 200);
    }

    function showEditor() {
        const ea = document.getElementById('editor-area');
        const dz = document.getElementById('drop-zone');
        if (dz) dz.style.display = 'none';
        if (ea) ea.style.display = 'flex';
    }

    /** Load `doc` into a new iframe through the app's normal loading path. */
    function loadFresh(doc, prev) {
        clearInterval(restoreTimer);
        if (prev && prev !== doc) park(prev);
        if (doc.frame) releaseFrame(doc);
        let f = visibleFrame();
        // Reuse the page's initial (unowned) frame; otherwise create one.
        if (!f || docs.some((d) => d.frame === f)) f = createFrame();
        showFrame(f);
        doc.frame = f;
        doc.resynced = false;
        state.lastBlobUrl = null; // the previous blob belongs to the parked deck
        switching = true;
        try {
            originalProcess.call(window, doc.content, doc.file);
        } finally {
            switching = false;
        }
        doc.blobUrl = state.lastBlobUrl;
        doc.hash = state.currentFileHash || doc.hash;
        enforceLiveLimit();
        restoreSlide(doc);
    }

    /** Show a deck whose iframe is still loaded: no reload, same slide and tab. */
    function showLive(doc, prev) {
        clearInterval(restoreTimer);
        if (prev && prev !== doc) park(prev);
        try { if (window.QuartoInkExcalidraw) window.QuartoInkExcalidraw.unmount(); } catch (_e) {}
        state.lastMountedSlideKey = null;
        showFrame(doc.frame);

        state.lastBlobUrl = doc.blobUrl;
        state.htmlContent = doc.htmlContent || doc.content;
        state.currentFileName = doc.name;
        state.currentFileHash = doc.hash || '';
        try { syncDocumentTitleBar(); } catch (_e) {}
        state.annotations.clear();
        state.excalidrawScenes = new Map();
        state.slideMetricsBySlide = new Map();
        state.history = [];
        state.redoStack = [];
        state.slides = doc.slides || [];
        state.slideCount = Math.max(state.slides.length, 1);
        if (doc.slide) state.currentSlide = `${doc.slide.h}-${doc.slide.v}`;
        try { loadFromLocalStorage(); } catch (_e) {}
        try { addToHistory(); } catch (_e) {}
        try { updateSidebar(); } catch (_e) {}
        showEditor();
        state.bridgeAlive = true;
        try { handleResize(); } catch (_e) {}

        // The bridge answers with INIT_STATE, which remounts the annotations for
        // the current slide and Quarto tab. Fall back to direct sync if it does not.
        doc.resynced = false;
        requestAnimationFrame(() => {
            try { doc.frame.contentWindow.postMessage({ type: 'RESYNC' }, qiTargetOrigin()); } catch (_e) {}
        });
        setTimeout(() => {
            if (activeId === doc.id && !doc.resynced && typeof syncPresentationStateFromFrame === 'function') {
                try { syncPresentationStateFromFrame(); } catch (_e) {}
            }
        }, 1500);
    }

    // Note when a deck's bridge has answered (used for the fallback above).
    window.addEventListener('message', (e) => {
        if (!e.data || e.data.type !== 'INIT_STATE') return;
        const doc = docs.find((d) => d.frame && d.frame.contentWindow === e.source);
        if (doc) doc.resynced = true;
    });

    /** Show `doc`: instantly if its iframe is loaded, otherwise load it. */
    async function showDoc(doc, prev) {
        if (doc.frame && doc.frame.isConnected) {
            showLive(doc, prev);
            return;
        }
        if (!doc.content) {
            try {
                if (!(await ensureContent(doc))) return;
            } catch (err) {
                if (window.log) window.log(`Could not reopen ${doc.name}: ${err && err.message}`, 'error');
                return;
            }
            if (activeId !== doc.id) return; // another tab was chosen meanwhile
        }
        loadFresh(doc, prev);
    }

    function activate(id) {
        if (id === activeId) return;
        const doc = findDoc(id);
        if (!doc) return;
        rememberActive();
        const prev = findDoc(activeId);
        activeId = id;
        doc.lastUsed = Date.now();
        render();
        return showDoc(doc, prev);
    }

    // Every load path (file picker, drop, programmatic) goes through here, so
    // each successfully opened presentation gets a tab and its own iframe.
    window.processFileContent = function (content, file) {
        if (switching || !isPresentation(content)) {
            return originalProcess.call(this, content, file);
        }
        rememberActive();
        const prev = findDoc(activeId);
        const info = fileInfo(file, content);
        let doc = docs.find((d) => sameFile(d, info));
        if (doc) {
            doc.content = content;
            doc.file = file;
        } else {
            doc = newDoc(info, content, file);
            docs.push(doc);
        }
        persistDeck(doc);
        activeId = doc.id;
        doc.lastUsed = Date.now();
        render();
        loadFresh(doc, prev);
    };

    /** No presentation left: go back to the landing page with one empty frame. */
    function showLanding() {
        clearInterval(restoreTimer);
        activeId = null;
        try { if (window.QuartoInkExcalidraw) window.QuartoInkExcalidraw.unmount(); } catch (_e) {}
        state.lastMountedSlideKey = null;
        showFrame(visibleFrame() || createFrame());
        state.lastBlobUrl = null;
        state.htmlContent = '';
        state.currentFileName = '';
        state.currentFileHash = '';
        state.bridgeAlive = false;
        state.annotations.clear();
        state.excalidrawScenes = new Map();
        state.slides = [];
        state.slideCount = 1;
        state.currentSlide = '0-0';
        const ea = document.getElementById('editor-area');
        const dz = document.getElementById('drop-zone');
        if (ea) ea.style.display = 'none';
        if (dz) dz.style.display = 'flex';
        const ind = document.getElementById('slide-indicator');
        if (ind) ind.style.display = 'none';
        const status = document.getElementById('status-left');
        if (status) status.textContent = 'Waiting for file...';
        try { syncDocumentTitleBar(); } catch (_e) {}
        try { updateSidebar(); } catch (_e) {}
    }

    function close(id) {
        const idx = docs.findIndex((d) => d.id === id);
        if (idx < 0) return;
        const doc = docs[idx];
        const wasActive = id === activeId;
        if (wasActive) {
            rememberActive();
            try { if (window.QuartoInkExcalidraw) window.QuartoInkExcalidraw.unmount(); } catch (_e) {}
        }
        releaseFrame(doc);
        forgetDeck(doc);
        docs.splice(idx, 1);
        if (!wasActive) {
            render();
            return;
        }
        activeId = null;
        const next = docs[idx] || docs[idx - 1];
        if (!next) {
            render();
            showLanding();
            return;
        }
        activeId = next.id;
        next.lastUsed = Date.now();
        render();
        showDoc(next, null);
    }

    function readFile(file) {
        if (typeof file.text === 'function') return file.text();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsText(file);
        });
    }

    /** Open one or more files: every valid deck gets a tab, the first new one is shown. */
    async function openFiles(files) {
        let first = null;
        for (const file of files) {
            let content;
            try {
                content = await readFile(file);
            } catch (err) {
                if (window.log) window.log(`File read error (${file.name}): ${err && err.message}`, 'error');
                continue;
            }
            if (!isPresentation(content)) {
                if (typeof showUnsupportedPresentationWarning === 'function') showUnsupportedPresentationWarning(file.name);
                continue;
            }
            // A deck saved with its ink (assets/ui/quarto-ink-share.js): the plain deck, and its ink restored.
            const shared = window.QuartoInkShare && window.QuartoInkShare.extract(content);
            if (shared) {
                content = shared.html;
                try { await window.QuartoInkShare.importInk(file.name, content, shared.annotations); } catch (_e) {}
            }
            if (file.size > 100 * 1024 * 1024 && window.log) {
                window.log(`Large file (over 100 MB): ${file.name} stays in memory while its tab is open.`, 'warn');
            }
            const info = fileInfo(file, content);
            let doc = docs.find((d) => sameFile(d, info));
            if (doc) {
                doc.content = content;
                doc.file = file;
                if (doc.id !== activeId) releaseFrame(doc); // reload with the fresh content when shown
            } else {
                doc = newDoc(info, content, file);
                docs.push(doc);
            }
            persistDeck(doc);
            if (!first) first = doc;
        }
        if (!first) {
            render();
            return;
        }
        if (first.id === activeId) {
            // Re-opened the visible deck: reload it with the fresh content.
            rememberActive();
            render();
            loadFresh(first, null);
        } else {
            activate(first.id);
        }
    }

    function render() {
        scheduleSessionSave();
        if (!bar || !list) return;
        bar.hidden = docs.length === 0;
        document.getElementById('main-view')?.classList.toggle('qi-has-doc-tabs', docs.length > 0);
        list.textContent = '';
        docs.forEach((doc, i) => {
            const active = doc.id === activeId;
            const tab = document.createElement('div');
            tab.className = 'qi-doc-tab' + (active ? ' is-active' : '');
            tab.setAttribute('role', 'presentation');
            tab.style.setProperty('--qi-tab-tilt', ((i % 3) - 1) * 0.6 + 'deg');

            const main = document.createElement('button');
            main.type = 'button';
            main.className = 'qi-doc-tab-main';
            main.setAttribute('role', 'tab');
            main.setAttribute('aria-selected', active ? 'true' : 'false');
            main.title = doc.name;
            const name = document.createElement('span');
            name.className = 'qi-doc-tab-name';
            name.textContent = doc.name.replace(/\.html?$/i, '');
            main.appendChild(name);
            if (!active && doc.slideLabel) {
                const where = document.createElement('span');
                where.className = 'qi-doc-tab-slide';
                where.textContent = doc.slideLabel;
                where.title = 'Last slide ' + doc.slideLabel;
                main.appendChild(where);
            }
            main.addEventListener('click', () => activate(doc.id));
            main.addEventListener('auxclick', (e) => { if (e.button === 1) close(doc.id); });

            const x = document.createElement('button');
            x.type = 'button';
            x.className = 'qi-doc-tab-close';
            x.setAttribute('aria-label', 'Close ' + doc.name);
            x.title = 'Close';
            x.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M7 7.5l9.5 9M16.5 7.2L7.2 16.8"/></svg>';
            x.addEventListener('click', (e) => { e.stopPropagation(); close(doc.id); });

            tab.appendChild(main);
            tab.appendChild(x);
            list.appendChild(tab);
            if (active) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        });
    }

    if (addBtn) {
        addBtn.addEventListener('click', () => {
            const input = document.getElementById('file-input');
            if (input) input.click();
        });
    }

    // Save the visible deck when the page is hidden or closed.
    window.addEventListener('pagehide', rememberActive);
    document.addEventListener('visibilitychange', () => { if (document.hidden) rememberActive(); });

    /** Reopen the tabs of the previous visit. */
    async function restoreSession() {
        if (!store) return;
        const ok = await store.ready;
        if (!ok || docs.length) return;
        let meta;
        try { meta = await store.getMeta('session'); } catch (_e) { return; }
        if (!meta || !Array.isArray(meta.order) || !meta.order.length || docs.length) return;
        restoring = true;
        try {
            for (const key of meta.order) {
                let rec;
                try { rec = await store.getDeck(key); } catch (_e) { rec = null; }
                // Older sessions stored a Blob, newer ones the HTML text.
                if (!rec || !(rec.blob || typeof rec.html === 'string') || docs.length >= 50) continue;
                const info = { name: rec.name, size: rec.size };
                const doc = newDoc(info, null, { name: rec.name, size: rec.size });
                doc.blob = rec.blob || new Blob([rec.html], { type: 'text/html' });
                doc.slide = (meta.slides && meta.slides[key]) || null;
                doc.slideLabel = (meta.labels && meta.labels[key]) || '';
                doc.tabScope = (meta.scopes && meta.scopes[key]) || '';
                docs.push(doc);
            }
        } finally {
            restoring = false;
        }
        if (!docs.length) return;
        const target = docs.find((d) => deckKey(d) === meta.active) || docs[0];
        activeId = target.id;
        render();
        if (window.log) window.log(`Restored ${docs.length} presentation tab(s) from the last session.`);
        showDoc(target, null);
    }

    restoreSession();

    window.QuartoInkDocs = {
        openFiles,
        activate,
        close,
        list: () => docs.map((d) => ({ id: d.id, name: d.name, active: d.id === activeId, slide: d.slide, live: !!d.frame })),
        /** The visible deck's HTML as opened (not the copy prepared for the frame). */
        activeContent: () => {
            const doc = findDoc(activeId);
            return doc ? doc.content : null;
        },
    };
})();
