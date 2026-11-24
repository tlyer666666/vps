// HTTP server: routes, sessions, SSE, rate limits, static files.
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReport, normalize } from './ingest.js';
import { verifyPassword, verifyAgentToken, hashPassword } from './auth.js';
import { createNotifier } from './notify.js';
import { sendTelegram } from './telegram.js';
import { serveStatic, SECURITY_HEADERS } from './static.js';
import { deepMerge, resolveSettings } from './config.js';
import { assertSafeUrl, assertSafeTcpTarget, parseTcpTarget } from './net-guard.js';

const COOKIE_NAME = 'vw_session';
const MASKED_SECRET = '••••••••';
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{20,}$/;
const ALLOWED_SETTINGS_KEYS = new Set([
  'webhookUrl',
  'thresholds',
  'notifyCooldownMin',
  'retentionDays',
  'public_status',
  'telegram_bot_token',
  'telegram_chat_id',
]);
const ALLOWED_THRESHOLD_KEYS = new Set(['cpu', 'mem', 'disk', 'consecutive', 'expiryDays']);
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
    ...SECURITY_HEADERS,
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

export function createApp({
  config,
  store,
  engine = null,
  notifier = null,
  probeRunner = null,
  sendTelegramImpl = sendTelegram,
  log = console,
  lookupImpl = undefined,
  allowPrivateTargets = false,
}) {
  const webDir = config.webDir ?? join(dirname(fileURLToPath(import.meta.url)), 'web');
  const guardOpts = { allowPrivate: Boolean(allowPrivateTargets), ignoreDnsFailure: true, ...(lookupImpl ? { lookupImpl } : {}) };

  // Effective settings = shipped defaults, overlaid with config and persisted admin changes.
  let effective = resolveSettings(config, store.getSetting('settings', {}) ?? {});
  if (engine) {
    engine.thresholds = { ...effective.thresholds };
    engine.cooldownMs = effective.notifyCooldownMin * 60_000;
  }

  const notify = notifier ?? createNotifier({
    webhookUrl: () => effective.webhookUrl,
    allowPrivateTargets: Boolean(allowPrivateTargets),
    ...(lookupImpl ? { lookupImpl } : {}),
  });

  async function readJsonBody(req, res, { defaultEmpty = true } = {}) {
    const { over, raw } = await readBody(req);
    if (over) {
      json(res, 413, { error: 'body too large' });
      return { ok: false };
    }
    try {
      const text = defaultEmpty ? (raw || '{}') : raw;
      return { ok: true, body: JSON.parse(text) };
    } catch {
      json(res, 400, { error: 'invalid json' });
      return { ok: false };
    }
  }

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
  const publicBuckets = new Map(); // anonymous status page, separate bucket
  const loginFails = new Map(); // ip -> [ms]
  const publicCache = { payload: null, at: 0 };
  const sseClients = new Set(); // res objects
  const sseHeartbeats = new Set(); // per-client heartbeat timers
  let broadcastTimer = null;
  let broadcastQueued = false;
  let tickTimer = null;
  let pruneTimer = null;

  // 24h uptime percentages, refreshed at most once a minute (single aggregate
  // query) — buildOverview runs on every broadcast frame and must stay cheap.
  const uptimeCache = new Map();
  let uptimeRefreshedAt = 0;
  function refreshUptime(force = false) {
    const now = Date.now();
    if (!force && now - uptimeRefreshedAt < 60_000) return;
    uptimeRefreshedAt = now;
    uptimeCache.clear();
    for (const [serverId, pct] of store.getUptimeAll(now - 24 * 3600 * 1000, now)) {
      uptimeCache.set(serverId, pct);
    }
  }

  function buildOverview(now = Date.now()) {
    refreshUptime();
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
      return { ...s, online, lastSeen: m ? m.ts : null, metric, uptimePct24h: uptimeCache.get(s.id) ?? 0 };
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
    return consumeBucket(agentBuckets, ip, config.rate?.agentPerSec ?? 30);
  }

  // The public status page is anonymous — keep its bucket separate from agent
  // traffic so a crawler can never throttle real reports (and vice versa).
  function consumePublicRate(ip) {
    return consumeBucket(publicBuckets, ip, 5);
  }

  function consumeBucket(map, ip, rate) {
    const now = Date.now();
    const bucket = map.get(ip) ?? { tokens: rate, last: now };
    bucket.tokens = Math.min(rate, bucket.tokens + ((now - bucket.last) / 1000) * rate);
    bucket.last = now;
    if (bucket.tokens < 1) {
      map.set(ip, bucket);
      return false;
    }
    bucket.tokens -= 1;
    map.set(ip, bucket);
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
    const parsed = await readJsonBody(req, res);
    if (!parsed.ok) return;
    const body = parsed.body ?? {};
    const stored = store.getAdminPasswordHash();
    const ok = stored !== null && (await verifyPassword(String(body.password ?? ''), stored));
    if (!ok) {
      recordLoginFail(ip);
      return json(res, 401, { error: 'unauthorized' });
    }
    loginFails.delete(ip);
    const ttlMs = (config.sessionTtlDays ?? 7) * 24 * 3600 * 1000;
    const token = store.createSession(ttlMs);
    const xfp = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase();
    const isHttps = req.socket.encrypted === true || (config.trustProxy === true && xfp === 'https');
    res.setHeader('set-cookie',
      `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}${isHttps ? '; Secure' : ''}`);
    return json(res, 200, { ok: true });
  }

  async function handleReport(req, res, ip) {
    if (!consumeAgentRate(ip)) return json(res, 429, { error: 'rate limited' });
    const server = verifyAgentToken(store, bearerOf(req));
    if (!server) return json(res, 401, { error: 'unauthorized' });

    const parsed = await readJsonBody(req, res, { defaultEmpty: false });
    if (!parsed.ok) return;
    const body = parsed.body;

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
      engine?.checkQuota?.(server, metric, now);
    } catch (err) {
      log.warn(`[ingest] alert engine failed for server ${server.id}: ${err.message}`);
    }
    broadcast();
    return json(res, 200, persisted ? { ok: true } : { ok: true, persisted: false });
  }

  function handleStream(req, res) {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
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
    const hasToken = Boolean(effective.telegram_bot_token);
    return {
      webhookUrl: effective.webhookUrl,
      thresholds: { ...effective.thresholds },
      notifyCooldownMin: effective.notifyCooldownMin,
      retentionDays: effective.retentionDays,
      public_status: effective.public_status === true,
      telegram_bot_token: hasToken ? MASKED_SECRET : '',
      has_telegram_bot_token: hasToken,
      telegram_chat_id: effective.telegram_chat_id ?? '',
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

  // Returns { error } or { patch } with only whitelisted keys.
  async function validateSettingsPatch(rawPatch) {
    if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
      return { error: 'body must be an object' };
    }
    const clean = {};
    for (const key of Object.keys(rawPatch)) {
      if (!ALLOWED_SETTINGS_KEYS.has(key)) {
        return { error: `unknown setting key: ${key}` };
      }
    }
    if (rawPatch.thresholds !== undefined) {
      const t = rawPatch.thresholds;
      if (t === null || typeof t !== 'object' || Array.isArray(t)) return { error: 'thresholds must be an object' };
      const cleanT = {};
      for (const tk of Object.keys(t)) {
        if (!ALLOWED_THRESHOLD_KEYS.has(tk)) return { error: `unknown thresholds key: ${tk}` };
      }
      for (const k of ['cpu', 'mem', 'disk']) {
        if (t[k] !== undefined) {
          if (!(typeof t[k] === 'number' && Number.isFinite(t[k]) && t[k] >= 1 && t[k] <= 100)) {
            return { error: `thresholds.${k} must be a number in [1, 100]` };
          }
          cleanT[k] = t[k];
        }
      }
      if (t.consecutive !== undefined) {
        if (!isIntIn(t.consecutive, 1, 60)) return { error: 'thresholds.consecutive must be an integer in [1, 60]' };
        cleanT.consecutive = t.consecutive;
      }
      if (t.expiryDays !== undefined) {
        if (!isIntIn(t.expiryDays, 0, 3650)) return { error: 'thresholds.expiryDays must be an integer in [0, 3650]' };
        cleanT.expiryDays = t.expiryDays;
      }
      clean.thresholds = cleanT;
    }
    if (rawPatch.notifyCooldownMin !== undefined) {
      if (!isIntIn(rawPatch.notifyCooldownMin, 1, 1440)) {
        return { error: 'notifyCooldownMin must be an integer in [1, 1440]' };
      }
      clean.notifyCooldownMin = rawPatch.notifyCooldownMin;
    }
    if (rawPatch.retentionDays !== undefined) {
      if (!isIntIn(rawPatch.retentionDays, 1, 3650)) {
        return { error: 'retentionDays must be an integer in [1, 3650]' };
      }
      clean.retentionDays = rawPatch.retentionDays;
    }
    if (rawPatch.webhookUrl !== undefined) {
      const u = rawPatch.webhookUrl;
      if (u !== '') {
        if (typeof u !== 'string' || u.length > 500 || !/^https?:\/\/.+/i.test(u)) {
          return { error: 'webhookUrl must be empty or an http(s) URL' };
        }
        try {
          await assertSafeUrl(u, guardOpts);
        } catch (err) {
          return { error: `webhookUrl rejected: ${err.message}` };
        }
      }
      clean.webhookUrl = u;
    }
    if (rawPatch.public_status !== undefined) {
      if (typeof rawPatch.public_status !== 'boolean') return { error: 'public_status must be a boolean' };
      clean.public_status = rawPatch.public_status;
    }
    if (rawPatch.telegram_bot_token !== undefined) {
      const t = rawPatch.telegram_bot_token;
      if (typeof t !== 'string') return { error: 'telegram_bot_token must be a string' };
      // Preserve existing token if the client echoes back the masked placeholder.
      if (t !== MASKED_SECRET) {
        if (t !== '' && (t.length > 200 || !TELEGRAM_TOKEN_RE.test(t))) {
          return { error: 'telegram_bot_token must match <digits>:<token>' };
        }
        clean.telegram_bot_token = t;
      }
    }
    if (rawPatch.telegram_chat_id !== undefined) {
      const c = rawPatch.telegram_chat_id;
      if (c !== '' && (typeof c !== 'string' || c.length > 64)) {
        return { error: 'telegram_chat_id must be a string of at most 64 characters' };
      }
      clean.telegram_chat_id = c;
    }
    return { patch: clean };
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
    if (body.groupName !== undefined && (typeof body.groupName !== 'string' || body.groupName.length > 64)) {
      return 'groupName must be a string of at most 64 characters';
    }
    if (body.monthlyQuotaBytes !== undefined && body.monthlyQuotaBytes !== null
      && !(Number.isInteger(body.monthlyQuotaBytes) && body.monthlyQuotaBytes >= 0 && body.monthlyQuotaBytes <= 1e18)) {
      return 'monthlyQuotaBytes must be null or an integer in [0, 1e18]';
    }
    return null;
  }

  // Dial-test probe fields (v1.1). When `existing` is provided (PATCH), merges
  // existing `type`/`target` so partial updates validate consistently.
  async function probeInputError(body, { partial = false, existing = null } = {}) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be an object';
    if (!partial || body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.trim().length > 100) {
        return 'name must be a string of 1..100 characters';
      }
    }
    const effectiveType = body.type !== undefined ? body.type : existing?.type;
    const effectiveTarget = body.target !== undefined ? body.target : existing?.target;
    if (!partial || body.type !== undefined) {
      if (effectiveType !== 'http' && effectiveType !== 'tcp') return "type must be 'http' or 'tcp'";
    }
    if (!partial || body.type !== undefined || body.target !== undefined) {
      const t = effectiveTarget;
      if (effectiveType === 'http') {
        if (typeof t !== 'string' || t.length > 300 || !/^https?:\/\/.+/i.test(t)) {
          return 'target must be an http(s) URL for http probes';
        }
        try {
          await assertSafeUrl(t, guardOpts);
        } catch (err) {
          return `target rejected: ${err.message}`;
        }
      } else {
        if (typeof t !== 'string' || t.length > 300 || !parseTcpTarget(t)) {
          return 'target must be host:port for tcp probes';
        }
        try {
          await assertSafeTcpTarget(t, guardOpts);
        } catch (err) {
          return `target rejected: ${err.message}`;
        }
      }
    }
    if (body.intervalSec !== undefined && !isIntIn(body.intervalSec, 10, 3600)) {
      return 'intervalSec must be an integer in [10, 3600]';
    }
    if (body.timeoutSec !== undefined && !isIntIn(body.timeoutSec, 1, 30)) {
      return 'timeoutSec must be an integer in [1, 30]';
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      return 'enabled must be a boolean';
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
      if (req.method === 'GET' && path === '/api/public/overview') {
        // Public status page: opt-in, anonymous, sanitized. Anonymous means
        // it must never do per-request heavy work — rate limited and served
        // from a 45s cache. Raw probe targets and internal errors are omitted.
        if (effective.public_status !== true) return json(res, 404, { error: 'not found' });
        if (!consumePublicRate(ip)) return json(res, 429, { error: 'rate limited' });
        const now = Date.now();
        if (!publicCache.payload || now - publicCache.at > 45_000) {
          refreshUptime(true);
          const latest = store.latestCached();
          const servers = store.listServers().map((s) => {
            const m = latest.get(s.id) ?? null;
            const intervalSec = s.intervalSec ?? config.intervalSec ?? 10;
            const windowMs = Math.max(intervalSec * 3 * 1000, 60_000);
            return {
              id: s.id,
              name: s.name,
              tag: s.tag,
              groupName: s.groupName,
              online: m !== null && now - m.ts <= windowMs,
              uptimePct24h: uptimeCache.get(s.id) ?? 0,
            };
          });
          const latestProbes = store.latestProbeResults();
          const now24 = now - 24 * 3600 * 1000;
          const probes = store.listProbes().map((p) => {
            const l = latestProbes.get(p.id) ?? null;
            const history = store.getProbeHistory(p.id, now24, now, 100);
            return {
              id: p.id, name: p.name, type: p.type,
              ok: l ? l.ok === 1 : null,
              latencyMs: l ? l.latencyMs : null,
              ts: l ? l.ts : null,
              history24h: history.points.map((pt) => ({ ts: pt.ts, latencyMs: pt.latencyMs ?? null })),
            };
          });
          publicCache.payload = { servers, probes };
          publicCache.at = now;
        }
        return json(res, 200, publicCache.payload);
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
          res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
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
        const subjectType = url.searchParams.get('subject_type');
        return json(res, 200, store.listEvents({
          limit,
          serverId: serverId === null ? null : Number(serverId),
          subjectType: subjectType === 'server' || subjectType === 'probe' ? subjectType : null,
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
        const parsed = await readJsonBody(req, res);
        if (!parsed.ok) return;
        const body = parsed.body;
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
          const parsed = await readJsonBody(req, res);
          if (!parsed.ok) return;
          const body = parsed.body;
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
          const parsed = await readJsonBody(req, res);
          if (!parsed.ok) return;
          const validated = await validateSettingsPatch(parsed.body);
          if (validated.error) return json(res, 400, { error: validated.error });
          applySettings(validated.patch);
          publicCache.payload = null; // settings changes invalidate the cached page
          return json(res, 200, settingsView());
        }
      }
      if (req.method === 'POST' && path === '/api/admin/password') {
        const parsed = await readJsonBody(req, res);
        if (!parsed.ok) return;
        const body = parsed.body ?? {};
        const current = typeof body.currentPassword === 'string' ? body.currentPassword : '';
        const stored = store.getAdminPasswordHash();
        if (!current || !stored || !(await verifyPassword(current, stored))) {
          return json(res, 403, { error: 'current password is incorrect' });
        }
        const pw = typeof body.password === 'string' ? body.password : '';
        if (pw.length < 8) return json(res, 400, { error: 'password must be at least 8 characters' });
        store.setAdminPasswordHash(await hashPassword(pw));
        // Rotating the password must evict every existing session cookie —
        // otherwise a stolen cookie survives the rotation for its full TTL.
        store.deleteAllSessions();
        res.setHeader('set-cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
        return json(res, 200, { ok: true });
      }

      if (req.method === 'POST' && path === '/api/admin/notify-test') {
        const event = { id: null, type: 'test', level: 'info', message: 'VPSWatch 通知测试', startedAt: Date.now() };
        const webhook = effective.webhookUrl ? await notify(event, { name: 'VPSWatch' }) : null;
        const telegram = (effective.telegram_bot_token && effective.telegram_chat_id)
          ? await sendTelegramImpl({
            botToken: effective.telegram_bot_token,
            chatId: effective.telegram_chat_id,
            text: `[VPSWatch] ${event.message}`,
          })
          : null;
        return json(res, 200, { webhook, telegram });
      }

      if (path === '/api/admin/probes' && req.method === 'GET') {
        const latest = store.latestProbeResults();
        return json(res, 200, store.listProbes().map((p) => ({ ...p, latest: latest.get(p.id) ?? null })));
      }
      if (path === '/api/admin/probes' && req.method === 'POST') {
        const parsed = await readJsonBody(req, res);
        if (!parsed.ok) return;
        const body = parsed.body;
        const err = await probeInputError(body);
        if (err) return json(res, 400, { error: err });
        const probe = store.createProbe(body);
        broadcast();
        return json(res, 200, probe);
      }
      const probeMatch = path.match(/^\/api\/admin\/probes\/(\d+)$/);
      if (probeMatch) {
        const pid = Number(probeMatch[1]);
        const existingProbe = store.getProbe(pid);
        if (!existingProbe) return json(res, 404, { error: 'no such probe' });
        if (req.method === 'PATCH') {
          const parsed = await readJsonBody(req, res);
          if (!parsed.ok) return;
          const body = parsed.body;
          const err = await probeInputError(body, { partial: true, existing: existingProbe });
          if (err) return json(res, 400, { error: err });
          if (typeof body.enabled === 'boolean') body.enabled = body.enabled ? 1 : 0;
          store.updateProbe(pid, body);
          broadcast();
          return json(res, 200, { ok: true });
        }
        if (req.method === 'DELETE') {
          store.deleteProbe(pid);
          probeRunner?.forget?.(pid);
          broadcast();
          return json(res, 200, { ok: true });
        }
      }
      const probeHistoryMatch = path.match(/^\/api\/probes\/(\d+)\/history$/);
      if (req.method === 'GET' && probeHistoryMatch) {
        const pid = Number(probeHistoryMatch[1]);
        if (!store.getProbe(pid)) return json(res, 404, { error: 'no such probe' });
        const range = url.searchParams.get('range') ?? '24h';
        const span = RANGES[range];
        if (!span) return json(res, 400, { error: 'range must be one of ' + Object.keys(RANGES).join('|') });
        const now = Date.now();
        return json(res, 200, { range, ...store.getProbeHistory(pid, now - span, now) });
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
        for (const [ip, bucket] of publicBuckets) {
          if (now - bucket.last > 15 * 60_000) publicBuckets.delete(ip);
        }
      }, 30_000);
      tickTimer.unref?.();
      pruneTimer = setInterval(() => {
        try {
          const cutoff = Date.now() - effective.retentionDays * 24 * 3600 * 1000;
          const removed = store.pruneOlderThan(cutoff);
          const sessions = store.deleteExpiredSessions();
          const events = store.pruneResolvedEvents(cutoff);
          const probeResults = store.pruneProbeResults(cutoff);
          if (removed > 0 || sessions > 0 || events > 0 || probeResults > 0) {
            log.info(`[prune] removed ${removed} metrics, ${sessions} sessions, ${events} events, ${probeResults} probe results`);
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
