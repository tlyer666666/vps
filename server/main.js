#!/usr/bin/env node
// VPSWatch hub entry point: config -> store -> engine -> http.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, resolveSettings } from './config.js';
import { openStore } from './store.js';
import { hashPassword } from './auth.js';
import { AlertEngine } from './alerts.js';
import { createNotifier, createDispatch } from './notify.js';
import { sendTelegram } from './telegram.js';
import { createProbeRunner, seedDefaultProbes } from './probes.js';
import { createApp } from './http.js';

const { config, generatedAdminPassword } = loadConfig();

mkdirSync(dirname(config.dbPath), { recursive: true });
const store = openStore(config.dbPath);

if (!store.getAdminPasswordHash()) {
  store.setAdminPasswordHash(await hashPassword(config.adminPassword));
  if (generatedAdminPassword) {
    console.log('首次启动:已生成管理员密码(仅显示一次,请立即保存):');
    console.log(`  ${generatedAdminPassword}`);
  }
}

// Once the password hash is safely stored in SQLite, scrub any plaintext
// VPSWATCH_ADMIN_PASSWORD line from hub.env if configured via VPSWATCH_ENV_FILE.
if (store.getAdminPasswordHash() && process.env.VPSWATCH_ENV_FILE) {
  try {
    const envPath = process.env.VPSWATCH_ENV_FILE;
    const raw = readFileSync(envPath, 'utf8');
    if (/^\s*VPSWATCH_ADMIN_PASSWORD=/m.test(raw)) {
      const cleaned = raw
        .split('\n')
        .filter((line) => !/^\s*VPSWATCH_ADMIN_PASSWORD=/.test(line))
        .join('\n');
      writeFileSync(envPath, cleaned, { mode: 0o600 });
    }
  } catch { /* read-only filesystem or non-writable env file is non-fatal */ }
}

const getSettings = () => resolveSettings(config, store.getSetting('settings', {}) ?? {});
const initialSettings = getSettings();
// Opt-in server-side env only (never exposed in settings API) for LAN/test targets.
const allowPrivateTargets = /^(1|true|yes)$/i.test(process.env.VPSWATCH_ALLOW_PRIVATE_TARGETS ?? '');

const notifier = createNotifier({
  webhookUrl: () => getSettings().webhookUrl,
  allowPrivateTargets,
});

// Every alert channel fires in parallel; one dead channel or a failing
// settings read never crashes the hub (createDispatch catches everything).
const dispatch = createDispatch({ store, config, getSettings, notifier, sendTelegram });

const engine = new AlertEngine(store, {
  thresholds: { ...initialSettings.thresholds },
  notifyCooldownMin: initialSettings.notifyCooldownMin,
  onNotify: dispatch,
});

const probeRunner = createProbeRunner(store, { onNotify: dispatch, allowPrivateTargets });

const app = createApp({ config, store, engine, notifier, probeRunner, allowPrivateTargets, log: console });
app.boot();
seedDefaultProbes(store); // first boot: built-in dial-test presets
probeRunner.start();
app.listen(config.port, config.host, () => {
  console.log(`VPSWatch hub 已启动: http://${config.host}:${config.port} (数据: ${config.dbPath})`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal},正在关闭...`);
  probeRunner.stop();
  app.close(() => {
    try { store.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
// Last-resort guard: a stray rejection must log, never kill a months-long
// monitoring process (sendTelegram/notifier already catch internally).
process.on('unhandledRejection', (reason) => {
  console.error(`[fatal-guard] unhandled rejection: ${reason?.stack ?? reason}`);
});
