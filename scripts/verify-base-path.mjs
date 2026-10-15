import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? '').replace(/\/+$/, '');
if (!basePath) {
  console.log('base-path guard SKIP (root hosting)');
} else {
  const out = join(process.cwd(), 'out');
  let scanned = 0;
  const failures = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(file);
      } else if (/\.(?:html|js|mjs)$/.test(entry.name)) {
        scanned++;
        // Include JSON-escaped URLs and inline hydration strings in HTML.
        const text = readFileSync(file, 'utf8')
          .replace(/\\u002f|\\x2f/gi, '/')
          .replace(/\\\//g, '/')
          .replace(/\\(["'])/g, '$1');
        // Match URL starts, not /fonts/ or /brand/ inside a prefixed URL.
        const urls = text.matchAll(/(?:^|["'`(=\s])(\/(?:fonts|brand)\/[^"'`<>\s\\)]*)/g);
        for (const [, url] of urls) {
          if (!url.startsWith(`${basePath}/`)) {
            failures.push(`${relative(process.cwd(), file)}: ${url}`);
          }
        }
      }
    }
  };
  walk(out);
  if (!scanned) throw new Error('base-path guard found no HTML/JS in out/; run npm run build first');
  if (failures.length) throw new Error(`Unprefixed public asset URLs for ${basePath}:\n${[...new Set(failures)].join('\n')}`);
  console.log(`base-path guard PASS (${basePath}, ${scanned} HTML/JS files)`);
}
