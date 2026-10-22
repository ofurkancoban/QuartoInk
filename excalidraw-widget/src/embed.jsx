import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Excalidraw,
  FONT_FAMILY,
  MainMenu,
  newElementWith,
  restore,
  serializeAsJSON,
  getNonDeletedElements,
  getCommonBounds,
  exportToSvg,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords
} from '@excalidraw/excalidraw';
// Excalidraw >= 0.18 no longer injects its own styles; ship them inside this bundle.
import excalidrawCss from '@excalidraw/excalidraw/index.css?inline';

(function injectExcalidrawCss() {
  if (document.getElementById('quarto-ink-excalidraw-css')) return;
  // The stylesheet references fonts relative to itself ("./fonts/..."); point them at dist/.
  const base = window.EXCALIDRAW_ASSET_PATH || '';
  const style = document.createElement('style');
  style.id = 'quarto-ink-excalidraw-css';
  style.textContent = excalidrawCss.replace(/url\((['"]?)\.\/fonts\//g, `url($1${base}fonts/`);
  // Prepend so the host page's #excalidraw-host overrides keep winning.
  document.head.prepend(style);
})();

// Custom toolbar options
const UIOptions = {
  canvasActions: {
    loadScene: false,
    saveToActiveFile: false,
    export: false,
    saveAsImage: false,
    clearCanvas: false,
    toggleTheme: false,
    changeViewBackgroundColor: false
  },
  tools: {
    image: true,
    laser: true
  }
};

// Check if Mac or iOS platform
function isApplePlatform() {
  try {
    return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
  } catch {
    return false;
  }
}

// Colors and defaults
const DEFAULT_STROKE_COLOR = "#1e1e1e";
const PURE_BLACK_COLOR = "#000000";
const DEFAULT_ROUGHNESS = 0;
const DEFAULT_STROKE_STYLE = "solid";
const HIGHLIGHTER_OPACITY = 30;
const PEN_OPACITY = 100;

const FIXED_PALETTE_COLORS = new Set([
  DEFAULT_STROKE_COLOR, "#212121", "#242424", "#292929", "#2c2c2c",
  "#ced4da", "#adb5bd", "#868e96", "#495057", "#343a40", "#212529"
]);

const EXCALIDRAW_ELEMENT_PROPS = ["editingElement", "multiElement", "draggingElement", "selectionElement"];

// Helper: Extract current stroke width from Excalidraw's appState
function getExcalidrawStrokeWidth(appState) {
  if (!appState || typeof appState !== 'object') return null;
  for (const prop of EXCALIDRAW_ELEMENT_PROPS) {
    const el = appState[prop];
    if (el && typeof el === 'object' && typeof el.strokeWidth === 'number' && Number.isFinite(el.strokeWidth)) {
      return el.strokeWidth;
    }
  }
  const cur = appState.currentItemStrokeWidth;
  return typeof cur === 'number' && Number.isFinite(cur) ? cur : null;
}

// Helper: Hex parser
function parseHexColor(hex) {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(clean.length - 2), 16)
  ];
}

// Normalize CSS colors to standard hex color supported by Excalidraw
function normalizeColorToHex(color) {
  if (!color || typeof color !== 'string') return PURE_BLACK_COLOR;
  let val = color.trim();
  if (/^rgba?\(/i.test(val)) {
    const m = val.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
    if (m) {
      const clamp = (n) => Math.max(0, Math.min(255, Math.round(Number(n))));
      const toHex = (n) => clamp(n).toString(16).padStart(2, "0");
      val = `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`.toLowerCase();
    } else {
      return PURE_BLACK_COLOR;
    }
  } else {
    if (!val.startsWith("#")) val = `#${val}`;
    if (/^#([0-9a-fA-F]{3})$/.test(val)) {
      const [r, g, b] = [val[1], val[2], val[3]];
      val = `#${r}${r}${g}${g}${b}${b}`;
    }
  }
  if (/^#[0-9a-fA-F]{8}$/.test(val)) {
    val = val.slice(0, 7);
  }
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    val = val.toLowerCase();
    // If the color matches our fixed palette theme black/dark gray, map it to pure black
    return FIXED_PALETTE_COLORS.has(val) ? PURE_BLACK_COLOR : val;
  }
  return PURE_BLACK_COLOR;
}

function areColorsEqual(c1, c2) {
  return normalizeColorToHex(c1) === normalizeColorToHex(c2);
}

function isFixedPaletteBlackColor(color) {
  if (!color || typeof color !== 'string') return false;
  let val = color.trim().toLowerCase();
  let hex = val.startsWith("#") ? val : "";
  if (hex.length === 9 && /^#[0-9a-f]{8}$/.test(hex)) {
    hex = hex.slice(0, 7);
  }
  if (hex.length === 7 && FIXED_PALETTE_COLORS.has(hex)) return true;

  const m = val.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  if (m) {
    const r = Math.round(Number(m[1]));
    const g = Math.round(Number(m[2]));
    const b = Math.round(Number(m[3]));
    for (const fixed of FIXED_PALETTE_COLORS) {
      const [fr, fg, fb] = parseHexColor(fixed);
      if (r === fr && g === fg && b === fb) return true;
    }
  }
  return false;
}

// Convert a single element properties if needed
function applyQuartoStyleToElement(el) {
  if (!el || typeof el !== 'object' || typeof el.strokeColor !== 'string' || !isFixedPaletteBlackColor(el.strokeColor)) {
    return null;
  }
  try {
    return newElementWith(el, {
      strokeColor: PURE_BLACK_COLOR,
      roughness: DEFAULT_ROUGHNESS,
      strokeStyle: DEFAULT_STROKE_STYLE
    });
  } catch {
    return null;
  }
}

// Map all elements to Quarto Ink styling
function applyQuartoStylesToElements(elements) {
  if (!Array.isArray(elements)) return null;
  let modified = false;
  const mapped = elements.map(el => {
    const styled = applyQuartoStyleToElement(el);
    if (styled) {
      modified = true;
      return styled;
    }
    return el;
  });
  return modified ? mapped : null;
}

// Convert appState active/editing elements
function applyQuartoStylesToAppState(appState) {
  if (!appState || typeof appState !== 'object') return null;
  const mapped = {};
  for (const prop of EXCALIDRAW_ELEMENT_PROPS) {
    const styled = applyQuartoStyleToElement(appState[prop]);
    if (styled) {
      mapped[prop] = styled;
    }
  }
  return Object.keys(mapped).length ? mapped : null;
}

function syncSceneStyles(api, elements, appState, currentOpacity) {
  if (!api) return;
  const newElements = applyQuartoStylesToElements(elements);
  const newAppState = applyQuartoStylesToAppState(appState);
  let extraState = null;

  if (appState && isFixedPaletteBlackColor(appState.currentItemStrokeColor)) {
    extraState = {
      currentItemStrokeColor: PURE_BLACK_COLOR,
      currentItemStrokeStyle: DEFAULT_STROKE_STYLE,
      currentItemRoughness: DEFAULT_ROUGHNESS,
      currentItemOpacity: currentOpacity
    };
  }

  if (newElements || newAppState || extraState) {
    isUpdatingScene = true;
    try {
      const updateData = { commitToHistory: false };
      if (newElements) updateData.elements = newElements;
      if (newAppState || extraState) {
        updateData.appState = {
          ...(newAppState || {}),
          ...(extraState || {})
        };
      }
      api.updateScene(updateData);
    } finally {
      isUpdatingScene = false;
    }
  }
}

function filterElementsForSync(elements) {
  return applyQuartoStylesToElements(elements) || elements;
}

let activeIframeRef = null;
let currentSlideKey = null;
let lastRootCreatedAt = 0;
let isUpdatingScene = false;
let debouncedSaveTimer = null;
let activeSerializedChangeCallback = null;

// The canvas lies exactly over the slide, so scene coordinates are slide (overlay) coordinates.
// The camera never moves: a two-finger scroll or pinch would otherwise pan the ink off the slide.
function createDefaultCamera() {
  return { scrollX: 0, scrollY: 0, zoom: { value: 1 } };
}

function isDefaultCamera(scrollX, scrollY, zoom) {
  return scrollX === 0 && scrollY === 0 && (zoom?.value ?? 1) === 1;
}

// Convert serialized state to restoration properties
function getRestorationScene(props) {
  const { sceneSerialized, initialToolbarStroke, initialToolbarStrokeWidth, initialQuartoTool, uiTheme } = props || {};
  const toolName = typeof initialQuartoTool === 'string' && initialQuartoTool ? initialQuartoTool : "pen";
  const opacity = toolName === "highlighter" ? HIGHLIGHTER_OPACITY : PEN_OPACITY;
  const strokeColor = normalizeColorToHex(initialToolbarStroke);
  const strokeWidth = normalizeStrokeWidth(initialToolbarStrokeWidth);
  const theme = normalizeTheme(uiTheme);

  if (!sceneSerialized || typeof sceneSerialized !== 'string') {
    return {
      elements: [],
      files: {},
      toolbarStroke: strokeColor,
      initStrokeW: strokeWidth,
      initOpacity: opacity,
      theme,
      toolName
    };
  }

  try {
    const restored = restore(JSON.parse(sceneSerialized), null, null);
    return {
      elements: filterElementsForSync(restored.elements || []),
      files: restored.files || {},
      toolbarStroke: strokeColor,
      initStrokeW: strokeWidth,
      initOpacity: opacity,
      theme,
      toolName
    };
  } catch {
    return {
      elements: [],
      files: {},
      toolbarStroke: strokeColor,
      initStrokeW: strokeWidth,
      initOpacity: opacity,
      theme,
      toolName
    };
  }
}

/**
 * True while the user is drawing or dragging on the canvas. setActiveTool() and
 * scene resets discard the element being drawn, so automatic re-syncs wait.
 */
function isUserDrawing(api) {
  try {
    const appState = api && api.getAppState();
    return !!(appState && (appState.newElement || appState.multiElement || appState.selectionElement || appState.cursorButton === "down"));
  } catch {
    return false;
  }
}

function syncStateFromHost(iframeRef, props) {
  if (!quartoInkRoot || !excalidrawRootRef.current || !iframeRef || (activeIframeRef && iframeRef !== activeIframeRef)) {
    return false;
  }
  activeSerializedChangeCallback = props?.onSerializedChange;
  const prevSlideKey = currentSlideKey;
  const excalAPI = excalidrawRootRef.current;

  try {
    const parsed = getRestorationScene(props);
    activeQuartoTool = parsed.toolName;
    activeToolbarStrokeColor = parsed.toolbarStroke;
    activeToolbarStrokeWidth = normalizeStrokeWidth(props?.initialToolbarStrokeWidth);

    const appState = excalAPI.getAppState();
    const isSameSlide = prevSlideKey === props.slideKey;
    currentSlideKey = props.slideKey || null;

    if (isSameSlide && isUserDrawing(excalAPI)) {
      // Same slide re-sync during a stroke: nothing to restore, and a reset would cut the stroke.
      return true;
    }

    const preserveMenu = props && props.preserveShapeMenu ? "shape" : null;
    const sceneElements = Array.isArray(parsed.elements) && parsed.elements.length > 0 ? parsed.elements : [];
    const camera = createDefaultCamera();

    isUpdatingScene = true;
    try {
      const updateData = {
        appState: {
          ...appState,
          scrollX: camera.scrollX,
          scrollY: camera.scrollY,
          zoom: camera.zoom,
          viewBackgroundColor: "transparent",
          gridSize: null,
          collaborators: new Map(),
          theme: parsed.theme,
          currentItemStrokeColor: parsed.toolbarStroke,
          currentItemStrokeWidth: parsed.initStrokeW,
          currentItemStrokeStyle: DEFAULT_STROKE_STYLE,
          currentItemRoughness: DEFAULT_ROUGHNESS,
          currentItemOpacity: parsed.initOpacity,
          currentItemFontSize: activeTextFontSize,
          currentItemFontFamily: activeTextFontFamily,
          activeTool: getExcalToolObject(activeQuartoTool),
          openMenu: preserveMenu,
          selectedElementIds: {},
          editingElement: null,
          multiElement: null,
          selectionElement: null,
          draggingElement: null
        },
        commitToHistory: false
      };
      if (!isSameSlide) {
        updateData.elements = sceneElements;
        updateData.files = parsed.files;
      }
      excalAPI.updateScene(updateData);
    } finally {
      isUpdatingScene = false;
    }

    syncToolbarUI();
    const tool = activeQuartoTool;
    const forceTool = () => {
      if (isUserDrawing(excalAPI)) return;
      try {
        excalAPI.setActiveTool(getExcalToolObject(tool));
        syncToolbarUI({ withColor: false });
      } catch {}
    };
    forceTool();
    requestAnimationFrame(() => {
      requestAnimationFrame(forceTool);
    });

    return true;
  } catch {
    return false;
  }
}

function normalizeStrokeColor(hex) {
  return normalizeColorToHex(hex);
}

function dispatchExcalidrawKeyEvent(keyChar, isShift = false) {
  const host = document.getElementById("excalidraw-host");
  if (!host || host.style.display === "none") return;
  const excal = host.querySelector(".excalidraw");
  if (!excal) return;
  const isMac = isApplePlatform();
  const code = keyChar === "z" ? "KeyZ" : "KeyY";
  excal.dispatchEvent(new KeyboardEvent("keydown", {
    key: keyChar,
    code,
    metaKey: isMac,
    ctrlKey: !isMac,
    shiftKey: !!isShift,
    bubbles: true,
    cancelable: true
  }));
}

function excalidrawUndo() {
  dispatchExcalidrawKeyEvent("z", false);
}

function excalidrawRedo() {
  isApplePlatform() ? dispatchExcalidrawKeyEvent("z", true) : dispatchExcalidrawKeyEvent("y", false);
}

const excalidrawRootRef = { current: null };
let quartoInkRoot = null;
let currentExcalAPI = null;
let activeToolbarStrokeColor = PURE_BLACK_COLOR;
let activeToolbarStrokeWidth = 2;
// Size and font of new text notes: Excalidraw's "L" (its default "M", 20, is small on a slide)
// in its "Normal" sans font, which reads better on slides than the hand-drawn one. Kept across
// slides, which each mount a new Excalidraw, once the user picks others in the panel or toolbar.
const DEFAULT_TEXT_FONT_SIZE = 28;
let activeTextFontSize = DEFAULT_TEXT_FONT_SIZE;
let activeTextFontFamily = FONT_FAMILY.Nunito;
// Excalidraw's size presets and the radio inputs of its panel that apply them.
const TEXT_SIZE_INPUTS = { 16: "fontSize-small", 20: "fontSize-medium", 28: "fontSize-large", 36: "fontSize-veryLarge" };

/** Remember the text size and font the user picked in the current Excalidraw. */
function rememberTextStyle() {
  try {
    const appState = excalidrawRootRef.current?.getAppState();
    const size = appState?.currentItemFontSize;
    const family = appState?.currentItemFontFamily;
    if (typeof size === 'number' && Number.isFinite(size) && size > 0) activeTextFontSize = size;
    if (typeof family === 'number' && Number.isFinite(family)) activeTextFontFamily = family;
  } catch {}
}

function normalizeStrokeWidth(val) {
  const num = Number(val);
  return Number.isFinite(num) ? (num <= 1.25 ? 1 : num <= 2.5 ? 2 : 4) : 2;
}

const HIGHLIGHTER_SIZE_OPACITY = 30;

let activeQuartoTool = "pen";
let strokeWidthChangeCount = 0;
const eraserTrailPoints = [];
let requestEraserFrameCallback = () => {};
let animationFrameId = null;
let isEraserActive = false;

function isHighlighterActive(appState) {
  if (activeQuartoTool === "highlighter") return true;
  if (!appState || typeof appState !== 'object') return false;
  const opacity = appState.currentItemOpacity;
  return typeof opacity === 'number' && Math.round(opacity) === HIGHLIGHTER_SIZE_OPACITY;
}

function getOpacityForTool(appState) {
  return isHighlighterActive(appState) ? HIGHLIGHTER_SIZE_OPACITY : PEN_OPACITY;
}

function getUIStrokeWidth(w) {
  return normalizeStrokeWidth(w);
}

function getAppStateStrokeWidth(appState) {
  const w = isHighlighterActive(appState) ? getExcalidrawStrokeWidth(appState) ?? appState?.currentItemStrokeWidth : appState?.currentItemStrokeWidth;
  return typeof w !== 'number' || !Number.isFinite(w) ? null : normalizeStrokeWidth(w);
}

function normalizeTheme(theme) {
  return theme === "dark" ? "dark" : "light";
}

const MAX_ERASER_TRAIL_LENGTH = 56;
const ERASER_TRAIL_STYLES = {
  light: { stroke: "rgba(72, 74, 84, 0.82)" },
  dark: { stroke: "rgba(210, 212, 220, 0.78)" }
};

function renderEraserTrail(canvas, host, api, points, theme, scaleMultiplier) {
  if (!canvas || !host || !api || points.length < 1) {
    if (canvas) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    }
    return;
  }

  const wrapper = host.querySelector(".excalidraw__canvas-wrapper") || host;
  const mainCanvas = wrapper.querySelector("canvas.excalidraw__canvas:not(.static)");

  if (canvas && wrapper.contains(canvas) && mainCanvas) {
    canvas.style.position = "absolute";
    canvas.style.left = `${mainCanvas.offsetLeft}px`;
    canvas.style.top = `${mainCanvas.offsetTop}px`;
    canvas.style.width = `${mainCanvas.offsetWidth}px`;
    canvas.style.height = `${mainCanvas.offsetHeight}px`;
    canvas.style.right = "auto";
    canvas.style.bottom = "auto";
  }

  const rect = (mainCanvas || wrapper).getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  const canvasW = Math.floor(width * dpr);
  const canvasH = Math.floor(height * dpr);

  if (canvas.width !== canvasW || canvas.height !== canvasH) {
    canvas.width = canvasW;
    canvas.height = canvasH;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const appState = api.getAppState();
  if (!appState) return;

  const style = theme === "dark" ? ERASER_TRAIL_STYLES.dark : ERASER_TRAIL_STYLES.light;
  const radius = Math.max(6, scaleMultiplier);
  const len = points.length;

  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  if (len === 1) {
    const coord = sceneCoordsToViewportCoords({ sceneX: points[0].x, sceneY: points[0].y }, appState);
    const px = coord.x - rect.left;
    const py = coord.y - rect.top;
    ctx.fillStyle = style.stroke;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.arc(px, py, radius * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1.0;
    return;
  }

  for (let i = 1; i < len; i++) {
    const w1 = (i - 1) / (len - 1);
    const w2 = i / (len - 1);
    const thickness = 0.6 + (radius - 0.6) * (w1 + w2) * 0.5;

    const c1 = sceneCoordsToViewportCoords({ sceneX: points[i - 1].x, sceneY: points[i - 1].y }, appState);
    const c2 = sceneCoordsToViewportCoords({ sceneX: points[i].x, sceneY: points[i].y }, appState);

    const x1 = c1.x - rect.left;
    const y1 = c1.y - rect.top;
    const x2 = c2.x - rect.left;
    const y2 = c2.y - rect.top;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineWidth = thickness;
    ctx.strokeStyle = style.stroke;

    const opacity = 0.35 + 0.65 * w2;
    ctx.globalAlpha = Math.min(1.0, opacity);
    ctx.stroke();
  }
  ctx.globalAlpha = 1.0;
}

function syncToolbarUI(options) {
  const withColor = !options || options.withColor !== false;
  const api = excalidrawRootRef.current;
  if (!api) return;

  const hexColor = normalizeColorToHex(activeToolbarStrokeColor);
  try {
    const appState = api.getAppState();
    if (activeQuartoTool === "highlighter" || activeQuartoTool === "pen") {
      const w = activeQuartoTool === "highlighter" ? getExcalidrawStrokeWidth(appState) ?? appState?.currentItemStrokeWidth : appState?.currentItemStrokeWidth;
      if (typeof w === 'number' && Number.isFinite(w)) {
        activeToolbarStrokeWidth = normalizeStrokeWidth(w);
      }
    }

    const strokeWidth = getUIStrokeWidth(activeToolbarStrokeWidth);
    const opacity = getOpacityForTool(appState);

    const currentStrokeColor = appState?.currentItemStrokeColor;
    const currentStrokeWidth = activeQuartoTool === "highlighter" ? getExcalidrawStrokeWidth(appState) ?? appState?.currentItemStrokeWidth : appState?.currentItemStrokeWidth;
    const currentOpacity = appState?.currentItemOpacity;

    if (withColor) {
      if (currentStrokeColor != null &&
          areColorsEqual(currentStrokeColor, hexColor) &&
          currentStrokeWidth === strokeWidth &&
          currentOpacity === opacity &&
          appState?.currentItemRoughness === DEFAULT_ROUGHNESS &&
          appState?.currentItemStrokeStyle === DEFAULT_STROKE_STYLE) {
        return;
      }
      api.updateScene({
        appState: {
          currentItemStrokeColor: hexColor,
          currentItemStrokeWidth: strokeWidth,
          currentItemStrokeStyle: DEFAULT_STROKE_STYLE,
          currentItemRoughness: DEFAULT_ROUGHNESS,
          currentItemOpacity: opacity
        },
        commitToHistory: false
      });
    } else {
      if (currentStrokeWidth === strokeWidth &&
          currentOpacity === opacity &&
          appState?.currentItemRoughness === DEFAULT_ROUGHNESS &&
          appState?.currentItemStrokeStyle === DEFAULT_STROKE_STYLE) {
        return;
      }
      api.updateScene({
        appState: {
          currentItemStrokeWidth: strokeWidth,
          currentItemStrokeStyle: DEFAULT_STROKE_STYLE,
          currentItemRoughness: DEFAULT_ROUGHNESS,
          currentItemOpacity: opacity
        },
        commitToHistory: false
      });
    }
  } catch {}
}

const QUARTO_TO_EXCALIDRAW_TOOL_MAP = {
  lasso: { type: "selection" },
  pen: { type: "freedraw" },
  highlighter: { type: "freedraw" },
  eraser: { type: "eraser" },
  // Locked: Excalidraw would fall back to selection after one shape or note, while the
  // toolbar still shows the tool, so the next drag would select instead of draw.
  rect: { type: "rectangle", locked: true },
  circle: { type: "ellipse", locked: true },
  arrow: { type: "arrow", locked: true },
  text: { type: "text", locked: true },
  image: { type: "image" },
  laser: { type: "laser" }
};

function getExcalToolObject(toolName) {
  return QUARTO_TO_EXCALIDRAW_TOOL_MAP[typeof toolName === 'string' && toolName ? toolName : "pen"] || QUARTO_TO_EXCALIDRAW_TOOL_MAP.pen;
}

function ExcalidrawWidget(props) {
  const { slideKey, sceneSerialized, initialToolbarStroke, initialToolbarStrokeWidth, initialUiTheme, initialQuartoTool } = props;
  const timerRef = useRef(null);
  const strokeWidthRef = useRef(null);
  const hostRef = useRef(null);
  const canvasRef = useRef(null);

  const initColor = normalizeColorToHex(initialToolbarStroke);
  const initWidth = normalizeStrokeWidth(initialToolbarStrokeWidth);
  const initTheme = normalizeTheme(initialUiTheme);
  const initOpacity = initialQuartoTool === "highlighter" ? HIGHLIGHTER_SIZE_OPACITY : PEN_OPACITY;

  const initialData = useMemo(() => {
    const defaultScene = {
      elements: [],
      appState: {
        viewBackgroundColor: "transparent",
        gridSize: null,
        collaborators: new Map(),
        theme: initTheme,
        currentItemStrokeColor: initColor,
        currentItemStrokeWidth: initWidth,
        currentItemStrokeStyle: DEFAULT_STROKE_STYLE,
        currentItemRoughness: DEFAULT_ROUGHNESS,
        currentItemOpacity: initOpacity,
        currentItemFontSize: activeTextFontSize,
        currentItemFontFamily: activeTextFontFamily,
        activeTool: getExcalToolObject(initialQuartoTool)
      },
      files: {}
    };

    if (!sceneSerialized || typeof sceneSerialized !== 'string') return defaultScene;
    try {
      const restored = restore(JSON.parse(sceneSerialized), null, null);
      return {
        elements: filterElementsForSync(restored.elements || []),
        appState: {
          ...(restored.appState || {}),
          ...createDefaultCamera(),
          viewBackgroundColor: "transparent",
          gridSize: null,
          collaborators: new Map(),
          theme: initTheme,
          currentItemStrokeColor: initColor,
          currentItemStrokeWidth: initWidth,
          currentItemStrokeStyle: DEFAULT_STROKE_STYLE,
          currentItemRoughness: DEFAULT_ROUGHNESS,
          currentItemOpacity: initOpacity,
          currentItemFontSize: activeTextFontSize,
          currentItemFontFamily: activeTextFontFamily,
          activeTool: getExcalToolObject(initialQuartoTool)
        },
        files: restored.files || {}
      };
    } catch {
      return defaultScene;
    }
  }, [sceneSerialized, initColor, initWidth, initOpacity, initTheme, initialQuartoTool]);

  // Handle toolbar state sync
  useEffect(() => {
    const syncToolbar = () => {
      try {
        syncToolbarUI();
      } catch {}
    };
    syncToolbar();
    const frameId = requestAnimationFrame(() => {
      syncToolbar();
      requestAnimationFrame(syncToolbar);
    });
    return () => cancelAnimationFrame(frameId);
  }, [initColor, initWidth, initOpacity, initTheme, initialQuartoTool, sceneSerialized]);

  // Handle eraser canvas setup
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const eraserCanvas = document.createElement("canvas");
    eraserCanvas.className = "quarto-excal-eraser-trail";
    eraserCanvas.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;pointer-events:none;z-index:25;filter:none";
    canvasRef.current = eraserCanvas;

    let resizeObserver = null;
    let cancelled = false;

    const checkWrapper = () => {
      if (cancelled) return;
      const wrapper = host.querySelector(".excalidraw__canvas-wrapper");
      if (wrapper && eraserCanvas.parentElement !== wrapper) {
        wrapper.appendChild(eraserCanvas);
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver?.disconnect();
          resizeObserver = new ResizeObserver(() => requestEraserFrameCallback());
          resizeObserver.observe(wrapper);
        }
      } else if (!wrapper) {
        requestAnimationFrame(checkWrapper);
      }
    };

    checkWrapper();

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      eraserCanvas.remove();
      if (canvasRef.current === eraserCanvas) {
        canvasRef.current = null;
      }
    };
  }, [sceneSerialized, initialQuartoTool]);

  // Handle eraser pointer events
  useEffect(() => {
    const triggerRedraw = () => {
      const canvas = canvasRef.current;
      const host = hostRef.current;
      const api = excalidrawRootRef.current;
      if (!api) return;

      const appState = api.getAppState();
      const zoomValue = appState?.zoom?.value ?? 1;
      const strokeWidth = activeToolbarStrokeWidth;
      const radius = Math.min(36, (10 + strokeWidth * 3) * Math.sqrt(zoomValue));

      renderEraserTrail(canvas, host, api, eraserTrailPoints, initTheme, radius);
    };

    requestEraserFrameCallback = () => {
      if (animationFrameId == null) {
        animationFrameId = requestAnimationFrame(() => {
          triggerRedraw();
          animationFrameId = null;
        });
      }
    };

    const addPoint = (clientX, clientY) => {
      const api = excalidrawRootRef.current;
      const appState = api?.getAppState();
      if (!api || !appState) return;

      const sceneCoord = viewportCoordsToSceneCoords({ clientX, clientY }, appState);
      const zoom = appState.zoom?.value ?? 1;
      const minDistance = Math.max(0.2, 0.35 / zoom);
      const points = eraserTrailPoints;

      if (points.length === 0) {
        points.push({ x: sceneCoord.x, y: sceneCoord.y });
      } else {
        const last = points[points.length - 1];
        const dist = Math.hypot(sceneCoord.x - last.x, sceneCoord.y - last.y);
        if (dist >= minDistance) {
          points.push({ x: sceneCoord.x, y: sceneCoord.y });
          while (points.length > MAX_ERASER_TRAIL_LENGTH) {
            points.shift();
          }
        } else {
          points[points.length - 1] = { x: sceneCoord.x, y: sceneCoord.y };
        }
      }
      requestEraserFrameCallback();
    };

    const clearTrail = () => {
      isEraserActive = false;
      if (eraserTrailPoints.length) {
        eraserTrailPoints.length = 0;
        requestEraserFrameCallback();
      }
    };

    const isHostDescendant = (node) => {
      const host = hostRef.current;
      if (!host || !node || typeof node !== 'object') return false;
      try {
        return host.contains(node);
      } catch {
        return false;
      }
    };

    const isExcludedUI = (node) => {
      if (!node || !node.closest) return false;
      return !!(
        node.closest(".layer-ui__wrapper") ||
        node.closest(".App-menu_top") ||
        node.closest(".App-menu_bottom") ||
        node.closest(".mobile-misc-tools-container") ||
        node.closest('button, a, input, textarea, select, [role="button"]')
      );
    };

    const onPointerDown = (e) => {
      if (!isHostDescendant(e.target) || isExcludedUI(e.target)) return;
      const api = excalidrawRootRef.current;
      const appState = api?.getAppState();
      if (!api || !appState) return;

      if (appState.activeTool.type === "eraser") {
        isEraserActive = true;
        eraserTrailPoints.length = 0;
        addPoint(e.clientX, e.clientY);
      }
    };

    const onPointerMove = (e) => {
      const api = excalidrawRootRef.current;
      const appState = api?.getAppState();
      if (!api || !appState || appState.activeTool.type !== "eraser") {
        if (isEraserActive || eraserTrailPoints.length) {
          clearTrail();
        }
        return;
      }
      if (isEraserActive) {
        addPoint(e.clientX, e.clientY);
      }
    };

    const onPointerUpOrCancel = () => {
      clearTrail();
    };

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUpOrCancel, true);
    window.addEventListener("pointercancel", onPointerUpOrCancel, true);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUpOrCancel, true);
      window.removeEventListener("pointercancel", onPointerUpOrCancel, true);
      requestEraserFrameCallback = () => {};
      if (animationFrameId != null) {
        cancelAnimationFrame(animationFrameId);
        animationFrameId = null;
      }
      isEraserActive = false;
    };
  }, [initTheme]);

  const onScrollChange = useCallback((scrollX, scrollY, zoom) => {
    requestEraserFrameCallback();
    if (isDefaultCamera(scrollX, scrollY, zoom)) return;
    const api = excalidrawRootRef.current;
    if (!api) return;
    // Called during Excalidraw's own update: put the camera back right after it.
    queueMicrotask(() => {
      try {
        api.updateScene({ appState: createDefaultCamera(), commitToHistory: false });
      } catch {}
    });
  }, []);

  // Swallow wheel panning and zooming (trackpad two-finger scroll and pinch) before Excalidraw
  // sees it, so the ink does not jump for a frame before the camera is reset.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const onWheel = (e) => {
      if (e.target instanceof Element && e.target.closest('.Island, .layer-ui__wrapper__top-right, .dropdown-menu')) return;
      e.preventDefault();
      e.stopPropagation();
    };
    host.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => host.removeEventListener('wheel', onWheel, { capture: true });
  }, []);

  // Remember the text size and font picked in the panel for the next slides, which each mount a
  // new Excalidraw. onChange is not reliably called for these appState-only changes.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const onPanelInput = (e) => {
      if (!(e.target instanceof Element) || !e.target.closest('.selected-shape-actions, .FontPicker__container, [data-testid^="font-family-"]')) return;
      // A font change is applied after its font has loaded, so read again a little later.
      [0, 250, 800].forEach((delay) => setTimeout(() => {
        rememberTextStyle();
        window.dispatchEvent(new CustomEvent('quartoink:textstyle'));
      }, delay));
    };
    host.addEventListener('change', onPanelInput, true);
    host.addEventListener('click', onPanelInput, true);
    return () => {
      host.removeEventListener('change', onPanelInput, true);
      host.removeEventListener('click', onPanelInput, true);
    };
  }, []);

  const onChange = useCallback((elements, appState, files) => {
    if (isUpdatingScene) return;
    const api = excalidrawRootRef.current;
    const resolvedAppState = appState || api?.getAppState();
    const currentOpacity = getOpacityForTool(resolvedAppState);

    if (api && Array.isArray(elements)) {
      syncSceneStyles(api, elements, resolvedAppState, currentOpacity);
    }

    // A finished note stays selected, and the text tool then re-opens the selected note on
    // the next click anywhere. Deselect it so every click with Text starts a new note.
    if (api && activeQuartoTool === "text" && resolvedAppState && !resolvedAppState.editingTextElement
      && resolvedAppState.activeTool?.type === "text"
      && Object.keys(resolvedAppState.selectedElementIds || {}).length) {
      queueMicrotask(() => {
        try {
          api.updateScene({ appState: { selectedElementIds: {} }, commitToHistory: false });
        } catch {}
      });
    }

    try {
      const newAppState = appState || api?.getAppState();
      const currentWidth = isHighlighterActive(newAppState)
        ? getExcalidrawStrokeWidth(newAppState) ?? newAppState?.currentItemStrokeWidth
        : newAppState?.currentItemStrokeWidth;

      if (typeof currentWidth === 'number' && Number.isFinite(currentWidth)) {
        activeToolbarStrokeWidth = normalizeStrokeWidth(currentWidth);
      }
    } catch {}

    if (props.onStrokeWidthFromExcalidraw) {
      try {
        const checkState = appState || api?.getAppState();
        const strokeW = getAppStateStrokeWidth(checkState);
        if (strokeW != null) {
          if (strokeWidthChangeCount > 0) {
            strokeWidthRef.current = strokeW;
          } else if (strokeWidthRef.current !== strokeW) {
            strokeWidthRef.current = strokeW;
            props.onStrokeWidthFromExcalidraw(strokeW);
          }
        }
      } catch {}
    }

    if (timerRef.current) {
      clearTimeout(timerRef.current);
    }

    const currentKey = slideKey;
    timerRef.current = setTimeout(() => {
      try {
        const innerAPI = excalidrawRootRef.current;
        let innerAppState = innerAPI?.getAppState() || appState;
        const innerFiles = innerAPI?.getFiles() || files;
        let innerElements = innerAPI?.getSceneElements() || elements;

        if (innerAPI && Array.isArray(innerElements)) {
          syncSceneStyles(innerAPI, innerElements, innerAppState, getOpacityForTool(innerAppState));
          innerAppState = innerAPI.getAppState() || innerAppState;
          innerElements = innerAPI.getSceneElements() || innerElements;
        }

        const filteredState = isFixedPaletteBlackColor(innerAppState.currentItemStrokeColor)
          ? { ...innerAppState, gridSize: null, currentItemStrokeColor: PURE_BLACK_COLOR, currentItemStrokeStyle: DEFAULT_STROKE_STYLE, currentItemRoughness: DEFAULT_ROUGHNESS, currentItemOpacity: getOpacityForTool(innerAppState) }
          : { ...innerAppState, gridSize: null };

        if (props.onStrokeColorFromExcalidraw && innerAppState.currentItemStrokeColor) {
          const hex = normalizeStrokeColor(innerAppState.currentItemStrokeColor);
          if (!timerRef.prevColor || !areColorsEqual(timerRef.prevColor, hex)) {
            timerRef.prevColor = hex;
            props.onStrokeColorFromExcalidraw(hex);
          }
        }

        const strokeW = getAppStateStrokeWidth(innerAppState);
        if (props.onStrokeWidthFromExcalidraw && strokeW != null) {
          if (strokeWidthChangeCount > 0) {
            strokeWidthRef.current = strokeW;
          } else if (strokeWidthRef.current !== strokeW) {
            strokeWidthRef.current = strokeW;
            props.onStrokeWidthFromExcalidraw(strokeW);
          }
        }

        const serialized = serializeAsJSON(innerElements, filteredState, innerFiles, "local");
        activeSerializedChangeCallback(serialized, currentKey);
      } catch {}
      timerRef.current = null;
    }, 120);
  }, [slideKey, props.onDebouncedSerialized, props.onStrokeColorFromExcalidraw, props.onStrokeWidthFromExcalidraw]);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return (
    <div ref={hostRef} style={{ width: "100%", height: "100%", position: "relative" }}>
      <Excalidraw
        name="quarto-ink"
        langCode="en"
        theme={initTheme}
        excalidrawAPI={(api) => {
          if (!api) {
            excalidrawRootRef.current = null;
            currentExcalAPI = null;
            return;
          }
          if (excalidrawRootRef.current === api) return;
          excalidrawRootRef.current = api;
          currentExcalAPI = api;

          const initScene = () => {
            if (isUserDrawing(api)) return;
            try {
              api.setActiveTool(getExcalToolObject(activeQuartoTool));
              api.updateScene({
                appState: { gridSize: null },
                commitToHistory: false
              });
              syncToolbarUI();
            } catch {}
          };

          initScene();
          requestAnimationFrame(() => {
            initScene();
            requestAnimationFrame(initScene);
          });

          [400, 1200].forEach((delay) => window.setTimeout(initScene, delay));

          try {
            api.onChange(() => {
              if (eraserTrailPoints.length > 0) {
                requestEraserFrameCallback();
              }
            });
          } catch {}
        }}
        initialData={initialData}
        onChange={onChange}
        onScrollChange={onScrollChange}
        onPointerDown={() => syncToolbarUI({ withColor: false })}
        UIOptions={UIOptions}
        renderTopRightUI={() => null}
      >
        <MainMenu __fallback={false} />
      </Excalidraw>
    </div>
  );
}

