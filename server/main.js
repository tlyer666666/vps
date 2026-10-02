#!/usr/bin/env node
// VPSWatch hub entry point: config -> store -> engine -> http.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, deepMerge } from './config.js';
import { openStore } from './store.js';
import { hashPassword } from './auth.js';
import { AlertEngine } from './alerts.js';
import { createNotifier } from './notify.js';
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
const engine = new AlertEngine(store, {
  thresholds,
  notifyCooldownMin,
  onNotify: (event, server) => notifier(event, server),
});

const app = createApp({ config, store, engine, log: console });
app.boot();
app.listen(config.port, config.host, () => {
  console.log(`VPSWatch hub 已启动: http://${config.host}:${config.port} (数据: ${config.dbPath})`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal},正在关闭...`);
  app.close(() => {
    try { store.close(); } catch { /* already closed */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
