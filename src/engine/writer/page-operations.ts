/**
 * Page Operations
 *
 * Structural operations on PDF page trees:
 *   - Delete pages
 *   - Reorder pages
 *   - Rotate pages
 *   - Extract pages into a new document
 *   - Merge pages from another document
 *   - Insert blank pages
 *
 * All operations modify the in-memory document structure.
 * Call the serializer or incremental writer to produce output bytes.
 */

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFNull,
  PDFObject,
  PDFRef,
  PDFStream,
  PDFString,
  type PDFDocumentData,
  type PDFPageInfo,
  type PDFRectangle,
} from '../types';
import { resolveRef } from '../parser/parser';
import { getNextObjNum } from './serializer';
import { bindPageContentRefs } from '../editor/stream-compiler';

// ─── Page deletion ──────────────────────────────────────────────────────────

/**
 * Delete a page from the document by index.
 * Modifies the document's page tree and updates the pages array.
 */
export function deletePage(doc: PDFDocumentData, pageIndex: number): void {
  if (pageIndex < 0 || pageIndex >= doc.pages.length) {
    throw new Error(`Page index ${pageIndex} out of range`);
  }
  if (doc.pages.length <= 1) {
    throw new Error('Cannot delete the last page');
  }

  const page = doc.pages[pageIndex];

  // Remove only destinations that point at the deleted page. The rest of the
  // outline tree remains valid and must survive page operations.
  removeDeletedPageDestinations(doc, page.ref);

  // Remove the leaf and update every affected page-tree node.
  removePageFromTree(page.ref, doc.catalog, doc.objects);

  // Remove from our pages array
  doc.pages.splice(pageIndex, 1);

  // Re-index remaining pages
  for (let i = pageIndex; i < doc.pages.length; i++) {
    doc.pages[i].index = i;
  }
}

function containsRef(obj: PDFObject, target: PDFRef, objects: Map<string, PDFObject>, seen = new Set<string>()): boolean {
  if (obj instanceof PDFRef) {
    if (obj.equals(target)) return true;
    const key = obj.toKey();
    if (seen.has(key)) return false;
    seen.add(key);
    const resolved = objects.get(key);
    return resolved ? containsRef(resolved, target, objects, seen) : false;
  }
  if (obj instanceof PDFArray) return obj.items.some((item) => containsRef(item, target, objects, seen));
  if (obj instanceof PDFDict) return Array.from(obj.values()).some((value) => containsRef(value, target, objects, seen));
  if (obj instanceof PDFStream) return containsRef(obj.dict, target, objects, seen);
  return false;
}

/**
 * Check a destination or action for a page reference without walking through
 * page dictionaries. A page dictionary points back into the shared page tree,
 * so resolving a destination's surviving page ref with containsRef() can
 * incorrectly discover the page being deleted through a sibling /Kids entry.
 */
function containsDestinationRef(
  obj: PDFObject,
  target: PDFRef,
  objects: Map<string, PDFObject>,
  seen = new Set<string>(),
): boolean {
  if (obj instanceof PDFRef) {
    if (obj.equals(target)) return true;
    const key = obj.toKey();
    if (seen.has(key)) return false;
    seen.add(key);
    const resolved = objects.get(key);
    if (!(resolved instanceof PDFArray || resolved instanceof PDFDict || resolved instanceof PDFStream)) return false;
    if (resolved instanceof PDFDict && (resolved.getName('Type') === 'Page' || resolved.getName('Type') === 'Pages')) return false;
    return containsDestinationRef(resolved, target, objects, seen);
  }
  if (obj instanceof PDFArray) return obj.items.some((item) => containsDestinationRef(item, target, objects, seen));
  if (obj instanceof PDFDict) return Array.from(obj.values()).some((value) => containsDestinationRef(value, target, objects, seen));
  if (obj instanceof PDFStream) return containsDestinationRef(obj.dict, target, objects, seen);
  return false;
}

function outlineList(doc: PDFDocumentData, first: PDFObject | undefined): PDFRef[] {
  const refs: PDFRef[] = [];
  const seen = new Set<string>();
  let current = first;
  while (current instanceof PDFRef && !seen.has(current.toKey())) {
    seen.add(current.toKey());
    refs.push(current);
    const item = doc.objects.get(current.toKey());
    current = item instanceof PDFDict ? item.get('Next') : undefined;
  }
  return refs;
}

