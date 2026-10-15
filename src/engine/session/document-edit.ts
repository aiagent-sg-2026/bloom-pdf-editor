import { clonePDFObject } from '../editing/editor-history';
import { bindPageContentRefs } from '../editor/stream-compiler';
import { parsePDF } from '../parser/parser';
import { PDFArray, PDFDict, PDFStream, type PDFDocumentData, type PDFObject } from '../types';
import { serializeDocument } from '../writer/serializer';
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
  for (let index = 0; index < doc.pages.length; index++) {
    const page = doc.pages[index];
    const draft = staged.pages[index];
    page.dict = adopt(draft.dict) as PDFDict;
    page.resources = adopt(draft.resources) as PDFDict;
    page.contentRefs.length = 0;
    for (const ref of draft.contentRefs) page.contentRefs.push(ref);
    bindPageContentRefs(page);
  }
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

  private async restore(doc: PDFDocumentData, direction: 'undo' | 'redo'): Promise<boolean> {
    if (this.editing) throw new Error('An edit transaction is already active');
    const session = this.session;
    if (!session) return false;
    this.editing = true;
    const bytes = session[direction]();
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
      // Legacy page-delete history still needs detached page/content objects.
      // They stay unreachable from the restored roots and are omitted on save.
      for (const [key, object] of restored.objects) doc.objects.set(key, object);
      doc.catalog = restored.catalog;
      doc.pages = restored.pages;
      doc.xref.trailerDict = restored.xref.trailerDict;
      doc.info = restored.info;
      doc.version = restored.version;
      return true;
    } catch (error) {
      // Failed parsing must not consume a toolbar history step.
      if (direction === 'undo') session.redo();
      else session.undo();
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
