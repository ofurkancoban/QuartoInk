/**
 * @excalidraw/excalidraw içinde:
 * - COLOR_PALETTE.black → #000000
 * - Gri tüpü son tonları → siyah (Island)
 * - `color-picker__top-picks` (stroke): `m.black` / indeks yerine Quarto ile aynı sabit hex’ler
 *
 * npm install / prebuild sonrası çalışır; `npm update @excalidraw/excalidraw` dosyaları
 * sıfırlarsa script yeniden uygulanır.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.resolve(__dirname, '..');
const distDir = path.join(widgetRoot, 'node_modules', '@excalidraw', 'excalidraw', 'dist');

/** Üst sıra: siyah + Quarto önayarları (title / toolbar ile aynı tonlar). */
const STROKE_TOP_PICKS_MIN_FROM = 'g=[m.black,m.red[d],m.green[d],m.blue[d],m.yellow[d]]';
const STROKE_TOP_PICKS_MIN_TO =
  'g=["#000000","#e03131","#2f9e44","#1971c2","#f08c00"]';

const STROKE_TOP_PICKS_DEV_FROM =
  'DEFAULT_ELEMENT_STROKE_PICKS = [COLOR_PALETTE.black, COLOR_PALETTE.red[DEFAULT_ELEMENT_STROKE_COLOR_INDEX], COLOR_PALETTE.green[DEFAULT_ELEMENT_STROKE_COLOR_INDEX], COLOR_PALETTE.blue[DEFAULT_ELEMENT_STROKE_COLOR_INDEX], COLOR_PALETTE.yellow[DEFAULT_ELEMENT_STROKE_COLOR_INDEX]]';
const STROKE_TOP_PICKS_DEV_TO =
  'DEFAULT_ELEMENT_STROKE_PICKS = ["#000000","#e03131","#2f9e44","#1971c2","#f08c00"]';

/** Minified + JSON.parse içi: open-color gray son üç gölge → siyah */
const GRAY_TAIL_FROM = '"#868e96","#495057","#343a40","#212529"]';
const GRAY_TAIL_TO = '"#868e96","#000000","#000000","#000000"]';

/** Stok `DEFAULT_ELEMENT_PROPS`: roughness artist (1) → çizgi soluk/dalgalı; architect (0) düz siyah. */
const DEFAULT_PROPS_ROUGH_MIN_FROM = 'opacity:100,roughness:1,strokeColor:a.HO.black';
const DEFAULT_PROPS_ROUGH_MIN_TO = 'opacity:100,roughness:0,strokeColor:a.HO.black';

const DEFAULT_PROPS_ROUGH_DEV_FROM = 'roughness: ROUGHNESS.artist,';
const DEFAULT_PROPS_ROUGH_DEV_TO = 'roughness: ROUGHNESS.architect,';

/**
 * Freedraw strokes use `perfect-freehand` (not roughness). In Quarto Ink, highlighter uses
 * opacity < 100 (e.g. 30%) and pen uses 100% — branch so only semi-opaque freedraw gets
 * flatter marker-like options (thinning 0, higher streamline/smoothing).
 * Highlighter branch uses a larger `size` multiplier (22 × strokeWidth vs stock 4.25 × strokeWidth).
 * without changing `currentItemStrokeWidth` (still 1/2/4 — avoids Excal UI / sync issues).
 */
const FREEDRAW_HIGHLIGHTER_OPTS_MIN_FROM =
  '{simulatePressure:e.simulatePressure,size:4.25*e.strokeWidth,thinning:.6,smoothing:.5,streamline:.5,easing:function(e){return Math.sin(e*Math.PI/2)},last:!!e.lastCommittedPoint}';
const FREEDRAW_HIGHLIGHTER_OPTS_MIN_TO =
  '("number"==typeof e.opacity&&e.opacity<100?{simulatePressure:!1,size:22*e.strokeWidth,thinning:0,smoothing:.65,streamline:.72,easing:function(e){return e},last:!!e.lastCommittedPoint}:{simulatePressure:e.simulatePressure,size:4.25*e.strokeWidth,thinning:.6,smoothing:.5,streamline:.5,easing:function(e){return Math.sin(e*Math.PI/2)},last:!!e.lastCommittedPoint})';

/** Patched bundles that still have 4.25 in the highlighter branch → 22. */
const FREEDRAW_HIGHLIGHTER_SIZE_UPGRADE_MIN_FROM =
  'opacity<100?{simulatePressure:!1,size:4.25*e.strokeWidth,thinning:0,smoothing:.65,streamline:.72';
