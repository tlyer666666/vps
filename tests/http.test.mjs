import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createApp } from '../server/http.js';
import { openStore } from '../server/store.js';
import { AlertEngine } from '../server/alerts.js';
import { createProbeRunner } from '../server/probes.js';
import { hashPassword } from '../server/auth.js';

const PORT = 0;
const PASSWORD = 'test-passwd';
const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

async function startApp(t, {
  password = PASSWORD,
  trustProxy = false,
  allowPrivateTargets = false,
  sendTelegramImpl = undefined,
  lookupImpl = PUBLIC_LOOKUP,
} = {}) {
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
  const probeRunner = createProbeRunner(store, {
    allowPrivateTargets,
    onNotify: (event, probe) => notified.push(event),
  });
  const app = createApp({
    config: { trustProxy, intervalSec: 10, retentionDays: 30, rate: { agentPerSec: 30, loginPer15Min: 5 } },
    store,
    engine,
    probeRunner,
    ...(sendTelegramImpl ? { sendTelegramImpl } : {}),
    lookupImpl,
    allowPrivateTargets,
    log: { info: () => {}, warn: () => {}, error: () => {} },
  });
  const server = app.listen(PORT, '127.0.0.1');
  await new Promise((res) => server.once('listening', res));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    probeRunner.stop();
    app.close();
    store.close();
  };
  if (t?.after) t.after(close);
  const call = async (path, opts = {}) => {
    const res = await fetch(base + path, {
      ...opts,
      headers: { ...(opts.headers ?? {}), ...(cookie ? { cookie } : {}) },
    });
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    return res;
  };
  return { store, engine, notified, app, server, base, call, close };
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

test('unauthenticated /api returns 401 JSON', async (t) => {
  const h = await startApp(t);
  for (const path of ['/api/overview', '/api/events', '/api/admin/settings']) {
    const res = await h.call(path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  }
});

test('login sets session cookie; wrong password hits 429 on 6th try', async (t) => {
  const h = await startApp(t);
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
});

test('login flow grants access to overview', async (t) => {
  const h = await startApp(t);
  await login(h);
  const res = await h.call('/api/overview');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), []);
});

test('full report pipeline: admin creates server, agent reports, overview shows online', async (t) => {
  const h = await startApp(t);
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
    await new Promise((r) => setTimeout(r, 25)); // distinct server-side ts so dtSec > 0
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
});

test('bad token is 401; reset-token revokes the old one immediately', async (t) => {
  const h = await startApp(t);
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
});

test('invalid report payloads are 400 and stored nothing', async (t) => {
  const h = await startApp(t);
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
});

test('oversized body is 413', async (t) => {
  const h = await startApp(t);
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
});

test('history endpoint returns points from metrics', async (t) => {
  const h = await startApp(t);
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
});

test('SSE stream sends an initial overview frame', async (t) => {
  const h = await startApp(t);
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
});

test('static root serves the dashboard html; unknown api is 404 JSON', async (t) => {
  const h = await startApp(t);
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
});

test('store write failure keeps report 200 and overview alive', async (t) => {
  const h = await startApp(t);
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
});

test('admin settings GET/PUT round-trips and updates engine thresholds', async (t) => {
  const h = await startApp(t);
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
});

test('logout invalidates the session cookie', async (t) => {
  const h = await startApp(t);
  await login(h);
  assert.equal((await h.call('/api/overview')).status, 200);
  await h.call('/api/logout', { method: 'POST' });
  assert.equal((await h.call('/api/overview')).status, 401);
});

test('admin can update and delete a server', async (t) => {
  const h = await startApp(t);
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
});

