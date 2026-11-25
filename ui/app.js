// Runs inside the Tauri desktop app, or in a browser served by tollgate-server, which takes the same commands over HTTP.
const TAURI = window.__TAURI__;
const invoke = TAURI ? TAURI.core.invoke : async (cmd, args = {}) => {
  const r = await fetch(`api/${cmd}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const v = await r.json().catch(() => null);
  if (!r.ok) throw (v && v.error) || `Server said ${r.status}`;
  return v;
};
const listen = TAURI ? TAURI.event.listen : (name, fn) => {
  new EventSource('api/events').addEventListener(name, (m) => fn({ payload: JSON.parse(m.data) }));
};
const win = TAURI ? TAURI.window.getCurrentWindow() : null;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const REFRESH_MS = 15000;
const ACTION_LABEL = { pause: 'Pause', unpause: 'Resume', block: 'Block', unblock: 'Unblock' };
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const RULE_COLORS = ['#6366f1', '#f59e0b', '#06b6d4', '#ec4899', '#22c55e', '#8b5cf6', '#ef4444'];

const ICON = {
  tablet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M11 18h2"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8"/>',
  laptop: '<rect x="5" y="5" width="14" height="10" rx="1.5"/><path d="M3 19h18"/>',
  game: '<path d="M7 8h10a4 4 0 0 1 4 4v1a3 3 0 0 1-5.4 1.8L14.5 14h-5l-1.1 1.8A3 3 0 0 1 3 13v-1a4 4 0 0 1 4-4Z"/><path d="M8 10.5v3M6.5 12h3"/>',
  speaker: '<rect x="6" y="3" width="12" height="18" rx="3"/><circle cx="12" cy="14" r="3"/><path d="M12 7h.01"/>',
  other: '<circle cx="12" cy="12" r="3"/><path d="M5 5l3 3M19 5l-3 3M5 19l3-3M19 19l-3-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chev: '<path d="M9 6l6 6-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Z"/>',
  play: '<path d="M7 5l12 7-12 7V5Z"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  check: '<path d="M5 12l5 5L20 7"/>',
  swap: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5A6.5 6.5 0 0 1 21.5 20"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
};
const svg = (k, cls = '') => `<svg viewBox="0 0 24 24" aria-hidden="true"${cls ? ` class="${cls}"` : ''}>${ICON[k]}</svg>`;

// ---------- state ----------
let devices = [];
let schedules = [];
let tab = 'devices';
let gfilter = 'all';
let query = '';
let selecting = false;
let selected = new Set();
const busy = new Set();
let sheet = null;
let lastOk = 0;
let loading = false;
let health = null;
let pinned = false;

// Nicknames, groups and new-device tracking are kept by the backend (prefs.json), so every browser sees the same ones.
// Writes go out one at a time, and only when a value changed.
const PREF_KEYS = ['nicks', 'groups', 'seenInfo', 'known', 'unseen'];
const sent = {};
let writes = Promise.resolve();
let pendingWrites = 0;
const save = (k, v) => {
  const j = JSON.stringify(v ?? null);
  if (sent[k] === j) return;
  sent[k] = j;
  pendingWrites++;
  writes = writes
    .then(() => invoke('set_pref', { key: k, value: v ?? null }))
    .catch((e) => { delete sent[k]; toast(`Could not save: ${e}`, 'err'); })
    .finally(() => pendingWrites--);
};
let nicks = {};
let groups = {};
let seenInfo = {};
let known = null;
let unseen = new Set();
const withNick = (d) => ({ ...d, orig: d.name, name: nicks[d.mac] || d.name });

async function loadPrefs() {
  if (pendingWrites) return;
  let p = await invoke('get_prefs');
  if (!Object.keys(p).length) {
    // first run after the move off localStorage: carry over what this window saved before
    const old = {};
    for (const k of PREF_KEYS) { try { const v = JSON.parse(localStorage.getItem(k)); if (v != null) old[k] = v; } catch {} }
    for (const k of Object.keys(old)) await invoke('set_pref', { key: k, value: old[k] });
    p = old;
  }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  nicks = obj(p.nicks);
  groups = obj(p.groups);
  seenInfo = obj(p.seenInfo);
  known = Array.isArray(p.known) && p.known.length ? new Set(p.known) : null;
  unseen = new Set(Array.isArray(p.unseen) ? p.unseen : []);
  for (const k of PREF_KEYS) sent[k] = JSON.stringify(p[k] ?? null);
}

// ---------- small helpers ----------
function toast(msg, kind = '', onClick) {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  if (onClick) { t.classList.add('act'); t.setAttribute('role', 'button'); t.tabIndex = 0; t.onclick = () => { onClick(); t.remove(); }; }
  $('#toasts').append(t);
  setTimeout(() => t.remove(), onClick ? 12000 : 4500);
}
const t12 = (t) => { const [h, m] = t.split(':').map(Number); return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'am' : 'pm'}`; };
const hhmm = (date) => date.toTimeString().slice(0, 5);
const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const inDays = (days, d) => !days || !days.length || days.includes(d);
const fmtIn = (m) => (m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} m` : ''}`);
const daysLabel = (days) => {
  const k = [...(days || [])].sort().join();
  const named = { '': 'Every day', '0,1,2,3,4,5,6': 'Every day', '1,2,3,4,5': 'Weekdays', '0,6': 'Weekends', '0,1,2,3,4': 'Sun–Thu', '1,2,3,4,5,6': 'Mon–Sat' };
  if (k in named) return named[k];
  if (days.length === 1) return DAY_LONG[days[0]] + 's';
  return [...days].sort().map((d) => DAY[d]).join(', ');
};
// minutes from now until a schedule entry next runs
function minsUntil(s, now = new Date()) {
  const base = toMin(s.time) - now.getHours() * 60 - now.getMinutes();
  for (let i = 0; i < 8; i++) {
    const t = base + i * 1440;
    if (t > 0 && inDays(s.days, (now.getDay() + i) % 7)) return t;
  }
  return Infinity;
}
const confirmed = (btn) => {
  if (btn.dataset.armed) return true;
  const label = btn.innerHTML;
  btn.dataset.armed = '1';
  btn.textContent = 'Tap again to confirm';
  btn.classList.add('armed');
  setTimeout(() => { if (!btn.isConnected) return; delete btn.dataset.armed; btn.innerHTML = label; btn.classList.remove('armed'); }, 3000);
  return false;
};
const state = (d) => (d.blocked ? 'blocked' : d.paused ? 'paused' : d.connected ? 'online' : 'offline');
const byMac = (mac) => devices.find((d) => d.mac === mac);
const nameOf = (mac) => byMac(mac)?.name || nicks[mac] || seenInfo[mac]?.name || mac;
function kind(d) {
  const s = `${d.name} ${d.orig || ''} ${d.maker || ''}`.toLowerCase();
  if (/\b(tv|roku|chromecast|fire ?stick|apple ?tv|bravia|shield|projector)\b/.test(s)) return 'tv';
  if (/(switch|xbox|playstation|ps[345]|nintendo|steam ?deck|quest|oculus)/.test(s)) return 'game';
  if (/(macbook|laptop|notebook|thinkpad|surface|desktop|\bpc\b|imac|mac ?mini|chromebook|dell|lenovo|asus|acer|\bhp\b)/.test(s)) return 'laptop';
  if (/(echo|alexa|speaker|sonos|homepod|nest|google home|amazon)/.test(s)) return 'speaker';
  if (/(phone|ipad|tablet|galaxy|pixel|android|apple|samsung|oneplus|xiaomi|oppo|huawei|motorola|kindle)/.test(s)) return 'tablet';
  return 'other';
}
const devIcon = (d, big) => `<span class="dev-ic ${kind(d)}${big ? ' big' : ''}">${svg(kind(d))}</span>`;
function statusText(d) {
  const st = state(d);
  if (st === 'blocked') return 'Blocked';
  if (st === 'paused') {
    if (d.resume_at) return `Paused · back at ${t12(hhmm(new Date(d.resume_at * 1000)))}`;
    const nx = schedules.filter((s) => s.mac === d.mac && s.action === 'unpause' && s.enabled !== false).map((s) => [minsUntil(s), s]).sort((a, b) => a[0] - b[0])[0];
    return nx && nx[0] < 1440 ? `Paused · back at ${t12(nx[1].time)}` : 'Paused';
  }
  if (st === 'online') return `Online · ${d.wired ? 'Wired' : 'Wi-Fi'}`;
  return 'Offline';
}

