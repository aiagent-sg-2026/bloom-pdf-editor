# PDF worker architecture

`PDFDocumentData` remains the authoritative, mutable document on the main thread. The worker never receives that object directly: `codec.ts` encodes its class graph as an explicit node-ID wire graph, preserving aliases, maps, references, streams, pages, and trailer data. The client hydrates responses into real PDF classes and prototypes.

Parsing runs in the worker and hydrates on the main thread. Save and optimize encode a snapshot first; the worker hydrates that snapshot, so optimization's garbage collection and deduplication do not mutate the live document. Byte buffers sent to the worker are copies before transfer.

Snapshot encoding still requires main-thread traversal and byte copying. PWA-005 therefore moves parse and serialization CPU off-thread but does not claim zero main-thread work.

When `Worker` is unavailable, construction fails, or a worker request errors, the client calls the existing parser and writer directly with the same public signatures. Static hosting remains supported because the worker is emitted through the bundler using `new URL('./pdf.worker.ts', import.meta.url)`.

The production `build` script intentionally uses `next build --webpack` as a temporary constraint. With Next 16.2.11, Turbopack static export currently treats this `new URL('./pdf.worker.ts', import.meta.url)` pattern as a raw media asset (`pdf.worker.<hash>.ts`) containing uncompiled TypeScript. Webpack emits a compiled executable worker JavaScript chunk instead. The PDF-worker guard checks static exports for both conditions.

Quick saves use one combined wire graph for `document.objects` and `newObjects`; `newObjectKeys` identifies the incremental subset. This preserves aliases between the two maps. After a successful worker quick save, the client applies the legacy incremental writer side effect by adding those objects to the live document and advances live `rawBytes` only when the incremental writer advanced the worker document's `rawBytes`. Full serialization and fallback saves do not blindly update it. Optimized fallback creates a fresh snapshot only after worker failure, so garbage collection and deduplication cannot mutate the live document.
