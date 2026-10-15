import { clonePDFObject } from '../editing/editor-history';
import { bindPageContentRefs } from '../editor/stream-compiler';
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
      for (const key of target.keys()) if (!object.has(key)) target.delete(key);
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
