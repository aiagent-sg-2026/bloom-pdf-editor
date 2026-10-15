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

### Page placement geometry

`src/engine/__tests__/placement-geometry.test.ts` uses synthetic in-memory PDFs
with direct and inherited page geometry. Literal user-space rectangles cover
`/Rotate` 0/90/180/270, zero and offset MediaBox origins, reversed box corners,
and an inset CropBox. Signature widgets with visual appearances and Square
annotations are checked before and after serialization, including appearance
`/BBox` and effective `/Matrix`. Coordinates include zoom and viewport offsets.
Watermark checks distinguish MediaBox-relative presets from absolute user-space
custom positions.

## Image soft masks

`src/engine/render/image-decoder.ts` applies image `/SMask` alpha to decoded RGBA, including browser-decoded JPEG base images. DeviceGray masks support 1-, 2-, 4-, 8-, and 16-bit samples with byte-padded rows, `/Decode` mapping, and nearest-neighbour resizing to the decoded base image dimensions. Images without a mask retain their existing opacity. `/Matte` unpremultiplication is not implemented.

Synthetic public-decoder regressions: `npm test -- src/engine/__tests__/image-decoder.test.ts`.

Image watermark uploads preserve original PNG bytes instead of flattening them
onto white JPEGs. Watermark PNG decoding uses `@pdf-lib/upng` and the same
`createRGBAImageObjects` builder as image replacement: intrinsic pixel dimensions,
Flate RGB data, and an indirect 8-bit DeviceGray `/SMask` when any alpha is below
255. Image and mask objects are registered in the document object map, reachable
from page resources, and retained by quick and optimized saves. Opaque PNGs omit
the mask; JPEGs retain their DCT path. Watermark opacity and blend mode remain
separate ExtGState settings applied on top of pixel alpha.
The builder retains the uncompressed RGB and mask buffers as `decodedBytes` for
immediate in-session rendering; `rawBytes` remain Flate-compressed for export.
`PDFStream.getBytes()` does not apply filters, so newly constructed image streams
must expose decoded samples just as parser-loaded streams do. Image display items
carry non-stroking `/ca`; the renderer multiplies it into canvas `globalAlpha`
inside the image's save/restore scope, independently of `/CA` and pixel alpha.
Single-use image replacement keeps the existing stream identity and indirect
reference while copying both encoded and decoded bytes from the replacement.
Clearing only `decodedBytes` would make the live decoder read Flate data as RGB
samples, despite a correct export. The editor refreshes both the page render and
thumbnail generation after replacement.
Synthetic live replacement regression (including repeated replacement on the same
object): `npm test -- src/engine/__tests__/image-replacement-audit.test.ts`.

`createWatermarkImageXObject`, `applyWatermarkToPage`, and `applyWatermarks` are
asynchronous; callers must await them. PNG samples are normalized to 8-bit RGBA
(16-bit precision is not retained); animated PNG watermarks are unsupported.
PNG decoding receives only the input view's bytes, including for pooled Node
Buffers. Image resource keys are unprefixed; content-stream `Do` operands add
exactly one `/`.
Synthetic in-session RGBA decoding and image draw-alpha regressions, plus RGBA,
palette/tRNS, opaque PNG, and JPEG round-trip regressions:
`npm test -- src/engine/__tests__/watermark-image.test.ts src/engine/__tests__/watermark-ctm.test.ts`.

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

The Download dropdown defaults to **Original** resolution and **Original** compression and uses the same save path as the main Download button. Optimized remains the default save mode (lossless GC + dedup); it does not recompress images, and original image streams pass through byte-for-byte. Choosing a compression preset explicitly enables JPEG re-encoding; Original resolution disables both downsampling and page rasterization. The engine cannot downsample without re-encoding, so a custom DPI with Original compression is not applied: image bytes remain unchanged, and the UI explains that a compression preset is required. The displayed current size is unchanged by the Original selections; lossless optimization may still change the final PDF size.

Image compression derives candidates from the current document, including committed edits, even when serialization is larger than the upload. `compressDocumentImages` accepts `originalIsCurrent: true` only when the caller can prove the upload still represents the current document; this permits the smaller upload as the baseline and caps the result at its size. The option defaults to false.

