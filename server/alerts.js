// Alert state machine. Persists event open/resolve through the store; the
// caller supplies onNotify — the engine itself never sends anything.
const DAY_MS = 24 * 3600 * 1000;

const LABELS = { cpu: 'CPU 使用率', mem: '内存使用率', disk: '磁盘使用率', offline: '离线', expiry: '到期' };

export class AlertEngine {
  constructor(store, { thresholds, notifyCooldownMin = 10, onNotify = () => {} } = {}) {
    this.store = store;
    this.thresholds = thresholds;
    this.cooldownMs = notifyCooldownMin * 60_000;
    this.onNotify = onNotify;
    this.states = new Map(); // serverId -> {lastSeen, intervalSec, cpuStreak, memStreak, lastNotifyAt}
  }

  state(serverId) {
    return this.states.get(serverId) ?? null;
  }

  #stateFor(serverId, intervalSec) {
    let st = this.states.get(serverId);
    if (!st) {
      st = { lastSeen: null, intervalSec, cpuStreak: 0, memStreak: 0, lastNotifyAt: {} };
      this.states.set(serverId, st);
    }
    return st;
  }

  ingest(serverRow, metric, nowMs = Date.now()) {
    const st = this.#stateFor(serverRow.id, serverRow.intervalSec);
    st.lastSeen = nowMs;
    st.intervalSec = serverRow.intervalSec ?? st.intervalSec;
    this.#resolve(serverRow.id, 'offline');

    this.#consecutiveRule(serverRow, st, 'cpu', metric.cpuPct ?? 0, nowMs);
    const memPct = metric.memTotal > 0 ? ((metric.memUsed ?? 0) / metric.memTotal) * 100 : 0;
    this.#consecutiveRule(serverRow, st, 'mem', memPct, nowMs);

    const diskPct = metric.diskTotal > 0 ? ((metric.diskUsed ?? 0) / metric.diskTotal) * 100 : 0;
    if (diskPct > this.thresholds.disk) {
      this.#open(serverRow, st, 'disk', 'critical',
        `${serverRow.name} ${LABELS.disk} ${diskPct.toFixed(1)}%(阈值 ${this.thresholds.disk}%)`, nowMs);
    } else {
      this.#resolve(serverRow.id, 'disk');
    }
  }

  #consecutiveRule(serverRow, st, type, pct, nowMs) {
    const threshold = this.thresholds[type];
    if (pct > threshold) {
      st[`${type}Streak`] += 1;
      if (st[`${type}Streak`] >= this.thresholds.consecutive) {
        this.#open(serverRow, st, type, 'critical',
          `${serverRow.name} ${LABELS[type]} ${pct.toFixed(1)}%(阈值 ${threshold}%,连续 ${this.thresholds.consecutive} 次)`,
          nowMs);
      }
    } else {
      st[`${type}Streak`] = 0;
      this.#resolve(serverRow.id, type, nowMs);
    }
  }

  tick(nowMs = Date.now()) {
    for (const server of this.store.listServers()) {
      const st = this.#stateFor(server.id, server.intervalSec);
      if (st.lastSeen !== null) {
        const windowMs = Math.max((st.intervalSec ?? 10) * 3 * 1000, 60_000);
        if (nowMs - st.lastSeen > windowMs) {
          this.#open(server, st, 'offline', 'critical',
            `${server.name} 已离线超过 ${Math.round(windowMs / 1000)} 秒`, nowMs);
        }
      }

      if (server.expiresAt != null) {
        const daysLeft = (server.expiresAt - nowMs) / DAY_MS;
        if (daysLeft <= this.thresholds.expiryDays) {
          const msg = daysLeft >= 0
            ? `${server.name} 将于 ${Math.max(1, Math.ceil(daysLeft))} 天后到期`
            : `${server.name} 已过期 ${Math.ceil(-daysLeft)} 天`;
          this.#open(server, st, 'expiry', 'warning', msg, nowMs, DAY_MS);
        } else {
          this.#resolve(server.id, "expiry", nowMs);
        }
      } else {
        this.#resolve(server.id, "expiry", nowMs);
      }
    }
  }

  #open(serverRow, st, type, level, message, nowMs, cooldownMs = this.cooldownMs) {
    const id = this.store.openEvent({ serverId: serverRow.id, type, level, message }, nowMs);
    const last = st.lastNotifyAt[type];
    if (last === undefined || nowMs - last >= cooldownMs) {
      st.lastNotifyAt[type] = nowMs;
      this.onNotify({ id, type, level, message, startedAt: nowMs }, serverRow);
    }
  }

  #resolve(serverId, type, nowMs = Date.now()) {
    this.store.resolveEvent(serverId, type, nowMs);
  }
}
