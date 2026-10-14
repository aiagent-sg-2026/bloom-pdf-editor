# Bloom PDF Engine

Bloom's PDF engine is a browser-native TypeScript implementation. It parses PDF objects and content streams, renders pages to Canvas, applies edits and annotations, manages forms and page operations, and writes edited PDFs through the native writer.

## Core areas

- `src/engine/parser/` — binary lexer, object parsing, filters, and cross-reference handling
- `src/engine/content/` — content-stream tokenization and interpretation
- `src/engine/render/` — Canvas rendering, color, transparency, clipping, images, and patterns
- `src/engine/editor/` and `src/engine/editing/` — text/object editing, annotations, selection, history, and transforms
- `src/engine/forms/` — AcroForm detection, values, appearances, and flattening
- `src/engine/writer/` — serialization, incremental updates, saveQuick/saveOptimized, and page operations
- `src/lib/pdfStorage.ts` — IndexedDB-backed browser document persistence

## Invariants

The engine remains browser-native. Native content-stream editing, annotations, forms, page operations, rendering, PDF save behavior, and IndexedDB persistence must remain independent of any server conversion product surface.

## Image soft masks

`src/engine/render/image-decoder.ts` applies image `/SMask` alpha to decoded RGBA, including browser-decoded JPEG base images. DeviceGray masks support 1-, 2-, 4-, 8-, and 16-bit samples with byte-padded rows, `/Decode` mapping, and nearest-neighbour resizing to the decoded base image dimensions. Images without a mask retain their existing opacity. `/Matte` unpremultiplication is not implemented.

Synthetic public-decoder regressions: `npm test -- src/engine/__tests__/image-decoder.test.ts`.

### Text-edit backgrounds

Complete text-operator rewrites do not paint an erase rectangle. Replacing
string operands, patching `TJ` spans, and emptying grouped siblings remove the
replaced glyphs while preserving coloured cells, images, and other backgrounds.

The legacy white erase remains only for incomplete rewrites with unmatched
source indices or an unmatched placement hint. It stays within the original
run bounds and may cover background content. Its placement before `BT` does
not guarantee that unmatched glyphs painted afterward are hidden; it is not a
substitute for removing their text operators.


## Export

The editor exports PNG, JPEG, SVG, and plain text in the browser. PDF save and optimization remain native writer operations.

Image compression derives candidates from the current document, including committed edits, even when serialization is larger than the upload. `compressDocumentImages` accepts `originalIsCurrent: true` only when the caller can prove the upload still represents the current document; this permits the smaller upload as the baseline and caps the result at its size. The option defaults to false.

The editor permits this fallback only for an unrecovered, unencrypted upload with unchanged exportable objects, no recorded or pending edits, and unchanged upload bytes. Saving does not reset its edit provenance. Uncertain state or a failed object comparison disables the fallback.

## Development

```bash
npm install
npm test
npm run lint
npm run build
```
