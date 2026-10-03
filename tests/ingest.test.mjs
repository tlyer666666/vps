import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReport, computeSpeed, normalize } from '../server/ingest.js';

function validReport(overrides = {}) {
  return {
    hostname: 'web-1',
    uptime: 12345.6,
    cpu: { usage_pct: 12.34, cores: 4 },
    mem: { total: 2 * 1024 ** 3, used: 1024 ** 3 },
    disks: [{ mount: '/', total: 40 * 1024 ** 3, used: 10 * 1024 ** 3 }],
    net: { rx_bytes: 1_000_000, tx_bytes: 2_000_000 },
    ...overrides,
  };
}

const CTX = { prevCounter: { rxBytes: 900_000, txBytes: 1_900_000 }, nowMs: 10_000, dtSec: 10 };

test('rejects non-object body', () => {
  for (const body of [null, 42, 'x', [], undefined]) {
    assert.equal(validateReport(body).ok, false, JSON.stringify(body));
  }
});

test('rejects NaN and non-finite numbers', () => {
  assert.equal(validateReport(validReport({ cpu: { usage_pct: NaN, cores: 4 } })).ok, false);
  assert.equal(validateReport(validReport({ uptime: Infinity })).ok, false);
  assert.equal(validateReport(validReport({ mem: { total: 'big', used: 1 } })).ok, false);
});

test('rejects negative values', () => {
  assert.equal(validateReport(validReport({ uptime: -1 })).ok, false);
  assert.equal(validateReport(validReport({ net: { rx_bytes: -5, tx_bytes: 1 } })).ok, false);
  assert.equal(validateReport(validReport({ cpu: { usage_pct: -0.1, cores: 1 } })).ok, false);
});

test('rejects mem.used > mem.total and cpu.usage_pct > 100', () => {
  assert.equal(validateReport(validReport({ mem: { total: 100, used: 101 } })).ok, false);
  assert.equal(validateReport(validReport({ cpu: { usage_pct: 100.01, cores: 1 } })).ok, false);
});

test('rejects bad hostname characters and overlong names', () => {
  assert.equal(validateReport(validReport({ hostname: 'web/1' })).ok, false);
  assert.equal(validateReport(validReport({ hostname: 'a b' })).ok, false);
  assert.equal(validateReport(validReport({ hostname: 'x'.repeat(65) })).ok, false);
});

test('empty-string hostname is treated as absent, not an error', () => {
  const r = validateReport(validReport({ hostname: '' }));
  assert.equal(r.ok, true);
  assert.equal(r.value.hostname, null);
});

test('rejects empty or oversized disk array and bad disk entries', () => {
  assert.equal(validateReport(validReport({ disks: [] })).ok, false);
  assert.equal(validateReport(validReport({
    disks: [
      { mount: '/', total: 10, used: 1 },
      { mount: '/data', total: 20, used: 1 },
      { mount: '/b', total: 20, used: 1 },
      { mount: '/c', total: 20, used: 1 },
      { mount: '/d', total: 20, used: 1 },
    ],
  })).ok, false);
  assert.equal(validateReport(validReport({ disks: [{ mount: '/', total: 0, used: 0 }] })).ok, false);
  assert.equal(validateReport(validReport({ disks: [{ mount: '/', total: 10, used: 11 }] })).ok, false);
});