test('admin password change rotates the credential', async (t) => {
  const h = await startApp(t);
  await login(h);
  const res = await h.call('/api/admin/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: PASSWORD, password: 'brand-new-pw' }),
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
});

test('password change rejects missing or wrong currentPassword', async (t) => {
  const h = await startApp(t);
  await login(h);
  const missing = await h.call('/api/admin/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'brand-new-pw' }),
  });
  assert.equal(missing.status, 403, 'missing currentPassword must be rejected');

  const wrong = await h.call('/api/admin/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: 'wrong-password', password: 'brand-new-pw' }),
  });
  assert.equal(wrong.status, 403, 'wrong currentPassword must be rejected');

  // original session and original password must still be intact
  assert.equal((await h.call('/api/overview')).status, 200);
  const reLogin = await fetch(`${h.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(reLogin.status, 200);
});

test('password change rejects short or missing passwords', async (t) => {
  const h = await startApp(t);
  await login(h);
  const short = await h.call('/api/admin/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: PASSWORD, password: 'short' }),
  });
  assert.equal(short.status, 400);
  const empty = await h.call('/api/admin/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: PASSWORD }),
  });
  assert.equal(empty.status, 400);
});

test('password change invalidates all existing sessions', async (t) => {
  const h = await startApp(t);
  await login(h);
  // a second session (another browser) is also logged in
  const cookie2 = await fetch(`${h.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  }).then((r) => r.headers.get('set-cookie').split(';')[0]);

  const change = await h.call('/api/admin/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ currentPassword: PASSWORD, password: 'brand-new-pw' }),
  });
  assert.equal(change.status, 200);

  const stolen = await fetch(`${h.base}/api/overview`, { headers: { cookie: cookie2 } });
  assert.equal(stolen.status, 401, 'rotating the password must kill every session');
  const own = await h.call('/api/overview');
  assert.equal(own.status, 401, 'current session is invalidated too');
});

test('cross-site mutations are rejected by Origin check', async (t) => {
  const h = await startApp(t);
  await login(h);

  // stolen-but-valid session cookie + cross-site Origin → 403
  const cookie2 = await fetch(`${h.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  }).then((r) => r.headers.get('set-cookie').split(';')[0]);
  const evil = await fetch(`${h.base}/api/admin/password`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://evil.example',
      cookie: cookie2,
    },
    body: JSON.stringify({ currentPassword: PASSWORD, password: 'hijacked-pw1' }),
  });
  assert.equal(evil.status, 403, 'cross-origin mutation must be 403 even with a stolen session');

  const crossLogin = await fetch(`${h.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(crossLogin.status, 403, 'login mutation is guarded too');

  // same-origin (or no Origin, like curl/agents) keeps working
  const same = await h.call('/api/overview');
  assert.equal(same.status, 200, 'same-origin requests are unaffected');
  const noOrigin = await report(h, 'x', reportBody());
  assert.equal(noOrigin.status, 401, 'agent report has no Origin; auth still applies normally');
});

test('trust-proxy takes client IP from X-Forwarded-For', async (t) => {
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
  t.after(() => {
    app.close();
    store.close();
  });
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
});

test('without trust-proxy the XFF header is ignored (spoof-safe default)', async (t) => {
  const h = await startApp(t);
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
});

test('session cookie gains Secure flag when HTTPS is detected via trustProxy, and ignores spoofed header otherwise', async (t) => {
  const trusted = await startApp(t, { trustProxy: true });
  const resTrusted = await fetch(`${trusted.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(resTrusted.status, 200);
  const setCookieTrusted = resTrusted.headers.get('set-cookie');
  assert.match(setCookieTrusted, /Secure/i, 'login over trusted proxy HTTPS must set Secure');

  const untrusted = await startApp(t, { trustProxy: false });
  const resUntrusted = await fetch(`${untrusted.base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(resUntrusted.status, 200);
  const setCookieUntrusted = resUntrusted.headers.get('set-cookie');
  assert.doesNotMatch(setCookieUntrusted, /;\s*Secure\b/i, 'x-forwarded-proto must be ignored when trustProxy is false');
});

// ---- settings/server input validation ----

test('PUT settings rejects type-broken payloads instead of silently killing alerts', async (t) => {
  const h = await startApp(t);
  await login(h);
  const bad = [
    { thresholds: 'banana' },
    { thresholds: { cpu: 0 } },                    // empty form field -> Number('') = 0
    { thresholds: { cpu: 101 } },
    { thresholds: { consecutive: 0 } },
    { thresholds: { expiryDays: -1 } },
    { retentionDays: 0 },                          // prune cutoff = now -> wipes all history
    { retentionDays: 'banana' },
    { notifyCooldownMin: 'abc' },
    { notifyCooldownMin: 0 },
    { webhookUrl: 'ftp://x' },
    { webhookUrl: 123 },
  ];
  for (const body of bad) {
    const res = await h.call('/api/admin/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  // engine thresholds untouched by rejected payloads
  assert.equal(h.engine.thresholds.cpu, 90);
});

test('PUT settings accepts boundary-valid values', async (t) => {
  const h = await startApp(t);
  await login(h);
  const res = await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      thresholds: { cpu: 1, mem: 100, disk: 99, consecutive: 1, expiryDays: 0 },
      notifyCooldownMin: 1,
      retentionDays: 1,
      webhookUrl: 'https://hooks.example.com/abc',
    }),
  });
  assert.equal(res.status, 200);
  const after = await (await h.call('/api/admin/settings')).json();
  assert.equal(after.thresholds.cpu, 1);
  assert.equal(after.thresholds.expiryDays, 0);
  assert.equal(after.retentionDays, 1);
});

test('GET /api/admin/settings masks telegram_bot_token and preserves it on masked echo', async (t) => {
  const h = await startApp(t);
  await login(h);
  const realToken = '123456:abcdefghijklmnopqrstuvwxyz012345';
  const put = await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ telegram_bot_token: realToken, telegram_chat_id: '987654' }),
  });
  assert.equal(put.status, 200);
  const putJson = await put.json();
  assert.equal(putJson.has_telegram_bot_token, true);
  assert.notEqual(putJson.telegram_bot_token, realToken, 'PUT response must mask token');
  assert.ok(!JSON.stringify(putJson).includes(realToken), 'raw token must never appear in PUT response');

  const getRes = await h.call('/api/admin/settings');
  assert.equal(getRes.status, 200);
  const view = await getRes.json();
  assert.equal(view.has_telegram_bot_token, true);
  assert.equal(view.telegram_bot_token, '••••••••');
  assert.equal(view.telegram_chat_id, '987654');
  assert.ok(!JSON.stringify(view).includes(realToken), 'raw token must never appear in GET response');

  // Echoing the masked placeholder back on unrelated updates preserves the real secret
  const keepRes = await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ telegram_bot_token: view.telegram_bot_token, retentionDays: 14 }),
  });
  assert.equal(keepRes.status, 200);
  assert.equal(h.store.getSetting('settings').telegram_bot_token, realToken);

  // Explicit empty string clears the token
  const clearRes = await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ telegram_bot_token: '' }),
  });
  assert.equal(clearRes.status, 200);
  const cleared = await (await h.call('/api/admin/settings')).json();
  assert.equal(cleared.has_telegram_bot_token, false);
  assert.equal(cleared.telegram_bot_token, '');
});

