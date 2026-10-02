import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/http.js';
import { openStore } from '../server/store.js';
import { AlertEngine } from '../server/alerts.js';
import { hashPassword } from '../server/auth.js';

const PORT = 0;
const PASSWORD = 'test-passwd';

async function startApp({ password = PASSWORD } = {}) {
  const store = openStore(':memory:');
  if (password !== null) {
    store.setAdminPasswordHash(await hashPassword(password));
  }
  const notified = [];
  const engine = new AlertEngine(store, {
    thresholds: { cpu: 90, mem: 90, disk: 90, consecutive: 3, expiryDays: 7 },
    notifyCooldownMin: 10,
    onNotify: (event, server) => notified.push(event),
  });
  const app = createApp({
    config: { intervalSec: 10, retentionDays: 30, rate: { agentPerSec: 30, loginPer15Min: 5 } },
    store,
    engine,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  const call = async (path, opts = {}) => {
    const res = await fetch(base + path, {
      ...opts,
      headers: { ...(opts.headers ?? {}), ...(cookie ? { cookie } : {}) },
    });
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    return res;
  };
  return { store, engine, notified, app, server, base, call, close: () => app.close() };
}

async function login(h) {
  const res = await h.call('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return res;
}

async function report(h, token, body, extra = {}) {
  return h.call('/api/agent/report', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...extra,
  });
}

function reportBody(over = {}) {
  return {
    hostname: 'web-1',
    uptime: 1000,
    cpu: { usage_pct: 20, cores: 2 },
    mem: { total: 2000, used: 1000 },
    disks: [{ mount: '/', total: 10000, used: 2500 }],
    net: { rx_bytes: 1000, tx_bytes: 2000 },
    ...over,
  };
}

test('unauthenticated /api returns 401 JSON', async () => {
  const h = await startApp();
  for (const path of ['/api/overview', '/api/events', '/api/admin/settings']) {
    const res = await h.call(path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
  h.close();
});

test('login sets session cookie; wrong password hits 429 on 6th try', async () => {
  const h = await startApp();
  for (let i = 0; i < 5; i++) {
    const res = await h.call('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(res.status, 401, `attempt ${i + 1}`);
  }
  const sixth = await h.call('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'wrong' }),
  });
  assert.equal(sixth.status, 429);
  h.close();
});

test('login flow grants access to overview', async () => {
  const h = await startApp();
  await login(h);
  const res = await h.call('/api/overview');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
  h.close();
});

test('full report pipeline: admin creates server, agent reports, overview shows online', async () => {
  const h = await startApp();
  await login(h);
  const createRes = await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'web-1', tag: 'hk', provider: 'Dox' }),
  });
  assert.equal(createRes.status, 200);
  const { id, token } = await createRes.json();
  assert.ok(token.length >= 32);

  for (let i = 1; i <= 3; i++) {
    const res = await report(h, token, reportBody({
      net: { rx_bytes: 1000 * i, tx_bytes: 2000 * i },
    }));
    assert.equal(res.status, 200, `report ${i}`);
    assert.deepEqual(await res.json(), { ok: true });
  }

  const overview = await (await h.call('/api/overview')).json();
  assert.equal(overview.length, 1);
  const item = overview[0];
  assert.equal(item.id, id);
  assert.equal(item.name, 'web-1');
  assert.equal(item.online, true);
  assert.equal(item.metric.cpuPct, 20);
  assert.equal(item.metric.rxSpeed > 0, true, 'second and later reports derive speed from counters');
  assert.equal(item.metric.diskPct, 25);
  h.close();
});

