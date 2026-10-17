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
let selected = new Set();
let editing = false;
let editIdx = null;

const load = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {}; } catch { return {}; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
let nicks = load('nicks');
let groups = load('groups');
const withNick = (d) => ({ ...d, orig: d.name, name: nicks[d.mac] || d.name });
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

const t12 = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`; };
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const daysLabel = (days) => {
  const k = [...days].sort().join();
  return !days.length || k === '0,1,2,3,4,5,6' ? 'Every day' : k === '1,2,3,4,5' ? 'Weekdays' : k === '0,6' ? 'Weekends' : [...days].sort().map((d) => DAY[d]).join(' ');
};
const applyLocal = (mac, a) => {
  const d = devices.find((x) => x.mac === mac);
  if (!d) return;
  if (a === 'pause' || a === 'unpause') d.paused = a === 'pause'; else d.blocked = a === 'block';
};
// two-step button: the first click arms it for 3s, the second click confirms
const confirmed = (btn) => {
  if (btn.dataset.armed) return true;
  const label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = 'Confirm?';
  btn.classList.add('armed');
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = label; btn.classList.remove('armed'); }, 3000);
  return false;
};
const state = (d) => (d.blocked ? 'blocked' : d.paused ? 'paused' : d.connected ? 'online' : 'offline');
const hue = (s) => [...s].reduce((h, c) => (h * 131 + c.charCodeAt(0) * 17) % 360, 7);
const nameOf = (mac) => (devices.find((d) => d.mac === mac) || {}).name || mac;

function renderStats() {
  const on = devices.filter((d) => d.connected && !d.blocked).length;
  const now = new Date();
  const mins = (s) => {
    const [h, m] = s.time.split(':').map(Number);
    const base = h * 60 + m - now.getHours() * 60 - now.getMinutes();
    for (let i = 0; i < 8; i++) {
      const t = base + i * 1440;
      if (t >= 0 && (!s.days?.length || s.days.includes((now.getDay() + i) % 7))) return t;
    }
    return Infinity;
  };
  const next = schedules.filter((s) => s.enabled !== false).sort((a, b) => mins(a) - mins(b))[0];
  $('#stats').innerHTML =
    `<div class="stat ok"><b>${on}</b><span>Online</span></div>` +
    `<div class="stat"><b>${devices.length}</b><span>Devices</span></div>` +
    `<div class="stat warn"><b>${devices.filter((d) => d.paused).length}</b><span>Paused</span></div>` +
    `<div class="stat bad"><b>${devices.filter((d) => d.blocked).length}</b><span>Blocked</span></div>` +
    `<div class="stat next"><b>${next ? t12(next.time) : '--'}</b><span>${next ? esc(ACTION_LABEL[next.action] + ' ' + nameOf(next.mac)) : 'No schedules'}</span></div>`;
}

function card(d) {
  const st = state(d);
  const sub = d.paused && d.resume_at
    ? `Resumes ${t12(new Date(d.resume_at * 1000).toTimeString().slice(0, 5))}`
    : [d.maker, d.ip, d.wired ? 'Wired' : ''].filter(Boolean).join(' · ') || d.mac;
  const off = busy.has(d.mac) ? 'disabled' : '';
  const pa = d.paused ? 'unpause' : 'pause';
  const ba = d.blocked ? 'unblock' : 'block';
  return `<article class="card ${st} ${selected.has(d.mac) ? 'sel' : ''}" style="--h:${hue(d.name)}">
    <input type="checkbox" class="pick" data-sel="${esc(d.mac)}" aria-label="Select ${esc(d.name)}" ${selected.has(d.mac) ? 'checked' : ''}>
    <div class="avatar">${esc((d.name.trim()[0] || '?').toUpperCase())}</div>
    <div class="meta"><h3 data-mac="${esc(d.mac)}" title="${esc(d.name)} (double-click to rename)">${esc(d.name)}</h3><p>${esc(sub)}</p></div>
    <span class="pill ${st}">${st}</span>
    <div class="actions">
      <button class="btn ${d.paused ? 'active' : ''}" data-m="${esc(d.mac)}" data-a="${pa}" ${off}>${d.paused ? 'Resume' : 'Pause'}</button>
      ${d.paused || d.blocked ? '' : `<select class="btn timer" data-timer="${esc(d.mac)}" aria-label="Pause for a while" ${off}>
        <option value="">Timer</option><option value="30">30 min</option><option value="60">1 hour</option><option value="120">2 hours</option><option value="240">4 hours</option></select>`}
      <button class="btn danger ${d.blocked ? 'active' : ''}" data-m="${esc(d.mac)}" data-a="${ba}" ${off}>${d.blocked ? 'Unblock' : 'Block'}</button>
    </div></article>`;
}

function renderGrid() {
  if (editing) return;
  const q = query.toLowerCase();
  const rank = { online: 0, paused: 1, blocked: 2, offline: 3 };
  const shown = devices
    .filter((d) => (filter === 'all' || state(d) === filter) && (!q || (d.name + d.orig + d.ip + d.maker + d.mac).toLowerCase().includes(q)))
    .sort((a, b) => rank[state(a)] - rank[state(b)] || a.name.localeCompare(b.name));
  const html = shown.length ? shown.map(card).join('') : '<p class="empty">No devices match.</p>';
  if (html !== gridHtml) { $('#grid').innerHTML = html; gridHtml = html; }
}

function renderSched() {
  selected = new Set([...selected].filter((m) => devices.some((d) => d.mac === m)));
  const key = devices.map((d) => d.mac + d.name).sort().join() + '|' + selected.size;
  if (key !== formKey) {
    const cur = $('#sm').value;
    $('#sm').innerHTML = (selected.size ? `<option value="">${selected.size} selected</option>` : '') +
      devices.map((d) => `<option value="${esc(d.mac)}">${esc(d.name)}</option>`).join('');
    if (selected.size) $('#sm').value = '';
    else if (cur) $('#sm').value = cur;
    $('#sm').disabled = selected.size > 0;
    formKey = key;
  }
  $('#sched-note').textContent = schedules.length ? `${schedules.length} active` : '';
  $('#sched-list').innerHTML = schedules.length
    ? schedules.map((s, i) => `<div class="sched${s.enabled === false ? ' off' : ''}${editIdx === i ? ' editing' : ''}"><input type="checkbox" class="tog" data-tog="${i}" title="Enabled" ${s.enabled === false ? '' : 'checked'}><b>${esc(nameOf(s.mac))}</b><span class="days-label">${daysLabel(s.days || [])}</span><span class="tag">${esc(ACTION_LABEL[s.action])}</span><span class="time">${t12(s.time)}</span><button class="icon" data-edit="${i}" aria-label="Edit schedule" title="Edit"><svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/></svg></button><button class="icon" data-del="${i}" aria-label="Remove schedule"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>`).join('')
    : '<p class="muted">Nothing scheduled. Add one below and it runs every day while this app is open.</p>';
}

function renderGroups() {
  const names = Object.keys(groups);
  $('#groups').hidden = !names.length && !selected.size;
  $('#group-form').hidden = !selected.size;
  $('#bulk').hidden = !selected.size;
  $('#bulk-n').textContent = `${selected.size} selected`;
  $('#group-chips').innerHTML = names.map((n) => {
    const on = groups[n].length === selected.size && groups[n].every((m) => selected.has(m));
    return `<span class="chip ${on ? 'on' : ''}" data-g="${esc(n)}">${esc(n)} · ${groups[n].length}<i data-gdel="${esc(n)}" title="Delete group">×</i></span>`;
  }).join('');
}

let swapHtml = '';
function renderSwap() {
  if (!$('#swap').open) return;
  const known = new Set(devices.map((d) => d.mac));
  const orphans = new Set([...schedules.map((s) => s.mac), ...Object.keys(nicks), ...Object.values(groups).flat()].filter((m) => !known.has(m)));
  const opt = (v, t) => `<option value="${esc(v)}">${esc(t)}</option>`;
  const from = [...orphans].map((m) => opt(m, `${nicks[m] || m} (not on network)`)).join('') +
    [...devices].sort((a, b) => a.connected - b.connected || a.name.localeCompare(b.name)).map((d) => opt(d.mac, d.name + (d.connected ? '' : ' (offline)'))).join('');
  const to = [...devices].sort((a, b) => b.connected - a.connected || a.name.localeCompare(b.name)).map((d) => opt(d.mac, `${d.name} · ${d.ip || d.mac}`)).join('');
  if (from + '|' + to === swapHtml) return;
  swapHtml = from + '|' + to;
  const f = $('#sw-from').value, t = $('#sw-to').value;
  $('#sw-from').innerHTML = from;
  $('#sw-to').innerHTML = to;
  if (f) $('#sw-from').value = f;
  if (t) $('#sw-to').value = t;
}
$('#swap').ontoggle = renderSwap;

$('#swap-form').onsubmit = async (e) => {
  e.preventDefault();
  const from = $('#sw-from').value, to = $('#sw-to').value;
  if (!from || !to || from === to) return toast('Pick two different devices', 'err');
  const nSched = schedules.filter((s) => s.mac === from).length;
  const hasNick = !!nicks[from];
  const inGroups = Object.keys(groups).filter((n) => groups[n].includes(from));
  if (!nSched && !hasNick && !inGroups.length) return toast('Nothing to move for that device', 'err');

  const moved = [];
  if (nSched) {
    await saveSchedules(schedules.map((s) => (s.mac === from ? { ...s, mac: to } : s)));
    if (schedules.some((s) => s.mac === from)) return;
    moved.push(`${nSched} schedule${nSched > 1 ? 's' : ''}`);
  }
  if (hasNick) {
    nicks[to] = nicks[from];
    delete nicks[from];
    save('nicks', nicks);
    moved.push('nickname');
  }
  if (inGroups.length) {
    inGroups.forEach((n) => { groups[n] = [...new Set(groups[n].map((m) => (m === from ? to : m)))]; });
    save('groups', groups);
    moved.push(`${inGroups.length} group${inGroups.length > 1 ? 's' : ''}`);
  }
  devices = devices.map((d) => ({ ...d, name: nicks[d.mac] || d.orig }));
  if (selected.delete(from)) selected.add(to);
  gridHtml = '';
  swapHtml = '';
  renderAll();
  toast(`Moved ${moved.join(', ')} to ${nameOf(to)}`);
};

function renderAll() { renderStats(); renderGrid(); renderSched(); renderGroups(); renderSwap(); }

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
    devices = (await invoke('devices')).map(withNick);
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
  if (a === 'block' && !confirmed(b)) return;
  busy.add(m);
  renderGrid();
  try {
    await invoke('device_action', { mac: m, action: a });
    applyLocal(m, a);
  } catch (x) { toast(String(x), 'err'); }
  busy.delete(m);
  renderAll();
  setTimeout(refresh, 1500);
};

$('#grid').onchange = async (e) => {
  const t = e.target.closest('select[data-timer]');
  if (t) {
    if (!t.value) return;
    const mac = t.dataset.timer;
    busy.add(mac);
    renderGrid();
    try {
      await invoke('pause_for', { mac, minutes: Number(t.value) });
      await refresh();
    } catch (x) { toast(String(x), 'err'); }
    busy.delete(mac);
    renderAll();
    return;
  }
  const c = e.target.closest('input[data-sel]');
  if (!c) return;
  c.checked ? selected.add(c.dataset.sel) : selected.delete(c.dataset.sel);
  renderGrid();
  renderSched();
  renderGroups();
};

$('#grid').ondblclick = (e) => {
  const h = e.target.closest('h3[data-mac]');
  const d = h && devices.find((x) => x.mac === h.dataset.mac);
  if (!d) return;
  const inp = document.createElement('input');
  inp.className = 'nick';
  inp.maxLength = 40;
  inp.value = d.name;
  h.replaceWith(inp);
  inp.focus();
  inp.select();
  editing = true;
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    editing = false;
    if (ok) {
      const v = inp.value.trim();
      if (v && v !== d.orig) nicks[d.mac] = v; else delete nicks[d.mac];
      save('nicks', nicks);
      d.name = nicks[d.mac] || d.orig;
    }
    gridHtml = '';
    renderAll();
  };
  inp.onkeydown = (k) => { if (k.key === 'Enter') finish(true); else if (k.key === 'Escape') finish(false); };
  inp.onblur = () => finish(true);
};

$('#group-chips').onclick = (e) => {
  const x = e.target.closest('[data-gdel]');
  if (x) { delete groups[x.dataset.gdel]; save('groups', groups); return renderGroups(); }
  const c = e.target.closest('[data-g]');
  if (!c) return;
  const m = groups[c.dataset.g];
  const same = m.length === selected.size && m.every((a) => selected.has(a));
  selected = same ? new Set() : new Set(m);
  renderGrid();
  renderSched();
  renderGroups();
};
$('#group-form').onsubmit = (e) => {
  e.preventDefault();
  const n = $('#gname').value.trim();
  if (!n) return;
  groups[n] = [...selected];
  save('groups', groups);
  $('#gname').value = '';
  renderGroups();
};

$('#chips').onclick = (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  filter = c.dataset.f;
  document.querySelectorAll('#chips .chip').forEach((x) => x.classList.toggle('on', x === c));
  renderGrid();
};
$('#q').oninput = (e) => { query = e.target.value; renderGrid(); };

$('#days').onclick = (e) => {
  const c = e.target.closest('.chip');
  if (c) return c.classList.toggle('on');
  const p = e.target.closest('[data-p]');
  if (!p) return;
  const on = p.dataset.p.split(',');
  document.querySelectorAll('#days .chip').forEach((x) => x.classList.toggle('on', on.includes(x.dataset.d)));
};

$('#sched-form').onsubmit = (e) => {
  e.preventDefault();
  const days = [...document.querySelectorAll('#days .chip.on')].map((x) => Number(x.dataset.d));
  if (!days.length) return toast('Pick at least one day', 'err');
  const fields = { action: $('#sa').value, time: $('#st').value, days: days.length === 7 ? [] : days };
  if (editIdx !== null) {
    const mac = $('#sm').value;
    if (!mac) return toast('Clear the device selection to edit a schedule', 'err');
    const i = editIdx;
    const next = schedules.map((s, n) => (n === i ? { ...s, mac, ...fields } : s));
    endEdit();
    return saveSchedules(next);
  }
  const macs = selected.size ? [...selected] : [$('#sm').value];
  if (!macs[0]) return;
  const add = macs.map((mac) => ({ mac, ...fields, enabled: true }));
  selected.clear();
  saveSchedules([...schedules, ...add]);
  renderGrid();
  renderGroups();
};
function endEdit() {
  editIdx = null;
  $('#sched-submit').textContent = 'Add';
  $('#sched-cancel').hidden = true;
  renderSched();
}
$('#sched-cancel').onclick = endEdit;

$('#sched-list').onclick = (e) => {
  const del = e.target.closest('[data-del]');
  const ed = e.target.closest('[data-edit]');
  const tog = e.target.closest('[data-tog]');
  if (del) {
    if (editIdx !== null) endEdit();
    saveSchedules(schedules.filter((_, i) => i !== Number(del.dataset.del)));
  } else if (tog) {
    const n = Number(tog.dataset.tog);
    saveSchedules(schedules.map((s, i) => (i === n ? { ...s, enabled: s.enabled === false } : s)));
  } else if (ed) {
    const s = schedules[Number(ed.dataset.edit)];
    editIdx = Number(ed.dataset.edit);
    selected.clear();
    renderGrid();
    renderSched();
    renderGroups();
    $('#sm').value = s.mac;
    $('#sa').value = s.action;
    $('#st').value = s.time;
    document.querySelectorAll('#days .chip').forEach((x) => x.classList.toggle('on', !s.days?.length || s.days.includes(Number(x.dataset.d))));
    $('#sched-submit').textContent = 'Save';
    $('#sched-cancel').hidden = false;
  }
};

async function bulk(call, ok) {
  const macs = [...selected];
  macs.forEach((m) => busy.add(m));
  renderGrid();
  const res = await Promise.allSettled(macs.map(call));
  res.forEach((r, i) => { if (r.status === 'fulfilled') ok(macs[i]); });
  const bad = res.filter((r) => r.status === 'rejected');
  if (bad.length) toast(`${bad.length} of ${macs.length} failed: ${bad[0].reason}`, 'err');
  macs.forEach((m) => busy.delete(m));
  renderAll();
  setTimeout(refresh, 1500);
}
$('#bulk').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'bulk-clear') {
    selected.clear();
    renderGrid();
    renderSched();
    return renderGroups();
  }
  const a = b.dataset.b;
  if (!a || (a === 'block' && !confirmed(b))) return;
  await bulk((mac) => invoke('device_action', { mac, action: a }), (mac) => applyLocal(mac, a));
};
$('#bulk-timer').onchange = async (e) => {
  const minutes = Number(e.target.value);
  e.target.value = '';
  if (minutes) await bulk((mac) => invoke('pause_for', { mac, minutes }), (mac) => applyLocal(mac, 'pause'));
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