function mount(container, props) {
  if (!container) return;
  activeSerializedChangeCallback = props?.onSerializedChange;

  if (!syncStateFromHost(container, props)) {
    if (quartoInkRoot) {
      quartoInkRoot.unmount();
      quartoInkRoot = null;
    }
    excalidrawRootRef.current = null;
    currentExcalAPI = null;
    isEraserActive = false;
    eraserTrailPoints.length = 0;

    activeToolbarStrokeColor = normalizeColorToHex(props?.initialToolbarStroke);
    activeQuartoTool = typeof props?.initialQuartoTool === 'string' ? props?.initialQuartoTool : "pen";
    activeToolbarStrokeWidth = normalizeStrokeWidth(props?.initialToolbarStrokeWidth);
    activeIframeRef = container;
    currentSlideKey = props?.slideKey || null;

    if (debouncedSaveTimer) {
      clearTimeout(debouncedSaveTimer);
      debouncedSaveTimer = null;
    }

    lastRootCreatedAt = performance.now();
    quartoInkRoot = createRoot(container);
    quartoInkRoot.render(
      <ExcalidrawWidget
        slideKey={props?.slideKey}
        sceneSerialized={props?.sceneSerialized}
        initialToolbarStroke={props?.initialToolbarStroke}
        initialToolbarStrokeWidth={props?.initialToolbarStrokeWidth}
        initialUiTheme={props?.initialUiTheme}
        initialQuartoTool={props?.initialQuartoTool}
        onDebouncedSerialized={props?.onSerializedChange || (() => {})}
        onStrokeColorFromExcalidraw={props?.onStrokeColorFromExcalidraw}
        onStrokeWidthFromExcalidraw={props?.onStrokeWidthFromExcalidraw}
        key={props?.slideKey}
      />
    );
  }
}

