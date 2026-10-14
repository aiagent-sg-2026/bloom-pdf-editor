# Paperloom PDF Engine

Paperloom PDF's engine is a browser-native TypeScript implementation. It parses PDF objects and content streams, renders pages to Canvas, applies edits and annotations, manages forms and page operations, and writes edited PDFs through the native writer.

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

### Unsupported glyphs and on-demand CJK font embedding

Current safety behavior: new floating text and existing-run edits are preflighted
before resource/content changes. `UnsupportedGlyphsError` exposes deduplicated
`characters` and `codePoints` in first-seen order. A failed download shows the
dismissible message "These characters need an embedded font: ..." and retains
the pending text, overlays, and edit session; it does not download a lossy PDF.
Supported text retains its current encoding and fallback behavior.

The existing "Unicode fallback" is not a Unicode font. It installs non-embedded
Standard 14 Type1 Helvetica with WinAnsiEncoding, plus Symbol/ZapfDingbats for
characters in their finite reverse encoding tables
(`src/engine/fonts/font-augmentation.ts:29-73`,
`src/engine/fonts/symbol-fallback.ts:8-25,43-60`). The normal fallback encoder
passes code points up to 255 as bytes (Latin-1-ish, not a full Unicode-to-WinAnsi
reverse map), preserves selected bullets, and uses the finite Symbol/Dingbats
tables for Greek/math symbols and dingbats; CJK is not supported. The current encoder
also retains legacy ASCII substitutions for typographic quotes, dashes, and
ellipsis. `augmentFontsForMissingGlyphs` merely adds Helvetica and builds a
single-byte CMap for characters below 256; it embeds no font program and does
not attach that CMap to the fallback font
(`src/engine/fonts/font-augmentation.ts:121-143`).

#### Existing font APIs and exact format boundaries

- `loadFont(name: string, dict: PDFDict, objects: Map<string, PDFObject>): FontData`
  and `loadPageFonts(resources: PDFDict, objects: Map<string, PDFObject>)` load
  **PDF font dictionaries**, not fetched font files
  (`src/engine/fonts/font-parser.ts:92-124`). They handle simple fonts, Type0
  descendants, ToUnicode, widths, descriptors, and Type3 CharProcs
  (`src/engine/fonts/font-parser.ts:154-213,452-507`).
- For **raw font bytes**, `parseTTF(data: Uint8Array): TTFFont` reads an sfnt
  table directory and metrics, `cmap`, names, and OS/2
  (`src/engine/fonts/truetype-parser.ts:172-218`). The supported container
  signatures are `0x00010000` (TrueType .ttf), `true` (legacy TrueType sfnt),
  and `OTTO` (OpenType .otf)
  (`src/engine/fonts/truetype-parser.ts:159-167`). `cmap` formats 0, 4, 6, and 12
  are parsed (`src/engine/fonts/truetype-parser.ts:294-356`).
  `charCodeToGlyphId(font, codePoint)`, `getGlyphWidth(font, glyphId)`, and
  `fontUnitsToTextSpace(value, unitsPerEm)` provide coverage and width lookup
  (`src/engine/fonts/truetype-parser.ts:805-824`).
- Native outline extraction via `getGlyphOutline` requires TrueType `glyf` and
  `loca`; detecting `OTTO` does **not** implement CFF outline parsing
  (`src/engine/fonts/truetype-parser.ts:534-541`). The PDF loader reads
  FontFile/FontFile2/FontFile3 and wraps standalone CFF 1 data into OTTO for
  browser font loading (`src/engine/fonts/font-parser.ts:406-445`,
  `src/engine/fonts/cff-wrapper.ts:20-27,174-284`). This is not native CFF
  subsetting. Type1 PFA/PFB programs, WOFF/WOFF2, TTC/OTC collections, and CFF2
  have no decoding/collection-selection path here. Variable-font sfnt detection
  is not variation instantiation; require a static font instance.
- `subsetFonts(doc: PDFDocumentData): Promise<FontSubsetResult>` operates on
  **already embedded document fonts**, scanning page content for used glyphs
  (`src/engine/optimize/font-subsetter.ts:56-99,745-798`). Its private
  `expandCompositeGlyphs` retains components, while `buildSubsetFont` removes
  unused `glyf` outlines but preserves GIDs, glyph count, and other tables
  (`src/engine/optimize/font-subsetter.ts:456-513,540-643`). There is no public
  raw-font-plus-used-glyph-set subsetting API or dense GID renumbering API.
- Type0 width and CIDToGIDMap loading already exist
  (`src/engine/fonts/font-parser.ts:325-384,476-507`), and `parseCMap` reads
  bfchar/bfrange, codespaces, and CID mappings
  (`src/engine/fonts/cmap-parser.ts:37-70`). These are readers, not an embedding
  or two-byte ToUnicode writer.

#### Proposed embedding pipeline (design only)

1. **Acquire lazily.** Ship an OFL-licensed, static TrueType-outline font such
   as `public/fonts/NotoSansSC-Regular.ttf`, with its OFL license and provenance.
   A build-time SC coverage subset is acceptable, but its actual `cmap` defines
   coverage, not the family name. Fetch same-origin only when a text commit
   needs characters absent from its original font and Standard 14 fallbacks.
   Cache the fetch/parsed font, not mutable document objects. Do not use a CSS
   system font, WOFF2 webfont, variable font, or CFF-flavored OTF as a substitute
   for this TrueType program. No font asset or fetcher is included in this phase.
