/**
 * Editor stacking contract. Global surfaces must use these layers (or the
 * matching literal Tailwind classes, with a reference to this scale).
 *
 * The relative, isolated data-canvas-stack workspace paints at the base layer.
 * Its descendants use 0–99 locally; even a high local layer cannot escape it.
 * Isolation does not clip negative-offset toolbars, buttons, or resize handles.
 */
export const Z_LAYERS = {
  canvasMin: 0,
  // Existing canvas-local ordering (drawings, text, guides, signatures) stays intact.
  canvasOverlay: 70,
  canvasHandle: 80,
  canvasMax: 99,
  chrome: 100,
  expandedSidebar: 110,
  // Above sidebars so the toolbar's nested download dropdown is not trapped below them.
  toolbar: 120,
  // Includes sidebar portal tooltips; never use an undocumented z-[200] popup.
  dropdown: 200,
  drawerBackdrop: 300,
  drawer: 400,
  modalBackdrop: 500,
  modal: 600,
  toast: 700,
} as const;
