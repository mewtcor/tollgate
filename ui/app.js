const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const win = window.__TAURI__.window.getCurrentWindow();

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const REFRESH_MS = 15000;
const ACTION_LABEL = { pause: 'Pause', unpause: 'Resume', block: 'Block', unblock: 'Unblock' };

let devices = [];
let schedules = [];
let filter = 'all';
let query = '';
let gridHtml = '';
let formKey = '';
let known = null;
let busy = new Set();
let lastOk = 0;
let loading = false;

try { known = new Set(JSON.parse(localStorage.getItem('known') || 'null')); if (!known.size) known = null; } catch { known = null; }

function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4500);
}

const state = (d) => (d.blocked ? 'blocked' : d.paused ? 'paused' : d.connected ? 'online' : 'offline');
const hue = (s) => [...s].reduce((h, c) => (h * 131 + c.charCodeAt(0) * 17) % 360, 7);
const nameOf = (mac) => (devices.find((d) => d.mac === mac) || {}).name || mac;

function renderStats() {
  const on = devices.filter((d) => d.connected && !d.blocked).length;
  const now = new Date();
  const mins = (t) => { const [h, m] = t.split(':').map(Number); return (h * 60 + m - now.getHours() * 60 - now.getMinutes() + 1440) % 1440; };
  const next = [...schedules].sort((a, b) => mins(a.time) - mins(b.time))[0];
  $('#stats').innerHTML =
    `<div class="stat ok"><b>${on}</b><span>Online</span></div>` +
    `<div class="stat"><b>${devices.length}</b><span>Devices</span></div>` +
    `<div class="stat warn"><b>${devices.filter((d) => d.paused).length}</b><span>Paused</span></div>` +
    `<div class="stat bad"><b>${devices.filter((d) => d.blocked).length}</b><span>Blocked</span></div>` +
    `<div class="stat next"><b>${next ? esc(next.time) : '--'}</b><span>${next ? esc(ACTION_LABEL[next.action] + ' ' + nameOf(next.mac)) : 'No schedules'}</span></div>`;
}

function card(d) {
  const st = state(d);
  const sub = [d.maker, d.ip, d.wired ? 'Wired' : ''].filter(Boolean).join(' · ') || d.mac;
  const off = busy.has(d.mac) ? 'disabled' : '';
  const pa = d.paused ? 'unpause' : 'pause';
  const ba = d.blocked ? 'unblock' : 'block';
  return `<article class="card ${st}" style="--h:${hue(d.name)}">
    <div class="avatar">${esc((d.name.trim()[0] || '?').toUpperCase())}</div>
    <div class="meta"><h3 title="${esc(d.name)}">${esc(d.name)}</h3><p>${esc(sub)}</p></div>
    <span class="pill ${st}">${st}</span>
    <div class="actions">
      <button class="btn ${d.paused ? 'active' : ''}" data-m="${esc(d.mac)}" data-a="${pa}" ${off}>${d.paused ? 'Resume' : 'Pause'}</button>
      <button class="btn danger ${d.blocked ? 'active' : ''}" data-m="${esc(d.mac)}" data-a="${ba}" ${off}>${d.blocked ? 'Unblock' : 'Block'}</button>
    </div></article>`;
}

function renderGrid() {
  const q = query.toLowerCase();
  const rank = { online: 0, paused: 1, blocked: 2, offline: 3 };
  const shown = devices
    .filter((d) => (filter === 'all' || state(d) === filter) && (!q || (d.name + d.ip + d.maker + d.mac).toLowerCase().includes(q)))
    .sort((a, b) => rank[state(a)] - rank[state(b)] || a.name.localeCompare(b.name));
  const html = shown.length ? shown.map(card).join('') : '<p class="empty">No devices match.</p>';
  if (html !== gridHtml) { $('#grid').innerHTML = html; gridHtml = html; }
}