/**
 * A new Excalidraw instance briefly starts with the "selection" tool and only applies
 * the requested tool once its scene has initialised. Input arriving in that window would
 * become a selection drag instead of a stroke, so the host holds it back until this is true.
 * Only applies right after a mount, so deliberate tool changes are never blocked.
 */
function isReadyForInput() {
  const api = excalidrawRootRef.current;
  if (!api) return false;
  if (performance.now() - lastRootCreatedAt > 1000) return true;
  try {
    return api.getAppState().activeTool.type === getExcalToolObject(activeQuartoTool).type;
  } catch {
    return true;
  }
}

function unmount() {
  if (debouncedSaveTimer) {
    clearTimeout(debouncedSaveTimer);
    debouncedSaveTimer = null;
  }
  if (quartoInkRoot) {
    quartoInkRoot.unmount();
    quartoInkRoot = null;
  }
  excalidrawRootRef.current = null;
  currentExcalAPI = null;
  activeIframeRef = null;
  currentSlideKey = null;
  isEraserActive = false;
  eraserTrailPoints.length = 0;
}

function captureSceneSerialized() {
  const api = excalidrawRootRef.current;
  if (!api) return null;
  try {
    let elements = api.getSceneElements();
    let appState = api.getAppState();
    syncSceneStyles(api, elements, appState, getOpacityForTool(appState));
    elements = api.getSceneElements();
    appState = api.getAppState();

    const filteredState = isFixedPaletteBlackColor(appState?.currentItemStrokeColor)
      ? { ...appState, gridSize: null, currentItemStrokeColor: PURE_BLACK_COLOR, currentItemStrokeStyle: DEFAULT_STROKE_STYLE, currentItemRoughness: DEFAULT_ROUGHNESS }
      : { ...appState, gridSize: null };

    return serializeAsJSON(elements, filteredState, api.getFiles(), "local");
  } catch {
    return null;
  }
}

