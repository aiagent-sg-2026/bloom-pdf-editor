/**
 * Digital signatures — ASN.1 DER, PKCS#7/CMS, digest verification, signing.
 * Visual signatures — overlay placement, library, draw/import/typed, appearances.
 * Signature fields (Phase 4) + appearance streams (Phase 5).
 */

export {
  parseDERNode,
  parseDER,
  parseCMSSignedData,
  computeByteRangeDigest,
  verifySignatureDigest,
  decodeOID,
  nodeOID,
  parseContentInfo,
} from './crypto/signature-verify';

export {
  buildDetachedCMS,
  createSignatureField,
  signDocument,
  signDocumentWithResult,
  signDocumentCryptographic,
  createSignatureDictionary,
} from './crypto/sign';
export type { SignOptions, CryptoSignOptions, SignPipelineResult } from './crypto/sign';

export type {
  ASN1Class,
  ASN1Node,
  PKCS7ContentInfo,
  CMSSignedData,
  CMSSignerInfo,
  PDFSignatureDict,
  SignatureVerificationResult,
  VerifyDigestOptions,
} from './crypto/types';

export { DEFAULT_VERIFY_OPTIONS, OID, OID_TO_DIGEST } from './crypto/types';

// ── Visual signatures (Phases 1–3) ──

export type {
  SignatureAppearanceType,
  VisualSignature,
  SignatureSourceKind,
  SignatureLibraryEntry,
  StrokePoint,
  Stroke,
  DrawEngineOptions,
  AppearanceTextComponent,
  AppearanceImageComponent,
  AppearanceBackgroundComponent,
  AppearanceBorderComponent,
  SignatureAppearanceLayout,
  SignatureAppearance,
  AppearanceRenderOptions,
  AppearanceRenderResult,
} from './visual/visual-types';

export {
  DEFAULT_SIGNATURE_SIZE,
  TYPED_SIGNATURE_FONTS,
} from './visual/visual-types';

export {
  nextSignatureId,
  resetSignatureIdCounter,
  createVisualSignature,
  cloneVisualSignature,
  hitTestSignature,
  moveSignature,
  resizeSignature,
  rotateSignature,
  setSignatureOpacity,
  setSignatureLocked,
  deleteSignature,
  updateSignature,
  signatureToBBox,
} from './visual/signature-model';
export type { CreateSignatureOpts } from './visual/signature-model';
export { visualSignatureToImagePlacement } from './visual/signature-export';
export type { VisualSignatureImagePlacement } from './visual/signature-export';

export { SignatureHistory } from './visual/visual-history';
export type { SignatureSnapshot } from './visual/visual-history';

export {
  SignatureDrawEngine,
  paintStroke,
  strokeToPathD,
} from './visual/draw-engine';

export {
  isAllowedSignatureFile,
  importSignatureFile,
  importSvgString,
  importDataURL,
} from './visual/import-engine';
export type { ImportMime, ImportedSignature } from './visual/import-engine';

export {
  listTypedSignatureFonts,
  renderTypedSignature,
  typedSignatureToSVG,
} from './visual/typed-engine';
export type { TypedSignatureOptions, TypedSignatureResult } from './visual/typed-engine';

export {
  SignatureLibrary,
  getSignatureLibrary,
  resetSignatureLibraryForTests,
} from './visual/library';

export {
  buildSignatureAppearance,
  cloneAppearance,
  setAppearanceComponentVisible,
  updateAppearanceLayout,
  listAppearanceTemplates,
  getAppearanceTemplate,
} from './visual/appearance-builder';
export type { BuildAppearanceInput } from './visual/appearance-builder';

export type { AppearanceTemplate } from './visual/appearance-templates';

export {
  renderSignatureAppearance,
  buildAppearanceSVG,
  rasterizeAppearanceAsync,
} from './visual/appearance-renderer';

// ── Phase 4 — Signature fields ──

export type {
  SignatureField,
  CreateSignatureFieldOptions,
} from './fields/signature-field';

export {
  pageIndexForWidget,
  widgetToSignatureField,
  listSignatureFields,
  detectSignatureFieldsOnPage,
  hitTestSignatureField,
  lookupSignatureFieldByName,
  lookupSignatureFieldByRef,
  createSignatureFieldAtPoint,
  placeSignatureInField,
  hitTestAnyFormOrSignatureField,
  ensureAcroFormCatalog,
} from './fields/signature-field';

// ── Phase 5 — Appearance streams ──

