/*
 * Quarto Ink: search across the slides of the open deck.
 *
 * The text comes from the deck's HTML (every slide, also tab panes that are not shown;
 * speaker notes left out) and from the text notes written on the slides with the Text tool.
 * The search box sits at the top of the slide navigator, which then lists only the matching
 * slides with a snippet; Enter goes to the first match. Cmd/Ctrl+F opens it.
 */
(function () {
    'use strict';

    const SNIPPET_RADIUS = 38; // characters around a match
    const HIDDEN = 'script, style, template, noscript, aside.notes, .notes';

    let cache = { hash: null, texts: new Map() };

    /** Lower case without accents, so "goren" finds "Gören". Keeps the string length. */
    function fold(text) {
        return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().normalize('NFC');
    }

    function textOf(el) {
        const copy = el.cloneNode(true);
        copy.querySelectorAll(HIDDEN).forEach((n) => n.remove());
        // A nested vertical slide belongs to its own entry.
        copy.querySelectorAll('section').forEach((n) => n.remove());
        return (copy.textContent || '').replace(/\s+/g, ' ').trim();
    }

    /** Text of every slide of the open deck, by slide key ("h-v"); parsed once per deck. */
    function slideTexts() {
        const hash = state.currentFileHash || state.currentFileName || '';
        if (cache.hash === hash) return cache.texts;
        const texts = new Map();
        try {
            const doc = new DOMParser().parseFromString(state.htmlContent || '', 'text/html');
            const root = doc.querySelector('.slides');
            const top = root ? Array.from(root.children).filter((el) => el.tagName === 'SECTION') : [];
            top.forEach((section, h) => {
                const vertical = Array.from(section.children).filter((el) => el.tagName === 'SECTION');
                if (vertical.length) vertical.forEach((child, v) => texts.set(`${h}-${v}`, textOf(child)));
                else texts.set(`${h}-0`, textOf(section));
            });
        } catch (_e) {}
        cache = { hash, texts };
        return texts;
    }

    /** Text notes written on a slide (any of its tabs) with the Text tool. */
    function noteText(slideKey) {
        const parts = [];
        for (const [key, raw] of state.excalidrawScenes || []) {
            if (key !== slideKey && !key.startsWith(`${slideKey}::`)) continue;
            try {
                const scene = typeof raw === 'string' ? JSON.parse(raw) : raw;
                (scene.elements || []).forEach((e) => {
                    if (e.type === 'text' && !e.isDeleted && e.text) parts.push(e.text);
                });
            } catch (_e) {}
        }
        return parts.join(' ').replace(/\s+/g, ' ').trim();
    }

    function snippet(text, at, length) {
        const start = Math.max(0, at - SNIPPET_RADIUS);
        const end = Math.min(text.length, at + length + SNIPPET_RADIUS);
        return {
            before: (start > 0 ? '…' : '') + text.slice(start, at),
            match: text.slice(at, at + length),
            after: text.slice(at + length, end) + (end < text.length ? '…' : ''),
        };
    }

    /**
     * Slides matching `query`, in deck order: [{ slide, key, snippet, inNote }]. Title, slide
     * text and notes are searched; the snippet comes from where the match is.
     */
    function search(query) {
        const q = fold(query).trim();
        if (!q) return [];
        const texts = slideTexts();
        const results = [];
        for (const slide of state.slides || []) {
            const key = `${slide.h}-${slide.v || 0}`;
            const sources = [
                { text: texts.get(key) || slide.title || '', inNote: false },
                { text: noteText(key), inNote: true },
            ];
            for (const source of sources) {
                const at = fold(source.text).indexOf(q);
                if (at === -1) continue;
                results.push({ slide, key, snippet: snippet(source.text, at, q.length), inNote: source.inNote });
                break;
            }
        }
        return results;
    }

    // --- Navigator ----------------------------------------------------------------

    function input() {
        return document.getElementById('qi-slide-search');
    }

    function query() {
        const el = input();
        return el ? el.value : '';
    }

    function setCount(text) {
        const el = document.getElementById('qi-slide-search-count');
        if (el) el.textContent = text;
    }

    /**
     * Fill the navigator list with the search results. Returns false while there is no query,
     * so the navigator shows all slides as usual.
     */
    function renderResults(list) {
        const q = query().trim();
        if (!q) {
            setCount('');
            return false;
        }
        const results = search(q);
        setCount(results.length === 1 ? '1 slide' : `${results.length} slides`);
        list.innerHTML = '';
        if (!results.length) {
            const empty = document.createElement('div');
            empty.className = 'qi-search-empty';
            empty.textContent = 'No slide contains this text.';
            list.appendChild(empty);
            return true;
        }
        results.forEach(({ slide, key, snippet: s, inNote }) => {
            const item = document.createElement('div');
            item.className = 'sidebar-item qi-search-result' + (key === state.currentSlide ? ' active' : '');
            const num = document.createElement('div');
            num.className = 'sidebar-slide-num';
            num.textContent = slide.v ? `${slide.h + 1}.${slide.v}` : `${slide.h + 1}`;
            const info = document.createElement('div');
            info.className = 'sidebar-slide-info';
            const title = document.createElement('div');
            title.className = 'sidebar-slide-title';
            title.textContent = slide.title || 'Untitled Slide';
            const text = document.createElement('div');
            text.className = 'qi-search-snippet';
            if (inNote) {
                const tag = document.createElement('span');
                tag.className = 'qi-search-note';
                tag.textContent = 'note';
                text.appendChild(tag);
            }
            const mark = document.createElement('mark');
            mark.textContent = s.match;
            text.append(s.before, mark, s.after);
            info.append(title, text);
            item.append(num, info);
            item.onclick = () => goToSlide(slide);
            list.appendChild(item);
        });
        return true;
    }

    function openNavigator() {
        if (!state.isSidebarOpen) {
            const toggle = document.getElementById('btn-sidebar-toggle');
            if (toggle) toggle.click();
        }
        const el = input();
        if (el) {
            setTimeout(() => {
                el.focus();
                el.select();
            }, 30);
        }
    }

    function init() {
        const el = input();
        if (!el) return;
        el.addEventListener('input', () => updateSidebar());
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const first = search(el.value)[0];
                if (first) goToSlide(first.slide);
            } else if (e.key === 'Escape') {
                e.stopPropagation();
                if (el.value) {
                    el.value = '';
                    updateSidebar();
                } else {
                    el.blur();
                }
            }
        });
    }

    window.QuartoInkSearch = { search, renderResults, openNavigator };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
