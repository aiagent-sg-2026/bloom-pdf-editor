import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const browserCore = path.join(root, 'src/engine/browser-core.ts');
const failures = [];

if (!fs.existsSync(browserCore)) failures.push('src/engine/browser-core.ts is missing');


if (fs.existsSync(browserCore)) {
  const source = fs.readFileSync(browserCore, 'utf8');
  if (/export\s+\*\s+from\s+['"]\.\/index['"]/.test(source)) {
    failures.push('browser-core must not export-star from ./index');
  }
  if (/from\s+['"]\.\/index['"]|from\s+['"]@\/engine['"]/.test(source)) {
    failures.push('browser-core must not import or re-export the root engine barrel');
  }

  let surface = 0;
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+['"]/g)) {
    surface += match[1].split(',').map((name) => name.trim()).filter(Boolean).length;
  }
  for (const match of source.matchAll(/export\s+(?:type\s+)?([^\n;]+?)\s+from\s+['"]/g)) {
    if (!match[0].includes('{')) surface += match[1].split(',').map((name) => name.trim()).filter(Boolean).length;
  }
  // The current inventory is intentionally broad because the browser UI uses
  // advanced signatures/security. Keep modest headroom for additive UI work.
  if (surface > 180) failures.push(`browser-core surface is ${surface}; bounded maximum is 180`);
  console.log(`browser-core explicit surface: ${surface} names/types (limit 180)`);
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.[jt]sx?$/.test(entry.name)) continue;
    const rel = path.relative(root, full).split(path.sep).join('/');
    if (!/^src\/(app|lib)\//.test(rel)) continue;
    const source = fs.readFileSync(full, 'utf8');
    if (/from\s+['"]@\/engine['"]|import\(\s*['"]@\/engine['"]\s*\)/.test(source)) {
      failures.push(`${rel} imports the broad '@/engine' root barrel`);
    }
  }
}

walk(path.join(root, 'src/app'));
walk(path.join(root, 'src/lib'));

if (failures.length) {
  console.error('Browser-core verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Browser-core verification passed.');
}