function rewriteOutlineList(
  doc: PDFDocumentData,
  refs: PDFRef[],
  parent: PDFRef,
  pageRef: PDFRef,
): PDFRef[] {
  const kept: PDFRef[] = [];
  for (const ref of refs) {
    const item = doc.objects.get(ref.toKey());
    if (!(item instanceof PDFDict)) continue;

    const children = rewriteOutlineList(doc, outlineList(doc, item.get('First')), ref, pageRef);
    const drops = containsDestinationRef(item.get('Dest') ?? PDFNull.instance, pageRef, doc.objects) ||
      containsDestinationRef(item.get('A') ?? PDFNull.instance, pageRef, doc.objects);

    if (drops) {
      // Promote children of a deleted parent so a surviving subtree is not
      // lost merely because its heading pointed at the removed page.
      for (const childRef of children) {
        const child = doc.objects.get(childRef.toKey());
        if (child instanceof PDFDict) child.set('Parent', parent);
      }
      kept.push(...children);
      continue;
    }

    item.set('Parent', parent);
    if (children.length > 0) {
      item.set('First', children[0]);
      item.set('Last', children[children.length - 1]);
      item.set('Count', new PDFNumber(children.length));
    } else {
      item.delete('First');
      item.delete('Last');
      item.delete('Count');
    }
    kept.push(ref);
  }

  for (let i = 0; i < kept.length; i++) {
    const item = doc.objects.get(kept[i].toKey());
    if (!(item instanceof PDFDict)) continue;
    if (i > 0) item.set('Prev', kept[i - 1]); else item.delete('Prev');
    if (i + 1 < kept.length) item.set('Next', kept[i + 1]); else item.delete('Next');
  }
  return kept;
}

/**
 * Prune destination name-tree pairs, preserving sibling trees and updating
 * bounds up through /Kids. Cyclic or unrecognized nodes are left intact.
 */
function pruneDestinationTree(
  doc: PDFDocumentData,
  tree: PDFObject,
  pageRef: PDFRef,
  seen = new Set<PDFDict>(),
): 'unchanged' | 'changed' | 'empty' {
  const node = resolveRef(tree, doc.objects);
  if (!(node instanceof PDFDict) || seen.has(node)) return 'unchanged';
  seen.add(node);
  const names = resolveRef(node.get('Names') ?? PDFNull.instance, doc.objects);
  const kids = resolveRef(node.get('Kids') ?? PDFNull.instance, doc.objects);
  let changed = false;
  if (names instanceof PDFArray) {
    for (let i = 0; i + 1 < names.items.length;) {
      if (containsDestinationRef(names.items[i + 1], pageRef, doc.objects)) {
        names.items.splice(i, 2);
        changed = true;
      } else {
        i += 2;
      }
    }
  }
  if (kids instanceof PDFArray) {
    for (let i = 0; i < kids.items.length;) {
      const result = pruneDestinationTree(doc, kids.items[i], pageRef, seen);
      if (result !== 'unchanged') changed = true;
      if (result === 'empty') kids.items.splice(i, 1); else i++;
    }
  }
  if (!changed) return 'unchanged';
  if (names instanceof PDFArray && names.length === 0) node.delete('Names');
  if (kids instanceof PDFArray && kids.length === 0) node.delete('Kids');
  if (!node.has('Names') && !node.has('Kids')) return 'empty';

  let first: PDFObject | undefined;
  let last: PDFObject | undefined;
  if (names instanceof PDFArray && names.length > 0 && names.length % 2 === 0) {
    first = names.items[0];
    last = names.items[names.length - 2];
  } else if (kids instanceof PDFArray && kids.length > 0) {
    const firstChild = resolveRef(kids.items[0], doc.objects);
    const lastChild = resolveRef(kids.items[kids.length - 1], doc.objects);
    const firstLimits = resolveRef(firstChild instanceof PDFDict ? firstChild.get('Limits') ?? PDFNull.instance : PDFNull.instance, doc.objects);
    const lastLimits = resolveRef(lastChild instanceof PDFDict ? lastChild.get('Limits') ?? PDFNull.instance : PDFNull.instance, doc.objects);
    if (firstLimits instanceof PDFArray) first = firstLimits.items[0];
    if (lastLimits instanceof PDFArray) last = lastLimits.items[1];
  }
  if ((first instanceof PDFString || first instanceof PDFHexString) &&
      (last instanceof PDFString || last instanceof PDFHexString)) {
    node.set('Limits', new PDFArray([first, last]));
  } else {
    // Malformed bounds must not remain stale after pruning.
    node.delete('Limits');
  }
  return 'changed';
}