The editor permits this fallback only for an unrecovered, unencrypted upload with unchanged exportable objects, no recorded or pending edits, and unchanged upload bytes. Saving does not reset its edit provenance. Uncertain state or a failed object comparison disables the fallback.

### ExportService

`src/engine/export/export-service.ts` owns the ordinary PDF download sequence:
await text preparation, await the pending line edit (stop if it returns false),
await overlay flattening, then await the worker client's `saveQuick` or
`saveOptimized`. It returns a typed success with bytes, cancellation, or the
original error. The public save APIs, worker fallback, and writer are unchanged.

Preparation, edit submission, and flattening are injected callbacks. Flattening
still preflights floating text, adds drawing annotations, inserts floating text,
images, and visual signatures in that order, and awaits `updatePageContent`.
Only then does `commitThenCleanup` clear overlays and update history/render
state. This existing cleanup happens before serialization; export is not a
transaction and does not roll back already committed edits on a save failure.

The page retains overlay geometry, browser image decoding, React state, download
DOM operations, glyph warnings, and error presentation. It marks the document
clean only after successful serialization and download dispatch; cancellation
or any failure must not mark it clean. Compression, autosave, page splitting,
and navigation keep their existing paths. This first extraction deliberately
keeps the shared, UI-coupled overlay implementation in `page.tsx`.

### Unsupported glyphs and on-demand Unicode font embedding

Floating text and existing-run edits have an asynchronous preparation stage
before content compilation. `prepareTextForExport(objects, runs, source?, options?)`
collects scalars that the original font and Standard 14 fallbacks cannot
encode. Commits fully covered by those fonts do not load a Unicode font.
The editor displays the non-modal status "Loading font..." while preparation is pending.

`src/engine/fonts/script-fonts.ts` registers static TrueType assets and their
SIL OFL-1.1 license files in `public/fonts/`. Approximate local, uncompressed
asset sizes (not network transfer sizes):

| Font id | Asset | License | Approx. size |
| --- | --- | --- | --- |
| `sc` | `NotoSansSC-Regular.ttf` | `NotoSansSC-OFL.txt` | 10.1 MB |
| `tc` | `NotoSansTC-Regular.ttf` | `NotoSansTC-OFL.txt` | 5.6 MB |
| `jp` | `NotoSansJP-Regular.ttf` | `NotoSansJP-OFL.txt` | 4.4 MB |
| `kr` | `NotoSansKR-Regular.ttf` | `NotoSansKR-OFL.txt` | 5.1 MB |
| `latin` | `NotoSans-Regular.ttf` | `NotoSans-OFL.txt` | 86.4 KB |
| `thai` | `NotoSansThai-Regular.ttf` | `NotoSansThai-OFL.txt` | 30.7 KB |
| `devanagari` | `NotoSansDevanagari-Regular.ttf` | `NotoSansDevanagari-OFL.txt` | 190.3 KB |
| `bengali` | `NotoSansBengali-Regular.ttf` | `NotoSansBengali-OFL.txt` | 111.5 KB |
| `tamil` | `NotoSansTamil-Regular.ttf` | `NotoSansTamil-OFL.txt` | 52.0 KB |
| `telugu` | `NotoSansTelugu-Regular.ttf` | `NotoSansTelugu-OFL.txt` | 155.7 KB |
| `kannada` | `NotoSansKannada-Regular.ttf` | `NotoSansKannada-OFL.txt` | 126.7 KB |
| `malayalam` | `NotoSansMalayalam-Regular.ttf` | `NotoSansMalayalam-OFL.txt` | 81.5 KB |
| `gujarati` | `NotoSansGujarati-Regular.ttf` | `NotoSansGujarati-OFL.txt` | 148.8 KB |
| `gurmukhi` | `NotoSansGurmukhi-Regular.ttf` | `NotoSansGurmukhi-OFL.txt` | 36.2 KB |

The pure `splitScriptRuns(text, options?)` returns ordered `{fontId, text}`
runs without normalizing text. Kana selects JP, Hangul selects KR, and Han
within the same contiguous CJK token follows kana (JP) or Hangul (KR) context.
Whitespace and Latin separate those tokens. Otherwise Han selects SC, or the
`preferredHanFont: 'sc' | 'tc' | 'jp' | 'kr'` preparation option. The setting
persists for subsequent preparations in that document; reopened embedded runs
also provide their original regional font as the default for new Han glyphs.
Latin, Latin Extended, Vietnamese, and combining marks select `latin` when
they need Unicode fallback. Already-encodable text stays in its original font
or the existing Standard 14 fallback.