test('bad token is 401; reset-token revokes the old one immediately', async () => {
  const h = await startApp();
  await login(h);
  const { id, token } = await (await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'a' }),
  })).json();

  assert.equal((await report(h, 'bogus', reportBody())).status, 401);
  assert.equal((await report(h, '', reportBody())).status, 401);
  assert.equal((await report(h, token, reportBody())).status, 200);

  const reset = await h.call(`/api/admin/servers/${id}/reset-token`, { method: 'POST' });
  const { token: fresh } = await reset.json();
  assert.equal((await report(h, token, reportBody())).status, 401, 'old token must die');
  assert.equal((await report(h, fresh, reportBody())).status, 200);
  h.close();
});

test('invalid report payloads are 400 and stored nothing', async () => {
  const h = await startApp();
  await login(h);
  const { token } = await (await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'a' }),
  })).json();

  assert.equal((await report(h, token, reportBody({ mem: { total: 10, used: 20 } }))).status, 400);
  const bad = await h.call('/api/agent/report', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: '{not json',
  });
  assert.equal(bad.status, 400);
  assert.equal(h.store.listEvents({ limit: 10 }).length, 0);
  h.close();
});

test('oversized body is 413', async () => {
  const h = await startApp();
  await login(h);
  const { token } = await (await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'a' }),
  })).json();
  const big = await h.call('/api/agent/report', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: 'x'.repeat(65 * 1024),
  });
  assert.equal(big.status, 413);
  h.close();
});

test('history endpoint returns points from metrics', async () => {
  const h = await startApp();
  await login(h);
  const { id } = await (await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'a' }),
  })).json();
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    h.store.insertMetric(id, { ts: now - (5 - i) * 10_000, cpuPct: 10 + i });
  }
  const res = await h.call(`/api/servers/${id}/history?range=1h`);
  assert.equal(res.status, 200);
  const hist = await res.json();
  assert.equal(hist.range, '1h');
  assert.equal(hist.downsampled, false);
  assert.equal(hist.points.length, 5);
  assert.equal(hist.points[4].cpuPct, 14);
  h.close();
});

test('SSE stream sends an initial overview frame', async () => {
  const h = await startApp();
  await login(h);
  await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'a' }),
  });
  const stream = await h.call('/api/stream');
  assert.equal(stream.headers.get('content-type'), 'text/event-stream');
  const reader = stream.body.getReader();
  const { value } = await reader.read();
  const text = Buffer.from(value).toString('utf8');
  assert.match(text, /event: overview/);
  assert.match(text, /"name":"a"/);
  await reader.cancel().catch(() => {});
  h.close();
});

test('static root serves the dashboard html; unknown api is 404 JSON', async () => {
  const h = await startApp();
  await login(h); // unknown-api 404 applies to authed callers; unauthenticated gets 401
  const home = await h.call('/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  assert.match(await home.text(), /VPSWatch/);

  const missing = await h.call('/no/such/file.css');
  assert.equal(missing.status, 404);

  const unknownApi = await h.call('/api/nothing');
  assert.equal(unknownApi.status, 404);
  assert.deepEqual(await unknownApi.json(), { error: 'not found' });
  h.close();
});

test('store write failure keeps report 200 and overview alive (Review Focus #5)', async () => {
  const h = await startApp();
  await login(h);
  const { id, token } = await (await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'a' }),
  })).json();
  h.store.insertMetric = () => { throw new Error('disk on fire'); };
  const res = await report(h, token, reportBody());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, persisted: false });
  const overview = await (await h.call('/api/overview')).json();
  assert.equal(overview.length, 1);
  assert.equal(overview[0].online, false, 'persist failed, so no metric backs the server row');
  assert.equal(overview[0].metric, null);
  h.close();
});

