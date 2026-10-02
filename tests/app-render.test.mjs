import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, renderCards } from '../server/web/app.js';

const DAY = 86400_000;

function serverItem(over = {}) {
  return {
    id: 1,
    name: 'web-1',
    tag: 'hk',
    provider: 'DoxCloud',
    region: 'HK',
    priceCny: 9.9,
    expiresAt: null,
    notes: '',
    online: true,
    lastSeen: 1_800_000_000_000,
    metric: {
      cpuPct: 12.3, memUsed: 1024 ** 2, memTotal: 4 * 1024 ** 3, memPct: 25,
      diskUsed: 10 * 1024 ** 3, diskTotal: 40 * 1024 ** 3, diskPct: 25,
      rxSpeed: 1.5 * 1024 ** 2, txSpeed: 256 * 1024,
      dailyRx: 3 * 1024 ** 3, dailyTx: 1 * 1024 ** 3,
      load1: 0.42, uptimeSec: 3 * 86400 + 3600, tcpConns: 42, processes: 180,
    },
    ...over,
  };
}

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<script>x</script>'), '&lt;script&gt;x&lt;/script&gt;');
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
  assert.equal(escapeHtml(null), '');
});

test('renderCards shows metric bars, speeds and daily traffic', () => {
  const html = renderCards([serverItem()], Date.now());
  assert.match(html, /web-1/);
  assert.match(html, /12\.3%/);
  assert.match(html, /1\.5 MB\/s/);
  assert.match(html, /256\.0 KB\/s/);
  assert.match(html, /3\.0 GB/); // daily rx
  assert.match(html, /0\.42/);   // load1
  assert.match(html, /3 天 1 小时/); // uptime
});

test('renderCards marks servers near expiry with a warning class', () => {
  const html = renderCards([serverItem({ expiresAt: Date.now() + 3 * DAY })], Date.now());
  assert.match(html, /expiry warn/);
  assert.match(html, /3 天后到期/);
});

test('renderCards flags offline servers with badge, not expiry warnings', () => {
  const html = renderCards([serverItem({
    online: false,
    metric: null,
    expiresAt: Date.now() + 100 * DAY,
  })], Date.now());
  assert.match(html, /offline/);
  assert.match(html, /离线/);
  assert.ok(!/expiry warn/.test(html), 'offline far-from-expiry card must not carry expiry warn');
});

test('renderCards escapes hostile names and providers', () => {
  const html = renderCards([serverItem({ name: '<script>alert(1)</script>', provider: 'a&b' })], Date.now());
  assert.ok(!/<script>alert/.test(html), 'raw markup must not survive rendering');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /a&amp;b/);
});

test('renderCards handles servers that never reported', () => {
  const html = renderCards([serverItem({ metric: null, online: false })], Date.now());
  assert.match(html, /暂无数据/);
});
