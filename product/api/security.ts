import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 32;

function deriveKey(password: string, salt: Uint8Array, length: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, length, { ...options, maxmem: 64 * 1024 * 1024 }, (error, derived) => error ? reject(error) : resolve(derived));
  });
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || password.length > 1024) throw new Error('password_policy');
  const salt = randomBytes(16);
  const derived = await deriveKey(password, salt, SCRYPT_KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts.slice(1, 4).map(Number);
  if (![n, r, p].every(Number.isSafeInteger) || n! < 16_384 || r! < 1 || p! < 1) return false;
  try {
    const salt = Buffer.from(parts[4] ?? '', 'base64url');
    const expected = Buffer.from(parts[5] ?? '', 'base64url');
    if (salt.length < 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
    const actual = await deriveKey(password, salt, expected.length, { N: n!, r: r!, p: p! });
    return timingSafeEqual(actual, expected);
  } catch { return false; }
}

export function createOpaqueToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, tokenHash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function sealSecret(plaintext: string, key: Uint8Array): Buffer {
  if (key.length !== 32) throw new Error('secret_key_must_be_32_bytes');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

export function openSecret(sealed: Uint8Array, key: Uint8Array): string {
  if (key.length !== 32 || sealed.length < 29 || sealed[0] !== 1) throw new Error('invalid_sealed_secret');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.slice(1, 13));
  decipher.setAuthTag(sealed.slice(13, 29));
  return Buffer.concat([decipher.update(sealed.slice(29)), decipher.final()]).toString('utf8');
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function decodeBase32(value: string): Buffer {
  let bits = 0; let buffer = 0; const output: number[] = [];
  for (const character of value.replace(/=+$/u, '').replace(/\s+/gu, '').toUpperCase()) {
    const index = BASE32.indexOf(character); if (index < 0) throw new Error('invalid_totp_secret');
    buffer = (buffer << 5) | index; bits += 5;
    if (bits >= 8) { bits -= 8; output.push((buffer >> bits) & 0xff); }
  }
  return Buffer.from(output);
}

export function verifyTotp(secretBase32: string, code: string, nowMs = Date.now(), window = 1): boolean {
  if (!/^\d{6}$/u.test(code) || window < 0 || window > 2) return false;
  let secret: Buffer; try { secret = decodeBase32(secretBase32); } catch { return false; }
  if (secret.length < 10) return false;
  const counter = Math.floor(nowMs / 30_000);
  for (let offset = -window; offset <= window; offset += 1) {
    const payload = Buffer.alloc(8); payload.writeBigUInt64BE(BigInt(counter + offset));
    const digest = createHmac('sha1', secret).update(payload).digest();
    const position = digest.at(-1)! & 0x0f;
    const binary = ((digest[position]! & 0x7f) << 24) | (digest[position + 1]! << 16) | (digest[position + 2]! << 8) | digest[position + 3]!;
    const candidate = String(binary % 1_000_000).padStart(6, '0');
    if (timingSafeEqual(Buffer.from(candidate), Buffer.from(code))) return true;
  }
  return false;
}
