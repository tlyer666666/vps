// SQLite persistence layer on node:sqlite. All methods are synchronous.
import { DatabaseSync } from 'node:sqlite';
import { newToken, sha256hex, safeEqualStr } from './secure.js';

const SERVER_COLS = `id, name, tag, provider, region, price_cny AS priceCny,
  expires_at AS expiresAt, notes, interval_sec AS intervalSec,
  sort_order AS sortOrder, created_at AS createdAt,
  group_name AS groupName, monthly_quota_bytes AS monthlyQuotaBytes`;

const METRIC_COLS = `server_id AS serverId, ts, cpu_pct AS cpuPct,
  mem_used AS memUsed, mem_total AS memTotal, swap_used AS swapUsed, swap_total AS swapTotal,
  disk_used AS diskUsed, disk_total AS diskTotal,
  load1, load5, load15,
  rx_bytes AS rxBytes, tx_bytes AS txBytes, rx_speed AS rxSpeed, tx_speed AS txSpeed,
  daily_rx AS dailyRx, daily_tx AS dailyTx,
  tcp_conns AS tcpConns, processes, uptime_sec AS uptimeSec`;

const METRIC_FIELDS = [
  ['cpuPct', 'cpu_pct'], ['memUsed', 'mem_used'], ['memTotal', 'mem_total'],
  ['swapUsed', 'swap_used'], ['swapTotal', 'swap_total'],
  ['diskUsed', 'disk_used'], ['diskTotal', 'disk_total'],
  ['load1', 'load1'], ['load5', 'load5'], ['load15', 'load15'],
  ['rxBytes', 'rx_bytes'], ['txBytes', 'tx_bytes'],
  ['rxSpeed', 'rx_speed'], ['txSpeed', 'tx_speed'],
  ['dailyRx', 'daily_rx'], ['dailyTx', 'daily_tx'],
  ['monthlyRx', 'monthly_rx'], ['monthlyTx', 'monthly_tx'],
  ['tcpConns', 'tcp_conns'], ['processes', 'processes'], ['uptimeSec', 'uptime_sec'],
];

const SERVER_PATCH = [
  ['name', 'name'], ['tag', 'tag'], ['provider', 'provider'], ['region', 'region'],
  ['priceCny', 'price_cny'], ['expiresAt', 'expires_at'], ['notes', 'notes'],
  ['intervalSec', 'interval_sec'], ['sortOrder', 'sort_order'],
  ['groupName', 'group_name'], ['monthlyQuotaBytes', 'monthly_quota_bytes'],
];

const PROBE_COLS = `id, name, type, target, interval_sec AS intervalSec,
  timeout_sec AS timeoutSec, enabled, created_at AS createdAt`;

const PROBE_PATCH = [
  ['name', 'name'], ['type', 'type'], ['target', 'target'],
  ['intervalSec', 'interval_sec'], ['timeoutSec', 'timeout_sec'], ['enabled', 'enabled'],
];

