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

### Unsupported glyphs and on-demand Unicode font embedding

Floating text and existing-run edits have an asynchronous preparation stage
before content compilation. `prepareTextForExport(objects, runs, source?, options?)`
collects scalars that the original font and Standard 14 fallbacks cannot
encode. Commits fully covered by those fonts do not load a Unicode font.
The editor displays the non-modal status "Loading font..." while preparation is pending.

`src/engine/fonts/script-fonts.ts` registers five static TrueType assets and
their SIL OFL-1.1 license files in `public/fonts/`:

| Font id | Asset | License |
| --- | --- | --- |
| `sc` | `NotoSansSC-Regular.ttf` | `NotoSansSC-OFL.txt` |
| `tc` | `NotoSansTC-Regular.ttf` | `NotoSansTC-OFL.txt` |
| `jp` | `NotoSansJP-Regular.ttf` | `NotoSansJP-OFL.txt` |
| `kr` | `NotoSansKR-Regular.ttf` | `NotoSansKR-OFL.txt` |
| `latin` | `NotoSans-Regular.ttf` | `NotoSans-OFL.txt` |

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

Coverage uses the selected font's actual cmap. Missing glyphs try the selected
font first, then `sc -> tc -> jp -> kr`, skipping the selected font's duplicate.
The pure splitter accepts a `covers(fontId, codePoint)` predicate to apply
the same fallback without I/O. Unsupported scripts remain rejected even if
an injected font happens to contain their outlines.

Each source is lazy-loaded independently; per-font byte sizes are not measured
here. The default loader fetches only needed fonts (including cmap fallbacks)
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
- Compact two-byte CIDs identify Unicode scalars, not UTF-8 bytes or guessed
  glyph IDs. `/ToUnicode` maps every used CID to UTF-16BE, including surrogate
  pairs for supplementary scalars, in bounded bfchar blocks.
- A document object map owns one graph per used font. Subsequent preparations
  union each font's scalar set, retain its existing CIDs and object references,
  and regenerate its subset, widths, CIDToGIDMap, and ToUnicode. Save/reopen
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

Boundaries: static TrueType `glyf` outlines only; no shaping or vertical text.
Thai, Indic scripts (including Devanagari), Arabic/RTL, and emoji are not
supported yet and retain `UnsupportedGlyphsError` with the exact unavailable
characters. Han unification cannot infer language from Han alone: default
SC glyph shapes remain unless kana/Hangul context or `preferredHanFont` selects
a regional face. CFF, variable-font instantiation, WOFF/WOFF2, and font
collections are not subset by this API. Coverage is the asset's actual cmap,
not its family name.

Regression sources:
`src/engine/__tests__/ttf-subsetter.test.ts`,
`src/engine/__tests__/unicode-font-embed.test.ts`,
`src/engine/__tests__/unicode-font-export.test.ts`,
`src/engine/__tests__/script-fonts.test.ts`, and
`src/engine/__tests__/multiscript-font-export.test.ts`.
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
