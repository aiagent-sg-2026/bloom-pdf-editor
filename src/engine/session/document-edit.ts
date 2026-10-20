import { clonePDFObject } from '../editing/editor-history';
import { addAnnotationToPage, createAnnotationDict, type Annotation } from '../editor/annotation-engine';
import { bindPageContentRefs } from '../editor/stream-compiler';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFRef, PDFStream, type PDFDocumentData, type PDFObject } from '../types';
import { extractPages } from '../writer/page-operations';
import { getNextObjNum, serializeDocument } from '../writer/serializer';
import { DocumentSession } from './document-session';
import type { EditTransaction } from './edit-transaction';

async function serializeSessionBytes(doc: PDFDocumentData): Promise<Uint8Array> {
  if (!doc.decryptedFromEncrypted) return serializeDocument(doc);
  // Internal snapshots are decrypted, like the live graph. Do not run AES's
  // random-IV export encryption when comparing document revisions.
  const trailerDict = clonePDFObject(doc.xref.trailerDict) as PDFDict;
  trailerDict.delete('Encrypt');
  return serializeDocument({
    ...doc,
    decryptedFromEncrypted: false,
    xref: { ...doc.xref, trailerDict },
  });
}

/** Probe the existing eraser/clear geometry without mutating the live graph.
 * Only the three migrated text-markup subtypes belong to a byte transaction.
 */
export function collectMarkupRemovals(
  doc: PDFDocumentData,
  pageIndex: number,
  remove: (pageDict: PDFDict, objects: Map<string, PDFObject>) => number,
): { textMarkup: PDFRef[]; legacy: PDFRef[] } {
  const annots = doc.pages[pageIndex].dict.get('Annots');
  const array = annots instanceof PDFRef ? doc.objects.get(annots.toKey()) : annots;
  const textMarkup: PDFRef[] = [];
  const legacy: PDFRef[] = [];
  if (!(array instanceof PDFArray)) return { textMarkup, legacy };
  const probe = new PDFDict();
  probe.set('Annots', new PDFArray([...array.items]));
  const objects = new Map<string, PDFObject>();
  for (const item of array.items) {
    if (!(item instanceof PDFRef)) continue;
    const annotation = doc.objects.get(item.toKey());
    if (annotation) objects.set(item.toKey(), annotation);
  }
  remove(probe, objects);
  for (const item of array.items) {
    if (!(item instanceof PDFRef) || objects.has(item.toKey())) continue;
    const annotation = doc.objects.get(item.toKey());
    if (!(annotation instanceof PDFDict)) continue;
    const subtype = annotation.getName('Subtype');
    if (subtype === 'Highlight' || subtype === 'Underline' || subtype === 'StrikeOut') textMarkup.push(item);
    else legacy.push(item);
  }
  return { textMarkup, legacy };
}

/** Add native draw/shape annotations to a transaction's detached document. */
export function addDrawingAnnotations(doc: PDFDocumentData, pageIndex: number, annotations: readonly Annotation[]): void {
  for (const annotation of annotations) {
    const ref = new PDFRef(getNextObjNum(doc), 0);
    const { dict } = createAnnotationDict(annotation, ref.objNum, doc.objects);
    addAnnotationToPage(doc.pages[pageIndex].dict, dict, ref, doc.objects);
  }
}

/** Ink and text markup share an eraser transaction; other removals stay legacy. */
export function collectDrawingRemovals(
  doc: PDFDocumentData,
  pageIndex: number,
  remove: (pageDict: PDFDict, objects: Map<string, PDFObject>) => number,
): { transactional: PDFRef[]; legacy: PDFRef[] } {
  const hits = collectMarkupRemovals(doc, pageIndex, remove);
  const transactional = [...hits.textMarkup];
  const legacy: PDFRef[] = [];
  for (const ref of hits.legacy) {
    const annotation = doc.objects.get(ref.toKey());
    if (annotation instanceof PDFDict && annotation.getName('Subtype') === 'Ink') transactional.push(ref);
    else legacy.push(ref);
  }
  return { transactional, legacy };
}

/** Apply previously hit-tested references to either a draft or the legacy graph. */
export function removeMarkupReferences(doc: PDFDocumentData, pageIndex: number, refs: readonly PDFRef[]): void {
  const pageDict = doc.pages[pageIndex].dict;
  const annots = pageDict.get('Annots');
  const array = annots instanceof PDFRef ? doc.objects.get(annots.toKey()) : annots;
  if (!(array instanceof PDFArray) || refs.length === 0) return;
  const removed = new Set(refs.map(ref => ref.toKey()));
  const remaining = array.items.filter(item => {
    if (!(item instanceof PDFRef) || !removed.has(item.toKey())) return true;
    doc.objects.delete(item.toKey());
    return false;
  });
  if (annots instanceof PDFRef) doc.objects.set(annots.toKey(), new PDFArray(remaining));
  else pageDict.set('Annots', new PDFArray(remaining));
}

