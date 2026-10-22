// Quarto Ink storage: annotations, open presentations and the tab session in IndexedDB.
//
// localStorage is limited to about 5 MB per site, which annotated decks with images
// can exceed. IndexedDB has no such small limit. The app reads annotations
// synchronously, so all annotation records are loaded into memory once at startup
// (`ready`); reads come from that cache and writes go to IndexedDB in the background.
// Existing localStorage annotations are migrated on first run. If IndexedDB is not
// available (some private modes), everything falls back to localStorage.
(function () {
    'use strict';

    const DB_NAME = 'quarto-ink';
    const DB_VERSION = 1;
    const ANNOTATION_PREFIX = 'quarto_anns_';
    const FLUSH_DELAY_MS = 300;

    /** @type {Map<string, string>} */
    const cache = new Map();
    const pending = new Map();
    let db = null;
    let flushTimer = null;

    function req(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function done(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
        });
    }

    function openDb() {
        return new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('IndexedDB is not available'));
                return;
            }
            const open = indexedDB.open(DB_NAME, DB_VERSION);
            open.onupgradeneeded = () => {
                const d = open.result;
                for (const name of ['annotations', 'decks', 'meta']) {
                    if (!d.objectStoreNames.contains(name)) d.createObjectStore(name);
                }
            };
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
            open.onblocked = () => reject(new Error('IndexedDB open blocked'));
        });
    }

    function legacyAnnotationKeys() {
        const keys = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(ANNOTATION_PREFIX)) keys.push(k);
            }
        } catch (_e) {}
        return keys;
    }

    function reportWriteError(err) {
        console.warn('[Store] Saving annotations failed:', err);
        if (window.log) window.log(`Could not save annotations (${(err && err.name) || 'error'}). Export your work to keep it.`, 'error');
    }

    async function hydrate() {
        const tx = db.transaction('annotations', 'readonly');
        const store = tx.objectStore('annotations');
        const [keys, values] = await Promise.all([req(store.getAllKeys()), req(store.getAll())]);
        keys.forEach((k, i) => { if (!cache.has(k)) cache.set(String(k), values[i]); });

        // One-time migration from localStorage (frees its 5 MB quota).
        const legacy = legacyAnnotationKeys();
        if (legacy.length) {
            const wtx = db.transaction('annotations', 'readwrite');
            const ws = wtx.objectStore('annotations');
            for (const k of legacy) {
                const v = localStorage.getItem(k);
                if (v == null) continue;
                if (!cache.has(k)) cache.set(k, v);
                ws.put(cache.get(k), k);
            }
            await done(wtx);
            legacy.forEach((k) => { try { localStorage.removeItem(k); } catch (_e) {} });
        }
    }

    const ready = openDb()
        .then(async (d) => {
            db = d;
            await hydrate();
            return true;
        })
        .catch((err) => {
            console.warn('[Store] Falling back to localStorage:', err);
            db = null;
            return false;
        });

    async function flush() {
        clearTimeout(flushTimer);
        flushTimer = null;
        if (!db || pending.size === 0) return;
        const entries = Array.from(pending.entries());
        pending.clear();
        try {
            const tx = db.transaction('annotations', 'readwrite');
            const store = tx.objectStore('annotations');
            entries.forEach(([k, v]) => store.put(v, k));
            await done(tx);
        } catch (err) {
            reportWriteError(err);
        }
    }

    function getAnnotations(key) {
        if (cache.has(key)) return cache.get(key);
        try { return localStorage.getItem(key); } catch (_e) { return null; }
    }

    /** Throws only in localStorage fallback mode (e.g. QuotaExceededError), like before. */
    function setAnnotations(key, value) {
        cache.set(key, value);
        if (!db) {
            localStorage.setItem(key, value);
            return;
        }
        pending.set(key, value);
        if (document.visibilityState === 'hidden') {
            flush();
        } else if (!flushTimer) {
            flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
        }
    }

    function removeAnnotations(key) {
        cache.delete(key);
        pending.delete(key);
        try { localStorage.removeItem(key); } catch (_e) {}
        if (!db) return;
        try {
            const tx = db.transaction('annotations', 'readwrite');
            tx.objectStore('annotations').delete(key);
        } catch (err) {
            console.warn('[Store] Removing annotations failed:', err);
        }
    }

    // --- Open presentations and tab session ---------------------------------

    async function put(storeName, key, value) {
        if (!db) throw new Error('IndexedDB is not available');
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value, key);
        await done(tx);
    }

    async function get(storeName, key) {
        if (!db) return undefined;
        return req(db.transaction(storeName, 'readonly').objectStore(storeName).get(key));
    }

    async function remove(storeName, key) {
        if (!db) return;
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).delete(key);
        await done(tx);
    }

    async function clearAll() {
        cache.clear();
        pending.clear();
        legacyAnnotationKeys().forEach((k) => { try { localStorage.removeItem(k); } catch (_e) {} });
        if (!db) return;
        const tx = db.transaction(['annotations', 'decks', 'meta'], 'readwrite');
        ['annotations', 'decks', 'meta'].forEach((n) => tx.objectStore(n).clear());
        await done(tx);
    }

    // Write pending annotations before the page goes away.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
    window.addEventListener('pagehide', () => { flush(); });

    window.QuartoInkStore = {
        ready,
        get available() { return !!db; },
        getAnnotations,
        setAnnotations,
        removeAnnotations,
        flush,
        putDeck: (key, record) => put('decks', key, record),
        getDeck: (key) => get('decks', key),
        deleteDeck: (key) => remove('decks', key),
        setMeta: (key, value) => put('meta', key, value),
        getMeta: (key) => get('meta', key),
        clearAll,
    };
})();
