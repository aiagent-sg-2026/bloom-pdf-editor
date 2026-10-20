# Editor UI layers

`src/app/editor/zLayers.ts` is the single layer scale. Use `Z_LAYERS` for inline
`zIndex`, or literal Tailwind classes with a comment referencing the scale.
Do not build Tailwind class names dynamically.

| Surface | Layer |
| --- | ---: |
| Canvas-local overlays | 0–99 |
| Sidebars and mobile tools strip (`chrome`) | 100 |
| Expanded thumbnails sidebar | 110 |
| Toolbar, including the parent context of its download menu | 120 |
| Dropdowns, popovers, sidebar portal tooltips | 200 |
| Drawer backdrop | 300 |
| Drawer / mobile sheet | 400 |
| Modal backdrop | 500 |
| Modal content | 600 |
| Global toast / notification | 700 |

## Stacking boundaries

The scroll viewport in `src/app/editor/page.tsx` has
`data-canvas-stack="true"` and `relative isolate`. It contains the PDF canvas,
drawings, image and signature frames/handles/toolbars, editable text, floating
text/images, watermark previews, search highlights, alignment guides, link
popovers, and in-canvas notifications. Their z-indexes are **local**, not global.
The workspace itself stays at the base stacking level, below every chrome tier.
Do not add a positive global z-index to this workspace.

Isolation establishes a stacking context; it does not establish a new clipping
boundary or a fixed-position containing block. Keep existing scrolling, page
padding, and overflow behavior. Do not add `overflow-hidden`, `overflow-clip`,
paint containment, or a transform to fix layering. Negative-offset Image /
Replace / Deselect toolbars, resize handles, and floating image buttons must be
able to extend beyond their canvas item or page box.

Existing canvas-local ordering is retained, including image frame 70 and handle
80. `EMBEDDED_IMAGE_OVERLAY_LAYERS` remains exported and consumes the shared
scale. The link popover is anchored inside the workspace at local 50; it is not
a global dropdown. The hidden text measurement span's negative z-index is an
internal sublayer of its local text box, not a global surface.

Global drawers and dialogs must remain outside the workspace. Radix dialog and
sidebar tooltip portals render outside it. Sidebar portal tooltips at 200 are
intentional: they beat other sidebars, but stay below drawer backdrops and
modals. A nested popup cannot escape its parent's stacking context by increasing
its own z-index; the toolbar is above the sidebars so its download menu can
paint over them. The download menu uses 400 as a mobile sheet and 200 at `md`
and larger, still contained by the toolbar context and below global drawers.

A backdrop must be below its own panel. Password and confirmation dialogs use
a combined fullscreen backdrop/container at 500, with their direct flex-item
content at 600. Radix dialogs use separate portalled overlay/content nodes at
500/600. Global status/error toasts use 700; canvas progress/search UI remains
canvas-local and must not pierce global surfaces.

## Regression checks

- `zLayers.test.ts` enforces strict tier ordering, integral values, and the
  canvas-local image frame/handle range and ordering.
- `zLayers.guard.test.ts` reads editor sources in the Node environment. It parses
  JSX, expands conditional/template classes, and checks fixed fullscreen
  overlays, drawers, modal content, and the workspace isolation marker. It
  handles responsive mobile-sheet/desktop-dropdown layers without depending on
  class ordering or whitespace. Keep fixed surface classes literal (or use
  inline numeric / `Z_LAYERS` z-indexes) so guards can inspect them.
- Browser regression scenario: select an embedded image with Select, open Export,
  and check that the frame, all four handles, and Image / Replace / Deselect
  toolbar are behind both backdrop and drawer. Close Export; verify the
  negative-offset toolbar and corner handles remain visible and clickable.
  Repeat with a modal above an open drawer, desktop sidebar tooltips/download
  menu, and mobile sheets. Source guards cannot prove painting or hit testing.
