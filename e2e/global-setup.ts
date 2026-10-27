import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function globalSetup() {
  execFileSync(process.execPath, [path.resolve(__dirname, 'fixtures/make-fixtures.mjs')], {
    stdio: 'inherit',
  });
}
