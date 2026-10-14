import type * as HarfBuzz from 'harfbuzzjs';
import { UnsupportedGlyphsError } from './unsupported-glyphs';

export interface ShapedGlyph { gid: number; advance: number; xOffset: number; yOffset: number }
export interface ShapedCluster { text: string; glyphs: ShapedGlyph[] }
let hb: typeof HarfBuzz | undefined;
let loading: Promise<void> | undefined;
const faces = new WeakMap<Uint8Array, { blob: HarfBuzz.Blob; face: HarfBuzz.Face; font: HarfBuzz.Font; buffer: HarfBuzz.Buffer }>();

/** The package fetches its new URL('harfbuzz.wasm', import.meta.url) webpack asset;
 * Node reads the same installed dist/harfbuzz.wasm using fs. Neither is eager. */
export function prepareShaping(): Promise<void> {
  return loading ??= import('harfbuzzjs').then(module => { hb = module; }).catch(error => {
    loading = undefined;
    throw error;
  });
}

/** Metrics are source-font units. Input bytes must remain immutable. */
export function shapeTextSync(bytes: Uint8Array, text: string, script: string, direction: 'ltr' = 'ltr'): ShapedCluster[] {
  if (!hb) throw new Error('Shaping was not prepared');
  if (direction !== 'ltr') throw new Error('Only LTR shaping is supported');
  if (!text) return [];
  let cached = faces.get(bytes);
  if (!cached) {
    const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const blob = new hb.Blob(data as ArrayBuffer);
    const face = new hb.Face(blob), font = new hb.Font(face), buffer = new hb.Buffer();
    font.setScale(face.upem, face.upem);
    cached = { blob, face, font, buffer };
    faces.set(bytes, cached);
  }
  const { buffer, font } = cached;
  buffer.reset();
  buffer.addText(text);
  buffer.setScript(script);
  buffer.setDirection(hb.Direction.LTR);
  buffer.setClusterLevel(hb.ClusterLevel.MONOTONE_GRAPHEMES);
  buffer.guessSegmentProperties();
  hb.shape(font, buffer);
  const infos = buffer.getGlyphInfos(), positions = buffer.getGlyphPositions();
  const clusters: ShapedCluster[] = [];
  for (let i = 0; i < infos.length;) {
    const start = infos[i].cluster;
    let end = i + 1;
    while (end < infos.length && infos[end].cluster === start) end++;
    const cluster: ShapedCluster = { text: text.slice(start, end < infos.length ? infos[end].cluster : text.length), glyphs: [] };
    for (; i < end; i++) {
      if (!infos[i].codepoint) throw new UnsupportedGlyphsError(Array.from(cluster.text, ch => ch.codePointAt(0)!));
      const pos = positions[i];
      cluster.glyphs.push({ gid: infos[i].codepoint, advance: pos.xAdvance, xOffset: pos.xOffset, yOffset: pos.yOffset });
    }
    clusters.push(cluster);
  }
  return clusters;
}

export async function shapeText(bytes: Uint8Array, text: string, script: string, direction: 'ltr' = 'ltr'): Promise<ShapedCluster[]> {
  await prepareShaping();
  return shapeTextSync(bytes, text, script, direction);
}
