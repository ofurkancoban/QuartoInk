// Source patches for the vendored html-to-image (the slide renderer of the PDF/PNG export).
// Applied while bundling it in scripts/build.mjs; each patch must match exactly once, so an
// html-to-image update that changes this code fails the build instead of silently losing a fix.

const CLONE_NODE = /html-to-image[\\/]es[\\/]clone-node\.js$/;

// Original style copy: every computed property, with font sizes shrunk (25.6px -> 24.9px).
const STYLE_COPY = `        getStyleProperties(options).forEach((name) => {
            let value = sourceStyle.getPropertyValue(name);
            if (name === 'font-size' && value.endsWith('px')) {
                const reducedFont = Math.floor(parseFloat(value.substring(0, value.length - 2))) - 0.1;
                value = \`\${reducedFont}px\`;
            }`;

// Patched: keeps font sizes as they are (the shrink changes where lines wrap) and, with
// options.qiCompactStyles, leaves out properties the copy would compute the same anyway.
const STYLE_COPY_PATCHED = `        const qiParent = options.qiCompactStyles && nativeNode !== options.qiRoot && nativeNode.parentElement
            ? window.getComputedStyle(nativeNode.parentElement)
            : null;
        const qiDefaults = qiParent ? qiDefaultStyle(nativeNode) : null;
        getStyleProperties(options).forEach((name) => {
            let value = sourceStyle.getPropertyValue(name);
            if (qiDefaults && qiSkipProperty(name, value, qiDefaults, qiParent, sourceStyle)) {
                return;
            }`;

const CLONE_STYLE_FN = 'function cloneCSSStyle(nativeNode, clonedNode, options) {';

// A property can be left out when the copy computes the same value without it:
// - it is the browser default for this tag (non-inherited properties) and the parent's value
//   (inherited ones), with no non-zero px length, since such defaults may scale with the font
//   size (UA margins of 1em are computed to px);
// - or it is a non-inherited colour that defaults to currentColor and equals the element's own
//   colour (inherited ones such as -webkit-text-fill-color must not be left out: the copy would
//   inherit the parent's written value instead of following its own colour);
// - or it is a custom property (inherited) with the parent's value. Decks define hundreds of
//   them, which otherwise made up most of every copied element.
// Border, outline and column-rule widths are always kept: they compute to 0px only while their
// style is none, so a solid border with width 0 would get the initial "medium" width instead.
const HELPERS = `// --- Quarto Ink: compact style copy --------------------------------------------
const qiDefaultStyles = new Map();
let qiDefaultsRoot = null;
const QI_SVG_NS = 'http://www.w3.org/2000/svg';
const QI_CURRENT_COLOR = /^(border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-color|outline-color|column-rule-color|rule-color|text-decoration-color)$/;
const QI_ALWAYS_COPY = /^(border(-(top|right|bottom|left|block|inline)(-(start|end))?)?-width|outline-width|column-rule-width|rule-width)$/;
function qiHasPxLength(value) {
    const lengths = value.match(/-?[\\d.]+px/g);
    return !!lengths && lengths.some((v) => parseFloat(v) !== 0);
}
function qiSkipProperty(name, value, defaults, parentStyle, ownStyle) {
    if (QI_ALWAYS_COPY.test(name)) return false;
    if (name.startsWith('--')) {
        return value === parentStyle.getPropertyValue(name);
    }
    if (QI_CURRENT_COLOR.test(name)) {
        return defaults[name] === defaults.color && value === ownStyle.getPropertyValue('color');
    }
    return value === defaults[name] && value === parentStyle.getPropertyValue(name) && !qiHasPxLength(value);
}
/**
 * Computed style of a bare element of the same kind, with only the browser's own styles: inside
 * a shadow root (the page's stylesheets do not reach it) whose host resets inherited values.
 * Not an empty iframe, which a sandboxed deck could not read (it gets an origin of its own).
 */
function qiDefaultStyle(node) {
    const ns = node.namespaceURI || '';
    const key = ns + ' ' + node.localName;
    let style = qiDefaultStyles.get(key);
    if (style) return style;
    const doc = node.ownerDocument;
    if (!qiDefaultsRoot || !qiDefaultsRoot.host.isConnected) {
        const host = doc.createElement('div');
        host.setAttribute('aria-hidden', 'true');
        host.style.cssText = 'all:initial;position:fixed;left:-10000px;top:0;width:10px;height:10px;visibility:hidden;contain:strict';
        // Next to <body>, so a rendered <body> never includes it.
        doc.documentElement.appendChild(host);
        qiDefaultsRoot = host.attachShadow({ mode: 'open' });
        qiDefaultStyles.clear();
    }
    let parent = qiDefaultsRoot;
    if (ns === QI_SVG_NS && node.localName !== 'svg') {
        parent = doc.createElementNS(QI_SVG_NS, 'svg');
        qiDefaultsRoot.appendChild(parent);
    }
    const el = ns && ns !== 'http://www.w3.org/1999/xhtml'
        ? doc.createElementNS(ns, node.localName)
        : doc.createElement(node.localName);
    parent.appendChild(el);
    const computed = doc.defaultView.getComputedStyle(el);
    style = {};
    for (let i = 0; i < computed.length; i++) style[computed[i]] = computed.getPropertyValue(computed[i]);
    if (parent !== qiDefaultsRoot) parent.remove();
    else el.remove();
    qiDefaultStyles.set(key, style);
    return style;
}
// ---------------------------------------------------------------------------------
`;

function replaceOnce(code, search, replacement, label) {
  const parts = code.split(search);
  if (parts.length !== 2) {
    throw new Error(`html-to-image changed: the "${label}" patch no longer applies (see scripts/renderer-patches.mjs).`);
  }
  return parts.join(replacement);
}

/** Vite plugin applying the patches above. */
export function rendererPatches() {
  let patched = false;
  return {
    name: 'quarto-ink-renderer-patches',
    transform(code, id) {
      if (!CLONE_NODE.test(id)) return null;
      let out = replaceOnce(code, STYLE_COPY, STYLE_COPY_PATCHED, 'style copy');
      out = replaceOnce(out, CLONE_STYLE_FN, HELPERS + CLONE_STYLE_FN, 'style helpers');
      patched = true;
      return { code: out, map: null };
    },
    buildEnd() {
      if (!patched) throw new Error('html-to-image changed: clone-node.js was not found to patch.');
    },
  };
}
