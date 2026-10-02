import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  linePath, downsampleRender,
  fmtBytes, fmtBytesPerSec, fmtUptime, fmtCountdown, fmtPct,
} from '../server/web/charts.js';

test('fmtBytes: 0/1023/1MiB/1.5GB/null/negative', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1023), '1023 B');
  assert.equal(fmtBytes(1024), '1.0 KB');
  assert.equal(fmtBytes(1024 ** 2), '1.0 MB');
  assert.equal(fmtBytes(1.5 * 1024 ** 3), '1.5 GB');
  assert.equal(fmtBytes(1024 ** 4), '1.0 TB');
  assert.equal(fmtBytes(-5), '0 B');
  assert.equal(fmtBytes(null), '—');
  assert.equal(fmtBytes(undefined), '—');
});

test('fmtBytesPerSec formats speeds', () => {
  assert.equal(fmtBytesPerSec(0), '0 B/s');
  assert.equal(fmtBytesPerSec(512), '512 B/s');
  assert.equal(fmtBytesPerSec(1536), '1.5 KB/s');
  assert.equal(fmtBytesPerSec(12.4 * 1024 ** 2), '12.4 MB/s');
  assert.equal(fmtBytesPerSec(null), '—');
});

test('fmtUptime renders days/hours/minutes', () => {
  assert.equal(fmtUptime(59), '<1 分钟');
  assert.equal(fmtUptime(120), '2 分钟');
  assert.equal(fmtUptime(3 * 3600 + 720), '3 小时');
  assert.equal(fmtUptime(2 * 86400 + 3600), '2 天 1 小时');
  assert.equal(fmtUptime(null), '—');
});

test('fmtCountdown: future, near, past, none', () => {
  const DAY = 86400_000;
  assert.equal(fmtCountdown(3 * DAY), '3 天后到期');
  assert.equal(fmtCountdown(5 * 3600 * 1000), '数小时内到期');
  assert.equal(fmtCountdown(-2 * DAY), '已过期 2 天');
  assert.equal(fmtCountdown(null), '未设置');
});

test('fmtPct rounds to one decimal with % sign', () => {
  assert.equal(fmtPct(0), '0.0%');
  assert.equal(fmtPct(12.34), '12.3%');
  assert.equal(fmtPct(null), '—');
});

test('linePath: empty and single point are safe', () => {
  assert.equal(linePath([], { w: 100, h: 40, pad: 2, min: 0, max: 1 }), '');
  const one = linePath([{ x: 5, y: 1 }], { w: 100, h: 40, pad: 2, min: 0, max: 10 });
  assert.match(one, /^M/);
});

test('linePath maps values to pixel coordinates linearly', () => {
  // two points: min -> bottom, max -> top (y inverted), x spans width minus padding
  const d = linePath(
    [{ x: 0, y: 0 }, { x: 100, y: 10 }],
    { w: 104, h: 44, pad: 2, min: 0, max: 10 },
  );
  const coords = [...d.matchAll(/-?[\d.]+,-?[\d.]+/g)].map((m) => m[0]);
  assert.equal(coords.length, 2);
  const [first, last] = coords.map((s) => s.split(',').map(Number));
  assert.equal(first[0], 2);   // x = pad + 0/100 * (w-2pad)
  assert.equal(first[1], 42);  // y = h-pad - (0-min)/(max-min) * (h-2pad) = 42
  assert.equal(last[0], 102);
  assert.equal(last[1], 2);
});

test('downsampleRender keeps ends and thins by pixel width', () => {
  const pts = Array.from({ length: 1000 }, (_, i) => ({ x: i, y: i }));
  const out = downsampleRender(pts, 300);
  assert.ok(out.length <= 300, `expected <=300, got ${out.length}`);
  assert.equal(out[0].x, 0);
  assert.equal(out[out.length - 1].x, 999);
  const small = downsampleRender(pts, 2000);
  assert.equal(small.length, 1000);
  assert.equal(downsampleRender([], 300).length, 0);
});
