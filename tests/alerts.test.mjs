import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertEngine } from '../server/alerts.js';
import { openStore } from '../server/store.js';

const MIN = 60_000;

function metric(ts, over = {}) {
  return { ts, cpuPct: 10, memUsed: 100, memTotal: 1000, memPct: 10,
    diskUsed: 10, diskTotal: 1000, ...over };
}

function setup({ expiresAt = null, intervalSec = 10 } = {}) {
  const store = openStore(':memory:');
  const notified = [];
  const engine = new AlertEngine(store, {
    thresholds: { cpu: 90, mem: 90, disk: 90, consecutive: 3, expiryDays: 7 },
    notifyCooldownMin: 10,
    onNotify: (event, server) => notified.push({ type: event.type, at: event.startedAt, server: server.id }),
  });
  const { id } = store.createServer({ name: 'web-1', intervalSec, expiresAt });
  const server = store.getServer(id);
  return { store, engine, notified, server };
}

function openEvents(store, serverId, type) {
  return store.listEvents({ serverId, limit: 50 }).filter((e) => e.type === type && e.resolvedAt === null);
}

test('cpu opens only after 3 consecutive over-threshold samples, resolves below', () => {
  const { store, engine, notified, server } = setup();
  engine.ingest(server, metric(1000, { cpuPct: 95 }), 1000);
  engine.ingest(server, metric(2000, { cpuPct: 95 }), 2000);
  assert.equal(openEvents(store, server.id, 'cpu').length, 0, 'streak of 2 must not open');
  assert.equal(notified.length, 0);

  engine.ingest(server, metric(3000, { cpuPct: 95 }), 3000);
  const open = openEvents(store, server.id, 'cpu');
  assert.equal(open.length, 1);
  assert.equal(open[0].level, 'critical');
  assert.equal(notified.length, 1);

  engine.ingest(server, metric(4000, { cpuPct: 89 }), 4000);
  assert.equal(openEvents(store, server.id, 'cpu').length, 0, '89% must resolve');
  store.close();
});

test('mem behaves like cpu; disk triggers on a single sample', () => {
  const { store, engine, notified, server } = setup();
  engine.ingest(server, metric(1000, { memPct: 95, memUsed: 950 }), 1000);
  engine.ingest(server, metric(2000, { memPct: 95, memUsed: 950 }), 2000);
  assert.equal(openEvents(store, server.id, 'mem').length, 0);

  engine.ingest(server, metric(3000, { memPct: 95, memUsed: 950 }), 3000);
  assert.equal(openEvents(store, server.id, 'mem').length, 1);

  engine.ingest(server, metric(4000, { diskUsed: 950, diskTotal: 1000 }), 4000);
  assert.equal(openEvents(store, server.id, 'disk').length, 1, 'disk is single-sample');
  assert.equal(notified.length, 2); // mem open + disk open
  store.close();
});

test('disk single-sample alert resolves when usage drops', () => {
  const { store, engine, server } = setup();
  engine.ingest(server, metric(1000, { diskUsed: 950, diskTotal: 1000 }), 1000);
  assert.equal(openEvents(store, server.id, 'disk').length, 1);
  engine.ingest(server, metric(2000, { diskUsed: 100, diskTotal: 1000 }), 2000);
  assert.equal(openEvents(store, server.id, 'disk').length, 0);
  store.close();
});

test('offline: tick flags silence beyond max(3*interval, 60s); fresh report resolves', () => {
  const { store, engine, notified, server } = setup({ intervalSec: 10 });
  engine.ingest(server, metric(10_000), 10_000);
  engine.tick(10_000 + 30_000); // within 3*interval*1000=30s window... boundary
  assert.equal(openEvents(store, server.id, 'offline').length, 0, 'silence 30s == 3*interval, not beyond');

  engine.tick(10_000 + 60_001); // beyond max(30s, 60s)=60s
  const offline = openEvents(store, server.id, 'offline');
  assert.equal(offline.length, 1);
  assert.equal(offline[0].level, 'critical');
  assert.equal(notified.filter((n) => n.type === 'offline').length, 1);

  engine.ingest(server, metric(70_000), 70_000);
  assert.equal(openEvents(store, server.id, 'offline').length, 0, 'fresh report resolves offline');
  store.close();
});

test('offline uses the server own interval when longer than 60s', () => {
  const { store, engine, server } = setup({ intervalSec: 60 }); // 3*interval = 180s
  engine.ingest(server, metric(10_000), 10_000);
  engine.tick(10_000 + 100_000);
  assert.equal(openEvents(store, server.id, 'offline').length, 0, '100s < 180s');
  engine.tick(10_000 + 180_001);
  assert.equal(openEvents(store, server.id, 'offline').length, 1);
  store.close();
});

test('expiry: opens warning within 7d, no re-notify for 24h, none beyond 7d', () => {
  const now = 1_800_000_000_000;
  const { store, engine, notified, server } = setup({ expiresAt: now + 3 * 24 * 3600 * 1000 });
  engine.tick(now);
  assert.equal(openEvents(store, server.id, 'expiry').length, 1);
  assert.equal(openEvents(store, server.id, 'expiry')[0].level, 'warning');
  assert.equal(notified.filter((n) => n.type === 'expiry').length, 1);

  engine.tick(now + 3600 * 1000); // 1h later: still open, no new notify
  assert.equal(openEvents(store, server.id, 'expiry').length, 1);
  assert.equal(notified.filter((n) => n.type === 'expiry').length, 1);

  const { store: store2, engine: engine2, notified: notified2, server: server2 } =
    setup({ expiresAt: now + 8 * 24 * 3600 * 1000 });
  engine2.tick(now);
  assert.equal(openEvents(store2, server2.id, 'expiry').length, 0);
  assert.equal(notified2.length, 0);
  store.close();
  store2.close();
});

