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

### Page trees and effective resources

Page deletion removes the leaf from its containing `/Kids` array, decrements
`/Count` on every ancestor, and prunes only intermediate `/Pages` nodes that
become empty. Nonempty branches and surviving page order are preserved.

Initial parsing and undo restoration use `resolvePageResources` for inline,
indirect, and inherited `/Resources`. The nearest resource dictionary wins;
resource categories are not merged across ancestors.

Image insertion on a leaf without its own `/Resources` materializes the
effective inherited dictionary and copies category dictionaries before adding
XObjects or opacity states. Resource definitions remain shared, but new
category entries do not affect siblings. The leaf's cached `page.resources`
tracks the materialized dictionary.

Synthetic serialize/reopen regressions:
`npm test -- src/engine/__tests__/page-tree-resources.test.ts`.

## Image soft masks

`src/engine/render/image-decoder.ts` applies image `/SMask` alpha to decoded RGBA, including browser-decoded JPEG base images. DeviceGray masks support 1-, 2-, 4-, 8-, and 16-bit samples with byte-padded rows, `/Decode` mapping, and nearest-neighbour resizing to the decoded base image dimensions. Images without a mask retain their existing opacity. `/Matte` unpremultiplication is not implemented.

Synthetic public-decoder regressions: `npm test -- src/engine/__tests__/image-decoder.test.ts`.

### Content-stream edit integrity

Parsed inline images retain their original `BI` dictionary, `ID` separator,
binary payload, and `EI` terminator as a byte view of the input stream. Keep
that input immutable. Both instruction compilation and pretty-printing copy
the image bytes unchanged; TJ normalization uses the same compilation path.
Unfiltered images with known sample dimensions skip embedded `EI` samples.
Filtered images and resource-defined colour spaces still use delimiter scanning.

String-only edits preserve `'` and `"` operators, including the word/character
spacing operands of `"`. Rewrites that split a quote show across fallback fonts
emit explicit `Tw`/`Tc` for `"` and `T*` before showing the replacement text.
Empty grouped quote siblings retain their line movement and spacing state.

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

### No-edit integrity guards

`npx vitest run src/engine/__tests__/no-edit-integrity.test.ts src/engine/__tests__/golden/golden-smoke.test.ts`

The integrity suite compares glyph codes, characters, and page-space origins
before and after the browser-facing `explodeTJGaps` entry point, with a
`1e-3` coordinate tolerance. It defines 240 independently seeded synthetic
streams, plus cairo, Chrome/Skia, and Word operator shapes. Failure diagnostics
include the seed and replay stream; a hand-reduced consecutive-TJ stream is
included when it independently reproduces the mismatch.

Synthetic three-page documents exercise quick saves with empty modified keys,
optimized saves, and the editor's normalize-on-open content update followed by
export and reopen. Unchanged streams must retain their exact text; normalized
streams must retain the original glyph sequence and positions. Finalized
signature markers must retain every original byte. These markers test save
policy, not cryptographic signature validity.

Pull requests run TypeScript checking, the complete Vitest suite, and Next build
in `.github/workflows/ci.yml`.