function getAPI() {
  return excalidrawRootRef.current;
}

function getTextFontSize() {
  return activeTextFontSize;
}

/**
 * Text size from the host toolbar. Goes through Excalidraw's own size control, so a selected
 * note or the note being typed changes too, as with the panel.
 */
function setTextFontSize(size) {
  if (!TEXT_SIZE_INPUTS[size]) return;
  activeTextFontSize = size;
  const input = document.querySelector(`#excalidraw-host [data-testid="${TEXT_SIZE_INPUTS[size]}"]`);
  if (input) {
    input.click();
  } else {
    try {
      excalidrawRootRef.current?.updateScene({ appState: { currentItemFontSize: size }, commitToHistory: false });
    } catch {}
  }
}

function setExcalidrawShapeMenuOpen(open) {
  const api = excalidrawRootRef.current;
  if (!api) return;
  requestAnimationFrame(() => {
    try {
      api.updateScene({
        appState: { openMenu: open ? "shape" : null },
        commitToHistory: false
      });
    } catch {}
  });
}

function syncQuartoToolFromHost(toolName) {
  if (typeof toolName !== 'string' || !toolName) return;
  activeQuartoTool = toolName;
  if (toolName !== "eraser") {
    isEraserActive = false;
    if (eraserTrailPoints.length) {
      eraserTrailPoints.length = 0;
      requestEraserFrameCallback();
    }
  }
}