test('expiry resolves when the date is pushed out again', () => {
  const now = 1_800_000_000_000;
  const { store, engine, server } = setup({ expiresAt: now + 3 * 24 * 3600 * 1000 });
  engine.tick(now);
  assert.equal(openEvents(store, server.id, 'expiry').length, 1);
  store.updateServer(server.id, { expiresAt: now + 400 * 24 * 3600 * 1000 });
  engine.tick(now + 1000);
  assert.equal(openEvents(store, server.id, 'expiry').length, 0);
  store.close();
});

test('notify cooldown suppresses re-notification within 10min, allows after', () => {
  const { store, engine, notified, server } = setup();
  const t = 1_000_000;
  engine.ingest(server, metric(t, { cpuPct: 99 }), t);
  engine.ingest(server, metric(t + 1000, { cpuPct: 99 }), t + 1000);
  engine.ingest(server, metric(t + 2000, { cpuPct: 99 }), t + 2000); // open + notify #1
  engine.ingest(server, metric(t + 3000, { cpuPct: 10 }), t + 3000); // resolve
  engine.ingest(server, metric(t + 5 * MIN, { cpuPct: 99 }), t + 5 * MIN);
  engine.ingest(server, metric(t + 5 * MIN + 1000, { cpuPct: 99 }), t + 5 * MIN + 1000);
  engine.ingest(server, metric(t + 5 * MIN + 2000, { cpuPct: 99 }), t + 5 * MIN + 2000); // re-open within cooldown
  assert.equal(notified.length, 1, '5min later is still within the 10min cooldown');
  assert.equal(openEvents(store, server.id, 'cpu').length, 1, 'a new open event exists');

  engine.ingest(server, metric(t + 6 * MIN, { cpuPct: 10 }), t + 6 * MIN);
  engine.ingest(server, metric(t + 11 * MIN, { cpuPct: 99 }), t + 11 * MIN);
  engine.ingest(server, metric(t + 11 * MIN + 1000, { cpuPct: 99 }), t + 11 * MIN + 1000);
  engine.ingest(server, metric(t + 11 * MIN + 2000, { cpuPct: 99 }), t + 11 * MIN + 2000);
  assert.equal(notified.length, 2, 'cooldown expired: second notification allowed');
  store.close();
});

test('state() exposes internal per-server memory', () => {
  const { engine, server } = setup();
  engine.ingest(server, metric(1000), 1000);
  assert.equal(engine.state(server.id).lastSeen, 1000);
});

test('a fresh engine (hub restart) does not re-notify an already-open event', () => {
  const store = openStore(':memory:');
  const notified = [];
  const opts = {
    thresholds: { cpu: 90, mem: 90, disk: 90, consecutive: 1, expiryDays: 7 },
    notifyCooldownMin: 10,
  };
  const first = new AlertEngine(store, { ...opts, onNotify: (e) => notified.push(e.type) });
  const { id } = store.createServer({ name: 'a', intervalSec: 10 });
  const server = store.getServer(id);
  first.ingest(server, metric(1000, { cpuPct: 99 }), 1000);
  assert.equal(notified.filter((t) => t === 'cpu').length, 1);

  const second = new AlertEngine(store, { ...opts, onNotify: (e) => notified.push(e.type) });
  second.ingest(server, metric(2000, { cpuPct: 99 }), 2000);
  second.tick(3000);
  assert.equal(notified.filter((t) => t === 'cpu').length, 1, 'open event reused: no duplicate webhook');
  store.close();
});

test('forget drops per-server memory when a server is deleted', () => {
  const { store, engine, server } = setup();
  engine.ingest(server, metric(1000), 1000);
  assert.ok(engine.state(server.id));
  engine.forget(server.id);
  assert.equal(engine.state(server.id), null);
  store.close();
});

test('traffic quota: exceeding opens warning, dropping resolves (v1.1)', () => {
  const { store, engine, notified, server } = setup();
  const GB = 1024 ** 3;
  store.updateServer(server.id, { monthlyQuotaBytes: 100 * GB });
  const quotaServer = store.getServer(server.id);

  engine.checkQuota(quotaServer, { monthlyRx: 60 * GB, monthlyTx: 50 * GB }, 1000);
  const over = store.listEvents({ serverId: server.id }).filter((e) => e.type === 'traffic');
  assert.equal(over.length, 1);
  assert.equal(over[0].level, 'warning');
  assert.match(over[0].message, /110\.0 GB/);
  assert.equal(notified.length, 1);

  // still over: no duplicate notify, event stays open
  engine.checkQuota(quotaServer, { monthlyRx: 95 * GB, monthlyTx: 10 * GB }, 2000);
  assert.equal(notified.length, 1);

  // back under quota: resolves
  engine.checkQuota(quotaServer, { monthlyRx: 10 * GB, monthlyTx: 5 * GB }, 3000);
  assert.equal(store.listEvents({ serverId: server.id }).filter((e) => e.type === 'traffic' && e.resolvedAt === null).length, 0);

  // no quota set: never alerts
  store.updateServer(server.id, { monthlyQuotaBytes: null });
  engine.checkQuota(store.getServer(server.id), { monthlyRx: 999 * GB, monthlyTx: 0 }, 4000);
  assert.equal(store.listEvents({ serverId: server.id }).filter((e) => e.type === 'traffic' && e.resolvedAt === null).length, 0);
  store.close();
});
