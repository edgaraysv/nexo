import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from 'node:crypto';

export const RECOVERY_SCHEMA = 'nexo.control-recovery.v1';
export const CHECKPOINT_SCHEMA = 'nexo.security-checkpoint.v1';
const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

export interface RecoveryPayload {
  schema: typeof RECOVERY_SCHEMA;
  databaseSql: string;
  roles: Array<{ name: string; superuser: false; bypassRls: false; inherit: false }>;
  configuration: Record<string, unknown>;
  emission: Record<string, unknown>;
}

interface RecoveryEnvelope {
  schema: typeof RECOVERY_SCHEMA;
  keyId: string;
  algorithm: 'AES-256-GCM';
  createdAt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
  plaintextSha256: string;
}

export interface SecurityCheckpoint {
  schema: typeof CHECKPOINT_SCHEMA;
  epoch: number;
  issuedAt: string;
  revokedDeviceIds: string[];
  missingOperationIds: string[];
}

export interface SignedCheckpoint {
  body: string;
  mac: string;
}

function requireKey(key: Buffer): void {
  if (key.length !== 32) throw new Error('recovery key must be 32 bytes');
}

function validKeyId(value: string): boolean {
  return /^[A-Za-z0-9._-]{3,64}$/.test(value);
}

function validBase64(value: string): boolean {
  return value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function validIdentifiers(values: unknown): values is string[] {
  return Array.isArray(values) && values.length <= 10_000 && values.every((value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value));
}

function parseEnvelope(encoded: Buffer): RecoveryEnvelope {
  if (encoded.length < 2 || encoded.length > MAX_BUNDLE_BYTES) throw new Error('invalid recovery bundle');
  let value: unknown;
  try {
    value = JSON.parse(encoded.toString('utf8'));
  } catch {
    throw new Error('invalid recovery bundle');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid recovery bundle');
  const envelope = value as Partial<RecoveryEnvelope>;
  const keys = Object.keys(envelope).sort().join(',');
  if (keys !== 'algorithm,ciphertext,createdAt,keyId,nonce,plaintextSha256,schema,tag' ||
      envelope.schema !== RECOVERY_SCHEMA || envelope.algorithm !== 'AES-256-GCM' ||
      typeof envelope.keyId !== 'string' || !validKeyId(envelope.keyId) ||
      typeof envelope.createdAt !== 'string' || !Number.isFinite(Date.parse(envelope.createdAt)) ||
      typeof envelope.nonce !== 'string' || typeof envelope.tag !== 'string' ||
      typeof envelope.ciphertext !== 'string' || typeof envelope.plaintextSha256 !== 'string' ||
      !validBase64(envelope.nonce) || Buffer.from(envelope.nonce, 'base64').length !== 12 ||
      !validBase64(envelope.tag) || Buffer.from(envelope.tag, 'base64').length !== 16 ||
      !validBase64(envelope.ciphertext) || !/^[0-9a-f]{64}$/.test(envelope.plaintextSha256)) {
    throw new Error('invalid recovery bundle');
  }
  return envelope as RecoveryEnvelope;
}

function parsePayload(plain: Buffer): RecoveryPayload {
  let value: unknown;
  try {
    value = JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('invalid recovery payload');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid recovery payload');
  const payload = value as Partial<RecoveryPayload>;
  if (Object.keys(payload).sort().join(',') !== 'configuration,databaseSql,emission,roles,schema' ||
      payload.schema !== RECOVERY_SCHEMA || typeof payload.databaseSql !== 'string' || !Array.isArray(payload.roles) || payload.roles.length !== 1 ||
      !payload.configuration || typeof payload.configuration !== 'object' || Array.isArray(payload.configuration) ||
      !payload.emission || typeof payload.emission !== 'object' || Array.isArray(payload.emission)) {
    throw new Error('invalid recovery payload');
  }
  for (const role of payload.roles) {
    if (!role || typeof role !== 'object' || Object.keys(role).sort().join(',') !== 'bypassRls,inherit,name,superuser' ||
        role.name !== 'nexo_l02_runtime' || role.superuser !== false || role.bypassRls !== false || role.inherit !== false) {
      throw new Error('invalid recovery role');
    }
  }
  return payload as RecoveryPayload;
}

export function encryptRecoveryBundle(payload: RecoveryPayload, key: Buffer, keyId: string, createdAt = new Date().toISOString()): Buffer {
  requireKey(key);
  if (!validKeyId(keyId) || !Number.isFinite(Date.parse(createdAt))) throw new Error('invalid recovery metadata');
  const plain = Buffer.from(JSON.stringify(payload));
  if (plain.length > MAX_BUNDLE_BYTES) throw new Error('recovery payload too large');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const authenticated = Buffer.from(`${RECOVERY_SCHEMA}|${keyId}|${createdAt}`);
  cipher.setAAD(authenticated);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const envelope: RecoveryEnvelope = {
    schema: RECOVERY_SCHEMA,
    keyId,
    algorithm: 'AES-256-GCM',
    createdAt,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    plaintextSha256: createHash('sha256').update(plain).digest('hex')
  };
  return Buffer.from(JSON.stringify(envelope));
}

export function decryptRecoveryBundle(encoded: Buffer, key: Buffer, expectedKeyId: string): RecoveryPayload {
  requireKey(key);
  const envelope = parseEnvelope(encoded);
  if (envelope.keyId !== expectedKeyId) throw new Error('recovery key id mismatch');
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(Buffer.from(`${RECOVERY_SCHEMA}|${envelope.keyId}|${envelope.createdAt}`));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    const digest = createHash('sha256').update(plain).digest('hex');
    if (digest !== envelope.plaintextSha256) throw new Error('digest mismatch');
    return parsePayload(plain);
  } catch {
    throw new Error('recovery bundle authentication failed');
  }
}

export function signSecurityCheckpoint(checkpoint: SecurityCheckpoint, key: Buffer): SignedCheckpoint {
  requireKey(key);
  if (checkpoint.schema !== CHECKPOINT_SCHEMA || !Number.isSafeInteger(checkpoint.epoch) || checkpoint.epoch < 1 ||
      !Number.isFinite(Date.parse(checkpoint.issuedAt)) || !validIdentifiers(checkpoint.revokedDeviceIds) || !validIdentifiers(checkpoint.missingOperationIds)) {
    throw new Error('invalid security checkpoint');
  }
  const body = Buffer.from(JSON.stringify(checkpoint));
  return { body: body.toString('base64'), mac: createHmac('sha256', key).update(body).digest('hex') };
}

export function verifySecurityCheckpoint(signed: SignedCheckpoint, key: Buffer, minimumEpoch: number): SecurityCheckpoint {
  requireKey(key);
  if (!signed || typeof signed.body !== 'string' || typeof signed.mac !== 'string' || !validBase64(signed.body) || !/^[0-9a-f]{64}$/.test(signed.mac)) {
    throw new Error('invalid security checkpoint');
  }
  const body = Buffer.from(signed.body, 'base64');
  const actual = createHmac('sha256', key).update(body).digest();
  const expected = Buffer.from(signed.mac, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(actual, expected)) throw new Error('invalid security checkpoint');
  let checkpoint: SecurityCheckpoint;
  try {
    checkpoint = JSON.parse(body.toString('utf8')) as SecurityCheckpoint;
  } catch {
    throw new Error('invalid security checkpoint');
  }
  if (checkpoint.schema !== CHECKPOINT_SCHEMA || !Number.isSafeInteger(checkpoint.epoch) || checkpoint.epoch < minimumEpoch ||
      !Number.isFinite(Date.parse(checkpoint.issuedAt)) || !validIdentifiers(checkpoint.revokedDeviceIds) || !validIdentifiers(checkpoint.missingOperationIds)) {
    throw new Error('stale security checkpoint');
  }
  return checkpoint;
}
