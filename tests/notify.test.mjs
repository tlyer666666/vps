import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createNotifier } from '../server/notify.js';

const EVENT = { id: 1, type: 'cpu', level: 'critical', message: 'web-1 CPU 使用率 95.2%', startedAt: 1000 };
const SERVER = { id: 7, name: 'web-1', intervalSec: 10 };

function listen(stub) {
  return new Promise((resolve) => {
    const server = createServer(stub);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('posts JSON {text, event, server} with UA and returns true', async () => {
  let seen = null;
  const server = await listen((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen = { body: JSON.parse(body), ua: req.headers['user-agent'], ct: req.headers['content-type'] };
      res.writeHead(200); res.end('ok');
    });
  });
  const notify = createNotifier({ webhookUrl: `http://127.0.0.1:${server.address().port}/hook` });
  const ok = await notify(EVENT, SERVER);
  assert.equal(ok, true);
  assert.equal(seen.ua, 'vpswatch/1.0');
  assert.match(seen.ct, /application\/json/);
  assert.equal(seen.body.text, `[VPSWatch] ${EVENT.message}`);
  assert.deepEqual(seen.body.event, EVENT);
  assert.deepEqual(seen.body.server, SERVER);
  server.close();
});

test('non-2xx response returns false', async () => {
  const server = await listen((req, res) => { res.writeHead(500); res.end('nope'); });
  const notify = createNotifier({ webhookUrl: `http://127.0.0.1:${server.address().port}/hook` });
  assert.equal(await notify(EVENT, SERVER), false);
  server.close();
});

test('hung endpoint times out (timeoutMs injected) and returns false', async () => {
  const server = await listen(() => { /* never respond */ });
  const notify = createNotifier({
    webhookUrl: `http://127.0.0.1:${server.address().port}/hook`,
    timeoutMs: 120,
  });
  const started = Date.now();
  assert.equal(await notify(EVENT, SERVER), false);
  assert.ok(Date.now() - started < 2000, 'must abort promptly, not wait 5s');
  server.close();
});

test('connection refused returns false without throwing', async () => {
  const notify = createNotifier({ webhookUrl: 'http://127.0.0.1:9/hook', timeoutMs: 300 });
  assert.equal(await notify(EVENT, SERVER), false);
});

test('empty webhookUrl short-circuits true without fetching', async () => {
  let called = false;
  const notify = createNotifier({
    webhookUrl: '',
    fetchImpl: async () => { called = true; return { ok: true }; },
  });
  assert.equal(await notify(EVENT, SERVER), true);
  assert.equal(called, false);
});

test('uses injected fetchImpl', async () => {
  let seenUrl, seenInit;
  const notify = createNotifier({
    webhookUrl: 'https://example.com/hook',
    fetchImpl: async (url, init) => { seenUrl = url; seenInit = init; return { ok: true }; },
  });
  assert.equal(await notify(EVENT, SERVER), true);
  assert.equal(seenUrl, 'https://example.com/hook');
  assert.equal(seenInit.method, 'POST');
});
