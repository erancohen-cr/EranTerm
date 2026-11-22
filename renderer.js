/* global api, Terminal, FitAddon, shq, logLevel, parseLogTime, logRowVisible, fileKind */

// Outline file-manager icons (stroke only, 1em, colored via CSS by kind).
const FILE_ICONS = {
  dir: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  exec: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 10l3 2-3 2 M12 15h5',
  text: 'M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M14 3v4h4 M8 12h8 M8 15h8 M8 18h5',
  archive: 'M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M14 3v4h4 M10 5h2 M10 8h2 M10 11h2 M9 14h4v4H9z',
  image: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M8.5 10.5a1.5 1.5 0 1 0 0-.01 M21 15l-5-5-9 9',
  link: 'M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1 M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1',
  file: 'M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z M14 3v4h4',
};
const KIND_TITLE = { dir: 'Folder', exec: 'Executable / script', text: 'Text file', archive: 'Archive', image: 'Image', link: 'Symbolic link', file: 'File' };
function fileIcon(kind) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'ficon k-' + kind);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', FILE_ICONS[kind] || FILE_ICONS.file);
  const title = document.createElementNS(NS, 'title');
  title.textContent = KIND_TITLE[kind] || 'File';
  svg.append(title, path);
  return svg;
}
const $ = s => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter(k => k != null && k !== ''));
  return e;
};
const iconBtn = (text, title, fn, cls = 'icon') =>
  el('button', { className: cls, title, textContent: text, onclick: e => { e.stopPropagation(); fn(); } });
const cleanErr = e => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const ago = t => {
  if (!t) return '—';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString();
};
const fmtSize = n => {
  if (n == null) return '—';
  const u = ['B', 'K', 'M', 'G', 'T'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
};
const basename = p => p.replace(/\/+$/, '').split('/').pop() || '/';
// Log source names: Windows paths use backslashes; "eventlog:System" is a Windows Event Log.
const isEventLogSrc = p => /^eventlog:/i.test(p);
const srcName = p => (isEventLogSrc(p) ? p.replace(/^eventlog:/i, '') : p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p);
const dirname = p => p.replace(/\/[^/]*\/?$/, '') || '/';

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = isErr ? 'err' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 6000 : 3000);
}

// Electron has no window.prompt(); tiny dialog instead.
function askName(title) {
  const dlg = $('#nameDlg');
  $('#nameTitle').textContent = title;
  $('#nameForm').reset();
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(resolve => dlg.addEventListener('close', () =>
    resolve(dlg.returnValue === 'ok' ? $('#nameForm').elements.name.value.trim() : ''), { once: true }));
}

// Dropping a file outside a drop zone must not navigate the window away.
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => e.preventDefault());

// ================= top tabs =================
const views = new Map(); // serverId -> server view
let deploys; // home Deployments panel, built on first visit

function show(id) {
  $('#home').hidden = id !== 'home';
  $('#homeTab').classList.toggle('active', id === 'home');
  for (const [sid, v] of views) {
    v.root.hidden = sid !== id;
    v.tabEl.classList.toggle('active', sid === id);
  }
  if (id === 'home') refreshServers();
  else views.get(id)?.onShow();
}
$('#homeTab').onclick = () => show('home');

// ================= home: servers, groups, users =================
let servers = [], users = [], savedGroups = [];
let homeMode = 'all'; // 'all' | 'fav' | 'users' | 'group:<name>'
const UNGROUPED = 'Ungrouped';
const groupOf = s => s.group || UNGROUPED;
const modeGroup = () => (homeMode.startsWith('group:') ? homeMode.slice(6) : null);
let collapsed = new Set();
try { collapsed = new Set(JSON.parse(localStorage.getItem('collapsedGroups')) || []); } catch { /* start expanded */ }
const saveCollapsed = () => { try { localStorage.setItem('collapsedGroups', JSON.stringify([...collapsed])); } catch { /* ignore */ } };

async function refreshServers() {
  [servers, users, savedGroups] = await Promise.all([api.servers.list(), api.users.list(), api.groups.list()]);
  renderNav();
  renderServers();
  renderUsers();
}