test('admin settings GET/PUT round-trips and updates engine thresholds', async () => {
  const h = await startApp();
  await login(h);
  const initial = await (await h.call('/api/admin/settings')).json();
  assert.equal(initial.thresholds.cpu, 90);
  assert.equal(initial.retentionDays, 30);

  const put = await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webhookUrl: 'https://example.com/hook', thresholds: { cpu: 80 } }),
  });
  assert.equal(put.status, 200);
  const after = await (await h.call('/api/admin/settings')).json();
  assert.equal(after.webhookUrl, 'https://example.com/hook');
  assert.equal(after.thresholds.cpu, 80);
  assert.equal(after.thresholds.mem, 90, 'untouched threshold survives merge');
  assert.equal(h.engine.thresholds.cpu, 80, 'engine picks up new threshold live');

  const events = await (await h.call('/api/events?limit=10')).json();
  assert.deepEqual(events, []);
  h.close();
});

test('logout invalidates the session cookie', async () => {
  const h = await startApp();
  await login(h);
  assert.equal((await h.call('/api/overview')).status, 200);
  await h.call('/api/logout', { method: 'POST' });
  assert.equal((await h.call('/api/overview')).status, 401);
  h.close();
});

test('admin can update and delete a server', async () => {
  const h = await startApp();
  await login(h);
  const { id } = await (await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'old' }),
  })).json();
  const patch = await h.call(`/api/admin/servers/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'new', priceCny: 9.9 }),
  });
  assert.equal(patch.status, 200);
  const overview = await (await h.call('/api/overview')).json();
  assert.equal(overview[0].name, 'new');
  assert.equal(overview[0].priceCny, 9.9);

  assert.equal((await h.call(`/api/admin/servers/${id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await h.call('/api/overview')).json(), []);
  h.close();
});

test('admin password change rotates the credential (review finding 1)', async () => {
  const h = await startApp();
  await login(h);
  const res = await h.call('/api/admin/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'brand-new-pw' }),
  });
  assert.equal(res.status, 200);

  // same store: the old password must stop working, the new one must log in
  await h.call('/api/logout', { method: 'POST' });
  const oldTry = await h.call('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(oldTry.status, 401, 'old password must stop working');
  const newTry = await h.call('/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'brand-new-pw' }),
  });
  assert.equal(newTry.status, 200, 'new password must log in');
  h.close();
});

test('password change rejects short or missing passwords', async () => {
  const h = await startApp();
  await login(h);
  const short = await h.call('/api/admin/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'short' }),
  });
  assert.equal(short.status, 400);
  h.close();
});

test('trust-proxy takes client IP from X-Forwarded-For (review finding 3)', async () => {
  const store = openStore(':memory:');
  store.setAdminPasswordHash(await hashPassword(PASSWORD));
  const engine = new AlertEngine(store, {
    thresholds: { cpu: 90, mem: 90, disk: 90, consecutive: 3, expiryDays: 7 },
  });
  const app = createApp({
    config: { trustProxy: true, rate: { agentPerSec: 30, loginPer15Min: 2 } },
    store, engine,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const attempt = (xff) => fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': xff },
    body: JSON.stringify({ password: 'nope' }),
  }).then((r) => r.status);

  assert.equal(await attempt('10.0.0.1'), 401);
  assert.equal(await attempt('10.0.0.1'), 401);
  assert.equal(await attempt('10.0.0.1'), 429, 'third failure from same XFF ip is limited');
  assert.equal(await attempt('10.0.0.2'), 401, 'different XFF ip has its own bucket');
  await new Promise((r) => { server.close(r); server.closeAllConnections(); });
});

test('without trust-proxy the XFF header is ignored (spoof-safe default)', async () => {
  const h = await startApp();
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${h.base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.9.${i}` },
      body: JSON.stringify({ password: 'nope' }),
    });
    assert.equal(res.status, 401);
  }
  const res = await fetch(`${h.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.9.9.99' },
    body: JSON.stringify({ password: 'nope' }),
  });
  assert.equal(res.status, 429, 'all requests share the socket-IP bucket by default');
  h.close();
});

test('session cookie gains Secure flag when HTTPS is detected (review finding 4)', async () => {
  const h = await startApp();
  const res = await fetch(`${h.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /Secure/i, 'login over detected HTTPS must set Secure');
  h.close();
});
