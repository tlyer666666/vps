import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReport } from '../server/ingest.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_PATH = join(REPO_ROOT, 'agent', 'vpswatch-agent.sh');

function makeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'vw-agent-node-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const proc = join(dir, 'proc');
  mkdirSync(join(proc, 'net'), { recursive: true });
  mkdirSync(join(proc, '1'), { recursive: true });
  writeFileSync(join(proc, 'stat'), 'cpu  100 0 100 700 0 0 0 0 0 0\n');
  writeFileSync(
    join(proc, 'meminfo'),
    'MemTotal: 4000000 kB\nMemAvailable: 1000000 kB\nSwapTotal: 2000000 kB\nSwapFree: 1500000 kB\n',
  );
  writeFileSync(join(proc, 'uptime'), '12345.67 49000.00\n');
  writeFileSync(join(proc, 'loadavg'), '0.15 0.25 0.35 1/100 1234\n');
  writeFileSync(
    join(proc, 'net', 'dev'),
    'Inter-|\n face |bytes\n  eth0: 5000 40 0 0 0 0 0 0 3000 30 0 0 0 0 0 0\n',
  );
  writeFileSync(join(proc, 'net', 'tcp'), '');
  writeFileSync(join(proc, 'net', 'tcp6'), '');

  const fakeDf = join(dir, 'fake-df');
  writeFileSync(
    fakeDf,
    '#!/usr/bin/env bash\necho "Filesystem 1024-blocks Used Available Capacity Mounted on"\necho "/dev/vda1 40960000 10240000 30720000 25% /"\n',
  );
  chmodSync(fakeDf, 0o755);

  const fakeHost = join(dir, 'fake-host');
  writeFileSync(fakeHost, '#!/usr/bin/env bash\necho web-agent-1\n');
  chmodSync(fakeHost, 0o755);

  return { dir, proc, fakeDf, fakeHost };
}

test('agent emits top-level load object, valid cores >= 1, and passes ingest validation', (t) => {
  const { dir, proc, fakeDf, fakeHost } = makeFixture(t);
  const env = {
    ...process.env,
    PROC: proc,
    STATE_FILE: join(dir, 'state'),
    DF_CMD: fakeDf,
    HOSTNAME_CMD: fakeHost,
  };
  delete env.CORES_CMD;
  delete env.SERVER_URL;
  delete env.TOKEN;

  const raw = execFileSync('bash', [AGENT_PATH, '--print-payload'], { env, encoding: 'utf8' });
  const payload = JSON.parse(raw);

  assert.deepEqual(payload.load, { load1: 0.15, load5: 0.25, load15: 0.35 });
  assert.equal(payload.cpu.load1, undefined, 'load must be top-level, not nested under cpu');
  assert.ok(Number.isInteger(payload.cpu.cores) && payload.cpu.cores >= 1, `expected cores >= 1, got ${payload.cpu.cores}`);

  const validated = validateReport(payload);
  assert.equal(validated.ok, true, `ingest rejected agent payload: ${validated.error}`);
  assert.equal(validated.value.load1, 0.15);
  assert.equal(validated.value.load5, 0.25);
  assert.equal(validated.value.load15, 0.35);
  assert.equal(validated.value.cores, payload.cpu.cores);
});

test('agent clamps invalid or zero CORES_CMD output to cores >= 1', (t) => {
  const { dir, proc, fakeDf, fakeHost } = makeFixture(t);
  for (const badOut of ['0', 'not-a-number', '']) {
    const fakeCores = join(dir, `cores-${badOut || 'empty'}`);
    writeFileSync(fakeCores, `#!/usr/bin/env bash\necho "${badOut}"\n`);
    chmodSync(fakeCores, 0o755);
    const raw = execFileSync('bash', [AGENT_PATH, '--print-payload'], {
      env: {
        ...process.env,
        PROC: proc,
        STATE_FILE: join(dir, `state-${badOut || 'empty'}`),
        DF_CMD: fakeDf,
        HOSTNAME_CMD: fakeHost,
        CORES_CMD: fakeCores,
      },
      encoding: 'utf8',
    });
    const payload = JSON.parse(raw);
    assert.equal(payload.cpu.cores, 1, `bad cores output "${badOut}" must clamp to 1`);
    assert.equal(validateReport(payload).ok, true);
  }
});