test('minimal valid payload passes with optionals null', () => {
  const r = validateReport({
    uptime: 10,
    cpu: { usage_pct: 1, cores: 1 },
    mem: { total: 100, used: 50 },
    disks: [{ mount: '/', total: 100, used: 1 }],
    net: { rx_bytes: 0, tx_bytes: 0 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.value.hostname, null);
  assert.equal(r.value.swapTotal, null);
  assert.equal(r.value.swapUsed, null);
  assert.equal(r.value.load1, null);
  assert.equal(r.value.tcpConns, null);
  assert.equal(r.value.processes, null);
  assert.equal(r.value.dailyRx, null);
  assert.equal(r.value.dailyTx, null);
  assert.equal(r.value.monthlyRx, null);
  assert.equal(r.value.monthlyTx, null);
});

test('monthly traffic counters pass through (v1.1 quota support)', () => {
  const r = validateReport(validReport({
    daily_rx: 1000,
    daily_tx: 2000,
    monthly_rx: 3000,
    monthly_tx: 4000,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.value.monthlyRx, 3000);
  assert.equal(r.value.monthlyTx, 4000);
  const row = normalize(r.value, { prevCounter: null, nowMs: 1, dtSec: 0 });
  assert.equal(row.monthlyRx, 3000);
  assert.equal(row.monthlyTx, 4000);
  assert.equal(validateReport(validReport({ monthly_rx: -1 })).ok, false);
});

test('accepts full payload with optionals', () => {
  const r = validateReport(validReport({
    mem: { total: 1000, used: 100, swap_total: 500, swap_used: 20 },
    load: { load1: 0.5, load5: 0.4, load15: 0.3 },
    tcp_conns: 42,
    processes: 180,
    daily_rx: 123456,
    daily_tx: 654321,
  }));
  assert.equal(r.ok, true);
  assert.equal(r.value.swapTotal, 500);
  assert.equal(r.value.load15, 0.3);
  assert.equal(r.value.tcpConns, 42);
  assert.equal(r.value.dailyRx, 123456);
});

test('root disk is the one with the largest total', () => {
  const r = validateReport(validReport({
    disks: [
      { mount: '/small', total: 1000, used: 900 },
      { mount: '/', total: 40 * 1024 ** 3, used: 10 * 1024 ** 3 },
    ],
  }));
  assert.equal(r.ok, true);
  assert.equal(r.value.diskTotal, 40 * 1024 ** 3);
  assert.equal(r.value.diskUsed, 10 * 1024 ** 3);
});

test('computeSpeed: null prev or rollback or bad dt -> 0', () => {
  assert.equal(computeSpeed(null, 1000, 10), 0);
  assert.equal(computeSpeed(2000, 1000, 10), 0, 'counter rollback must yield 0');
  assert.equal(computeSpeed(1000, 1000, 0), 0);
  assert.equal(computeSpeed(1000, 1000, -5), 0);
});

test('computeSpeed: (1000,2000,10) is 100; rounds to 0.001', () => {
  assert.equal(computeSpeed(1000, 2000, 10), 100);
  assert.equal(computeSpeed(0, 3333, 3), 1111);
  assert.equal(computeSpeed(0, 1, 3), 0.333);
});

test('normalize emits all metric row fields with server-side ts', () => {
  const report = validateReport(validReport({
    net: { rx_bytes: 1_900_000, tx_bytes: 3_800_000 },
  })).value;
  const row = normalize(report, CTX);
  for (const key of ['ts', 'cpuPct', 'memUsed', 'memTotal', 'swapUsed', 'swapTotal',
    'diskUsed', 'diskTotal', 'load1', 'load5', 'load15',
    'rxBytes', 'txBytes', 'rxSpeed', 'txSpeed', 'dailyRx', 'dailyTx',
    'tcpConns', 'processes', 'uptimeSec']) {
    assert.ok(key in row, `missing ${key}`);
  }
  assert.equal(row.ts, 10_000, 'ts must come from server clock, not the agent');
  assert.equal(row.cpuPct, 12.34);
  assert.equal(row.memPct, 50);
  assert.equal(row.rxSpeed, 100_000);
  assert.equal(row.txSpeed, 190_000);
  assert.equal(row.uptimeSec, 12345.6);
});

test('normalize with no prev counter yields zero speeds', () => {
  const report = validateReport(validReport()).value;
  const row = normalize(report, { prevCounter: null, nowMs: 1, dtSec: 10 });
  assert.equal(row.rxSpeed, 0);
  assert.equal(row.txSpeed, 0);
});
