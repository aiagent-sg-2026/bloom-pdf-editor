/**
 * Unit tests — Phase 4 signature fields + Phase 5 appearance streams.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocumentData,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
} from '../../types';
import {
  createSignatureField,
  createSignatureFieldAtPoint,
  listSignatureFields,
  detectSignatureFieldsOnPage,
  hitTestSignatureField,
  lookupSignatureFieldByName,
  placeSignatureInField,
  ensureAcroFormCatalog,
  AppearanceResourceManager,
  buildSignatureAppearanceContent,
  serializeAppearanceStream,
  applySignatureFieldAppearance,
  getNormalAppearanceRef,
  attachNormalAppearance,
} from '../../signatures';
import { parseAcroFormCatalog, detectFormFieldsOnPage } from '../../forms';

function makeMinimalDoc(): PDFDocumentData {
  const objects = new Map<string, import('../../types').PDFObject>();
  const pageDict = new PDFDict();
  pageDict.set('Type', new PDFName('Page'));
  pageDict.set('MediaBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
  ]));
  pageDict.set('Annots', new PDFArray([]));
  const pageRef = new PDFRef(2, 0);
  objects.set(pageRef.toKey(), pageDict);

  const pagesDict = new PDFDict();
  pagesDict.set('Type', new PDFName('Pages'));
  pagesDict.set('Kids', new PDFArray([pageRef]));
  pagesDict.set('Count', new PDFNumber(1));
  const pagesRef = new PDFRef(1, 0);
  objects.set(pagesRef.toKey(), pagesDict);
  pageDict.set('Parent', pagesRef);

  const catalog = new PDFDict();
  catalog.set('Type', new PDFName('Catalog'));
  catalog.set('Pages', pagesRef);

  return {
    version: '1.7',
    catalog,
    objects,
    pages: [{
      ref: pageRef,
      dict: pageDict,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      contentRefs: [],
    }],
    trailer: new PDFDict(),
    xref: { entries: [], trailer: new PDFDict() },
    info: {},
    rawBytes: new Uint8Array(0),
  } as unknown as PDFDocumentData;
}

describe('Phase 4 — signature fields', () => {
  let doc: PDFDocumentData;

  beforeEach(() => {
    doc = makeMinimalDoc();
  });

  it('creates a signature field registered in AcroForm', () => {
    const ref = createSignatureField(doc, 0, {
      x: 72, y: 700, width: 160, height: 50,
    }, 'Sig1');
    expect(ref).toBeInstanceOf(PDFRef);

    const catalog = parseAcroFormCatalog(doc);
    expect(catalog).not.toBeNull();
    expect(catalog!.fields.length).toBeGreaterThanOrEqual(1);

    const widgets = detectFormFieldsOnPage(doc, 0);
    const sig = widgets.find((w) => w.fieldType === 'Sig');
    expect(sig).toBeTruthy();
    expect(sig!.fieldName).toBe('Sig1');
  });

  it('lists / detects / hit-tests / looks up signature fields', () => {
    createSignatureFieldAtPoint(doc, 0, 200, 400, {
      fieldName: 'BuyerSign',
      width: 120,
      height: 40,
    });

    const all = listSignatureFields(doc);
    expect(all.length).toBe(1);
    expect(all[0].fieldName).toBe('BuyerSign');
    expect(all[0].signed).toBe(false);
    expect(all[0].hasAppearance).toBe(true); // placeholder AP

    const onPage = detectSignatureFieldsOnPage(doc, 0);
    expect(onPage).toHaveLength(1);

    const hit = hitTestSignatureField(onPage, 200, 400);
    expect(hit?.fieldName).toBe('BuyerSign');

    expect(lookupSignatureFieldByName(doc, 'BuyerSign')?.fieldName).toBe('BuyerSign');
    expect(lookupSignatureFieldByName(doc, 'buyer')).not.toBeNull();
  });

  it('ensureAcroFormCatalog creates DR with Helv', () => {
    const acro = ensureAcroFormCatalog(doc);
    expect(acro.get('Fields')).toBeInstanceOf(PDFArray);
    const dr = acro.get('DR');
    expect(dr).toBeInstanceOf(PDFDict);
  });
});

describe('Phase 5 — appearance streams', () => {
  let doc: PDFDocumentData;

  beforeEach(() => {
    doc = makeMinimalDoc();
  });

  it('resource manager builds Font / XObject / ExtGState', () => {
    const rm = new AppearanceResourceManager();
    expect(rm.ensureType1Font('Helvetica')).toBe('Helv');
    rm.ensureOpacity(0.5);
    const imgRef = new PDFRef(99, 0);
    expect(rm.addImageXObject(imgRef)).toBe('Im1');
    const res = rm.toResourcesDict(doc.objects);
    expect(res.get('Font')).toBeInstanceOf(PDFDict);
    expect(res.get('XObject')).toBeInstanceOf(PDFDict);
    expect(res.get('ExtGState')).toBeInstanceOf(PDFDict);
  });

  it('builds vector appearance content with BBox-local operators', () => {
    const rm = new AppearanceResourceManager();
    const content = buildSignatureAppearanceContent(
      {
        width: 160,
        height: 50,
        typedName: 'Alex Rivera',
        date: '2026-07-15',
        reason: 'Approved',
        backgroundColor: [1, 1, 1],
        borderWidth: 1,
      },
      rm,
    );
    expect(content).toContain('BT');
    expect(content).toContain('Alex Rivera');
    expect(content).toContain('Date: 2026-07-15');
    expect(content).toContain('re S'); // border
    expect(rm.fonts.has('Helv')).toBe(true);
  });

  it('serializes Form XObject with BBox, Matrix, Resources', () => {
    const rm = new AppearanceResourceManager();
    rm.ensureType1Font('Helvetica');
    const content = 'q 0 0 160 50 re S Q\n';
    const result = serializeAppearanceStream(
      doc,
      content,
      { x: 0, y: 0, width: 160, height: 50 },
      rm,
    );
    const stream = doc.objects.get(result.streamRef.toKey());
    expect(stream).toBeInstanceOf(PDFStream);
    const dict = (stream as PDFStream).dict;
    expect((dict.get('Subtype') as PDFName).name).toBe('Form');
    expect(dict.get('BBox')).toBeInstanceOf(PDFArray);
    expect(dict.get('Matrix')).toBeInstanceOf(PDFArray);
    expect(dict.get('Resources')).toBeInstanceOf(PDFDict);
  });

  it('applySignatureFieldAppearance attaches /AP /N', () => {
    const ref = createSignatureField(doc, 0, {
      x: 50, y: 50, width: 180, height: 60,
    }, 'APTest');

    applySignatureFieldAppearance(doc, ref, {
      width: 180,
      height: 60,
      typedName: 'Sam Lee',
      date: 'Jul 15, 2026',
      backgroundColor: [0.98, 0.98, 1],
      borderWidth: 1.25,
    });

    const field = doc.objects.get(ref.toKey()) as PDFDict;
    const nRef = getNormalAppearanceRef(field, doc.objects);
    expect(nRef).toBeInstanceOf(PDFRef);

    const fields = listSignatureFields(doc);
    expect(fields[0].hasAppearance).toBe(true);
  });

  it('placeSignatureInField updates appearance', () => {
    const created = createSignatureFieldAtPoint(doc, 0, 100, 100, {
      fieldName: 'PlaceMe',
      withPlaceholderAppearance: true,
    });
    placeSignatureInField(doc, created.ref, {
      width: created.rect.width,
      height: created.rect.height,
      typedName: 'Placed',
      location: 'NYC',
    });
    const field = doc.objects.get(created.ref.toKey()) as PDFDict;
    expect(getNormalAppearanceRef(field, doc.objects)).toBeTruthy();
  });

  it('attachNormalAppearance wires AP dict', () => {
    const field = new PDFDict();
    const apRef = new PDFRef(10, 0);
    attachNormalAppearance(field, apRef);
    const ap = field.get('AP') as PDFDict;
    expect(ap.get('N')).toBe(apRef);
  });
});
