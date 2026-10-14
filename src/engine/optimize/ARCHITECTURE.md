# PDF Optimization Engine (Phase 9)

Object reachability analysis, stream deduplication, and garbage collection for smaller, cleaner PDF files.

## Problem

Incremental edits, form flattening, and annotation removal leave orphaned indirect objects. Duplicate image/font streams inflate file size. Optimization removes unreachable objects and collapses identical streams.

## Architecture

```
Map<string, PDFObject>
  → buildObjectGraph()       — refs from every object
  → computeReachability()    — DFS from trailer roots
  → deduplicateStreams()     — FNV-1a content hash clusters
  → applyRefMap()            — rewrite refs to keeper objects
  → garbageCollect()         — delete unreachable keys
  → writer/serializer        — emit compact file (future linearization)
```

## ISO 32000-2 References

| Topic | Section |
|-------|---------|
| Indirect objects | §7.3.10 |
| Trailer /Root | §7.5.5 |
| Object streams | §7.5.7 |
| Incremental updates | §7.5.6 |

Removing unreachable objects is spec-compliant when all live roots remain reachable from `/Root`.

## Reachability Graph

**Nodes:** object keys `"objNum_genNum"`.

**Edges:** every `PDFRef` found in dicts, arrays, and stream dicts.

**Roots:** `/Root`, `/Info`, `/Encrypt` from trailer + optional extra roots (e.g. `/AcroForm` during partial GC).

### DFS Algorithm

```
reachable ← ∅
stack ← roots
while stack not empty:
  k ← pop(stack)
  if k ∈ reachable or k ∉ nodes: continue
  reachable ← reachable ∪ {k}
  for each edge (k → t): push(t)
unreachable ← nodes \ reachable
```

**Complexity:** O(V + E) where V = objects, E = references.

**Memory:** O(V + E) for adjacency lists.

## Stream Deduplication

1. For each `PDFStream`, hash decoded bytes with FNV-1a (32-bit, hex)
2. Group keys by hash
3. Keeper = lowest object number in group
4. `refMap[duplicate] = keeper`
5. `applyRefMap` deep-remaps all `PDFRef` instances

**Bytes saved:** sum of duplicate stream payload lengths (metadata dicts may still differ — future: merge dicts).

## garbageCollect()

```
1. optional deduplicateStreams → applyRefMap
2. graph ← buildObjectGraph(objects, roots)
3. {reachable, unreachable} ← computeReachability(graph)
4. delete keys in unreachable from object map
5. return stats + new map
```

## Gap Analysis vs Adobe Acrobat

| Feature | Acrobat "Save Optimized" | This engine |
|---------|--------------------------|-------------|
| Remove unused objects | Yes | `garbageCollect()` |
| Duplicate image merge | Yes | `deduplicateStreams()` |
| Font subsetting | Yes | `subsetFonts()` |
| Linearization | Yes | Not yet |
| Object streams | Yes | `serializeDocumentCompact()` |
| Recompress Flate | Yes | `recompressStreams()` |
| JPEG re-quantize | Yes | Not yet |

## Edge Cases

- Circular refs → DFS handles via visited set
- Encrypt dict root → must include `/Encrypt` or encrypted content breaks
- Multiple revisions → GC on merged object map only; raw incremental bytes separate
- Zero-byte streams → skipped in dedup

### Editing and save invariants

- Pages parsed, hydrated, restored from history, or copied between documents retain
  ownership of empty content-reference arrays. The first content update allocates
  an indirect stream and attaches `/Contents` to the page dictionary. Explicit
  incremental saves include both objects; optimized saves retain the stream
  through the new page reference.
- Undo of an originally contentless page restores the absence of `/Contents`.
  It must not compile an empty snapshot into a new stream.
- Image resource entries can share one stream across names, pages, and forms.
  Replacement uses a new image object and page-local resource membership when
  shared, but retains the original stream/reference for a single-use image.
  New encoding dictionaries contain only newly generated keys; opaque PNGs have
  no soft mask, and PNGs with alpha reference a newly generated mask.

## Testing Strategy

- Chain A→B→C, root A: GC keeps A,B,C
- Orphan D: GC removes D
- Two identical streams: refMap maps duplicate to keeper
- Encrypt root present: encrypted objects still reachable via chain

## Hash Function

FNV-1a 32-bit (browser-safe, no Node crypto required):

\[
\text{hash} \leftarrow (\text{hash} \oplus \text{byte}) \times 16777619 \pmod{2^{32}}
\]

Initial offset basis: `0x811c9dc5`.