test('settings and probe APIs block loopback, IMDS, and RFC1918 targets by default', async (t) => {
  const h = await startApp(t);
  await login(h);
  for (const webhookUrl of [
    'http://127.0.0.1:8080/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/hook',
  ]) {
    const res = await h.call('/api/admin/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl }),
    });
    assert.equal(res.status, 400, `webhookUrl ${webhookUrl} must be rejected`);
  }
  for (const probe of [
    { name: 'h1', type: 'http', target: 'http://127.0.0.1:8080/' },
    { name: 'h2', type: 'http', target: 'http://169.254.169.254/latest/meta-data/' },
    { name: 'h3', type: 'http', target: 'http://10.0.0.1/' },
    { name: 't1', type: 'tcp', target: '127.0.0.1:22' },
    { name: 't2', type: 'tcp', target: '169.254.169.254:80' },
    { name: 't3', type: 'tcp', target: '10.0.0.1:53' },
  ]) {
    const res = await h.call('/api/admin/probes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(probe),
    });
    assert.equal(res.status, 400, `probe target ${probe.target} must be rejected`);
  }
});

test('server create/update validate field types', async (t) => {
  const h = await startApp(t);
  await login(h);
  const badBodies = [
    { name: '' },
    { name: '   ' },
    { name: 'a'.repeat(101) },
    { name: 'ok', intervalSec: 'abc' },
    { name: 'ok', intervalSec: 0 },
    { name: 'ok', intervalSec: null },
    { name: 'ok', expiresAt: 'next tuesday' },
    { name: 'ok', priceCny: 'cheap' },
    { name: 'ok', tag: 42 },
  ];
  for (const body of badBodies) {
    const res = await h.call('/api/admin/servers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }

  const { id } = await (await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'good', intervalSec: 10 }),
  })).json();
  const badPatches = [{ intervalSec: 'abc' }, { intervalSec: null }, { expiresAt: 'x' }, { priceCny: [] }];
  for (const body of badPatches) {
    const res = await h.call(`/api/admin/servers/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `expected 400 for PATCH ${JSON.stringify(body)}`);
  }
});

test('GET /api/admin/servers and /:id', async (t) => {
  const h = await startApp(t);
  await login(h);
  const { id, token } = await (await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'listed' }),
  })).json();
  const list = await (await h.call('/api/admin/servers')).json();
  assert.equal(list.length, 1);
  assert.ok(!JSON.stringify(list).includes(token), 'token must never appear in listings');
  const one = await (await h.call(`/api/admin/servers/${id}`)).json();
  assert.equal(one.name, 'listed');
  assert.equal((await h.call('/api/admin/servers/9999')).status, 404);
});

test('events limit clamps negatives and large values', async (t) => {
  const h = await startApp(t);
  await login(h);
  for (const type of ['cpu', 'mem', 'disk']) {
    h.store.openEvent({ serverId: 1, type, level: 'critical', message: `e-${type}` }, 1000);
  }
  const big = await (await h.call('/api/events?limit=999999')).json();
  assert.equal(big.length, 3, 'limit clamps to 1000, still returns all 3');
  const neg = await (await h.call('/api/events?limit=-1')).json();
  assert.equal(neg.length, 3, 'negative limit must not become unlimited/0/error');
  const two = await (await h.call('/api/events?limit=2')).json();
  assert.equal(two.length, 2);
});

// ---- probes, public status page, notify test ----

function startAppWithRunner(t, opts = {}) {
  return startApp(t, opts);
}

test('probe CRUD with validation and embedded latest results', async (t) => {
  const h = await startAppWithRunner(t);
  await login(h);
  const bad = [
    { name: '', type: 'http', target: 'https://a.b/' },
    { name: 'x', type: 'ftp', target: 'https://a.b/' },
    { name: 'x', type: 'http', target: 'ftp://a.b/' },
    { name: 'x', type: 'tcp', target: 'no-port' },
    { name: 'x', type: 'tcp', target: 'host:99999' },
    { name: 'x', type: 'http', target: 'https://a.b/', intervalSec: 5 },
    { name: 'x', type: 'http', target: 'https://a.b/', timeoutSec: 60 },
  ];
  for (const body of bad) {
    const res = await h.call('/api/admin/probes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
  }

  const create = await h.call('/api/admin/probes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'gateway', type: 'http', target: 'https://gw.example/health', intervalSec: 30 }),
  });
  assert.equal(create.status, 200);
  const probe = await create.json();

  const list = await (await h.call('/api/admin/probes')).json();
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'gateway');
  assert.equal(list[0].latest, null, 'no result yet');

  h.store.insertProbeResult(probe.id, { ts: Date.now(), ok: 0, latencyMs: 5, error: 'HTTP 503' });
  const list2 = await (await h.call('/api/admin/probes')).json();
  assert.equal(list2[0].latest.ok, 0);
  assert.equal(list2[0].latest.error, 'HTTP 503');

  const patch = await h.call(`/api/admin/probes/${probe.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(patch.status, 200);
  assert.equal((await (await h.call('/api/admin/probes')).json())[0].enabled, 0);

  assert.equal((await h.call(`/api/admin/probes/${probe.id}`, { method: 'DELETE' })).status, 200);
  assert.deepEqual(await (await h.call('/api/admin/probes')).json(), []);
});

test('probe history endpoint returns points', async (t) => {
  const h = await startAppWithRunner(t);
  await login(h);
  const probe = h.store.createProbe({ name: 'p', type: 'tcp', target: '127.0.0.1:22' });
  for (let i = 0; i < 5; i++) {
    h.store.insertProbeResult(probe.id, { ts: Date.now() - (5 - i) * 1000, ok: 1, latencyMs: 10 + i });
  }
  const hist = await (await h.call(`/api/probes/${probe.id}/history?range=1h`)).json();
  assert.equal(hist.points.length, 5);
  assert.equal(hist.points[4].latencyMs, 14);
});

test('public overview is gated and sanitized (v1.1 status page)', async (t) => {
  const h = await startAppWithRunner(t);
  await login(h);
  const { id } = await (await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'pub-1', tag: 'hk', provider: 'SecretProvider', notes: 'secret notes', groupName: 'prod' }),
  })).json();
  h.store.insertMetric(id, { ts: Date.now(), cpuPct: 10 });
  const probe = h.store.createProbe({ name: 'gw', type: 'http', target: 'https://a.b/' });

  // disabled by default → 404
  assert.equal((await h.call('/api/public/overview')).status, 404);

  await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_status: true }),
  });

  // public route must work WITHOUT cookies
  const anon = await fetch(`${h.base}/api/public/overview`);
  assert.equal(anon.status, 200);
  const pub = await anon.json();
  assert.equal(pub.servers.length, 1);
  assert.equal(pub.servers[0].name, 'pub-1');
  assert.equal(pub.servers[0].groupName, 'prod');
  assert.equal(typeof pub.servers[0].online, 'boolean');
  assert.ok(!('priceCny' in pub.servers[0]) && !('notes' in pub.servers[0]), 'private fields must not leak');
  assert.equal(pub.probes.length, 1);
  assert.equal(pub.probes[0].name, 'gw');

  // authed probe uptime data present
  assert.equal(typeof pub.servers[0].uptimePct24h, 'number');
  assert.equal(pub.probes[0].id, probe.id);
});