export {
  AppearanceResourceManager,
  buildSignatureAppearanceContent,
  serializeAppearanceStream,
  attachNormalAppearance,
  embedAppearanceImage,
  dataUrlToJpegBytes,
  applySignatureFieldAppearance,
  applySignatureFieldAppearanceAsync,
  getNormalAppearanceRef,
} from './fields/appearance-stream';
export type {
  SignatureFieldAppearanceOptions,
  SerializedAppearance,
} from './fields/appearance-stream';

// ── Phase 7 — Hash / CMS / signing pipeline ──

export {
  hashBytes,
  hashByteRanges,
  bytesToHex,
  hexToBytes,
  toSubtleHashName,
  hashAlgorithmOID,
  hashDigestLength,
  HASH_ALGORITHMS,
} from './crypto/hash-engine';
export type { HashAlgorithm } from './crypto/hash-engine';

export {
  buildDetachedCMSAdvanced,
  getSignedAttributesForSigning,
  derLength,
  derSequence,
  derSet,
  derOctetString,
  derInteger,
  derObjectIdentifier,
} from './crypto/cms-builder';
export type { BuildCMSOptions, SignatureAlgorithmKind } from './crypto/cms-builder';

export {
  makeContentsPlaceholder,
  computeDocumentDigest,
  calculateByteRange,
  validateByteRange,
  hashExcludedContents,
  findContentsHexSpan,
  computeByteRangeFromContentsSpan,
  injectSignature,
  injectSignatureContents,
  fillContentsHex,
  patchByteRangeInPlace,
  finalizePdfSignature,
  DEFAULT_CONTENTS_SIZE,
  BYTERANGE_DIGIT_WIDTH,
} from './crypto/signing-pipeline';

export type { ByteRange, ContentsSpan, ByteRangeCalculation } from './crypto/byterange';
export type { FinalizeSignatureResult, FinalizeSignatureInput } from './crypto/finalizer';

// ── Phase 9 — Certificates ──

export {
  decodePem,
  isPem,
  parseCertificateDer,
  importPrivateKey,
  importFromPem,
  importCertificateDer,
  formatCertificateSummary,
  isCertificateExpired,
} from './certificates/certificate-parser';
export type {
  CertificateFormat,
  DistinguishedName,
  CertificateInfo,
  ImportedKeyMaterial,
  ImportedCertificateBundle,
} from './certificates/certificate-parser';

export {
  importPkcs12,
  detectCertificateFileFormat,
} from './certificates/pkcs12';

export {
  CertificateManager,
  getCertificateManager,
  resetCertificateManagerForTests,
} from './certificates/certificate-manager';
export type { ManagedIdentity } from './certificates/certificate-manager';

// ── Phase 10 — Validation ──

export {
  trimCmsPadding,
  extractPdfSignatureDict,
  extractSpkiFromCertificate,
  verifyCmsCryptographic,
  validateSignatureField,
  validateDocumentSignatures,
  validationStatusBadge,
} from './validation/validation-engine';
export type {
  ValidationStatus,
  TrustAnchor,
  ValidationOptions,
  CertificateValidationInfo,
  SignatureValidationDetail,
  ValidationReport,
} from './validation/validation-types';

// ── Phase 11 — Timestamps ──

export {
  buildTimestampRequest,
  parseTimestampResponse,
  requestTimestamp,
  cmsHasTimestampToken,
  DEFAULT_TSA_URLS,
} from './timestamp/timestamp-parser';
export type {
  TimestampRequestOptions,
  TimestampToken,
  TimestampResult,
} from './timestamp/timestamp-parser';

// ── Phase 12 — Multi-signature ──

export {
  listManagedSignatures,
  buildRevisionViewer,
  inspectMultiSignatures,
  canAddSignatureWithoutInvalidating,
} from './multi/multi-signature-manager';
export type {
  ManagedSignature,
  RevisionViewEntry,
  MultiSignatureSnapshot,
} from './multi/multi-signature-manager';

// ── Phase 13 — LTV / DSS ──

export {
  buildDocumentSecurityStore,
  embedDssIncremental,
  readDssSummary,
} from './ltv/dss-builder';
export type { DssBuildInput, DssBuildResult } from './ltv/dss-builder';

export {
  collectEmbeddedCertificates,
  enableLongTermValidation,
  getLtvStatus,
  fetchOcspPlaceholder,
} from './ltv/ltv-engine';
export type { LtvEnableOptions, LtvStatus } from './ltv/ltv-engine';

// ── Phase 14 — UX helpers ──

export {
  SIGNATURE_SHORTCUTS,
  pushRecentSignatureId,
  listRecentSignatureIds,
  orderLibraryByRecent,
  lockSignaturesAfterSigning,
  snapToAlignmentGuides,
  defaultPageGuides,
} from './ux/ux-helpers';
