import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../..');
const css = readFileSync(resolve(root, 'src/app/globals.css'), 'utf8');

function luminance(hex: string): number {
  const [r, g, b] = hex.slice(1).match(/../g)!.map(component => {
    const value = parseInt(component, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}

function contrast(a: string, b: string): number {
  const values = [luminance(a), luminance(b)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

describe('Paperloom identity assets', () => {
  it.each(['mark', 'logo', 'icon'])('ships a self-contained %s SVG with a usable viewBox', name => {
    const path = resolve(root, `public/brand/paperloom-${name}.svg`);
    expect(existsSync(path)).toBe(true);
    const svg = readFileSync(path, 'utf8');
    expect(svg).toMatch(/^\s*<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toMatch(/<\/svg>\s*$/);
    const viewBox = svg.match(/\bviewBox="([^"]+)"/)?.[1].trim().split(/\s+/).map(Number);
    expect(viewBox).toHaveLength(4);
    expect(viewBox!.every(Number.isFinite)).toBe(true);
    expect(viewBox![2]).toBeGreaterThan(0);
    expect(viewBox![3]).toBeGreaterThan(0);
    // All lettering is paths: no external-font dependency or missing font fallback.
    expect(svg).not.toMatch(/<text\b|<image\b|<script\b|<foreignObject\b|@import|@font-face|\b(?:href|src)\s*=/i);
    if (name === 'icon') expect(viewBox).toEqual([0, 0, 512, 512]);
  });

  it('documents every defined CSS palette token, including Tailwind aliases', () => {
    const docs = readFileSync(resolve(root, 'docs/BRAND.md'), 'utf8');
    const tokens = new Set([...css.matchAll(/^\s*(--[\w-]+)\s*:/gm)].map(match => match[1]));
    expect(tokens.has('--accent')).toBe(true);
    expect([...tokens].filter(token => !docs.includes(`\`${token}\``))).toEqual([]);
  });

  it('keeps primary text, selected text, and theme focus colors above WCAG thresholds', () => {
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const declarations = (theme: 'light' | 'dark'): Record<string, string> => {
      const block = blocks.find(match => match[1].includes(`[data-theme="${theme}"]`))!;
      return Object.fromEntries([...block[2].matchAll(/(--[\w-]+):\s*(#[\da-f]{6})/gi)]
        .map(match => [match[1], match[2]]));
    };
    const light = declarations('light');
    for (const theme of [light, { ...light, ...declarations('dark') }]) {
      for (const primary of ['--bloom-500', '--bloom-600', '--bloom-700']) {
        expect(contrast('#FFFFFF', theme[primary])).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(theme['--accent'], theme['--bloom-100'])).toBeGreaterThanOrEqual(4.5);
      for (const surface of ['--surface', '--panel', '--panel-elevated', '--ring-offset']) {
        expect(contrast(theme['--accent'], theme[surface])).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