When added Latin is absent from a reopened Unicode subset, split-font export
retains covered Unicode scalars in the original font and sends only missing
Latin to the Standard 14 fallback. This needs no source-font load or CID/
ToUnicode rewrite. Adding fallback resources copies the effective resource
and font dictionaries so inherited resources remain unchanged.

Coverage uses the selected font's actual cmap. Missing glyphs try the selected
font first, then `sc -> tc -> jp -> kr`, skipping the selected font's duplicate.
The pure splitter accepts a `covers(fontId, codePoint)` predicate to apply
the same fallback without I/O. Unsupported scripts remain rejected even if
an injected font happens to contain their outlines.

Each source is lazy-loaded independently. The default loader fetches only needed
fonts (including cmap fallbacks)
from `${process.env.__NEXT_ROUTER_BASEPATH}/fonts/<file>` (empty basePath by
default). Assets are not JavaScript imports. Bytes, in-flight loads, and parsed
source metrics are cached per font; failed loads can be retried.
The legacy public `pdf.worker.min.mjs` is not referenced by current product
code; the native PDF worker is emitted with
`new URL('./pdf.worker.ts', import.meta.url)`. Tests and other consumers can pass
raw `Uint8Array` bytes or an asynchronous loader function instead of fetching;
a single source supplies every selected id. A partial font-id record supplies
independent sources, for example `{ sc: scBytes, tc: async () => tcBytes }`;
unspecified ids use the default loader. Keep injected source bytes immutable.

#### Complex-script shaping and wasm loading

Thai (U+0E00–U+0E7F), Devanagari (U+0900–U+097F), Bengali
(U+0980–U+09FF), Tamil (U+0B80–U+0BFF), Telugu (U+0C00–U+0C7F),
Kannada (U+0C80–U+0CFF), Malayalam (U+0D00–U+0D7F), Gujarati
(U+0A80–U+0AFF), and Gurmukhi (U+0A00–U+0A7F) select their own fonts.
Adjacent joiners (ZWJ/ZWNJ), dotted circle, and danda inherit the shaping
script; otherwise danda selects Devanagari. Latin/CJK/Vietnamese keep the
part-1 scalar path. Arabic, Hebrew, directional controls, and emoji remain rejected,
even if an injected font could encode them.

`src/engine/fonts/shaping.ts` lazily imports the MIT `harfbuzzjs` package.
The installed 1.6.3 package initializes its wasm asynchronously before the
import resolves. In the browser, its
`new URL('harfbuzz.wasm', import.meta.url)` is a webpack-emitted asset URL;
the package fetches/instantiates that URL, with an ArrayBuffer fallback if
streaming compilation is unavailable. No public wasm copy, CDN, or binary
modification is needed. The configured dev/build commands use webpack;
`next.config.ts` disables resolution of Emscripten's Node-only `module` import
in client bundles. In Node/Vitest, the package reads its installed
`node_modules/harfbuzzjs/dist/harfbuzz.wasm` with `fs`. Browser asset emission
and deployment still require build/runtime verification.

The shaping wasm is about 431 KB uncompressed; `harfbuzz-subset.wasm` is
not loaded. The JS wrapper/loader adds about 112 KB before compression.
Only a needed Thai/Indic span triggers wasm loading; Latin/CJK/Vietnamese
do not. Immutable source byte identities cache HarfBuzz blob/face/font and
a resettable buffer. HarfBuzz retains its own font copy in wasm memory;
source bytes and parsed metrics also remain cached. Shaping output and
export subsets are computed on demand, not eagerly for all nine fonts.

`shapeText(bytes, text, script, 'ltr')` returns original-text clusters with
`{gid, advance, xOffset, yOffset}` glyphs in source-font units.
`shapeTextSync` is the synchronous counterpart after `prepareShaping`.
Explicit ISO script tags, LTR direction, and monotone grapheme clusters
apply GSUB conjuncts/reordering and GPOS placement without normalizing the
input. `prepareTextForExport` always shapes complex-script spans, even if the
original PDF font has a Unicode encoder, before publishing font graphs.
Preflight checks shaped glyph coverage as well as scalar coverage: previously
prepared scalars alone do not imply that a new conjunct is exportable.