test('notify-test reports per-channel delivery results', async (t) => {
  let telegramResult = false;
  const h = await startAppWithRunner(t, {
    allowPrivateTargets: true,
    sendTelegramImpl: async () => telegramResult,
  });
  await login(h);
  const put1 = await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      webhookUrl: 'http://127.0.0.1:9/hook', /* refused */
      telegram_bot_token: '123456:abcdefghijklmnopqrstuvwxyz012345',
      telegram_chat_id: '42',
    }),
  });
  assert.equal(put1.status, 200);
  const res = await h.call('/api/admin/notify-test', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body, { webhook: false, telegram: false }, 'both channels attempted; refused/unreachable = false');

  // working local webhook + succeeding telegram → { webhook: true, telegram: true }
  const hookServer = createServer((req, res2) => { res2.writeHead(200); res2.end('ok'); });
  t.after(() => {
    hookServer.closeAllConnections?.();
    hookServer.close();
  });
  await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));
  telegramResult = true;
  const putOk = await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webhookUrl: `http://127.0.0.1:${hookServer.address().port}/hook` }),
  });
  assert.equal(putOk.status, 200);
  const resOk = await h.call('/api/admin/notify-test', { method: 'POST' });
  assert.deepEqual(await resOk.json(), { webhook: true, telegram: true });

  // empty config: channels report null (not configured)
  const put2 = await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ webhookUrl: '', telegram_bot_token: '', telegram_chat_id: '' }),
  });
  assert.equal(put2.status, 200);
  const res2 = await h.call('/api/admin/notify-test', { method: 'POST' });
  assert.deepEqual(await res2.json(), { webhook: null, telegram: null });
});

