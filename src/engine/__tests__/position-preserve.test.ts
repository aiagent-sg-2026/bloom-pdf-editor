/**
 * Position-preserving edit — changing one run must not move other runs.
 */

import { describe, it, expect } from 'vitest';
import { buildDocumentFlow } from '../flow/index';
import { applyLineTextEdit } from '../flow/flow-editor';
import { applyRunPositionShifts } from '../editor/text-editor';
import { interpretPage } from '../content/interpreter';
import {
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFArray,
  type PDFPageInfo,
  type PDFObject,
} from '../types';

function makePage(): { page: PDFPageInfo; objects: Map<string, PDFObject>; bytes: Uint8Array } {
  const content =
    'BT\n/F1 12 Tf\n1 0 0 1 50 700 Tm\n(Hello World) Tj\nET\n' +
    'BT\n/F1 12 Tf\n1 0 0 1 50 680 Tm\n(Second Line) Tj\nET\n';
  const bytes = new TextEncoder().encode(content);

  const fontDict = new PDFDict();
  const helv = new PDFDict();
  helv.set('Type', new PDFName('Font'));
  helv.set('Subtype', new PDFName('Type1'));
  helv.set('BaseFont', new PDFName('Helvetica'));
  fontDict.set('F1', helv);

  const resources = new PDFDict();
  resources.set('Font', fontDict);

  const pageDict = new PDFDict();
  pageDict.set('Resources', resources);
  pageDict.set('MediaBox', new PDFArray([
    new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
  ]));

  const page: PDFPageInfo = {
    index: 0,
    dict: pageDict,
    mediaBox: { x: 0, y: 0, width: 612, height: 792 },
    cropBox: { x: 0, y: 0, width: 612, height: 792 },
    rotate: 0,
    ref: new PDFRef(1, 0),
    resources,
    contentRefs: [new PDFRef(2, 0)],
  };

  const objects = new Map<string, PDFObject>();
  objects.set('1 0', pageDict);

  return { page, objects, bytes };
}