const FREEDRAW_HIGHLIGHTER_SIZE_UPGRADE_MIN_TO =
  'opacity<100?{simulatePressure:!1,size:22*e.strokeWidth,thinning:0,smoothing:.65,streamline:.72';

/** Previous Quarto Ink used 8.5 here — bump to 22. */
const FREEDRAW_HIGHLIGHTER_SIZE_UPGRADE_85_MIN_FROM =
  'opacity<100?{simulatePressure:!1,size:8.5*e.strokeWidth,thinning:0,smoothing:.65,streamline:.72';
const FREEDRAW_HIGHLIGHTER_SIZE_UPGRADE_85_MIN_TO =
  'opacity<100?{simulatePressure:!1,size:22*e.strokeWidth,thinning:0,smoothing:.65,streamline:.72';

/** Prior build used 25.5 — nudge down to 22. */
const FREEDRAW_HIGHLIGHTER_SIZE_DOWNGRADE_255_MIN_FROM =
  'opacity<100?{simulatePressure:!1,size:25.5*e.strokeWidth,thinning:0,smoothing:.65,streamline:.72';
const FREEDRAW_HIGHLIGHTER_SIZE_DOWNGRADE_255_MIN_TO =
  'opacity<100?{simulatePressure:!1,size:22*e.strokeWidth,thinning:0,smoothing:.65,streamline:.72';

const FREEDRAW_HIGHLIGHTER_OPTS_DEV_FROM =
  'const options = {\\n    simulatePressure: element.simulatePressure,\\n    size: element.strokeWidth * 4.25,\\n    thinning: 0.6,\\n    smoothing: 0.5,\\n    streamline: 0.5,\\n    easing: t => Math.sin(t * Math.PI / 2),\\n    last: !!element.lastCommittedPoint // LastCommittedPoint is added on pointerup\\n\\n  };';
const FREEDRAW_HIGHLIGHTER_OPTS_DEV_TO =
  'const options = typeof element.opacity === "number" && element.opacity < 100 ? {\\n    simulatePressure: false,\\n    size: element.strokeWidth * 22,\\n    thinning: 0,\\n    smoothing: 0.65,\\n    streamline: 0.72,\\n    easing: t => t,\\n    last: !!element.lastCommittedPoint\\n\\n  } : {\\n    simulatePressure: element.simulatePressure,\\n    size: element.strokeWidth * 4.25,\\n    thinning: 0.6,\\n    smoothing: 0.5,\\n    streamline: 0.5,\\n    easing: t => Math.sin(t * Math.PI / 2),\\n    last: !!element.lastCommittedPoint // LastCommittedPoint is added on pointerup\\n\\n  };';

const FREEDRAW_HIGHLIGHTER_DEV_SIZE_UPGRADE_FROM =
  'simulatePressure: false,\\n    size: element.strokeWidth * 4.25,\\n    thinning: 0,\\n    smoothing: 0.65,\\n    streamline: 0.72,\\n    easing: t => t';
const FREEDRAW_HIGHLIGHTER_DEV_SIZE_UPGRADE_TO =
  'simulatePressure: false,\\n    size: element.strokeWidth * 22,\\n    thinning: 0,\\n    smoothing: 0.65,\\n    streamline: 0.72,\\n    easing: t => t';

const FREEDRAW_HIGHLIGHTER_DEV_SIZE_UPGRADE_85_FROM =
  'simulatePressure: false,\\n    size: element.strokeWidth * 8.5,\\n    thinning: 0,\\n    smoothing: 0.65,\\n    streamline: 0.72,\\n    easing: t => t';
const FREEDRAW_HIGHLIGHTER_DEV_SIZE_UPGRADE_85_TO =
  'simulatePressure: false,\\n    size: element.strokeWidth * 22,\\n    thinning: 0,\\n    smoothing: 0.65,\\n    streamline: 0.72,\\n    easing: t => t';

const FREEDRAW_HIGHLIGHTER_DEV_SIZE_DOWNGRADE_255_FROM =
  'simulatePressure: false,\\n    size: element.strokeWidth * 25.5,\\n    thinning: 0,\\n    smoothing: 0.65,\\n    streamline: 0.72,\\n    easing: t => t';
const FREEDRAW_HIGHLIGHTER_DEV_SIZE_DOWNGRADE_255_TO =
  'simulatePressure: false,\\n    size: element.strokeWidth * 22,\\n    thinning: 0,\\n    smoothing: 0.65,\\n    streamline: 0.72,\\n    easing: t => t';

