import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const ignoredDirectories = new Set(['.git', 'node_modules', '.next', 'out', 'coverage']);
const ignoredFiles = new Set(['docs/PWA_BASELINE.md', 'scripts/verify-browser-only.mjs']);

function relative(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    const rel = relative(fullPath);
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) continue;
      if (entry.name === 'server') failures.push(`${rel}/ is a server directory`);
      walk(fullPath);
      continue;
    }
    if (!entry.isFile() || ignoredFiles.has(rel)) continue;
    const contents = fs.readFileSync(fullPath, 'utf8');
    if (/^src\/app\/api(?:\/|$)/.test(rel)) failures.push(`${rel} is an app API route`);
    if (/\b(?:server-only|bloom-api|bloom-server)\b|\/api\/bloom/.test(contents)) {
      failures.push(`${rel} contains a server-runtime residue`);
    }
  }
}

const configPath = path.join(root, 'next.config.ts');
const config = fs.readFileSync(configPath, 'utf8');
if (!/output\s*:\s*['"]export['"]/.test(config)) {
  failures.push('next.config.ts must configure output: \'export\'');
}

walk(root);

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const allPackages = {
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.devDependencies ?? {}),
};
for (const packageName of Object.keys(allPackages)) {
  if (/^(?:server-only|bloom-api|bloom-server)$/.test(packageName)) {
    failures.push(`package.json includes server-only package ${packageName}`);
  }
}

if (failures.length > 0) {
  console.error('Browser-only verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Browser-only verification passed.');
}
