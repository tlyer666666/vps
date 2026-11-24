import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { createProbeRunner, DEFAULT_PROBES, seedDefaultProbes } from '../server/probes.js';
import { openStore } from '../server/store.js';

function httpStub(t, handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    t.after(() => {
      server.closeAllConnections?.();
      server.close();
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function tcpStub(t, onConn = () => {}) {
  return new Promise((resolve) => {
    const server = net.createServer(onConn);
    t.after(() => server.close());
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function setup(t, { allowPrivateTargets = true, fetchImpl } = {}) {
  const store = openStore(':memory:');
  const notified = [];
  const runner = createProbeRunner(store, {
    allowPrivateTargets,
    ...(fetchImpl ? { fetchImpl } : {}),
    onNotify: (event, probe) => notified.push({ type: event.type, probe: probe.id, msg: event.message }),
  });
  t.after(() => {
    runner.stop();
    store.close();
  });
  return { store, runner, notified };
}

test('http probe records success with latency and no event', async (t) => {
  const { store, runner, notified } = setup(t);
  const server = await httpStub(t, (req, res) => { res.writeHead(200); res.end('ok'); });
  const url = `http://127.0.0.1:${server.address().port}/health`;
  const probe = store.createProbe({ name: 'gw', type: 'http', target: url, intervalSec: 1 });
  await runner.runDue(Date.now());
  const latest = store.latestProbeResults().get(probe.id);
  assert.equal(latest.ok, 1);
  assert.ok(latest.latencyMs >= 0);
  assert.equal(notified.length, 0);
});

test('http probe records non-2xx failure and 3 consecutive failures open + notify', async (t) => {
  const { store, runner, notified } = setup(t);
  const server = await httpStub(t, (req, res) => { res.writeHead(500); res.end(); });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const probe = store.createProbe({ name: 'bad', type: 'http', target: url, intervalSec: 1 });

  const T = Date.now();
  await runner.runDue(T);
  await runner.runDue(T + 1100);
  assert.equal(store.listEvents({ limit: 10 }).length, 0, 'streak of 2 must not open');
  await runner.runDue(T + 2200);
  const events = store.listEvents({ limit: 10 });
  assert.equal(events.filter((e) => e.type === 'probe' && e.resolvedAt === null).length, 1);
  assert.equal(notified.length, 1);
  assert.match(notified[0].msg, /bad/);

  // duplicate runs while open: no re-notify (existed semantics)
  await runner.runDue(T + 3300);
  assert.equal(notified.length, 1);
});

test('recovery resolves the probe event; next failure opens a fresh one', async (t) => {
  const { store, runner, notified } = setup(t);
  let status = 500;
  const server = await httpStub(t, (req, res) => { res.writeHead(status); res.end(); });
  const probe = store.createProbe({ name: 'flap', type: 'http', target: `http://127.0.0.1:${server.address().port}/`, intervalSec: 1 });
  const T = Date.now();
  for (let i = 0; i < 3; i++) await runner.runDue(T + i * 1100);
  assert.equal(store.listEvents({ limit: 10 }).filter((e) => e.resolvedAt === null).length, 1);

  status = 200;
  await runner.runDue(T + 3300);
  assert.equal(store.listEvents({ limit: 10 }).filter((e) => e.resolvedAt === null).length, 0, 'recovery resolves');

  status = 500;
  // 11 minutes later the 10-minute notify cooldown has expired → notify #2
  for (let i = 0; i < 3; i++) await runner.runDue(T + 660_000 + i * 1100);
  assert.equal(notified.length, 2, 'fresh failure notifies again');
  assert.equal(store.listEvents({ limit: 10 }).filter((e) => e.resolvedAt === null).length, 1);
});

test('http probe timeout is recorded as failure', async (t) => {
  const { store, runner } = setup(t);
  const server = await httpStub(t, () => { /* never respond */ });
  const probe = store.createProbe({
    name: 'slow', type: 'http', target: `http://127.0.0.1:${server.address().port}/`,
    intervalSec: 1, timeoutSec: 1,
  });
  await runner.runDue(Date.now());
  const latest = store.latestProbeResults().get(probe.id);
  assert.equal(latest.ok, 0);
  assert.match(latest.error, /timeout/i);
});

test('tcp probe succeeds against a listening port, fails on refusal', async (t) => {
  const { store, runner } = setup(t);
  const server = await tcpStub(t);
  const port = server.address().port;
  const okProbe = store.createProbe({ name: 'ssh', type: 'tcp', target: `127.0.0.1:${port}` });
  const badProbe = store.createProbe({ name: 'dead', type: 'tcp', target: '127.0.0.1:1' });
  await runner.runDue(Date.now());
  assert.equal(store.latestProbeResults().get(okProbe.id).ok, 1);
  assert.equal(store.latestProbeResults().get(badProbe.id).ok, 0);
  assert.ok(store.latestProbeResults().get(badProbe.id).error.length > 0);
});

test('disabled probes and interval scheduling are respected', async (t) => {
  const { store, runner } = setup(t);
  const server = await httpStub(t, (req, res) => { res.writeHead(200); res.end(); });
  const off = store.createProbe({ name: 'off', type: 'http', target: `http://127.0.0.1:${server.address().port}/`, enabled: 0 });
  const slow = store.createProbe({ name: 'slow', type: 'http', target: `http://127.0.0.1:${server.address().port}/`, intervalSec: 3600 });
  await runner.runDue(Date.now());
  assert.equal(store.latestProbeResults().has(off.id), false, 'disabled probe never runs');
  assert.equal(store.latestProbeResults().has(slow.id), true, 'due probe runs');
  await runner.runDue(Date.now() + 1000); // only 1s later, interval is 1h
  const count = store.db.prepare('SELECT COUNT(*) c FROM probe_results WHERE probe_id=?').get(slow.id).c;
  assert.equal(count, 1, 'not due again');
});

test('forget clears per-probe memory', async (t) => {
  const { store, runner } = setup(t);
  const server = await httpStub(t, (req, res) => { res.writeHead(500); res.end(); });
  const probe = store.createProbe({ name: 'x', type: 'http', target: `http://127.0.0.1:${server.address().port}/` });
  await runner.runDue(Date.now());
  runner.forget(probe.id);
  assert.equal(runner.stateOf(probe.id), undefined);
});

test('http and tcp probes block loopback, IMDS, and RFC1918 targets by default (SSRF guard)', async (t) => {
  let fetchCalled = false;
  let tcpConnected = false;
  const httpServer = await httpStub(t, (req, res) => { res.writeHead(200); res.end('ok'); });
  const tcpServer = await tcpStub(t, () => { tcpConnected = true; });

  const { store, runner } = setup(t, {
    allowPrivateTargets: false,
    fetchImpl: async () => { fetchCalled = true; return { status: 200 }; },
  });

  const probes = [
    store.createProbe({ name: 'http-loopback', type: 'http', target: `http://127.0.0.1:${httpServer.address().port}/` }),
    store.createProbe({ name: 'http-imds', type: 'http', target: 'http://169.254.169.254/latest/meta-data/' }),
    store.createProbe({ name: 'http-rfc1918', type: 'http', target: 'http://10.0.0.1/status' }),
    store.createProbe({ name: 'tcp-loopback', type: 'tcp', target: `127.0.0.1:${tcpServer.address().port}` }),
    store.createProbe({ name: 'tcp-imds', type: 'tcp', target: '169.254.169.254:80' }),
    store.createProbe({ name: 'tcp-rfc1918', type: 'tcp', target: '10.0.0.1:22' }),
  ];

  await runner.runDue(Date.now());
  const latest = store.latestProbeResults();
  for (const p of probes) {
    const r = latest.get(p.id);
    assert.ok(r, `result recorded for ${p.name}`);
    assert.equal(r.ok, 0, `${p.name} must be blocked`);
    assert.match(r.error, /blocked/i, `${p.name} error must explain SSRF block`);
  }
  assert.equal(fetchCalled, false, 'blocked HTTP probes must never invoke fetch');
  assert.equal(tcpConnected, false, 'blocked TCP probes must never open a socket');
});

test('seedDefaultProbes seeds once on an empty probes table (v1.2)', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  assert.equal(DEFAULT_PROBES.length >= 3, true, 'built-in preset list');
  assert.equal(seedDefaultProbes(store), DEFAULT_PROBES.length);
  assert.equal(store.listProbes().length, DEFAULT_PROBES.length);
  // second boot (flag set): no duplicates, even after user deletes all probes
  assert.equal(seedDefaultProbes(store), 0);
  for (const p of store.listProbes()) store.deleteProbe(p.id);
  assert.equal(seedDefaultProbes(store), 0, 'deleted defaults must not resurrect');
});

test('seedDefaultProbes skips targets that already exist', (t) => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const first = DEFAULT_PROBES[0];
  store.createProbe({ name: 'mine', type: first.type, target: first.target });
  const added = seedDefaultProbes(store);
  assert.equal(added, DEFAULT_PROBES.length - 1, 'existing target not duplicated');
  assert.equal(store.listProbes().filter((p) => p.target === first.target).length, 1);
});
