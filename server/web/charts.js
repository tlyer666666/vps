// Pure formatting/chart helpers. Must stay import-able from node --test
// (no DOM access at module scope) and from the browser.

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function fmtBytes(n) {
  if (n === null || n === undefined || typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n <= 0) return '0 B';
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u += 1;
  }
  if (u === 0) return `${Math.round(v)} B`;
  return `${v.toFixed(1)} ${UNITS[u]}`;
}

export function fmtBytesPerSec(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return n === 0 ? '0 B/s' : '—';
  if (n === 0) return '0 B/s';
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u += 1;
  }
  return u === 0 ? `${Math.round(v)} B/s` : `${v.toFixed(1)} ${UNITS[u]}/s`;
}

export function fmtUptime(sec) {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec < 0) return '—';
  if (sec < 60) return '<1 分钟';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时`;
  return `${minutes} 分钟`;
}

export function fmtCountdown(msUntil) {
  if (typeof msUntil !== 'number' || !Number.isFinite(msUntil)) return '未设置';
  const days = msUntil / 86400_000;
  if (days >= 1) return `${Math.floor(days)} 天后到期`;
  if (days >= 0) return '数小时内到期';
  return `已过期 ${Math.ceil(-days)} 天`;
}

export function fmtPct(p) {
  if (typeof p !== 'number' || !Number.isFinite(p)) return '—';
  return `${p.toFixed(1)}%`;
}

// Relative age of a timestamp ("3 秒前"), for last-report indicators.
export function fmtRel(msAgo, nowMs = Date.now()) {
  if (typeof msAgo !== 'number' || !Number.isFinite(msAgo)) return '—';
  const s = Math.max(0, Math.floor((nowMs - msAgo) / 1000));
  if (s < 60) return s === 0 ? '刚刚' : `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

// points: [{x, y}] in value space; returns an SVG path `d` string.
export function linePath(points, { w, h, pad = 2, min, max }) {
  if (!Array.isArray(points) || points.length === 0) return '';
  const lo = min ?? Math.min(...points.map((p) => p.y));
  const hi = max ?? Math.max(...points.map((p) => p.y));
  const span = hi - lo || 1;
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  let d = '';
  for (const p of points) {
    const x = pad + ((p.x - (points[0].x ?? 0)) / ((points[points.length - 1].x - points[0].x) || 1)) * innerW;
    const y = pad + innerH - ((p.y - lo) / span) * innerH;
    d += `${d === '' ? 'M' : ' L'}${round2(x)},${round2(y)}`;
  }
  return d;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// Thin points so the chart draws at most ~width/2 segments.
export function downsampleRender(points, width) {
  if (!Array.isArray(points) || points.length <= 1) return points ?? [];
  const maxPoints = Math.max(2, Math.floor(width / 2));
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) {
    out.push(points[Math.floor(i * step)]);
  }
  out[out.length - 1] = points[points.length - 1];
  return out;
}