function removeDeletedPageDestinations(doc: PDFDocumentData, pageRef: PDFRef): void {
  const catalog = doc.catalog;
  const outlines = catalog.get('Outlines');
  const outlineRoot = outlines instanceof PDFRef ? doc.objects.get(outlines.toKey()) : outlines;
  if (outlineRoot instanceof PDFDict) {
    const kept = rewriteOutlineList(doc, outlineList(doc, outlineRoot.get('First')), outlines as PDFRef, pageRef);
    if (kept.length > 0) {
      outlineRoot.set('First', kept[0]);
      outlineRoot.set('Last', kept[kept.length - 1]);
      outlineRoot.set('Count', new PDFNumber(kept.length));
    } else {
      catalog.delete('Outlines');
    }
  }

  // Prune legacy catalog destinations individually so surviving named
  // destinations remain valid after page deletion.
  const dests = catalog.get('Dests');
  const destDict = resolveRef(dests ?? PDFNull.instance, doc.objects);
  if (destDict instanceof PDFDict) {
    let changed = false;
    for (const [name, destination] of Array.from(destDict.entries())) {
      if (containsDestinationRef(destination, pageRef, doc.objects)) {
        destDict.delete(name);
        changed = true;
      }
    }
    if (changed && destDict.size === 0) catalog.delete('Dests');
  }

  const names = resolveRef(catalog.get('Names') ?? PDFNull.instance, doc.objects);
  if (names instanceof PDFDict) {
    const destTree = names.get('Dests');
    if (destTree && pruneDestinationTree(doc, destTree, pageRef) === 'empty') {
      names.delete('Dests');
      if (names.size === 0) catalog.delete('Names');
    }
  }

  for (const page of doc.pages) {
    const annots = page.dict.get('Annots');
    const arr = annots instanceof PDFArray
      ? annots
      : annots instanceof PDFRef && doc.objects.get(annots.toKey()) instanceof PDFArray
        ? doc.objects.get(annots.toKey()) as PDFArray
        : null;
    if (!arr) continue;
    const kept = arr.items.filter((item) => {
      const annotation = item instanceof PDFRef ? doc.objects.get(item.toKey()) : item;
      return !(annotation instanceof PDFDict && annotation.getName('Subtype') === 'Link' &&
        (containsDestinationRef(annotation.get('Dest') ?? PDFNull.instance, pageRef, doc.objects) ||
          containsDestinationRef(annotation.get('A') ?? PDFNull.instance, pageRef, doc.objects)));
    });
    if (kept.length === 0) {
      page.dict.delete('Annots');
      if (annots instanceof PDFRef) doc.objects.delete(annots.toKey());
    } else {
      arr.items.splice(0, arr.items.length, ...kept);
    }
  }
}

/**
 * Delete multiple pages at once (more efficient than calling deletePage repeatedly).
 * Indices should be in ascending order.
 */
export function deletePages(doc: PDFDocumentData, indices: number[]): void {
  // Sort descending so we don't invalidate indices
  const sorted = [...indices].sort((a, b) => b - a);
  for (const idx of sorted) {
    deletePage(doc, idx);
  }
}

// ─── Page reordering ────────────────────────────────────────────────────────

/**
 * Reorder pages according to a new index mapping.
 * @param newOrder Array where newOrder[newIndex] = oldIndex
 */
export function reorderPages(doc: PDFDocumentData, newOrder: number[]): void {
  if (newOrder.length !== doc.pages.length) {
    throw new Error('New order must have same number of pages');
  }

  // Validate all indices are present
  const seen = new Set<number>();
  for (const idx of newOrder) {
    if (idx < 0 || idx >= doc.pages.length || seen.has(idx)) {
      throw new Error(`Invalid page order: ${newOrder.join(', ')}`);
    }
    seen.add(idx);
  }

  // Reorder pages array
  const oldPages = [...doc.pages];
  for (let i = 0; i < newOrder.length; i++) {
    doc.pages[i] = oldPages[newOrder[i]];
    doc.pages[i].index = i;
  }

  // Rebuild the Kids array in the pages root
  rebuildKidsArray(doc);
}

/**
 * Move a page from one position to another.
 */
