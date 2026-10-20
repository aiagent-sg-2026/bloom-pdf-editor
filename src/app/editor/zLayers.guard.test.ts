// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { Z_LAYERS } from './zLayers';

type Opening = ts.JsxOpeningElement | ts.JsxSelfClosingElement;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(file);
    return /\.tsx?$/.test(file) && !/\.(test|spec)\.tsx?$/.test(file) ? [file] : [];
  }).sort();
}

function attribute(opening: Opening, name: string): ts.JsxAttribute | undefined {
  return opening.attributes.properties.find((item): item is ts.JsxAttribute =>
    ts.isJsxAttribute(item) && item.name.getText() === name);
}

// Expand conditional class branches independently, including templates whose
// common prefix contains the positioning classes. Class order/formatting is irrelevant.
function classBranches(node: ts.Node | undefined): string[] {
  if (!node) return [''];
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isJsxExpression(node)) return classBranches(node.expression);
  if (ts.isParenthesizedExpression(node)) return classBranches(node.expression);
  if (ts.isConditionalExpression(node)) {
    return [...classBranches(node.whenTrue), ...classBranches(node.whenFalse)];
  }
  if (ts.isTemplateExpression(node)) {
    return node.templateSpans.reduce<string[]>((prefixes, span) =>
      prefixes.flatMap(prefix => classBranches(span.expression).map(value => prefix + value + span.literal.text)),
    [node.head.text]);
  }
  if (ts.isBinaryExpression(node)) {
    if (node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return classBranches(node.left).flatMap(left => classBranches(node.right).map(right => left + right));
    }
    if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
      return ['', ...classBranches(node.right)];
    }
  }
  return ['']; // Non-class expressions (e.g. a numeric width) add no utilities.
}

function inlineLayer(opening: Opening): number | undefined {
  const style = attribute(opening, 'style')?.initializer;
  if (!style || !ts.isJsxExpression(style) || !style.expression || !ts.isObjectLiteralExpression(style.expression)) return;
  const property = style.expression.properties.find((item): item is ts.PropertyAssignment =>
    ts.isPropertyAssignment(item) && item.name.getText() === 'zIndex');
  if (!property) return;
  const value = property.initializer;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (ts.isPropertyAccessExpression(value) && value.expression.getText() === 'Z_LAYERS') {
    return Z_LAYERS[value.name.text as keyof typeof Z_LAYERS];
  }
}

const breakpoints = ['', 'sm', 'md', 'lg', 'xl', '2xl'];
function utilitiesAt(classes: string, breakpoint: number): string[] {
  const tokens = classes.trim().split(/\s+/);
  // Base utilities first, then responsive overrides, regardless of source order.
  return breakpoints.slice(0, breakpoint + 1).flatMap(prefix => tokens.flatMap(token => {
    if (!prefix) return token.includes(':') ? [] : [token];
    return token.startsWith(`${prefix}:`) ? [token.slice(prefix.length + 1)] : [];
  }));
}

function layerOf(utilities: string[], opening: Opening): number {
  const inline = inlineLayer(opening);
  if (inline !== undefined) return inline;
  const values = utilities.flatMap(token => {
    const match = /^z-(?:\[(\d+)\]|(\d+))$/.exec(token);
    return match ? [Number(match[1] ?? match[2])] : [];
  });
  return values.length ? values[values.length - 1] : Number.NEGATIVE_INFINITY;
}

function openings(source: ts.SourceFile): Opening[] {
  const result: Opening[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) result.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return result;
}

const sources = sourceFiles(__dirname).map(file => ts.createSourceFile(
  file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true,
  file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
));

describe('editor stacking boundaries', () => {
  it('keeps all fixed fullscreen surfaces and drawers above canvas and chrome', () => {
    const failures: string[] = [];
    for (const source of sources) {
      for (const opening of openings(source)) {
        const tag = opening.tagName.getText(source);
        for (const classes of classBranches(attribute(opening, 'className')?.initializer)) {
          for (let viewport = 0; viewport < breakpoints.length; viewport++) {
            const utilities = utilitiesAt(classes, viewport);
            const positions = utilities.filter(value => ['fixed', 'absolute', 'relative', 'sticky', 'static'].includes(value));
            if (positions[positions.length - 1] !== 'fixed') continue;
            const has = (token: string) => utilities.includes(token);
            const fullscreen = has('inset-0') || ['top-0', 'right-0', 'bottom-0', 'left-0'].every(has);
            const modal = tag === 'Dialog.Overlay' || tag === 'Dialog.Content' ||
              (fullscreen && has('items-center') && has('justify-center'));
            // A bottom toolbar (<aside>) is chrome, not a drawer. Sheets span
            // the horizontal edges; side drawers span both vertical edges.
            const drawer = !fullscreen && (
              has('mobile-sheet-up') || has('mobile-drawer-right') ||
              (has('top-0') && has('bottom-0') && (has('left-0') || has('right-0'))) ||
              (tag !== 'aside' && has('bottom-0') && (has('inset-x-0') || (has('left-0') && has('right-0'))))
            );
            if (!fullscreen && !drawer && !modal) continue;
            const minimum = modal
              ? (tag === 'Dialog.Content' ? Z_LAYERS.modal : Z_LAYERS.modalBackdrop)
              : fullscreen ? Z_LAYERS.drawerBackdrop : Z_LAYERS.drawer;
            const layer = layerOf(utilities, opening);
            const location = `${relative(__dirname, source.fileName)}:${source.getLineAndCharacterOfPosition(opening.getStart()).line + 1}`;
            if (layer < minimum) failures.push(`${location} (${breakpoints[viewport] || 'base'}): layer ${layer}, requires >= ${minimum}`);

            // Combined backdrop + centered panel: content must sit above its backdrop.
            if (fullscreen && modal && ts.isJsxOpeningElement(opening) && ts.isJsxElement(opening.parent)) {
              for (const child of opening.parent.children) {
                if (!ts.isJsxElement(child)) continue;
                for (const branch of classBranches(attribute(child.openingElement, 'className')?.initializer)) {
                  if (layerOf(utilitiesAt(branch, viewport), child.openingElement) < Z_LAYERS.modal) {
                    failures.push(`${location}: centered modal content requires >= ${Z_LAYERS.modal}`);
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('isolates the marked workspace without clipping negative-offset canvas controls', () => {
    const page = sources.find(source => relative(__dirname, source.fileName) === 'page.tsx');
    expect(page, 'editor page source').toBeDefined();
    const workspaces = openings(page!).filter(opening =>
      classBranches(attribute(opening, 'data-canvas-stack')?.initializer).includes('true'));
    expect(workspaces, 'one canvas stacking boundary').toHaveLength(1);
    for (const classes of classBranches(attribute(workspaces[0], 'className')?.initializer)) {
      const utilities = classes.trim().split(/\s+/);
      expect(utilities).toContain('relative');
      expect(utilities).toContain('isolate');
      expect(layerOf(utilities, workspaces[0])).toBeLessThan(Z_LAYERS.chrome);
      expect(utilities.some(token => /(?:^|:)overflow(?:-[xy])?-(?:hidden|clip)$/.test(token))).toBe(false);
    }
  });
});
