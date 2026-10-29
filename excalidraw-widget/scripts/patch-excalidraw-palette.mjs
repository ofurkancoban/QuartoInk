/**
 * Dynamic, Version-Agnostic Patch Script for @excalidraw/excalidraw:
 * Recursively scans all JS files inside dist/ to apply semantic patches.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.resolve(__dirname, '..');
const distDir = path.join(widgetRoot, 'node_modules', '@excalidraw', 'excalidraw', 'dist');

// Define regex-based semantic patches
const SEMANTIC_PATCHES = [
  // 1. Black Color: replaces "#1e1e1e" with "#000000" in the default black color definition
  {
    name: 'Black Color Default',
    replace: (content) => {
      // Avoid re-patching if already done
      if (content.includes('black:"#000000"') || content.includes('black: "#000000"')) {
        return { content, applied: false };
      }
      const regex = /(black\s*:\s*["'])#1e1e1e(["'])/g;
      if (regex.test(content)) {
        return { content: content.replace(regex, '$1#000000$2'), applied: true };
      }
      return { content, applied: false };
    }
  },

  // 2. Default Roughness to 0 (Architect): replaces roughness:Gi.artist or roughness:ROUGHNESS.artist with 0
  {
    name: 'Default Roughness (Architect)',
    replace: (content) => {
      // Match only if it is set to artist (1) or the variable, not already architect (0)
      const regex = /(strokeColor\s*:\s*\w+\.black\s*,\s*backgroundColor\s*:\s*\w+\.transparent\s*,\s*fillStyle\s*:\s*["']solid["']\s*,\s*strokeWidth\s*:\s*2\s*,\s*strokeStyle\s*:\s*["']solid["']\s*,\s*roughness\s*:\s*)(1|\w+\.artist)/g;
      if (regex.test(content)) {
        return { content: content.replace(regex, '$10'), applied: true };
      }
      return { content, applied: false };
    }
  },

  // 3. Stroke Top Picks (Color Palette): replaces the default stroke colors array with Quarto colors
  {
    name: 'Stroke Top Picks (Quarto Palette)',
    replace: (content) => {
      // Avoid re-patching if already done
      if (content.includes('["#000000","#6366f1","#06b6d4","#ef4444","#10b981"]')) {
        return { content, applied: false };
      }
      const regex = /\[\s*(?:\w+\.black|COLOR_PALETTE\.black)\s*,\s*(?:\w+\.red\[\w+\]|COLOR_PALETTE\.red\[\w+\])\s*,\s*(?:\w+\.green\[\w+\]|COLOR_PALETTE\.green\[\w+\])\s*,\s*(?:\w+\.blue\[\w+\]|COLOR_PALETTE\.blue\[\w+\])\s*,\s*(?:\w+\.yellow\[\w+\]|COLOR_PALETTE\.yellow\[\w+\])\s*\]/g;
      if (regex.test(content)) {
        return { content: content.replace(regex, '["#000000","#6366f1","#06b6d4","#ef4444","#10b981"]'), applied: true };
      }
      return { content, applied: false };
    }
  },

  // 4. Gray Tail: replaces the open-color gray tail with pure black if found as literal strings
  {
    name: 'Gray Tail (Open-Color)',
    replace: (content) => {
      const regex = /"#868e96"\s*,\s*"#495057"\s*,\s*"#343a40"\s*,\s*"#212529"\s*\]/g;
      if (regex.test(content)) {
        return { content: content.replace(regex, '"#868e96","#000000","#000000","#000000"]'), applied: true };
      }
      return { content, applied: false };
    }
  },

  // 5. Highlighter Options: dynamically injects perfect-freehand thickness and streamline adjustments
  {
    name: 'Highlighter perfect-freehand Options',
    replace: (content) => {
      // Avoid re-patching if already contains our custom logic (opacity < 100 check)
      if (content.includes('opacity < 100') || content.includes('opacity<100')) {
        return { content, applied: false };
      }
      const regex = /([{,]\s*options\s*=\s*)?\{\s*simulatePressure:\s*(\w+)\.simulatePressure,\s*size:\s*(?:\2\.strokeWidth\s*\*\s*4\.25|4\.25\s*\*\s*\2\.strokeWidth),\s*thinning:\s*(?:0\.6|\.6),\s*smoothing:\s*(?:0\.5|\.5),\s*streamline:\s*(?:0\.5|\.5),\s*easing:\s*([^,}]+),\s*(?:\/\/[^\n]*\n\s*)*last:\s*!!\2\.lastCommittedPoint\s*(?:\/\/[^\n]*)?\s*\}/g;
      if (regex.test(content)) {
        const newContent = content.replace(regex, (match, g1, g2, g3) => {
          const prefix = g1 || '';
          const el = g2;
          const easingFunc = g3.trim();
          const paramMatch = easingFunc.match(/^\(?(\w+)\)?\s*=>/);
          const param = paramMatch ? paramMatch[1] : 't';
          return `${prefix}("number" == typeof ${el}.opacity && ${el}.opacity < 100 ? { simulatePressure: false, size: 22 * ${el}.strokeWidth, thinning: 0, smoothing: 0.65, streamline: 0.72, easing: ${param} => ${param}, last: !!${el}.lastCommittedPoint } : { simulatePressure: ${el}.simulatePressure, size: ${el}.strokeWidth * 4.25, thinning: 0.6, smoothing: 0.5, streamline: 0.5, easing: ${easingFunc}, last: !!${el}.lastCommittedPoint })`;
        });
        return { content: newContent, applied: true };
      }
      return { content, applied: false };
    }
  },

  // 6. No phone layout: Quarto Ink replaces Excalidraw's toolbar with its own and lays out the
  //    desktop property panel, which the phone layout (picked when the canvas is narrower than
  //    730 px, e.g. a portrait iPad or a docked side toolbar) does not have.
  {
    name: 'Desktop Layout Only',
    replace: (content) => {
      if (/"isMobileBreakpoint",\s*\([\w$]+,\s*[\w$]+\)\s*=>\s*(?:\{\s*return\s+)?false/.test(content)) {
        return { content, applied: false };
      }
      // Only a body without parentheses or braces inside: anything else is left alone (reported
      // as "no match") rather than cut at the wrong ')' into a broken bundle.
      const regex = /("isMobileBreakpoint",\s*\(([\w$]+),\s*([\w$]+)\)\s*=>\s*)(\{\s*return\s+[^;{}()]+;\s*\}|[^(){};,]+)\)/g;
      if (regex.test(content)) {
        return { content: content.replace(regex, '$1false)'), applied: true };
      }
      return { content, applied: false };
    }
  }
];

function walk(dir) {
  let files = [];
  if (!fs.existsSync(dir)) return files;
  const list = fs.readdirSync(dir);
  for (const file of list) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat && stat.isDirectory()) {
      files = files.concat(walk(fullPath));
    } else if (file.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

if (!fs.existsSync(distDir)) {
  console.warn('[patch-excalidraw-palette] @excalidraw/excalidraw is not installed; run `npm install` first.');
  process.exit(0);
}

const jsFiles = walk(distDir);
const matchedFiles = new Map(SEMANTIC_PATCHES.map((patch) => [patch.name, []]));

for (const file of jsFiles) {
  let content = fs.readFileSync(file, 'utf8');
  let changed = false;

  // Normalize line endings to avoid CRLF mismatch in regexes/strings
  let newContent = content.replace(/\r\n/g, '\n');

  for (const patch of SEMANTIC_PATCHES) {
    const res = patch.replace(newContent);
    if (res.applied) {
      newContent = res.content;
      matchedFiles.get(patch.name).push(path.relative(distDir, file));
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(file, newContent, 'utf8');
  }
}

// Report per patch. The patches are idempotent: once applied to node_modules they no longer
// match, so "no match" is the normal state on repeat runs. It only means the upstream code
// changed if a patch never matches on a fresh install (check the palette visually then).
let applied = 0;
for (const patch of SEMANTIC_PATCHES) {
  const files = matchedFiles.get(patch.name);
  if (files.length > 0) {
    applied++;
    console.log(`[patch-excalidraw-palette] "${patch.name}" applied in ${files.length} file(s).`);
  } else {
    console.log(`[patch-excalidraw-palette] "${patch.name}" no match (already applied in node_modules).`);
  }
}
console.log(`[patch-excalidraw-palette] Done. ${applied} patch(es) applied this run.`);