export function openStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  // WAL + NORMAL: frequent small inserts without a per-commit fsync stalling
  // the event loop. Power loss may drop the last commits but cannot corrupt
  // the DB — acceptable for metrics. :memory: test DBs ignore journal_mode.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');

  // node:sqlite re-prepares on every prepare() call (no LRU cache on Node 22),
  // so static SQL strings get a hand-rolled statement cache. Dynamic SQL
  // (updateServer) must stay uncached — its string varies per patch shape.
  const statements = new Map();
  const prep = (sql) => {
    let stmt = statements.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      statements.set(sql, stmt);
    }
    return stmt;
  };

  // O(1) latest-metric lookups for ingest (prev counter) and buildOverview.
  // Seeded once at open (restart rebuild), updated on write paths.
  const latestCache = new Map();
  const seedLatestCache = () => {
    latestCache.clear();
    for (const [serverId, row] of store.latestPerServer()) {
      latestCache.set(serverId, row);
    }
  };

  const store = {
    db,
    prep,

    initSchema() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS servers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          tag TEXT NOT NULL DEFAULT '',
          provider TEXT NOT NULL DEFAULT '',
          region TEXT NOT NULL DEFAULT '',
          price_cny REAL,
          expires_at INTEGER,
          notes TEXT NOT NULL DEFAULT '',
          token_hash TEXT NOT NULL,
          interval_sec INTEGER NOT NULL DEFAULT 10,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS metrics (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          cpu_pct REAL, mem_used INTEGER, mem_total INTEGER,
          swap_used INTEGER, swap_total INTEGER,
          disk_used INTEGER, disk_total INTEGER,
          load1 REAL, load5 REAL, load15 REAL,
          rx_bytes INTEGER, tx_bytes INTEGER,
          rx_speed REAL, tx_speed REAL,
          daily_rx INTEGER, daily_tx INTEGER,
          tcp_conns INTEGER, processes INTEGER, uptime_sec INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_metrics_srv_ts ON metrics(server_id, ts);
        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          server_id INTEGER NOT NULL,
          type TEXT NOT NULL,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          resolved_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS probes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          target TEXT NOT NULL,
          interval_sec INTEGER NOT NULL DEFAULT 30,
          timeout_sec INTEGER NOT NULL DEFAULT 5,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS probe_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          probe_id INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          ok INTEGER NOT NULL,
          latency_ms REAL,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_probe_results ON probe_results(probe_id, ts);
      `);
      // v1.1 migrations for pre-existing databases (idempotent).
      for (const stmt of [
        "ALTER TABLE servers ADD COLUMN group_name TEXT NOT NULL DEFAULT ''",
        'ALTER TABLE servers ADD COLUMN monthly_quota_bytes INTEGER',
        'ALTER TABLE metrics ADD COLUMN monthly_rx INTEGER',
        'ALTER TABLE metrics ADD COLUMN monthly_tx INTEGER',
      ]) {
        try {
          db.exec(stmt);
        } catch (err) {
          if (!/duplicate column/i.test(err.message)) throw err;
        }
      }
    },

    close() {
      db.close();
    },

    // ---- servers ----

    createServer({ name, tag = '', provider = '', region = '', priceCny = null,
      expiresAt = null, notes = '', intervalSec = 10, sortOrder = 0,
      groupName = '', monthlyQuotaBytes = null } = {}) {
      const token = newToken();
      const now = Date.now();
      const res = prep(`
        INSERT INTO servers (name, tag, provider, region, price_cny, expires_at, notes,
                             token_hash, interval_sec, sort_order, created_at,
                             group_name, monthly_quota_bytes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, tag, provider, region, priceCny, expiresAt, notes,
        sha256hex(token), intervalSec, sortOrder, now, groupName, monthlyQuotaBytes);
      return { id: Number(res.lastInsertRowid), token };
    },

    listServers() {
      return prep(`SELECT ${SERVER_COLS} FROM servers ORDER BY sort_order, id`).all();
    },

    getServer(id) {
      return prep(`SELECT ${SERVER_COLS} FROM servers WHERE id = ?`).get(id) ?? null;
    },

    updateServer(id, patch = {}) {
      const sets = [];
      const vals = [];
      for (const [key, col] of SERVER_PATCH) {
        if (key in patch) {
          sets.push(`${col} = ?`);
          vals.push(patch[key]);
        }
      }
      if (!sets.length) return;
      vals.push(id);
      db.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    },

    deleteServer(id) {
      prep('DELETE FROM metrics WHERE server_id = ?').run(id);
      prep('DELETE FROM events WHERE server_id = ?').run(id);
      prep('DELETE FROM servers WHERE id = ?').run(id);
      latestCache.delete(id);
    },

    resetToken(id) {
      const token = newToken();
      prep('UPDATE servers SET token_hash = ? WHERE id = ?').run(sha256hex(token), id);
      return token;
    },

    findServerByToken(token) {
      const hash = sha256hex(token);
      for (const row of prep('SELECT id, token_hash FROM servers').all()) {
        if (safeEqualStr(row.token_hash, hash)) {
          return store.getServer(row.id);
        }
      }
      return null;
    },

    // ---- metrics ----

    insertMetric(serverId, m = {}) {
      const cols = ['server_id', 'ts', ...METRIC_FIELDS.map(([, c]) => c)];
      const vals = [serverId, m.ts, ...METRIC_FIELDS.map(([k]) => m[k] ?? null)];
      prep(`INSERT INTO metrics (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...vals);
      // Cache only after the insert actually committed — a failed write must
      // leave prev = last *persisted* row so speeds don't jump.
      latestCache.set(serverId, { serverId, ...m });
    },

    latestCached() {
      return latestCache;
    },

    getHistory(serverId, fromMs, toMs, maxPoints = 400) {
      const total = prep(`
        SELECT COUNT(*) AS c FROM metrics
        WHERE server_id = ? AND ts >= ? AND ts <= ?
      `).get(serverId, fromMs, toMs).c;
      if (total <= maxPoints) {
        const rows = prep(`
          SELECT ${METRIC_COLS} FROM metrics
          WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts
        `).all(serverId, fromMs, toMs);
        return { points: rows, downsampled: false };
      }
      // Bucket in SQL: avg() ignores NULLs per column, matching the old JS
      // per-key sums/counts. ~400 rows leave the DB instead of the full range.
      // node:sqlite does not reliably honor AS aliases on aggregate columns,
      // so address values positionally (a0..aN) and map back to camelCase.
      const bucketMs = (toMs - fromMs) / maxPoints;
      const avgCols = METRIC_FIELDS.map(([, col], i) => `avg(${col}) AS a${i}`).join(', ');
      const rows = prep(`
        SELECT CAST((ts - ?) / ? AS INT) AS b, ${avgCols}
        FROM metrics
        WHERE server_id = ? AND ts >= ? AND ts <= ?
        GROUP BY b ORDER BY b
      `).all(fromMs, bucketMs, serverId, fromMs, toMs);
      const points = rows.map((row) => {
        const point = { serverId, ts: fromMs + row.b * bucketMs };
        METRIC_FIELDS.forEach(([key], i) => {
          const v = row[`a${i}`];
          if (v !== null && v !== undefined) point[key] = v;
        });
        return point;
      });
      return { points, downsampled: true };
    },

    latestPerServer() {
      const mCols = METRIC_COLS.split(',').map((c) => `m.${c.trim()}`).join(', ');
      const rows = prep(`
        SELECT ${mCols} FROM metrics m
        JOIN (SELECT server_id, MAX(ts) AS mts FROM metrics GROUP BY server_id) latest
          ON m.server_id = latest.server_id AND m.ts = latest.mts
      `).all();
      const map = new Map();
      for (const row of rows) map.set(row.serverId, row);
      return map;
    },

    pruneOlderThan(cutoffMs) {
      const removed = prep('DELETE FROM metrics WHERE ts < ?').run(cutoffMs).changes;
      if (removed > 0) seedLatestCache(); // prune can remove a server's only rows
      return removed;
    },

    deleteExpiredSessions(nowMs = Date.now()) {
      return prep('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs).changes;
    },

    deleteAllSessions() {
      return prep('DELETE FROM sessions').run().changes;
    },

    pruneResolvedEvents(cutoffMs) {
      return prep('DELETE FROM events WHERE resolved_at IS NOT NULL AND resolved_at < ?')
        .run(cutoffMs).changes;
    },

    // ---- probes (v1.1) ----

    createProbe({ name, type, target, intervalSec = 30, timeoutSec = 5, enabled = 1 } = {}) {
      const res = prep(`
        INSERT INTO probes (name, type, target, interval_sec, timeout_sec, enabled, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(name, type, target, intervalSec, timeoutSec, enabled ? 1 : 0, Date.now());
      return store.getProbe(Number(res.lastInsertRowid));
    },

    listProbes() {
      return prep(`SELECT ${PROBE_COLS} FROM probes ORDER BY id`).all();
    },

    getProbe(id) {
      return prep(`SELECT ${PROBE_COLS} FROM probes WHERE id = ?`).get(id) ?? null;
    },

    updateProbe(id, patch = {}) {
      const sets = [];
      const vals = [];
      for (const [key, col] of PROBE_PATCH) {
        if (key in patch) {
          sets.push(`${col} = ?`);
          vals.push(patch[key]);
        }
      }
      if (!sets.length) return;
      vals.push(id);
      db.prepare(`UPDATE probes SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    },

    deleteProbe(id) {
      prep('DELETE FROM probe_results WHERE probe_id = ?').run(id);
      prep('DELETE FROM probes WHERE id = ?').run(id);
    },

    insertProbeResult(probeId, r = {}) {
      prep('INSERT INTO probe_results (probe_id, ts, ok, latency_ms, error) VALUES (?, ?, ?, ?, ?)')
        .run(probeId, r.ts, r.ok ? 1 : 0, r.latencyMs ?? null, r.error ?? null);
    },

    latestProbeResults() {
      const rows = prep(`
        SELECT pr.id, pr.probe_id AS probeId, pr.ts, pr.ok, pr.latency_ms AS latencyMs, pr.error
        FROM probe_results pr
        JOIN (SELECT probe_id, MAX(ts) AS mts FROM probe_results GROUP BY probe_id) latest
          ON pr.probe_id = latest.probe_id AND pr.ts = latest.mts
      `).all();
      const map = new Map();
      for (const row of rows) map.set(row.probeId, row);
      return map;
    },

    getProbeHistory(probeId, fromMs, toMs, maxPoints = 400) {
      const total = prep('SELECT COUNT(*) AS c FROM probe_results WHERE probe_id = ? AND ts >= ? AND ts <= ?')
        .get(probeId, fromMs, toMs).c;
      if (total <= maxPoints) {
        const rows = prep(`
          SELECT ts, ok, latency_ms AS latencyMs, error FROM probe_results
          WHERE probe_id = ? AND ts >= ? AND ts <= ? ORDER BY ts
        `).all(probeId, fromMs, toMs);
        return { points: rows, downsampled: false };
      }
      // node:sqlite ignores AS aliases on aggregates — address values positionally.
      const bucketMs = (toMs - fromMs) / maxPoints;
      const rows = prep(`
        SELECT CAST((ts - ?) / ? AS INT) AS b,
               avg(ok) AS a0, avg(latency_ms) AS a1
        FROM probe_results
        WHERE probe_id = ? AND ts >= ? AND ts <= ?
        GROUP BY b ORDER BY b
      `).all(fromMs, bucketMs, probeId, fromMs, toMs);
      const points = rows.map((row) => ({
        ts: fromMs + row.b * bucketMs,
        okRatio: row.a0,
        latencyMs: row.a1,
      }));
      return { points, downsampled: true };
    },

    pruneProbeResults(cutoffMs) {
      return prep('DELETE FROM probe_results WHERE ts < ?').run(cutoffMs).changes;
    },

    // ---- uptime (v1.1) ----

    getUptimePct(serverId, fromMs, toMs, intervalSec) {
      const row = prep('SELECT COUNT(*) AS c FROM metrics WHERE server_id = ? AND ts >= ? AND ts <= ?')
        .get(serverId, fromMs, toMs);
      const expected = Math.max(1, Math.floor((toMs - fromMs) / 1000 / Math.max(1, intervalSec)));
      return Math.min(100, Math.round((row.c / expected) * 1000) / 10);
    },

    getUptimeAll(fromMs, toMs) {
      const rows = prep(`
        SELECT m.server_id AS serverId, COUNT(*) AS c, s.interval_sec AS intervalSec
        FROM metrics m JOIN servers s ON s.id = m.server_id
        WHERE m.ts >= ? AND m.ts <= ?
        GROUP BY m.server_id
      `).all(fromMs, toMs);
      const map = new Map();
      for (const row of rows) {
        const expected = Math.max(1, Math.floor((toMs - fromMs) / 1000 / Math.max(1, row.intervalSec)));
        map.set(row.serverId, Math.min(100, Math.round((row.c / expected) * 1000) / 10));
      }
      return map;
    },

    // ---- events ----

    openEvent({ serverId, type, level, message }, nowMs = Date.now()) {
      const existing = prep(
        'SELECT id, started_at FROM events WHERE server_id = ? AND type = ? AND resolved_at IS NULL'
      ).get(serverId, type);
      if (existing) {
        return { id: existing.id, startedAt: existing.started_at, existed: true };
      }
      const res = prep(`
        INSERT INTO events (server_id, type, level, message, started_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(serverId, type, level, message, nowMs);
      return { id: Number(res.lastInsertRowid), startedAt: nowMs, existed: false };
    },

    resolveEvent(serverId, type, nowMs = Date.now()) {
      return prep(`
        UPDATE events SET resolved_at = ?
        WHERE server_id = ? AND type = ? AND resolved_at IS NULL
      `).run(nowMs, serverId, type).changes;
    },

    listEvents({ limit = 100, serverId = null } = {}) {
      const base = `SELECT id, server_id AS serverId, type, level, message,
        started_at AS startedAt, resolved_at AS resolvedAt FROM events`;
      if (serverId != null) {
        return prep(`${base} WHERE server_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`)
          .all(serverId, limit);
      }
      return prep(`${base} ORDER BY started_at DESC, id DESC LIMIT ?`).all(limit);
    },

    // ---- settings ----

    getSetting(key, def = null) {
      const row = prep('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row) return def;
      try { return JSON.parse(row.value); } catch { return row.value; }
    },

    setSetting(key, val) {
      prep(`
        INSERT INTO settings (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, JSON.stringify(val));
    },

    getAdminPasswordHash() {
      return store.getSetting('admin_password_hash', null);
    },

    setAdminPasswordHash(hash) {
      store.setSetting('admin_password_hash', hash);
    },

    // ---- sessions ----

    createSession(ttlMs, nowMs = Date.now()) {
      const token = newToken();
      prep('INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)')
        .run(sha256hex(token), nowMs + ttlMs, nowMs);
      return token;
    },

    getSession(token, nowMs = Date.now()) {
      const row = prep('SELECT expires_at AS expiresAt FROM sessions WHERE token_hash = ?')
        .get(sha256hex(token));
      if (!row || row.expiresAt <= nowMs) return null;
      return row;
    },

    deleteSession(token) {
      prep('DELETE FROM sessions WHERE token_hash = ?').run(sha256hex(token));
    },
  };

  store.initSchema();
  seedLatestCache();
  return store;
}