describe('position-preserving line edit', () => {
  it('edits one line without moving the other line', () => {
    const { page, objects, bytes } = makePage();
    const before = interpretPage(bytes, page, objects);
    expect(before.textRuns.length).toBeGreaterThanOrEqual(2);

    const flow = buildDocumentFlow(before.textRuns);
    expect(flow.lines.length).toBeGreaterThanOrEqual(2);
    const line0 = flow.lines[0];

    const otherBaseline = flow.lines[1].baseline;
    const otherText = flow.lines[1].text;
    const otherX = flow.lines[1].x;

    const result = applyLineTextEdit(
      bytes,
      page,
      objects,
      line0,
      'Hello Brave World',
      flow,
    );

    const after = interpretPage(result.newContentBytes, page, objects);
    const afterFlow = buildDocumentFlow(after.textRuns);

    const edited = afterFlow.lines.find(l =>
      Math.abs(l.baseline - line0.baseline) < 2 && Math.abs(l.x - line0.x) < 5,
    );
    expect(edited?.text).toContain('Brave');

    const second = afterFlow.lines.find(l =>
      Math.abs(l.baseline - otherBaseline) < 2,
    );
    expect(second).toBeTruthy();
    expect(second!.text).toBe(otherText);
    expect(Math.abs(second!.x - otherX)).toBeLessThan(2);

    for (const line of afterFlow.lines) {
      expect(line.baseline).toBeGreaterThan(0);
      expect(line.baseline).toBeLessThan(800);
    }
  });

  it('keeps both lines when rewriting with same text', () => {
    const { page, objects, bytes } = makePage();
    const before = interpretPage(bytes, page, objects);
    const flow = buildDocumentFlow(before.textRuns);
    const line = flow.lines[0];
    const result = applyLineTextEdit(bytes, page, objects, line, line.text, flow);
    const after = interpretPage(result.newContentBytes, page, objects);
    expect(after.textRuns.some(r => r.text.includes('Hello'))).toBe(true);
    expect(after.textRuns.some(r => r.text.includes('Second'))).toBe(true);
  });

  it('shifts same-baseline peers when a split title cell grows', () => {
    // Title | tags | date already column-split (large gutters). Growing the
    // title-only cell must still push tags and date — segment shifts are empty.
    const content =
      'BT\n/F1 12 Tf\n1 0 0 1 40 700 Tm\n(Assignme Title) Tj\nET\n' +
      'BT\n/F1 12 Tf\n1 0 0 1 250 700 Tm\n( | HTML, CSS) Tj\nET\n' +
      'BT\n/F1 12 Tf\n1 0 0 1 450 700 Tm\n(Aug 2024) Tj\nET\n';
    const bytes = new TextEncoder().encode(content);

    const fontDict = new PDFDict();
    const helv = new PDFDict();
    helv.set('Type', new PDFName('Font'));
    helv.set('Subtype', new PDFName('Type1'));
    helv.set('BaseFont', new PDFName('Helvetica'));
    fontDict.set('F1', helv);
    const resources = new PDFDict();
    resources.set('Font', fontDict);
    const pageDict = new PDFDict();
    pageDict.set('Resources', resources);
    pageDict.set('MediaBox', new PDFArray([
      new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
    ]));
    const page: PDFPageInfo = {
      index: 0,
      dict: pageDict,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      ref: new PDFRef(1, 0),
      resources,
      contentRefs: [new PDFRef(2, 0)],
    };
    const objects = new Map<string, PDFObject>();
    objects.set('1 0', pageDict);

    const before = interpretPage(bytes, page, objects);
    const flow = buildDocumentFlow(before.textRuns);
    const title = flow.lines.find(l => l.text.includes('Assignme'));
    const tagsBefore = before.textRuns.find(r => r.text.includes('HTML'));
    const dateBefore = before.textRuns.find(r => r.text.includes('Aug'));
    expect(title).toBeTruthy();
    expect(tagsBefore).toBeTruthy();
    expect(dateBefore).toBeTruthy();
    // Title cell alone (column-split) — this is the regression setup
    expect(title!.segments.length).toBe(1);

    const result = applyLineTextEdit(
      bytes,
      page,
      objects,
      title!,
      'Assignme Title EXTRA WORDS HERE PLUS MORE',
      flow,
    );
    const after = interpretPage(result.newContentBytes, page, objects);
    const tagsAfter = after.textRuns.find(r => r.text.includes('HTML'));
    const dateAfter = after.textRuns.find(r => r.text.includes('Aug'));
    expect(tagsAfter).toBeTruthy();
    expect(dateAfter).toBeTruthy();
    expect(tagsAfter!.x).toBeGreaterThan(tagsBefore!.x + 20);
    expect(dateAfter!.x).toBeGreaterThan(dateBefore!.x + 20);
    // No pile-up: title must end before tags start
    const titleAfter = after.textRuns.find(r => r.text.includes('Assignme'));
    expect(titleAfter).toBeTruthy();
    expect(titleAfter!.x + titleAfter!.width).toBeLessThan(tagsAfter!.x + 1);
  });

  it('shifts cm outside q (cm q BT … ET Q)', () => {
    // cm before q — lookup must walk past the opening q.
    // Second cm is relative (+150) because PDF concatenates onto current CTM.
    const content =
      '1 0 0 1 50 700 cm\nq\nBT\n/F1 12 Tf\n(Hello) Tj\nET\nQ\n' +
      '1 0 0 1 150 0 cm\nq\nBT\n/F1 12 Tf\n(World) Tj\nET\nQ\n';
    const bytes = new TextEncoder().encode(content);

    const fontDict = new PDFDict();
    const helv = new PDFDict();
    helv.set('Type', new PDFName('Font'));
    helv.set('Subtype', new PDFName('Type1'));
    helv.set('BaseFont', new PDFName('Helvetica'));
    fontDict.set('F1', helv);
    const resources = new PDFDict();
    resources.set('Font', fontDict);
    const pageDict = new PDFDict();
    pageDict.set('Resources', resources);
    pageDict.set('MediaBox', new PDFArray([
      new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
    ]));
    const page: PDFPageInfo = {
      index: 0,
      dict: pageDict,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      ref: new PDFRef(1, 0),
      resources,
      contentRefs: [new PDFRef(2, 0)],
    };
    const objects = new Map<string, PDFObject>();
    objects.set('1 0', pageDict);

    const before = interpretPage(bytes, page, objects);
    const worldBefore = before.textRuns.find(r => r.text.includes('World'));
    expect(worldBefore).toBeTruthy();
    expect(Math.abs(worldBefore!.x - 200)).toBeLessThan(2);

    const shifted = applyRunPositionShifts(bytes, [{ run: worldBefore!, dx: 40, dy: 0 }]);
    const after = interpretPage(shifted, page, objects);
    const worldAfter = after.textRuns.find(r => r.text.includes('World'));
    expect(worldAfter).toBeTruthy();
    expect(worldAfter!.x).toBeGreaterThan(235);
  });

  it('shifts cm-positioned runs inside q (q cm BT … ET Q)', () => {
    const content =
      'q\n1 0 0 1 50 700 cm\nBT\n/F1 12 Tf\n(Hello) Tj\nET\nQ\n' +
      'q\n1 0 0 1 200 700 cm\nBT\n/F1 12 Tf\n(World) Tj\nET\nQ\n';
    const bytes = new TextEncoder().encode(content);

    const fontDict = new PDFDict();
    const helv = new PDFDict();
    helv.set('Type', new PDFName('Font'));
    helv.set('Subtype', new PDFName('Type1'));
    helv.set('BaseFont', new PDFName('Helvetica'));
    fontDict.set('F1', helv);
    const resources = new PDFDict();
    resources.set('Font', fontDict);
    const pageDict = new PDFDict();
    pageDict.set('Resources', resources);
    pageDict.set('MediaBox', new PDFArray([
      new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
    ]));
    const page: PDFPageInfo = {
      index: 0,
      dict: pageDict,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      ref: new PDFRef(1, 0),
      resources,
      contentRefs: [new PDFRef(2, 0)],
    };
    const objects = new Map<string, PDFObject>();
    objects.set('1 0', pageDict);

    const before = interpretPage(bytes, page, objects);
    const worldBefore = before.textRuns.find(r => r.text.includes('World'));
    expect(worldBefore).toBeTruthy();

    const shifted = applyRunPositionShifts(bytes, [{ run: worldBefore!, dx: 40, dy: 0 }]);
    const after = interpretPage(shifted, page, objects);
    const worldAfter = after.textRuns.find(r => r.text.includes('World'));
    expect(worldAfter).toBeTruthy();
    expect(worldAfter!.x).toBeGreaterThan(235);
  });

  it('clears sibling Tj fragments after adjacent-run merge (no ghost text)', () => {
    // Two tight Tj ops on one baseline — mergeAdjacentTextRuns joins them for
    // editing; both sourceInstructionIndices must be kept so the second op is cleared.
    const content =
      'BT\n/F1 12 Tf\n1 0 0 1 100 700 Tm\n(SHASHANK ) Tj\n(KUMAR RATHOUR) Tj\nET\n';
    const bytes = new TextEncoder().encode(content);

    const fontDict = new PDFDict();
    const helv = new PDFDict();
    helv.set('Type', new PDFName('Font'));
    helv.set('Subtype', new PDFName('Type1'));
    helv.set('BaseFont', new PDFName('Helvetica'));
    fontDict.set('F1', helv);

    const resources = new PDFDict();
    resources.set('Font', fontDict);

    const pageDict = new PDFDict();
    pageDict.set('Resources', resources);
    pageDict.set('MediaBox', new PDFArray([
      new PDFNumber(0), new PDFNumber(0), new PDFNumber(612), new PDFNumber(792),
    ]));

    const page: PDFPageInfo = {
      index: 0,
      dict: pageDict,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 0, y: 0, width: 612, height: 792 },
      rotate: 0,
      ref: new PDFRef(1, 0),
      resources,
      contentRefs: [new PDFRef(2, 0)],
    };
    const objects = new Map<string, PDFObject>();
    objects.set('1 0', pageDict);

    const before = interpretPage(bytes, page, objects);
    // Merged into one editable run spanning both Tj ops
    expect(before.textRuns.length).toBe(1);
    expect(before.textRuns[0].text).toBe('SHASHANK KUMAR RATHOUR');
    expect((before.textRuns[0].sourceInstructionIndices ?? []).length).toBeGreaterThanOrEqual(2);

    const flow = buildDocumentFlow(before.textRuns);
    const line = flow.lines[0];
    const result = applyLineTextEdit(
      bytes,
      page,
      objects,
      line,
      'SHASHANK KUMxxxAR RATHOUR',
      flow,
    );

    // The grouped rewrite removes old glyphs; it must not paint over the background.
    expect(new TextDecoder().decode(result.newContentBytes)).not.toMatch(
      /1\s+1\s+1\s+rg\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+[-\d.]+\s+re\s+f\b/,
    );

    const after = interpretPage(result.newContentBytes, page, objects);
    const joined = after.textRuns.map(r => r.text).join('');
    expect(joined).toContain('KUMxxxAR');
    // Must not leave the old second fragment beside the rewrite
    expect(joined).not.toMatch(/RATHOUR.*KUMAR RATHOUR/);
    expect((joined.match(/RATHOUR/g) || []).length).toBe(1);
  });
});
