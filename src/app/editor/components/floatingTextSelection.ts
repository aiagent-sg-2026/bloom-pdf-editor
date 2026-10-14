/** Only the just-created box gets a replacement selection; existing boxes keep their caret. */
export function initialFloatingTextSelection(
  pendingBoxId: string | null, boxId: string, text: string,
): [number, number] | null {
  return pendingBoxId === boxId ? [0, text.length] : null;
}