Complex-script CIDs identify source glyph IDs, not Unicode scalars.
`subsetTrueType` accepts an optional fifth glyph-ID iterable, retaining the
same composite closure/renumbering; existing scalar callers are unchanged.
The Type0/Identity-H/CIDFontType2 graph maps those CIDs to dense subset GIDs.
`/W` contains nominal glyph advances from hmtx in 1000/em; each `TJ` applies
the difference to HarfBuzz's contextual advance and its horizontal offset.
`Ts` applies vertical offsets in text-space points and is reset after each
cluster. Saved/restored text state prevents per-glyph character spacing or
rise from leaking into following runs.

Every shaped cluster is wrapped in
`/Span << /ActualText <FEFF...UTF-16BE...> >> BDC ... EMC`, preserving its
original Unicode sequence, including conjuncts, reordered vowels, and joiners.
Nominal 1:1 glyphs also receive ToUnicode entries. The interpreter handles
nested ActualText spans and preserves the positioned glyphs separately from
logical extraction text; baseline/reading order use the cluster's logical
pen position rather than displaced marks. The native canvas renderer draws
these glyphs from subset outlines through CIDToGIDMap, not by reshaping
ActualText with a substitute font. Poppler extraction and visual rendering
remain unverified until exercised externally.

Existing ActualText runs cannot be edited in place or receive per-glyph style
changes. UI entry, direct text edits, line edits, and style edits reject them
before content/resource mutations with a clear message; add a new text box
instead. A reopened shaped graph is never reconstructed as a scalar graph:
appending new shaped text creates a separate graph and leaves the original
CID assignments/program untouched. Subsequent preparations within the same
live graph union used glyphs and retain existing CIDs.

Floating boxes currently have fixed/minimum/user-resized DOM widths, not a
font-dependent content-width measurement. Export's content-dependent wrapping
and underline widths run only after async font/wasm preparation and use
HarfBuzz advances. Oversized Thai/Indic words may overflow a width limit rather
than splitting a conjunct at an arbitrary Unicode scalar. Preparation retains
the existing script-neutral "Loading font..." status and warning/pending-text
failure contract.

#### TrueType subset and PDF objects

- `src/engine/fonts/ttf-subsetter.ts` exposes `subsetTrueType`. It reads static
  sfnt TrueType `head`, `hhea`, `hmtx`, `maxp`, Unicode `cmap` (including formats
  4 and 12), `loca`, and `glyf`. It retains `.notdef` and the transitive closure
  of composite components, assigns dense GIDs, and rewrites component IDs,
  metrics, and the used-character cmap. The output uses legal short or long
  loca offsets, aligned tables, directory checksums, and head checksum
  adjustment. Hinting tables `cvt `, `fpgm`, and `prep` are preserved when present;
  `post` is written as format 3. Subset names replace original family names
  while retaining source copyright, attribution, and license name records.
- `src/engine/fonts/unicode-font-embed.ts` prepares a Type0 `/Identity-H` font
  with a CIDFontType2 descendant, a binary `/CIDToGIDMap`, `/W` advances scaled
  from hmtx to 1000/em, and a symbolic FontDescriptor (Flags 4). `/FontFile2`
  contains the Flate-compressed subset and an uncompressed `/Length1`.
  Six-letter subset tags prefix the registry's `NotoSansSC`, `NotoSansTC`,
  `NotoSansJP`, `NotoSansKR`, or `NotoSans` name.
  Descriptor ascent/descent use signed `hhea` metrics (OS/2 typo metrics when
  absent), and `head` bounds are scaled to 1000/em. Cap height comes from OS/2
  when positive, italic angle from `post`, and StemV defaults to 80.
- For part-1 fonts, compact two-byte CIDs identify Unicode scalars, not UTF-8
  bytes or guessed glyph IDs. `/ToUnicode` maps every used CID to UTF-16BE,
  including surrogate pairs for supplementary scalars, in bounded bfchar blocks.
- A document object map owns one live graph per used font. Subsequent preparations
  union each font's scalar set (shaped glyph set for complex scripts), retain
  existing CIDs and object references, and regenerate the subset, widths,
  CIDToGIDMap, and ToUnicode. Save/reopen
  recovers each regional compact-CID graph. Full source fonts remain available
  for new glyphs. Concurrent preparations are serialized; restored object
  graphs invalidate stale subset coverage. Multi-font preparation stages all
  graphs before publishing any of them to the document.