function applyQuartoTool(toolName) {
  const api = excalidrawRootRef.current;
  if (!api || typeof toolName !== 'string') return;
  activeQuartoTool = toolName;
  if (toolName !== "eraser") {
    isEraserActive = false;
    if (eraserTrailPoints.length) {
      eraserTrailPoints.length = 0;
      requestEraserFrameCallback();
    }
  }
  const excalTool = getExcalToolObject(toolName);
  try {
    api.setActiveTool(excalTool);
    syncToolbarUI();
  } catch {}
}

function setCurrentItemStrokeColor(color) {
  const api = excalidrawRootRef.current;
  if (!api || typeof color !== 'string') return;

  const hexColor = normalizeColorToHex(color);
  activeToolbarStrokeColor = hexColor;

  try {
    const appState = api.getAppState();
    const currentOpacity = getOpacityForTool(appState);
    const apiStrokeColor = appState?.currentItemStrokeColor;

    if (apiStrokeColor != null &&
        areColorsEqual(apiStrokeColor, hexColor) &&
        appState?.currentItemRoughness === DEFAULT_ROUGHNESS &&
        appState?.currentItemOpacity === currentOpacity &&
        appState?.currentItemStrokeStyle === DEFAULT_STROKE_STYLE) {
      return;
    }
    api.updateScene({
      appState: {
        currentItemStrokeColor: hexColor,
        currentItemStrokeStyle: DEFAULT_STROKE_STYLE,
        currentItemRoughness: DEFAULT_ROUGHNESS,
        currentItemOpacity: currentOpacity
      },
      commitToHistory: false
    });
  } catch {}
}

