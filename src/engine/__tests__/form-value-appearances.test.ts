import { describe, expect, it } from 'vitest';
import { parseContentStream } from '../content/operator-lexer';
import { setFormFieldValue } from '../forms/apply-field';
import { detectFormFieldsOnPage, parseAcroFormCatalog } from '../forms/detect-fields';
import { setButtonFieldValue, setChoiceFieldValue } from '../forms/widget-appearances';
import { parsePDF, resolveRef } from '../parser/parser';
import { SessionDocumentEditor } from '../session/document-edit';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, PDFString, type PDFDocumentData } from '../types';
import { serializeDocument } from '../writer/serializer';
import { rawPDF } from './audit-p1-fixtures';

function fixture(field = '', acro = '', da = '/F1 12 Tf 0 g'): Uint8Array {
  const old = 'BT /F1 12 Tf 2 5 Td (OLD) Tj ET';
  return rawPDF([
    '<< /Type /Catalog /Pages 2 0 R /AcroForm 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 240 240] /Resources << >> /Contents 4 0 R /Annots [6 0 R] >>',
    '<< /Length 0 >>\nstream\nendstream',
    `<< /Fields [6 0 R] /DA (${da}) /DR << /Font << /F1 8 0 R >> >> ${acro} >>`,
    `<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /Rect [10 10 110 50] /V (OLD) /P 3 0 R /AP << /N 7 0 R >> ${field} >>`,
    `<< /Type /XObject /Subtype /Form /BBox [0 0 100 40] /Resources << /Font << /F1 8 0 R >> >> /Length ${old.length} >>\nstream\n${old}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
  ]);
}

function appearance(doc: PDFDocumentData): { dict: PDFDict; stream: PDFStream; content: string } {
  const dict = detectFormFieldsOnPage(doc, 0)[0].dict;
  const ap = resolveRef(dict.get('AP')!, doc.objects) as PDFDict;
  const stream = resolveRef(ap.get('N')!, doc.objects) as PDFStream;
  return { dict, stream, content: new TextDecoder('latin1').decode(stream.getBytes()) };
}

async function edited(value: string, field = '', acro = ''): Promise<PDFDocumentData> {
  const doc = await parsePDF(fixture(field, acro));
  setFormFieldValue(doc, detectFormFieldsOnPage(doc, 0)[0], value);
  return parsePDF(await serializeDocument(doc));
}

function textRows(doc: PDFDocumentData) {
  const instructions = parseContentStream(appearance(doc).stream.getBytes());
  const rows: { text: string; x: number; y: number }[] = [];
  let x = 0, y = 0;
  for (const instruction of instructions) {
    if (instruction.operator === 'Tm') {
      x = (instruction.operands[4] as PDFNumber).value;
      y = (instruction.operands[5] as PDFNumber).value;
    }
    if (instruction.operator === 'Tj') rows.push({ text: (instruction.operands[0] as PDFString).value, x, y });
  }
  const tf = instructions.find(instruction => instruction.operator === 'Tf')!;
  return { rows, size: (tf.operands[1] as PDFNumber).value, fontName: (tf.operands[0] as PDFName).name, instructions };
}

describe('exported form value appearances', () => {
  it('replaces stale normal appearance text, not just /V', async () => {
    const doc = await edited('NEW');
    const { dict, content } = appearance(doc);
    expect((dict.get('V') as PDFString).value).toBe('NEW');
    expect(content).toContain('(NEW)');
    expect(content).not.toContain('OLD');
  });

  it('updates the parent /V and every sibling widget using inherited layout attributes', async () => {
    const doc = await parsePDF(fixture());
    const parent = detectFormFieldsOnPage(doc, 0)[0].dict;
    const oldAP = parent.getDict('AP')!;
    parent.delete('Subtype');
    parent.delete('Rect');
    parent.delete('P');
    parent.delete('AP');
    parent.set('DA', new PDFString('/F1 8 Tf 0.4 g'));
    parent.set('Q', new PDFNumber(2));
    parent.set('Kids', new PDFArray([new PDFRef(9, 0), new PDFRef(10, 0)]));
    for (const index of [9, 10]) {
      doc.objects.set(`${index}_0`, new PDFDict([
        ['Subtype', new PDFName('Widget')], ['Parent', new PDFRef(6, 0)], ['P', new PDFRef(3, 0)],
        ['Rect', new PDFArray([10, 10, 110, 50].map(value => new PDFNumber(value)))], ['AP', oldAP],
      ]));
    }
    doc.pages[0].dict.set('Annots', parent.getArray('Kids')!);
    setFormFieldValue(doc, detectFormFieldsOnPage(doc, 0)[0], 'NEW');
    // Shared source appearances must not be mutated while replacing a widget.
    expect(oldAP.getRef('N')).toEqual(new PDFRef(7, 0));
    const reopened = await parsePDF(await serializeDocument(doc));
    expect((parseAcroFormCatalog(reopened)!.fields[0].dict.get('V') as PDFString).value).toBe('NEW');
    for (const widget of detectFormFieldsOnPage(reopened, 0)) {
      expect(widget.value).toBe('NEW');
      const ap = widget.dict.getDict('AP')!;
      const stream = resolveRef(ap.get('N')!, reopened.objects) as PDFStream;
      const content = new TextDecoder().decode(stream.getBytes());
      expect(content).toContain('(NEW)');
      expect(content).not.toContain('OLD');
      const instructions = parseContentStream(stream.getBytes());
      expect((instructions.find(instruction => instruction.operator === 'Tf')!.operands[1] as PDFNumber).value).toBe(8);
      const tm = instructions.find(instruction => instruction.operator === 'Tm')!;
      expect((tm.operands[4] as PDFNumber).value).toBeGreaterThan(50);
    }
  });

  it('uses inherited /DA and indirect /DR fonts without changing the shared font', async () => {
    const doc = await parsePDF(fixture('', '', '/F1 9 Tf 0.2 0.4 0.6 rg'));
    const acro = parseAcroFormCatalog(doc)!.dict;
    const dr = acro.getDict('DR')!;
    doc.objects.set('9_0', dr);
    acro.set('DR', new PDFRef(9, 0));
    setFormFieldValue(doc, detectFormFieldsOnPage(doc, 0)[0], 'NEW');
    const reopened = await parsePDF(await serializeDocument(doc));
    const { stream, content } = appearance(reopened);
    const { size, fontName } = textRows(reopened);
    expect(size).toBe(9);
    expect(content).toContain('0.2 0.4 0.6 rg');
    const fonts = stream.dict.getDict('Resources')!.getDict('Font')!;
    expect(fonts.get(fontName)).toEqual(new PDFRef(8, 0));
    expect((resolveRef(fonts.get(fontName)!, reopened.objects) as PDFDict).getName('BaseFont')).toBe('Courier');
  });

  it('honors a field-local /DA before the AcroForm default', async () => {
    const doc = await edited('NEW', '/DA (/F1 7 Tf 0.3 g)');
    expect(textRows(doc).size).toBe(7);
    expect(appearance(doc).content).toContain('0.3 g');
  });

  it('positions left, centered, and right text within the widget, not page coordinates', async () => {
    const positions: number[] = [];
    for (const q of [0, 1, 2]) {
      const doc = await edited('AB', `/Q ${q} /Border [0 0 0]`);
      const { rows, size } = textRows(doc);
      expect(size).toBe(12);
      expect(rows[0].text).toBe('AB');
      positions.push(rows[0].x);
      if (q === 1) expect(rows[0].x + 2 * 0.6 * size / 2).toBeCloseTo(50);
    }
    expect(positions[0]).toBeLessThan(positions[1]);
    expect(positions[1]).toBeLessThan(positions[2]);
    expect(positions[0] + positions[2] + 2 * 0.6 * 12).toBeCloseTo(100);
  });

  it('wraps multiline words and preserves explicit line breaks', async () => {
    const doc = await parsePDF(fixture('/Ff 4096'));
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    widget.dict.set('Rect', new PDFArray([10, 10, 110, 90].map(value => new PDFNumber(value))));
    setFormFieldValue(doc, widget, 'alpha beta gamma\nlast');
    const reopened = await parsePDF(await serializeDocument(doc));
    const { rows } = textRows(reopened);
    expect(rows.map(row => row.text)).toEqual(['alpha beta', 'gamma', 'last']);
    expect(rows[0].y).toBeGreaterThan(rows[1].y);
    expect(rows[1].y).toBeGreaterThan(rows[2].y);
    expect(rows[2].y).toBeGreaterThan(0);
    expect(appearance(reopened).content).not.toContain('OLD');
  });

  it('fits size-zero text to the available width rather than emitting zero-sized glyphs', async () => {
    const doc = await edited('W'.repeat(40), '/DA (/F1 0 Tf 0 g)');
    const { size, rows } = textRows(doc);
    expect(size).toBeGreaterThan(3.9);
    expect(size).toBeLessThanOrEqual(4);
    expect(rows[0].text).toBe('W'.repeat(40));
    expect(rows[0].x + 40 * 0.6 * size).toBeLessThanOrEqual(100);
  });

  it('fits multiline size-zero text in both dimensions', async () => {
    const doc = await edited('one two three four five six seven eight nine ten', '/Ff 4096 /DA (/F1 0 Tf 0 g)');
    const { rows, size } = textRows(doc);
    expect(rows.map(row => row.text).join(' ')).toBe('one two three four five six seven eight nine ten');
    expect(size).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.x + row.text.length * 0.6 * size).toBeLessThanOrEqual(100);
      expect(row.y - 0.157 * size).toBeGreaterThanOrEqual(0);
    }
  });

  it('escapes PDF literal delimiters without changing the displayed text or /V', async () => {
    const value = String.raw`A (new) \ name`;
    const doc = await edited(value);
    expect(detectFormFieldsOnPage(doc, 0)[0].value).toBe(value);
    expect(textRows(doc).rows[0].text).toBe(value);
    expect(appearance(doc).content).toContain(String.raw`A \(new\) \\ name`);
  });

  it('enforces /MaxLen and places comb characters in separate equal-width cells', async () => {
    const doc = await edited('ABCDE', '/Ff 16777216 /MaxLen 4');
    expect(detectFormFieldsOnPage(doc, 0)[0].value).toBe('ABCD');
    const { rows } = textRows(doc);
    expect(rows.map(row => row.text)).toEqual(['A', 'B', 'C', 'D']);
    const spacing = rows[1].x - rows[0].x;
    expect(spacing).toBeGreaterThan(0);
    expect(rows[2].x - rows[1].x).toBeCloseTo(spacing);
    expect(rows[3].x - rows[2].x).toBeCloseTo(spacing);
    expect(rows[0].x + rows[3].x + 0.6 * 12).toBeCloseTo(100);
  });

  it('draws /MK background and border in widget-local coordinates', async () => {
    const doc = await edited('NEW', '/MK << /BG [1 0.9 0.8] /BC [0.2] >> /BS << /W 2 >>');
    const { stream, content } = appearance(doc);
    expect(stream.dict.getArray('BBox')!.asNumbers()).toEqual([0, 0, 100, 40]);
    expect(content).toContain('1 0.9 0.8 rg');
    expect(content).toContain('0 0 100 40 re f');
    expect(content).toContain('0.2 G');
    expect(content).toContain('2 w');
    expect(content).toContain('1 1 98 38 re S');
  });

  it('uses real WinAnsi punctuation and degrades unsupported glyphs without corrupting /V', async () => {
    const value = 'Euro € — 漢 😀';
    const doc = await edited(value, '/DA (/Missing 12 Tf 0 g)');
    expect(detectFormFieldsOnPage(doc, 0)[0].value).toBe(value);
    const { rows, fontName } = textRows(doc);
    expect(rows[0].text).toBe('Euro \x80 \x97 ? ?');
    const fontEntry = appearance(doc).stream.dict.getDict('Resources')!.getDict('Font')!.get(fontName)!;
    expect(fontEntry).toBeInstanceOf(PDFRef);
    const font = resolveRef(fontEntry, doc.objects) as PDFDict;
    expect(font.getName('BaseFont')).toBe('Helvetica');
    expect(font.getName('Encoding')).toBe('WinAnsiEncoding');
  });

  it('displays a choice option label while retaining its export value', async () => {
    const doc = await parsePDF(fixture('/Opt [[(a) (Before)] [(b) (New label)]]'));
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    widget.dict.set('FT', new PDFName('Ch'));
    widget.fieldType = 'Ch';
    setChoiceFieldValue(doc, widget, 'b');
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(detectFormFieldsOnPage(reopened, 0)[0].value).toBe('b');
    expect(textRows(reopened).rows[0].text).toBe('New label');
    expect(appearance(reopened).content).not.toContain('OLD');
  });

  it.each([true, false])('keeps checkbox/radio /V and /AS consistent for checked=%s', async checked => {
    const doc = await parsePDF(fixture());
    const widget = detectFormFieldsOnPage(doc, 0)[0];
    widget.dict.set('FT', new PDFName('Btn'));
    widget.fieldType = 'Btn';
    setButtonFieldValue(doc, widget, checked, 'Selected');
    const reopened = await parsePDF(await serializeDocument(doc));
    const dict = detectFormFieldsOnPage(reopened, 0)[0].dict;
    const expected = checked ? 'Selected' : 'Off';
    expect(dict.getName('V')).toBe(expected);
    expect(dict.getName('AS')).toBe(expected);
    const states = dict.getDict('AP')!.getDict('N')!;
    expect(resolveRef(states.get(expected)!, reopened.objects)).toBeInstanceOf(PDFStream);
  });

  it('clears NeedAppearances after complete regeneration but retains it when a widget cannot regenerate', async () => {
    const complete = await edited('NEW', '', '/NeedAppearances true');
    expect(parseAcroFormCatalog(complete)!.needAppearances).toBe(false);
    const doc = await parsePDF(fixture('', '/NeedAppearances true'));
    const sibling = new PDFDict([
      ['Type', new PDFName('Annot')], ['Subtype', new PDFName('Widget')], ['FT', new PDFName('Tx')],
      ['T', new PDFString('Unrenderable')], ['Rect', new PDFArray([0, 0, 0, 0].map(value => new PDFNumber(value)))],
    ]);
    doc.objects.set('9_0', sibling);
    parseAcroFormCatalog(doc)!.dict.getArray('Fields')!.push(new PDFRef(9, 0));
    setFormFieldValue(doc, detectFormFieldsOnPage(doc, 0)[0], 'NEW');
    const reopened = await parsePDF(await serializeDocument(doc));
    expect(appearance(reopened).content).toContain('(NEW)');
    expect(parseAcroFormCatalog(reopened)!.needAppearances).toBe(true);
  });

  it.each(['Tx', 'Ch'])('restores preexisting %s appearance bytes exactly through session undo/redo and failed edits', async type => {
    const doc = await parsePDF(fixture('', '/NeedAppearances true'));
    detectFormFieldsOnPage(doc, 0)[0].dict.set('FT', new PDFName(type));
    const before = await serializeDocument(doc);
    const oldAppearance = appearance(doc).stream.getBytes().slice();
    const editor = new SessionDocumentEditor();
    const apply = async (staged: PDFDocumentData) => {
      const widget = detectFormFieldsOnPage(staged, 0)[0];
      if (type === 'Ch') setChoiceFieldValue(staged, widget, 'NEW');
      else setFormFieldValue(staged, widget, 'NEW');
    };
    await expect(editor.edit(doc, 'form-value', async staged => {
      await apply(staged);
      throw new Error('abort');
    })).rejects.toThrow('abort');
    expect(await serializeDocument(doc)).toEqual(before);
    await editor.edit(doc, 'form-value', apply);
    const after = await serializeDocument(doc);
    expect(appearance(await parsePDF(after)).content).toContain('(NEW)');
    for (let cycle = 0; cycle < 2; cycle++) {
      await editor.undo(doc);
      expect(await serializeDocument(doc)).toEqual(before);
      expect(appearance(doc).stream.getBytes()).toEqual(oldAppearance);
      await editor.redo(doc);
      expect(await serializeDocument(doc)).toEqual(after);
      expect(appearance(doc).content).toContain('(NEW)');
    }
  });
});