// ---------- schedules: the backend keeps flat entries; the UI groups them into rules by their `rule` id ----------
const newId = () => 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const shiftDays = (days) => (days.length ? days.map((d) => (d + 1) % 7).sort() : []);
function rulesOf(list) {
  const map = new Map();
  for (const s of list) {
    if (!map.has(s.rule)) map.set(s.rule, { id: s.rule, name: s.name || '', group: s.group || '', entries: [] });
    map.get(s.rule).entries.push(s);
  }
  const rules = [...map.values()].map((r) => {
    const p = r.entries.find((e) => e.action === 'pause');
    const u = r.entries.find((e) => e.action === 'unpause');
    const range = !!(p && u && r.entries.every((e) => e.action === 'pause' || e.action === 'unpause'));
    const first = range ? p : r.entries[0];
    return { ...r, range, action: first.action, start: first.time, end: range ? u.time : null, days: first.days || [], enabled: r.entries.some((e) => e.enabled !== false), macs: [...new Set(r.entries.map((e) => e.mac))] };
  });
  return rules.sort((a, b) => toMin(a.start) - toMin(b.start) || a.name.localeCompare(b.name));
}
function entriesFor(r) {
  const days = r.days.length === 7 ? [] : [...r.days].sort();
  const base = { enabled: r.enabled, rule: r.id };
  if (r.name) base.name = r.name;
  if (r.group) base.group = r.group;
  return r.macs.flatMap((mac) => (r.range
    ? [{ mac, action: 'pause', time: r.start, days, ...base }, { mac, action: 'unpause', time: r.end, days: r.end <= r.start ? shiftDays(days) : days, ...base }]
    : [{ mac, action: r.action, time: r.start, days, ...base }]));
}
const ruleById = (id) => rulesOf(schedules).find((r) => r.id === id);
const whoShort = (r) => (r.group ? r.group : r.macs.length === 1 ? nameOf(r.macs[0]) : `${r.macs.length} devices`);
const whoLong = (r) => (r.group ? `${r.group} (${r.macs.length} device${r.macs.length === 1 ? '' : 's'})` : whoShort(r));
const ruleTitle = (r) => r.name || (r.range ? `Offline: ${whoShort(r)}` : `${ACTION_LABEL[r.action]} ${whoShort(r)}`);
const ruleTime = (r) => (r.range ? `${t12(r.start)} – ${t12(r.end)}` : t12(r.start));

async function saveSchedules(items) {
  try {
    await invoke('set_schedules', { items });
    schedules = items;
    render();
    return true;
  } catch (e) { toast(String(e), 'err'); return false; }
}
const replaceRule = (id, rule) => saveSchedules([...schedules.filter((s) => s.rule !== id), ...(rule ? entriesFor(rule) : [])]);
// a schedule made for a group follows that group's members
function groupRulesFollow(oldName, newName) {
  const rules = rulesOf(schedules).filter((r) => r.group === oldName);
  if (!rules.length) return;
  let items = schedules.filter((s) => !rules.some((r) => r.id === s.rule));
  for (const r of rules) {
    const macs = newName ? groups[newName] || [] : r.macs;
    items = items.concat(entriesFor({ ...r, group: newName || '', macs }));
  }
  saveSchedules(items);
}

// Schedules saved before rules existed have no `rule` id. Give each its own, and pair a pause with the resume that ends it.
function linkLegacy(list) {
  const out = list.map((s, i) => (s.rule ? s : { ...s, rule: `x${i}`, legacy: true }));
  const same = (a, b) => [...a].sort().join() === [...b].sort().join();
  for (const p of out.filter((s) => s.legacy && s.action === 'pause')) {
    const u = out.find((s) => s.legacy && !s.paired && s.action === 'unpause' && s.mac === p.mac && s.enabled === p.enabled &&
      (same(s.days || [], p.days || []) && s.time > p.time || s.time <= p.time && same(s.days || [], shiftDays(p.days || []))));
    if (u) { u.rule = p.rule; u.paired = true; p.paired = true; }
  }
  return out.map(({ legacy, paired, ...s }) => s);
}