const PATCH_GROUPS = [
  {
    files: [
      'excalidraw.production.min.js',
      'excalidraw-with-preact.production.min.js',
    ],
    patches: [
      { from: 'black:"#1e1e1e"', to: 'black:"#000000"' },
      { from: GRAY_TAIL_FROM, to: GRAY_TAIL_TO },
      { from: STROKE_TOP_PICKS_MIN_FROM, to: STROKE_TOP_PICKS_MIN_TO },
      { from: DEFAULT_PROPS_ROUGH_MIN_FROM, to: DEFAULT_PROPS_ROUGH_MIN_TO },
      { from: FREEDRAW_HIGHLIGHTER_OPTS_MIN_FROM, to: FREEDRAW_HIGHLIGHTER_OPTS_MIN_TO },
      { from: FREEDRAW_HIGHLIGHTER_SIZE_UPGRADE_MIN_FROM, to: FREEDRAW_HIGHLIGHTER_SIZE_UPGRADE_MIN_TO },
      { from: FREEDRAW_HIGHLIGHTER_SIZE_UPGRADE_85_MIN_FROM, to: FREEDRAW_HIGHLIGHTER_SIZE_UPGRADE_85_MIN_TO },
      { from: FREEDRAW_HIGHLIGHTER_SIZE_DOWNGRADE_255_MIN_FROM, to: FREEDRAW_HIGHLIGHTER_SIZE_DOWNGRADE_255_MIN_TO },
    ],
  },
  {
    files: ['excalidraw.development.js', 'excalidraw-with-preact.development.js'],
    patches: [
      { from: 'black: \\"#1e1e1e\\"', to: 'black: \\"#000000\\"' },
      { from: GRAY_TAIL_FROM, to: GRAY_TAIL_TO },
      { from: STROKE_TOP_PICKS_DEV_FROM, to: STROKE_TOP_PICKS_DEV_TO },
      { from: DEFAULT_PROPS_ROUGH_DEV_FROM, to: DEFAULT_PROPS_ROUGH_DEV_TO },
      { from: FREEDRAW_HIGHLIGHTER_OPTS_DEV_FROM, to: FREEDRAW_HIGHLIGHTER_OPTS_DEV_TO },
      { from: FREEDRAW_HIGHLIGHTER_DEV_SIZE_UPGRADE_FROM, to: FREEDRAW_HIGHLIGHTER_DEV_SIZE_UPGRADE_TO },
      { from: FREEDRAW_HIGHLIGHTER_DEV_SIZE_UPGRADE_85_FROM, to: FREEDRAW_HIGHLIGHTER_DEV_SIZE_UPGRADE_85_TO },
      { from: FREEDRAW_HIGHLIGHTER_DEV_SIZE_DOWNGRADE_255_FROM, to: FREEDRAW_HIGHLIGHTER_DEV_SIZE_DOWNGRADE_255_TO },
    ],
  },
];

let patchedFiles = 0;
let noopFiles = 0;
let missing = 0;

function applyPatches(content, patches, name) {
  let s = content;
  let changed = false;
  for (const { from, to } of patches) {
    if (s.includes(from)) {
      s = s.split(from).join(to);
      changed = true;
    } else if (!s.includes(to)) {
      console.warn(
        `[patch-excalidraw-palette] ne kaynak ne hedef bulundu (sürüm farkı?): ${name} … ${from.slice(0, 48)}…`,
      );
    }
  }
  return { s, changed };
}

function fileFullyPatched(raw, patches) {
  return patches.every((p) => !raw.includes(p.from));
}

for (const { files, patches } of PATCH_GROUPS) {
  for (const name of files) {
    const fp = path.join(distDir, name);
    if (!fs.existsSync(fp)) {
      console.warn(`[patch-excalidraw-palette] atlandı (yok): ${name}`);
      missing++;
      continue;
    }
    const raw = fs.readFileSync(fp, 'utf8');
    const { s, changed } = applyPatches(raw, patches, name);
    if (changed) {
      fs.writeFileSync(fp, s);
      console.log(`[patch-excalidraw-palette] güncellendi: ${name}`);
      patchedFiles++;
    } else if (fileFullyPatched(raw, patches)) {
      console.log(`[patch-excalidraw-palette] zaten uygulu: ${name}`);
      noopFiles++;
    } else {
      console.warn(`[patch-excalidraw-palette] kısmen uygulanamadı: ${name}`);
    }
  }
}

if (missing >= PATCH_GROUPS.reduce((n, g) => n + g.files.length, 0)) {
  console.warn('[patch-excalidraw-palette] @excalidraw/excalidraw kurulu değil; önce `npm install` çalıştırın.');
} else if (patchedFiles === 0 && noopFiles === 0) {
  console.warn('[patch-excalidraw-palette] yama uygulanamadı; paket sürümü script ile uyumsuz olabilir.');
}