function groupNames() {
  const named = [...new Set([...savedGroups, ...servers.map(s => s.group).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  return servers.some(s => !s.group) ? [...named, UNGROUPED] : named;
}

function setMode(mode) {
  homeMode = mode;
  const g = modeGroup();
  if (g) { collapsed.delete(g); saveCollapsed(); }
  renderNav();
  renderServers();
  $('.content').scrollTop = 0;
}

function renderNav() {
  const g = modeGroup();
  $('#navCount').textContent = servers.length;
  $('#favCount').textContent = servers.filter(s => s.starred).length || '';
  $('#userCount').textContent = users.length || '';
  $('#navAll').classList.toggle('active', homeMode === 'all');
  $('#navFav').classList.toggle('active', homeMode === 'fav');
  $('#navUsers').classList.toggle('active', homeMode === 'users');
  $('#navDeploy').classList.toggle('active', homeMode === 'deploy');
  $('#navGroups').replaceChildren(...groupNames().map(name => el('button', {
    className: 'navitem' + (g === name ? ' active' : ''), title: name, onclick: () => setMode('group:' + name),
  }, el('i', { textContent: name === UNGROUPED ? '◌' : '▣' }), el('span', { className: 'lbl', textContent: name }),
  el('span', { className: 'count lbl', textContent: servers.filter(s => groupOf(s) === name).length }),
  ...(name === UNGROUPED ? [] : [iconBtn('✎', `Edit group ${name}`, () => editGroup(name), 'icon gedit lbl')]))));
  $('#serversView').hidden = homeMode === 'users' || homeMode === 'deploy';
  $('#usersView').hidden = homeMode !== 'users';
  $('#deployView').hidden = homeMode !== 'deploy';
  $('#home .content').classList.toggle('flush', homeMode === 'deploy');
  if (homeMode === 'deploy') deploys ||= initDeployments($('#deployView .panel'));
  // suggestions for the server form
  $('#groupList').replaceChildren(...groupNames().filter(x => x !== UNGROUPED).map(value => el('option', { value })));
  $('#usernameList').replaceChildren(...users.map(u => el('option', { value: u.username, label: u.label })));
}

// ---- alerts on the home table ----
// serverId -> Map(metric -> { val, threshold, since }) for alerts currently above their limit (set by each server page).
const alertState = new Map();
const METRIC_NAME = { cpu: 'CPU', mem: 'Memory', disk: 'Disk' };
const METRIC_ICON = { // same shapes as the Metrics cards
  cpu: 'M13 2 4 14h7l-1 8 9-12h-7l1-8z',
  mem: 'M3 8h18v9H3z M7 8V5 M12 8V5 M17 8V5 M7 17v2 M12 17v2 M17 17v2 M7 11.5h3v2H7z M14 11.5h3v2h-3z',
  disk: 'M5 3h14v18H5z M5 9h14 M5 15h14 M8 6h3 M8 12h3 M8 18h3',
};
function metricIcon(k) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'micon m-' + k);
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', METRIC_ICON[k]);
  svg.append(path);
  return svg;
}
// Red metric icons while an alert is firing; a quiet bell when alerts are set but all is fine.
// Hover shows what's wrong (or what's watched) and a jump to that server's Metrics tab.
function alertCell(s) {
  const firing = alertState.get(s.id);
  const set = Object.entries(s.alerts || {}).filter(([, a]) => a.on);
  if (!firing?.size && !set.length) return el('td', { className: 'alertcell' });
  const lines = firing?.size
    ? [...firing].map(([k, f]) => el('div', { className: 'aline fire' }, metricIcon(k),
      el('span', { textContent: `${METRIC_NAME[k]} at ${Math.round(f.val)}% — above your ${f.threshold}% alert · since ${new Date(f.since).toLocaleTimeString()}` })))
    : [el('div', { className: 'aline', textContent: views.get(s.id)?.connId ? 'All within limits.' : 'Not connected — alerts are checked only while connected.' })];
  const watched = set.map(([k, a]) => `${METRIC_NAME[k]} > ${a.threshold}%`).join(' · ');
  return el('td', { className: 'alertcell' },
    el('span', { className: 'abadge' + (firing?.size ? ' fire' : '') },
      ...(firing?.size ? [...firing.keys()].map(metricIcon) : [el('span', { className: 'bell', textContent: '🔔' })])),
    el('div', { className: 'apop' },
      el('b', { textContent: firing?.size ? `🔔 Alert on ${s.name}` : `Alerts on ${s.name}` }),
      ...lines,
      watched ? el('small', { className: 'muted', textContent: `Watching: ${watched}` }) : null,
      el('button', { className: 'sm primary', textContent: 'Open Metrics →', onclick: e => { e.stopPropagation(); openMetrics(s); } })));
}
async function openMetrics(s) {
  if (!views.has(s.id)) await openServer(s); // connects (alerts only fire on connected servers anyway)
  const v = views.get(s.id);
  if (!v) return;
  show(s.id);
  v.pickPanel?.('stats');
}

// ---- availability (probed in main, pushed every interval) ----
// Painted in place (data-av="<serverId>:<server|ssh|desk>") so a refresh never rebuilds the table.
let avail = {};
const AV_TEXT = { up: 'available', down: 'not available', unknown: 'unknown' };
const avMark = (id, key) => {
  const e = el('span', { className: 'av' });
  e.dataset.av = `${id}:${key}`;
  return e;
};
// Button label on the left, protocol status on the right (buttons share one width, see .actions .desk/.conn).
const withAv = (btn, id, key) => {
  btn.replaceChildren(el('span', { className: 'blbl', textContent: btn.textContent }), avMark(id, key));
  return btn;
};
function paintAvail() {
  for (const e of document.querySelectorAll('[data-av]')) {
    const [id, key] = e.dataset.av.split(':');
    const st = avail[id]?.[key] || '';
    e.className = 'av' + (st ? ' ' + st : '');
    e.textContent = key !== 'server' && st === 'unknown' ? 'unknown' : '';
    e.title = st ? `${key === 'server' ? 'Server' : key === 'ssh' ? 'SSH' : 'Desktop'}: ${AV_TEXT[st]} · checked ${new Date(avail[id].at).toLocaleTimeString()}`
      : 'Availability not checked (off in Settings or for this server)';
  }
}
// OS popup (HTML5 Notification = native notification in Electron). Off in Settings → notifications.
const notifyOn = () => { try { return localStorage.getItem('notify') !== 'off'; } catch { return true; } };
function notify(title, body) {
  try { if (notifyOn()) new Notification(title, { body }); } catch { /* notifications blocked */ }
}
function onAvail(next) {
  for (const [id, a] of Object.entries(next)) {
    const was = avail[id]?.server;
    if (!was || was === a.server) continue; // first check or no change: stay quiet
    const s = servers.find(x => x.id === id);
    if (s) notify(a.server === 'up' ? `✅ ${s.name} is back up` : `⛔ ${s.name} is not responding`, s.host);
  }
  avail = next;
  paintAvail();
}
api.avail.onUpdate(onAvail);
api.avail.get().then(a => { avail = a; paintAvail(); });

function serverRow(s) {
  const tr = el('tr', { className: 'srow' + (alertState.get(s.id)?.size ? ' alerting' : '') },
    el('td', {}, el('span', { className: 'dot' + (views.has(s.id) ? ' on' : '') }), el('b', { textContent: s.name }), avMark(s.id, 'server')),
    el('td', {}, el('span', { className: 'proto ' + typeOf(s), textContent: typeOf(s).toUpperCase() })),
    el('td', { className: 'mono', title: s.userLabel ? `Login: saved user "${s.userLabel}"` : '' },
      `${s.username ? s.username + '@' : ''}${s.host}` + (s.port !== defaultPort(s) ? `:${s.port}` : ''),
      s.userLabel ? el('span', { className: 'ulink', textContent: ' 👤' }) : null),
    el('td', {}, ...s.tags.map(t => el('span', { className: 'tag', textContent: t }))),
    el('td', { className: 'details muted', textContent: s.details || '', title: s.details || '' }),
    alertCell(s),
    el('td', { className: 'muted', textContent: ago(s.lastSeen) }),
    el('td', { className: 'r actions' },
      iconBtn(s.starred ? '★' : '☆', s.starred ? 'Unfavorite' : 'Favorite', () => toggleStar(s), 'icon' + (s.starred ? ' star' : '')),
      iconBtn('✎', 'Edit', () => editServer(s)),
      iconBtn('🗑', 'Delete', () => deleteServer(s), 'icon danger'),
      withAv(typeOf(s) === 'rdp'
        ? iconBtn('🖥 Desktop', `Open Remote Desktop (RDP, port ${s.port})`, () => openRdp(s), 'desk')
        : iconBtn(...(DESKTOP[s.os] || DESKTOP['']), () => openDesktop(s), 'desk'), s.id, 'desk'),
      withAv(iconBtn(views.has(s.id) ? '↗ Open' : '▶ Connect',
        typeOf(s) === 'rdp' ? `Open SSH (Windows OpenSSH, port ${s.sshPort || 22}) with the same login` : 'Connect', () => connectServer(s), 'primary conn'), s.id, 'ssh')));
  tr.ondblclick = () => connectServer(s);
  return tr;
}

function renderServers() {
  const q = $('#filter').value.toLowerCase();
  const g = modeGroup();
  const list = servers
    .filter(s => homeMode !== 'fav' || s.starred)
    .filter(s => !g || groupOf(s) === g)
    .filter(s => !q || [s.name, s.host, s.username, s.group || '', s.details || '', ...s.tags].some(x => x.toLowerCase().includes(q)))
    .sort((a, b) => b.starred - a.starred || a.name.localeCompare(b.name));
  $('#countBadge').textContent = `${list.length} server${list.length === 1 ? '' : 's'}`;
  $('#homeTitle').textContent = g || (homeMode === 'fav' ? 'Favorites' : 'All Servers');
  const rows = [];
  for (const name of groupNames()) {
    const members = list.filter(s => groupOf(s) === name);
    if (!members.length && (q || homeMode === 'fav')) continue; // empty groups show only when not filtering
    const shut = !q && collapsed.has(name); // searching always shows matches
    rows.push(el('tr', {
      className: 'grprow' + (shut ? ' shut' : ''),
      onclick: () => { collapsed[collapsed.has(name) ? 'delete' : 'add'](name); saveCollapsed(); renderServers(); },
    }, el('td', { colSpan: 8 },
      el('span', { className: 'caret', textContent: shut ? '▸' : '▾' }),
      el('b', { textContent: name }),
      el('span', { className: 'count', textContent: members.length }),
      el('span', { className: 'grow' }),
      el('span', { className: 'gacts' },
        ...(name === UNGROUPED ? [] : [iconBtn('✎', `Edit group ${name}`, () => editGroup(name))]),
        iconBtn('＋', `Add a server to ${name}`, () => editServer({ group: name === UNGROUPED ? '' : name }))))));
    if (!shut) rows.push(...members.map(serverRow));
  }
  $('#serverRows').replaceChildren(...rows);
  paintAvail();
  $('#emptyHome').hidden = servers.length > 0;
}
// ---- groups: new / rename / delete ----
function editGroup(name = '') {
  const dlg = $('#groupDlg'), f = $('#groupForm');
  $('#groupTitle').textContent = name ? 'Edit group' : 'New group';
  f.elements.name.value = name;
  const n = servers.filter(s => s.group === name).length;
  $('#groupInfo').textContent = name ? `${n} server${n === 1 ? '' : 's'} in this group.` : '';
  f.querySelector('.gdel').hidden = !name;
  dlg.returnValue = '';
  dlg.showModal();
  dlg.addEventListener('close', async () => {
    try {
      if (dlg.returnValue === 'save') {
        const next = await api.groups.save(name, f.elements.name.value);
        if (name && next !== name) {
          if (collapsed.delete(name)) { collapsed.add(next); saveCollapsed(); }
          if (modeGroup() === name) homeMode = 'group:' + next;
        }
        toast(name ? `Group renamed to ${next}` : `Group ${next} created`);
      } else if (dlg.returnValue === 'delete') {
        if (!await ask({ title: `Delete group "${name}"?`, danger: true, ok: 'Delete group',
          body: n ? `Its ${n} server${n === 1 ? '' : 's'} will move to ${UNGROUPED}. No servers are deleted.` : 'The group is empty.' })) return;
        await api.groups.delete(name);
        if (modeGroup() === name) homeMode = 'all';
        toast(`Group ${name} deleted`);
      } else return;
      refreshServers();
    } catch (e) { toast(cleanErr(e), true); }
  }, { once: true });
}
$('#newGroupBtn').onclick = () => editGroup();

$('#collapseAll').onclick = () => { collapsed = new Set(groupNames()); saveCollapsed(); renderServers(); };
$('#expandAll').onclick = () => { collapsed.clear(); saveCollapsed(); renderServers(); };

const typeOf = s => (s.type === 'rdp' ? 'rdp' : 'ssh');
const defaultPort = s => (typeOf(s) === 'rdp' ? 3389 : 22);

function connectServer(s) {
  return openServer(s); // RDP entries connect over SSH too; their Desktop button opens RDP
}

async function openRdp(s) {
  try {
    const r = await api.rdp.open(s.id);
    toast(`Opening ${s.name} in Windows App…` + (r.copied ? ' Password copied to clipboard (cleared in 45 s).' : ''));
    refreshServers();
  } catch (e) { toast(cleanErr(e), true); }
}

// Desktop button for SSH servers, by the server's OS (unknown until the first connection).
const DESKTOP = {
  windows: ['🖥 RDP', 'Open with Remote Desktop (Windows App, port 3389)'],
  macos: ['🖥 Screen Sharing', 'Open with macOS Screen Sharing (Remote Management must be on)'],
  linux: ['🖥 VNC', 'Open the desktop with Screen Sharing (needs a VNC server on port 5900)'],
  unix: ['🖥 VNC', 'Open the desktop with Screen Sharing (needs a VNC server on port 5900)'],
  '': ['🖥 Desktop', 'Open the remote desktop: RDP for Windows, Screen Sharing for macOS/Linux (detects the OS over SSH)'],
};
async function openDesktop(s) {
  if (!s.os) toast(`Detecting the OS of ${s.name}…`);
  try {
    const r = await api.remote.open(s.id);
    toast(`Opening ${s.name} in ${r.os === 'windows' ? 'Windows App' : 'Screen Sharing'}…` +
      (r.copied ? ' Password copied to clipboard (cleared in 45 s).' : ''));
    refreshServers();
  } catch (e) { toast(cleanErr(e), true); }
}

async function toggleStar(s) {
  await api.servers.save({ ...s, starred: !s.starred });
  refreshServers();
}

function editServer(s = {}) {
  const f = $('#serverForm');
  f.reset();
  for (const k of ['id', 'name', 'host', 'port', 'username', 'keyPath', 'group']) if (s[k] != null) f.elements[k].value = s[k];
  f.elements.type.value = typeOf(s);
  f.elements.domain.value = s.domain || '';
  f.elements.sshPort.value = s.sshPort || 22;
  f.elements.userId.replaceChildren(el('option', { value: '', textContent: 'Enter username / password below' }),
    ...users.map(u => el('option', { value: u.id, textContent: `Saved user: ${u.label} (${u.username})` })));
  f.elements.userId.value = s.userId || '';
  syncFormType();
  f.elements.tags.value = (s.tags || []).join(', ');
  f.elements.details.value = s.details || '';
  f.elements.starred.checked = !!s.starred;
  f.elements.probe.checked = !s.noProbe;
  $('#serverDlg').returnValue = ''; // Esc must not reuse the last 'save'
  $('#serverDlg').showModal();
}

// Show only the fields that apply; swap the default port when the type changes.
function syncFormType() {
  const f = $('#serverForm');
  const rdp = f.elements.type.value === 'rdp';
  const saved = !!f.elements.userId.value;
  f.querySelectorAll('.rdp-only').forEach(x => (x.hidden = !rdp));
  f.querySelectorAll('.ssh-only').forEach(x => (x.hidden = rdp));
  f.querySelectorAll('.own-cred').forEach(x => (x.hidden = saved));
  f.querySelector('.portLabel').textContent = rdp ? 'RDP port (for Desktop)' : 'Port';
  f.querySelector('.saved-user').hidden = !saved;
  f.elements.username.required = !rdp && !saved; // RDP can prompt for the user
  const port = f.elements.port;
  if (rdp && port.value === '22') port.value = '3389';
  if (!rdp && port.value === '3389') port.value = '22';
}
$('#serverForm').elements.type.onchange = syncFormType;
$('#serverForm').elements.userId.onchange = syncFormType;
// Picking a suggested username that belongs to a saved user links that user (and its password).
$('#serverForm').elements.username.onchange = () => {
  const f = $('#serverForm');
  const u = users.find(x => x.username === f.elements.username.value);
  if (u && users.filter(x => x.username === u.username).length === 1) { f.elements.userId.value = u.id; syncFormType(); }
};

$('#serverDlg').addEventListener('close', async () => {
  if ($('#serverDlg').returnValue !== 'save') return;
  const e = $('#serverForm').elements;
  await api.servers.save({
    id: e.id.value || undefined, type: e.type.value, domain: e.domain.value.trim(), sshPort: e.sshPort.value,
    name: e.name.value, host: e.host.value, port: e.port.value, group: e.group.value, userId: e.userId.value,
    username: e.username.value, keyPath: e.keyPath.value.trim(), password: e.userId.value ? '' : e.password.value,
    tags: e.tags.value.split(',').map(t => t.trim()).filter(Boolean), starred: e.starred.checked,
    details: e.details.value, noProbe: !e.probe.checked,
  });
  refreshServers();
});

async function deleteServer(s) {
  if (!confirm(`Delete ${s.name}? Its saved password and host key are removed too.`)) return;
  if (views.has(s.id)) closeServer(s.id);
  await api.servers.delete(s.id);
  refreshServers();
}

$('#addBtn').onclick = () => editServer({ group: modeGroup() && modeGroup() !== UNGROUPED ? modeGroup() : '' });
$('#filter').oninput = renderServers;
$('#navAll').onclick = () => setMode('all');
$('#navFav').onclick = () => setMode('fav');
$('#navUsers').onclick = () => setMode('users');
$('#navDeploy').onclick = () => setMode('deploy');

// ---- users (saved credentials) ----
function renderUsers() {
  $('#usersBadge').textContent = `${users.length} user${users.length === 1 ? '' : 's'}`;
  $('#emptyUsers').hidden = users.length > 0;
  $('#userRows').replaceChildren(...users.map(u => {
    const usedBy = servers.filter(x => x.userId === u.id).map(x => x.name);
    return el('tr', {},
      el('td', {}, el('b', { textContent: u.label })),
      el('td', { className: 'mono', textContent: u.username }),
      el('td', {}, ...[u.hasPassword && 'Password', u.keyPath && 'Key'].filter(Boolean).map(t => el('span', { className: 'tag', textContent: t })),
        !u.hasPassword && !u.keyPath ? el('span', { className: 'muted', textContent: 'SSH agent / prompt' }) : null),
      el('td', { className: 'muted', textContent: usedBy.join(', ') || '—', title: usedBy.join('\n') }),
      el('td', { className: 'r actions' },
        iconBtn('✎', 'Edit', () => editUser(u)),
        iconBtn('🗑', 'Delete', () => deleteUser(u, usedBy), 'icon danger')));
  }));
}

function editUser(u = {}) {
  const f = $('#userForm');
  f.reset();
  for (const k of ['id', 'label', 'username', 'keyPath']) f.elements[k].value = u[k] || '';
  f.elements.password.placeholder = u.hasPassword ? 'leave blank to keep the saved one' : 'optional';
  f.elements.clearPassword.parentElement.hidden = !u.hasPassword;
  $('#userDlg').returnValue = '';
  $('#userDlg').showModal();
}
$('#userDlg').addEventListener('close', async () => {
  if ($('#userDlg').returnValue !== 'save') return;
  const e = $('#userForm').elements;
  try {
    await api.users.save({
      id: e.id.value || undefined, label: e.label.value, username: e.username.value,
      password: e.password.value, keyPath: e.keyPath.value, clearPassword: e.clearPassword.checked,
    });
  } catch (err) { toast(cleanErr(err), true); }
  refreshServers();
});
async function deleteUser(u, usedBy) {
  const msg = usedBy.length
    ? `Delete user "${u.label}"? ${usedBy.length} server(s) use it (${usedBy.join(', ')}) and will need their own login.`
    : `Delete user "${u.label}"?`;
  if (!confirm(msg)) return;
  await api.users.delete(u.id);
  refreshServers();
}
$('#addUserBtn').onclick = () => editUser();

// ================= theme =================
// ponytail: theme lives in localStorage (per-machine UI preference); falls back to System if storage is unavailable.
const darkMq = matchMedia('(prefers-color-scheme: dark)');
const allTerms = new Set(); // every xterm, so a theme switch restyles open sessions too
const getThemePref = () => { try { return localStorage.getItem('theme') || 'system'; } catch { return 'system'; } };
const isLight = () => document.documentElement.dataset.theme === 'light';
const termTheme = () => (isLight()
  ? { background: '#ffffff', foreground: '#1d2127', cursor: '#1a9a3a', cursorAccent: '#ffffff', selectionBackground: '#1a9a3a40' }
  : { background: '#0b0d10', foreground: '#e3e6eb', cursor: '#3ddc5f', cursorAccent: '#0b0d10', selectionBackground: '#3ddc5f55' });
function applyTheme() {
  const pref = getThemePref();
  document.documentElement.dataset.theme = pref === 'system' ? (darkMq.matches ? 'dark' : 'light') : pref;
  for (const term of allTerms) {
    if (term.element?.isConnected) term.options.theme = termTheme();
    else allTerms.delete(term); // disposed / closed
  }
}
darkMq.addEventListener('change', applyTheme);
applyTheme();

// ================= settings =================
let aiSettings = null; // last settings:get, so switching provider in the dialog shows that provider's state
function showProvider(p) {
  const f = $('#settingsForm').elements;
  const d = aiSettings.providers[p];
  $('#keyLabel').textContent = `${d.label} API key`;
  $('#keyStatus').textContent = d.fromEnv ? `Using ${d.env} from the environment (it overrides a saved key).`
    : d.hasKey ? 'A key is saved for this provider (encrypted in Keychain).' : 'No key for this provider — Ask AI is disabled until you add one.';
  f.clearKey.parentElement.hidden = !d.hasKey || d.fromEnv;
  f.clearKey.checked = false;
  f.apiKey.value = '';
  $('#aiModelList').replaceChildren(...d.models.map(value => el('option', { value })));
  f.aiModel.value = d.model;
  aiMsg('');
}
async function openSettings(focusKey = false) {
  aiSettings = await api.settings.get();
  const f = $('#settingsForm');
  f.reset();
  f.elements.theme.value = getThemePref();
  f.elements.autoUpdate.checked = aiSettings.autoUpdate;
  f.elements.logToFile.checked = aiSettings.logToFile;
  f.elements.logDir.value = aiSettings.logDir;
  f.elements.availOn.checked = aiSettings.avail.on;
  f.elements.availSec.value = aiSettings.avail.intervalSec;
  f.elements.notify.checked = notifyOn();
  $('#updHint').textContent = `You have version ${aiSettings.version}. Checks at startup and every 6 hours. Help → Check for Updates… checks now.`;
  f.elements.aiProvider.replaceChildren(...Object.entries(aiSettings.providers)
    .map(([value, d]) => el('option', { value, textContent: d.label + (d.hasKey ? '  ✓' : '') })));
  f.elements.aiProvider.value = aiSettings.aiProvider;
  showProvider(aiSettings.aiProvider);
  $('#settingsDlg').returnValue = '';
  $('#settingsDlg').showModal();
  if (focusKey) f.elements.apiKey.focus();
}
$('#settingsForm').elements.aiProvider.onchange = e => showProvider(e.target.value);
$('#logPick').onclick = async () => {
  const dir = await api.settings.pickLogDir($('#settingsForm').elements.logDir.value);
  if (dir) $('#settingsForm').elements.logDir.value = dir;
};
$('#logOpen').onclick = () => api.log.openFolder();
$('#logConsole').onclick = () => api.log.openConsole();
$('#settingsBtn').onclick = () => openSettings();

// Confirm / small form dialog. body: string or element(s). Resolves true on OK.
function ask({ title, body, ok = 'OK', danger = false, okDisabled = false }) {
  const dlg = $('#actDlg');
  dlg.querySelector('.actTitle').textContent = title;
  dlg.querySelector('.actBody').replaceChildren(...[].concat(body).map(b => (typeof b === 'string' ? el('p', { textContent: b }) : b)));
  const okBtn = dlg.querySelector('.actOk');
  okBtn.textContent = ok;
  okBtn.className = 'actOk ' + (danger ? 'danger-btn' : 'primary');
  okBtn.disabled = okDisabled;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok'), { once: true }));
}

// ---- AI helpers shared by Terminal and Logs ----
// Last n lines of an xterm's buffer as plain text (what's on screen plus scrollback).
function termText(term, n) {
  const b = term.buffer.active;
  const out = [];
  for (let i = Math.max(0, b.length - n); i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out.join('\n').replace(/\n+$/, '');
}
function showAiAnswer(box, text) {
  box.replaceChildren(
    el('div', { className: 'aiOutHead' }, el('b', { textContent: '✦ AI analysis' }), el('span', { className: 'grow' }),
      iconBtn('⧉', 'Copy answer', () => navigator.clipboard.writeText(text).then(() => toast('Copied'))),
      iconBtn('×', 'Close', () => { box.hidden = true; })),
    el('div', { className: 'aiOutBody', textContent: text })); // plain text: model output is never rendered as HTML
  box.hidden = false;
}
// Missing / rejected key → message + button that opens AI configuration.
function showAiError(target, err) {
  const msg = cleanErr(err);
  if (msg.startsWith('NO_API_KEY')) {
    target.replaceChildren(msg.replace(/^NO_API_KEY:\s*/, '') + ' ',
      el('button', { type: 'button', className: 'sm primary', textContent: 'Add API key', onclick: () => openSettings(true) }));
  } else target.textContent = msg;
}
// Preview the theme while the dialog is open; Cancel/Esc restores the saved one.
$('#settingsForm').elements.theme.onchange = e => { document.documentElement.dataset.theme =
  e.target.value === 'system' ? (darkMq.matches ? 'dark' : 'light') : e.target.value; };
// Messages inside the dialog (it no longer closes on a failed save).
const aiMsg = (text, kind = '') => { $('#aiMsg').textContent = text; $('#aiMsg').className = 'hint ' + kind; };
const aiNoKeyText = e => cleanErr(e).replace(/^NO_API_KEY:\s*/, '').replace(/\s*(Update it|Add one)? ?in Settings → AI configuration\./, ' Check the key and try again.');

// Save: validate + store first; close only when it worked.
$('#settingsForm').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'save') return; // Cancel closes as usual
  e.preventDefault();
  const f = $('#settingsForm').elements;
  const btn = e.submitter;
  btn.disabled = true;
  try {
    await api.settings.setAi({
      provider: f.aiProvider.value, model: f.aiModel.value,
      key: f.clearKey.checked ? null : f.apiKey.value.trim(),
    });
    if (f.autoUpdate.checked !== aiSettings.autoUpdate) await api.settings.setAutoUpdate(f.autoUpdate.checked);
    if (f.logToFile.checked !== aiSettings.logToFile || f.logDir.value.trim() !== aiSettings.logDir) {
      await api.settings.setLog({ logToFile: f.logToFile.checked, logDir: f.logDir.value });
    }
    if (f.availOn.checked !== aiSettings.avail.on || Number(f.availSec.value) !== aiSettings.avail.intervalSec) {
      await api.settings.setAvail({ on: f.availOn.checked, intervalSec: f.availSec.value });
    }
    if (f.notify.checked && Notification.permission === 'default') Notification.requestPermission();
    try { localStorage.setItem('theme', f.theme.value); localStorage.setItem('notify', f.notify.checked ? 'on' : 'off'); } catch { /* ignore */ }
    $('#settingsDlg').close('save');
    toast(`Settings saved. AI: ${aiSettings.providers[f.aiProvider.value].label}`);
  } catch (err) {
    aiMsg(aiNoKeyText(err), 'error');
  } finally { btn.disabled = false; }
});
$('#settingsDlg').addEventListener('close', applyTheme);

