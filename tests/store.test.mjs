import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/store.js';
import { sha256hex, newToken } from '../server/secure.js';

function freshStore() {
  return openStore(':memory:');
}

test('initSchema is idempotent', () => {
  const s = freshStore();
  s.initSchema();
  s.initSchema(); // second run must not throw
  s.close();
});

test('createServer returns plaintext token once; db stores only its hash', () => {
  const s = freshStore();
  const { id, token } = s.createServer({ name: 'web-1', tag: 'hk', intervalSec: 10 });
  assert.equal(typeof id, 'number');
  assert.equal(token.length, 64); // 32 bytes hex
  const raw = s.db.prepare('SELECT token_hash FROM servers WHERE id=?').get(id);
  assert.equal(raw.token_hash, sha256hex(token));
  assert.ok(!JSON.stringify(s.listServers()).includes(token));
  s.close();
});

test('findServerByToken hit and miss', () => {
  const s = freshStore();
  const a = s.createServer({ name: 'a' });
  const b = s.createServer({ name: 'b' });
  assert.equal(s.findServerByToken(a.token).id, a.id);
  assert.equal(s.findServerByToken(b.token).id, b.id);
  assert.equal(s.findServerByToken('nope'), null);
  s.close();
});

test('server CRUD: get, update patch, delete cascades', () => {
  const s = freshStore();
  const { id, token } = s.createServer({ name: 'old', tag: '', provider: 'Dox' });
  s.updateServer(id, { name: 'new', tag: 'us', expiresAt: 1790000000000, priceCny: 9.9 });
  const row = s.getServer(id);
  assert.equal(row.name, 'new');
  assert.equal(row.tag, 'us');
  assert.equal(row.expiresAt, 1790000000000);
  assert.equal(row.priceCny, 9.9);
  assert.equal(row.provider, 'Dox');

  s.insertMetric(id, { ts: 1000, cpuPct: 1 });
  s.openEvent({ serverId: id, type: 'cpu', level: 'critical', message: 'x' });
  s.deleteServer(id);
  assert.equal(s.getServer(id), null);
  assert.equal(s.findServerByToken(token), null);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM metrics WHERE server_id=?').get(id).c, 0);
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM events WHERE server_id=?').get(id).c, 0);
  s.close();
});

test('resetToken invalidates old token immediately', () => {
  const s = freshStore();
  const { id, token } = s.createServer({ name: 'a' });
  const fresh = s.resetToken(id);
  assert.notEqual(fresh, token);
  assert.equal(s.findServerByToken(token), null);
  assert.equal(s.findServerByToken(fresh).id, id);
  s.close();
});

test('getHistory on empty db returns empty', () => {
  const s = freshStore();
  assert.deepEqual(s.getHistory(1, 0, Date.now()), { points: [], downsampled: false });
  s.close();
});

test('getHistory downsamples >400 points to equal-width bucket means', () => {
  const s = freshStore();
  const { id } = s.createServer({ name: 'a' });
  const N = 1000;
  for (let i = 0; i < N; i++) {
    s.insertMetric(id, { ts: i * 1000, cpuPct: i % 10, uptimeSec: i });
  }
  const from = 0, to = N * 1000;
  const { points, downsampled } = s.getHistory(id, from, to, 400);
  assert.equal(downsampled, true);
  assert.ok(points.length <= 400, `expected <=400, got ${points.length}`);
  assert.ok(points.length > 0);
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].ts >= points[i - 1].ts, 'ts must be monotonic');
  }
  // first bucket covers ts 0..~ (N*1000/400): mean of i%10 over ~3 samples
  assert.ok(Number.isFinite(points[0].cpuPct));
  // no downsampling when under limit (bounds inclusive: ts 0..100000 → 101 points)
  const small = s.getHistory(id, 0, 100 * 1000, 400);
  assert.equal(small.downsampled, false);
  assert.equal(small.points.length, 101);
  s.close();
});

test('pruneOlderThan removes old points, keeps fresh ones', () => {
  const s = freshStore();
  const { id } = s.createServer({ name: 'a' });
  s.insertMetric(id, { ts: 1000, cpuPct: 1 });
  s.insertMetric(id, { ts: 900000000000, cpuPct: 2 });
  const removed = s.pruneOlderThan(900000000000);
  assert.equal(removed, 1);
  const left = s.getHistory(id, 0, Number.MAX_SAFE_INTEGER, 400).points;
  assert.equal(left.length, 1);
  assert.equal(left[0].cpuPct, 2);
  s.close();
});

test('openEvent is idempotent while open; reopen after resolve creates new event', () => {
  const s = freshStore();
  const { id } = s.createServer({ name: 'a' });
  const e1 = s.openEvent({ serverId: id, type: 'cpu', level: 'critical', message: 'hi', }, 1000);
  const e1again = s.openEvent({ serverId: id, type: 'cpu', level: 'critical', message: 'hi' }, 2000);
  assert.equal(e1, e1again);
  const resolved = s.resolveEvent(id, 'cpu', 3000);
  assert.equal(resolved, 1);
  const e2 = s.openEvent({ serverId: id, type: 'cpu', level: 'critical', message: 'hi' }, 4000);
  assert.notEqual(e2, e1);
  const rows = s.listEvents({ serverId: id });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].startedAt >= rows[1].startedAt, true); // newest first
  s.close();
});

test('latestPerServer returns most recent metric per server', () => {
  const s = freshStore();
  const a = s.createServer({ name: 'a' });
  const b = s.createServer({ name: 'b' });
  s.insertMetric(a.id, { ts: 1000, cpuPct: 5 });
  s.insertMetric(a.id, { ts: 2000, cpuPct: 7 });
  s.insertMetric(b.id, { ts: 1500, cpuPct: 9 });
  const map = s.latestPerServer();
  assert.equal(map.get(a.id).cpuPct, 7);
  assert.equal(map.get(b.id).cpuPct, 9);
  assert.equal(map.size, 2);
  s.close();
});

test('settings roundtrip and admin password hash helpers', () => {
  const s = freshStore();
  assert.equal(s.getSetting('nope', 'def'), 'def');
  s.setSetting('webhookUrl', 'https://example.com/hook');
  assert.equal(s.getSetting('webhookUrl'), 'https://example.com/hook');
  assert.equal(s.getAdminPasswordHash(), null);
  s.setAdminPasswordHash('scrypt$1$ab$cd');
  assert.equal(s.getAdminPasswordHash(), 'scrypt$1$ab$cd');
  s.close();
});

test('sessions: create/validate/expire/delete', () => {
  const s = freshStore();
  const token = s.createSession(1000, 1000); // ttl=1000ms, now=1000ms
  assert.equal(token.length, 64);
  assert.equal(s.getSession(token, 1400).expiresAt, 2000);
  assert.equal(s.getSession(token, 2001), null, 'expired session must not validate');
  s.deleteSession(token);
  assert.equal(s.getSession(token, 1400), null);
  s.close();
});

test('newToken is unique and well-formed', () => {
  const a = newToken();
  const b = newToken();
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b);
});
