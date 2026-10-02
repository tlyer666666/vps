// HTTP server: routes, sessions, SSE, rate limits, static files.
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReport, normalize } from './ingest.js';
import { verifyPassword, verifyAgentToken, hashPassword } from './auth.js';
import { createNotifier } from './notify.js';
import { serveStatic } from './static.js';
import { deepMerge, CONFIG_DEFAULTS } from './config.js';

const COOKIE_NAME = 'vw_session';
const BODY_LIMIT = 64 * 1024;
const RANGES = {
  '1h': 3600e3,
  '6h': 6 * 3600e3,
  '24h': 24 * 3600e3,
  '7d': 7 * 24 * 3600e3,
  '30d': 30 * 24 * 3600e3,
};
const LOGIN_WINDOW_MS = 15 * 60_000;

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    let over = false;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      resolve(result);
    };
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > BODY_LIMIT) {
        over = true;
        // Let the request drain so the 413 response can be delivered cleanly.
        req.removeAllListeners('data');
        req.resume();
        finish({ over: true });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => finish({ over: false, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ over: false, raw: '' }));
  });
}

function bearerOf(req) {
  const h = req.headers.authorization ?? '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function sessionTokenOf(req) {
  const cookie = req.headers.cookie ?? '';
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE_NAME) return rest.join('=');
  }
  return null;
}

