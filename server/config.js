// Layered configuration: defaults <- config.json <- VPSWATCH_* env <- CLI args.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

// No 0/O/1/l/I — passwords get read off a terminal and typed into other hosts.
const PASSWORD_CHARSET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

const DEFAULTS = {
  host: '0.0.0.0',
  port: 3577,
  dataDir: null, // resolved against cwd below
  dbPath: null,  // resolved to <dataDir>/vpswatch.db unless set
  retentionDays: 30,
  sessionTtlDays: 7,
  intervalSec: 10,
  webhookUrl: '',
  notifyCooldownMin: 10,
  adminPassword: null,
  trustProxy: false, // take client IP from the last X-Forwarded-For hop (set when behind a reverse proxy)
  thresholds: { cpu: 90, mem: 90, disk: 90, consecutive: 3, expiryDays: 7 },
  rate: { agentPerSec: 30, loginPer15Min: 5 },
};

export const CONFIG_DEFAULTS = DEFAULTS;

const CLI_KEYS = new Map([
  ['port', 'port'],
  ['host', 'host'],
  ['db-path', 'dbPath'],
  ['data-dir', 'dataDir'],
  ['retention-days', 'retentionDays'],
  ['session-ttl-days', 'sessionTtlDays'],
  ['webhook-url', 'webhookUrl'],
  ['notify-cooldown-min', 'notifyCooldownMin'],
  ['admin-password', 'adminPassword'],
  ['trust-proxy', 'trustProxy'],
  ['interval', 'intervalSec'],
]);

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    let key = arg.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      value = argv[++i];
    } else {
      value = true;
    }
    if (CLI_KEYS.has(key)) out[CLI_KEYS.get(key)] = value;
  }
  return out;
}

function coerceNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : v;
}

function envLayer(env) {
  const out = {};
  for (const [rawKey, rawVal] of Object.entries(env)) {
    if (!rawKey.startsWith('VPSWATCH_')) continue;
    const key = rawKey.slice('VPSWATCH_'.length)
      .toLowerCase()
      .replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    let val = rawVal;
    if (typeof val === 'string') {
      try { val = JSON.parse(val); } catch { /* plain string */ }
    }
    out[key] = val;
  }
  // Non-object scalar fields that arrive as strings from env need coercion.
  for (const k of ['port', 'retentionDays', 'sessionTtlDays', 'intervalSec', 'notifyCooldownMin']) {
    if (k in out) out[k] = coerceNum(out[k]);
  }
  return out;
}

function argLayer(args) {
  const out = { ...args };
  for (const k of ['port', 'retentionDays', 'sessionTtlDays', 'intervalSec', 'notifyCooldownMin']) {
    if (k in out) out[k] = coerceNum(out[k]);
  }
  if (typeof out.trustProxy === 'string') {
    out.trustProxy = out.trustProxy === 'true' || out.trustProxy === '1';
  }
  return out;
}

function generatePassword(len = 16) {
  const bytes = randomBytes(len * 2);
  let pw = '';
  for (let i = 0; pw.length < len && i < bytes.length * 4; i++) {
    const b = i < bytes.length ? bytes[i] : randomBytes(1)[0];
    if (b >= 256 - (256 % PASSWORD_CHARSET.length)) continue; // rejection sampling, no modulo bias
    pw += PASSWORD_CHARSET[b % PASSWORD_CHARSET.length];
  }
  return pw;
}

export function loadConfig({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd() } = {}) {
  let fileLayer = {};
  try {
    fileLayer = JSON.parse(readFileSync(join(cwd, 'config.json'), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error(`config.json is not valid JSON: ${err.message}`);
    }
  }

  const args = argLayer(parseArgs(argv));
  const merged = deepMerge(deepMerge(deepMerge(DEFAULTS, fileLayer), envLayer(env)), args);

  const config = { ...merged };
  config.dataDir = config.dataDir ?? join(cwd, 'data');
  config.dbPath = config.dbPath ?? join(config.dataDir, 'vpswatch.db');

  let generatedAdminPassword = null;
  if (!config.adminPassword) {
    generatedAdminPassword = generatePassword();
    config.adminPassword = generatedAdminPassword;
  }

  return { config, generatedAdminPassword };
}