export function movePage(doc: PDFDocumentData, fromIndex: number, toIndex: number): void {
  if (fromIndex === toIndex) return;
  if (fromIndex < 0 || fromIndex >= doc.pages.length) throw new Error('Invalid from index');
  if (toIndex < 0 || toIndex >= doc.pages.length) throw new Error('Invalid to index');

  const newOrder = Array.from({ length: doc.pages.length }, (_, i) => i);
  const [removed] = newOrder.splice(fromIndex, 1);
  newOrder.splice(toIndex, 0, removed);
  reorderPages(doc, newOrder);
}

// ─── Page rotation ──────────────────────────────────────────────────────────

/**
 * Set the rotation of a page.
 * @param rotation Rotation in degrees (0, 90, 180, 270)
 */
export function rotatePage(doc: PDFDocumentData, pageIndex: number, rotation: number): void {
  if (pageIndex < 0 || pageIndex >= doc.pages.length) {
    throw new Error(`Page index ${pageIndex} out of range`);
  }

  // Normalize rotation
  const normalized = ((rotation % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(normalized)) {
    throw new Error('Rotation must be 0, 90, 180, or 270 degrees');
  }

  const page = doc.pages[pageIndex];
  page.rotate = normalized;
  page.dict.set('Rotate', new PDFNumber(normalized));
}

/**
 * Rotate a page by a relative amount (add to current rotation).
 */
export function rotatePageBy(doc: PDFDocumentData, pageIndex: number, degrees: number): void {
  const currentRotation = doc.pages[pageIndex].rotate;
  rotatePage(doc, pageIndex, currentRotation + degrees);
}

// ─── Page insertion ─────────────────────────────────────────────────────────

/**
 * Insert a blank page at the specified index.
 */
export function insertBlankPage(
  doc: PDFDocumentData,
  atIndex: number,
  size: PDFRectangle = { x: 0, y: 0, width: 612, height: 792 }, // US Letter
): void {
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > doc.pages.length) {
    throw new Error(`Page index ${atIndex} out of range`);
  }
  const nextObj = getNextObjNum(doc);

  // Create page dictionary
  const pageDict = new PDFDict();
  pageDict.set('Type', new PDFName('Page'));
  pageDict.set('MediaBox', new PDFArray([
    new PDFNumber(size.x),
    new PDFNumber(size.y),
    new PDFNumber(size.x + size.width),
    new PDFNumber(size.y + size.height),
  ]));

  // Set parent to root pages node
  const pagesRef = doc.catalog.getRef('Pages');
  if (pagesRef) pageDict.set('Parent', pagesRef);

  // Empty resources
  pageDict.set('Resources', new PDFDict());
  pageDict.set('Rotate', new PDFNumber(0));

  // Empty content stream
  const contentDict = new PDFDict();
  contentDict.set('Length', new PDFNumber(0));
  const contentStream = new PDFStream(contentDict, new Uint8Array(0), new Uint8Array(0));
  const contentRef = new PDFRef(nextObj + 1, 0);
  doc.objects.set(contentRef.toKey(), contentStream);
  pageDict.set('Contents', contentRef);

  // Store page object
  const pageRef = new PDFRef(nextObj, 0);
  doc.objects.set(pageRef.toKey(), pageDict);

  // Add to pages array
  const pageInfo: PDFPageInfo = {
    index: atIndex,
    dict: pageDict,
    mediaBox: size,
    cropBox: size,
    rotate: 0,
    ref: pageRef,
    resources: pageDict.getDict('Resources')!,
    contentRefs: [contentRef],
  };

  doc.pages.splice(atIndex, 0, bindPageContentRefs(pageInfo));

  // Re-index
  for (let i = atIndex; i < doc.pages.length; i++) {
    doc.pages[i].index = i;
  }

  // Rebuild page tree
  rebuildKidsArray(doc);
}

// ─── Page extraction and merging ──────────────────────────────────────────────

/**
 * Insert pages from a source document into a target document at a specific index.
 */
