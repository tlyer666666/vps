import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import net from 'node:net';
import { createProbeRunner } from '../server/probes.js';
import { openStore } from '../server/store.js';

function httpStub(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function tcpStub() {
  return new Promise((resolve) => {
    const server = net.createServer(() => {});
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function setup() {
  const store = openStore(':memory:');
  const notified = [];
  const runner = createProbeRunner(store, {
    onNotify: (event, probe) => notified.push({ type: event.type, probe: probe.id, msg: event.message }),
  });
  return { store, runner, notified };
}

test('http probe records success with latency and no event', async () => {
  const { store, runner, notified } = setup();
  const server = await httpStub((req, res) => { res.writeHead(200); res.end('ok'); });
  const url = `http://127.0.0.1:${server.address().port}/health`;
  const probe = store.createProbe({ name: 'gw', type: 'http', target: url, intervalSec: 1 });
  await runner.runDue(Date.now());
  const latest = store.latestProbeResults().get(probe.id);
  assert.equal(latest.ok, 1);
  assert.ok(latest.latencyMs >= 0);
  assert.equal(notified.length, 0);
  runner.stop(); server.close(); store.close();
});

test('http probe records non-2xx failure and 3 consecutive failures open + notify', async () => {
  const { store, runner, notified } = setup();
  const server = await httpStub((req, res) => { res.writeHead(500); res.end(); });
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
  runner.stop(); server.close(); store.close();
});

test('recovery resolves the probe event; next failure opens a fresh one', async () => {
  const { store, runner, notified } = setup();
  let status = 500;
  const server = await httpStub((req, res) => { res.writeHead(status); res.end(); });
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
  runner.stop(); server.close(); store.close();
});

test('http probe timeout is recorded as failure', async () => {
  const { store, runner } = setup();
  const server = await httpStub(() => { /* never respond */ });
  const probe = store.createProbe({
    name: 'slow', type: 'http', target: `http://127.0.0.1:${server.address().port}/`,
    intervalSec: 1, timeoutSec: 1,
  });
  await runner.runDue(Date.now());
  const latest = store.latestProbeResults().get(probe.id);
  assert.equal(latest.ok, 0);
  assert.match(latest.error, /timeout/i);
  runner.stop(); server.close(); store.close();
});

test('tcp probe succeeds against a listening port, fails on refusal', async () => {
  const { store, runner } = setup();
  const server = await tcpStub();
  const port = server.address().port;
  const okProbe = store.createProbe({ name: 'ssh', type: 'tcp', target: `127.0.0.1:${port}` });
  const badProbe = store.createProbe({ name: 'dead', type: 'tcp', target: '127.0.0.1:1' });
  await runner.runDue(Date.now());
  assert.equal(store.latestProbeResults().get(okProbe.id).ok, 1);
  assert.equal(store.latestProbeResults().get(badProbe.id).ok, 0);
  assert.ok(store.latestProbeResults().get(badProbe.id).error.length > 0);
  runner.stop(); server.close(); store.close();
});

test('disabled probes and interval scheduling are respected', async () => {
  const { store, runner } = setup();
  const server = await httpStub((req, res) => { res.writeHead(200); res.end(); });
  const off = store.createProbe({ name: 'off', type: 'http', target: `http://127.0.0.1:${server.address().port}/`, enabled: 0 });
  const slow = store.createProbe({ name: 'slow', type: 'http', target: `http://127.0.0.1:${server.address().port}/`, intervalSec: 3600 });
  await runner.runDue(Date.now());
  assert.equal(store.latestProbeResults().has(off.id), false, 'disabled probe never runs');
  assert.equal(store.latestProbeResults().has(slow.id), true, 'due probe runs');
  await runner.runDue(Date.now() + 1000); // only 1s later, interval is 1h
  const count = store.db.prepare('SELECT COUNT(*) c FROM probe_results WHERE probe_id=?').get(slow.id).c;
  assert.equal(count, 1, 'not due again');
  runner.stop(); server.close(); store.close();
});

test('forget clears per-probe memory', async () => {
  const { store, runner } = setup();
  const server = await httpStub((req, res) => { res.writeHead(500); res.end(); });
  const probe = store.createProbe({ name: 'x', type: 'http', target: `http://127.0.0.1:${server.address().port}/` });
  await runner.runDue(Date.now());
  runner.forget(probe.id);
  assert.equal(runner.stateOf(probe.id), undefined);
  runner.stop(); server.close(); store.close();
});