/** Render an in-progress transactional annotation erase without publishing a partial gesture. */
export function previewMarkupRemoval(
  doc: PDFDocumentData,
  pageIndex: number,
  removed: ReadonlyMap<string, PDFRef>,
): PDFDocumentData {
  if (removed.size === 0) return doc;
  const page = doc.pages[pageIndex];
  const annots = page.dict.get('Annots');
  const array = annots instanceof PDFRef ? doc.objects.get(annots.toKey()) : annots;
  if (!(array instanceof PDFArray)) return doc;
  const dict = new PDFDict([...page.dict.entries()]);
  dict.set('Annots', new PDFArray(array.items.filter(item =>
    !(item instanceof PDFRef && removed.has(item.toKey())))));
  const pages = [...doc.pages];
  pages[pageIndex] = { ...page, dict };
  return { ...doc, pages };
}

/** Reconcile the draft into existing objects, preserving stream identity and
 * the objects-map identity used by native edit/font provenance registries.
 */
function publishDraft(doc: PDFDocumentData, staged: PDFDocumentData, clones: Map<object, PDFObject>): void {
  const originals = new Map<PDFObject, PDFObject>();
  for (const [original, clone] of clones) originals.set(clone, original as PDFObject);
  const published = new Map<PDFObject, PDFObject>();
  function adopt(object: PDFObject): PDFObject {
    const previous = published.get(object);
    if (previous) return previous;
    const target = originals.get(object) ?? object;
    published.set(object, target);
    if (object instanceof PDFDict && target instanceof PDFDict) {
      // Match the draft's insertion order as well as its values so the live
      // serialization matches the committed snapshot. New dictionaries adopt in place.
      if (target !== object) for (const key of target.keys()) target.delete(key);
      for (const [key, value] of object.entries()) target.set(key, adopt(value));
    } else if (object instanceof PDFArray && target instanceof PDFArray) {
      for (let index = 0; index < object.items.length; index++) target.items[index] = adopt(object.items[index]);
      target.items.length = object.items.length;
    } else if (object instanceof PDFStream && target instanceof PDFStream) {
      adopt(object.dict);
      target.rawBytes = object.rawBytes;
      target.decodedBytes = object.decodedBytes;
    }
    return target;
  }
  for (const key of doc.objects.keys()) if (!staged.objects.has(key)) doc.objects.delete(key);
  for (const [key, object] of staged.objects) doc.objects.set(key, adopt(object));
  const previousPages = new Map(doc.pages.map(page => [page.ref.toKey(), page]));
  const pages = staged.pages.map(draft => {
    const page = previousPages.get(draft.ref.toKey()) ?? { ...draft };
    page.index = draft.index;
    page.ref = draft.ref;
    page.dict = adopt(draft.dict) as PDFDict;
    page.resources = adopt(draft.resources) as PDFDict;
    page.mediaBox = { ...draft.mediaBox };
    page.cropBox = { ...draft.cropBox };
    page.rotate = draft.rotate;
    page.contentRefs = [...draft.contentRefs];
    return bindPageContentRefs(page);
  });
  doc.pages.splice(0, doc.pages.length, ...pages);
  doc.catalog = adopt(staged.catalog) as PDFDict;
  doc.xref.trailerDict = adopt(staged.xref.trailerDict) as PDFDict;
}

/** Stages native object-graph edits without reparsing, losing decoded streams,
 * changing upload bytes, or routing edits through the export/save policy.
 * The adapter is deliberately separate from the byte-only session classes.
 */
export class SessionDocumentEditor {
  private session: DocumentSession | null = null;
  private editing = false;

  get canUndo(): boolean {
    return !this.editing && (this.session?.canUndo ?? false);
  }

  get canRedo(): boolean {
    return !this.editing && (this.session?.canRedo ?? false);
  }

  async undo(doc: PDFDocumentData): Promise<boolean> {
    return this.restore(doc, 'undo');
  }

  async redo(doc: PDFDocumentData): Promise<boolean> {
    return this.restore(doc, 'redo');
  }

  /** Reapply a baked toolbar state after crossing a neighbouring session boundary. */
  async restoreCurrent(doc: PDFDocumentData): Promise<boolean> {
    return this.restore(doc, 'current');
  }

