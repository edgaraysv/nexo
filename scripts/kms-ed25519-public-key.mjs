import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rawEd25519KeyFromSpki } from './sign-agent-release.mjs';

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: node scripts/kms-ed25519-public-key.mjs <KMS GetPublicKey DER file>');
    process.exitCode = 2;
  } else {
    try {
      console.log(rawEd25519KeyFromSpki(await readFile(path)).toString('base64'));
    } catch {
      console.error('unable to parse an Ed25519 KMS public key');
      process.exitCode = 1;
    }
  }
}