test('public overview is cached and rate limited', async (t) => {
  const h = await startAppWithRunner(t);
  await login(h);
  await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'pub' }),
  });
  await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_status: true }),
  });

  // hammering the anonymous endpoint hits the per-IP rate limit
  const codes = [];
  for (let i = 0; i < 30; i++) {
    codes.push((await fetch(`${h.base}/api/public/overview`)).status);
  }
  assert.ok(codes.filter((c) => c === 200).length >= 5, 'legitimate requests succeed');
  assert.ok(codes.includes(429), 'a burst must hit the 5 req/s public limit');

  // settings change invalidates the cached payload immediately
  await h.call('/api/admin/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ public_status: false }),
  });
  assert.equal((await fetch(`${h.base}/api/public/overview`)).status, 404, 'disabled beats the cache');
});

test('server group and quota fields validate and persist', async (t) => {
  const h = await startAppWithRunner(t);
  await login(h);
  assert.equal((await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'g', groupName: 'x'.repeat(65) }),
  })).status, 400);
  assert.equal((await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'g', monthlyQuotaBytes: -1 }),
  })).status, 400);

  const create = await h.call('/api/admin/servers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'g', groupName: '生产', monthlyQuotaBytes: 1024 ** 3 }),
  });
  assert.equal(create.status, 200);
  const { id } = await create.json();
  const overview = await (await h.call('/api/overview')).json();
  assert.equal(overview[0].groupName, '生产');
  assert.equal(overview[0].monthlyQuotaBytes, 1024 ** 3);
  assert.equal((await h.call(`/api/admin/servers/${id}`)).status, 200);
});