export function insertPagesFromDocument(
  target: PDFDocumentData,
  source: PDFDocumentData,
  insertAtIndex: number,
): void {
  if (!Number.isInteger(insertAtIndex) || insertAtIndex < 0 || insertAtIndex > target.pages.length) {
    throw new Error(`Page index ${insertAtIndex} out of range`);
  }
  const refMap = new Map<string, PDFRef>(); // old source key → new target ref

  function copyObject(obj: PDFObject): PDFObject {
    if (obj instanceof PDFRef) {
      const oldKey = obj.toKey();
      if (refMap.has(oldKey)) return refMap.get(oldKey)!;

      // Allocate new ref in target
      const newRef = new PDFRef(getNextObjNum(target), 0);
      refMap.set(oldKey, newRef);
      // Temporarily set it in target to reserve the ref and prevent infinite loops on circular refs
      target.objects.set(newRef.toKey(), new PDFDict()); 

      // Copy the referenced object from source
      const resolved = source.objects.get(oldKey);
      if (resolved) {
        target.objects.set(newRef.toKey(), copyObjectDeep(resolved));
      }

      return newRef;
    }
    return copyObjectDeep(obj);
  }

  function copyObjectDeep(obj: PDFObject): PDFObject {
    if (obj instanceof PDFDict) {
      const newDict = new PDFDict();
      const entries = Array.from(obj.entries());
      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i];
        // Skip Parent reference for pages so we can re-parent them to target's Pages tree
        if (key === 'Parent') continue;
        newDict.set(key, copyObject(value));
      }
      return newDict;
    }

    if (obj instanceof PDFArray) {
      return new PDFArray(obj.items.map((item) => copyObject(item)));
    }

    if (obj instanceof PDFStream) {
      const newStreamDict = copyObjectDeep(obj.dict) as PDFDict;
      return new PDFStream(
        newStreamDict,
        new Uint8Array(obj.rawBytes),
        obj.decodedBytes ? new Uint8Array(obj.decodedBytes) : null,
      );
    }

    if (obj instanceof PDFRef) {
      return copyObject(obj);
    }

    return obj;
  }

  const targetPagesRef = target.catalog.getRef('Pages');
  if (!targetPagesRef) throw new Error('Target document has no Pages root');

  const pagesToInsert: PDFPageInfo[] = [];

  for (let i = 0; i < source.pages.length; i++) {
    const srcPage = source.pages[i];
    if (!srcPage) continue;

    const pageRef = copyObject(srcPage.ref) as PDFRef;

    // Set parent to target pages node
    const pageDictObj = target.objects.get(pageRef.toKey());
    if (pageDictObj instanceof PDFDict) {
      pageDictObj.set('Parent', targetPagesRef);

      const copiedResources = copyObjectDeep(srcPage.resources) as PDFDict;
      pageDictObj.set('Resources', copiedResources);
      pageDictObj.set('MediaBox', new PDFArray([
        new PDFNumber(srcPage.mediaBox.x),
        new PDFNumber(srcPage.mediaBox.y),
        new PDFNumber(srcPage.mediaBox.x + srcPage.mediaBox.width),
        new PDFNumber(srcPage.mediaBox.y + srcPage.mediaBox.height),
      ]));
      pageDictObj.set('CropBox', new PDFArray([
        new PDFNumber(srcPage.cropBox.x),
        new PDFNumber(srcPage.cropBox.y),
        new PDFNumber(srcPage.cropBox.x + srcPage.cropBox.width),
        new PDFNumber(srcPage.cropBox.y + srcPage.cropBox.height),
      ]));
      pageDictObj.set('Rotate', new PDFNumber(srcPage.rotate));

      pagesToInsert.push(bindPageContentRefs({
        index: insertAtIndex + i,
        dict: pageDictObj,
        mediaBox: { ...srcPage.mediaBox },
        cropBox: { ...srcPage.cropBox },
        rotate: srcPage.rotate,
        ref: pageRef,
        resources: copiedResources,
        contentRefs: srcPage.contentRefs.map((ref) => {
          const mapped = refMap.get(ref.toKey());
          return (mapped as PDFRef) ?? ref;
        }),
      }));
    }
  }

  // Insert into target pages array
  target.pages.splice(insertAtIndex, 0, ...pagesToInsert);

  // Re-index pages
  for (let i = insertAtIndex; i < target.pages.length; i++) {
    target.pages[i].index = i;
  }

  // Rebuild page tree
  rebuildKidsArray(target);

  mergeInsertedAcroForm(target, source, refMap, pagesToInsert.map((page) => page.ref));
}

