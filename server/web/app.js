// VPSWatch dashboard SPA. Pure render helpers are exported for node --test;
// everything DOM lives inside the `typeof document` guard below.
import {
  fmtBytes, fmtBytesPerSec, fmtUptime, fmtCountdown, fmtPct, fmtRel, linePath, downsampleRender,
} from './charts.js';

const DAY = 86400_000;

export function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function clampPct(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function bar(label, p) {
  const width = clampPct(p);
  const level = width >= 90 ? 'hot' : width >= 70 ? 'warm' : 'ok';
  return `<div class="bar"><label>${label}</label><div class="track"><i class="${level}" style="width:${width}%"></i></div><span>${fmtPct(p)}</span></div>`;
}

export function renderCards(servers, nowMs = Date.now()) {
  if (!Array.isArray(servers) || servers.length === 0) {
    return '<div class="empty">还没有服务器,点右上角「添加服务器」开始。</div>';
  }
  return servers.map((s) => {
    const m = s.metric ?? null;
    const near = s.expiresAt != null && s.expiresAt - nowMs <= 7 * DAY;
    const expiry = s.expiresAt != null
      ? `<div class="expiry${near ? ' warn' : ''}">⏳ ${escapeHtml(fmtCountdown(s.expiresAt - nowMs))}</div>`
      : '';
    const status = s.online
      ? '<span class="dot on"></span><span class="statustext">在线</span>'
      : '<span class="dot off"></span><span class="statustext">离线</span>';
    const body = m
      ? `
        <div class="bars">
          ${bar('CPU', m.cpuPct)}
          ${bar('内存', m.memPct)}
          ${bar('磁盘', m.diskPct)}
        </div>
        <div class="netrow">
          <span title="下行速率">↓ ${escapeHtml(fmtBytesPerSec(m.rxSpeed))}</span>
          <span title="上行速率">↑ ${escapeHtml(fmtBytesPerSec(m.txSpeed))}</span>
        </div>
        <div class="netrow dim">
          <span title="今日流量">今日 ↓ ${escapeHtml(fmtBytes(m.dailyRx))} · ↑ ${escapeHtml(fmtBytes(m.dailyTx))}</span>
          <span>负载 ${m.load1 != null ? Number(m.load1).toFixed(2) : '—'}</span>
        </div>
        <footer>
          <span>在线率 ${s.uptimePct24h != null ? Number(s.uptimePct24h).toFixed(1) + '%' : '—'} · 运行 ${escapeHtml(fmtUptime(m.uptimeSec))}</span>
          <span>上报 ${escapeHtml(fmtRel(s.lastSeen, nowMs))}</span>
        </footer>`
      : '<div class="nodata">暂无数据,等待上报…</div>';
    const meta = [
      s.provider,
      s.region,
      s.priceCny != null && s.priceCny !== '' ? `¥${escapeHtml(String(s.priceCny))}` : null,
    ].filter(Boolean).map((v) => escapeHtml(v)).join(' · ');
    return `
      <article class="card${s.online ? '' : ' offline'}" data-id="${s.id}">
        <header>
          ${status}
          <h3><a href="#/server/${s.id}">${escapeHtml(s.name)}</a></h3>
          ${s.tag ? `<span class="tag">${escapeHtml(s.tag)}</span>` : ''}
        </header>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${expiry}
        ${body}
      </article>`;
  }).join('');
}

// ---------------------------------------------------------------------------
// Browser-only SPA code
// ---------------------------------------------------------------------------

if (typeof document !== 'undefined') {
  const $ = (sel) => document.querySelector(sel);
  const state = {
    servers: [],
    sort: 'default',
    groupFilter: '',
    es: null,
    pollTimer: null,
    statusTimer: null,
    detail: { id: null, range: '24h', data: null },
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
    if (res.status === 401) {
      location.hash = '#/login';
      throw new Error('unauthorized');
    }
    return res;
  }

  // ---- appearance (theme + wallpaper), per-browser localStorage (v1.2) ----

  const WALLPAPERS = {
    aurora: 'radial-gradient(1200px 600px at 15% -10%, rgba(76, 194, 255, .35), transparent 60%),' +
      'radial-gradient(1000px 500px at 85% 0%, rgba(157, 123, 255, .3), transparent 55%),' +
      'radial-gradient(900px 700px at 50% 110%, rgba(55, 214, 122, .22), transparent 60%)',
    night: 'linear-gradient(180deg, #0a1230 0%, #101a38 45%, #1c1035 100%)',
    grid: 'linear-gradient(rgba(76,194,255,.07) 1px, transparent 1px),' +
      'linear-gradient(90deg, rgba(76,194,255,.07) 1px, transparent 1px)',
  };

  function applyAppearance() {
    const theme = localStorage.getItem('vw_theme') ?? 'dark';
    if (theme === 'dark') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    const wall = localStorage.getItem('vw_wallpaper'); // JSON: {preset} or {url}
    if (wall) {
      try {
        const parsed = JSON.parse(wall);
        const image = parsed.url || WALLPAPERS[parsed.preset];
        if (image) {
          document.body.style.backgroundImage = image;
          document.body.classList.add('has-wallpaper');
          return;
        }
      } catch { /* corrupted pref falls back to none */ }
    }
    document.body.style.backgroundImage = '';
    document.body.classList.remove('has-wallpaper');
  }

  function showAppearance() {
    const theme = localStorage.getItem('vw_theme') ?? 'dark';
    const wall = (() => {
      try { return JSON.parse(localStorage.getItem('vw_wallpaper') ?? '{}'); } catch { return {}; }
    })();
    const wrap = modal(`
      <h2>🎨 外观</h2>
      <form id="appearance-form">
        <div class="row">
          <label>主题
            <select name="theme">
              <option value="dark"${theme === 'dark' ? ' selected' : ''}>暗色(默认)</option>
              <option value="light"${theme === 'light' ? ' selected' : ''}>浅色</option>
              <option value="midnight"${theme === 'midnight' ? ' selected' : ''}>午夜蓝</option>
            </select>
          </label>
          <label>壁纸
            <select name="preset">
              <option value="">无</option>
              <option value="aurora"${wall.preset === 'aurora' ? ' selected' : ''}>极光渐变</option>
              <option value="night"${wall.preset === 'night' ? ' selected' : ''}>夜空</option>
              <option value="grid"${wall.preset === 'grid' ? ' selected' : ''}>网格</option>
              <option value="__custom"${wall.url ? ' selected' : ''}>自定义 URL</option>
            </select>
          </label>
        </div>
        <label class="wide">自定义壁纸 URL<input name="url" value="${escapeHtml(wall.url ?? '')}" placeholder="https://..."></label>
        <p class="dim">偏好保存在本浏览器,不影响其他访问者。</p>
        <div class="actions">
          <button type="button" id="clear-wall">清除壁纸</button>
          <button type="submit" class="primary">应用</button>
        </div>
      </form>`);
    const form = wrap.querySelector('#appearance-form');
    const presetSel = form.elements.preset;
    const urlInput = form.elements.url;
    presetSel.addEventListener('change', () => {
      urlInput.disabled = presetSel.value !== '__custom';
    });
    urlInput.disabled = presetSel.value !== '__custom';
    wrap.querySelector('#clear-wall').addEventListener('click', () => {
      localStorage.removeItem('vw_wallpaper');
      applyAppearance();
      closeModal();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      localStorage.setItem('vw_theme', form.elements.theme.value);
      const value = presetSel.value;
      if (value === '') localStorage.removeItem('vw_wallpaper');
      else if (value === '__custom') localStorage.setItem('vw_wallpaper', JSON.stringify({ url: urlInput.value.trim() }));
      else localStorage.setItem('vw_wallpaper', JSON.stringify({ preset: value }));
      applyAppearance();
      closeModal();
    });
  }

  // ---- dial-test presets mirrored from server/probes.js DEFAULT_PROBES ----

  const PROBE_PRESETS = [
    { name: 'Cloudflare', type: 'http', target: 'https://cp.cloudflare.com/generate_204', intervalSec: 60, timeoutSec: 5 },
    { name: 'Google 204', type: 'http', target: 'https://www.gstatic.com/generate_204', intervalSec: 60, timeoutSec: 5 },
    { name: '阿里 DNS', type: 'tcp', target: '223.5.5.5:53', intervalSec: 60, timeoutSec: 5 },
    { name: 'GitHub API', type: 'http', target: 'https://api.github.com/', intervalSec: 60, timeoutSec: 5 },
  ];

  function filteredServers() {
    let list = [...state.servers];
    if (state.groupFilter) {
      list = list.filter((s) => (s.groupName ?? '') === state.groupFilter);
    }
    const by = {
      cpu: (a, b) => (b.metric?.cpuPct ?? -1) - (a.metric?.cpuPct ?? -1),
      mem: (a, b) => (b.metric?.memPct ?? -1) - (a.metric?.memPct ?? -1),
      traffic: (a, b) => ((b.metric?.dailyRx ?? 0) + (b.metric?.dailyTx ?? 0)) - ((a.metric?.dailyRx ?? 0) + (a.metric?.dailyTx ?? 0)),
      expiry: (a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity),
      name: (a, b) => a.name.localeCompare(b.name),
      default: (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id,
    };
    return list.sort(by[state.sort] ?? by.default);
  }

  function groupOptions() {
    const groups = [...new Set(state.servers.map((s) => s.groupName ?? '').filter(Boolean))];
    return groups;
  }

  function renderTopbar() {
    const online = state.servers.filter((s) => s.online).length;
    $('#online-count').textContent = `${online}/${state.servers.length} 在线`;
  }

  // SSE frames call this — only the card grid and the online count change,
  // so the sort dropdown keeps focus and listeners are not re-attached.
  function updateOverviewCards() {
    renderTopbar();
    const cards = document.getElementById('cards');
    if (cards) cards.innerHTML = renderCards(filteredServers());
  }

  function renderOverview() {
    const groups = groupOptions();
    $('#main').innerHTML = `
      <div class="toolbar">
        <label>排序
          <select id="sort">
            <option value="default"${state.sort === 'default' ? ' selected' : ''}>默认</option>
            <option value="cpu"${state.sort === 'cpu' ? ' selected' : ''}>CPU</option>
            <option value="mem"${state.sort === 'mem' ? ' selected' : ''}>内存</option>
            <option value="traffic"${state.sort === 'traffic' ? ' selected' : ''}>今日流量</option>
            <option value="expiry"${state.sort === 'expiry' ? ' selected' : ''}>到期时间</option>
            <option value="name"${state.sort === 'name' ? ' selected' : ''}>名称</option>
          </select>
        </label>
        ${groups.length ? `<label>分组
          <select id="group-filter">
            <option value="">全部分组</option>
            ${groups.map((g) => `<option value="${escapeHtml(g)}"${state.groupFilter === g ? ' selected' : ''}>${escapeHtml(g)}</option>`).join('')}
          </select>
        </label>` : ''}
        <a class="dim" href="#/status" style="align-self:center">状态页 ↗</a>
        <span class="spacer"></span>
        <button id="btn-alerts">告警记录</button>
        <button id="btn-admin">管理</button>
        <button id="btn-add" class="primary">添加服务器</button>
      </div>
      <div id="cards" class="grid"></div>`;
    $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; updateOverviewCards(); });
    $('#group-filter')?.addEventListener('change', (e) => { state.groupFilter = e.target.value; updateOverviewCards(); });
    $('#btn-add').addEventListener('click', () => showServerForm(null));
    $('#btn-admin').addEventListener('click', () => { location.hash = '#/admin'; });
    $('#btn-alerts').addEventListener('click', showEvents);
    updateOverviewCards();
  }

  function modal(html) {
    closeModal();
    const wrap = document.createElement('div');
    wrap.id = 'modal';
    wrap.innerHTML = `<div class="modal-mask"></div><div class="modal-box">${html}</div>`;
    document.body.appendChild(wrap);
    wrap.querySelector('.modal-mask').addEventListener('click', closeModal);
    return wrap;
  }
  function closeModal() { document.getElementById('modal')?.remove(); }

  async function showServerForm(existing) {
    const s = existing ?? {};
    const exp = s.expiresAt ? new Date(s.expiresAt).toISOString().slice(0, 10) : '';
    const wrap = modal(`
      <h2>${existing ? '编辑服务器' : '添加服务器'}</h2>
      <form id="server-form">
        <label>名称 *<input name="name" required value="${escapeHtml(s.name ?? '')}"></label>
        <div class="row">
          <label>标签<input name="tag" value="${escapeHtml(s.tag ?? '')}" placeholder="hk"></label>
          <label>服务商<input name="provider" value="${escapeHtml(s.provider ?? '')}"></label>
        </div>
        <div class="row">
          <label>地区<input name="region" value="${escapeHtml(s.region ?? '')}" placeholder="香港"></label>
          <label>月价格 (¥)<input name="priceCny" type="number" step="0.01" value="${s.priceCny ?? ''}"></label>
        </div>
        <div class="row">
          <label>分组<input name="groupName" value="${escapeHtml(s.groupName ?? '')}" placeholder="生产环境"></label>
          <label>月流量配额 (GB)<input name="quotaGb" type="number" min="0" step="0.1" value="${s.monthlyQuotaBytes != null ? s.monthlyQuotaBytes / 1024 ** 3 : ''}" placeholder="不限"></label>
        </div>
        <label>到期日<input name="expiresAt" type="date" value="${exp}"></label>
        <label>上报间隔 (秒)<input name="intervalSec" type="number" min="5" max="3600" value="${s.intervalSec ?? 10}"></label>
        <label>备注<textarea name="notes" rows="2">${escapeHtml(s.notes ?? '')}</textarea></label>
        <div class="actions">
          <button type="button" id="cancel">取消</button>
          <button type="submit" class="primary">${existing ? '保存' : '创建'}</button>
        </div>
      </form>`);
    wrap.querySelector('#cancel').addEventListener('click', closeModal);
    wrap.querySelector('#server-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {
        name: String(fd.get('name')).trim(),
        tag: String(fd.get('tag')).trim(),
        provider: String(fd.get('provider')).trim(),
        region: String(fd.get('region')).trim(),
        priceCny: fd.get('priceCny') === '' ? null : Number(fd.get('priceCny')),
        expiresAt: fd.get('expiresAt') ? Date.parse(fd.get('expiresAt')) : null,
        intervalSec: Number(fd.get('intervalSec')) || 10,
        notes: String(fd.get('notes')),
        groupName: String(fd.get('groupName') ?? '').trim(),
        monthlyQuotaBytes: fd.get('quotaGb') === '' || fd.get('quotaGb') == null
          ? null
          : Math.round(Number(fd.get('quotaGb')) * 1024 ** 3),
      };
      const res = existing
        ? await api(`/api/admin/servers/${existing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/admin/servers', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) { alert('保存失败'); return; }
      if (existing) { closeModal(); route(); return; }
      const { token } = await res.json();
      showTokenModal(body.name, token);
      loadOverview();
    });
  }

  function showTokenModal(name, token) {
    const cmd = `curl -fsSL ${location.origin}/install-agent.sh | bash -s -- --server ${location.origin} --token ${token}`;
    modal(`
      <h2>「${escapeHtml(name)}」已创建</h2>
      <p class="dim">Token 仅显示这一次,请立即复制:</p>
      <pre class="token">${escapeHtml(token)}</pre>
      <p class="dim">在服务器上执行:</p>
      <pre class="cmd" id="cmd">${escapeHtml(cmd)}</pre>
      <div class="actions">
        <button id="copy-cmd">复制命令</button>
        <button id="copy-tok">复制 Token</button>
        <button class="primary" id="done">完成</button>
      </div>`).querySelector('#done').addEventListener('click', closeModal);
    document.getElementById('copy-cmd').addEventListener('click', () => navigator.clipboard.writeText(cmd));
    document.getElementById('copy-tok').addEventListener('click', () => navigator.clipboard.writeText(token));
  }

  async function showEvents() {
    const res = await api('/api/events?limit=100');
    const events = await res.json();
    const rows = events.map((e) => `
      <tr class="${e.resolvedAt ? '' : 'open'}">
        <td>${new Date(e.startedAt).toLocaleString('zh-CN')}</td>
        <td>${escapeHtml(e.message)}</td>
        <td><span class="badge ${e.level}">${e.level === 'critical' ? '严重' : '警告'}</span></td>
        <td>${e.resolvedAt ? '已恢复' : '<b class="hottext">未恢复</b>'}</td>
      </tr>`).join('');
    modal(`
      <h2>告警记录</h2>
      <table class="list">${rows || '<tr><td class="dim">暂无告警 🎉</td></tr>'}</table>
      <div class="actions"><button class="primary" id="done">关闭</button></div>`)
      .querySelector('#done').addEventListener('click', closeModal);
  }

  async function showAdmin() {
    const res = await api('/api/overview');
    state.servers = await res.json();
    const rows = state.servers.map((s) => `
      <tr>
        <td>${escapeHtml(s.name)}${s.tag ? ` <span class="tag">${escapeHtml(s.tag)}</span>` : ''}</td>
        <td>${escapeHtml(s.provider || '—')}</td>
        <td>${s.expiresAt ? escapeHtml(fmtCountdown(s.expiresAt - Date.now())) : '—'}</td>
        <td>${s.priceCny != null ? `¥${escapeHtml(String(s.priceCny))}` : '—'}</td>
        <td class="actions-cell">
          <button data-edit="${s.id}">编辑</button>
          <button data-reset="${s.id}">重置 Token</button>
          <button class="danger" data-del="${s.id}">删除</button>
        </td>
      </tr>`).join('');
    $('#main').innerHTML = `
      <div class="toolbar"><button id="back">← 返回总览</button><span class="spacer"></span>
        <button id="btn-add2" class="primary">添加服务器</button></div>
      <table class="list">
        <thead><tr><th>名称</th><th>服务商</th><th>到期</th><th>月费</th><th>操作</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="dim">暂无服务器</td></tr>'}</tbody>
      </table>
      <h2>拨测任务</h2>
      <div class="toolbar">
        <button id="btn-add-probe" class="primary">添加拨测</button>
        <button id="btn-probe-presets">一键添加常用拨测点</button>
      </div>
      <table class="list" id="probe-table">
        <thead><tr><th>名称</th><th>类型</th><th>目标</th><th>间隔</th><th>最近结果</th><th>状态</th><th>操作</th></tr></thead>
        <tbody><tr><td colspan="7" class="dim">加载中…</td></tr></tbody>
      </table>
      <h2>系统设置</h2>
      <form id="settings-form" class="settings">
        <div class="row">
          <label>CPU 阈值 %<input name="cpu" type="number" min="1" max="100"></label>
          <label>内存阈值 %<input name="mem" type="number" min="1" max="100"></label>
          <label>磁盘阈值 %<input name="disk" type="number" min="1" max="100"></label>
        </div>
        <div class="row">
          <label>连续超标次数<input name="consecutive" type="number" min="1" max="60"></label>
          <label>到期提醒天数<input name="expiryDays" type="number" min="0" max="365"></label>
          <label>通知冷却 (分钟)<input name="notifyCooldownMin" type="number" min="1" max="1440"></label>
        </div>
        <div class="row">
          <label>数据保留 (天)<input name="retentionDays" type="number" min="1" max="3650"></label>
          <label class="wide">Webhook URL<input name="webhookUrl" placeholder="https://..."></label>
        </div>
        <div class="row">
          <label class="wide">Telegram Bot Token<input name="telegram_bot_token" placeholder="123456:ABC-DEF..."></label>
          <label>Telegram Chat ID<input name="telegram_chat_id" placeholder="-100..."></label>
        </div>
        <div class="row">
          <label class="wide checkbox-label"><input name="public_status" type="checkbox"> 开启公开状态页(无需登录访问 /status)</label>
          <div class="actions"><button type="button" id="btn-notify-test">发送测试通知</button></div>
        </div>
        <div class="actions"><button type="submit" class="primary">保存设置</button></div>
      </form>
      <h2>修改密码</h2>
      <form id="password-form" class="settings">
        <div class="row">
          <label>新密码<input name="password" type="password" minlength="8" required></label>
          <div class="actions"><button type="submit" class="primary">更新密码</button></div>
        </div>
      </form>`;

    $('#back').addEventListener('click', () => { location.hash = '#/'; });
    $('#btn-add2').addEventListener('click', () => showServerForm(null));
    $('#btn-add-probe').addEventListener('click', () => showProbeForm(null));
    $('#btn-probe-presets').addEventListener('click', async () => {
      const probes = await (await api('/api/admin/probes')).json();
      const targets = new Set(probes.map((p) => p.target));
      const missing = PROBE_PRESETS.filter((p) => !targets.has(p.target));
      if (!missing.length) { alert('常用拨测点已全部存在'); return; }
      for (const p of missing) {
        await api('/api/admin/probes', { method: 'POST', body: JSON.stringify(p) });
      }
      await loadProbeTable();
      alert(`已添加 ${missing.length} 个常用拨测点`);
    });
    $('#main').querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => {
      showServerForm(state.servers.find((s) => s.id === Number(b.dataset.edit)));
    }));
    $('#main').querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', async () => {
      const r = await api(`/api/admin/servers/${b.dataset.reset}/reset-token`, { method: 'POST' });
      const { token } = await r.json();
      showTokenModal('重置完成', token);
    }));
    $('#main').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('删除该服务器及其全部历史数据?')) return;
      await api(`/api/admin/servers/${b.dataset.del}`, { method: 'DELETE' });
      showAdmin();
    }));

    const settings = await (await api('/api/admin/settings')).json();
    const form = $('#settings-form');
    form.elements.cpu.value = settings.thresholds.cpu;
    form.elements.mem.value = settings.thresholds.mem;
    form.elements.disk.value = settings.thresholds.disk;
    form.elements.consecutive.value = settings.thresholds.consecutive;
    form.elements.expiryDays.value = settings.thresholds.expiryDays;
    form.elements.notifyCooldownMin.value = settings.notifyCooldownMin;
    form.elements.retentionDays.value = settings.retentionDays;
    form.elements.webhookUrl.value = settings.webhookUrl ?? '';
    form.elements.telegram_bot_token.value = settings.telegram_bot_token ?? '';
    form.elements.telegram_chat_id.value = settings.telegram_chat_id ?? '';
    form.elements.public_status.checked = settings.public_status === true;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        thresholds: {
          cpu: Number(form.elements.cpu.value),
          mem: Number(form.elements.mem.value),
          disk: Number(form.elements.disk.value),
          consecutive: Number(form.elements.consecutive.value),
          expiryDays: Number(form.elements.expiryDays.value),
        },
        notifyCooldownMin: Number(form.elements.notifyCooldownMin.value),
        retentionDays: Number(form.elements.retentionDays.value),
        webhookUrl: form.elements.webhookUrl.value.trim(),
        public_status: form.elements.public_status.checked,
        telegram_bot_token: form.elements.telegram_bot_token.value.trim(),
        telegram_chat_id: form.elements.telegram_chat_id.value.trim(),
      };
      const saved = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(body) });
      if (!saved.ok) alert('保存失败:' + (await saved.json()).error ?? ''); else alert('已保存');
    });
    $('#btn-notify-test').addEventListener('click', async () => {
      const btn = $('#btn-notify-test');
      btn.disabled = true;
      try {
        const res = await api('/api/admin/notify-test', { method: 'POST' });
        const r = await res.json();
        const fmt = (v) => v === null || v === undefined ? '未配置' : (v ? '✓ 已发送' : '✗ 失败');
        alert(`测试结果\nWebhook: ${fmt(r.webhook)}\nTelegram: ${fmt(r.telegram)}`);
      } finally {
        btn.disabled = false;
      }
    });
    $('#password-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const pw = e.target.elements.password.value;
      const res = await api('/api/admin/password', { method: 'POST', body: JSON.stringify({ password: pw }) });
      if (res.ok) alert('密码已更新,所有会话已注销,请重新登录'); else alert('更新失败');
      e.target.reset();
    });

    await loadProbeTable();
  }

  async function loadProbeTable() {
    const probes = await (await api('/api/admin/probes')).json();
    const tbody = $('#probe-table tbody');
    if (!tbody) return;
    tbody.innerHTML = probes.map((p) => `
      <tr>
        <td>${escapeHtml(p.name)}</td>
        <td><span class="tag">${p.type.toUpperCase()}</span></td>
        <td class="dim">${escapeHtml(p.target)}</td>
        <td>${p.intervalSec}s</td>
        <td>${p.latest
          ? (p.latest.ok ? `✓ ${p.latest.latencyMs != null ? p.latest.latencyMs.toFixed(0) + ' ms' : ''}` : `✗ ${escapeHtml(p.latest.error ?? '')}`)
          : '<span class="dim">暂无</span>'}</td>
        <td>${p.enabled ? '启用' : '<span class="dim">停用</span>'}</td>
        <td class="actions-cell">
          <button data-pedit="${p.id}">编辑</button>
          <button class="danger" data-pdel="${p.id}">删除</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="7" class="dim">暂无拨测任务</td></tr>';
    tbody.querySelectorAll('[data-pedit]').forEach((b) => b.addEventListener('click', () => {
      showProbeForm(probes.find((p) => p.id === Number(b.dataset.pedit)));
    }));
    tbody.querySelectorAll('[data-pdel]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('删除该拨测任务及其历史?')) return;
      await api(`/api/admin/probes/${b.dataset.pdel}`, { method: 'DELETE' });
      loadProbeTable();
    }));
  }

  function showProbeForm(existing) {
    const p = existing ?? {};
    const wrap = modal(`
      <h2>${existing ? '编辑拨测' : '添加拨测'}</h2>
      <form id="probe-form">
        ${existing ? '' : `<label>常用预设
          <select name="preset">
            <option value="">自定义</option>
            ${PROBE_PRESETS.map((preset, i) => `<option value="${i}">${escapeHtml(preset.name)}(${escapeHtml(preset.target)})</option>`).join('')}
          </select>
        </label>`}
        <div class="row">
          <label>名称 *<input name="name" required value="${escapeHtml(p.name ?? '')}" placeholder="网关延迟"></label>
          <label>类型 *
            <select name="type">
              <option value="http"${p.type === 'http' || !p.type ? ' selected' : ''}>HTTP</option>
              <option value="tcp"${p.type === 'tcp' ? ' selected' : ''}>TCP</option>
            </select>
          </label>
        </div>
        <label>目标 *<input name="target" required value="${escapeHtml(p.target ?? '')}" placeholder="https://example.com/health 或 1.2.3.4:22"></label>
        <div class="row">
          <label>间隔 (秒)<input name="intervalSec" type="number" min="10" max="3600" value="${p.intervalSec ?? 30}"></label>
          <label>超时 (秒)<input name="timeoutSec" type="number" min="1" max="30" value="${p.timeoutSec ?? 5}"></label>
          <label>启用<select name="enabled"><option value="1"${p.enabled !== 0 ? ' selected' : ''}>是</option><option value="0"${p.enabled === 0 ? ' selected' : ''}>否</option></select></label>
        </div>
        <div class="actions">
          <button type="button" id="cancel">取消</button>
          <button type="submit" class="primary">${existing ? '保存' : '创建'}</button>
        </div>
      </form>`);
    wrap.querySelector('#cancel').addEventListener('click', closeModal);
    const presetSel = wrap.querySelector('[name="preset"]');
    presetSel?.addEventListener('change', () => {
      const preset = PROBE_PRESETS[Number(presetSel.value)];
      if (!preset) return;
      const f = wrap.querySelector('#probe-form').elements;
      f.name.value = preset.name;
      f.type.value = preset.type;
      f.target.value = preset.target;
      f.intervalSec.value = preset.intervalSec;
      f.timeoutSec.value = preset.timeoutSec;
    });
    wrap.querySelector('#probe-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const body = {
        name: String(fd.get('name')).trim(),
        type: String(fd.get('type')),
        target: String(fd.get('target')).trim(),
        intervalSec: Number(fd.get('intervalSec')) || 30,
        timeoutSec: Number(fd.get('timeoutSec')) || 5,
        enabled: String(fd.get('enabled')) === '1',
      };
      const res = existing
        ? await api(`/api/admin/probes/${existing.id}`, { method: 'PATCH', body: JSON.stringify(body) })
        : await api('/api/admin/probes', { method: 'POST', body: JSON.stringify(body) });
      if (!res.ok) alert('保存失败:' + (await res.json()).error ?? ''); else { closeModal(); loadProbeTable(); }
    });
  }

  function svgChart(points, { min, max, color, format }) {
    const W = 560;
    const H = 120;
    const pts = downsampleRender(points.filter((p) => p != null), W);
    if (pts.length === 0) return '<div class="dim chart-empty">暂无数据</div>';
    const xs = pts.map((p) => p.ts);
    const hi = max ?? Math.max(...pts.map((p) => p.y), 0.0001);
    const lo = min ?? 0;
    const series = pts.map((p) => ({ x: p.ts, y: p.y ?? lo }));
    const d = linePath(series, { w: W, h: H, pad: 4, min: lo, max: hi });
    const avg = series.reduce((acc, p) => acc + p.y, 0) / series.length;
    const peak = Math.max(...series.map((p) => p.y));
    return `
      <div class="chart">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><path d="${d}" fill="none" stroke="${color}" stroke-width="1.6"/></svg>
        <div class="chart-caption"><span>均值 ${format(avg)}</span><span>峰值 ${format(peak)}</span></div>
      </div>`;
  }

  const RANGES = ['1h', '6h', '24h', '7d', '30d'];

  async function showDetail(id) {
    state.detail = { id, range: state.detail.id === id ? state.detail.range : '24h', data: null };
    renderDetailShell();
    await loadDetail();
  }

  function renderDetailShell() {
    const s = state.servers.find((x) => x.id === state.detail.id);
    const bits = [];
    if (s?.groupName) bits.push(`分组 ${escapeHtml(s.groupName)}`);
    if (s?.uptimePct24h != null) bits.push(`24h 在线率 ${Number(s.uptimePct24h).toFixed(1)}%`);
    if (s?.monthlyQuotaBytes > 0) {
      const used = (s.metric?.monthlyRx ?? 0) + (s.metric?.monthlyTx ?? 0);
      bits.push(`月流量 ${escapeHtml(fmtBytes(used))} / ${escapeHtml(fmtBytes(s.monthlyQuotaBytes))}`);
    }
    if (s?.notes) bits.push(escapeHtml(s.notes));
    $('#main').innerHTML = `
      <div class="toolbar">
        <button id="back">← 返回总览</button>
        <h2>${escapeHtml(s?.name ?? `服务器 #${state.detail.id}`)}</h2>
        ${RANGES.map((r) => `<button class="range${r === state.detail.range ? ' active' : ''}" data-range="${r}">${r}</button>`).join('')}
      </div>
      ${bits.length ? `<div class="meta-line">${bits.map((b) => `<span>${b}</span>`).join('<span class="dim"> · </span>')}</div>` : ''}
      <div id="detail-body"><p class="dim">加载中…</p></div>`;
    $('#back').addEventListener('click', () => { location.hash = '#/'; });
    $('#main').querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
      state.detail.range = b.dataset.range;
      $('#main').querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('active', x === b));
      loadDetail();
    }));
  }

  async function loadDetail() {
    const id = state.detail.id;
    let info = state.servers.find((x) => x.id === id);
    if (!info) {
      info = (await (await api('/api/overview')).json()).find((x) => x.id === id);
    }
    const hist = await (await api(`/api/servers/${id}/history?range=${state.detail.range}`)).json();
    const pts = hist.points ?? [];
    const series = (pick) => pts.map((p) => ({ ts: p.ts, y: pick(p) }));
    const speedFmt = (v) => fmtBytesPerSec(v);
    const body = `
      <div class="charts">
        ${chartBlock('CPU 使用率', svgChart(series((p) => p.cpuPct), { min: 0, max: 100, color: '#4cc2ff', format: fmtPct }))}
        ${chartBlock('内存使用率', svgChart(series((p) => p.memTotal ? (p.memUsed / p.memTotal) * 100 : null), { min: 0, max: 100, color: '#9d7bff', format: fmtPct }))}
        ${chartBlock('网络速率', svgChart([
          ...series((p) => p.rxSpeed).map((p) => ({ ...p, kind: '↓' })),
        ], { color: '#37d67a', format: speedFmt }))}
        ${chartBlock('上行速率', svgChart(series((p) => p.txSpeed), { color: '#ffb84c', format: speedFmt }))}
        ${chartBlock('负载 (load1)', svgChart(series((p) => p.load1), { color: '#ff6b81', format: (v) => Number(v).toFixed(2) }))}
      </div>
      <h2>告警历史</h2>
      <table class="list" id="detail-events"><tbody><tr><td class="dim">加载中…</td></tr></tbody></table>`;
    $('#detail-body').innerHTML = body;
    const evRes = await api(`/api/events?server_id=${id}&limit=20`);
    const events = await evRes.json();
    $('#detail-events tbody').innerHTML = events.map((e) => `
      <tr><td>${new Date(e.startedAt).toLocaleString('zh-CN')}</td>
      <td>${escapeHtml(e.message)}</td>
      <td>${e.resolvedAt ? '已恢复' : '<b class="hottext">未恢复</b>'}</td></tr>`).join('')
      || '<tr><td class="dim">暂无告警 🎉</td></tr>';
  }

  function chartBlock(title, inner) {
    return `<section><h3>${title}</h3>${inner}</section>`;
  }

  function renderLogin() {
    stopStream();
    document.body.classList.add('login-mode');
    $('#topbar').style.display = 'none';
    $('#main').innerHTML = `
      <form id="login-form" class="login-card">
        <h1>VPSWatch</h1>
        <p class="dim">多 VPS 日常监控管理系统</p>
        <label>管理员密码<input type="password" name="password" required autofocus></label>
        <button class="primary" type="submit">登录</button>
        <p id="login-err" class="hottext"></p>
      </form>`;
    $('#login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: e.target.elements.password.value }),
      });
      if (res.ok) {
        document.body.classList.remove('login-mode');
        $('#topbar').style.display = '';
        location.hash = '#/';
        route();
      } else {
        $('#login-err').textContent = res.status === 429 ? '尝试过多,请稍后再试' : '密码错误';
      }
    });
  }

  function stopStream() {
    state.es?.close();
    state.es = null;
    if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
  }

  function connectStream() {
    if (state.es) return;
    const es = new EventSource('/api/stream');
    es.addEventListener('overview', (e) => {
      // SSE is alive again — the degraded polling loop must stop.
      if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
      state.servers = JSON.parse(e.data);
      if (location.hash === '' || location.hash === '#/') updateOverviewCards();
      if (state.detail.id && location.hash.startsWith('#/server/')) renderTopbar();
    });
    es.onerror = () => {
      es.close();
      state.es = null;
      if (!state.pollTimer) state.pollTimer = setInterval(loadOverview, 5000);
    };
    state.es = es;
  }

  async function loadOverview() {
    try {
      const res = await api('/api/overview');
      state.servers = await res.json();
      if (location.hash === '' || location.hash === '#/') {
        // first paint builds the shell; repeat visits (poll fallback) only refresh cards
        if (document.getElementById('cards')) updateOverviewCards();
        else renderOverview();
      }
    } catch { /* redirected to login */ }
  }

  async function route() {
    const hash = location.hash || '#/';
    document.body.classList.remove('login-mode');
    document.body.classList.remove('status-mode');
    $('#topbar').style.display = '';
    if (state.statusTimer) { clearInterval(state.statusTimer); state.statusTimer = null; }
    if (hash === '#/login') return renderLogin();
    if (hash === '#/status') return renderStatus();
    if (hash === '#/admin') {
      try { await showAdmin(); } catch { /* 401 redirected */ }
      return;
    }
    const m = hash.match(/^#\/server\/(\d+)/);
    if (m) {
      try { await showDetail(Number(m[1])); } catch { /* 401 redirected */ }
      return;
    }
    // overview
    connectStream();
    await loadOverview();
  }

  // Public status page (Komari-style): no login required when the hub has
  // 公开状态页 enabled; everything else on this page is deliberately minimal.
  async function renderStatus() {
    stopStream();
    $('#topbar').style.display = 'none';
    document.body.classList.add('status-mode');
    const generation = state.statusGeneration = (state.statusGeneration ?? 0) + 1;
    const isCurrent = () => location.hash === '#/status' && generation === state.statusGeneration;
    const render = (pub) => {
      const spark = (h) => {
        const pts = (h ?? []).filter((x) => x.latencyMs != null).map((x) => ({ x: x.ts, y: x.latencyMs }));
        if (pts.length < 2) return '';
        const max = Math.max(...pts.map((p) => p.y));
        const d = linePath(pts, { w: 120, h: 28, pad: 2, min: 0, max: max * 1.1 || 1 });
        return `<svg class="spark" viewBox="0 0 120 28"><path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5"/></svg>`;
      };
      $('#main').innerHTML = `
        <div class="status-head">
          <h1>⏱ VPSWatch 状态页</h1>
          <a class="dim" href="#/">管理面板</a>
        </div>
        <div id="status-body">
          ${pub ? `
            <table class="list">
              <thead><tr><th>服务器</th><th>分组</th><th>状态</th><th>24h 在线率</th></tr></thead>
              <tbody>
                ${pub.servers.map((s) => `
                  <tr>
                    <td>${escapeHtml(s.name)}${s.tag ? ` <span class="tag">${escapeHtml(s.tag)}</span>` : ''}</td>
                    <td class="dim">${escapeHtml(s.groupName || '—')}</td>
                    <td>${s.online
                      ? '<span class="dot on"></span> 在线'
                      : '<span class="dot off"></span> 离线'}</td>
                    <td>${Number(s.uptimePct24h ?? 0).toFixed(1)}%</td>
                  </tr>`).join('') || '<tr><td colspan="4" class="dim">暂无服务器</td></tr>'}
              </tbody>
            </table>
            <h2>拨测</h2>
            <table class="list">
              <thead><tr><th>名称</th><th>类型</th><th>目标</th><th>最近结果</th></tr></thead>
              <tbody>
                ${pub.probes.map((p) => `
                  <tr>
                    <td>${escapeHtml(p.name)}</td>
                    <td><span class="tag">${p.type.toUpperCase()}</span></td>
                    <td class="dim">${escapeHtml(p.target)}</td>
                    <td>${p.ok === null ? '<span class="dim">暂无</span>'
                      : p.ok ? `<span class="dot on"></span> ${p.latencyMs != null ? p.latencyMs.toFixed(0) + ' ms' : ''} ${spark(p.history24h)}`
                        : `<span class="dot off"></span> ${escapeHtml(p.error ?? '失败')} ${spark(p.history24h)}`}</td>
                  </tr>`).join('') || '<tr><td colspan="4" class="dim">暂无拨测任务</td></tr>'}
              </tbody>
            </table>`
            : '<div class="empty">公开状态页未开启。管理员可在「管理 → 系统设置」中开启。</div>'}
        </div>`;
    };
    try {
      const res = await fetch('/api/public/overview');
      const pub = res.status === 200 ? await res.json() : null;
      if (isCurrent()) render(pub);
      if (pub) state.statusTimer = setInterval(async () => {
        if (!isCurrent()) return;
        try {
          const r = await fetch('/api/public/overview');
          if (r.status === 200) render(await r.json());
        } catch { /* transient */ }
      }, 30_000);
    } catch {
      if (isCurrent()) render(null);
    }
  }

  $('#logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    stopStream();
    location.hash = '#/login';
    route();
  });

  window.addEventListener('hashchange', route);
  applyAppearance();
  $('#btn-appearance').addEventListener('click', showAppearance);
  route();
}
