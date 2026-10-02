// SQLite persistence layer on node:sqlite. All methods are synchronous.
import { DatabaseSync } from 'node:sqlite';
import { newToken, sha256hex, safeEqualStr } from './secure.js';

const SERVER_COLS = `id, name, tag, provider, region, price_cny AS priceCny,
  expires_at AS expiresAt, notes, interval_sec AS intervalSec,
  sort_order AS sortOrder, created_at AS createdAt`;

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
  ['tcpConns', 'tcp_conns'], ['processes', 'processes'], ['uptimeSec', 'uptime_sec'],
];

const SERVER_PATCH = [
  ['name', 'name'], ['tag', 'tag'], ['provider', 'provider'], ['region', 'region'],
  ['priceCny', 'price_cny'], ['expiresAt', 'expires_at'], ['notes', 'notes'],
  ['intervalSec', 'interval_sec'], ['sortOrder', 'sort_order'],
];

export function openStore(dbPath) {
  const db = new DatabaseSync(dbPath);
  const store = {
    db,

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
      `);
    },

    close() {
      db.close();
    },

    // ---- servers ----

    createServer({ name, tag = '', provider = '', region = '', priceCny = null,
      expiresAt = null, notes = '', intervalSec = 10, sortOrder = 0 } = {}) {
      const token = newToken();
      const now = Date.now();
      const res = db.prepare(`
        INSERT INTO servers (name, tag, provider, region, price_cny, expires_at, notes,
                             token_hash, interval_sec, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(name, tag, provider, region, priceCny, expiresAt, notes,
        sha256hex(token), intervalSec, sortOrder, now);
      return { id: Number(res.lastInsertRowid), token };
    },

    listServers() {
      return db.prepare(`SELECT ${SERVER_COLS} FROM servers ORDER BY sort_order, id`).all();
    },

    getServer(id) {
      return db.prepare(`SELECT ${SERVER_COLS} FROM servers WHERE id = ?`).get(id) ?? null;
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
      db.prepare('DELETE FROM metrics WHERE server_id = ?').run(id);
      db.prepare('DELETE FROM events WHERE server_id = ?').run(id);
      db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    },

    resetToken(id) {
      const token = newToken();
      db.prepare('UPDATE servers SET token_hash = ? WHERE id = ?').run(sha256hex(token), id);
      return token;
    },

    findServerByToken(token) {
      const hash = sha256hex(token);
      for (const row of db.prepare('SELECT id, token_hash FROM servers').all()) {
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
      db.prepare(`INSERT INTO metrics (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
        .run(...vals);
    },

    getHistory(serverId, fromMs, toMs, maxPoints = 400) {
      const rows = db.prepare(`
        SELECT ${METRIC_COLS} FROM metrics
        WHERE server_id = ? AND ts >= ? AND ts <= ? ORDER BY ts
      `).all(serverId, fromMs, toMs);
      if (rows.length <= maxPoints) {
        return { points: rows, downsampled: false };
      }
      const bucketMs = (toMs - fromMs) / maxPoints;
      const buckets = new Map();
      for (const row of rows) {
        const idx = Math.min(Math.floor((row.ts - fromMs) / bucketMs), maxPoints - 1);
        let b = buckets.get(idx);
        if (!b) {
          b = { ts: fromMs + idx * bucketMs, sums: {}, counts: {} };
          buckets.set(idx, b);
        }
        for (const key of Object.keys(row)) {
          if (key === 'serverId' || row[key] === null) continue;
          b.sums[key] = (b.sums[key] ?? 0) + row[key];
          b.counts[key] = (b.counts[key] ?? 0) + 1;
        }
      }
      const points = [...buckets.keys()].sort((a, b) => a - b).map((idx) => {
        const b = buckets.get(idx);
        const point = { serverId, ts: b.ts };
        for (const key of Object.keys(b.sums)) {
          point[key] = b.sums[key] / b.counts[key];
        }
        return point;
      });
      return { points, downsampled: true };
    },

    latestPerServer() {
      const mCols = METRIC_COLS.split(',').map((c) => `m.${c.trim()}`).join(', ');
      const rows = db.prepare(`
        SELECT ${mCols} FROM metrics m
        JOIN (SELECT server_id, MAX(ts) AS mts FROM metrics GROUP BY server_id) latest
          ON m.server_id = latest.server_id AND m.ts = latest.mts
      `).all();
      const map = new Map();
      for (const row of rows) map.set(row.serverId, row);
      return map;
    },

    pruneOlderThan(cutoffMs) {
      return db.prepare('DELETE FROM metrics WHERE ts < ?').run(cutoffMs).changes;
    },

    deleteExpiredSessions(nowMs = Date.now()) {
      return db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(nowMs).changes;
    },

    pruneResolvedEvents(cutoffMs) {
      return db.prepare('DELETE FROM events WHERE resolved_at IS NOT NULL AND resolved_at < ?')
        .run(cutoffMs).changes;
    },

    // ---- events ----

    openEvent({ serverId, type, level, message }, nowMs = Date.now()) {
      const existing = db.prepare(
        'SELECT id, started_at FROM events WHERE server_id = ? AND type = ? AND resolved_at IS NULL'
      ).get(serverId, type);
      if (existing) {
        return { id: existing.id, startedAt: existing.started_at, existed: true };
      }
      const res = db.prepare(`
        INSERT INTO events (server_id, type, level, message, started_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(serverId, type, level, message, nowMs);
      return { id: Number(res.lastInsertRowid), startedAt: nowMs, existed: false };
    },

    resolveEvent(serverId, type, nowMs = Date.now()) {
      return db.prepare(`
        UPDATE events SET resolved_at = ?
        WHERE server_id = ? AND type = ? AND resolved_at IS NULL
      `).run(nowMs, serverId, type).changes;
    },

    listEvents({ limit = 100, serverId = null } = {}) {
      const base = `SELECT id, server_id AS serverId, type, level, message,
        started_at AS startedAt, resolved_at AS resolvedAt FROM events`;
      if (serverId != null) {
        return db.prepare(`${base} WHERE server_id = ? ORDER BY started_at DESC, id DESC LIMIT ?`)
          .all(serverId, limit);
      }
      return db.prepare(`${base} ORDER BY started_at DESC, id DESC LIMIT ?`).all(limit);
    },

    // ---- settings ----

    getSetting(key, def = null) {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row) return def;
      try { return JSON.parse(row.value); } catch { return row.value; }
    },

    setSetting(key, val) {
      db.prepare(`
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
      db.prepare('INSERT INTO sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)')
        .run(sha256hex(token), nowMs + ttlMs, nowMs);
      return token;
    },

    getSession(token, nowMs = Date.now()) {
      const row = db.prepare('SELECT expires_at AS expiresAt FROM sessions WHERE token_hash = ?')
        .get(sha256hex(token));
      if (!row || row.expiresAt <= nowMs) return null;
      return row;
    },

    deleteSession(token) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256hex(token));
    },
  };

  store.initSchema();
  return store;
}
