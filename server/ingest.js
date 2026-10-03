// Validation and normalization of agent reports.
// The server clock is the single time authority: client timestamps are ignored.
const MAX_COUNTER = 1e18;

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v, min, max) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) return null;
  return v;
}

function int(v, min, max) {
  const n = num(v, min, max);
  return n === null ? null : Math.round(n);
}

function optHostname(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length === 0 || v.length > 64) return null;
  return /^[A-Za-z0-9._-]+$/.test(v) ? v : null;
}

function validate(report) {
  if (!isObj(report)) return 'body must be an object';

  const uptime = num(report.uptime, 0, 1e10);
  if (uptime === null) return 'uptime must be a finite number >= 0';

  const cpu = report.cpu;
  if (!isObj(cpu)) return 'cpu must be an object';
  const usagePct = num(cpu.usage_pct, 0, 100);
  if (usagePct === null) return 'cpu.usage_pct must be in [0, 100]';
  const cores = int(cpu.cores, 1, 4096);
  if (cores === null) return 'cpu.cores must be an integer in [1, 4096]';

  const mem = report.mem;
  if (!isObj(mem)) return 'mem must be an object';
  const memTotal = num(mem.total, 1, MAX_COUNTER);
  if (memTotal === null) return 'mem.total must be > 0';
  const memUsed = num(mem.used, 0, memTotal);
  if (memUsed === null) return 'mem.used must be in [0, mem.total]';

  let swapTotal = null;
  let swapUsed = null;
  if (mem.swap_total !== undefined && mem.swap_total !== null) {
    swapTotal = num(mem.swap_total, 0, MAX_COUNTER);
    if (swapTotal === null) return 'mem.swap_total must be >= 0';
    swapUsed = mem.swap_used === undefined || mem.swap_used === null
      ? 0
      : num(mem.swap_used, 0, swapTotal);
    if (swapUsed === null) return 'mem.swap_used must be in [0, mem.swap_total]';
  }

  if (!Array.isArray(report.disks) || report.disks.length < 1 || report.disks.length > 4) {
    return 'disks must be an array of 1..4 entries';
  }
  let rootDisk = null;
  for (const d of report.disks) {
    if (!isObj(d)) return 'each disk must be an object';
    const total = num(d.total, 1, MAX_COUNTER);
    if (total === null) return 'disk.total must be > 0';
    const used = num(d.used, 0, total);
    if (used === null) return 'disk.used must be in [0, disk.total]';
    if (!rootDisk || total > rootDisk.total) rootDisk = { total, used };
  }

  const net = report.net;
  if (!isObj(net)) return 'net must be an object';
  const rxBytes = num(net.rx_bytes, 0, MAX_COUNTER);
  if (rxBytes === null) return 'net.rx_bytes must be a finite number >= 0';
  const txBytes = num(net.tx_bytes, 0, MAX_COUNTER);
  if (txBytes === null) return 'net.tx_bytes must be a finite number >= 0';

  let load1 = null, load5 = null, load15 = null;
  if (report.load !== undefined && report.load !== null) {
    if (!isObj(report.load)) return 'load must be an object';
    load1 = num(report.load.load1, 0, 1e4);
    load5 = num(report.load.load5, 0, 1e4);
    load15 = num(report.load.load15, 0, 1e4);
    if (load1 === null || load5 === null || load15 === null) {
      return 'load values must be finite numbers in [0, 1e4]';
    }
  }

  const tcpConns = report.tcp_conns === undefined || report.tcp_conns === null
    ? null
    : int(report.tcp_conns, 0, 1e7);
  if (report.tcp_conns != null && tcpConns === null) return 'tcp_conns out of range';

  const processes = report.processes === undefined || report.processes === null
    ? null
    : int(report.processes, 0, 1e7);
  if (report.processes != null && processes === null) return 'processes out of range';

  const dailyRx = report.daily_rx === undefined || report.daily_rx === null
    ? null
    : num(report.daily_rx, 0, MAX_COUNTER);
  if (report.daily_rx != null && dailyRx === null) return 'daily_rx out of range';

  const dailyTx = report.daily_tx === undefined || report.daily_tx === null
    ? null
    : num(report.daily_tx, 0, MAX_COUNTER);
  if (report.daily_tx != null && dailyTx === null) return 'daily_tx out of range';

  const monthlyRx = report.monthly_rx === undefined || report.monthly_rx === null
    ? null
    : num(report.monthly_rx, 0, MAX_COUNTER);
  if (report.monthly_rx != null && monthlyRx === null) return 'monthly_rx out of range';

  const monthlyTx = report.monthly_tx === undefined || report.monthly_tx === null
    ? null
    : num(report.monthly_tx, 0, MAX_COUNTER);
  if (report.monthly_tx != null && monthlyTx === null) return 'monthly_tx out of range';

  const hostname = optHostname(report.hostname);
  if (report.hostname && hostname === null) {
    return 'hostname must match [A-Za-z0-9._-]{1,64}';
  }

  return {
    uptimeSec: uptime,
    hostname,
    cpuPct: usagePct,
    cores,
    memUsed,
    memTotal,
    swapUsed,
    swapTotal,
    diskUsed: rootDisk.used,
    diskTotal: rootDisk.total,
    load1, load5, load15,
    rxBytes,
    txBytes,
    dailyRx,
    dailyTx,
    monthlyRx,
    monthlyTx,
    tcpConns,
    processes,
  };
}

export function validateReport(body) {
  try {
    const value = validate(body);
    return typeof value === 'string' ? { ok: false, error: value } : { ok: true, value };
  } catch (err) {
    return { ok: false, error: `invalid report: ${err.message}` };
  }
}

// Speed from cumulative counters; any rollback or clock nonsense reads as 0
// (reboots reset counters — a giant spike is worse than a quiet zero).
export function computeSpeed(prevCounter, curCounter, dtSec) {
  if (prevCounter === null || prevCounter === undefined) return 0;
  if (typeof prevCounter !== 'number' || typeof curCounter !== 'number') return 0;
  if (!Number.isFinite(prevCounter) || !Number.isFinite(curCounter)) return 0;
  if (dtSec <= 0) return 0;
  if (curCounter < prevCounter) return 0;
  return Math.round(((curCounter - prevCounter) / dtSec) * 1000) / 1000;
}

export function normalize(report, { prevCounter, nowMs, dtSec }) {
  const prevRx = prevCounter ? prevCounter.rxBytes : null;
  const prevTx = prevCounter ? prevCounter.txBytes : null;
  return {
    ts: nowMs,
    hostname: report.hostname,
    cpuPct: report.cpuPct,
    memUsed: report.memUsed,
    memTotal: report.memTotal,
    memPct: Math.round((report.memUsed / report.memTotal) * 10000) / 100,
    swapUsed: report.swapUsed,
    swapTotal: report.swapTotal,
    diskUsed: report.diskUsed,
    diskTotal: report.diskTotal,
    load1: report.load1,
    load5: report.load5,
    load15: report.load15,
    rxBytes: report.rxBytes,
    txBytes: report.txBytes,
    rxSpeed: computeSpeed(prevRx, report.rxBytes, dtSec),
    txSpeed: computeSpeed(prevTx, report.txBytes, dtSec),
    dailyRx: report.dailyRx,
    dailyTx: report.dailyTx,
    monthlyRx: report.monthlyRx,
    monthlyTx: report.monthlyTx,
    tcpConns: report.tcpConns,
    processes: report.processes,
    uptimeSec: report.uptimeSec,
  };
}