  /** Split downloads transform private session bytes, not the live graph or
   * toolbar cursor. Failed extraction cannot publish a partial PDF.
   */
  async extractPages(doc: PDFDocumentData, indices: number[]): Promise<Uint8Array> {
    const session = new DocumentSession(await serializeSessionBytes(doc));
    const transaction = session.beginTransaction('extract-pages');
    try {
      await transaction.apply(async bytes => {
        const source = await parsePDF(bytes);
        return serializeDocument(extractPages(source, indices));
      });
      transaction.commit();
      return session.getBytes();
    } catch (error) {
      transaction.rollback();
      throw error;
    }
  }

  private async restore(doc: PDFDocumentData, direction: 'undo' | 'redo' | 'current'): Promise<boolean> {
    if (this.editing) throw new Error('An edit transaction is already active');
    const session = this.session;
    if (!session) return false;
    this.editing = true;
    const bytes = direction === 'current' ? session.getBytes() : session[direction]();
    if (!bytes) {
      this.editing = false;
      return false;
    }
    try {
      const restored = await parsePDF(bytes);
      // Keep upload/save/security provenance on the live document and objects map.
      // Internal snapshots omit /Encrypt; downloads still need the original entry.
      const encryptRef = doc.xref.trailerDict.getRef('Encrypt');
      if (doc.decryptedFromEncrypted && encryptRef) {
        restored.xref.trailerDict.set('Encrypt', encryptRef);
        const encrypt = doc.objects.get(encryptRef.toKey());
        if (encrypt) restored.objects.set(encryptRef.toKey(), encrypt);
      }
      // The parser reads xref-number order, not physical snapshot order.
      // Restore file order so reinserted annotations and their /Annots arrays
      // serialize byte-identically; retain detached objects for legacy history.
      const orderedObjects = [...restored.objects].sort(([left], [right]) =>
        (restored.xref.entries.get(left)?.offset ?? Number.MAX_SAFE_INTEGER) -
        (restored.xref.entries.get(right)?.offset ?? Number.MAX_SAFE_INTEGER));
      for (const [key, object] of doc.objects) {
        if (!restored.objects.has(key)) orderedObjects.push([key, object]);
      }
      doc.objects.clear();
      for (const [key, object] of orderedObjects) doc.objects.set(key, object);
      doc.catalog = restored.catalog;
      doc.pages = restored.pages;
      doc.xref.trailerDict = restored.xref.trailerDict;
      doc.info = restored.info;
      doc.version = restored.version;
      return true;
    } catch (error) {
      // Failed parsing must not consume a toolbar history step.
      if (direction === 'undo') session.redo();
      else if (direction === 'redo') session.undo();
      throw error;
    } finally {
      this.editing = false;
    }
  }

  async edit(
    doc: PDFDocumentData,
    label: string,
    apply: (staged: PDFDocumentData) => Promise<void>,
  ): Promise<void> {
    if (this.editing) throw new Error('An edit transaction is already active');
    this.editing = true;
    let transaction: EditTransaction | undefined;
    try {
      const baseline = await serializeSessionBytes(doc);
      if (!this.session) this.session = new DocumentSession(baseline);
      else {
        const previous = this.session.getBytes();
        if (previous.length !== baseline.length || previous.some((byte, index) => byte !== baseline[index])) {
          this.session.snapshot('legacy-edit', baseline);
        }
      }
      transaction = this.session.beginTransaction(label);
      const seen = new Map<object, PDFObject>();
      const objects = new Map<string, PDFObject>();
      for (const [key, object] of doc.objects) objects.set(key, clonePDFObject(object, seen));
      const staged: PDFDocumentData = {
        ...doc,
        objects,
        catalog: clonePDFObject(doc.catalog, seen) as PDFDict,
        pages: doc.pages.map(page => ({
          ...page,
          mediaBox: { ...page.mediaBox },
          cropBox: { ...page.cropBox },
          dict: clonePDFObject(page.dict, seen) as PDFDict,
          resources: clonePDFObject(page.resources, seen) as PDFDict,
          contentRefs: [...page.contentRefs],
        })),
        xref: { ...doc.xref, trailerDict: clonePDFObject(doc.xref.trailerDict, seen) as PDFDict },
      };
      for (const page of staged.pages) bindPageContentRefs(page);
      await transaction.apply(async () => {
        await apply(staged);
        return serializeSessionBytes(staged);
      });
      // Legacy edit paths remain live. Do not overwrite their work if one ran
      // while the staged operation was awaiting image decoding/compression.
      const latest = await serializeSessionBytes(doc);
      if (baseline.length !== latest.length || baseline.some((byte, index) => byte !== latest[index])) {
        throw new Error('Document changed during the edit transaction');
      }
      transaction.commit();
      publishDraft(doc, staged, seen);
    } catch (error) {
      transaction?.rollback();
      throw error;
    } finally {
      this.editing = false;
    }
  }
}
