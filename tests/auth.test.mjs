import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, verifyAgentToken } from '../server/auth.js';
import { openStore } from '../server/store.js';

test('hashPassword output verifies with correct password', async () => {
  const stored = await hashPassword('hunter2hunter2');
  assert.match(stored, /^scrypt\$16384\$[0-9a-f]{32}\$[0-9a-f]{64}$/);
  assert.equal(await verifyPassword('hunter2hunter2', stored), true);
});

test('wrong password fails verification', async () => {
  const stored = await hashPassword('correct-horse');
  assert.equal(await verifyPassword('wrong-battery', stored), false);
});

test('malformed stored hash returns false instead of throwing', async () => {
  for (const bad of ['', 'scrypt', 'scrypt$abc$xx$yy', 'plain$1$salt$hash', null, undefined]) {
    assert.equal(await verifyPassword('x', bad), false, String(bad));
  }
});

test('same password hashes differently (random salt) but both verify', async () => {
  const a = await hashPassword('pw');
  const b = await hashPassword('pw');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('pw', a), true);
  assert.equal(await verifyPassword('pw', b), true);
});

test('verifyAgentToken returns the right server row or null', () => {
  const store = openStore(':memory:');
  const a = store.createServer({ name: 'a' });
  const b = store.createServer({ name: 'b' });
  assert.equal(verifyAgentToken(store, a.token).id, a.id);
  assert.equal(verifyAgentToken(store, b.token).id, b.id, 'tokens must not cross servers');
  assert.equal(verifyAgentToken(store, 'garbage'), null);
  assert.equal(verifyAgentToken(store, ''), null);
  assert.equal(verifyAgentToken(store, undefined), null);
  store.close();
});