/** Copy only AcroForm fields that have widgets on the pages being inserted. */
function mergeInsertedAcroForm(
  target: PDFDocumentData,
  source: PDFDocumentData,
  refMap: Map<string, PDFRef>,
  insertedPageRefs: PDFRef[],
): void {
  const sourceAcroValue = source.catalog.get('AcroForm');
  const sourceAcro = sourceAcroValue instanceof PDFRef
    ? source.objects.get(sourceAcroValue.toKey())
    : sourceAcroValue;
  if (!(sourceAcro instanceof PDFDict)) return;

  const insertedPages = new Set(insertedPageRefs.map((ref) => ref.toKey()));
  const insertedWidgets = new Set<string>();
  for (const page of source.pages) {
    const annots = page.dict.get('Annots');
    const annotItems = annots instanceof PDFArray
      ? annots.items
      : annots instanceof PDFRef && source.objects.get(annots.toKey()) instanceof PDFArray
        ? (source.objects.get(annots.toKey()) as PDFArray).items
        : [];
    // The caller inserts every source page, so every source page is relevant.
    if (!insertedPages.size) continue;
    for (const annot of annotItems) {
      const ref = annot instanceof PDFRef ? annot : undefined;
      const value = ref ? source.objects.get(ref.toKey()) : annot;
      if (value instanceof PDFDict && value.getName('Subtype') === 'Widget' && ref) {
        insertedWidgets.add(ref.toKey());
      }
    }
  }
  if (!insertedWidgets.size) return;

  const relevantFields = new Set<string>();
  const fieldRoots = sourceAcro.get('Fields');
  const markField = (value: PDFObject): boolean => {
    const ref = value instanceof PDFRef ? value : undefined;
    const field = ref ? source.objects.get(ref.toKey()) : value;
    if (!(field instanceof PDFDict)) return false;
    const widget = ref && insertedWidgets.has(ref.toKey());
    const kids = field.get('Kids');
    let hasRelevantChild = false;
    if (kids instanceof PDFArray) {
      hasRelevantChild = kids.items.some(markField);
    }
    if (ref && (widget || hasRelevantChild)) relevantFields.add(ref.toKey());
    return widget || hasRelevantChild;
  };
  if (!(fieldRoots instanceof PDFArray)) return;
  fieldRoots.items.forEach(markField);

  const cloneField = (sourceRef: PDFRef): PDFRef => {
    const existing = refMap.get(sourceRef.toKey());
    if (existing) return existing;
    const newRef = new PDFRef(getNextObjNum(target), 0);
    refMap.set(sourceRef.toKey(), newRef);
    const sourceField = source.objects.get(sourceRef.toKey());
    if (!(sourceField instanceof PDFDict)) return newRef;
    const cloned = new PDFDict();
    target.objects.set(newRef.toKey(), cloned);
    for (const [key, value] of sourceField.entries()) {
      if (key === 'Parent') continue;
      if (key === 'Kids' && value instanceof PDFArray) {
        cloned.set('Kids', new PDFArray(value.items
          // Keep direct widgets as well as nested fields marked by the walk
          // above. Direct widgets are the common AcroForm shape and must stay
          // reachable even when their parent field is cloned after page copy.
          .filter((kid) => kid instanceof PDFRef &&
            (insertedWidgets.has(kid.toKey()) || relevantFields.has(kid.toKey())))
          .map((kid) => cloneField(kid as PDFRef))));
      } else {
        cloned.set(key, copyAcroValue(value));
      }
    }
    const kids = cloned.get('Kids');
    if (kids instanceof PDFArray) {
      for (const kid of kids.items) {
        const child = kid instanceof PDFRef ? target.objects.get(kid.toKey()) : undefined;
        if (child instanceof PDFDict) child.set('Parent', newRef);
      }
    }
    return newRef;
  };

  const copyAcroValue = (value: PDFObject): PDFObject => {
    if (value instanceof PDFRef) {
      const mapped = refMap.get(value.toKey());
      return mapped ?? value;
    }
    if (value instanceof PDFArray) return new PDFArray(value.items.map(copyAcroValue));
    if (value instanceof PDFDict) {
      const dict = new PDFDict();
      for (const [key, item] of value.entries()) dict.set(key, copyAcroValue(item));
      return dict;
    }
    if (value instanceof PDFStream) return new PDFStream(copyAcroValue(value.dict) as PDFDict, new Uint8Array(value.rawBytes), value.decodedBytes ? new Uint8Array(value.decodedBytes) : null);
    return value;
  };

  const acroValue = target.catalog.get('AcroForm');
  const targetAcro = acroValue instanceof PDFRef
    ? target.objects.get(acroValue.toKey())
    : acroValue;
  const acro = targetAcro instanceof PDFDict ? targetAcro : new PDFDict();
  if (!(targetAcro instanceof PDFDict)) target.catalog.set('AcroForm', acro);
  const targetFields = acro.get('Fields') instanceof PDFArray ? acro.get('Fields') as PDFArray : new PDFArray();
  if (!acro.has('Fields')) acro.set('Fields', targetFields);
  for (const root of fieldRoots.items) {
    if (root instanceof PDFRef && relevantFields.has(root.toKey())) targetFields.push(cloneField(root));
  }
  for (const key of ['DR', 'DA', 'NeedAppearances']) {
    if (!acro.has(key) && sourceAcro.has(key)) acro.set(key, copyAcroValue(sourceAcro.get(key)!));
  }
}


