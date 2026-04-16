/**
 * QuartoAnnotation – client-side annotation engine
 *
 * Architecture
 * ────────────
 * The presentation is rendered inside an <iframe>.  This module:
 *  1. Injects highlight CSS + selection listeners into the iframe.
 *  2. Shows a floating colour/annotate toolbar when text is selected.
 *  3. Opens a modal to capture a note.
 *  4. Sends annotations to the Flask API and re-renders highlights.
 *  5. Lets users edit / delete annotations from the sidebar.
 */

(function () {
  'use strict';

  /* ── Colour map ────────────────────────────────────────────────────────── */
  const DEFAULT_COLOR = 'yellow';
  const COLOR_HEX = {
    yellow: '#ffe066',
    green:  '#6ee7a0',
    blue:   '#93c5fd',
    pink:   '#f9a8d4',
    orange: '#fdba74',
  };

  /* ── State ─────────────────────────────────────────────────────────────── */
  let PRESENTATION_ID = null;
  let annotations      = [];
  let pendingRange     = null;   // Range in the iframe document
  let pendingColor     = DEFAULT_COLOR;
  let editingId        = null;   // Annotation being edited

  /* ════════════════════════════════════════════════════════════════════════
     Initialisation
  ═══════════════════════════════════════════════════════════════════════════ */

  function init(presentationId, initialAnnotations) {
    PRESENTATION_ID = presentationId;
    annotations     = initialAnnotations || [];

    // Wait for the iframe to be ready
    iframe.addEventListener('load', () => {
      injectStyles();
      injectSelectionListener();
      renderHighlights();
    });

    // If already loaded (cached)
    if (iframe.contentDocument && iframe.contentDocument.readyState === 'complete') {
      injectStyles();
      injectSelectionListener();
      renderHighlights();
    }

    wireToolbar();
    wireModal();
    renderSidebar();
  }

  /* ════════════════════════════════════════════════════════════════════════
     XPath helpers – used to create stable anchors across page loads
  ═══════════════════════════════════════════════════════════════════════════ */

  function xpathOf(node, root) {
    if (node === root) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = xpathOf(node.parentNode, root);
      const siblings = Array.from(node.parentNode.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE);
      const idx = siblings.indexOf(node) + 1;
      return `${parent}/text()[${idx}]`;
    }
    const tag = node.tagName.toLowerCase();
    const siblings = Array.from(node.parentNode.children)
      .filter(n => n.tagName.toLowerCase() === tag);
    const idx = siblings.indexOf(node) + 1;
    return `${xpathOf(node.parentNode, root)}/${tag}[${idx}]`;
  }

  function nodeByXpath(xpath, root) {
    try {
      const result = root.evaluate(
        xpath, root, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null
      );
      return result.singleNodeValue;
    } catch (_) {
      return null;
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Inject styles into iframe
  ═══════════════════════════════════════════════════════════════════════════ */

  function injectStyles() {
    const doc = iframe.contentDocument;
    if (!doc || doc.getElementById('qann-styles')) return;

    const style = doc.createElement('style');
    style.id = 'qann-styles';
    style.textContent = `
      .qann-highlight {
        border-radius: 3px;
        cursor: pointer;
        transition: filter .12s;
      }
      .qann-highlight:hover { filter: brightness(.88); }
      .qann-highlight[data-color="yellow"] { background: #ffe066; }
      .qann-highlight[data-color="green"]  { background: #6ee7a0; }
      .qann-highlight[data-color="blue"]   { background: #93c5fd; }
      .qann-highlight[data-color="pink"]   { background: #f9a8d4; }
      .qann-highlight[data-color="orange"] { background: #fdba74; }
      @keyframes qann-flash {
        0%   { filter: brightness(.7); }
        50%  { filter: brightness(.5); }
        100% { filter: brightness(.7); }
      }
      .qann-highlight.flash { animation: qann-flash .5s ease 2; }
    `;
    doc.head.appendChild(style);
  }

  /* ════════════════════════════════════════════════════════════════════════
     Listen for text selections inside the iframe
  ═══════════════════════════════════════════════════════════════════════════ */

  function injectSelectionListener() {
    const doc = iframe.contentDocument;
    if (!doc) return;

    doc.addEventListener('mouseup', onIframeMouseUp);
    doc.addEventListener('touchend', onIframeMouseUp);

    // Hide toolbar when clicking elsewhere
    doc.addEventListener('mousedown', e => {
      if (!e.target.closest('[data-ann-toolbar]')) {
        hideToolbar();
      }
    });
  }

  function onIframeMouseUp(e) {
    // Small delay so the selection is finalised
    setTimeout(() => {
      const sel = iframe.contentWindow.getSelection();
      if (!sel || sel.isCollapsed || sel.toString().trim() === '') {
        hideToolbar();
        return;
      }

      pendingRange = sel.getRangeAt(0).cloneRange();

      // Position the toolbar above the selection
      const rect = pendingRange.getBoundingClientRect();
      const iframeRect = iframe.getBoundingClientRect();

      const top  = iframeRect.top  + rect.top  - toolbar.offsetHeight - 10 + window.scrollY;
      const left = iframeRect.left + rect.left  + rect.width / 2 - toolbar.offsetWidth / 2 + window.scrollX;

      toolbar.style.top  = `${Math.max(4, top)}px`;
      toolbar.style.left = `${Math.max(4, left)}px`;
      toolbar.classList.add('visible');
    }, 10);
  }

  /* ════════════════════════════════════════════════════════════════════════
     Toolbar
  ═══════════════════════════════════════════════════════════════════════════ */

  function wireToolbar() {
    // Colour selection
    colorBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        colorBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        pendingColor = btn.dataset.color;
      });
    });

    // Set default active
    const defaultBtn = document.querySelector(`.toolbar-color-btn[data-color="${DEFAULT_COLOR}"]`);
    if (defaultBtn) defaultBtn.classList.add('active');

    // Annotate button
    annotateBtn.addEventListener('click', openCreateModal);

    // Prevent hiding toolbar when clicking inside it
    toolbar.addEventListener('mousedown', e => e.stopPropagation());
  }

  function hideToolbar() {
    toolbar.classList.remove('visible');
  }

  /* ════════════════════════════════════════════════════════════════════════
     Modal
  ═══════════════════════════════════════════════════════════════════════════ */

  function wireModal() {
    modalCancelBtn.addEventListener('click', closeModal);
    modalOverlay.addEventListener('click', e => {
      if (e.target === modalOverlay) closeModal();
    });
    modalSaveBtn.addEventListener('click', saveAnnotation);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeModal();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && modalOverlay.classList.contains('open')) {
        saveAnnotation();
      }
    });
  }

  function openCreateModal() {
    if (!pendingRange) return;
    editingId = null;

    const text = pendingRange.toString().trim();
    if (!text) return;

    modalExcerpt.textContent = text;
    modalTextarea.value = '';
    document.getElementById('ann-modal-title').textContent = 'Add Annotation';
    openModal();
    hideToolbar();
  }

  function openEditModal(ann) {
    editingId = ann.id;
    pendingColor = ann.color;
    // Sync active colour button
    colorBtns.forEach(b => b.classList.toggle('active', b.dataset.color === ann.color));

    modalExcerpt.textContent = ann.selected_text;
    modalTextarea.value = ann.note || '';
    document.getElementById('ann-modal-title').textContent = 'Edit Annotation';
    openModal();
  }

  function openModal() {
    modalOverlay.classList.add('open');
    setTimeout(() => modalTextarea.focus(), 80);
  }

  function closeModal() {
    modalOverlay.classList.remove('open');
    editingId = null;
    pendingRange = null;
    // Clear the iframe selection
    if (iframe.contentWindow) {
      try { iframe.contentWindow.getSelection().removeAllRanges(); } catch (_) {}
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Save / update annotation
  ═══════════════════════════════════════════════════════════════════════════ */

  async function saveAnnotation() {
    const note = modalTextarea.value.trim();

    if (editingId !== null) {
      // Update existing annotation
      try {
        const res = await fetch(`/api/annotations/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note, color: pendingColor }),
        });
        if (!res.ok) throw new Error('Update failed');
        const updated = await res.json();
        const idx = annotations.findIndex(a => a.id === editingId);
        if (idx >= 0) annotations[idx] = updated;
        closeModal();
        renderHighlights();
        renderSidebar();
      } catch (err) {
        console.error(err);
        alert('Failed to update annotation. Please try again.');
      }
      return;
    }

    // Create new annotation
    if (!pendingRange) return;

    const selectedText = pendingRange.toString().trim();
    if (!selectedText) return;

    const doc  = iframe.contentDocument;
    const root = doc.documentElement;

    let startXpath, startOffset, endXpath, endOffset;
    try {
      startXpath  = xpathOf(pendingRange.startContainer, root);
      startOffset = pendingRange.startOffset;
      endXpath    = xpathOf(pendingRange.endContainer, root);
      endOffset   = pendingRange.endOffset;
    } catch (err) {
      console.error('Failed to compute anchor:', err);
      closeModal();
      return;
    }

    const payload = {
      presentation_id:      PRESENTATION_ID,
      selected_text:        selectedText,
      note,
      color:                pendingColor,
      anchor_start_xpath:   startXpath,
      anchor_start_offset:  startOffset,
      anchor_end_xpath:     endXpath,
      anchor_end_offset:    endOffset,
    };

    try {
      const res = await fetch('/api/annotations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error('Save failed');
      const created = await res.json();
      annotations.push(created);
      closeModal();
      renderHighlights();
      renderSidebar();
    } catch (err) {
      console.error(err);
      alert('Failed to save annotation. Please try again.');
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Render highlights in the iframe
  ═══════════════════════════════════════════════════════════════════════════ */

  function renderHighlights() {
    const doc = iframe.contentDocument;
    if (!doc) return;

    // Remove existing highlights
    doc.querySelectorAll('.qann-highlight').forEach(el => {
      const parent = el.parentNode;
      while (el.firstChild) parent.insertBefore(el.firstChild, el);
      parent.removeChild(el);
      parent.normalize();
    });

    annotations.forEach(ann => {
      try {
        applyHighlight(doc, ann);
      } catch (err) {
        console.warn('Could not render highlight for annotation', ann.id, err);
      }
    });
  }

  function applyHighlight(doc, ann) {
    const root = doc.documentElement;
    const startNode = nodeByXpath(ann.anchor_start_xpath, doc);
    const endNode   = nodeByXpath(ann.anchor_end_xpath, doc);

    if (!startNode || !endNode) return;

    const range = doc.createRange();
    range.setStart(startNode, ann.anchor_start_offset);
    range.setEnd(endNode,   ann.anchor_end_offset);

    if (range.collapsed) return;

    const mark = doc.createElement('mark');
    mark.className = 'qann-highlight';
    mark.dataset.color = ann.color;
    mark.dataset.annId = ann.id;

    try {
      range.surroundContents(mark);
    } catch (_) {
      // Range spans multiple elements – fall back to extracting + wrapping
      const fragment = range.extractContents();
      mark.appendChild(fragment);
      range.insertNode(mark);
    }

    // Click on highlight → scroll sidebar card into view & flash
    mark.addEventListener('click', () => scrollToAnnotation(ann.id));
  }

  /* ════════════════════════════════════════════════════════════════════════
     Sidebar
  ═══════════════════════════════════════════════════════════════════════════ */

  function renderSidebar() {
    // Update count badge
    annCount.textContent = annotations.length;

    if (annotations.length === 0) {
      sidebarBody.innerHTML = `
        <div class="no-annotations">
          <div class="no-ann-icon">✏️</div>
          <p>Select any text in the presentation to add an annotation.</p>
        </div>`;
      return;
    }

    sidebarBody.innerHTML = '';
    annotations.forEach(ann => {
      const card = buildSidebarCard(ann);
      sidebarBody.appendChild(card);
    });
  }

  function buildSidebarCard(ann) {
    const card = document.createElement('div');
    card.className = 'ann-card';
    card.dataset.annId = ann.id;

    const dot = `<span class="ann-color-dot" style="background:${COLOR_HEX[ann.color] || COLOR_HEX[DEFAULT_COLOR]}"></span>`;
    const excerpt = escapeHtml(ann.selected_text.length > 100
      ? ann.selected_text.slice(0, 100) + '…'
      : ann.selected_text);
    const note = ann.note ? `<div class="ann-note">${escapeHtml(ann.note)}</div>` : '';
    const date = new Date(ann.created_at).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
    });

    card.innerHTML = `
      <div class="ann-excerpt">${dot}"${excerpt}"</div>
      ${note}
      <div class="ann-meta">
        <span>${date}</span>
        <div class="ann-card-actions">
          <button class="btn-icon edit-btn" title="Edit annotation" aria-label="Edit annotation" data-id="${ann.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
          </button>
          <button class="btn-icon delete-btn" title="Delete annotation" aria-label="Delete annotation" data-id="${ann.id}" style="color:#e74c3c">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
          </button>
        </div>
      </div>`;

    // Scroll-to on card click (but not on action buttons)
    card.addEventListener('click', e => {
      if (e.target.closest('.edit-btn') || e.target.closest('.delete-btn')) return;
      flashHighlight(ann.id);
    });

    card.querySelector('.edit-btn').addEventListener('click', () => openEditModal(ann));
    card.querySelector('.delete-btn').addEventListener('click', () => confirmDelete(ann.id));

    return card;
  }

  function scrollToAnnotation(annId) {
    const card = sidebarBody.querySelector(`[data-ann-id="${annId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      card.classList.add('selected');
      setTimeout(() => card.classList.remove('selected'), 1500);
    }
  }

  function flashHighlight(annId) {
    const doc = iframe.contentDocument;
    if (!doc) return;
    const el = doc.querySelector(`.qann-highlight[data-ann-id="${annId}"]`);
    if (el) {
      el.classList.remove('flash');
      // Force reflow
      void el.offsetWidth;
      el.classList.add('flash');
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Delete annotation
  ═══════════════════════════════════════════════════════════════════════════ */

  async function confirmDelete(annId) {
    if (!confirm('Delete this annotation?')) return;

    try {
      const res = await fetch(`/api/annotations/${annId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      annotations = annotations.filter(a => a.id !== annId);
      renderHighlights();
      renderSidebar();
    } catch (err) {
      console.error(err);
      alert('Failed to delete annotation. Please try again.');
    }
  }

  /* ════════════════════════════════════════════════════════════════════════
     Utilities
  ═══════════════════════════════════════════════════════════════════════════ */

  function escapeHtml(str) {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── Public API ────────────────────────────────────────────────────────── */
  window.QuartoAnnotation = { init };

})();
