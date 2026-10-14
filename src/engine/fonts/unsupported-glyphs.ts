/** Export cannot preserve these characters with the selected font and available fallbacks. */
export class UnsupportedGlyphsError extends Error {
  readonly codePoints: readonly number[];
  readonly characters: readonly string[];

  constructor(codePoints: Iterable<number>) {
    const unique = Array.from(new Set(codePoints));
    const characters = unique.map(cp => String.fromCodePoint(cp));
    super(`These characters need an embedded font: ${characters.join(' ')}`);
    this.name = 'UnsupportedGlyphsError';
    this.codePoints = unique;
    this.characters = characters;
  }
}