// ---------- refresh and new-device tracking ----------
const ruledMacs = () => new Set([...schedules.map((s) => s.mac), ...Object.keys(nicks), ...Object.values(groups).flat()]);
function persist() {
  save('known', known && [...known]);
  save('unseen', [...unseen]);
  save('seenInfo', seenInfo);
}
function ack(mac) {
  if (!unseen.delete(mac)) return;
  if (!known) known = new Set(devices.map((d) => d.mac));
  known.add(mac);
  persist();
}
function lookalike(d) {
  const present = new Set(devices.map((x) => x.mac));
  const orphans = [...ruledMacs()].filter((m) => !present.has(m));
  return orphans.find((m) => (seenInfo[m]?.name && seenInfo[m].name === d.orig) || (seenInfo[m]?.maker && d.maker && seenInfo[m].maker === d.maker));
}
function detectNew(list) {
  const ruled = ruledMacs();
  if (known) {
    list.filter((d) => !known.has(d.mac) && !unseen.has(d.mac)).forEach((d) => {
      unseen.add(d.mac);
      if (sheet?.type !== 'review') toast(`New device joined: ${d.name}. Tap to review.`, '', () => openSheet({ type: 'review' }));
    });
  }
  list.filter((d) => ruled.has(d.mac)).forEach((d) => { seenInfo[d.mac] = { name: d.orig, maker: d.maker }; });
  persist();
}
function markUpdated() { lastOk = Date.now(); $('#live').classList.remove('stale'); tick(); }
function tick() {
  if (!lastOk) return;
  const s = Math.round((Date.now() - lastOk) / 1000);
  $('#updated').textContent = s < 5 ? 'Live · updated just now' : `Updated ${s < 60 ? s + ' s' : Math.round(s / 60) + ' min'} ago`;
  $('#live').classList.toggle('stale', s > REFRESH_MS / 500);
}
async function refresh(manual = false) {
  if (loading) return;
  loading = true;
  if (manual) $('#refresh').classList.add('spin');
  try {
    await loadPrefs();
    devices = (await invoke('devices')).map(withNick);
    detectNew(devices);
    markUpdated();
    if (!TAURI) health = await fetch('api/health').then((r) => r.json()).catch(() => null);
    render();
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

// ---------- device actions ----------
function applyLocal(mac, a) {
  const d = byMac(mac);
  if (!d) return;
  if (a === 'pause' || a === 'unpause') { d.paused = a === 'pause'; if (a === 'unpause') d.resume_at = null; } else d.blocked = a === 'block';
}
async function run(macs, call, local) {
  macs.forEach((m) => busy.add(m));
  render();
  const res = await Promise.allSettled(macs.map(call));
  res.forEach((r, i) => { if (r.status === 'fulfilled') local(macs[i]); });
  const bad = res.filter((r) => r.status === 'rejected');
  if (bad.length) toast(macs.length > 1 ? `${bad.length} of ${macs.length} failed: ${bad[0].reason}` : String(bad[0].reason), 'err');
  macs.forEach((m) => busy.delete(m));
  render();
  setTimeout(refresh, 1500);
  return !bad.length;
}
const act = (macs, action) => run(macs, (mac) => invoke('device_action', { mac, action }), (mac) => applyLocal(mac, action));
const pauseFor = (macs, minutes) => run(macs, (mac) => invoke('pause_for', { mac, minutes }), (mac) => { applyLocal(mac, 'pause'); const d = byMac(mac); if (d) d.resume_at = Math.floor(Date.now() / 1000) + minutes * 60; });
const minsTo7 = () => { const now = new Date(); let m = 7 * 60 - (now.getHours() * 60 + now.getMinutes()); if (m <= 0) m += 1440; return m; };

function moveSettings(from, to) {
  const nSched = new Set(schedules.filter((s) => s.mac === from).map((s) => s.rule)).size;
  const hasNick = !!nicks[from];
  const inGroups = Object.keys(groups).filter((n) => groups[n].includes(from));
  const moved = [];
  if (nSched) {
    saveSchedules(schedules.map((s) => (s.mac === from ? { ...s, mac: to } : s)));
    moved.push(`${nSched} schedule${nSched > 1 ? 's' : ''}`);
  }
  if (hasNick) { nicks[to] = nicks[from]; delete nicks[from]; save('nicks', nicks); moved.push('name'); }
  if (inGroups.length) {
    inGroups.forEach((n) => { groups[n] = [...new Set(groups[n].map((m) => (m === from ? to : m)))]; });
    save('groups', groups);
    moved.push(`${inGroups.length} group${inGroups.length > 1 ? 's' : ''}`);
  }
  devices = devices.map((d) => ({ ...d, name: nicks[d.mac] || d.orig }));
  if (!moved.length) { toast('Nothing to move for that device', 'err'); return false; }
  ack(to);
  toast(`Moved ${moved.join(', ')} to ${nameOf(to)}`);
  render();
  return true;
}
function movable(from) {
  const out = [];
  if (nicks[from]) out.push(`The name “${nicks[from]}”`);
  const rules = rulesOf(schedules).filter((r) => r.macs.includes(from));
  if (rules.length) out.push(`${rules.length} schedule${rules.length > 1 ? 's' : ''} (${rules.map(ruleTitle).join(', ')})`);
  const gs = Object.keys(groups).filter((n) => groups[n].includes(from));
  if (gs.length) out.push(`The ${gs.join(', ')} group${gs.length > 1 ? 's' : ''}`);
  return out;
}

// ---------- rendering ----------
let lastHtml = {};
const put = (sel, html) => { if (lastHtml[sel] === html) return; lastHtml[sel] = html; $(sel).innerHTML = html; };

function render() {
  if ($('#login').hidden === false) return;
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = t.id !== `tab-${tab}`; });
  document.querySelectorAll('#tabbar button').forEach((b) => { b.classList.toggle('on', b.dataset.tab === tab); b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false'); });
  $('#tabbar').hidden = selecting;
  if (tab === 'devices') renderDevices();
  if (tab === 'schedules') renderSchedules();
  if (tab === 'settings') renderSettings();
  renderSelbar();
  if (sheet && sheet.live && !document.activeElement?.closest('#sheet input, #sheet select')) renderSheet();
}

function renderDevices() {
  const on = devices.filter((d) => state(d) === 'online').length;
  const paused = devices.filter((d) => d.paused && !d.blocked).length;
  const blocked = devices.filter((d) => d.blocked).length;
  const off = devices.filter((d) => state(d) === 'offline').length;
  put('#summary', [`${on} online`, paused && `${paused} paused`, blocked && `${blocked} blocked`, off && `${off} offline`].filter(Boolean).join(' · ') || 'No devices yet');

  // next schedule
  const next = schedules.filter((s) => s.enabled !== false).map((s) => [minsUntil(s), s]).sort((a, b) => a[0] - b[0])[0];
  if (next && next[0] < Infinity) {
    const r = ruleById(next[1].rule);
    const verb = ACTION_LABEL[next[1].action].toLowerCase();
    const who = `${r ? whoShort(r) : nameOf(next[1].mac)} at ${t12(next[1].time)}`;
    const title = r && r.name ? `${r.name}: ${verb} ${who}` : `${ACTION_LABEL[next[1].action]} ${who}`;
    put('#next', `<button class="card next" data-do="tab" data-tab="schedules"><span class="badge">${svg('clock')}</span><span class="txt"><span class="eyebrow">Next up · ${fmtIn(next[0])}</span><b>${esc(title)}</b></span>${svg('chev', 'chev')}</button>`);
  } else put('#next', '');

  // banners
  const fresh = devices.filter((d) => unseen.has(d.mac));
  let b = '';
  if (fresh.length) b += `<button class="banner" data-do="review"><span>${fresh.length} new device${fresh.length > 1 ? 's' : ''} joined</span><span class="pill">Review</span></button>`;
  if (!known && devices.length) b += `<button class="banner quiet" data-do="seed"><span>${devices.length} devices found. Mark them as known so new ones stand out.</span><span class="pill">Mark known</span></button>`;
  put('#banners', b);

  // group chips
  if (gfilter !== 'all' && !groups[gfilter]) gfilter = 'all';
  const names = Object.keys(groups).sort();
  put('#group-chips', `<button class="chip ${gfilter === 'all' ? 'on' : ''}" role="tab" aria-selected="${gfilter === 'all'}" data-do="filter" data-g="all">All · ${devices.length}</button>` +
    names.map((n) => `<button class="chip ${gfilter === n ? 'on' : ''}" role="tab" aria-selected="${gfilter === n}" data-do="filter" data-g="${esc(n)}">${esc(n)} · ${groups[n].length}</button>`).join('') +
    `<button class="chip add" data-do="new-group">+ Group</button>`);
  $('#select-btn').textContent = selecting ? 'Done' : 'Select';

  // group card
  if (gfilter !== 'all') {
    const members = groups[gfilter].map(byMac).filter(Boolean);
    const gOn = members.filter((d) => state(d) === 'online').length;
    const gPaused = members.filter((d) => d.paused && !d.blocked).length;
    const gr = rulesOf(schedules).filter((r) => r.group === gfilter && r.enabled);
    const facts = [`${gOn} online`, gPaused && `${gPaused} paused`, gr[0] && `${ruleTitle(gr[0])} at ${t12(gr[0].start)}`].filter(Boolean).join(' · ');
    const dis = members.length ? '' : 'disabled';
    put('#group-card', `<div class="card gcard">
      <div class="gcard-head"><div><h2>${esc(gfilter)}</h2><p>${esc(facts)}</p></div><button class="icon round" data-do="edit-group" data-g="${esc(gfilter)}" aria-label="Edit ${esc(gfilter)}">${svg('edit')}</button></div>
      <div class="grid2"><button class="btn block primary" data-do="group-act" data-a="pause" ${dis}>${svg('pause')}Pause all</button><button class="btn block" data-do="group-act" data-a="unpause" ${dis}>${svg('play')}Resume all</button></div>
      <div class="inline">Pause all for <button class="btn sm" data-do="group-for" data-min="30" ${dis}>30 min</button><button class="btn sm" data-do="group-for" data-min="60" ${dis}>1 h</button><button class="btn sm" data-do="group-for" data-min="120" ${dis}>2 h</button></div>
    </div>`);
  } else put('#group-card', '');

  // list
  const q = query.toLowerCase();
  const rank = { online: 0, paused: 1, blocked: 2, offline: 3 };
  const inGroup = gfilter === 'all' ? null : new Set(groups[gfilter]);
  const shown = devices
    .filter((d) => (!inGroup || inGroup.has(d.mac)) && (!q || `${d.name} ${d.orig} ${d.ip} ${d.maker} ${d.mac}`.toLowerCase().includes(q)))
    .sort((a, b) => (unseen.has(b.mac) - unseen.has(a.mac)) || rank[state(a)] - rank[state(b)] || a.name.localeCompare(b.name));
  put('#list', shown.length ? shown.map(row).join('') : `<p class="empty">${q ? 'No devices match.' : inGroup ? 'No devices in this group yet. Tap the pencil to add some.' : 'No devices found.'}</p>`);
}

function row(d) {
  const st = state(d);
  const dis = busy.has(d.mac) ? 'disabled' : '';
  const sel = selected.has(d.mac);
  let btn = '';
  if (!selecting) {
    if (st === 'blocked') btn = `<button class="btn danger" data-do="act" data-mac="${esc(d.mac)}" data-a="unblock" ${dis}>Unblock</button>`;
    else if (d.paused) btn = `<button class="btn resume" data-do="act" data-mac="${esc(d.mac)}" data-a="unpause" ${dis}>Resume</button>`;
    else btn = `<button class="btn" data-do="act" data-mac="${esc(d.mac)}" data-a="pause" ${dis}>Pause</button>`;
  }
  return `<div class="row ${st}${sel ? ' sel' : ''}" data-row="${esc(d.mac)}">
    ${selecting ? `<input type="checkbox" class="pick" data-do="pick" data-mac="${esc(d.mac)}" aria-label="Select ${esc(d.name)}" ${sel ? 'checked' : ''}>` : ''}
    <button class="open" data-do="${selecting ? 'pick' : 'open'}" data-mac="${esc(d.mac)}">${devIcon(d)}<span class="dev-txt"><span class="dev-name">${esc(d.name)}${unseen.has(d.mac) ? '<span class="newtag">New</span>' : ''}</span><span class="status ${st}">${esc(statusText(d))}</span></span></button>
    ${btn}</div>`;
}

function renderSelbar() {
  $('#selbar').hidden = !selecting;
  if (!selecting) return;
  const n = selected.size;
  const dis = n ? '' : 'disabled';
  put('#selbar', `<div class="top"><span>${n ? `${n} selected` : 'Tap devices to select them'}</span><button class="link" data-do="select-done">Done</button></div>
    <div class="acts"><button class="btn primary" data-do="sel-act" data-a="pause" ${dis}>Pause</button><button class="btn" data-do="sel-act" data-a="unpause" ${dis}>Resume</button>
    <button class="btn" data-do="sel-for" data-min="30" ${dis}>30 min</button><button class="btn" data-do="sel-for" data-min="60" ${dis}>1 h</button><button class="btn" data-do="sel-for" data-min="120" ${dis}>2 h</button>
    <button class="btn" data-do="sel-group" ${dis}>Add to group</button><button class="btn danger" data-do="sel-act" data-a="block" ${dis}>Block</button><button class="btn" data-do="sel-act" data-a="unblock" ${dis}>Unblock</button></div>`);
}

function renderSchedules() {
  const rules = rulesOf(schedules);
  const live = rules.filter((r) => r.enabled).length;
  put('#sched-sub', TAURI ? 'They run while this app is open.' : 'They run on the server, even when your phone is off.');

  // today's timeline
  const now = new Date();
  const today = now.getDay();
  const yday = (today + 6) % 7;
  const bars = [];
  rules.forEach((r, i) => {
    if (!r.enabled) return;
    const c = RULE_COLORS[i % RULE_COLORS.length];
    const s = toMin(r.start);
    if (r.range) {
      const e = toMin(r.end);
      if (inDays(r.days, today)) bars.push([s, e > s ? e : 1440, c]);
      if (e <= s && inDays(r.days, yday)) bars.push([0, e, c]);
    } else if (inDays(r.days, today)) bars.push([s, s + 6, c]);
  });
  const pct = (m) => (m / 14.4).toFixed(2);
  put('#today', rules.length ? `<div class="card today"><div class="today-head"><h2>Today, ${DAY_LONG[today]}</h2><span>${live} of ${rules.length} on</span></div>
    <div class="bar" role="img" aria-label="Today's schedules on a 24 hour line">${bars.map(([a, b, c]) => `<i style="left:${pct(a)}%;width:${pct(b - a)}%;background:${c}"></i>`).join('')}<span class="now" style="left:${pct(now.getHours() * 60 + now.getMinutes())}%"></span></div>
    <div class="ticks"><span>12 am</span><span>6 am</span><span>12 pm</span><span>6 pm</span><span>12 am</span></div></div>` : '');

  put('#rules', rules.length ? rules.map((r, i) => `<div class="card rule${r.enabled ? '' : ' off'}">
      <button class="open" data-do="edit-rule" data-id="${esc(r.id)}"><span class="dot" style="background:${r.enabled ? RULE_COLORS[i % RULE_COLORS.length] : 'var(--field)'}"></span>
      <span><span class="time">${esc(ruleTime(r))}</span><span class="name" style="display:block">${esc(ruleTitle(r))}</span><span class="who" style="display:block">${esc(whoLong(r))} · ${esc(daysLabel(r.days))}${r.enabled ? '' : ' · Off'}</span></span></button>
      <button class="switch" role="switch" aria-checked="${r.enabled}" aria-label="${esc(ruleTitle(r))}" data-do="toggle-rule" data-id="${esc(r.id)}"></button></div>`).join('')
    : `<div class="card empty">No schedules yet. Use <b>New schedule</b> to take devices offline at set times, like bedtime or homework.</div>`);
}

function renderSettings() {
  const names = Object.keys(groups).sort();
  const server = TAURI
    ? `<div class="card mrow">${svg('server')}<span class="grow"><span>Desktop app</span><span class="hint">Schedules run while this app is open</span></span></div>`
    : health
      ? `<div class="card mrow">${svg('server')}<span class="grow"><span>Running at ${esc(location.host)}</span><span class="hint">Version ${esc(health.version)} · ${health.signed_in ? 'signed in to eero' : 'not signed in'}</span></span><span class="health ${health.ok ? '' : 'warn'}">${health.ok ? 'Healthy' : 'Check it'}</span></div>`
      : `<div class="card mrow">${svg('server')}<span class="grow"><span>Tollgate server</span><span class="hint">Checking…</span></span></div>`;
  let theme = 'system';
  try { theme = localStorage.getItem('theme') || 'system'; } catch {}
  const seg = ['system', 'light', 'dark'].map((t) => `<button aria-pressed="${theme === t}" data-do="theme" data-t="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('');
  put('#settings', `
    <div class="sect"><h2 class="lbl">${TAURI ? 'Where schedules run' : 'Tollgate server'}</h2>${server}</div>
    <div class="sect"><h2 class="lbl">Groups</h2><div class="menu">
      ${names.map((n) => `<button class="mrow" data-do="edit-group" data-g="${esc(n)}">${svg('people')}<span class="grow">${esc(n)}</span><span class="val">${groups[n].length}</span>${svg('chev', 'chev')}</button>`).join('')}
      <button class="mrow" data-do="new-group">${svg('plus')}<span class="grow">New group</span></button></div></div>
    <div class="sect"><h2 class="lbl">Devices</h2><div class="menu">
      <button class="mrow" data-do="move">${svg('swap')}<span class="grow"><span>Move settings to a new address</span><span class="hint">For a device that came back as a new one</span></span>${svg('chev', 'chev')}</button>
      <button class="mrow" data-do="seed">${svg('check')}<span class="grow"><span>Mark all devices as known</span><span class="hint">${unseen.size ? `${unseen.size} waiting for review` : 'New devices get flagged when they join'}</span></span></button></div></div>
    <div class="sect"><h2 class="lbl">Appearance</h2><div class="seg" role="group" aria-label="Theme">${seg}</div></div>
    ${win ? `<div class="sect"><h2 class="lbl">Window</h2><div class="menu"><div class="mrow"><span class="grow">Keep on top</span><button class="switch" role="switch" aria-checked="${pinned}" aria-label="Keep on top" data-do="pin"></button></div></div></div>` : ''}
    <div class="sect"><h2 class="lbl">eero account</h2><div class="menu"><button class="mrow bad" data-do="logout">Sign out</button></div></div>`);
}

// ---------- sheets ----------
function openSheet(s) {
  sheet = s;
  $('#scrim').hidden = false;
  $('#sheet').hidden = false;
  renderSheet();
  const f = $('#sheet').querySelector('[autofocus]') || $('#sheet').querySelector('button, input, select');
  if (f) f.focus({ preventScroll: true });
}
function closeSheet() {
  sheet = null;
  $('#scrim').hidden = true;
  $('#sheet').hidden = true;
  $('#sheet').innerHTML = '';
  render();
}
function renderSheet() {
  if (!sheet) return;
  const fn = { device: sheetDevice, review: sheetReview, rule: sheetRule, group: sheetGroup, pickgroup: sheetPickGroup, move: sheetMove }[sheet.type];
  const html = fn && fn();
  if (html == null) return closeSheet();
  $('#sheet').innerHTML = `<div class="grab"></div>${html}`;
}
const closeBtn = `<button class="icon round" data-do="close" aria-label="Close">${svg('close')}</button>`;

function sheetDevice() {
  sheet.live = true;
  const d = byMac(sheet.mac);
  if (!d) return null;
  const st = state(d);
  const dis = busy.has(d.mac) ? 'disabled' : '';
  const names = Object.keys(groups).sort();
  const rules = rulesOf(schedules).filter((r) => r.macs.includes(d.mac));
  const title = sheet.renaming
    ? `<form class="namebox" data-form="rename"><input name="nick" maxlength="40" value="${esc(d.name)}" aria-label="Device name" autofocus><button class="btn primary">Save</button></form>`
    : `<h2 id="sheet-title" style="display:flex;align-items:center;gap:4px">${esc(d.name)}<button class="icon" data-do="rename" aria-label="Rename">${svg('edit')}</button></h2>`;
  let primary;
  if (st === 'blocked') primary = `<button class="btn big primary" data-do="act" data-mac="${esc(d.mac)}" data-a="unblock" ${dis}>Unblock</button>`;
  else if (d.paused) primary = `<button class="btn big resume" data-do="act" data-mac="${esc(d.mac)}" data-a="unpause" ${dis}>${svg('play')}Resume now</button>`;
  else primary = `<button class="btn big primary" data-do="act" data-mac="${esc(d.mac)}" data-a="pause" ${dis}>${svg('pause')}Pause now</button>`;
  const until = minsTo7();
  return `<div class="sheet-head">${devIcon(d, true)}<div class="grow">${title}<p class="status ${st}">${esc(statusText(d))}</p></div>${closeBtn}</div>
    ${primary}
    ${st === 'blocked' ? '' : `<div class="field"><span class="flabel">Pause for</span><div class="grid4">
      <button class="btn block" data-do="for" data-min="30" ${dis}>30 min</button><button class="btn block" data-do="for" data-min="60" ${dis}>1 h</button>
      <button class="btn block" data-do="for" data-min="120" ${dis}>2 h</button><button class="btn block" data-do="for" data-min="${until}" ${dis}>Until 7 am</button></div></div>`}
    <div class="field"><span class="flabel">Groups</span><div class="gtoggles">
      ${names.map((n) => `<button class="chip" aria-pressed="${groups[n].includes(d.mac)}" data-do="toggle-member" data-g="${esc(n)}">${esc(n)}</button>`).join('')}
      <button class="chip add" data-do="new-group" data-with="${esc(d.mac)}">+ New group</button></div></div>
    <div class="box">
      <button class="mrow" data-do="dev-schedules">${svg('clock')}<span class="grow"><span>Schedules</span><span class="hint">${rules.length ? esc(rules.map(ruleTitle).join(', ')) : 'None yet. Tap to add one.'}</span></span>${svg('chev', 'chev')}</button>
    </div>
    <dl class="facts">
      <div><dt>IP address</dt><dd>${esc(d.ip || '–')}</dd></div><div><dt>Connection</dt><dd>${d.wired ? 'Wired' : 'Wi-Fi'}</dd></div>
      <div><dt>Maker</dt><dd>${esc(d.maker || 'Unknown')}</dd></div><div><dt>MAC</dt><dd>${esc(d.mac)}</dd></div>
      ${nicks[d.mac] ? `<div><dt>Name on eero</dt><dd>${esc(d.orig)}</dd></div>` : ''}
    </dl>
    ${st === 'blocked' ? '' : `<button class="btn block danger" data-do="block" data-mac="${esc(d.mac)}" ${dis}>${svg('block')}Block from network</button>
    <p class="small">Pause is a break. Block keeps it off until you unblock it.</p>`}
    <button class="link" data-do="move" data-to="${esc(d.mac)}">Replaced an old device? Move its settings here</button>`;
}

function sheetReview() {
  sheet.live = true;
  const list = devices.filter((d) => unseen.has(d.mac));
  if (!list.length) return null;
  const d = list.find((x) => x.mac === sheet.mac) || list[0];
  sheet.mac = d.mac;
  const old = lookalike(d);
  const what = old ? movable(old) : [];
  const oldName = old && (nicks[old] || seenInfo[old]?.name || old);
  return `<div class="bar-head"><span class="eyebrow">New device · ${list.indexOf(d) + 1} of ${list.length}</span>${closeBtn}</div>
    <div class="sheet-head">${devIcon(d, true)}<div class="grow"><h2 id="sheet-title">${esc(d.name)}</h2><p class="muted">${esc([d.maker, d.ip, d.connected ? 'online now' : 'offline'].filter(Boolean).join(' · '))}</p></div></div>
    ${old && what.length ? `<div class="suggest"><div><b>Is this ${esc(oldName)}?</b><p class="muted" style="margin-top:4px;font-size:14px">${esc(oldName)} isn’t on the network any more and looks the same. Devices sometimes get a new address after a reset.</p></div>
      <div class="what"><b>We’ll move over:</b>${what.map((w) => `<span>• ${esc(w)}</span>`).join('')}</div>
      <button class="btn block primary" data-do="review-same" data-old="${esc(old)}">Yes, it’s the same device</button></div>
      <span class="flabel">Or, if it’s something new</span>` : ''}
    ${sheet.renaming ? `<form class="namebox" data-form="review-name"><input name="nick" maxlength="40" value="${esc(d.name)}" aria-label="Device name" autofocus><button class="btn primary">Save</button></form>` : ''}
    <div class="grid2"><button class="btn block" data-do="review-ok">${svg('check')}Looks fine</button><button class="btn block danger" data-do="review-block">${svg('block')}Block it</button></div>
    ${sheet.renaming ? '' : '<button class="link" data-do="review-rename">Give it a name first</button>'}
    <p class="small">Tollgate flags devices it hasn’t seen before so you can check them once.</p>`;
}

function sheetRule() {
  const r = sheet.draft;
  const opts = Object.keys(groups).sort().map((n) => `<option value="g:${esc(n)}" ${r.target === 'g:' + n ? 'selected' : ''}>${esc(n)} (group, ${groups[n].length})</option>`).join('');
  const devs = [...devices].sort((a, b) => a.name.localeCompare(b.name));
  const missing = r.target.startsWith('m:') && !byMac(r.target.slice(2)) ? `<option value="${esc(r.target)}" selected>${esc(nameOf(r.target.slice(2)))} (not on network)</option>` : '';
  const multi = r.target === 'multi' ? `<option value="multi" selected>${r.macs.length} devices</option>` : '';
  const dayBtns = [0, 1, 2, 3, 4, 5, 6].map((d) => `<button type="button" class="day" aria-pressed="${r.days.includes(d)}" aria-label="${DAY_LONG[d]}" data-do="rule-day" data-d="${d}">${DAY[d][0]}</button>`).join('');
  const who = ruleWho(r);
  const daysTxt = r.days.length ? daysLabel(r.days) : 'no days';
  const many = /devices/.test(who);
  const summary = r.range
    ? `${esc(who)} ${many ? 'go' : 'goes'} offline at <b>${t12(r.start)}</b> and ${many ? 'come' : 'comes'} back at <b>${t12(r.end)}</b>${r.end <= r.start ? ' the next morning' : ''}, ${esc(daysTxt)}.`
    : `${ACTION_LABEL[r.action]} ${esc(who)} at <b>${t12(r.start)}</b>, ${esc(daysTxt)}.`;
  return `<div class="bar-head"><button class="link muted" data-do="close">Cancel</button><h2 id="sheet-title">${sheet.id ? 'Edit schedule' : 'New schedule'}</h2><button class="link" data-do="rule-save">Save</button></div>
    <label class="field"><span>Name</span><input data-bind="name" maxlength="40" placeholder="Bedtime, Homework…" value="${esc(r.name)}"></label>
    <label class="field"><span>Who</span><select data-bind="target">${multi}${opts ? `<optgroup label="Groups">${opts}</optgroup>` : ''}<optgroup label="Devices">${missing}${devs.map((d) => `<option value="m:${esc(d.mac)}" ${r.target === 'm:' + d.mac ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</optgroup></select></label>
    <div class="field"><span class="flabel">What</span>
      <div class="seg" role="group" aria-label="Kind of schedule"><button type="button" aria-pressed="${r.range}" data-do="rule-kind" data-range="1">Offline for a while</button><button type="button" aria-pressed="${!r.range}" data-do="rule-kind" data-range="">One action</button></div>
      ${r.range
        ? `<div class="grid2"><label class="timebox"><span>Pause at</span><input type="time" data-bind="start" value="${r.start}" required></label><label class="timebox"><span>Back on at</span><input type="time" data-bind="end" value="${r.end}" required></label></div>`
        : `<div class="grid2"><label class="timebox"><span>Do this</span><select data-bind="action" class="input" style="border:0;height:32px;padding:0;font-size:18px;font-weight:700;background:transparent">${Object.keys(ACTION_LABEL).map((a) => `<option value="${a}" ${r.action === a ? 'selected' : ''}>${ACTION_LABEL[a]}</option>`).join('')}</select></label><label class="timebox"><span>At</span><input type="time" data-bind="start" value="${r.start}" required></label></div>`}
    </div>
    <div class="field"><span class="flabel">Days${r.range ? ' (the day it starts)' : ''}</span><div class="days">${dayBtns}</div>
      <div class="presets"><button type="button" class="btn sm" data-do="rule-preset" data-p="0,1,2,3,4">School nights</button><button type="button" class="btn sm" data-do="rule-preset" data-p="1,2,3,4,5">Weekdays</button><button type="button" class="btn sm" data-do="rule-preset" data-p="0,6">Weekends</button><button type="button" class="btn sm" data-do="rule-preset" data-p="0,1,2,3,4,5,6">Every day</button></div></div>
    <div class="note" id="rule-summary">${summary}</div>
    ${sheet.id ? '<button class="btn block danger" data-do="rule-delete">Delete schedule</button>' : ''}`;
}
function ruleWho(r) {
  if (r.target.startsWith('g:')) { const g = r.target.slice(2); const n = (groups[g] || []).length; return `The ${n} device${n === 1 ? '' : 's'} in ${g}`; }
  if (r.target === 'multi') return `${r.macs.length} devices`;
  return nameOf(r.target.slice(2));
}
function draftFrom(r) {
  if (!r) {
    const firstG = Object.keys(groups).sort()[0];
    const target = selecting && selected.size === 1 ? `m:${[...selected][0]}` : gfilter !== 'all' ? `g:${gfilter}` : firstG ? `g:${firstG}` : devices[0] ? `m:${devices[0].mac}` : '';
    return { name: '', target, macs: [], range: true, action: 'pause', start: '21:00', end: '07:00', days: [0, 1, 2, 3, 4], enabled: true };
  }
  const target = r.group && groups[r.group] ? `g:${r.group}` : r.macs.length === 1 ? `m:${r.macs[0]}` : 'multi';
  return { name: r.name, target, macs: r.macs, range: r.range, action: r.range ? 'pause' : r.action, start: r.start, end: r.end || '07:00', days: r.days.length ? [...r.days] : [0, 1, 2, 3, 4, 5, 6], enabled: r.enabled };
}
async function saveDraft() {
  const r = sheet.draft;
  if (!r.target) return toast('Pick who this is for', 'err');
  if (!r.days.length) return toast('Pick at least one day', 'err');
  if (r.range && r.start === r.end) return toast('Pick two different times', 'err');
  const group = r.target.startsWith('g:') ? r.target.slice(2) : '';
  const macs = group ? groups[group] || [] : r.target === 'multi' ? r.macs : [r.target.slice(2)];
  if (!macs.length) return toast(`${group} has no devices yet`, 'err');
  const rule = { id: sheet.id || newId(), name: r.name.trim(), group, macs, range: r.range, action: r.action, start: r.start, end: r.end, days: r.days, enabled: r.enabled };
  if (await replaceRule(rule.id, rule)) { closeSheet(); toast('Schedule saved'); }
}

function sheetGroup() {
  const g = sheet.draft;
  const devs = [...devices].sort((a, b) => (g.members.has(b.mac) - g.members.has(a.mac)) || a.name.localeCompare(b.name));
  return `<div class="bar-head"><button class="link muted" data-do="close">Cancel</button><h2 id="sheet-title">${sheet.name ? 'Edit group' : 'New group'}</h2><button class="link" data-do="group-save">Save</button></div>
    <label class="field"><span>Name</span><input data-gbind="name" maxlength="24" placeholder="Kids, TVs…" value="${esc(g.name)}" ${sheet.name ? '' : 'autofocus'}></label>
    <div class="field"><span class="flabel">Devices · ${g.members.size} picked</span><div class="box checks">
      ${devs.map((d) => `<label><input type="checkbox" data-do="group-member" data-mac="${esc(d.mac)}" ${g.members.has(d.mac) ? 'checked' : ''}>${esc(d.name)}<span class="status ${state(d)}">${esc(state(d))}</span></label>`).join('') || '<p class="empty">No devices yet.</p>'}
    </div></div>
    ${sheet.name ? '<button class="btn block danger" data-do="group-delete">Delete group</button><p class="small">Its schedules stay, as schedules for each device.</p>' : ''}`;
}
function saveGroup() {
  const g = sheet.draft;
  const name = g.name.trim();
  if (!name) return toast('Give the group a name', 'err');
  if (name !== sheet.name && groups[name]) return toast('There is already a group with that name', 'err');
  const old = sheet.name;
  if (old && old !== name) delete groups[old];
  groups[name] = [...g.members];
  save('groups', groups);
  if (old) groupRulesFollow(old, name); else groupRulesFollow(name, name);
  if (gfilter === old) gfilter = name;
  if (sheet.fromSelection) { selecting = false; selected.clear(); }
  closeSheet();
  toast(old ? `Saved ${name}` : `Made ${name}`);
}

function sheetPickGroup() {
  const names = Object.keys(groups).sort();
  return `<div class="bar-head"><h2 id="sheet-title">Add ${selected.size} to a group</h2>${closeBtn}</div>
    <div class="menu box">${names.map((n) => `<button class="mrow" data-do="pick-group" data-g="${esc(n)}">${svg('people')}<span class="grow">${esc(n)}</span><span class="val">${groups[n].length}</span></button>`).join('')}
    <button class="mrow" data-do="new-group" data-sel="1">${svg('plus')}<span class="grow">New group</span></button></div>`;
}

function sheetMove() {
  const m = sheet;
  const present = new Set(devices.map((d) => d.mac));
  const orphans = [...ruledMacs()].filter((x) => !present.has(x));
  const opt = (v, t, cur) => `<option value="${esc(v)}" ${cur === v ? 'selected' : ''}>${esc(t)}</option>`;
  if (!m.from) m.from = orphans[0] || '';
  const from = `<option value="">Pick one</option>` + orphans.map((x) => opt(x, `${nicks[x] || seenInfo[x]?.name || x} (gone)`, m.from)).join('') +
    [...devices].sort((a, b) => a.connected - b.connected || a.name.localeCompare(b.name)).map((d) => opt(d.mac, d.name + (d.connected ? '' : ' (offline)'), m.from)).join('');
  const to = `<option value="">Pick one</option>` + [...devices].sort((a, b) => b.connected - a.connected || a.name.localeCompare(b.name)).map((d) => opt(d.mac, `${d.name} · ${d.ip || d.mac}`, m.to)).join('');
  const what = m.from ? movable(m.from) : [];
  return `<div class="bar-head"><h2 id="sheet-title">Move settings</h2>${closeBtn}</div>
    <p class="muted">When a device gets a new address it shows up as a new one. Move its name, schedules and groups over.</p>
    <label class="field"><span>From the old entry</span><select data-mbind="from">${from}</select></label>
    <label class="field"><span>To the new one</span><select data-mbind="to">${to}</select></label>
    ${m.from ? `<div class="note">${what.length ? `Moves: ${esc(what.join('; '))}.` : 'This entry has nothing to move.'}</div>` : ''}
    <button class="btn big primary" data-do="move-go" ${m.from && m.to && m.from !== m.to && what.length ? '' : 'disabled'}>Move settings</button>`;
}

// ---------- events ----------
const DO = {
  tab: (b) => { tab = b.dataset.tab; selecting = false; selected.clear(); render(); $('#main').scrollTop = 0; },
  close: closeSheet,
  open: (b) => openSheet({ type: 'device', mac: b.dataset.mac }),
  act: async (b) => {
    const { mac, a } = b.dataset;
    await act([mac], a);
  },
  block: async (b) => { if (confirmed(b)) await act([b.dataset.mac], 'block'); },
  for: async (b) => { await pauseFor([sheet.mac], Number(b.dataset.min)); },
  rename: () => { sheet.renaming = true; renderSheet(); $('#sheet input')?.select(); },
  'toggle-member': (b) => {
    const g = b.dataset.g;
    const mac = sheet.mac;
    groups[g] = groups[g].includes(mac) ? groups[g].filter((m) => m !== mac) : [...groups[g], mac];
    save('groups', groups);
    groupRulesFollow(g, g);
    renderSheet();
    render();
  },
  'dev-schedules': () => {
    const mac = sheet.mac;
    closeSheet();
    tab = 'schedules';
    render();
    if (!schedules.some((s) => s.mac === mac)) openSheet({ type: 'rule', id: null, draft: { ...draftFrom(null), target: `m:${mac}` } });
  },
  review: () => openSheet({ type: 'review' }),
  'review-ok': () => { ack(sheet.mac); sheet.renaming = false; sheet.mac = null; render(); renderSheet(); },
  'review-block': async (b) => { const mac = sheet.mac; if (!confirmed(b)) return; ack(mac); sheet.mac = null; await act([mac], 'block'); renderSheet(); },
  'review-rename': () => { sheet.renaming = true; renderSheet(); $('#sheet input')?.select(); },
  'review-same': (b) => { const mac = sheet.mac; if (moveSettings(b.dataset.old, mac)) { sheet.mac = null; renderSheet(); } },
  seed: () => { known = new Set(devices.map((d) => d.mac)); unseen.clear(); persist(); render(); toast('All current devices are marked as known'); },
  filter: (b) => { gfilter = b.dataset.g; render(); },
  'group-act': (b) => act(groups[gfilter].filter(byMac), b.dataset.a),
  'group-for': (b) => pauseFor(groups[gfilter].filter(byMac), Number(b.dataset.min)),
  'new-group': (b) => {
    const members = new Set(b.dataset.sel ? selected : b.dataset.with ? [b.dataset.with] : []);
    openSheet({ type: 'group', name: null, fromSelection: !!b.dataset.sel, draft: { name: '', members } });
  },
  'edit-group': (b) => openSheet({ type: 'group', name: b.dataset.g, draft: { name: b.dataset.g, members: new Set(groups[b.dataset.g]) } }),
  'group-save': saveGroup,
  'group-delete': (b) => {
    if (!confirmed(b)) return;
    const n = sheet.name;
    delete groups[n];
    save('groups', groups);
    groupRulesFollow(n, null);
    if (gfilter === n) gfilter = 'all';
    closeSheet();
    toast(`Deleted ${n}`);
  },
  'pick-group': (b) => {
    const g = b.dataset.g;
    groups[g] = [...new Set([...groups[g], ...selected])];
    save('groups', groups);
    groupRulesFollow(g, g);
    toast(`Added ${selected.size} to ${g}`);
    selecting = false;
    selected.clear();
    closeSheet();
  },
  'select-done': () => { selecting = false; selected.clear(); render(); },
  pick: (b) => {
    const m = b.dataset.mac;
    selected.has(m) ? selected.delete(m) : selected.add(m);
    render();
  },
  'sel-act': async (b) => { if (b.dataset.a === 'block' && !confirmed(b)) return; if (await act([...selected], b.dataset.a)) { selecting = false; selected.clear(); render(); } },
  'sel-for': async (b) => { if (await pauseFor([...selected], Number(b.dataset.min))) { selecting = false; selected.clear(); render(); } },
  'sel-group': () => openSheet({ type: 'pickgroup' }),
  'edit-rule': (b) => { const r = ruleById(b.dataset.id); if (r) openSheet({ type: 'rule', id: r.id, draft: draftFrom(r) }); },
  'toggle-rule': (b) => { const r = ruleById(b.dataset.id); if (r) replaceRule(r.id, { ...r, enabled: !r.enabled }); },
  'rule-day': (b) => { const d = Number(b.dataset.d); const r = sheet.draft; r.days = r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d].sort(); renderSheet(); },
  'rule-preset': (b) => { sheet.draft.days = b.dataset.p.split(',').map(Number); renderSheet(); },
  'rule-kind': (b) => { sheet.draft.range = !!b.dataset.range; renderSheet(); },
  'rule-save': saveDraft,
  'rule-delete': async (b) => { if (!confirmed(b)) return; if (await replaceRule(sheet.id, null)) { closeSheet(); toast('Schedule deleted'); } },
  move: (b) => openSheet({ type: 'move', from: '', to: b.dataset.to || '' }),
  'move-go': () => { if (moveSettings(sheet.from, sheet.to)) closeSheet(); },
  theme: (b) => {
    const t = b.dataset.t;
    try { t === 'system' ? localStorage.removeItem('theme') : localStorage.setItem('theme', t); } catch {}
    applyTheme();
    render();
  },
  pin: async () => { pinned = !pinned; await win.setAlwaysOnTop(pinned); $('#pin').setAttribute('aria-pressed', pinned); render(); },
  logout: async (b) => { if (!confirmed(b)) return; await invoke('logout'); devices = []; showLogin(); },
};

let pressTimer = null;
let suppressUntil = 0;
let longFired = false;
document.addEventListener('click', (e) => {
  if (Date.now() < suppressUntil) { e.preventDefault(); return; }
  const b = e.target.closest('[data-do]');
  if (!b || b.disabled) return;
  const fn = DO[b.dataset.do];
  if (!fn) return;
  if (b.tagName === 'INPUT' && b.type === 'checkbox' && b.dataset.do === 'pick') { DO.pick(b); return; }
  if (b.dataset.do === 'group-member') { const m = b.dataset.mac; b.checked ? sheet.draft.members.add(m) : sheet.draft.members.delete(m); const l = $('#sheet .flabel'); if (l) l.textContent = `Devices · ${sheet.draft.members.size} picked`; return; }
  e.preventDefault();
  fn(b);
});
DO['group-member'] = () => {};

// press and hold a device to start picking several
document.addEventListener('pointerdown', (e) => {
  const r = e.target.closest('.row[data-row]');
  if (!r || selecting || e.target.closest('.btn')) return;
  pressTimer = setTimeout(() => {
    pressTimer = null;
    selecting = true;
    selected = new Set([r.dataset.row]);
    longFired = true;
    if (navigator.vibrate) navigator.vibrate(10);
    render();
  }, 500);
});
['pointerup', 'pointercancel', 'pointermove'].forEach((t) => document.addEventListener(t, (e) => {
  // the click that follows the release of a long press must not toggle the device straight back
  if (t !== 'pointermove' && longFired) { longFired = false; suppressUntil = Date.now() + 150; }
  if (!pressTimer) return;
  if (t === 'pointermove' && Math.abs(e.movementX) + Math.abs(e.movementY) < 4) return;
  clearTimeout(pressTimer);
  pressTimer = null;
}));
document.addEventListener('contextmenu', (e) => { if (e.target.closest('.row[data-row]')) e.preventDefault(); });

// form fields inside sheets keep their values in the sheet's draft
document.addEventListener('input', (e) => {
  const t = e.target;
  if (!sheet) return;
  if (t.dataset.bind) {
    const r = sheet.draft;
    const k = t.dataset.bind;
    if (k === 'target') { r.target = t.value; } else r[k] = t.value;
    if (k !== 'name') { const s = $('#rule-summary'); if (s) { const html = sheetRule(); const m = html.match(/<div class="note" id="rule-summary">([\s\S]*?)<\/div>/); if (m) s.innerHTML = m[1]; } }
  }
  if (t.dataset.gbind) sheet.draft[t.dataset.gbind] = t.value;
  if (t.dataset.mbind) { sheet[t.dataset.mbind] = t.value; renderSheet(); }
});
document.addEventListener('submit', (e) => {
  const f = e.target.closest('[data-form]');
  if (!f) return;
  e.preventDefault();
  const v = f.nick.value.trim();
  const d = byMac(sheet.mac);
  if (!d) return;
  if (v && v !== d.orig) nicks[d.mac] = v; else delete nicks[d.mac];
  save('nicks', nicks);
  d.name = nicks[d.mac] || d.orig;
  sheet.renaming = false;
  if (f.dataset.form === 'review-name') { ack(d.mac); sheet.mac = null; }
  renderSheet();
  render();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && sheet) closeSheet();
});
$('#scrim').onclick = closeSheet;
document.querySelectorAll('#tabbar button').forEach((b) => { b.onclick = () => DO.tab(b); });
$('#select-btn').onclick = () => { selecting = !selecting; selected.clear(); render(); };
$('#search-btn').onclick = () => {
  const q = $('#q');
  q.hidden = !q.hidden;
  $('#search-btn').setAttribute('aria-expanded', !q.hidden);
  if (!q.hidden) q.focus(); else { q.value = ''; query = ''; render(); }
};
$('#q').oninput = (e) => { query = e.target.value; render(); };
$('#refresh').onclick = () => refresh(true);
$('#add-rule').onclick = () => openSheet({ type: 'rule', id: null, draft: draftFrom(null) });

// ---------- login and start ----------
function showLogin() {
  closeSheet();
  document.querySelectorAll('.tab').forEach((t) => { t.hidden = true; });
  $('#tabbar').hidden = true;
  $('#selbar').hidden = true;
  $('#login').hidden = false;
  $('#f-user').hidden = false;
  $('#f-code').hidden = true;
  $('#login-err').textContent = '';
}
async function showDash() {
  $('#login').hidden = true;
  lastHtml = {};
  schedules = linkLegacy(await invoke('get_schedules'));
  render();
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

function applyTheme() {
  let t = null;
  try { t = localStorage.getItem('theme'); } catch {}
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
}
applyTheme();

if (win) {
  $('#titlebar').hidden = false;
  $('#pin').onclick = () => DO.pin();
  $('#min').onclick = () => win.minimize();
  $('#close').onclick = () => win.close();
}

listen('schedule-ran', (e) => {
  const { mac, action, error } = e.payload;
  toast(error ? `Schedule failed: ${error}` : `${ACTION_LABEL[action]}: ${nameOf(mac)}`, error ? 'err' : '');
  refresh();
});

window.addEventListener('focus', () => refresh());
setInterval(() => { if ($('#login').hidden && document.visibilityState === 'visible') refresh(); }, REFRESH_MS);
setInterval(tick, 1000);

(async () => {
  try { (await invoke('status')) ? await showDash() : showLogin(); } catch (e) { toast(String(e), 'err'); showLogin(); }
})();