2. **Plan without mutation.** Collect used Unicode scalars and glyph IDs for
   all pending insertions/edits, including mixed Latin/CJK runs and whitespace.
   Use `parseTTF`/`charCodeToGlyphId` to verify every required glyph is nonzero;
   unsupported scalars still raise `UnsupportedGlyphsError`. Retain the cached
   source font for future edits: a previously embedded subset cannot supply new
   characters merely because an untouched cmap entry still exists.
3. **Subset TrueType.** Add a raw-font subsetting API using the existing
   composite-glyph closure, always retaining GID 0. A conservative first
   implementation can preserve original GIDs and remove unused outlines.
   A compact subset additionally renumbers GIDs and rewrites composite
   references, `glyf`, `loca`, `hmtx`, `maxp`, `cmap`, and affected layout tables.
   Preserve required hinting tables or remove hinting coherently; rebuild
   checksums, `head.checkSumAdjustment`, alignment, and a legal subset name.
   Never claim CFF or variable-font subsetting from the existing sfnt detector.
4. **Build the PDF font graph.** Allocate reachable indirect objects only after
   coverage and subsetting succeed:
   - Type0 `/BaseFont /ABCDEF+NotoSansSC-Regular`, `/Encoding /Identity-H`,
     `/DescendantFonts [cidFontRef]`, and `/ToUnicode toUnicodeRef`.
   - CIDFontType2 with matching BaseFont, `/CIDSystemInfo` using Registry
     `Adobe`, Ordering `Identity`, Supplement 0, and `/FontDescriptor`.
   - Assign compact two-byte CIDs to used characters/glyphs; reserve CID 0.
     Write `/CIDToGIDMap` as a binary big-endian uint16 stream mapping each
     CID to the actual subset GID. Use `/Identity` only if CID really equals GID.
   - Write `/W` with widths per CID from hmtx, scaled to 1000/em, and a consistent
     `/DW`. Emit text-show operands as hexadecimal two-byte CIDs, not UTF-8
     literal strings or Unicode values guessed to equal GIDs.
   - Write a two-byte ToUnicode codespace `<0000> <FFFF>` and bfchar/bfrange
     mappings from emitted CIDs back to original UTF-16BE strings, with surrogate
     pairs for supplementary characters. Keep mapping blocks bounded. Glyph
     appearance comes from the embedded program; ToUnicode alone cannot fix it.
   - FontDescriptor contains matching FontName, FontBBox, Ascent, Descent,
     CapHeight, ItalicAngle, StemV, and `/FontFile2` with uncompressed `/Length1`.
     Derive metrics and embedding permission from the selected asset. For a
     regular proportional sans CJK font with glyphs outside the standard Latin
     set, set Symbolic (bit 3, value 4), not Nonsymbolic (bit 6, value 32);
     never set both. Add FixedPitch, Serif, Italic, or ForceBold only when
     justified by the actual program/style, not as a missing-glyph workaround.
5. **Integrate before content compilation.** Add an asynchronous preparation
   stage shared by floating-text commits and existing-text edits. It must finish
   before `insertTextRun`/`applyTextEdits`, `updatePageContent`, annotation/image
   mutations, and overlay cleanup. The editor currently commits overlays before
   calling saveQuick/saveOptimized; loading a font inside final serialization is
   too late to recover characters already replaced in a stream. Pass the
   prepared font resource/encoding plan into run emission, split mixed text as
   needed, then commit font objects, resources, and content atomically.
   Materialize inherited page resources without modifying siblings.
6. **Save the prepared graph.** Both quick and optimized paths must include
   new font objects and modified resources/content. Register changed/new object
   keys for incremental saves and keep the font graph reachable for optimized
   garbage collection (`src/engine/writer/save-pipeline.ts:84-114,121-145`,
   `src/engine/writer/serializer.ts:43-88`). Do not depend on optimization:
   `saveOptimized` currently does GC/dedup, not font subsetting. Fetch, coverage,
   or subset failure leaves the PDF and all pending edits intact, releases the
   saving state, and shows the same non-modal warning without downloading.

Missing implementation: a licensed static font asset, lazy asset loader and
coverage selection, a public raw-font subsetting API, Type0/CIDFontType2 object
builders and CID/ToUnicode writers, font-aware insertion/fallback emission,
atomic asynchronous commit integration, and real-font cross-viewer validation.
Acceptance for that phase requires export/reparse of pure and mixed CJK with
Identity-H and correct ToUnicode **and** visible glyphs in Chrome and another
independent PDF viewer; synthetic mappings alone cannot prove font appearance.


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

Producer edit contracts retain the exact ordered list of separate text runs.
Untouched runs require exact text, font size, baseline y, and glyph text, with
an absolute `1e-6` tolerance for x, bounds, and glyph coordinates: TJ gap
compensation can change floating-point representation without moving a run.

Pull requests run TypeScript checking, the complete Vitest suite, and Next build
in `.github/workflows/ci.yml`.
