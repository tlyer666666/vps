#!/usr/bin/env node
// VPSWatch hub entry point: config -> store -> engine -> http.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, deepMerge } from './config.js';
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

const saved = store.getSetting('settings', {}) ?? {};
const thresholds = deepMerge(config.thresholds ?? {}, saved.thresholds ?? {});
const notifyCooldownMin = saved.notifyCooldownMin ?? config.notifyCooldownMin;

const notifier = createNotifier({ webhookUrl: () => store.getSetting('settings', {})?.webhookUrl ?? '' });

// Every alert channel fires in parallel; one dead channel or a failing
// settings read never crashes the hub (createDispatch catches everything).
const dispatch = createDispatch({ store, notifier, sendTelegram });

const engine = new AlertEngine(store, {
  thresholds,
  notifyCooldownMin,
  onNotify: dispatch,
});

const probeRunner = createProbeRunner(store, { onNotify: dispatch });

const app = createApp({ config, store, engine, probeRunner, log: console });
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
