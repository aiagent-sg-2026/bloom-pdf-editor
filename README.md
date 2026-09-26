<div align="center">

# 🌸 Bloom PDF Editor

### A Pure-Engine, Open-Source PDF Editor

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=next.js&logoColor=white)](https://nextjs.org/)

**Edit PDFs in the browser with a custom TypeScript PDF engine.**

[Quick Start](#-quick-start) · [Architecture](#-architecture) · [Contributing](CONTRIBUTING.md)

</div>

## ✨ What is Bloom?

Bloom is a full-featured PDF editor built with Next.js and React. Its custom TypeScript engine parses, renders, edits, and serializes PDFs in the browser. The application is a browser-only client and exports as static files to `out/`; it has no server conversion runtime.

The editor supports native PDF content-stream editing, annotations, forms, page operations, signatures, browser-side PNG/JPEG/SVG/TXT export, and PDF save/optimization.

## 🏗️ Architecture

The browser UI and the client engine communicate directly. PDF bytes remain in the browser and may be persisted through IndexedDB for local document storage.

```
Browser
  ├── React UI / Zustand state
  ├── src/engine/  (parser, renderer, editor, annotations, forms, writer)
  └── src/lib/pdfStorage.ts  (IndexedDB persistence)
```

## 🔧 Client Engine

The client engine includes binary parsing, content-stream interpretation, Canvas rendering, text and object editing, annotations, forms, page operations, signatures, OCR layout helpers, image handling, optimization, and incremental/full PDF writing. See [docs/ENGINE.md](docs/ENGINE.md) for the engine overview.

## 🚀 Quick Start

### Prerequisites

- Node.js ≥ 18
- npm ≥ 9

### Installation

```bash
git clone https://github.com/stemlen/bloom-pdf-editor.git
cd bloom-pdf-editor
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Scripts

```bash
npm run dev       # Next.js development server
npm run build     # Next.js production build
npm run lint      # ESLint
npm test          # Vitest
npm run verify:browser-only # Check for server-runtime regressions
```

`npm run build` produces the static export in `out/`, which can be hosted by any static web server or CDN.

## 📁 Project Structure

```
bloom-pdf-editor/
├── src/app/          # Next.js app and editor UI
├── src/engine/       # Browser-native TypeScript PDF engine
├── src/lib/          # Browser persistence and utilities
├── docs/             # Engine documentation
├── CONTRIBUTING.md
└── LICENSE           # Apache-2.0
```

## License

Bloom PDF Editor is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
