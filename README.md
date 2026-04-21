# Quarto Ink 🖋️
  
![Quarto Ink Cover](assets/cover.png)

<p align="center">
  <strong>The Professional Annotation Orchestrator for Quarto & Reveal.js</strong><br>
  Elevate your data storytelling with precision drawing, state-aware persistence, and seamless slide integration.
</p>

<p align="center">
  <a href="https://ofurkancoban.github.io/QuartoAnnotationWebsite/">
    <img src="https://img.shields.io/badge/Live%20Demo-Open%20Quarto%20Ink-success?style=for-the-badge&logo=rocket" alt="Live Demo">
  </a>
  <img src="https://img.shields.io/badge/Privacy-100%25%20Local-blue?style=for-the-badge" alt="Privacy">
  <img src="https://img.shields.io/badge/File%20Type-HTML-orange?style=for-the-badge" alt="File Type">
</p>

---

## 🌟 Overview

**Quarto Ink** is the professional choice for interactive storytelling. Built specifically for **Quarto Reveal.js** presentations, it provides a powerful annotation engine that runs **entirely in your browser**.

### 🔒 100% Local & Private
Unlike cloud-based annotation tools, Quarto Ink processing happens entirely on your machine.
- **No Server Required**: Load your local `.html` files directly.
- **Data Privacy**: Your annotations and slides never leave your computer.
- **Offline Capable**: Perfect for presenting in environments without internet access.

### 🎯 The "Overlay" Philosophy
Quarto Ink acts as a non-destructive **transparent layer** over your presentation. It captures your ink, tracks your slide position, and even understands the internal state of your Quarto components (like tabs and fragments).

**Compatibility Note**: Designed exclusively for **Quarto Reveal.js** exports (`.html` files).

---

## 🛠️ Advanced Features

### 🧩 Tab-Aware Annotation (Exclusive)
Quarto Ink isn't just "over" your slides; it's **context-aware**. If your slide contains a [Quarto Tabset](https://quarto.org/docs/presentations/revealjs/#tabsets), Quarto Ink automatically detects which tab is active.
- Annotations are **scoped to individual tabs**.
- Switching tabs hides/reveals the correct drawings instantly.
- No more overlapping annotations when cycling through complex data views.

### ⚓ 4-Directional Adaptive Toolbar
The interface is designed to respect your content. The main control pill can be docked to any edge of the screen:
- **Top/Bottom**: Optimized for horizontal layouts.
- **Left/Right**: Ideal for widescreen presentations, keeping controls near your hand.
- **Smart Popovers**: Tool settings and color pickers intelligently reposition themselves to avoid clipping at the screen edges.

### 🖋️ Precision Drawing Engine
Built for the **Apple Pencil** and high-resolution styluses:
- **Perfect Freehand API**: Pressure-sensitive, buttery-smooth strokes that feel natural.
- **Dynamic Thickness Presets**: Dedicated settings for Pen and Highlighter tools (saved per-tool).
- **Lasso Selection & Grouping**: Move or delete complex sketches as single objects.

---

## 🚀 Workflow & Usage

### 1. Preparation
Simply open `index.html` in any modern browser. You will be greeted by the **Drop Zone**. 
- Drag and drop your **Quarto Reveal.js (.html)** file.
- Or use the "Open Presentation" button to browse for `.html` / `.htm` files.

### 2. Annotation
Once loaded, your presentation sits securely in an iframe. 
- Use **Drawing Mode** (Canvas Overlay) to sketch.
- Use **Navigation Mode** to interact with links or advance fragments.
- **Pro Tip**: Use the `Space` bar to toggle between modes instantly.

### 3. Distribution
Capture your brilliance using the **Export** button.
- **Native Injection**: Quarto Ink creates a new version of your HTML file with all annotations and the rendering engine **injected directly into the source**.
- **Self-Contained**: The exported file needs no dependencies; send it to your students or colleagues, and they will see your annotations exactly as you drew them.

---

## ⌨️ Productivity Shortcuts

| Tool / Action | Shortcut | Mode Requirement |
| :--- | :--- | :--- |
| **Toggle Mode** | `Space` | None |
| **Pen / Highlighter** | `P` / `H` | Global |
| **Shapes (A / R / C)** | `A` (Arrow), `R` (Rect), `C` (Circle) | Global |
| **Selection (Lasso)** | `S` | Global |
| **Eraser** | `E` or `X` | Global |
| **Navigation** | `→` / `↓` / `N` | Navigation Mode (or Global fallback) |
| **Sidebar Toggle** | `L` | Global |
| **Undo / Redo** | `⌘ + Z` / `⌘ + Y` | Global |

---

## 🛡️ Technical Architecture

- **Engine**: Pure Vanilla JS (ES6+) — Lightweight and fast.
- **State Management**: `Map`-based annotation storage with `slide::tab` indexing.
- **Performance**: Double-buffered canvas drawing with `requestAnimationFrame` for artifact-free rendering.
- **Persistence**: `localStorage` bridge ensures you can close your browser and resume your session anytime.

---

## 📝 License & Attribution

Licensed under the [MIT License](LICENSE). 
Created and maintained by [ofurkancoban](https://github.com/ofurkancoban).

---

<p align="center">
  <em>"Ink your data. Empower your story."</em>
</p>
