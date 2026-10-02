// Password hashing (scrypt) and agent token verification.
import { scrypt, randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { newToken, sha256hex, safeEqualStr } from './secure.js';

const scryptAsync = promisify(scrypt);
const SCRYPT_N = 16384;
const KEY_LEN = 32;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password), salt, KEY_LEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  if (!Number.isInteger(n) || n <= 0) return false;
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  if (salt.length === 0 || expected.length === 0) return false;
  try {
    const key = await scryptAsync(String(password), salt, expected.length, { N: n });
    return safeEqualStr(key.toString('hex'), expected.toString('hex'));
  } catch {
    return false;
  }
}

export function verifyAgentToken(store, bearer) {
  if (typeof bearer !== 'string' || bearer.length === 0) return null;
  return store.findServerByToken(bearer);
}

export { newToken, sha256hex, safeEqualStr };
