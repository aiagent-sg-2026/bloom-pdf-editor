/**
 * Public API for the browser product.
 *
 * Keep this list explicit: the broad `./index` barrel remains available to
 * tests and compatibility consumers, but product code must depend on this
 * bounded browser-facing surface.
 */

export { PDFName, PDFRef } from './types';
export type { PDFObject, PDFDocumentData } from './types';

export { parsePDF } from './worker/client';
export { getPageContentBytes } from './parser/parser';
export { interpretPage } from './content/interpreter';
export type { TextRun, PathItem, ImageItem, DisplayItem } from './content/interpreter';

export { loadPageFonts } from './fonts/font-parser';
export { augmentFontsForMissingGlyphs } from './fonts/font-augmentation';
export type { FontData } from './fonts/font-parser';

export { renderPage } from './render/renderer';
export type { RenderResult } from './render/renderer';

export {
  buildDocumentFlow,
  applyLineTextEdit,
  correctLineResidualGaps,
  hitTestTextLine,
  findNearestTextLine,
  caretIndexFromLineX,
  lineXFromCaretIndex,
  distributeTextChangeToSegments,
  segmentAtIndex,
  visualFontSize,
  resolveRunStyleFlags,
  computeLineHeight,
  computeEditPreview,
  collectBatchedFontSizeTrailingShifts,
  duplicateLineBelow,
  duplicateTableRowBelow,
  getTableRowLines,
  insertTableColumnRight,
  applyStyleToSelectionOnPage,
  detectTablesOnPage,
} from './flow';
export type { TextLine, TextStylePatch, DetectedTable } from './flow';

export { ingestPage, blockPlainText } from './bloom';
export type { BloomBlock, BloomPage } from './bloom';

export { applyRunPositionShifts, findAndReplace, insertTextRun } from './editor/text-editor';
export { insertImageRun, replaceImageXObject } from './editor/image-editor';
export { applyObjectTransform, deleteObject } from './editor/object-editor';
export { addHighlightFromLineSelection } from './editor/highlight';
export { updatePageContent, serializeObject } from './editor/stream-compiler';
export { insertInvisibleTextLayer } from './editor/invisible-text';
export {
  createAnnotationDict,
  addAnnotationToPage,
  eraseAnnotationsAtPoint,
  clearMarkupAnnotationsOnPage,
} from './editor/annotation-engine';
export type { Annotation, AnnotationBase } from './editor/annotation-engine';
export type { PageLinkInfo } from './editor/link';
export {
  addLinkFromLineSelection,
  listPageLinks,
  hitTestPageLink,
  removePageLink,
  updatePageLinkUrl,
} from './editor/link';

export { getNextObjNum } from './writer/serializer';
export { saveQuick, saveOptimized, saveDocument } from './worker/client';
export {
  deletePage,
  rotatePageBy,
  movePage,
  insertBlankPage,
  extractPages,
  insertPagesFromDocument,
} from './writer/page-operations';

export {
  QuadTree,
  TransactionStack,
  EditorHistory,
  captureHistoryEntry,
  restoreAnnotSnapshot,
  parseOverlaySnapshot,
  buildDisplayListIndex,
  hitTestDisplayList,
  isSelectableDisplayItem,
  transformObject,
} from './editing';
export type { SelectableItem, EditableObject, EditorHistoryEntry } from './editing';

export { compressDocumentImages } from './optimize';

export {
  detectFormFieldsOnPage,
  hitTestFormField,
  setFormFieldValue,
  setButtonFieldValue,
  setChoiceFieldValue,
  flattenFormFieldsOnPage,
} from './forms';
export type { AcroFormWidget } from './forms';

export {
  createVisualSignature,
  hitTestSignature,
  moveSignature,
  resizeSignature,
  rotateSignature,
  setSignatureOpacity,
  setSignatureLocked,
  deleteSignature,
  updateSignature,
  getSignatureLibrary,
  DEFAULT_SIGNATURE_SIZE,
  detectSignatureFieldsOnPage,
  hitTestSignatureField,
  createSignatureFieldAtPoint,
  applySignatureFieldAppearanceAsync,
  getCertificateManager,
  signDocumentCryptographic,
  validateDocumentSignatures,
  enableLongTermValidation,
  getLtvStatus,
  listManagedSignatures,
  buildRevisionViewer,
  lockSignaturesAfterSigning,
  pushRecentSignatureId,
  orderLibraryByRecent,
  SIGNATURE_SHORTCUTS,
  buildSignatureAppearance,
  listAppearanceTemplates,
  renderSignatureAppearance,
  isAllowedSignatureFile,
  importSignatureFile,
  listTypedSignatureFonts,
  renderTypedSignature,
  SignatureDrawEngine,
  formatCertificateSummary,
} from './signatures';
export type {
  VisualSignature,
  SignatureLibraryEntry,
  SignatureField,
  ManagedIdentity,
  ValidationReport,
  LtvStatus,
  ManagedSignature,
  RevisionViewEntry,
  SignatureSourceKind,
} from './signatures';

export { securityEngine } from './security';
export type { PdfPermissions, FullSecurityReport } from './security';

export { buildTextWatermarkContent, buildImageWatermarkContent } from './watermark/watermark-engine';
export { applyWatermarks } from './watermark/watermark-engine';
export { detectWatermarks } from './watermark/watermark-detector';
export { removeWatermarks } from './watermark/watermark-remover';
export type { TextWatermark, ImageWatermark, Watermark } from './watermark/watermark-engine';
export type { DetectedWatermark } from './watermark/watermark-detector';

export { extractPagePlainText } from './ai';