$('#aiLoadModels').onclick = async () => {
  const f = $('#settingsForm').elements;
  const btn = $('#aiLoadModels');
  btn.disabled = true; aiMsg('Loading models…');
  try {
    const models = await api.ai.models({ provider: f.aiProvider.value, key: f.apiKey.value });
    $('#aiModelList').replaceChildren(...models.map(value => el('option', { value })));
    const cur = f.aiModel.value.trim().replace(/^models\//, '');
    aiMsg(`${models.length} models available. ` + (models.includes(cur) ? `"${cur}" is one of them ✓`
      : `"${cur}" is not in the list — click the Model field to pick one.`), models.includes(cur) ? 'ok' : 'warn');
  } catch (err) { aiMsg(aiNoKeyText(err), 'error'); }
  finally { btn.disabled = false; }
};
$('#aiTest').onclick = async () => {
  const f = $('#settingsForm').elements;
  const btn = $('#aiTest');
  btn.disabled = true; aiMsg('Testing…');
  try {
    const r = await api.ai.test({ provider: f.aiProvider.value, key: f.apiKey.value, model: f.aiModel.value });
    aiMsg(`Works ✓ ${r.model} answered "${r.reply}" in ${(r.ms / 1000).toFixed(1)} s. Click Save to keep it.`, 'ok');
  } catch (err) { aiMsg(aiNoKeyText(err), 'error'); }
  finally { btn.disabled = false; }
};

// ================= terminals =================
const shellsById = new Map(); // shellId -> terminal wrapper
api.ssh.onData((id, d) => shellsById.get(id)?.term.write(d));
api.ssh.onClosed(id => {
  shellsById.get(id)?.term.writeln('\r\n\x1b[90m[session closed]\x1b[0m');
  shellsById.delete(id);
});

// ---- command suggestions: per-server history (this browser only) + common commands ----
const COMMON_CMDS = [
  'ls -la', 'ls -lah', 'cd ..', 'pwd', 'df -h', 'du -sh *', 'free -h', 'top', 'htop', 'uptime', 'whoami', 'uname -a',
  'ps aux', 'ps aux | grep ', 'kill -9 ', 'tail -f ', 'tail -n 100 ', 'less ', 'cat ', 'grep -rn ', 'find . -name ',
  'systemctl status ', 'systemctl restart ', 'journalctl -xe', 'journalctl -u ', 'sudo -i', 'sudo ',
  'docker ps', 'docker ps -a', 'docker logs -f ', 'docker exec -it ', 'docker compose up -d', 'docker compose logs -f',
  'ss -tulpn', 'netstat -an', 'ip addr', 'ping ', 'curl -I ', 'git status', 'git log --oneline -20', 'git pull',
  'chmod +x ', 'chown -R ', 'mkdir -p ', 'rm -rf ', 'cp -r ', 'mv ', 'tar czf ', 'tar xzf ', 'history | tail -50', 'clear', 'exit',
];
const HIST_MAX = 500;
const histCache = new Map();
function getHist(serverId) {
  if (!histCache.has(serverId)) {
    let h = [];
    try { h = JSON.parse(localStorage.getItem('hist:' + serverId)) || []; } catch { /* no storage: session-only history */ }
    histCache.set(serverId, h);
  }
  return histCache.get(serverId);
}
function pushHist(serverId, cmd) {
  const h = [cmd, ...getHist(serverId).filter(x => x !== cmd)].slice(0, HIST_MAX);
  histCache.set(serverId, h);
  try { localStorage.setItem('hist:' + serverId, JSON.stringify(h)); } catch { /* ignore */ }
}

function makeTerm(host, connId, cwd, serverId) {
  const term = new Terminal({
    cursorBlink: true, fontSize: 13, fontFamily: 'Menlo, monospace',
    theme: termTheme(),
  });
  allTerms.add(term);
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(host);
  const t = { term, id: null };
  const refit = () => { if (host.offsetParent) fit.fit(); };
  const ro = new ResizeObserver(refit); // handles window resize and hidden->shown
  ro.observe(host);
  refit();

  // We only know what the user typed since the last Enter; anything that moves the cursor
  // (arrows, shell Tab-completion, Ctrl-keys) makes that unknowable, so tracking stops until Enter.
  // Suggestions show only when the screen line really ends with what we tracked: that also hides
  // them at password prompts (no echo), and keeps unechoed input out of history.
  const sug = { line: '', lost: false, echoed: false, items: [], idx: 0, box: el('div', { className: 'suggest', hidden: true }) };
  host.append(sug.box);
  const cursorLine = () => {
    const b = term.buffer.active;
    return b.getLine(b.baseY + b.cursorY)?.translateToString(true) || '';
  };
  const hide = () => { sug.box.hidden = true; sug.items = []; };
  function refresh() {
    const typed = sug.line;
    if (sug.lost || typed.trim().length < 1 || term.buffer.active.type === 'alternate') return hide();
    if (!cursorLine().trimEnd().endsWith(typed.trimEnd())) return hide();
    sug.echoed = true; // the shell echoes this line, so it's not a password prompt
    const seen = new Set();
    sug.items = [...getHist(serverId), ...COMMON_CMDS]
      .filter(c => c.startsWith(typed) && c !== typed && !seen.has(c) && seen.add(c))
      .slice(0, 6);
    if (!sug.items.length) return hide();
    sug.idx = 0;
    render();
  }
  function render() {
    sug.box.replaceChildren(
      ...sug.items.map((c, i) => el('div', {
        className: 'sitem' + (i === sug.idx ? ' active' : ''),
        onmousedown: e => { e.preventDefault(); sug.idx = i; accept(); },
      }, el('b', { textContent: sug.line }), el('span', { textContent: c.slice(sug.line.length) }))),
      el('div', { className: 'shint', textContent: 'Tab accept · ↑↓ choose · Esc close' }));
    sug.box.hidden = false;
    // place under (or above, near the bottom) the start of the typed text
    const screen = term.element.querySelector('.xterm-screen');
    const hr = host.getBoundingClientRect(), sr = screen.getBoundingClientRect();
    const cw = sr.width / term.cols, ch = sr.height / term.rows;
    const b = term.buffer.active;
    sug.box.style.left = `${sr.left - hr.left + Math.max(0, b.cursorX - sug.line.length) * cw}px`;
    const y = sr.top - hr.top + b.cursorY * ch;
    if (b.cursorY > term.rows / 2) { sug.box.style.top = ''; sug.box.style.bottom = `${hr.height - y + 2}px`; }
    else { sug.box.style.bottom = ''; sug.box.style.top = `${y + ch + 2}px`; }
  }
  function accept() {
    const rest = sug.items[sug.idx]?.slice(sug.line.length);
    if (rest && t.id) { api.ssh.write(t.id, rest); sug.line += rest; }
    hide();
  }
  function track(d) {
    if (d === '\r') {
      const cmd = sug.line.trim();
      if (cmd && !sug.lost) {
        if (sug.echoed) pushHist(serverId, cmd);
        else { // Enter beat the echo (paste + Enter, slow link): look at that screen row once it's drawn
          const b = term.buffer.active, row = b.baseY + b.cursorY;
          setTimeout(() => { if (b.getLine(row)?.translateToString(true).includes(cmd)) pushHist(serverId, cmd); }, 500);
        }
      }
      sug.line = ''; sug.lost = false; sug.echoed = false;
      return hide();
    }
    if (d === '\x7f' || d === '\b') sug.line = sug.line.slice(0, -1);
    else if (d === '\x03' || d === '\x15') { sug.line = ''; sug.lost = false; sug.echoed = false; } // Ctrl-C / Ctrl-U clear the line
    else if (/^[^\x00-\x1f\x7f]+$/.test(d)) sug.line += d;                    // typed or pasted text
    else { sug.lost = true; return hide(); }                                  // arrows, Tab, other control keys
    setTimeout(refresh); // in case the echo was already drawn before we updated the line
  }
  term.attachCustomKeyEventHandler(e => {
    if (sug.box.hidden || e.type !== 'keydown') return true;
    if (e.key === 'Tab') { e.preventDefault(); accept(); return false; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      sug.idx = (sug.idx + (e.key === 'ArrowDown' ? 1 : -1) + sug.items.length) % sug.items.length;
      render();
      return false;
    }
    if (e.key === 'Escape') { hide(); return false; }
    return true;
  });
  term.onWriteParsed(() => { if (sug.line) refresh(); }); // re-check after the shell echoes
  term.onScroll(hide);

  t.ready = api.ssh.shell(connId, term.cols, term.rows, cwd).then(id => {
    t.id = id;
    shellsById.set(id, t);
    term.onData(d => { track(d); api.ssh.write(id, d); }); // track first: Enter must see the line before the echo
    term.onResize(({ cols, rows }) => api.ssh.resize(id, cols, rows));
    api.ssh.resize(id, term.cols, term.rows); // size may have changed while the shell was opening
  }, e => term.writeln(`\x1b[31m${cleanErr(e)}\x1b[0m`));
  t.run = async cmd => { await t.ready; if (t.id) api.ssh.write(t.id, cmd); };
  t.dispose = () => {
    ro.disconnect();
    if (t.id) { api.ssh.closeShell(t.id); shellsById.delete(t.id); }
    term.dispose();
    host.replaceChildren();
  };
  return t;
}

// ================= server page =================
const tailHandlers = new Map(); // tailId -> { data(chunk), end() }
const xferHandlers = new Map(); // xferId -> progress handler (File Manager transfers)
api.sftp.onProgress((id, p) => xferHandlers.get(id)?.(p));
api.logs.onData((id, d) => tailHandlers.get(id)?.data(d));
api.logs.onEnd(id => { tailHandlers.get(id)?.end(); tailHandlers.delete(id); });

// A changed host key was accepted automatically: say so (and how to tell it apart from a problem).
api.ssh.onHostKeyReplaced((serverId, k) => {
  const short = f => (f ? f.slice(0, 16) + '…' : '?');
  toast(k.moved
    ? `${k.name}: saved host key updated for the new address ${k.store.addr}.`
    : `⚠ ${k.name}: the server's host key changed (${short(k.oldFp)} → ${short(k.store.fp)}) and was accepted. ` +
      'Expected after reinstalling the server or its SSH service; if not, check the server.', !k.moved);
});

api.ssh.onConnClosed((connId, msg) => {
  for (const v of views.values()) if (v.connId === connId) v.disconnected(msg);
});

function closeServer(serverId) {
  const v = views.get(serverId);
  if (!v) return;
  v.dispose();
  views.delete(serverId);
  show('home');
}

async function openServer(s) {
  if (views.has(s.id)) return show(s.id);

  const root = $('#serverTpl').content.firstElementChild.cloneNode(true);
  const q = sel => root.querySelector(sel);
  $('#views').append(root);
  const tabEl = el('button', { className: 'tab', onclick: () => show(s.id) },
    el('span', { textContent: '▤ ' + s.name }),
    el('span', { className: 'x', textContent: '×', title: 'Disconnect', onclick: e => { e.stopPropagation(); closeServer(s.id); } }));
  $('#tabs').append(tabEl);

  const v = { root, tabEl, connId: null, panel: 'files' };
  views.set(s.id, v);

  q('.sname').textContent = s.name;
  q('.saddr').textContent = typeOf(s) === 'rdp' // the server page is the SSH side of an RDP entry
    ? `${s.domain ? s.domain + '\\' : ''}${s.username}@${s.host}:${s.sshPort || 22} (SSH)`
    : `${s.username}@${s.host}:${s.port}`;
  q('.sdetails').textContent = q('.sdetails').title = s.details || '';
  q('.sdetails').hidden = !s.details;
  q('.back').onclick = () => show('home');
  const setStatus = (text, cls) => { q('.status').textContent = text; q('.status').className = 'status ' + cls; };

  // ---- side menu ----
  v.pickPanel = name => pickPanel(name); // used by "Open Metrics" from the home Alerts column
  function pickPanel(name) {
    v.panel = name;
    root.querySelectorAll('.panel').forEach(p => (p.hidden = !p.classList.contains(name)));
    root.querySelectorAll('.srvbody > .side .navitem').forEach(b => b.classList.toggle('active', b.dataset.panel === name));
    if (!v.connId) return;
    if (name === 'term') {
      if (!sessions.length && !v.termOpened) newSession();
      v.termOpened = true;
      requestAnimationFrame(() => active?.t.term.focus());
    }
    if (name === 'files' && !fm.loaded) loadDir('');
    if (name === 'stats') loadStats(); // measure every time the tab is opened
  }
  root.querySelectorAll('.srvbody > .side .navitem').forEach(b => (b.onclick = () => pickPanel(b.dataset.panel)));

  // ---- terminal sessions (tabs) ----
  const sessions = [];
  let active = null, sessNo = 0;

  function newSession(cwd) {
    if (!v.connId) return null;
    const host = el('div', { className: 'xhost' });
    q('.thosts').append(host);
    const sess = { host, title: `Session ${++sessNo}` };
    const titleEl = el('span', { className: 'ttitle', textContent: sess.title, title: 'Double-click to rename' });
    titleEl.ondblclick = e => { e.stopPropagation(); renameSession(sess, titleEl); };
    sess.tabEl = el('div', { className: 'ttab', onclick: () => activateSession(sess) },
      el('span', { className: 'tdot' }), titleEl,
      iconBtn('×', 'Close session', () => closeSession(sess), 'x'));
    q('.ttablist').append(sess.tabEl);
    sess.t = makeTerm(host, v.connId, cwd, s.id);
    sessions.push(sess);
    activateSession(sess);
    return sess;
  }

  function activateSession(sess) {
    active = sess;
    for (const x of sessions) {
      x.host.hidden = x !== sess;
      x.tabEl.classList.toggle('active', x === sess);
    }
    q('.tempty').hidden = sessions.length > 0;
    if (sess) requestAnimationFrame(() => sess.t.term.focus());
  }

  function closeSession(sess) {
    sess.t.dispose();
    sess.host.remove();
    sess.tabEl.remove();
    sessions.splice(sessions.indexOf(sess), 1);
    if (active === sess) activateSession(sessions[sessions.length - 1] || null);
    q('.tempty').hidden = sessions.length > 0;
  }

  function renameSession(sess, titleEl) {
    const inp = el('input', { className: 'trename', value: sess.title });
    titleEl.replaceWith(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = save => {
      if (done) return;
      done = true;
      if (save && inp.value.trim()) sess.title = inp.value.trim();
      titleEl.textContent = sess.title;
      inp.replaceWith(titleEl);
      sess.t.term.focus();
    };
    inp.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); };
    inp.onblur = () => finish(true);
    inp.onclick = e => e.stopPropagation();
  }

  // run text in the active session (open one if none)
  async function runInTerminal(cmd) {
    pickPanel('term');
    const sess = active || newSession();
    if (!sess) return;
    await sess.t.run(cmd);
    sess.t.term.focus();
  }
  const openInTerminal = dir => runInTerminal(`cd ${shq(dir)}\r`);

  q('.tnew').onclick = () => newSession();

  // ---- scripts side panel ----
  let scripts = [], dragId = null;
  const activeTags = new Set(); // show scripts having ANY of these tags
  let sortMode = 'manual';
  try { sortMode = localStorage.getItem('scriptSort') || 'manual'; } catch { /* default */ }
  q('.sc-sort').value = sortMode;
  const lastRun = () => { try { return JSON.parse(localStorage.getItem('scriptLastRun')) || {}; } catch { return {}; } };

  async function loadScripts() {
    try { scripts = await api.scripts.list(); } catch (e) { toast(cleanErr(e), true); }
    renderScripts();
  }
  const toggleTag = t => { activeTags[activeTags.has(t) ? 'delete' : 'add'](t); renderScripts(); };

  function renderTags() {
    const counts = new Map();
    for (const x of scripts) for (const t of x.tags || []) counts.set(t, (counts.get(t) || 0) + 1);
    for (const t of activeTags) if (!counts.has(t)) activeTags.delete(t);
    q('.sc-tags').replaceChildren(
      ...[...counts.keys()].sort().map(t => el('button', {
        className: 'tchip' + (activeTags.has(t) ? ' on' : ''), title: `Show scripts tagged "${t}"`, onclick: () => toggleTag(t),
      }, t, el('small', { textContent: counts.get(t) }))),
      ...(activeTags.size ? [el('button', { className: 'tchip clear', textContent: '✕ Clear', onclick: () => { activeTags.clear(); renderScripts(); } })] : []));
  }

  function renderScripts() {
    renderTags();
    const f = q('.sc-filter').value.toLowerCase();
    let list = scripts
      .filter(x => !f || `${x.name} ${x.description} ${x.command} ${(x.tags || []).join(' ')}`.toLowerCase().includes(f))
      .filter(x => !activeTags.size || (x.tags || []).some(t => activeTags.has(t)));
    if (sortMode === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    if (sortMode === 'recent') { const lr = lastRun(); list = [...list].sort((a, b) => (lr[b.id] || 0) - (lr[a.id] || 0)); }
    const canDrag = sortMode === 'manual' && !f && !activeTags.size;
    q('.sc-hint').textContent = sortMode !== 'manual' ? '' : canDrag ? 'Drag ⋮⋮ to change the order.' : 'Clear the search and tag filters to drag scripts into a new order.';
    q('.sc-list').replaceChildren(...list.map(x => {
      const li = el('li', { title: x.command, draggable: canDrag },
        el('div', { className: 'sc-head' },
          canDrag ? el('span', { className: 'grip', textContent: '⋮⋮', title: 'Drag to reorder' }) : null,
          el('b', { textContent: x.name }),
          el('span', { className: 'grow' }),
          iconBtn('✎', 'Edit', () => editScript(x)),
          iconBtn('🗑', 'Delete', () => deleteScript(x), 'icon danger'),
          iconBtn('▶ Run', 'Run in the active terminal session', () => runScript(x), 'primary sm')),
        x.description ? el('small', { textContent: x.description }) : null,
        el('code', { className: 'mono', textContent: x.command.split('\n')[0] + (x.command.includes('\n') ? ' …' : '') }),
        x.tags?.length ? el('div', { className: 'sc-tagrow' }, ...x.tags.map(t => el('span', {
          className: 'tag' + (activeTags.has(t) ? ' on' : ''), textContent: t, title: `Filter by "${t}"`,
          onclick: e => { e.stopPropagation(); toggleTag(t); },
        }))) : null);
      if (canDrag) {
        li.ondragstart = e => { dragId = x.id; li.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; };
        li.ondragend = () => { dragId = null; li.classList.remove('dragging'); };
        li.ondragover = e => {
          if (!dragId) return;
          e.preventDefault();
          const r = li.getBoundingClientRect();
          const after = e.clientY > r.top + r.height / 2;
          li.classList.toggle('drop-after', after);
          li.classList.toggle('drop-before', !after);
        };
        li.ondragleave = () => li.classList.remove('drop-after', 'drop-before');
        li.ondrop = async e => {
          e.preventDefault();
          const after = li.classList.contains('drop-after');
          li.classList.remove('drop-after', 'drop-before');
          if (!dragId || dragId === x.id) return;
          const ids = scripts.map(y => y.id).filter(id => id !== dragId);
          ids.splice(ids.indexOf(x.id) + (after ? 1 : 0), 0, dragId);
          scripts = ids.map(id => scripts.find(y => y.id === id));
          renderScripts();
          try { await api.scripts.reorder(ids); } catch (err) { toast(cleanErr(err), true); loadScripts(); }
        };
      }
      return li;
    }));
  }
  q('.sc-sort').onchange = () => {
    sortMode = q('.sc-sort').value;
    try { localStorage.setItem('scriptSort', sortMode); } catch { /* ignore */ }
    renderScripts();
  };
  q('.sc-restore').onclick = async () => {
    const n = await api.scripts.restoreBuiltins();
    toast(n ? `Restored ${n} built-in script${n === 1 ? '' : 's'}` : 'All built-in scripts are already in your list.');
    loadScripts();
  };
  function runScript(x) {
    try { localStorage.setItem('scriptLastRun', JSON.stringify({ ...lastRun(), [x.id]: Date.now() })); } catch { /* ignore */ }
    const body = x.command.replace(/\r\n/g, '\n').trimEnd();
    if (!body.includes('\n')) return runInTerminal(body + '\r');
    // multi-line: feed through a heredoc so blocks/functions run as one script
    const interp = body.startsWith('#!') ? body.slice(2, body.indexOf('\n')).trim() : 'sh';
    runInTerminal(`${interp} -s <<'ERATERM_SCRIPT'\r${body.replace(/\n/g, '\r')}\rERATERM_SCRIPT\r`);
  }
  function editScript(x = {}) {
    const f = $('#scriptForm');
    f.reset();
    for (const k of ['id', 'name', 'description', 'command']) f.elements[k].value = x[k] || '';
    f.elements.tags.value = (x.tags || []).join(', ');
    // existing tags as one-click chips
    const all = [...new Set(scripts.flatMap(y => y.tags || []))].sort();
    $('#scriptTagPick').replaceChildren(...all.map(t => el('button', {
      type: 'button', className: 'tchip', textContent: t,
      onclick: () => {
        const cur = f.elements.tags.value.split(',').map(y => y.trim()).filter(Boolean);
        if (!cur.includes(t)) f.elements.tags.value = [...cur, t].join(', ');
      },
    })));
    const dlg = $('#scriptDlg');
    dlg.returnValue = '';
    dlg.showModal();
    dlg.addEventListener('close', async () => {
      if (dlg.returnValue !== 'save') return;
      const e = f.elements;
      try {
        await api.scripts.save({ id: e.id.value || undefined, name: e.name.value, description: e.description.value, command: e.command.value, tags: e.tags.value });
        loadScripts();
      } catch (err) { toast(cleanErr(err), true); }
    }, { once: true });
  }
  async function deleteScript(x) {
    if (!confirm(`Delete script "${x.name}"?`)) return;
    await api.scripts.delete(x.id);
    loadScripts();
  }
  q('.tscripts').onclick = () => {
    const p = q('.scripts');
    p.hidden = !p.hidden;
    q('.tscripts').classList.toggle('on', !p.hidden);
    if (!p.hidden) loadScripts();
  };
  q('.sc-close').onclick = () => { q('.scripts').hidden = true; q('.tscripts').classList.remove('on'); };
  q('.sc-refresh').onclick = loadScripts;
  q('.sc-add').onclick = () => editScript();
  q('.sc-filter').oninput = renderScripts;
  q('.sc-up').onclick = async () => {
    try { const n = await api.scripts.import(); if (n) toast(`Imported ${n} script${n === 1 ? '' : 's'}`); loadScripts(); }
    catch (e) { toast(`Import failed: ${cleanErr(e)}`, true); }
  };
  q('.sc-down').onclick = async () => {
    try { const f = await api.scripts.export(); if (f) toast(`Exported to ${f}`); }
    catch (e) { toast(cleanErr(e), true); }
  };

  // ---- side terminal (inside file manager) ----
  let sideTerm = null;
  function openSide(dir) {
    sideTerm?.dispose();
    q('.sidepane').hidden = false;
    q('.sidetitle').textContent = dir;
    sideTerm = makeTerm(q('.sidepane .xhost'), v.connId, dir, s.id);
    requestAnimationFrame(() => sideTerm.term.focus());
  }
  q('.sideclose').onclick = () => { sideTerm?.dispose(); sideTerm = null; q('.sidepane').hidden = true; };

  // ---- file manager ----
  const fm = { path: '', entries: [], loaded: false, sort: { key: 'name', asc: true } };
  async function loadDir(dir) {
    try {
      const r = await api.sftp.list(v.connId, dir);
      Object.assign(fm, r, { loaded: true });
      q('.path').value = r.path;
      renderFiles();
    } catch (e) {
      toast(`Cannot open ${dir || 'home'}: ${cleanErr(e)}`, true);
      q('.path').value = fm.path;
    }
  }

  function renderFiles() {
    const term = q('.fsearch').value.toLowerCase();
    const hidden = q('.showhidden').checked;
    const list = fm.entries
      .filter(e => (hidden || !e.name.startsWith('.')) && (!term || e.name.toLowerCase().includes(term)))
      .sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || fileCmp(a, b)); // folders stay on top
    for (const th of q('.fm thead').querySelectorAll('th.sortable')) {
      const on = th.dataset.sort === fm.sort.key;
      th.classList.toggle('on', on);
      th.querySelector('.sorti').textContent = on ? (fm.sort.asc ? '▲' : '▼') : '⇅';
    }
    q('.frows').replaceChildren(...list.map(e => {
      const isDir = e.type === 'dir';
      const cwd = isDir ? e.path : fm.path;
      const tr = el('tr', { className: isDir ? 'dir' : '' },
        el('td', { className: 'fname' },
          fileIcon(fileKind(e)),
          el('span', { textContent: e.name }),
          e.link ? el('small', { className: 'link mono', textContent: `→ ${e.link}` }) : null),
        el('td', { className: 'r muted mono', textContent: isDir ? '—' : fmtSize(e.size) }),
        el('td', { className: 'r muted mono', textContent: ago(e.mtime) }),
        el('td', { className: 'r actions' },
          iconBtn('◧', 'Open in side terminal', () => openSide(cwd)),
          iconBtn('›_', 'Open in terminal', () => openInTerminal(cwd)),
          iconBtn('⧉', 'Copy path', () => navigator.clipboard.writeText(e.path).then(() => toast(`Copied ${e.path}`), err => toast(cleanErr(err), true))),
          isDir ? el('span', { className: 'ph-btn' }) : v.inLogs(e.path)
            ? iconBtn('≡✓', 'In Logs — click to open it in the Logs tab', () => v.openInLogs(e.path), 'icon inlogs')
            : iconBtn('≡⁺', 'Add to Logs', () => v.addToLogs(e.path)),
          iconBtn('⤓', isDir ? 'Download as .tar.gz' : 'Download', () => download(e)),
          iconBtn('🗑', 'Delete', () => remove(e), 'icon danger')));
      tr.ondblclick = () => (isDir ? loadDir(e.path) : download(e));
      return tr;
    }));
    const dirs = list.filter(e => e.type === 'dir').length;
    const bytes = list.reduce((n, e) => n + (e.type === 'dir' ? 0 : e.size || 0), 0);
    q('.fstat').textContent = `${dirs} folders · ${list.length - dirs} files · ${fmtSize(bytes)}`;
  }

  // Folders first (always), then the clicked column; click again to reverse.
  const fileCmp = (a, b) => {
    const k = fm.sort.key;
    const d = k === 'size' ? (a.size || 0) - (b.size || 0) : k === 'mtime' ? a.mtime - b.mtime : 0;
    return (fm.sort.asc ? 1 : -1) * (d || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  };
  for (const th of q('.fm thead').querySelectorAll('th.sortable')) {
    th.onclick = () => {
      const k = th.dataset.sort;
      fm.sort = { key: k, asc: fm.sort.key === k ? !fm.sort.asc : k === 'name' }; // size/date: biggest/newest first
      renderFiles();
    };
  }

  // ---- transfers: a card per upload/download with %, speed and time left ----
  const fmtDur = sec => (sec < 60 ? `${Math.max(1, Math.round(sec))}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${String(Math.round(sec % 60)).padStart(2, '0')}s` : `${Math.floor(sec / 3600)}h ${Math.round((sec % 3600) / 60)}m`);
  function transfer(kind) { // kind: 'up' | 'down'
    const id = Math.random().toString(36).slice(2);
    let card = null, t0 = 0, last = { t: 0, done: 0 }, speed = 0, cur = { done: 0, total: 0 };
    const make = name => {
      t0 = last.t = performance.now();
      const fill = el('i'), pct = el('b', { className: 'xpct' }), meta = el('small', { className: 'xmeta mono' });
      card = el('div', { className: `xfer ${kind} running` },
        el('span', { className: 'xicon' }, el('span', { textContent: kind === 'up' ? '⤒' : '⤓' })),
        el('div', { className: 'xmain' },
          el('div', { className: 'xline' }, el('b', { className: 'xname', textContent: name, title: name }), el('span', { className: 'grow' }), pct),
          el('div', { className: 'xbar' }, fill), meta),
        iconBtn('×', 'Dismiss', () => card.remove(), 'icon xclose'));
      Object.assign(card, { fill, pct, meta });
      q('.xfers').append(card);
    };
    xferHandlers.set(id, p => {
      if (!card) make(p.name);
      const now = performance.now(), dt = (now - last.t) / 1000;
      if (dt > 0.2) { // smoothed speed, so the estimate doesn't jump around
        const inst = (p.done - last.done) / dt;
        speed = speed ? speed * 0.7 + inst * 0.3 : inst;
        last = { t: now, done: p.done };
      }
      cur = p;
      const known = p.total > 0;
      card.classList.toggle('unknown', !known);
      const frac = known ? Math.min(0.99, p.done / p.total) : 0; // 100% only when it really finished
      card.fill.style.width = known ? `${frac * 100}%` : '';
      card.pct.textContent = known ? `${Math.floor(frac * 100)}%` : '';
      const left = known && speed > 0 ? ` · ${fmtDur((p.total - p.done) / speed)} left` : '';
      card.meta.textContent = `${fmtSize(p.done)}${known ? ` of ${fmtSize(p.total)}` : ''}${speed > 0 ? ` · ${fmtSize(speed)}/s` : ''}${left}`;
    });
    return {
      id,
      finish(err) {
        xferHandlers.delete(id);
        if (!card) return; // cancelled before it started (file dialog)
        const secs = (performance.now() - t0) / 1000;
        card.classList.remove('running', 'unknown');
        card.classList.add(err ? 'failed' : 'done');
        card.querySelector('.xicon span').textContent = err ? '✕' : '✓';
        if (err) { card.meta.textContent = cleanErr(err); return; }
        card.fill.style.width = '100%';
        card.pct.textContent = '100%';
        card.meta.textContent = `Done · ${fmtSize(cur.done)} in ${fmtDur(secs)}` + (secs > 1 && cur.done ? ` · avg ${fmtSize(cur.done / secs)}/s` : '');
        setTimeout(() => { card.classList.add('gone'); setTimeout(() => card.remove(), 400); }, 6000);
      },
    };
  }

  async function download(e) {
    const x = transfer('down');
    try {
      const saved = await api.sftp.download(v.connId, e.path, e.type === 'dir', x.id);
      x.finish();
      if (saved) toast(`Saved to ${saved}`);
    } catch (err) { x.finish(err); toast(`Download failed: ${cleanErr(err)}`, true); }
  }

  async function remove(e) {
    if (!confirm(`Delete ${e.path}${e.type === 'dir' ? ' and everything inside it' : ''}? This cannot be undone.`)) return;
    try { await api.sftp.delete(v.connId, e.path); toast(`Deleted ${e.name}`); } catch (err) { toast(`Delete failed: ${cleanErr(err)}`, true); }
    loadDir(fm.path);
  }

  async function upload(locals) {
    const x = transfer('up');
    try {
      const n = await api.sftp.upload(v.connId, fm.path, locals, x.id);
      x.finish();
      if (n) toast(`Uploaded ${n} item${n === 1 ? '' : 's'} to ${fm.path}`);
    } catch (err) { x.finish(err); toast(`Upload failed: ${cleanErr(err)}`, true); }
    loadDir(fm.path);
  }

  q('.up').onclick = () => loadDir(dirname(fm.path));
  q('.homedir').onclick = () => loadDir('');
  q('.refresh').onclick = () => loadDir(fm.path);
  q('.path').onkeydown = e => { if (e.key === 'Enter') loadDir(q('.path').value.trim()); };
  q('.fsearch').oninput = renderFiles;
  q('.showhidden').onchange = renderFiles;
  q('.upload').onclick = () => upload();
  q('.sideterm').onclick = () => openSide(fm.path);
  q('.mkdir').onclick = async () => {
    const name = await askName('New folder name');
    if (!name) return;
    try { await api.sftp.mkdir(v.connId, `${fm.path.replace(/\/$/, '')}/${name}`); } catch (err) { toast(cleanErr(err), true); }
    loadDir(fm.path);
  };

  const drop = q('.droparea');
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = e => { if (!drop.contains(e.relatedTarget)) drop.classList.remove('over'); };
  drop.ondrop = e => {
    e.preventDefault();
    drop.classList.remove('over');
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    if (paths.length) upload(paths);
  };

  // ---- logs ----
  const lg = { paths: [...(s.logPaths || [])], cur: null, live: false, tailId: null, partial: '', n: 0 };
  const lbody = q('.lbody');

  function renderSources() {
    const f = q('.lfilter').value.toLowerCase();
    q('.lcount').textContent = lg.paths.length;
    q('.llist').replaceChildren(...lg.paths.filter(p => !f || p.toLowerCase().includes(f)).map(p =>
      el('li', { className: p === lg.cur ? 'active' : '', title: p, onclick: () => selectLog(p) },
        el('span', { textContent: (isEventLogSrc(p) ? '⚑ ' : '▫ ') + srcName(p) }),
        iconBtn('×', 'Remove source', () => removeSource(p)))));
  }
  const saveSources = () => api.servers.setLogPaths(s.id, lg.paths);
  function removeSource(p) {
    lg.paths = lg.paths.filter(x => x !== p);
    saveSources();
    if (fm.loaded) renderFiles(); // its "Add to Logs" button turns back
    if (lg.cur === p) {
      stopTail(); lg.cur = null; lbody.replaceChildren(); updateLogStat();
      q('.lname').textContent = 'Select a log source'; q('.lpath').textContent = ''; q('.lcopy').hidden = true;
    }
    renderSources();
  }
  function addLogSource(p) {
    p = String(p).trim();
    if (!p) return null;
    if (!lg.paths.includes(p)) { lg.paths.push(p); saveSources(); }
    return p;
  }
  q('.ladd').onsubmit = e => {
    e.preventDefault();
    const inp = q('.ladd input');
    const p = addLogSource(inp.value);
    if (!p) return;
    inp.value = '';
    selectLog(p);
  };
  q('.lfilter').oninput = renderSources;
  // From the File Manager: add the file as a log source (stays on the File Manager; the button turns green).
  v.inLogs = p => lg.paths.includes(p);
  v.addToLogs = p => {
    addLogSource(p);
    renderFiles();
    toast(`Added to Logs: ${p}`);
  };
  v.openInLogs = p => { pickPanel('logs'); selectLog(p); };

  // Suggestions for the "add source" box, by the server's OS (known after the first connection).
  const LOG_SUGGEST = {
    windows: ['eventlog:System', 'eventlog:Application', 'eventlog:Security', 'eventlog:Setup',
      'eventlog:Microsoft-Windows-OpenSSH/Operational', 'eventlog:Microsoft-Windows-PowerShell/Operational',
      'C:\\ProgramData\\ssh\\logs\\sshd.log', 'C:\\Windows\\Logs\\CBS\\CBS.log', 'C:\\Windows\\Logs\\DISM\\dism.log'],
    macos: ['/var/log/system.log', '/var/log/install.log', '/var/log/wifi.log'],
    linux: ['/var/log/syslog', '/var/log/messages', '/var/log/auth.log', '/var/log/secure', '/var/log/kern.log',
      '/var/log/cloud-init.log', '/var/log/nginx/error.log', '/var/log/nginx/access.log', '/var/log/dpkg.log', '/var/log/dnf.log'],
  };
  // OS detected on the live connection wins; before that, what we last knew (RDP entries are Windows).
  const osOf = async () => (v.connId && (await api.ssh.os(v.connId).catch(() => '')))
    || servers.find(x => x.id === s.id)?.os || s.os || (typeOf(s) === 'rdp' ? 'windows' : '');
  const suggId = 'lsugg-' + s.id;
  const sugg = el('datalist', { id: suggId });
  root.append(sugg);
  q('.ladd input').setAttribute('list', suggId);
  const fillSuggest = async () => {
    const os = await osOf();
    q('.ladd input').placeholder = os === 'windows' ? 'C:\\path\\app.log  or  eventlog:System' : '/var/log/syslog';
    sugg.replaceChildren(...(LOG_SUGGEST[os] || LOG_SUGGEST.linux).filter(x => !lg.paths.includes(x)).map(value => el('option', { value })));
  };
  q('.ladd input').onfocus = fillSuggest;
  fillSuggest();

  function selectLog(p) {
    lg.cur = p;
    q('.lname').textContent = srcName(p);
    q('.lpath').textContent = isEventLogSrc(p) ? 'Windows Event Log' : p;
    q('.lcopy').hidden = isEventLogSrc(p);
    q('.ldl').hidden = isEventLogSrc(p); // an event log isn't a file
    renderSources();
    reloadLog();
  }

  function stopTail() {
    if (lg.tailId) { api.logs.stop(lg.tailId); tailHandlers.delete(lg.tailId); lg.tailId = null; }
  }

  function updateLogStat() {
    const counts = { info: 0, warn: 0, error: 0, debug: 0 };
    let shown = 0;
    for (const r of lbody.children) { if (r.dataset.lv in counts) counts[r.dataset.lv]++; if (!r.hidden) shown++; }
    for (const b of root.querySelectorAll('.lv')) b.querySelector('small').textContent = counts[b.dataset.lv] || '';
    q('.lstat').textContent = (lg.live ? '● Live · ' : '') + `${shown} of ${lbody.childElementCount} lines`;
    q('.llive').classList.toggle('on', lg.live);
  }

  // A row shows only if it passes all three: time window, level buttons, search (in "Only matches" mode).
  lg.levels = new Set(); // empty = all levels
  function applyFilters(row, cutoff = sinceCutoff()) {
    const term = q('.lsearch').value.toLowerCase();
    const match = !!term && row.dataset.text.includes(term);
    const onlyMatches = q('.lmode').value === 'filter';
    row.classList.toggle('hit', match && !onlyMatches);
    row.hidden = !logRowVisible(
      { t: row.dataset.t ? Number(row.dataset.t) : null, lv: row.dataset.lv, text: row.dataset.text },
      { cutoff, levels: lg.levels, term, onlyMatches });
  }
  const sinceCutoff = () => { const ms = Number(q('.lsince').value); return ms ? Date.now() - ms : 0; };
  const filterAll = () => { const c = sinceCutoff(); for (const r of lbody.children) applyFilters(r, c); updateLogStat(); };
  q('.lsearch').oninput = filterAll;
  q('.lmode').onchange = filterAll;
  q('.lsince').onchange = filterAll;
  for (const b of root.querySelectorAll('.lv')) {
    b.onclick = () => {
      lg.levels[lg.levels.has(b.dataset.lv) ? 'delete' : 'add'](b.dataset.lv);
      b.classList.toggle('on', lg.levels.has(b.dataset.lv));
      filterAll();
    };
  }
  q('.lcopy').onclick = () => lg.cur && navigator.clipboard.writeText(lg.cur)
    .then(() => toast(`Copied ${lg.cur}`), err => toast(cleanErr(err), true));

  function appendText(chunk) {
    const atBottom = lbody.scrollHeight - lbody.scrollTop - lbody.clientHeight < 40;
    const lines = (lg.partial + chunk.replace(/\r/g, '')).split('\n');
    lg.partial = lines.pop();
    const frag = document.createDocumentFragment();
    const cutoff = sinceCutoff();
    for (const line of lines) {
      const lv = logLevel(line);
      const row = el('div', { className: 'lrow ' + lv },
        el('span', { className: 'ln', textContent: ++lg.n }), el('span', { textContent: line }));
      row.dataset.text = line.toLowerCase();
      row.dataset.lv = lv;
      // Continuation lines (stack traces) take the time of the line above them.
      const t = parseLogTime(line);
      if (t !== null) lg.lastT = t;
      if (lg.lastT != null) row.dataset.t = lg.lastT;
      applyFilters(row, cutoff);
      frag.append(row);
    }
    lbody.append(frag);
    const max = Number(q('.llines').value); // keep the last N lines only
    while (lbody.childElementCount > max) lbody.firstElementChild.remove();
    if (atBottom) lbody.scrollTop = lbody.scrollHeight;
    updateLogStat();
  }

  async function reloadLog() {
    stopTail();
    lbody.replaceChildren();
    lg.partial = ''; lg.n = 0; lg.lastT = null;
    updateLogStat();
    if (!lg.cur || !v.connId) return;
    const n = q('.llines').value;
    const file = lg.cur;
    try {
      if (lg.live) {
        const id = await api.logs.tail(v.connId, file, n);
        if (!lg.live || lg.cur !== file) return api.logs.stop(id); // user changed something meanwhile
        lg.tailId = id;
        tailHandlers.set(id, {
          data: appendText,
          end: () => { if (lg.tailId === id) { lg.tailId = null; lg.live = false; updateLogStat(); } },
        });
      } else {
        appendText(await api.logs.read(v.connId, file, n) + '\n');
      }
    } catch (err) { toast(`${basename(file)}: ${cleanErr(err)}`, true); }
    lbody.scrollTop = lbody.scrollHeight;
  }

  q('.llive').onclick = () => {
    lg.live = !lg.live;
    if (lg.live) reloadLog();
    else { stopTail(); updateLogStat(); } // stopping keeps what's on screen
  };
  q('.llines').onchange = reloadLog;
  q('.lrefresh').onclick = reloadLog;
  q('.lclear').onclick = () => { lbody.replaceChildren(); updateLogStat(); }; // screen only, tail keeps running
  // SFTP on Windows wants /C:/dir/file, people type C:\dir\file
  const sftpPath = p => (/^[A-Za-z]:[\\/]/.test(p) ? '/' + p.replace(/\\/g, '/') : p);
  q('.ldl').onclick = () => lg.cur && !isEventLogSrc(lg.cur) && download({ name: srcName(lg.cur), path: sftpPath(lg.cur), type: 'file' });

  // Ask AI about the log: sends the lines currently shown (filters applied), newest last.
  const visibleLogText = () => [...lbody.children].filter(r => !r.hidden)
    .map(r => r.lastElementChild.textContent).join('\n');
  q('.laiBtn').onclick = () => {
    const box = q('.lai');
    box.hidden = !box.hidden;
    if (!box.hidden) {
      const n = [...lbody.children].filter(r => !r.hidden).length;
      q('.laiNote').textContent = lg.cur
        ? `Sends the ${n} line${n === 1 ? '' : 's'} shown now (after filters) from ${lg.cur}. Narrow with the filters first for a focused answer.`
        : 'Select a log source first.';
      q('.laiQ').focus();
    }
  };
  q('.laiClose').onclick = () => { q('.lai').hidden = true; };
  q('.laiForm').onsubmit = async e => {
    e.preventDefault();
    if (!v.connId || !lg.cur) return;
    const text = visibleLogText();
    if (!text.trim()) { q('.laiNote').textContent = 'No lines shown — load the log or relax the filters.'; return; }
    const btn = q('.laiForm button.primary');
    btn.disabled = true; btn.textContent = 'Analyzing…';
    try {
      const answer = await api.ai.analyze(v.connId, { kind: 'logs', question: q('.laiQ').value.trim(), text, source: lg.cur });
      showAiAnswer(q('.lai .aiOut'), answer);
    } catch (err) {
      showAiError(q('.laiNote'), err);
    } finally {
      btn.disabled = false; btn.textContent = 'Analyze';
    }
  };
  renderSources();

  // ---- AI (suggest, show, run only on approval) ----
  q('.aiForm').onsubmit = async e => {
    e.preventDefault();
    const req = q('.aiInput').value.trim();
    if (!req || !v.connId) return;
    q('.aiError').textContent = '';
    q('.aiResult').hidden = true;
    q('.tAiOut').hidden = true;
    const btn = q('.aiSuggest');
    btn.disabled = true; btn.textContent = 'Thinking…';
    try {
      const r = await api.ai.suggest(v.connId, req);
      q('.aiCmd').value = r.command;
      q('.aiExplain').textContent = r.explanation;
      q('.aiRisk').textContent = `risk: ${r.risk}`;
      q('.aiRisk').className = 'aiRisk risk-' + r.risk;
      q('.aiResult').hidden = false;
    } catch (err) {
      showAiError(q('.aiError'), err);
    } finally {
      btn.disabled = false; btn.textContent = 'Suggest command';
    }
  };

  // Ask about the terminal screen: sends the active session's recent output (read-only, nothing runs).
  q('.aiAsk').onclick = async () => {
    if (!v.connId) return;
    const sess = active;
    if (!sess) { q('.aiError').textContent = 'Open a terminal session first.'; return; }
    const text = termText(sess.t.term, 400);
    if (!text.trim()) { q('.aiError').textContent = 'The terminal is empty — run something first.'; return; }
    q('.aiError').textContent = '';
    q('.aiResult').hidden = true;
    const btn = q('.aiAsk');
    btn.disabled = true; btn.textContent = 'Analyzing…';
    try {
      const answer = await api.ai.analyze(v.connId, { kind: 'terminal', question: q('.aiInput').value.trim(), text });
      showAiAnswer(q('.tAiOut'), answer);
    } catch (err) {
      showAiError(q('.aiError'), err);
    } finally {
      btn.disabled = false; btn.textContent = '✦ Ask about output';
    }
  };
  q('.aiApprove').onclick = () => {
    const cmd = q('.aiCmd').value.trim();
    if (!cmd) return;
    runInTerminal(cmd + '\r');
    q('.aiResult').hidden = true;
    q('.aiInput').value = '';
  };
  q('.aiCancel').onclick = () => { q('.aiResult').hidden = true; };

  // ---- metrics ----
  const gb = n => (n / 1e9).toFixed(1) + 'G';
  v.pollMetrics = async () => {
    try {
      const m = await api.ssh.metrics(v.connId);
      const pct = (u, t) => Math.round((u / t) * 100) + '%';
      q('.mCpu').textContent = m.cpu == null ? '—' : m.cpu + '%';
      if (m.memTotal) q('.mMem').textContent = `${pct(m.memUsed, m.memTotal)} (${gb(m.memUsed)}/${gb(m.memTotal)})`;
      if (m.diskTotal) {
        q('.mDisk').textContent = `${pct(m.diskUsed, m.diskTotal)} (${gb(m.diskUsed)}/${gb(m.diskTotal)})`;
        q('.fdisk').textContent = `Disk ${gb(m.diskUsed)} / ${gb(m.diskTotal)} (${pct(m.diskUsed, m.diskTotal)})`;
      }
      v.checkAlerts?.({ cpu: m.cpu, mem: m.memTotal ? (m.memUsed / m.memTotal) * 100 : null, disk: m.diskTotal ? (m.diskUsed / m.diskTotal) * 100 : null });
    } catch { /* unsupported OS (e.g. Windows): leave dashes */ }
  };

  // ---- metrics tab: cards with 270° gauges, alerts, actions, top processes ----
  const RING = 2 * Math.PI * 42, ARC = RING * 0.75;
  const KNAME = { cpu: 'CPU', mem: 'Memory', disk: 'Disk' };
  const card = k => q(`.gcard[data-k="${k}"]`);
  const pctOf = (u, t) => (t ? (u / t) * 100 : null);
  function setGauge(k, pct) {
    const g = card(k);
    const val = pct == null || !Number.isFinite(pct) ? null : Math.max(0, Math.min(100, pct));
    g.querySelector('.gtrack').style.strokeDasharray = `${ARC} ${RING}`;
    g.querySelector('.gbar').style.strokeDasharray = `${ARC * (val ?? 0) / 100} ${RING}`;
    g.classList.toggle('hot', val >= 90);
    g.classList.toggle('warm', val >= 70 && val < 90);
    g.querySelector('.gval b').textContent = val == null ? '—' : (val < 10 ? val.toFixed(1) : Math.round(val)) + '%';
  }
  const fmtMem = b => (b == null ? '—' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
  const fmtDisk = b => (b == null ? '—' : b >= 1e12 ? (b / 1e12).toFixed(1) + 'T' : b >= 1e9 ? (b / 1e9).toFixed(1) + 'G' : (b / 1e6).toFixed(0) + 'M');
  const span = (cls, text) => el('span', { className: cls, textContent: text });

  // Alerts: off until the user turns one on. Checked on every metrics poll (5 s) while connected,
  // even when this server isn't on screen. One notification per crossing; re-arms 5 points below.
  v.alerts = { cpu: { on: false, threshold: 90 }, mem: { on: false, threshold: 90 }, disk: { on: false, threshold: 90 }, ...(s.alerts || {}) };
  v.hasAlerts = () => Object.values(v.alerts).some(a => a.on);
  const firing = {};
  function renderAlertBtns() {
    for (const k of ['cpu', 'mem', 'disk']) {
      const a = v.alerts[k], b = card(k).querySelector('.galert');
      b.textContent = a.on ? `🔔 Alert > ${a.threshold}%` : '🔔 Set alert';
      b.classList.toggle('on', a.on);
      card(k).classList.toggle('alerting', !!(a.on && firing[k]));
    }
  }
  function checkAlerts(vals) {
    const before = JSON.stringify([...(alertState.get(s.id) || new Map()).keys()]);
    const state = alertState.get(s.id) || new Map();
    for (const k of ['cpu', 'mem', 'disk']) {
      const a = v.alerts[k], val = vals[k];
      if (!a.on || val == null) { firing[k] = false; state.delete(k); continue; }
      if (val >= a.threshold && !firing[k]) {
        firing[k] = true;
        state.set(k, { val, threshold: a.threshold, since: Date.now() });
        const msg = `${s.name}: ${KNAME[k]} at ${Math.round(val)}% (alert above ${a.threshold}%)`;
        toast('🔔 ' + msg, true);
        notify('EranTerm alert', msg);
      } else if (val < a.threshold - 5) { firing[k] = false; state.delete(k); }
      else if (firing[k]) state.set(k, { ...state.get(k), val }); // keep the latest value for the tooltip
    }
    alertState.set(s.id, state);
    renderAlertBtns();
    // home table: redraw when the set of firing alerts changed (values refresh on the next redraw)
    if (!$('#home').hidden && JSON.stringify([...state.keys()]) !== before) renderServers();
  }
  for (const k of ['cpu', 'mem', 'disk']) {
    card(k).querySelector('.galert').onclick = async () => {
      const a = v.alerts[k];
      const on = el('input', { type: 'checkbox', checked: a.on });
      const th = el('input', { type: 'number', min: 1, max: 99, value: a.threshold, className: 'num' });
      const okd = await ask({
        title: `${KNAME[k]} alert — ${s.name}`, ok: 'Save',
        body: [
          el('label', { className: 'row' }, on, ` Alert me when ${KNAME[k]} usage is above`),
          el('label', { className: 'row' }, th, ' %'),
          el('p', { className: 'hint', textContent: 'Checked every 5 s while this server is connected (also when you are on another tab). You get one notification each time it crosses the limit.' }),
        ],
      });
      if (!okd) return;
      v.alerts = await api.servers.setAlerts(s.id, { ...v.alerts, [k]: { on: on.checked, threshold: th.value } });
      s.alerts = v.alerts;
      firing[k] = false;
      alertState.get(s.id)?.delete(k);
      const hs = servers.find(x => x.id === s.id); // keep the home table's copy in step
      if (hs) hs.alerts = v.alerts;
      renderAlertBtns();
      toast(v.alerts[k].on ? `${KNAME[k]} alert on: above ${v.alerts[k].threshold}%` : `${KNAME[k]} alert off`);
    };
  }
  renderAlertBtns();

  // ---- load + render ----
  v.stSort = 'cpu';
  let statsBusy = false, last = null;
  async function loadStats() {
    if (!v.connId || statsBusy) return;
    statsBusy = true;
    q('.stReload').disabled = true;
    q('.stTime').textContent = 'measuring…';
    try {
      const [m, t] = await Promise.all([api.ssh.metrics(v.connId), api.ssh.top(v.connId, v.stSort)]);
      last = { m, t };
      const memPct = pctOf(m.memUsed, m.memTotal), diskPct = pctOf(m.diskUsed, m.diskTotal);
      setGauge('cpu', m.cpu); setGauge('mem', memPct); setGauge('disk', diskPct);
      q('.gUptime').textContent = t.uptime || '—';
      q('.gCores').replaceChildren(...(t.cores ? ['CPU cores: ', el('b', { textContent: t.cores })] : []),
        ...(t.load ? [`   ·   Load ${t.load.map(x => x.toFixed(2)).join(' / ')}`] : []));
      q('.gMemUsed').replaceChildren(fmtMem(m.memUsed), span('muted', ` / ${fmtMem(m.memTotal)}`));
      q('.gMemAvail').textContent = fmtMem(t.memAvail ?? (m.memTotal != null ? m.memTotal - m.memUsed : null));
      q('.gSwap').textContent = t.swapTotal ? `${fmtMem(t.swapUsed)} / ${fmtMem(t.swapTotal)}` : 'none';
      q('.gDiskUsed').replaceChildren(fmtDisk(m.diskUsed), span('muted', ` / ${fmtDisk(m.diskTotal)}`));
      q('.gDiskAvail').textContent = fmtDisk(m.diskTotal != null ? m.diskTotal - m.diskUsed : null);
      q('.stinfo').textContent = t.procs.length ? `top ${t.procs.length} by ${v.stSort === 'mem' ? 'memory' : 'CPU'}` : '';
      renderProcs(t.procs);
      checkAlerts({ cpu: m.cpu, mem: memPct, disk: diskPct });
      q('.stTime').textContent = 'measured ' + new Date().toLocaleTimeString();
    } catch (err) {
      q('.stTime').textContent = '';
      toast(`Metrics: ${cleanErr(err)}`, true);
    } finally {
      statsBusy = false;
      q('.stReload').disabled = false;
    }
  }
  const bar = pct => el('span', { className: 'pbar' }, el('i', { style: `width:${Math.min(100, Math.max(0, pct))}%` }));
  function renderProcs(procs) {
    for (const th of root.querySelectorAll('.sttable th.sortable')) {
      th.classList.toggle('on', th.dataset.sort === v.stSort);
      th.querySelector('.sorti').textContent = th.dataset.sort === v.stSort ? '▼' : '⇅';
    }
    if (!procs.length) {
      q('.stRows').replaceChildren(el('tr', {}, el('td', { colSpan: 5, className: 'muted', textContent: 'No process list (ps not available on this server).' })));
      return;
    }
    q('.stRows').replaceChildren(...procs.map(p => {
      const name = p.command.split('/').pop() || p.command; // macOS ps shows full paths
      return el('tr', {},
        el('td', { className: 'r mono', textContent: p.pid }),
        el('td', { className: 'pname', title: `${p.command}\nuser: ${p.user} · RSS ${fmtMem(p.rss)}` },
          el('b', { textContent: name }), span('muted puser', p.user)),
        el('td', { className: 'pcell' }, span('mono pv' + (p.cpu >= 50 ? ' hotv' : ''), p.cpu.toFixed(1) + '%'), bar(p.cpu)),
        el('td', { className: 'pcell mem' }, span('mono pv', p.mem.toFixed(1) + '%'), bar(p.mem)),
        el('td', { className: 'r' }, iconBtn('🗑', `End process ${p.pid}`, () => killProc(p), 'icon danger pkill')));
    }));
  }
  for (const th of root.querySelectorAll('.sttable th.sortable')) {
    th.onclick = () => { v.stSort = th.dataset.sort; loadStats(); };
  }

  async function killProc(p) {
    const force = el('input', { type: 'checkbox' });
    const okd = await ask({
      title: `End process ${p.pid}?`, ok: 'End process', danger: true,
      body: [
        el('p', { className: 'mono actcmd', textContent: p.command }),
        el('p', { className: 'hint', textContent: `User ${p.user} · CPU ${p.cpu}% · Memory ${p.mem}%. Sends SIGTERM so it can shut down cleanly. Uses sudo if the process isn't yours.` }),
        el('label', { className: 'row' }, force, ' Force kill (SIGKILL) — stops it immediately, no clean-up'),
      ],
    });
    if (!okd) return;
    try {
      await api.ssh.kill(v.connId, p.pid, force.checked);
      toast(`Sent ${force.checked ? 'SIGKILL' : 'SIGTERM'} to ${p.pid} (${p.command.split('/').pop()})`);
      setTimeout(loadStats, 800);
    } catch (err) { toast(`Kill ${p.pid}: ${cleanErr(err)}`, true); }
  }

  q('.memClear').onclick = async () => {
    const okd = await ask({
      title: `Clear cache / buffers on ${s.name}?`, ok: 'Clear cache',
      body: [
        el('p', { textContent: 'Frees memory used for cached file data (Linux: sync + drop_caches, macOS: purge). Running programs keep their memory; nothing is deleted.' }),
        el('p', { className: 'hint', textContent: 'Disk reads are slower for a while as the cache refills. Needs root (sudo).' }),
      ],
    });
    if (!okd) return;
    const before = last?.t.memAvail;
    const btn = q('.memClear');
    btn.disabled = true;
    try {
      await api.maint.dropCaches(v.connId);
      await loadStats();
      const after = last?.t.memAvail;
      toast('Cache cleared.' + (before != null && after != null ? ` Available memory ${fmtMem(before)} → ${fmtMem(after)}.` : ''));
    } catch (err) { toast(`Clear cache: ${cleanErr(err)}`, true); }
    finally { btn.disabled = false; }
  };

  // Disk clean: scan first (shows what each category would free), user picks, then delete.
  q('.diskClean').onclick = async () => {
    const list = el('div', { className: 'cleanlist' }, el('p', { className: 'muted', textContent: 'Scanning… (measuring what can be freed)' }));
    const total = el('p', { className: 'hint' });
    const boxes = [];
    const sumSel = () => {
      const n = boxes.filter(b => b.chk.checked).reduce((x, b) => x + (b.bytes || 0), 0);
      total.textContent = `Selected: about ${fmtDisk(n)} to free. Deleted files can't be recovered.`;
      $('#actDlg .actOk').disabled = !boxes.some(b => b.chk.checked);
    };
    const pending = ask({ title: `Clean disk on ${s.name}`, ok: 'Delete selected', danger: true, okDisabled: true,
      body: [list, total, el('p', { className: 'hint', textContent: 'Only these fixed locations are touched; current logs and recent temp files are kept. Needs root (sudo) for system folders.' })] });
    api.maint.scanDisk(v.connId).then(items => {
      list.replaceChildren(...items.map(i => {
        const chk = el('input', { type: 'checkbox', checked: i.id !== 'pkg' && (i.bytes ?? 0) > 0, onchange: sumSel });
        boxes.push({ id: i.id, chk, bytes: i.bytes });
        return el('label', { className: 'row cleanitem' }, chk,
          el('span', { className: 'grow' }, el('b', { textContent: i.label }), el('small', { className: 'muted', textContent: i.detail })),
          el('span', { className: 'mono', textContent: i.bytes == null ? '?' : fmtDisk(i.bytes) }));
      }));
      sumSel();
    }).catch(err => list.replaceChildren(el('p', { className: 'error', textContent: `Scan failed: ${cleanErr(err)}` })));
    if (!(await pending)) return;
    const ids = boxes.filter(b => b.chk.checked).map(b => b.id);
    if (!ids.length) return;
    const before = last?.m.diskUsed;
    const btn = q('.diskClean');
    btn.disabled = true;
    toast('Cleaning disk…');
    try {
      await api.maint.cleanDisk(v.connId, ids);
      await loadStats();
      const after = last?.m.diskUsed;
      toast('Disk cleaned.' + (before != null && after != null ? ` Freed about ${fmtDisk(Math.max(0, before - after))}.` : ''));
    } catch (err) { toast(`Clean disk: ${cleanErr(err)}`, true); }
    finally { btn.disabled = false; }
  };

  q('.stReload').onclick = loadStats;
  let statsTimer = null;
  q('.stAuto').onchange = () => {
    clearInterval(statsTimer);
    const ms = Number(q('.stAuto').value);
    // only while this server page and its Metrics tab are on screen
    statsTimer = ms ? setInterval(() => { if (v.panel === 'stats' && !root.hidden) loadStats(); }, ms) : null;
  };
  v.checkAlerts = checkAlerts;

  // ---- lifecycle ----
  v.onShow = () => { if (v.panel === 'term') active?.t.term.focus(); };
  v.disconnected = msg => {
    v.connId = null;
    stopTail();
    setStatus('DISCONNECTED — click to reconnect', 'err');
    if (msg) toast(`${s.name}: ${msg}`, true);
  };
  v.dispose = () => {
    alertState.delete(s.id);
    clearInterval(statsTimer);
    stopTail();
    sideTerm?.dispose();
    for (const x of [...sessions]) closeSession(x);
    if (v.connId) api.ssh.disconnect(v.connId);
    v.connId = null;
    root.remove();
    tabEl.remove();
  };
  q('.status').onclick = () => {
    if (v.connId) return;
    closeServer(s.id);
    openServer(servers.find(x => x.id === s.id) || s);
  };

  pickPanel('files');
  show(s.id);
  try {
    v.connId = await api.ssh.connect(s.id);
  } catch (e) {
    setStatus('FAILED — click to retry', 'err');
    toast(`${s.name}: ${cleanErr(e)}`, true);
    return;
  }
  if (!views.has(s.id)) return api.ssh.disconnect(v.connId); // tab closed while connecting
  setStatus('● CONNECTED', 'on');
  pickPanel(v.panel);
  v.pollMetrics();
}

// Poll metrics for the server page on screen, plus background servers that have an alert switched on.
setInterval(() => {
  for (const v of views.values()) if (v.connId && (!v.root.hidden || v.hasAlerts?.())) v.pollMetrics();
}, 5000);

refreshServers();

// ================= foldable side menus (one state for all menus) =================
const setFolded = on => {
  document.body.classList.toggle('folded', on);
  try { localStorage.setItem('sideFolded', on ? '1' : ''); } catch { /* storage unavailable: just don't remember */ }
};
try { setFolded(localStorage.getItem('sideFolded') === '1'); } catch { /* default: expanded */ }
// Resizable side menus: drag the right edge (the .side::after strip); one width for all menus.
const setSideW = w => document.body.style.setProperty('--side-w', Math.min(480, Math.max(160, w)) + 'px');
try { const w = +localStorage.getItem('sideW'); if (w) setSideW(w); } catch { /* default width */ }
document.addEventListener('pointerdown', e => {
  const side = e.target;
  if (!side.classList?.contains('side') || document.body.classList.contains('folded')) return;
  const { left, right } = side.getBoundingClientRect();
  if (e.clientX < right - 4) return; // a click inside the menu, not on the edge strip
  e.preventDefault();
  document.body.classList.add('resizing');
  const move = ev => setSideW(ev.clientX - left);
  addEventListener('pointermove', move);
  addEventListener('pointerup', () => {
    removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    try { localStorage.setItem('sideW', parseInt(document.body.style.getPropertyValue('--side-w'))); } catch { /* not remembered */ }
  }, { once: true });
});
document.addEventListener('click', e => {
  if (e.target.closest('.fold')) setFolded(!document.body.classList.contains('folded'));
});
