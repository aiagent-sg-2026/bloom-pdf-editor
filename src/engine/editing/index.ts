export { QuadTree, hitTestSpatial } from './spatial-index';
export { TransactionStack } from './transactions';
export {
  EditorHistory,
  captureHistoryEntry,
  captureAnnotSnapshot,
  restoreAnnotSnapshot,
  restoreDocumentStructure,
  clonePDFObject,
  makeOverlaySnapshot,
  parseOverlaySnapshot,
} from './editor-history';
export type {
  EditorHistoryEntry,
  OverlaySnapshot,
  PageAnnotSnapshot,
} from './editor-history';
export { buildDisplayListIndex, hitTestDisplayList, isSelectableDisplayItem, isPageBackgroundPath } from './selection';
export { buildSceneGraph, hitTestScene, resetSceneIdCounter } from './scene-graph';
export type { EditableObject } from './scene-graph';
export {
  identityAffine,
  multiplyAffine,
  invertAffine,
  transformPoint,
  composeTransform,
  transformObject,
  snapToGuides,
} from './transform-editor';
export type {
  Affine,
  ComposeOps,
  ObjectTransformOps,
  Guide,
  SnapGuide,
} from './transform-editor';
export {
  buildPageGuides,
  buildObjectGuides,
  buildAllGuides,
  pageGuides,
  objectGuides,
  allGuides,
} from './snap-guides';
export type { Bounds, SpatialEntry } from './spatial-index';
export type { EditSnapshot } from './transactions';
export type { SelectableItem } from './selection';

// Word-like text editing modules
export { CaretManager } from './caret-manager';
export { SelectionHandler } from './selection-handler';
export type { NormalizedRange } from './selection-handler';
export { InputHandler } from './input-handler';
export type { KeyModifiers, EditState, EditAction, EditActionKind } from './input-handler';
export { EditorController } from './editor-controller';
export type { EditorPhase, EditorSnapshot, EditEvent } from './editor-controller';
export type {
  CaretState,
  SelectionState,
  EditTransaction,
  LayoutPlan,
  LineEdit,
  RunPositionShift,
  EditResult,
} from './types';
