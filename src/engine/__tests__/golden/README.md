# Golden Render Corpus

Strategy for Acrobat-class visual regression:

1. Curate PDFs under `fixtures/` (resume, brochure, form, scan-with-text).
2. Render each page at scale `1.0` with `renderPage()`.
3. Compare canvas pixel buffers (or PNG hashes) against committed goldens.
4. Allow small tolerance for antialiasing (ΔE or max 2% pixel diff).

## Minimal smoke test

`golden-smoke.test.ts` builds a synthetic one-page PDF with `pdf-lib` and renders
it through the real engine and native `canvas` implementation. It checks page
dimensions, extracted text, a black rectangle pixel, and a white background
pixel. Parser, renderer, and assertion failures propagate; there is no soft skip.

The test requires the existing `canvas` optional dependency installed through
Fabric. Do not omit optional dependencies when installing for CI.
