// Dial-test (probe) runner: hub-side periodic HTTP/TCP checks with latency
// history and failure alerting. Kept dependency-free by design.
import net from 'node:net';

const FAIL_THRESHOLD = 3;
const NOTIFY_COOLDOWN_MS = 10 * 60_000;
const TICK_MS = 5000;

// Built-in dial-test presets, seeded once on a fresh install and offered as
// one-click additions in the admin UI. Targets are public anycast endpoints.
export const DEFAULT_PROBES = [
  { name: 'Cloudflare', type: 'http', target: 'https://cp.cloudflare.com/generate_204', intervalSec: 60, timeoutSec: 5 },
  { name: 'Google 204', type: 'http', target: 'https://www.gstatic.com/generate_204', intervalSec: 60, timeoutSec: 5 },
  { name: '阿里 DNS', type: 'tcp', target: '223.5.5.5:53', intervalSec: 60, timeoutSec: 5 },
  { name: 'GitHub API', type: 'http', target: 'https://api.github.com/', intervalSec: 60, timeoutSec: 5 },
];

// Seed the built-in presets exactly once per installation: only when no
// previous seed ran AND the probes table is empty, and never re-adding a
// preset the user deliberately deleted.
export function seedDefaultProbes(store) {
  if (store.getSetting('probes_seeded', false)) return 0;
  const existing = new Set(store.listProbes().map((p) => p.target));
  let added = 0;
  for (const preset of DEFAULT_PROBES) {
    if (existing.has(preset.target)) continue;
    store.createProbe({ ...preset, enabled: 1 });
    added += 1;
  }
  store.setSetting('probes_seeded', true);
  return added;
}

function httpProbe(target, timeoutSec, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);
  const started = Date.now();
  return fetchImpl(target, { signal: controller.signal, redirect: 'follow' })
    .then((res) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      // Any non-2xx/3xx code is a failure (5xx, 4xx, weird codes).
      return res.status < 400
        ? { ok: true, latencyMs }
        : { ok: false, latencyMs, error: `HTTP ${res.status}` };
    })
    .catch((err) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - started;
      const reason = err?.name === 'AbortError' ? 'timeout' : (err?.message ?? 'error');
      return { ok: false, latencyMs, error: reason };
    });
}

function tcpProbe(target, timeoutSec) {
  const sep = target.lastIndexOf(':');
  if (sep <= 0 || sep === target.length - 1) {
    return Promise.resolve({ ok: false, error: 'target must be host:port' });
  }
  const host = target.slice(0, sep);
  const port = Number(target.slice(sep + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return Promise.resolve({ ok: false, error: 'invalid port' });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (result) => {
      const latencyMs = Date.now() - started;
      socket.destroy();
      resolve({ latencyMs, ...result });
    };
    socket.setTimeout(timeoutSec * 1000, () => done({ ok: false, error: 'timeout' }));
    socket.once('connect', () => done({ ok: true }));
    socket.once('error', (err) => done({ ok: false, error: err.code ?? err.message }));
  });
}

export function createProbeRunner(store, { onNotify = () => {}, log = console, fetchImpl = fetch } = {}) {
  // probeId -> { lastRunAt, failStreak, lastNotifyAt }
  const memory = new Map();
  let timer = null;
  let running = false;

  async function runDue(nowMs = Date.now()) {
    if (running) return; // a slow probe batch must not stack up
    running = true;
    try {
      for (const probe of store.listProbes()) {
        if (!probe.enabled) continue;
        const st = memory.get(probe.id) ?? { lastRunAt: 0, failStreak: 0, lastNotifyAt: {} };
        if (nowMs - st.lastRunAt < probe.intervalSec * 1000) continue;
        st.lastRunAt = nowMs;
        memory.set(probe.id, st);

        const result = probe.type === 'tcp'
          ? await tcpProbe(probe.target, probe.timeoutSec)
          : await httpProbe(probe.target, probe.timeoutSec, fetchImpl);
        store.insertProbeResult(probe.id, { ts: nowMs, ...result });

        if (result.ok) {
          st.failStreak = 0;
          store.resolveEvent(probe.id, 'probe', nowMs);
        } else {
          st.failStreak += 1;
          if (st.failStreak >= FAIL_THRESHOLD) {
            const event = store.openEvent({
              serverId: probe.id, // subject id space: probes live beside servers
              type: 'probe',
              level: 'critical',
              message: `拨测 ${probe.name} 连续 ${st.failStreak} 次失败:${result.error ?? '失败'}`,
            }, nowMs);
            if (event.existed) {
              if (st.lastNotifyAt.probe === undefined) {
                st.lastNotifyAt.probe = event.startedAt; // restart-safe suppression
              }
            } else if (st.lastNotifyAt.probe === undefined || nowMs - st.lastNotifyAt.probe >= NOTIFY_COOLDOWN_MS) {
              st.lastNotifyAt.probe = nowMs;
              onNotify({ id: event.id, type: 'probe', level: 'critical', message: `拨测 ${probe.name} 失败:${result.error ?? ''}`, startedAt: nowMs }, probe);
            }
          }
        }
      }
    } catch (err) {
      log.error(`[probes] ${err.stack ?? err}`);
    } finally {
      running = false;
    }
  }

  return {
    start() {
      timer = setInterval(() => { runDue().catch(() => {}); }, TICK_MS);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
    },
    runDue,
    forget(probeId) {
      memory.delete(probeId);
    },
    stateOf(probeId) {
      return memory.get(probeId);
    },
  };
}