function setCurrentItemStrokeWidth(width) {
  const api = excalidrawRootRef.current;
  if (!api || typeof width !== 'number' || !Number.isFinite(width)) return;

  try {
    const appState = api.getAppState();
    const strokeWidth = normalizeStrokeWidth(width);
    activeToolbarStrokeWidth = strokeWidth;
    const currentOpacity = getOpacityForTool(appState);

    if (appState?.currentItemStrokeWidth === strokeWidth && appState?.currentItemOpacity === currentOpacity) {
      return;
    }

    strokeWidthChangeCount++;
    try {
      api.updateScene({
        appState: {
          currentItemStrokeWidth: strokeWidth,
          currentItemOpacity: currentOpacity
        },
        commitToHistory: false
      });
    } finally {
      queueMicrotask(() => {
        strokeWidthChangeCount = Math.max(0, strokeWidthChangeCount - 1);
      });
    }
  } catch {}
}

function setCurrentItemOpacity(opacityVal) {
  const api = excalidrawRootRef.current;
  if (!api || typeof opacityVal !== 'number' || !Number.isFinite(opacityVal)) return;

  const opacity = Math.max(0, Math.min(100, Math.round(opacityVal)));
  try {
    const appState = api.getAppState();
    if (appState?.currentItemOpacity === opacity) return;
    api.updateScene({
      appState: {
        currentItemOpacity: opacity
      },
      commitToHistory: false
    });
  } catch {}
}

