import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.js';

const PASSWORD_CHARSET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

test('defaults: port 3577, host 0.0.0.0, retention 30d, cpu 90%, interval 10s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-cfg-'));
  const { config, generatedAdminPassword } = loadConfig({ argv: [], env: {}, cwd: dir });
  assert.equal(config.port, 3577);
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.retentionDays, 30);
  assert.equal(config.thresholds.cpu, 90);
  assert.equal(config.thresholds.mem, 90);
  assert.equal(config.thresholds.disk, 90);
  assert.equal(config.thresholds.consecutive, 3);
  assert.equal(config.thresholds.expiryDays, 7);
  assert.equal(config.intervalSec, 10);
  assert.equal(config.sessionTtlDays, 7);
  assert.equal(config.notifyCooldownMin, 10);
  assert.equal(config.webhookUrl, '');
  assert.equal(config.rate.agentPerSec, 30);
  assert.equal(config.rate.loginPer15Min, 5);
  assert.equal(config.dataDir, join(dir, 'data'));
  assert.equal(config.dbPath, join(dir, 'data', 'vpswatch.db'));
});

test('cli --port overrides default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-cfg-'));
  const { config } = loadConfig({ argv: ['--port', '8080'], env: {}, cwd: dir });
  assert.equal(config.port, 8080);
});

test('cli --key=value form works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-cfg-'));
  const { config } = loadConfig({ argv: ['--host=127.0.0.1'], env: {}, cwd: dir });
  assert.equal(config.host, '127.0.0.1');
});

test('env VPSWATCH_PORT is used when cli absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-cfg-'));
  const { config } = loadConfig({ argv: [], env: { VPSWATCH_PORT: '9000' }, cwd: dir });
  assert.equal(config.port, 9000);
});

test('config.json layer sits between env and default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-cfg-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ retentionDays: 60, thresholds: { cpu: 80 } }));
  const { config } = loadConfig({ argv: [], env: { VPSWATCH_THRESHOLDS: '{"cpu":70}' }, cwd: dir });
  assert.equal(config.retentionDays, 60);          // file beats default
  assert.equal(config.thresholds.cpu, 70);         // env beats file
  assert.equal(config.thresholds.mem, 90);         // untouched default survives deep merge
});

test('priority: cli > env > file > default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-cfg-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ port: 1111 }));
  const { config } = loadConfig({ argv: ['--port', '3333'], env: { VPSWATCH_PORT: '2222' }, cwd: dir });
  assert.equal(config.port, 3333);
  const { config: noCli } = loadConfig({ argv: [], env: { VPSWATCH_PORT: '2222' }, cwd: dir });
  assert.equal(noCli.port, 2222);
});

test('generated admin password: 16 chars, unambiguous charset, null when provided', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-cfg-'));
  const { config, generatedAdminPassword } = loadConfig({ argv: [], env: {}, cwd: dir });
  assert.equal(generatedAdminPassword.length, 16);
  for (const ch of generatedAdminPassword) {
    assert.ok(PASSWORD_CHARSET.includes(ch), `unexpected char ${ch}`);
  }
  assert.equal(config.adminPassword, generatedAdminPassword);

  const fixed = loadConfig({ argv: ['--admin-password', 'hunter2hunter2'], env: {}, cwd: dir });
  assert.equal(fixed.generatedAdminPassword, null);
  assert.equal(fixed.config.adminPassword, 'hunter2hunter2');
});

test('generated passwords differ between calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vw-cfg-'));
  const a = loadConfig({ argv: [], env: {}, cwd: dir });
  const b = loadConfig({ argv: [], env: {}, cwd: dir });
  assert.notEqual(a.generatedAdminPassword, b.generatedAdminPassword);
});
