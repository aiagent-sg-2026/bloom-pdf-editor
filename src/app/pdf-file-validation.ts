/** Cheap PDF identification used before handing a file to the parser. */
export function isPdfFile(
  name: string,
  mimeType: string,
  firstBytes: Uint8Array,
): boolean {
  if (mimeType === 'application/pdf' || name.toLowerCase().endsWith('.pdf')) return true;
  const sample = new TextDecoder('latin1').decode(firstBytes.slice(0, 1024));
  return sample.includes('%PDF-');
}
