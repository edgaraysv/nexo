import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const schema = 'nexo.agent-update.v2';
const semver = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const keyIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const spkiEd25519Prefix = Buffer.from('302a300506032b6570032100', 'hex');

export function signingPayload(manifest) {
  const blocked = manifest.blocked_rollback_versions ?? [];
  assert.ok(Array.isArray(blocked) && blocked.every(version => semver.test(version)), 'blocked rollback versions invalid');
  const signed = {
    schema: manifest.schema,
    version: manifest.version,
    operating_system: manifest.operating_system,
    architecture: manifest.architecture,
    size: manifest.size,
    sha256: manifest.sha256,
    minimum_current_version: manifest.minimum_current_version,
    minimum_allowed_version: manifest.minimum_allowed_version,
    metadata_version: manifest.metadata_version,
    security_epoch: manifest.security_epoch,
    blocked_rollback_versions: blocked,
    key_id: manifest.key_id,
    issued_at: manifest.issued_at,
    expires_at: manifest.expires_at,
  };
  return Buffer.from(JSON.stringify(signed), 'utf8');
}

export function rawEd25519KeyFromSpki(spki) {
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('KMS public key must be Ed25519');
  const raw = Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');
  if (raw.length !== 32) throw new Error('KMS Ed25519 public key has invalid length');
  return raw;
}

export function verifyKmsSignature(manifest, signature, trustKeys) {
	if (!Object.hasOwn(trustKeys, manifest.key_id) || typeof trustKeys[manifest.key_id] !== 'string') return false;
	const rawPublicKey = Buffer.from(trustKeys[manifest.key_id], 'base64');
  if (rawPublicKey.length !== 32 || signature.length !== 64) return false;
  const publicKey = createPublicKey({ key: Buffer.concat([spkiEd25519Prefix, rawPublicKey]), format: 'der', type: 'spki' });
  return verify(null, signingPayload(manifest), publicKey, signature);
}

function requiredVersion(value, name) {
  if (!semver.test(value ?? '')) throw new Error(`${name} must be a canonical x.y.z version`);
  if (value.split('.').some(part => !Number.isSafeInteger(Number(part)))) throw new Error(`${name} components exceed the safe integer range`);
  return value;
}

function requiredPositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive safe integer`);
  return parsed;
}

async function signRelease(argv) {
  const [artifactArgument, feedArgument, versionArgument, metadataArgument, epochArgument, minCurrentArgument, minAllowedArgument] = argv;
  if (!artifactArgument || !feedArgument || !versionArgument || !metadataArgument || !epochArgument || !minCurrentArgument || !minAllowedArgument) {
    throw new Error('usage: node scripts/sign-agent-release.mjs <nexo-agent.exe> <feed-dir> <version> <metadata-version> <security-epoch> <minimum-current-version> <minimum-allowed-version>');
  }
  const artifact = resolve(artifactArgument);
  const feedDir = resolve(feedArgument);
  const version = requiredVersion(versionArgument, 'version');
  const metadataVersion = requiredPositiveInteger(metadataArgument, 'metadata-version');
  const securityEpoch = requiredPositiveInteger(epochArgument, 'security-epoch');
  const minimumCurrentVersion = requiredVersion(minCurrentArgument, 'minimum-current-version');
  const minimumAllowedVersion = requiredVersion(minAllowedArgument, 'minimum-allowed-version');
  if (compareVersion(version, minimumCurrentVersion) < 0 || compareVersion(version, minimumAllowedVersion) < 0) throw new Error('release version is below a declared version floor');

  const kmsKeyId = process.env.NEXO_AGENT_UPDATE_KMS_KEY_ID;
  const keyId = process.env.NEXO_AGENT_UPDATE_SIGNING_KEY_ID;
  const trustKeysB64 = process.env.NEXO_AGENT_UPDATE_TRUST_KEYS_B64;
  if (!kmsKeyId || !keyId || !keyIdPattern.test(keyId) || !trustKeysB64) throw new Error('KMS key id, signing key id and embedded trust keyring are required');
  if (trustKeysB64.length > 65536) throw new Error('embedded update trust keyring exceeds the size limit');
  const trustKeys = JSON.parse(Buffer.from(trustKeysB64, 'base64').toString('utf8'));
  if (!trustKeys || typeof trustKeys !== 'object' || Array.isArray(trustKeys) || !Object.hasOwn(trustKeys, keyId) || typeof trustKeys[keyId] !== 'string') throw new Error('signing key id is absent from the agent trust keyring');

  const artifactInfo = await lstat(artifact);
  if (!artifactInfo.isFile() || artifactInfo.isSymbolicLink() || artifactInfo.size < 1 || artifactInfo.size > 64 * 1024 * 1024) throw new Error('agent artifact must be a regular file of 1..64 MiB');
  const contents = await readFile(artifact);
  const issuedAt = new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
  const blocked = (process.env.NEXO_AGENT_UPDATE_BLOCKED_ROLLBACK_VERSIONS ?? '').split(',').map(item => item.trim()).filter(Boolean);
  if (blocked.some(item => !semver.test(item))) throw new Error('blocked rollback version invalid');
  const manifest = {
    schema,
    version,
    operating_system: 'windows',
    architecture: 'amd64',
    size: contents.length,
    sha256: createHash('sha256').update(contents).digest('hex'),
    minimum_current_version: minimumCurrentVersion,
    minimum_allowed_version: minimumAllowedVersion,
    metadata_version: metadataVersion,
    security_epoch: securityEpoch,
    blocked_rollback_versions: blocked,
    key_id: keyId,
    issued_at: issuedAt,
    expires_at: expiresAt,
  };
  if (blocked.length > 256) throw new Error('blocked rollback version list exceeds the limit');
  const currentManifestPath = join(feedDir, 'current', 'manifest.json');
  let previousManifest;
  let hasPreviousManifest = false;
  try {
    previousManifest = JSON.parse(await readFile(currentManifestPath, 'utf8'));
    hasPreviousManifest = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('existing update metadata is invalid; refuse to replace it');
  }
  if (hasPreviousManifest) {
    if (previousManifest === null || typeof previousManifest !== 'object' || Array.isArray(previousManifest)) {
      throw new Error('existing update metadata is not a valid signed release; refuse to replace it');
    }
    let previousSignature = Buffer.alloc(0);
    if (typeof previousManifest.signature === 'string') previousSignature = Buffer.from(previousManifest.signature, 'base64');
    let previousSignatureValid = false;
    try {
      previousSignatureValid = verifyKmsSignature(previousManifest, previousSignature, trustKeys);
    } catch {
      previousSignatureValid = false;
    }
    const previousFieldsValid = previousManifest.schema === schema
      && typeof previousManifest.version === 'string' && semver.test(previousManifest.version)
      && typeof previousManifest.minimum_current_version === 'string' && semver.test(previousManifest.minimum_current_version)
      && typeof previousManifest.minimum_allowed_version === 'string' && semver.test(previousManifest.minimum_allowed_version)
      && typeof previousManifest.key_id === 'string' && keyIdPattern.test(previousManifest.key_id)
      && [previousManifest.version, previousManifest.minimum_current_version, previousManifest.minimum_allowed_version].every(value => value.split('.').every(part => Number.isSafeInteger(Number(part))))
      && typeof previousManifest.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(previousManifest.sha256)
      && previousManifest.operating_system === 'windows' && previousManifest.architecture === 'amd64'
      && Number.isSafeInteger(previousManifest.size) && previousManifest.size > 0 && previousManifest.size <= 64 * 1024 * 1024
      && Number.isSafeInteger(previousManifest.metadata_version) && previousManifest.metadata_version > 0
      && Number.isSafeInteger(previousManifest.security_epoch) && previousManifest.security_epoch > 0
      && Array.isArray(previousManifest.blocked_rollback_versions) && previousManifest.blocked_rollback_versions.length <= 256
      && previousManifest.blocked_rollback_versions.every(value => typeof value === 'string' && semver.test(value) && value.split('.').every(part => Number.isSafeInteger(Number(part))))
      && typeof previousManifest.issued_at === 'string' && Number.isFinite(Date.parse(previousManifest.issued_at))
      && typeof previousManifest.expires_at === 'string' && Number.isFinite(Date.parse(previousManifest.expires_at))
      && Date.parse(previousManifest.expires_at) > Date.parse(previousManifest.issued_at)
      && Date.parse(previousManifest.expires_at) - Date.parse(previousManifest.issued_at) <= 180 * 24 * 60 * 60 * 1000
      && compareVersion(previousManifest.version, previousManifest.minimum_current_version) >= 0
      && compareVersion(previousManifest.version, previousManifest.minimum_allowed_version) >= 0;
    if (!previousFieldsValid || !previousSignatureValid) throw new Error('existing update metadata is not a valid signed release; refuse to replace it');
    if (metadataVersion <= previousManifest.metadata_version || securityEpoch < previousManifest.security_epoch || compareVersion(version, previousManifest.version) < 0 || compareVersion(minimumAllowedVersion, previousManifest.minimum_allowed_version) < 0) {
      throw new Error('update metadata, epoch, version and minimum floor must advance monotonically');
    }
    if (version === previousManifest.version && manifest.sha256 !== previousManifest.sha256) throw new Error('a published agent version is immutable; increment the version for changed bytes');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'nexo-kms-sign-'));
  try {
    const messagePath = join(temporary, 'message.bin');
    await writeFile(messagePath, signingPayload(manifest), { mode: 0o600, flag: 'wx' });
    const result = spawnSync('aws', [
      'kms', 'sign', '--key-id', kmsKeyId,
      '--message', `fileb://${messagePath}`,
      '--message-type', 'RAW',
      '--signing-algorithm', 'ED25519_SHA_512',
      '--query', 'Signature', '--output', 'text',
    ], { encoding: 'utf8', windowsHide: true });
    if (result.error || result.status !== 0) throw new Error('AWS KMS signing failed; no manifest was published');
    const signature = Buffer.from(result.stdout.trim(), 'base64');
    if (!verifyKmsSignature(manifest, signature, trustKeys)) throw new Error('KMS signature did not match the embedded Go trust key');
    manifest.signature = signature.toString('base64');

    const releaseDirectory = join(feedDir, version);
    const currentDirectory = join(feedDir, 'current');
    await mkdir(releaseDirectory, { recursive: true });
    await mkdir(currentDirectory, { recursive: true });
    const releasePackagePath = join(releaseDirectory, 'nexo-agent.exe');
    let packageExists = false;
    try {
      const existingInfo = await lstat(releasePackagePath);
      if (!existingInfo.isFile() || existingInfo.isSymbolicLink()) throw new Error('existing versioned package is not a regular file');
      packageExists = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (packageExists) {
      const existingPackage = await readFile(releasePackagePath);
      if (createHash('sha256').update(existingPackage).digest('hex') !== manifest.sha256) throw new Error('a published agent version is immutable; increment the version for changed bytes');
    } else {
      await copyFile(artifact, releasePackagePath);
    }
    const published = await readFile(releasePackagePath);
    if (createHash('sha256').update(published).digest('hex') !== manifest.sha256) throw new Error('published package differs from the signed artifact');
    const manifestPath = join(currentDirectory, 'manifest.json');
    const temporaryManifest = join(currentDirectory, `.manifest-${process.pid}.tmp`);
    await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporaryManifest, manifestPath);
    console.log(`Signed Windows agent ${version}; feed: ${feedDir}`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function compareVersion(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) {
  signRelease(process.argv.slice(2)).catch(error => {
    console.error(error instanceof Error ? error.message : 'agent release signing failed');
    process.exitCode = 1;
  });
}