export function createApp({ config, store, engine = null, notifier = null, log = console }) {
  const webDir = config.webDir ?? join(dirname(fileURLToPath(import.meta.url)), 'web');

  // Effective settings = shipped defaults, overlaid with config and persisted admin changes.
  let effective = deepMerge(
    {
      webhookUrl: CONFIG_DEFAULTS.webhookUrl,
      thresholds: { ...CONFIG_DEFAULTS.thresholds },
      notifyCooldownMin: CONFIG_DEFAULTS.notifyCooldownMin,
      retentionDays: CONFIG_DEFAULTS.retentionDays,
    },
    {
      webhookUrl: config.webhookUrl,
      thresholds: config.thresholds,
      notifyCooldownMin: config.notifyCooldownMin,
      retentionDays: config.retentionDays,
    },
  );
  effective = deepMerge(effective, store.getSetting('settings', {}) ?? {});
  if (engine) {
    engine.thresholds = { ...effective.thresholds };
    engine.cooldownMs = effective.notifyCooldownMin * 60_000;
  }

  const notify = notifier ?? createNotifier({ webhookUrl: () => effective.webhookUrl });

  // Client identity for rate limits. Behind a reverse proxy every socket is
  // 127.0.0.1, so all clients would share one bucket — trust-proxy opts into
  // taking the client from the last X-Forwarded-For hop instead.
  function clientIp(req) {
    if (config.trustProxy) {
      const xff = req.headers['x-forwarded-for'];
      if (typeof xff === 'string' && xff.length > 0) {
        const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
        if (hops.length > 0) return hops[hops.length - 1];
      }
    }
    return req.socket.remoteAddress ?? '?';
  }

  const agentBuckets = new Map(); // ip -> { tokens, last }
  const loginFails = new Map(); // ip -> [ms]
  const sseClients = new Set(); // res objects
  const sseHeartbeats = new Set(); // per-client heartbeat timers
  let broadcastTimer = null;
  let broadcastQueued = false;
  let tickTimer = null;
  let pruneTimer = null;

  function buildOverview(now = Date.now()) {
    const latest = store.latestCached();
    return store.listServers().map((s) => {
      const m = latest.get(s.id) ?? null;
      const intervalSec = s.intervalSec ?? config.intervalSec ?? 10;
      const windowMs = Math.max(intervalSec * 3 * 1000, 60_000);
      const online = m !== null && now - m.ts <= windowMs;
      const metric = m
        ? {
          ...m,
          memPct: m.memTotal > 0 ? Math.round((m.memUsed / m.memTotal) * 10000) / 100 : null,
          diskPct: m.diskTotal > 0 ? Math.round((m.diskUsed / m.diskTotal) * 10000) / 100 : null,
        }
        : null;
      return { ...s, online, lastSeen: m ? m.ts : null, metric };
    });
  }

  function sendSnapshot() {
    const frame = `event: overview\ndata: ${JSON.stringify(buildOverview())}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { /* client vanished mid-write */ }
    }
  }

  function broadcast() {
    if (broadcastTimer) {
      broadcastQueued = true;
      return;
    }
    sendSnapshot();
    broadcastTimer = setTimeout(() => {
      broadcastTimer = null;
      if (broadcastQueued) {
        broadcastQueued = false;
        broadcast();
      }
    }, 2000);
  }

  function consumeAgentRate(ip) {
    const rate = config.rate?.agentPerSec ?? 30;
    const now = Date.now();
    const bucket = agentBuckets.get(ip) ?? { tokens: rate, last: now };
    bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.last) / 1000) * rate);
    bucket.last = now;
    if (bucket.tokens < 1) {
      agentBuckets.set(ip, bucket);
      return false;
    }
    bucket.tokens -= 1;
    agentBuckets.set(ip, bucket);
    return true;
  }

  function loginBlocked(ip) {
    const limit = config.rate?.loginPer15Min ?? 5;
    const now = Date.now();
    const fails = (loginFails.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    loginFails.set(ip, fails);
    return fails.length >= limit;
  }

  function recordLoginFail(ip) {
    const fails = loginFails.get(ip) ?? [];
    fails.push(Date.now());
    loginFails.set(ip, fails);
  }

  function isAuthed(req) {
    const token = sessionTokenOf(req);
    if (!token) return false;
    return store.getSession(token) !== null;
  }

  // CSRF defense-in-depth: SameSite=Lax covers modern browsers, but the
  // Chrome "Lax+POST" 2-minute exception plus an enctype=text/plain form can
  // smuggle JSON. When the browser advertises an Origin/Referer that does not
  // match Host, refuse the mutation. curl/agents send neither → unaffected.
  function crossOriginMutation(req) {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return false;
    const src = req.headers.origin ?? req.headers.referer;
    if (!src) return false;
    try {
      return new URL(src).host !== req.headers.host;
    } catch {
      return true;
    }
  }

  async function handleLogin(req, res, ip) {
    if (crossOriginMutation(req)) return json(res, 403, { error: 'cross-origin request blocked' });
    if (loginBlocked(ip)) return json(res, 429, { error: 'too many attempts' });
    const { raw } = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw ?? '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
    const stored = store.getAdminPasswordHash();
    const ok = stored !== null && (await verifyPassword(String(body.password ?? ''), stored));
    if (!ok) {
      recordLoginFail(ip);
      return json(res, 401, { error: 'unauthorized' });
    }
    loginFails.delete(ip);
    const ttlMs = (config.sessionTtlDays ?? 7) * 24 * 3600 * 1000;
    const token = store.createSession(ttlMs);
    const isHttps = req.socket.encrypted === true || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('set-cookie',
      `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${isHttps ? '; Secure' : ''}`);
    return json(res, 200, { ok: true });
  }

  async function handleReport(req, res, ip) {
    if (!consumeAgentRate(ip)) return json(res, 429, { error: 'rate limited' });
    const server = verifyAgentToken(store, bearerOf(req));
    if (!server) return json(res, 401, { error: 'unauthorized' });

    const { over, raw } = await readBody(req);
    if (over) return json(res, 413, { error: 'body too large' });
    let body;
    try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'invalid json' }); }

    const v = validateReport(body);
    if (!v.ok) return json(res, 400, { error: v.error });

    const now = Date.now();
    const prev = store.latestCached().get(server.id) ?? null;
    const dtSec = prev ? Math.max(0, (now - prev.ts) / 1000) : 0;
    const metric = normalize(v.value, { prevCounter: prev, nowMs: now, dtSec });

    let persisted = true;
    try {
      store.insertMetric(server.id, metric);
    } catch (err) {
      persisted = false;
      log.warn(`[ingest] persist failed for server ${server.id}: ${err.message}`);
    }
    try {
      engine?.ingest(server, metric, now);
    } catch (err) {
      log.warn(`[ingest] alert engine failed for server ${server.id}: ${err.message}`);
    }
    broadcast();
    return json(res, 200, persisted ? { ok: true } : { ok: true, persisted: false });
  }

  function handleStream(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    sseClients.add(res);
    res.write(`event: overview\ndata: ${JSON.stringify(buildOverview())}\n\n`);
    const heartbeat = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignored */ }
    }, 15000);
    sseHeartbeats.add(heartbeat);
    req.on('close', () => {
      clearInterval(heartbeat);
      sseHeartbeats.delete(heartbeat);
      sseClients.delete(res);
    });
  }

  function settingsView() {
    return {
      webhookUrl: effective.webhookUrl,
      thresholds: { ...effective.thresholds },
      notifyCooldownMin: effective.notifyCooldownMin,
      retentionDays: effective.retentionDays,
    };
  }

  function applySettings(patch) {
    const saved = deepMerge(store.getSetting('settings', {}) ?? {}, patch);
    store.setSetting('settings', saved);
    effective = deepMerge(effective, patch);
    if (engine) {
      engine.thresholds = { ...effective.thresholds };
      engine.cooldownMs = effective.notifyCooldownMin * 60_000;
    }
  }

  // ---- input validation (rejected payloads must never reach the store) ----

  function isIntIn(v, lo, hi) {
    return Number.isInteger(v) && v >= lo && v <= hi;
  }

  // Returns null when valid, otherwise an error message.
  function settingsPatchError(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'body must be an object';
    if (patch.thresholds !== undefined) {
      const t = patch.thresholds;
      if (t === null || typeof t !== 'object' || Array.isArray(t)) return 'thresholds must be an object';
      for (const k of ['cpu', 'mem', 'disk']) {
        if (t[k] !== undefined && !(typeof t[k] === 'number' && Number.isFinite(t[k]) && t[k] >= 1 && t[k] <= 100)) {
          return `thresholds.${k} must be a number in [1, 100]`;
        }
      }
      if (t.consecutive !== undefined && !isIntIn(t.consecutive, 1, 60)) return 'thresholds.consecutive must be an integer in [1, 60]';
      if (t.expiryDays !== undefined && !isIntIn(t.expiryDays, 0, 3650)) return 'thresholds.expiryDays must be an integer in [0, 3650]';
    }
    if (patch.notifyCooldownMin !== undefined && !isIntIn(patch.notifyCooldownMin, 1, 1440)) {
      return 'notifyCooldownMin must be an integer in [1, 1440]';
    }
    if (patch.retentionDays !== undefined && !isIntIn(patch.retentionDays, 1, 3650)) {
      return 'retentionDays must be an integer in [1, 3650]';
    }
    if (patch.webhookUrl !== undefined) {
      const u = patch.webhookUrl;
      if (u !== '' && (typeof u !== 'string' || u.length > 500 || !/^https?:\/\/.+/i.test(u))) {
        return 'webhookUrl must be empty or an http(s) URL';
      }
    }
    return null;
  }

  // Server create/update fields. Partial=true validates only present keys.
  function serverInputError(body, { partial = false } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
    if (!partial || body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 100) {
        return 'name must be a string of 1..100 characters';
      }
    }
    for (const k of ['tag', 'provider', 'region', 'notes']) {
      if (body[k] !== undefined && (typeof body[k] !== 'string' || body[k].length > 200)) {
        return `${k} must be a string of at most 200 characters`;
      }
    }
    if (body.priceCny !== undefined && body.priceCny !== null
      && !(typeof body.priceCny === 'number' && Number.isFinite(body.priceCny) && body.priceCny >= 0 && body.priceCny <= 1e7)) {
      return 'priceCny must be null or a number in [0, 1e7]';
    }
    if (body.expiresAt !== undefined && body.expiresAt !== null
      && !(Number.isInteger(body.expiresAt) && body.expiresAt >= 0 && body.expiresAt <= 4102444800000)) {
      return 'expiresAt must be null or an epoch-ms integer';
    }
    if (body.intervalSec !== undefined && !isIntIn(body.intervalSec, 5, 86400)) {
      return 'intervalSec must be an integer in [5, 86400]';
    }
    if (body.sortOrder !== undefined && !(Number.isInteger(body.sortOrder) && body.sortOrder >= 0)) {
      return 'sortOrder must be a non-negative integer';
    }
    return null;
  }

  const server = createServer(async (req, res) => {
    const ip = clientIp(req);
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (req.method === 'POST' && path === '/api/agent/report') {
        return await handleReport(req, res, ip);
      }
      if (req.method === 'POST' && path === '/api/login') {
        return await handleLogin(req, res, ip);
      }
      if (!path.startsWith('/api/')) {
        // Distributable install assets so the panel one-liner works out of the box.
        if (req.method === 'GET' && (path === '/install-agent.sh' || path === '/agent.sh')) {
          const scriptsDir = config.scriptsDir ?? join(webDir, '..', '..', 'scripts');
          const agentDir = config.agentDir ?? join(webDir, '..', '..', 'agent');
          const target = path === '/install-agent.sh'
            ? { dir: scriptsDir, file: '/install-agent.sh' }
            : { dir: agentDir, file: '/vpswatch-agent.sh' };
          if (serveStatic(target.dir, target.file, res)) return;
        }
        if (req.method === 'GET' && serveStatic(webDir, path, res)) return;
        if (req.method === 'GET') {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('not found');
        }
        return json(res, 405, { error: 'method not allowed' });
      }
      if (!isAuthed(req)) return json(res, 401, { error: 'unauthorized' });
      if (crossOriginMutation(req)) return json(res, 403, { error: 'cross-origin request blocked' });

      if (req.method === 'GET' && path === '/api/overview') {
        return json(res, 200, buildOverview());
      }
      if (req.method === 'GET' && path === '/api/stream') {
        return handleStream(req, res);
      }
      if (req.method === 'GET' && path === '/api/events') {
        const raw = Number(url.searchParams.get('limit'));
        const limit = Math.min(Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 100, 1000);
        const serverId = url.searchParams.get('server_id');
        return json(res, 200, store.listEvents({
          limit,
          serverId: serverId === null ? null : Number(serverId),
        }));
      }
      const historyMatch = path.match(/^\/api\/servers\/(\d+)\/history$/);
      if (req.method === 'GET' && historyMatch) {
        const range = url.searchParams.get('range') ?? '24h';
        const span = RANGES[range];
        if (!span) return json(res, 400, { error: 'range must be one of ' + Object.keys(RANGES).join('|') });
        const now = Date.now();
        return json(res, 200, {
          range,
          ...store.getHistory(Number(historyMatch[1]), now - span, now),
        });
      }
      if (req.method === 'POST' && path === '/api/logout') {
        const token = sessionTokenOf(req);
        if (token) store.deleteSession(token);
        res.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
        return json(res, 200, { ok: true });
      }

      if (path === '/api/admin/servers' && req.method === 'POST') {
        const { raw } = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw ?? '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
        const err = serverInputError(body);
        if (err) return json(res, 400, { error: err });
        const created = store.createServer(body);
        broadcast();
        return json(res, 200, created);
      }
      if (path === '/api/admin/servers' && req.method === 'GET') {
        return json(res, 200, store.listServers());
      }
      const idMatch = path.match(/^\/api\/admin\/servers\/(\d+)(\/reset-token)?$/);
      if (idMatch) {
        const id = Number(idMatch[1]);
        if (!store.getServer(id)) return json(res, 404, { error: 'no such server' });
        if (req.method === 'GET' && !idMatch[2]) {
          return json(res, 200, store.getServer(id));
        }
        if (req.method === 'POST' && idMatch[2]) {
          return json(res, 200, { id, token: store.resetToken(id) });
        }
        if (req.method === 'PATCH' && !idMatch[2]) {
          const { raw } = await readBody(req);
          let body = {};
          try { body = JSON.parse(raw ?? '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
          const err = serverInputError(body, { partial: true });
          if (err) return json(res, 400, { error: err });
          store.updateServer(id, body);
          broadcast();
          return json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE' && !idMatch[2]) {
          store.deleteServer(id);
          engine?.forget?.(id);
          broadcast();
          return json(res, 200, { ok: true });
        }
      }
      if (path === '/api/admin/settings') {
        if (req.method === 'GET') return json(res, 200, settingsView());
        if (req.method === 'PUT') {
          const { raw } = await readBody(req);
          let body = {};
          try { body = JSON.parse(raw ?? '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
          const err = settingsPatchError(body);
          if (err) return json(res, 400, { error: err });
          applySettings(body);
          return json(res, 200, settingsView());
        }
      }
      if (req.method === 'POST' && path === '/api/admin/password') {
        const { raw } = await readBody(req);
        let body = {};
        try { body = JSON.parse(raw ?? '{}'); } catch { return json(res, 400, { error: 'invalid json' }); }
        const pw = typeof body.password === 'string' ? body.password : '';
        if (pw.length < 8) return json(res, 400, { error: 'password must be at least 8 characters' });
        store.setAdminPasswordHash(await hashPassword(pw));
        // Rotating the password must evict every existing session cookie —
        // otherwise a stolen cookie survives the rotation for its full TTL.
        store.deleteAllSessions();
        res.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
        return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    } catch (err) {
      log.error(`[http] ${req.method} ${path}: ${err.stack ?? err}`);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    }
  });

  server.app = {
    buildOverview,
    broadcast,
    boot() {
      tickTimer = setInterval(() => {
        try {
          engine?.tick();
          broadcast();
        } catch (err) {
          log.error(`[tick] ${err.stack ?? err}`);
        }
        // bounded-memory sweep: stale rate buckets and empty fail lists
        const now = Date.now();
        for (const [ip, bucket] of agentBuckets) {
          if (now - bucket.last > 15 * 60_000) agentBuckets.delete(ip);
        }
        for (const [ip, fails] of loginFails) {
          const fresh = fails.filter((t) => now - t < LOGIN_WINDOW_MS);
          if (fresh.length === 0) loginFails.delete(ip);
          else loginFails.set(ip, fresh);
        }
      }, 30_000);
      tickTimer.unref?.();
      pruneTimer = setInterval(() => {
        try {
          const cutoff = Date.now() - effective.retentionDays * 24 * 3600 * 1000;
          const removed = store.pruneOlderThan(cutoff);
          const sessions = store.deleteExpiredSessions();
          const events = store.pruneResolvedEvents(cutoff);
          if (removed > 0 || sessions > 0 || events > 0) {
            log.info(`[prune] removed ${removed} metrics, ${sessions} sessions, ${events} resolved events`);
          }
        } catch (err) {
          log.error(`[prune] ${err.stack ?? err}`);
        }
      }, 6 * 3600 * 1000);
      pruneTimer.unref?.();
      try {
        engine?.tick();
      } catch (err) {
        log.error(`[tick] ${err.stack ?? err}`);
      }
    },
    close() {
      clearInterval(tickTimer);
      clearInterval(pruneTimer);
      clearTimeout(broadcastTimer);
      for (const hb of sseHeartbeats) clearInterval(hb);
      sseHeartbeats.clear();
      for (const res of sseClients) {
        try { res.end(); } catch { /* ignored */ }
      }
      sseClients.clear();
    },
  };
  const nativeClose = server.close.bind(server);
  server.close = (cb) => {
    server.app.close();
    // SSE keep-alive sockets would otherwise keep close() pending forever.
    server.closeAllConnections?.();
    return nativeClose(cb);
  };
  server.boot = server.app.boot;

  return server;
}
