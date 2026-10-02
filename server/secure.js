// Small crypto helpers shared by store and auth.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function newToken(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

export function sha256hex(str) {
  return createHash('sha256').update(str).digest('hex');
}

export function safeEqualStr(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
