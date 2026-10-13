import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface TestCredentials {
  pem: string;
  certificatePem: string;
  certificateDer: Uint8Array;
}

let cached: TestCredentials | undefined;

/** Generate ephemeral credentials in the OS temp directory; no key material is committed. */
export function getTestCredentials(): TestCredentials {
  if (cached) return cached;
  const directory = mkdtempSync(join(tmpdir(), 'bloom-signature-'));
  const keyPath = join(directory, 'signer.key');
  const certPath = join(directory, 'signer.pem');
  const derPath = join(directory, 'signer.der');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=Bloom Test Signer',
  ], { stdio: 'ignore' });
  execFileSync('openssl', ['x509', '-in', certPath, '-outform', 'DER', '-out', derPath], {
    stdio: 'ignore',
  });
  const certificatePem = readFileSync(certPath, 'utf8');
  cached = {
    pem: `${readFileSync(keyPath, 'utf8')}\n${certificatePem}`,
    certificatePem,
    certificateDer: new Uint8Array(readFileSync(derPath)),
  };
  return cached;
}