function renderSched() {
  const key = devices.map((d) => d.mac).sort().join();
  if (key !== formKey) {
    const cur = $('#sm').value;
    $('#sm').innerHTML = devices.map((d) => `<option value="${esc(d.mac)}">${esc(d.name)}</option>`).join('');
    if (cur) $('#sm').value = cur;
    formKey = key;
  }
  $('#sched-note').textContent = schedules.length ? `${schedules.length} active` : '';
  $('#sched-list').innerHTML = schedules.length
    ? schedules.map((s, i) => `<div class="sched"><b>${esc(nameOf(s.mac))}</b><span class="tag">${esc(ACTION_LABEL[s.action])}</span><span class="time">${esc(s.time)}</span><button class="icon" data-del="${i}" aria-label="Remove schedule"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('')
    : '<p class="muted">Nothing scheduled. Add one below and it runs every day while this app is open.</p>';
}

function renderAll() { renderStats(); renderGrid(); renderSched(); }

function markUpdated() {
  lastOk = Date.now();
  $('#live').classList.remove('stale');
  tick();
}
function tick() {
  if (!lastOk) return;
  const s = Math.round((Date.now() - lastOk) / 1000);
  $('#updated').textContent = s < 5 ? 'Live' : `Updated ${s}s ago`;
  $('#live').classList.toggle('stale', s > REFRESH_MS / 500);
}

function detectNew(list) {
  const macs = new Set(list.map((d) => d.mac));
  if (known) {
    list.filter((d) => !known.has(d.mac)).forEach((d) => toast(`New device joined: ${d.name}`, 'new'));
  }
  known = new Set([...(known || []), ...macs]);
  try { localStorage.setItem('known', JSON.stringify([...known])); } catch {}
}

async function refresh(manual = false) {
  if (loading) return;
  loading = true;
  if (manual) $('#refresh').classList.add('spin');
  try {
    devices = await invoke('devices');
    detectNew(devices);
    markUpdated();
    renderAll();
  } catch (e) {
    $('#live').classList.add('stale');
    $('#updated').textContent = 'Offline';
    if (manual || /Not signed in|401/.test(String(e))) toast(String(e), 'err');
    if (/Not signed in|401/.test(String(e))) showLogin();
  } finally {
    loading = false;
    setTimeout(() => $('#refresh').classList.remove('spin'), 800);
  }
}

async function saveSchedules(items) {
  try {
    await invoke('set_schedules', { items });
    schedules = items;
    renderStats();
    renderSched();
  } catch (e) { toast(String(e), 'err'); }
}

function showLogin() {
  $('#dash').hidden = true;
  $('#login').hidden = false;
  $('#logout').hidden = true;
  $('#live').hidden = true;
  $('#f-user').hidden = false;
  $('#f-code').hidden = true;
  $('#login-err').textContent = '';
}

async function showDash() {
  $('#login').hidden = true;
  $('#dash').hidden = false;
  $('#logout').hidden = false;
  $('#live').hidden = false;
  schedules = await invoke('get_schedules');
  await refresh(true);
}

$('#f-user').onsubmit = async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    await invoke('login', { user: $('#user').value.trim() });
    $('#f-user').hidden = true;
    $('#f-code').hidden = false;
    $('#login-hint').textContent = 'Code sent. Check your email or phone.';
    $('#code').focus();
  } catch (x) { $('#login-err').textContent = String(x); }
};
$('#f-code').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await invoke('verify', { code: $('#code').value.trim() });
    $('#code').value = '';
    showDash();
  } catch (x) { $('#login-err').textContent = String(x); }
};

$('#grid').onclick = async (e) => {
  const b = e.target.closest('button[data-a]');
  if (!b) return;
  const { m, a } = b.dataset;
  busy.add(m);
  renderGrid();
  try {
    await invoke('device_action', { mac: m, action: a });
    const d = devices.find((x) => x.mac === m);
    if (d) { if (a === 'pause' || a === 'unpause') d.paused = a === 'pause'; else d.blocked = a === 'block'; }
  } catch (x) { toast(String(x), 'err'); }
  busy.delete(m);
  renderAll();
  setTimeout(refresh, 1500);
};

$('#chips').onclick = (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  filter = c.dataset.f;
  document.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
  renderGrid();
};
$('#q').oninput = (e) => { query = e.target.value; renderGrid(); };

$('#sched-form').onsubmit = (e) => {
  e.preventDefault();
  if (!$('#sm').value) return;
  saveSchedules([...schedules, { mac: $('#sm').value, action: $('#sa').value, time: $('#st').value }]);
};
$('#sched-list').onclick = (e) => {
  const b = e.target.closest('[data-del]');
  if (b) saveSchedules(schedules.filter((_, i) => i !== Number(b.dataset.del)));
};

let pinned = false;
$('#pin').onclick = async () => { pinned = !pinned; await win.setAlwaysOnTop(pinned); $('#pin').classList.toggle('on', pinned); };
$('#min').onclick = () => win.minimize();
$('#close').onclick = () => win.close();
$('#refresh').onclick = () => refresh(true);
$('#logout').onclick = async () => { await invoke('logout'); devices = []; known = null; showLogin(); };

listen('schedule-ran', (e) => {
  const { mac, action, error } = e.payload;
  toast(error ? `Schedule failed: ${error}` : `${ACTION_LABEL[action]}: ${nameOf(mac)}`, error ? 'err' : '');
  refresh();
});

window.addEventListener('focus', () => refresh());
setInterval(() => { if (!$('#dash').hidden) refresh(); }, REFRESH_MS);
setInterval(tick, 1000);

(async () => {
  try { (await invoke('status')) ? await showDash() : showLogin(); } catch (e) { toast(String(e), 'err'); showLogin(); }
})();
