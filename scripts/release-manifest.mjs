import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

async function walk(directory, root = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const fullPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink no permitido en release: ${fullPath}`);
    if (entry.isDirectory()) files.push(...await walk(fullPath, root));
    else if (entry.isFile()) files.push({ fullPath, path: relative(root, fullPath).split(sep).join('/') });
  }
  return files;
}

function gitValue(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`No se pudo obtener metadato Git: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}

const output = resolve(process.argv[2] ?? 'release');
const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
const commit = gitValue(['rev-parse', 'HEAD']);
const commitTime = Number(gitValue(['show', '-s', '--format=%ct', 'HEAD']));
assert.ok(/^[a-f0-9]{40,64}$/.test(commit), 'Commit Git inválido');
assert.ok(Number.isSafeInteger(commitTime) && commitTime > 0, 'Timestamp de commit inválido');

const initialFiles = await walk(output);
const paths = new Set(initialFiles.map(file => file.path));
for (const required of ['nexo-source.tar.gz', 'nexo-agent.exe', 'nexo-endpoint-installer.exe']) {
  assert.ok(paths.has(required), `Falta artefacto requerido: ${required}`);
}
assert.ok([...paths].some(path => path.endsWith('.cdx.json')), 'Falta el SBOM CycloneDX.');

const artifacts = await Promise.all(initialFiles.map(async file => {
  const contents = await readFile(file.fullPath);
  return {
    path: file.path,
    bytes: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
  };
}));

const manifest = {
  schemaVersion: 1,
  product: 'Nexo',
  packageVersion: packageJson.version,
  sourceRef: process.env.GITHUB_REF ?? gitValue(['describe', '--tags', '--exact-match', 'HEAD']),
  sourceCommit: commit,
  sourceCommitTime: new Date(commitTime * 1000).toISOString(),
  signature: 'GitHub Actions artifact attestation (Sigstore); no Authenticode signature',
  artifacts,
};
await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });

const checksumFiles = await walk(output);
const checksums = await Promise.all(checksumFiles
  .filter(file => file.path !== 'SHA256SUMS')
  .map(async file => {
    const contents = await readFile(file.fullPath);
    return `${createHash('sha256').update(contents).digest('hex')}  ${file.path}`;
  }));
await writeFile(join(output, 'SHA256SUMS'), `${checksums.join('\n')}\n`, { flag: 'wx' });
console.log(`Manifest listo para ${commit}: ${artifacts.length} artefactos de entrada + manifiesto y checksums.`);