/**
 * Extract specific pages into a new document data structure.
 * The extracted document can be serialized independently.
 */
export function extractPages(
  doc: PDFDocumentData,
  pageIndices: number[],
): PDFDocumentData {
  const newObjects = new Map<string, PDFObject>();
  const newPages: PDFPageInfo[] = [];
  let nextObj = 1;

  // Copy referenced objects recursively
  const refMap = new Map<string, PDFRef>(); // old key → new ref

  function copyObject(obj: PDFObject): PDFObject {
    if (obj instanceof PDFRef) {
      const oldKey = obj.toKey();
      if (refMap.has(oldKey)) return refMap.get(oldKey)!;

      // Allocate new ref
      const newRef = new PDFRef(nextObj++, 0);
      refMap.set(oldKey, newRef);

      // Copy the referenced object
      const resolved = doc.objects.get(oldKey);
      if (resolved) {
        newObjects.set(newRef.toKey(), copyObjectDeep(resolved));
      }

      return newRef;
    }
    return copyObjectDeep(obj);
  }

  function copyObjectDeep(obj: PDFObject): PDFObject {
    if (obj instanceof PDFDict) {
      const newDict = new PDFDict();
      const entries = Array.from(obj.entries());
      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i];
        // Skip Parent reference to avoid circular refs
        if (key === 'Parent') continue;
        newDict.set(key, copyObject(value));
      }
      return newDict;
    }

    if (obj instanceof PDFArray) {
      return new PDFArray(obj.items.map((item) => copyObject(item)));
    }

    if (obj instanceof PDFStream) {
      const newStreamDict = copyObjectDeep(obj.dict) as PDFDict;
      return new PDFStream(
        newStreamDict,
        new Uint8Array(obj.rawBytes),
        obj.decodedBytes ? new Uint8Array(obj.decodedBytes) : null,
      );
    }

    if (obj instanceof PDFRef) {
      return copyObject(obj);
    }

    return obj;
  }

  // Create root pages node
  const pagesRef = new PDFRef(nextObj++, 0);
  const pagesDict = new PDFDict();
  pagesDict.set('Type', new PDFName('Pages'));

  // Copy selected pages
  const kidsRefs: PDFRef[] = [];

  for (let i = 0; i < pageIndices.length; i++) {
    const srcPage = doc.pages[pageIndices[i]];
    if (!srcPage) continue;

    const pageRef = copyObject(srcPage.ref) as PDFRef;
    kidsRefs.push(pageRef);

    // Set parent to new pages node
    const pageDictObj = newObjects.get(pageRef.toKey());
    if (pageDictObj instanceof PDFDict) {
      pageDictObj.set('Parent', pagesRef);

      const copiedResources = copyObjectDeep(srcPage.resources) as PDFDict;
      pageDictObj.set('Resources', copiedResources);
      pageDictObj.set('MediaBox', new PDFArray([
        new PDFNumber(srcPage.mediaBox.x),
        new PDFNumber(srcPage.mediaBox.y),
        new PDFNumber(srcPage.mediaBox.x + srcPage.mediaBox.width),
        new PDFNumber(srcPage.mediaBox.y + srcPage.mediaBox.height),
      ]));
      pageDictObj.set('CropBox', new PDFArray([
        new PDFNumber(srcPage.cropBox.x),
        new PDFNumber(srcPage.cropBox.y),
        new PDFNumber(srcPage.cropBox.x + srcPage.cropBox.width),
        new PDFNumber(srcPage.cropBox.y + srcPage.cropBox.height),
      ]));
      pageDictObj.set('Rotate', new PDFNumber(srcPage.rotate));

      newPages.push(bindPageContentRefs({
        index: i,
        dict: pageDictObj,
        mediaBox: { ...srcPage.mediaBox },
        cropBox: { ...srcPage.cropBox },
        rotate: srcPage.rotate,
        ref: pageRef,
        resources: copiedResources,
        contentRefs: srcPage.contentRefs.map((ref) => {
          const mapped = refMap.get(ref.toKey());
          return (mapped as PDFRef) ?? ref;
        }),
      }));
    }
  }

  pagesDict.set('Kids', new PDFArray(kidsRefs));
  pagesDict.set('Count', new PDFNumber(kidsRefs.length));
  newObjects.set(pagesRef.toKey(), pagesDict);

  // Create catalog
  const catalogRef = new PDFRef(nextObj++, 0);
  const catalogDict = new PDFDict();
  catalogDict.set('Type', new PDFName('Catalog'));
  catalogDict.set('Pages', pagesRef);
  newObjects.set(catalogRef.toKey(), catalogDict);

  // Build xref
  const trailerDict = new PDFDict();
  trailerDict.set('Size', new PDFNumber(nextObj));
  trailerDict.set('Root', catalogRef);

  return {
    version: doc.version,
    objects: newObjects,
    xref: { entries: new Map(), trailerDict },
    catalog: catalogDict,
    pages: newPages,
    info: { ...doc.info },
    rawBytes: new Uint8Array(0),
  };
}