function setTheme(theme) {
  const api = excalidrawRootRef.current;
  if (!api) return;

  const targetTheme = normalizeTheme(theme);
  const reSync = () => {
    try {
      syncToolbarUI();
    } catch {}
  };

  try {
    const appState = api.getAppState();
    if (appState?.theme !== targetTheme) {
      api.updateScene({
        appState: { theme: targetTheme },
        commitToHistory: false
      });
    }
    reSync();
    requestAnimationFrame(() => {
      reSync();
      requestAnimationFrame(reSync);
    });
    [120, 400].forEach((delay) => window.setTimeout(reSync, delay));
  } catch {}
}

function isFrameElement(el) {
  return el && (el.type === "frame" || el.type === "magicframe");
}

function filterOutFrameChildren(elements) {
  if (!Array.isArray(elements) || !elements.length) return elements;
  const frameIds = new Set(elements.filter(isFrameElement).map(el => el.id).filter(Boolean));
  return elements.filter(el => frameIds.has(el.id) || !el.frameId || !frameIds.has(el.frameId));
}

async function exportSerializedToSvg(sceneSerialized, slideKeyVal, preserveMenuVal, paddingX = 0, paddingY = 0) {
  if (!sceneSerialized || typeof sceneSerialized !== 'string') return null;

  try {
    const restored = restore(JSON.parse(sceneSerialized), null, null);
    const elements = filterElementsForSync(restored.elements);
    const nonDeleted = getNonDeletedElements(elements);

    if (!nonDeleted.length) return null;

    const padding = 10;
    const filteredFrames = filterOutFrameChildren(nonDeleted);
    const targetElements = filteredFrames.length ? filteredFrames : nonDeleted;

    let bounds = getCommonBounds(targetElements);
    let [minX, minY, maxX, maxY] = bounds;

    if (![minX, minY, maxX, maxY].every(Number.isFinite) || (maxX <= minX && maxY <= minY)) {
      bounds = getCommonBounds(nonDeleted);
      [minX, minY, maxX, maxY] = bounds;
    }

    const svg = await exportToSvg({
      elements: restored.elements,
      appState: {
        ...(restored.appState || {}),
        exportBackground: false,
        viewBackgroundColor: "transparent"
      },
      files: restored.files || null,
      exportPadding: padding
    });

    if (!svg) return null;

    if (![minX, minY, maxX, maxY].every(Number.isFinite) ||
        !(typeof slideKeyVal === 'number' && typeof preserveMenuVal === 'number' && typeof paddingX === 'number' && typeof paddingY === 'number' && slideKeyVal > 0 && preserveMenuVal > 0)) {
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.style.width = "100%";
      svg.style.height = "100%";
      return svg.outerHTML;
    }

    const viewBox = svg.getAttribute("viewBox");
    const vb = viewBox ? viewBox.trim().split(/[\s,]+/).map(Number.parseFloat) : [];
    const vbW = vb.length >= 4 ? vb[2] : 0;
    const vbH = vb.length >= 4 ? vb[3] : 0;

    if (!(vbW > 0) || !(vbH > 0)) {
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.style.width = "100%";
      svg.style.height = "100%";
      return svg.outerHTML;
    }

    const relX = (minX - padding - paddingX) / slideKeyVal;
    const relY = (minY - padding - paddingY) / preserveMenuVal;
    const relW = vbW / slideKeyVal;
    const relH = vbH / preserveMenuVal;

    if (![relX, relY, relW, relH].every(Number.isFinite)) {
      svg.setAttribute("width", "100%");
      svg.setAttribute("height", "100%");
      svg.style.width = "100%";
      svg.style.height = "100%";
      return svg.outerHTML;
    }

    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.width = "100%";
    svg.style.height = "100%";
    svg.style.display = "block";

    return [svg.outerHTML, relX, relY, relW, relH];
  } catch (err) {
    console.warn("[QuartoInkExcalidraw] exportSerializedToSvg", err);
    return null;
  }
}

// Global API export
window.__QUARTO_INK_BUNDLE_VER = "__QI_BUNDLE_VER__"; // replaced with a content hash by scripts/build.mjs
window.QuartoInkExcalidraw = {
  mount,
  unmount,
  isReadyForInput,
  captureSceneSerialized,
  exportSerializedToSvg,
  getAPI,
  getTextFontSize,
  setTextFontSize,
  syncQuartoToolFromHost,
  applyQuartoTool,
  setExcalidrawShapeMenuOpen,
  setCurrentItemStrokeColor,
  setCurrentItemStrokeWidth,
  setCurrentItemOpacity,
  setTheme,
  excalidrawUndo,
  excalidrawRedo,
  flush: () => {
    const scene = captureSceneSerialized();
    if (scene && activeSerializedChangeCallback) {
      activeSerializedChangeCallback(scene, currentSlideKey);
    }
  }
};