- Newly added Standard 14 page, annotation, signature, and AcroForm resource
  fonts are indirect objects. Their references remain resolvable across full
  and explicitly incremental saves, including the worker bridge.

Only used outlines, composite dependencies, retained metrics/hinting/metadata,
and the PDF font graph increase exported PDF size—not the entire source font.
Exact subset size depends on glyphs and retained hinting tables. Source font
embedding permissions are checked before publishing the graph.
The assets are distributed under SIL OFL-1.1; their copyright and license paths
are listed in the registry above. Exported documents are not themselves subject
to the OFL font-software license.

#### Commit, layout, and save behavior

New Add Text Box placeholders are selected in full on their first focus.
The creation-only selection is consumed once; existing boxes retain native
caret and focus behavior.

Preparation validates coverage, builds the subset, and compresses it before
publishing PDF objects. Load, parse, subset, or compression failures become
`UnsupportedGlyphsError`; missing scalars retain deduplicated `characters` and
`codePoints` in first-seen order. The dismissible warning
"These characters need an embedded font: ..." remains for unavailable glyphs.
Failed preparation leaves pending text, overlays, edit sessions, and PDF
resources/content intact; no lossy download is attempted.

Mixed edits emit adjacent text-show runs: encodable characters stay in their
original font, otherwise Latin/Symbol/Dingbats use the existing Standard 14
fallbacks, and remaining covered scalars use their selected embedded fonts with
hex Identity-H operands. Font switches share one text object and use each font's
own advances; resource names avoid existing fonts and one another.
Quote operators retain their spacing and line movement;
grouped operands do not repeat the replacement. The prior font is restored for
following text. New floating text wraps using the selected advances, including
CJK token splitting, and line-edit layout uses embedded widths rather than a
Latin average. Identity-H CIDs do not receive single-byte code-32 word spacing.

Adjacent same-font shows on the same baseline can form one editable run;
replacing that run replaces all its source operands, so `newText` must include
any suffix to retain. To replace only one show inside a merged run, target that
show's source instruction index and corresponding text/glyph span instead of
all merged indices. Other shows remain in place and use the restored font;
their text may merge with the final replacement run when interpreted again.

Inherited font resource dictionaries are copied before adding membership.

Both quick and optimized saves include the reachable font graph. Explicit
incremental quick saves also register changed font objects, page resources,
and content references, including the browser worker path. Browser FontFace
registration distinguishes font byte identities so an extended subset cannot
reuse the preceding subset's loaded face.

Synchronous `insertTextRun`/`applyTextEdits` still preflight: callers must await
preparation before submitting previously unsupported text. Without preparation,
the phase-1 warning/error contract remains unchanged. Existing WinAnsi
punctuation substitutions and finite Symbol/Dingbats encodings are unchanged.

Boundaries: static TrueType `glyf` outlines only; shaping is LTR only, with no
vertical text or bidirectional layout. Arabic/Hebrew/RTL and emoji retain
`UnsupportedGlyphsError`. No per-glyph style editing after shaped export.
Han unification cannot infer language from Han alone: default
SC glyph shapes remain unless kana/Hangul context or `preferredHanFont` selects
a regional face. CFF, variable-font instantiation, WOFF/WOFF2, and font
collections are not subset by this API. Coverage is the asset's actual cmap,
not its family name.

Regression sources:
`src/engine/__tests__/ttf-subsetter.test.ts`,
`src/engine/__tests__/unicode-font-embed.test.ts`,
`src/engine/__tests__/unicode-font-export.test.ts`,
`src/engine/__tests__/script-fonts.test.ts`,
`src/engine/__tests__/multiscript-font-export.test.ts`,
`src/engine/__tests__/shaping.test.ts`, and
`src/engine/__tests__/shaped-font-export.test.ts`.
They include independent sfnt/checksum/loca/composite inspection, native font
and CMap reparsing, quick/optimized export round trips, supplementary scalars,
and committed-font outline comparisons. Cross-viewer visual validation remains
a separate check; these tests do not prove appearance in Chrome or another PDF
viewer.

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