// ─── Page tree helpers ──────────────────────────────────────────────────────

function removePageFromTree(
  pageRef: PDFRef,
  catalog: PDFDict,
  objects: Map<string, PDFObject>,
): void {
  const pagesRef = catalog.getRef('Pages');
  if (!pagesRef) return;

  const pagesObj = resolveRef(pagesRef, objects);
  if (!(pagesObj instanceof PDFDict)) return;

  const visited = new Set<PDFDict>();
  function removeFromNode(node: PDFDict): boolean {
    if (visited.has(node)) return false;
    visited.add(node);
    const kidsObj = node.get('Kids');
    const kids = kidsObj ? resolveRef(kidsObj, objects) : undefined;
    if (!(kids instanceof PDFArray)) return false;

    for (let i = 0; i < kids.items.length; i++) {
      const kid = kids.items[i];
      if (kid instanceof PDFRef && kid.equals(pageRef)) {
        kids.items.splice(i, 1);
      } else {
        const child = resolveRef(kid, objects);
        if (!(child instanceof PDFDict) || child.getName('Type') !== 'Pages' || !removeFromNode(child)) {
          continue;
        }
        const childKidsObj = child.get('Kids');
        const childKids = childKidsObj ? resolveRef(childKidsObj, objects) : undefined;
        if (childKids instanceof PDFArray && childKids.items.length === 0) {
          kids.items.splice(i, 1);
        }
      }
      const count = node.get('Count');
      const resolvedCount = count ? resolveRef(count, objects) : undefined;
      const nextCount = new PDFNumber((resolvedCount instanceof PDFNumber ? resolvedCount.value : 0) - 1);
      if (count instanceof PDFRef) objects.set(count.toKey(), nextCount);
      else node.set('Count', nextCount);
      return true;
    }
    return false;
  }

  removeFromNode(pagesObj);
}

function rebuildKidsArray(doc: PDFDocumentData): void {
  const pagesRef = doc.catalog.getRef('Pages');
  if (!pagesRef) return;

  const pagesObj = resolveRef(pagesRef, doc.objects);
  if (!(pagesObj instanceof PDFDict)) return;

  // Flattening changes inheritance. Materialize each leaf's effective values
  // before reparenting, including an explicit zero rotation under a rotated root.
  for (const page of doc.pages) {
    if (!page.dict.has('Resources')) page.dict.set('Resources', page.resources);
    if (!page.dict.has('MediaBox')) page.dict.set('MediaBox', rectangleArray(page.mediaBox));
    if (!page.dict.has('CropBox')) page.dict.set('CropBox', rectangleArray(page.cropBox));
    if (!page.dict.has('Rotate')) page.dict.set('Rotate', new PDFNumber(page.rotate));
    page.dict.set('Parent', pagesRef);
  }
  const newKids = new PDFArray(doc.pages.map((p) => p.ref));
  const kids = pagesObj.get('Kids');
  if (kids instanceof PDFRef) doc.objects.set(kids.toKey(), newKids);
  else pagesObj.set('Kids', newKids);
  const count = pagesObj.get('Count');
  const newCount = new PDFNumber(doc.pages.length);
  if (count instanceof PDFRef) doc.objects.set(count.toKey(), newCount);
  else pagesObj.set('Count', newCount);
}


function rectangleArray(rect: PDFRectangle): PDFArray {
  return new PDFArray([
    rect.x, rect.y, rect.x + rect.width, rect.y + rect.height,
  ].map(value => new PDFNumber(value)));
}
