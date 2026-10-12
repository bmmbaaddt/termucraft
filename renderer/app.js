/* TermuCraft renderer */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const h = html => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => crypto.randomUUID();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const fmtSize = n => n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' MB' : (n / 1073741824).toFixed(2) + ' GB';
const fmtUp = s => { const d = Math.floor(s / 86400), hh = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60); return d ? `${d}d ${hh}h` : `${hh}h ${m}m`; };

let V = null; // decrypted vault data
const save = (...keys) => api.call('vault:save', Object.fromEntries(keys.map(k => [k, V[k]])));

function toast(msg, kind = '') {
  const t = h(`<div class="toast ${kind}">${esc(msg)}</div>`);
  $('#toasts').append(t); setTimeout(() => t.remove(), kind === 'bad' ? 7000 : 3500);
}
const errLoc = e => { const s = (e && e.stack || '').split('\n').find(l => /app\.js|db\.js|import\.js/.test(l)); return s ? ' — ' + s.trim().replace(/.*[\\/]/, '').replace(/\)$/, '') : ''; };
window.addEventListener('unhandledrejection', e => toast((e.reason && e.reason.message || String(e.reason)) + errLoc(e.reason), 'bad'));
window.addEventListener('error', e => { if (e.error) toast(e.error.message + errLoc(e.error), 'bad'); });

// ---------------- settings / themes ----------------
const THEMES = {
  'Classic Dark': { background: '#1e1e1e', foreground: '#ececec', cursor: '#b4b4c0', selectionBackground: '#3a4a6b' },
  'One Dark': { background: '#1b1d23', foreground: '#abb2bf', cursor: '#528bff', selectionBackground: '#3e4451', black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4' },
  Dracula: { background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', selectionBackground: '#44475a', black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2' },
  'Solarized Dark': { background: '#002b36', foreground: '#839496', cursor: '#93a1a1', selectionBackground: '#073642', black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5' },
  Monokai: { background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', selectionBackground: '#49483e', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4' },
  Matrix: { background: '#000000', foreground: '#00ff66', cursor: '#00ff66', selectionBackground: '#004d1f', green: '#00ff66' },
  Light: { background: '#ffffff', foreground: '#1d2330', cursor: '#1d2330', selectionBackground: '#bcd4ff', black: '#000000', red: '#c91b00', green: '#00a600', yellow: '#a68b00', blue: '#0225c7', magenta: '#b200b2', cyan: '#00a6b2', white: '#bfbfbf' },
};
const DEFAULTS = {
  appTheme: 'dark', accent: '#3b82f6', brandName: 'TermuCraft', termTheme: 'Classic Dark', fontFamily: 'Consolas, "Cascadia Mono", monospace',
  fontSize: 14, cursorStyle: 'block', cursorBlink: true, scrollback: 10000, copyOnSelect: true, rightClickPaste: true,
  highlight: true, highlightRules: '', confirmClose: true, monitor: true, x11Display: 0, autoStartX: false, vncViewer: '',
  autoLockMin: 60, autoLog: false, logDir: '', dbRowLimit: 200,
  defaultShell: 'bash', disabledTypes: [], servers: {},
};
const S = () => ({ ...DEFAULTS, ...V.settings });
let HL = Highlight.compile();
function parseRules(text) {
  const rules = text.split('\n').map(l => l.split('=>')).filter(p => p.length === 2 && p[0].trim()).map(([p, c]) => ({ pattern: p.trim(), color: c.trim() }));
  return rules.length ? rules : null;
}
function applySettings() {
  const s = S();
  document.documentElement.dataset.theme = s.appTheme;
  document.documentElement.style.setProperty('--accent', s.accent);
  $('#brandName').textContent = s.brandName; document.title = s.brandName;
  HL = Highlight.compile(parseRules(s.highlightRules) || undefined);
  for (const t of tabs) if (t.term) {
    Object.assign(t.term.options, termOptions());
    fitTab(t);
  }
}
const termOptions = () => { const s = S(); return { theme: THEMES[s.termTheme] || THEMES['Classic Dark'], fontFamily: s.fontFamily, fontSize: +s.fontSize, cursorStyle: s.cursorStyle, cursorBlink: !!s.cursorBlink, scrollback: +s.scrollback }; };

// ---------------- modal + forms ----------------
function modal(title, body, buttons = [{ label: 'Close' }], cls = '') {
  const back = h(`<div class="back ${cls.includes('sticky') ? 'lockscreen' : ''}"><div class="modal ${cls}"><h2>${esc(title)}</h2><div class="body"></div><div class="foot"></div></div></div>`);
  const b = $('.body', back);
  typeof body === 'string' ? (b.innerHTML = body) : b.append(body);
  const close = () => { back.remove(); if (active && active.term) active.term.focus(); };
  for (const bt of buttons) {
    const e = h(`<button class="${bt.cls || ''}">${esc(bt.label)}</button>`);
    e.onclick = async () => {
      try { e.disabled = true; if (bt.onClick && (await bt.onClick(b)) === false) return; close(); }
      catch (err) { toast(err.message, 'bad'); } finally { e.disabled = false; }
    };
    $('.foot', back).append(e);
  }
  if (!buttons.length) $('.foot', back).remove();
  back.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !cls.includes('sticky')) close();
    if (e.key === 'Enter' && e.target.tagName === 'INPUT') { const p = $('.foot button.primary', back); p && p.click(); }
  });
  $('#modals').append(back);
  setTimeout(() => { const f = $('input:not([type=checkbox]),select,textarea', b); f && f.focus(); });
  return { el: b, close };
}

function form(fields, vals = {}) {
  const el = h('<div class="form"></div>');
  for (const [k, label, type = 'text', def, opts] of fields) {
    if (type === 'heading') { el.insertAdjacentHTML('beforeend', `<div class="full dim" style="margin-top:6px;font-weight:600">${esc(label)}</div>`); continue; }
    const v = vals[k] ?? def ?? '';
    let input;
    if (type === 'check') input = `<input type="checkbox" data-k="${k}" ${v ? 'checked' : ''}>`;
    else if (type === 'select') input = `<select data-k="${k}">${opts.map(o => { const [ov, ol] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
    else if (type === 'textarea') input = `<textarea data-k="${k}" rows="5" style="width:100%" class="mono">${esc(v)}</textarea>`;
    else if (type === 'file' || type === 'dir') input = `<div class="row"><input data-k="${k}" value="${esc(v)}"><button data-browse="${type}" type="button">Browse…</button></div>`;
    else if (type === 'password') input = `<div class="row"><input type="password" data-k="${k}" value="${esc(v)}" autocomplete="off"><button data-reveal type="button" title="Show">👁</button></div>`;
    else if (type === 'datalist') input = `<input data-k="${k}" list="dl-${k}" value="${esc(v)}" style="width:100%"><datalist id="dl-${k}">${opts.map(o => `<option value="${esc(o)}">`).join('')}</datalist>`;
    else input = `<input type="${type}" data-k="${k}" value="${esc(v)}" style="width:100%">`;
    el.insertAdjacentHTML('beforeend', `<label class="k">${esc(label)}</label><div>${input}</div>`);
  }
  el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.browse) { const p = await api.call('file:pick', { dir: b.dataset.browse === 'dir' }); if (p) b.previousElementSibling.value = p; }
    if ('reveal' in b.dataset) { const i = b.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; }
  });
  return el;
}
function readForm(el) {
  const o = {};
  for (const i of $$('[data-k]', el)) o[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.type === 'number' ? (i.value === '' ? '' : +i.value) : i.value.trim();
  return o;
}
function ask(title, fields, vals = {}, okLabel = 'OK') {
  return new Promise(res => {
    const f = form(fields, vals);
    const m = modal(title, f, [{ label: 'Cancel', onClick: () => res(null) }, { label: okLabel, cls: 'primary', onClick: () => res(readForm(f)) }], 'small');
    m.el.closest('.back').addEventListener('keydown', e => { if (e.key === 'Escape') res(null); });
  });
}
const confirmBox = msg => new Promise(res => modal('Confirm', `<p>${esc(msg)}</p>`, [{ label: 'Cancel', onClick: () => res(false) }, { label: 'OK', cls: 'primary', onClick: () => res(true) }], 'small'));

// ---------------- vault lock screen ----------------
async function boot() {
  const st = await api.call('vault:status');
  if (st.smoke) return; // smoke test drives unlock itself
  const create = !st.exists;
  const body = h(`<div>
    <p class="dim" style="margin:0">${create ? 'Create a master password. It encrypts all your sessions, passwords and macros (AES-256-GCM). It cannot be recovered.' : 'Enter your master password to unlock your sessions.'}</p>
    <input type="password" id="pw1" placeholder="Master password" autocomplete="off">
    ${create ? '<input type="password" id="pw2" placeholder="Confirm password" autocomplete="off">' : ''}
    <div class="err" id="pwErr"></div>
    ${create ? '' : '<a href="#" id="resetLink" class="dim" style="font-size:12px">Forgot the master password? Reset the app (deletes all data)…</a>'}</div>`);
  const rl = $('#resetLink', body); if (rl) rl.onclick = e => { e.preventDefault(); resetApp(); };
  modal(create ? 'Welcome to TermuCraft' : 'Unlock TermuCraft', body, [{
    label: create ? 'Create vault' : 'Unlock', cls: 'primary', onClick: async () => {
      const pw = $('#pw1', body).value;
      if (create && (pw.length < 6 || pw !== $('#pw2', body).value)) { $('#pwErr', body).textContent = pw.length < 6 ? 'Use at least 6 characters' : 'Passwords do not match'; return false; }
      try { await unlock(pw, create); } catch (e) { $('#pwErr', body).textContent = e.message; $('#pw1', body).select(); return false; }
    },
  }], 'small sticky');
}
async function unlock(pw, create) {
  V = await api.call(create ? 'vault:create' : 'vault:unlock', pw);
  // old default was PowerShell; switch once to the Linux-style shell (user can change it back in Settings)
  if (V.settings.brandName === 'MobaCraft') { V.settings.brandName = 'TermuCraft'; save('settings'); } // renamed app
  if (!V.settings.bashDefault) { if (!V.settings.defaultShell || V.settings.defaultShell === 'powershell.exe') V.settings.defaultShell = 'bash'; V.settings.bashDefault = true; save('settings'); }
  applySettings(); renderSide(); renderHome(); refreshStatus();
  // autostart tunnels / X server
  for (const t of V.tunnels.filter(t => t.autostart)) api.call('tun:start', t).catch(e => toast(`Tunnel ${t.name}: ${e.message}`, 'bad'));
  if (S().autoStartX) api.call('x:start').catch(() => {});
  api.call('wsl:list').then(l => { wslDistros = l; renderSide(); }).catch(() => {});
}
let wslDistros = [];

// auto-lock after inactivity (terminal output does not count as activity)
let lastActivity = Date.now();
['keydown', 'mousedown', 'wheel'].forEach(ev => document.addEventListener(ev, () => { lastActivity = Date.now(); }, true));
setInterval(async () => {
  const min = V && +S().autoLockMin;
  if (min > 0 && Date.now() - lastActivity > min * 60000 && !tabs.some(unsavedWork)) { await api.call('vault:lock'); leaving = true; location.reload(); }
}, 30000);

// ---------------- session model ----------------
const TYPES = { ssh: 'SSH', sftp: 'SFTP', wsl: 'WSL', telnet: 'Telnet', serial: 'Serial', shell: 'Shell', rdp: 'RDP', vnc: 'VNC', browser: 'Browser' };
const SHELLS = ['bash', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'wsl.exe', 'wsl.exe -d Ubuntu', '"C:\\Program Files\\Git\\bin\\bash.exe" --login -i'];
function sessionFields(type) {
  const creds = [['', '— none —'], ...V.credentials.map(c => [c.id, `${c.name} (${c.username || ''})`])];
  const sshs = [['', '— none —'], ...V.sessions.filter(s => s.type === 'ssh').map(s => [s.id, s.name])];
  const common = [['name', 'Session name'], ['folder', 'Folder (e.g. Prod/Web)']];
  const auth = [['username', 'Username'], ['password', 'Password (optional)', 'password'], ['credentialId', 'Or saved credential', 'select', '', creds]];
  const sshAuth = [...auth, ['keyFile', 'Private key file', 'file'], ['keyInVault', 'Keep a copy of the key inside the encrypted vault (keeps working if the file moves; included in vault backups)', 'check'], ['passphrase', 'Key passphrase', 'password'], ['agent', 'Use SSH agent (OpenSSH/Pageant)', 'check'], ['jumpId', 'SSH gateway (jump host)', 'select', '', sshs]];
  switch (type) {
    case 'ssh': return [...common, ['host', 'Remote host'], ['port', 'Port', 'number', 22], ...sshAuth, ['heading', 'Advanced'], ['x11', 'X11 forwarding', 'check', true], ['startDir', 'Start in folder'], ['command', 'Execute command after login'], ['monitor', 'Remote monitoring bar', 'check', true]];
    case 'sftp': return [...common, ['host', 'Remote host'], ['port', 'Port', 'number', 22], ...sshAuth, ['startDir', 'Start in folder']];
    case 'telnet': return [...common, ['host', 'Remote host'], ['port', 'Port', 'number', 23]];
    case 'serial': return [...common, ['port', 'Serial port', 'datalist', 'COM1', serialPorts], ['baud', 'Speed (bps)', 'select', 115200, [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600]], ['dataBits', 'Data bits', 'select', 8, [5, 6, 7, 8]], ['parity', 'Parity', 'select', 'none', ['none', 'even', 'odd', 'mark', 'space']], ['stopBits', 'Stop bits', 'select', 1, [1, 2]]];
    case 'shell': return [...common, ['command', 'Shell / command', 'datalist', S().defaultShell, SHELLS], ['cwd', 'Working directory', 'dir']];
    case 'rdp': return [...common, ['host', 'Remote host'], ['port', 'Port', 'number', 3389], ...auth, ['fullscreen', 'Full screen', 'check'], ['width', 'Width', 'number', 1600], ['height', 'Height', 'number', 900], ['admin', 'Admin/console session', 'check'], ['drives', 'Redirect local drives', 'check'], ['audio', 'Play remote audio locally', 'check', true]];
    case 'vnc': return [...common, ['host', 'Remote host'], ['port', 'Port', 'number', 5900]];
    case 'browser': return [...common, ['url', 'URL', 'text', 'https://']];
    case 'wsl': return [...common, ['distro', 'Distribution', 'datalist', wslDistros[0] || 'Ubuntu', wslDistros], ['user', 'User (empty = default)'], ['startDir', 'Start in folder', 'text', '~']];
  }
}
let serialPorts = [];

function editSession(s = null, connectAfter = false) {
  const isNew = !s;
  let type = s ? s.type : 'ssh';
  let vals = s ? { ...s } : {};
  const body = h(`<div><div class="types">${Object.entries(TYPES).filter(([k]) => !S().disabledTypes.includes(k)).map(([k, l]) => `<button data-t="${k}">${l}</button>`).join('')}</div><div class="slot"></div></div>`);
  const draw = () => {
    $$('.types button', body).forEach(b => b.classList.toggle('on', b.dataset.t === type));
    $('.slot', body).replaceChildren(form(sessionFields(type), vals));
  };
  $('.types', body).onclick = e => { const b = e.target.closest('button'); if (!b) return; vals = { ...vals, ...readForm($('.slot', body)) }; type = b.dataset.t; draw(); };
  if (type === 'serial' || isNew) api.call('serial:list').then(p => { serialPorts = p; }).catch(() => {});
  draw();
  const store = async () => {
    const v = readForm($('.slot', body));
    const label = v.host || v.url || (v.distro && 'WSL ' + v.distro) || v.port || v.command || type;
    const out = { ...(s || { id: uid() }), ...v, type, name: v.name || (v.username && v.host ? `${v.username}@${v.host}` : label) };
    if ((type === 'ssh' || type === 'sftp' || type === 'telnet' || type === 'rdp' || type === 'vnc') && !out.host) throw new Error('Remote host is required');
    await keyToVault(out, s);
    const i = V.sessions.findIndex(x => x.id === out.id);
    i >= 0 ? (V.sessions[i] = out) : V.sessions.push(out);
    save('sessions'); renderSide();
    return out;
  };
  modal(isNew ? 'New session' : `Edit session — ${s.name}`, body, [
    { label: 'Cancel' },
    { label: 'Save', onClick: async () => { await store(); } },
    { label: 'Save & connect', cls: 'primary', onClick: async () => { connect(await store()); } },
  ], 'wide');
}

// "Keep the key in the vault": copy the private key file's text into the item (session or credential), or drop the copy.
// A copy whose file is gone is kept as long as the option stays on.
async function keyToVault(item, before = null) {
  if (!item.keyInVault) { delete item.keyData; return; }
  if (!item.keyFile) { if (!item.keyData) throw new Error('Choose the private key file to keep in the vault'); return; }
  if (item.keyData && before && before.keyFile === item.keyFile && before.keyData) return; // already copied
  try { item.keyData = await api.call('key:read', item.keyFile, item.passphrase); }
  catch (e) { if (!item.keyData) throw new Error('Could not read the key: ' + e.message); }
}

// After generating a key: keep it as a credential, attach it to a session, or install it on a server.
function afterKeygen(k, file, passphrase) {
  const sshSessions = V.sessions.filter(x => x.type === 'ssh' || x.type === 'sftp');
  const pick = async title => { const r = await ask(title, [['id', 'Session', 'select', sshSessions[0] && sshSessions[0].id, sshSessions.map(x => [x.id, x.name])]], {}, 'OK'); return r && V.sessions.find(x => x.id === r.id); };
  const attach = o => Object.assign(o, { keyFile: file || o.keyFile || '', keyData: k.private, keyInVault: true, passphrase: passphrase || '' });
  modal('Use the new key', h(`<div><p>The key is ready. What next?</p><pre class="out" style="white-space:pre-wrap;word-break:break-all">${esc(k.public)}</pre></div>`), [
    { label: 'Save as a credential…', onClick: async () => {
      const r = await ask('New credential with this key', [['name', 'Name'], ['username', 'Username']], { name: 'Key ' + new Date().toISOString().slice(0, 10) }, 'Save');
      if (!r) return false;
      V.credentials.push(attach({ id: uid(), name: r.name || r.username, username: r.username }));
      await save('credentials'); toast('Credential saved (key kept in the vault)', 'ok'); return false;
    } },
    { label: 'Use for a session…', onClick: async () => {
      if (!sshSessions.length) { toast('No SSH sessions yet', 'bad'); return false; }
      const s = await pick('Use the key for which session?'); if (!s) return false;
      attach(s); await save('sessions'); toast(`${s.name} now logs in with the new key`, 'ok'); return false;
    } },
    { label: 'Install on a server…', onClick: async () => {
      if (!sshSessions.length) { toast('No SSH sessions yet', 'bad'); return false; }
      const s = await pick('Install the public key on which session\'s server?'); if (s) await installKeyUI(s, k.public); return false;
    } },
    { label: 'Done', cls: 'primary' },
  ], 'wide');
}

// ssh-copy-id: put a public key into ~/.ssh/authorized_keys on the session's server (one login with a password)
async function installKeyUI(s, pub = '') {
  const cred = V.credentials.find(c => c.id === s.credentialId) || {};
  let derived = pub;
  if (!derived) try { derived = await api.call('key:public', s.id); } catch {}
  const r = await ask(`Install public key on ${s.host}`, [
    ['heading', 'Adds the public key to ~/.ssh/authorized_keys of ' + (s.username || cred.username || 'the user') + ' on the server, like ssh-copy-id. Afterwards this session can log in with the key instead of a password.'],
    ['publicKey', 'Public key (OpenSSH line)', 'textarea', derived],
    ['password', 'Password for this one login (empty = use the saved one / the key)', 'password'],
  ], {}, 'Install');
  if (!r) return;
  try {
    const res = await api.call('ssh:installKey', s.id, { password: r.password || undefined, publicKey: r.publicKey.trim() || undefined });
    toast(res === 'already' ? 'The key is already installed on ' + s.host : 'Key installed on ' + s.host + '. The session can now use the key.', 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}

function recent(s) {
  try {
    const r = JSON.parse(localStorage.recent || '[]').filter(id => id !== s.id);
    localStorage.recent = JSON.stringify([s.id, ...r].slice(0, 8));
  } catch {}
}

// ---------------- tabs ----------------
const tabs = []; let active = null;
const byConn = new Map();
let multiExec = false, recording = null;

function addTab(tab) {
  tabs.push(tab);
  $('#panes').append(tab.pane);
  activate(tab);
  renderTabs();
  return tab;
}

function renderTabs() {
  $('#tabs').replaceChildren(...tabs.map(t => {
    const e = h(`<div class="tab ${t === active ? 'on' : ''}" title="${esc(t.title)}">
      <span class="dot ${t.status || ''}"></span>
      ${multiExec && t.kind === 'term' ? `<input type="checkbox" ${t.multi ? 'checked' : ''} title="Include in MultiExec">` : ''}
      <span class="t">${esc(t.title)}${t.dirty ? ' •' : ''}</span><span class="x" title="Close">✕</span></div>`);
    e.onclick = ev => { if (ev.target.classList.contains('x')) return closeTab(t); if (ev.target.type === 'checkbox') { t.multi = ev.target.checked; return; } activate(t); };
    e.onauxclick = ev => ev.button === 1 && closeTab(t);
    e.oncontextmenu = ev => { ev.preventDefault(); tabMenu(ev, t); };
    return e;
  }));
  $('#home').style.display = tabs.length ? 'none' : '';
  if ($('#panes').classList.contains('tile')) layoutTile();
}

function ctxMenu(ev, items) {
  $$('.ctxmenu').forEach(m => m.remove());
  const m = h('<div class="ctxmenu"></div>');
  for (const it of items) {
    if (it === '-') { m.append(h('<hr>')); continue; }
    const d = h(`<div${it[2] ? ' class="off"' : ''}>${esc(it[0])}</div>`); // it[2]: disabled
    d.onclick = () => { if (it[2]) return; m.remove(); it[1](); };
    m.append(d);
  }
  document.body.append(m);
  m.style.left = Math.min(ev.clientX, innerWidth - m.offsetWidth - 8) + 'px';
  m.style.top = Math.min(ev.clientY, innerHeight - m.offsetHeight - 8) + 'px';
  setTimeout(() => document.addEventListener('mousedown', e => { if (!m.contains(e.target)) m.remove(); }, { once: true }));
}

async function tabMenu(ev, t) {
  const rename = async () => { const r = await ask('Rename tab', [['n', 'Title']], { n: t.title }); if (r && r.n) { t.title = r.n; if (t.pane.querySelector('.ptitle')) $('.ptitle', t.pane).textContent = r.n; renderTabs(); } };
  const others = () => tabs.filter(x => x !== t).forEach(x => closeTab(x, true));
  if (t.kind === 'term') {
    const logging = t.connId && await api.call('log:active', t.connId);
    ctxMenu(ev, [
      ['Rename…', rename],
      ['Duplicate session', () => connect({ ...t.session })],
      ['Reconnect', async () => { if (t.connId) { await api.call('sess:close', t.connId); byConn.delete(t.connId); t.connId = null; } t.term.write('\r\n'); openConn(t); }],
      ['Clear scrollback', () => t.term.clear()],
      ['Find… (Ctrl+Shift+F)', () => termSearch(t)],
      '-',
      [logging ? '■ Stop logging to file' : '● Log output to file…', async () => {
        if (!t.connId) return toast('Not connected', 'bad');
        if (logging) { await api.call('log:stop', t.connId); toast('Logging stopped'); }
        else { const p = await api.call('log:start', t.connId, t.title); if (p) toast('Logging to ' + p, 'ok'); }
      }],
      ['Save scrollback to file…', async () => { const b = t.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\n'; const p = await api.call('file:save', null, s.replace(/\n+$/, '\n')); if (p) toast('Saved ' + p, 'ok'); }],
      '-', ...splitItems(t),
      ['Close other tabs', others], ['Close', () => closeTab(t)],
    ]);
  } else {
    ctxMenu(ev, [['Rename…', rename], ...(t.kind === 'db' ? [['Duplicate', () => openDb(t.db)]] : []), '-', ...splitItems(t), ['Close other tabs', others], ['Close', () => closeTab(t)]]);
  }
}

// ---------------- split view: two tabs side by side ----------------
let split = null;
function splitItems(t) {
  if (split && split.includes(t)) return [['⫿ Close split view', unsplit], '-'];
  return [...tabs.filter(o => o !== t).slice(0, 12).map(o => [`⫿ Side by side with "${o.title}"`, () => setSplit(t, o)]), '-'];
}
function setSplit(a, b) {
  if ($('#panes').classList.contains('tile')) ACTIONS.tile();
  split = [a, b];
  for (const t of tabs) t.pane.classList.toggle('inSplit', split.includes(t));
  $('#panes').classList.add('split');
  activate(a);
}
function unsplit() {
  split = null;
  $('#panes').classList.remove('split');
  tabs.forEach(t => t.pane.classList.remove('inSplit'));
  requestAnimationFrame(() => tabs.forEach(fitTab));
}

function activate(t) {
  if (split && !(t && split.includes(t))) unsplit(); // picking a tab outside the pair leaves split view
  active = t;
  for (const x of tabs) x.pane.classList.toggle('on', x === t);
  renderTabs();
  if (t) { requestAnimationFrame(() => { (split || [t]).forEach(fitTab); t.term ? t.term.focus() : t.cm && t.cm.focus(); }); }
  if (sideMode === 'sftp' || sideMode === 'docker' || sideMode === 'db') renderSide();
  updateMonitor(true);
}

async function closeTab(t, force = false) {
  if (!force && t.kind === 'term' && t.status === 'up' && S().confirmClose && !(await confirmBox(`Close "${t.title}"?`))) return;
  if (!force && t.dirty && !(await confirmBox(`"${t.title}" has unsaved changes. Close anyway?`))) return;
  if (!force && t.gridEdits && t.gridEdits() && !(await confirmBox(`"${t.title}" has unsaved changes in the result grid. Close anyway?`))) return;
  if (!force && t.txPending && t.txPending() && !(await confirmBox(`"${t.title}" has ${t.txPending()} uncommitted change(s). Close and roll them back?`))) return;
  if (t.kind === 'db') { if (t.connId) api.call('db:close', t.connId); }
  else if (t.connId) { api.call('sess:close', t.connId); byConn.delete(t.connId); }
  if (t.term) t.term.dispose();
  t.pane.remove();
  if (split && split.includes(t)) unsplit();
  const i = tabs.indexOf(t); tabs.splice(i, 1);
  activate(tabs[Math.min(i, tabs.length - 1)] || null);
}

function fitTab(t) {
  if (!t || !t.fit || !t.pane.isConnected || t.pane.offsetParent === null) return;
  try { t.fit.fit(); } catch {}
  if (t.cm) t.cm.refresh();
}

function layoutTile() {
  const n = tabs.filter(t => t.kind === 'term').length || 1;
  const cols = Math.ceil(Math.sqrt(n));
  $('#panes').style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  $('#panes').style.gridTemplateRows = `repeat(${Math.ceil(n / cols)}, 1fr)`;
  requestAnimationFrame(() => tabs.forEach(fitTab));
}

// ---------------- terminal tabs ----------------
function needsPassword(s) {
  if (s.type !== 'ssh' && s.type !== 'sftp') return false;
  const c = V.credentials.find(x => x.id === s.credentialId) || {};
  return !(s.password || c.password || s.keyFile || c.keyFile || s.keyData || c.keyData || s.agent);
}

async function connect(s, extra = {}) {
  if (S().disabledTypes.includes(s.type)) return toast(`${TYPES[s.type]} is disabled in Settings`, 'bad');
  if (V.sessions.includes(s)) recent(s);
  if (['rdp', 'vnc', 'browser'].includes(s.type)) {
    try { await api.call('sess:open', s); toast(`Launching ${TYPES[s.type]} ${s.host || s.url}`, 'ok'); } catch (e) { toast(e.message, 'bad'); }
    return;
  }
  if (needsPassword(s) && !extra.password) {
    const r = await ask(`Password for ${s.username || ''}@${s.host}`, [['password', 'Password', 'password'], ['save', 'Save password in vault', 'check', true]], {}, 'Connect');
    if (!r) return;
    extra.password = r.password;
    if (r.save && V.sessions.includes(s)) { s.password = r.password; save('sessions'); }
  }
  const tab = s.type === 'sftp' ? sftpTab(s) : termTab(s);
  addTab(tab);
  return openConn(tab, extra);
}

function termTab(s) {
  const pane = h(`<div class="pane termpane"><div class="ptitle"></div><div class="term"></div></div>`);
  const term = new Terminal({ ...termOptions(), allowProposedApi: true, rightClickSelectsWord: false, macOptionIsMeta: true });
  const fit = new FitAddon.FitAddon(), search = new SearchAddon.SearchAddon();
  term.loadAddon(fit); term.loadAddon(search);
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, u) => api.call('open:url', u)));
  const tab = { id: uid(), kind: 'term', session: s, title: s.name || TYPES[s.type], pane, term, fit, search, multi: true, hl: { colored: false }, status: 'wait' };
  $('.ptitle', pane).textContent = tab.title;
  term.open($('.term', pane));
  try { const gl = new WebglAddon.WebglAddon(); gl.onContextLoss(() => gl.dispose()); term.loadAddon(gl); } catch {}
  term.onData(d => input(tab, d));
  term.onResize(({ cols, rows }) => tab.connId && api.call('sess:resize', tab.connId, cols, rows));
  term.onSelectionChange(() => { if (S().copyOnSelect && term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {}); });
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
    if (e.code === 'KeyC') { navigator.clipboard.writeText(term.getSelection()); return false; }
    if (e.code === 'KeyV') { navigator.clipboard.readText().then(t => term.paste(t)); return false; }
    if (e.code === 'KeyF') { termSearch(tab); return false; }
    return true;
  });
  pane.addEventListener('contextmenu', e => { e.preventDefault(); if (S().rightClickPaste) navigator.clipboard.readText().then(t => t && term.paste(t)); });
  pane.addEventListener('mousedown', () => { if (active !== tab) activate(tab); });
  new ResizeObserver(() => requestAnimationFrame(() => fitTab(tab))).observe($('.term', pane));
  return tab;
}

async function openConn(tab, extra = {}) {
  tab.status = 'wait'; renderTabs();
  const s = tab.session;
  if (tab.term) tab.term.write(`\x1b[90mConnecting to ${esc(s.host || s.command || s.port || s.name)}…\x1b[0m\r\n`);
  try {
    const r = await api.call('sess:open', s, { cols: tab.term ? tab.term.cols : 80, rows: tab.term ? tab.term.rows : 24, password: extra.password });
    tab.connId = r.id; tab.home = s.startDir || r.home; tab.cwd = tab.cwd || tab.home;
    if (!tabs.includes(tab)) return api.call('sess:close', r.id); // tab closed while connecting
    tab.status = 'up'; tab.monFail = false;
    bindConn(r.id, tab);
    if (tab.term) { fitTab(tab); api.call('sess:resize', r.id, tab.term.cols, tab.term.rows); }
    if (tab.kind === 'sftp') tab.view.load();
  } catch (e) {
    tab.status = 'down';
    if (tab.term) tab.term.write(`\x1b[1;31m${e.message}\x1b[0m\r\n\x1b[33m[Press R to retry]\x1b[0m\r\n`);
    else toast(e.message, 'bad');
    if (/authentication/i.test(e.message) && (s.type === 'ssh' || s.type === 'sftp')) {
      const r = await ask(`Authentication failed — password for ${s.username || ''}@${s.host}`, [['password', 'Password', 'password'], ['save', 'Save password in vault', 'check', true]], {}, 'Retry');
      if (r) { if (r.save && V.sessions.includes(s)) { s.password = r.password; save('sessions'); } return openConn(tab, { password: r.password }); }
    }
  }
  renderTabs();
  if (active === tab) { updateMonitor(true); if (sideMode === 'sftp') renderSide(); }
}

function input(tab, d) {
  if (tab.status === 'down') { if (/^r$/i.test(d)) { tab.term.write('\r\n'); openConn(tab); } return; }
  if (recording) recording.data += d;
  if (multiExec && tab.multi) { for (const t of tabs) if (t.kind === 'term' && t.multi && t.status === 'up') api.call('sess:write', t.connId, d); }
  else if (tab.connId && tab.status === 'up') api.call('sess:write', tab.connId, d);
}

// output can arrive before sess:open resolves (banners/MOTD): park it until the tab registers
const early = new Map();
function bindConn(id, tab) {
  byConn.set(id, tab);
  const q = early.get(id) || []; early.delete(id);
  for (const [ch, d] of q) ch === 'data' ? onData(id, d) : onExit(id);
}
api.on('data', (id, d) => onData(id, d));
function onData(id, d) {
  const t = byConn.get(id);
  if (!t) { if (!early.has(id)) early.set(id, []); early.get(id).push(['data', d]); return; }
  if (!t.term) return;
  const plain = !S().highlight || t.term.buffer.active.type === 'alternate';
  t.term.write(plain ? d : Highlight.highlight(d, HL, t.hl));
}
api.on('exit', id => onExit(id));
function onExit(id) {
  const t = byConn.get(id);
  if (!t) { if (!early.has(id)) early.set(id, []); early.get(id).push(['exit']); return; }
  byConn.delete(id); t.connId = null; t.status = 'down';
  if (t.term) t.term.write('\r\n\x1b[33m[Session closed — press R to reconnect]\x1b[0m\r\n');
  renderTabs(); if (t === active) updateMonitor(true);
}

async function termSearch(tab) {
  const r = await ask('Find in terminal', [['q', 'Text or regex'], ['regex', 'Regular expression', 'check'], ['cs', 'Case sensitive', 'check']], tab.lastSearch || {});
  if (!r || !r.q) return;
  tab.lastSearch = r;
  if (!tab.search.findNext(r.q, { regex: r.regex, caseSensitive: r.cs })) toast('Not found');
}

// ---------------- remote monitoring bar ----------------
let monTimer = null, monPrev = null;
async function updateMonitor(reset) {
  if (reset) monPrev = null;
  const t = active, bar = $('#monbar');
  const ok = t && t.kind === 'term' && t.session.type === 'ssh' && t.status === 'up' && !t.monFail && S().monitor && t.session.monitor !== false;
  if (!ok) { bar.hidden = true; return; }
  try {
    const t0 = performance.now();
    const m = await api.call('mon', t.connId);
    const rtt = Math.round(performance.now() - t0);
    if (t !== active) return;
    const now = Date.now();
    const rate = monPrev ? { rx: (m.rx - monPrev.rx) / ((now - monPrev.t) / 1000), tx: (m.tx - monPrev.tx) / ((now - monPrev.t) / 1000) } : null;
    monPrev = { ...m, t: now };
    const meter = (label, v, extra = '') => `<span class="m">${label} <span class="bar"><span class="${v > 90 ? 'crit' : v > 70 ? 'hi' : ''}" style="width:${v}%"></span></span>${v}%${extra}</span>`;
    bar.innerHTML = meter('CPU', m.cpu) + meter('RAM', m.mem, ` <span class="dim">of ${fmtSize(m.memTotal)}</span>`) + meter('Disk /', m.disk) +
      `<span class="m" title="Round trip of the monitoring command: network latency + server response">Response <b class="${rtt > 500 ? 'crit' : rtt > 150 ? 'hi' : ''}">${rtt} ms</b></span><span class="m">Load <b>${esc(m.load)}</b></span><span class="m">Up <b>${fmtUp(m.uptime)}</b></span><span class="m">Users <b>${m.users}</b></span>` +
      (rate ? `<span class="m">Net ↓${fmtSize(Math.max(0, rate.rx))}/s ↑${fmtSize(Math.max(0, rate.tx))}/s</span>` : '');
    bar.hidden = false;
  } catch { t.monFail = true; bar.hidden = true; }
}
setInterval(() => updateMonitor(false), 4000);

// ---------------- SFTP browser ----------------
function sftpTab(s) {
  const pane = h(`<div class="pane"></div>`);
  const tab = { id: uid(), kind: 'sftp', session: s, title: s.name || s.host, pane, status: 'wait' };
  tab.view = sftpView(tab, pane);
  return tab;
}

const isLocal = tab => tab.session && (tab.session.type === 'shell' || tab.session.type === 'wsl');
const fsTarget = tab => isLocal(tab) ? { local: true } : { conn: tab.connId };

function sftpView(tab, container) {
  const el = h(`<div class="sftp">
    <div class="bar">
      <button data-a="up" title="Parent folder">⬆</button><button data-a="refresh" title="Refresh">⟳</button><button data-a="home" title="Home">⌂</button>
      <button data-a="mkdir" title="New folder">📁+</button><button data-a="touch" title="New file">📄+</button>
      <button data-a="upload" title="Upload files">⤒ Upload</button><button data-a="download" title="Download selection">⤓ Download</button>
      <button data-a="edit" title="Open in editor">✎</button><button data-a="rename" title="Rename">Ren</button><button data-a="chmod" title="Permissions">chmod</button>
      <button data-a="delete" class="danger" title="Delete selection">🗑</button>
      ${tab.kind === 'term' ? '<button data-a="cd" title="cd terminal into this folder">⇢ Term</button>' : ''}
    </div>
    <div class="path"><input class="p"></div>
    <div class="list"><table><thead><tr><th>Name</th><th>Size</th><th>Modified</th><th>Perms</th></tr></thead><tbody></tbody></table></div>
    <div class="prog"></div></div>`);
  container.replaceChildren(el);
  el.dataset.conn = tab.connId || '';
  const sel = new Set();
  let files = [];
  const P = (...p) => p.reduce((a, b) => b.startsWith('/') ? b : (a.endsWith('/') ? a : a + '/') + b);
  const call = (op, ...a) => api.call('fs', fsTarget(tab), op, ...a);

  async function load(dir = tab.cwd || tab.home || '/') {
    el.dataset.conn = tab.connId;
    try {
      const real = await call('realpath', dir);
      files = await call('list', real);
      tab.cwd = real; sel.clear();
    } catch (e) { toast(e.message, 'bad'); }
    $('.p', el).value = tab.cwd;
    $('tbody', el).innerHTML = files.map((f, i) => `<tr data-i="${i}"><td class="n">${f.dir ? '📁' : f.link ? '🔗' : '📄'} ${esc(f.name)}</td><td>${f.dir ? '' : fmtSize(f.size)}</td><td>${new Date(f.mtime).toLocaleString()}</td><td class="mono">${esc(f.perm)}</td></tr>`).join('');
  }
  const selected = () => [...sel].map(i => files[i]);
  const one = () => { const s = selected(); if (s.length !== 1) { toast('Select one item'); return null; } return s[0]; };

  async function openItem(f) {
    if (f.dir || (f.link && await call('isDir', P(tab.cwd, f.name)).catch(() => false))) return load(P(tab.cwd, f.name));
    openRemoteFile(tab, P(tab.cwd, f.name));
  }

  $('tbody', el).addEventListener('click', e => {
    const tr = e.target.closest('tr'); if (!tr) return;
    const i = +tr.dataset.i;
    if (!e.ctrlKey && !e.shiftKey) sel.clear();
    if (e.shiftKey && sel.size) { const a = Math.min(...sel, i), b = Math.max(...sel, i); for (let k = a; k <= b; k++) sel.add(k); }
    else sel.has(i) && e.ctrlKey ? sel.delete(i) : sel.add(i);
    $$('tr', $('tbody', el)).forEach(r => r.classList.toggle('sel', sel.has(+r.dataset.i)));
  });
  $('tbody', el).addEventListener('dblclick', e => { const tr = e.target.closest('tr'); if (tr) openItem(files[+tr.dataset.i]); });
  const act = a => { const b = $(`.bar [data-a="${a}"]`, el); b && b.click(); };
  $('.list', el).addEventListener('contextmenu', e => {
    e.preventDefault();
    const tr = e.target.closest('tbody tr');
    if (tr && !sel.has(+tr.dataset.i)) { sel.clear(); sel.add(+tr.dataset.i); $$('tr', $('tbody', el)).forEach(r => r.classList.toggle('sel', sel.has(+r.dataset.i))); }
    const f = tr && files[+tr.dataset.i];
    const here = [['📁 New folder…', () => act('mkdir')], ['📄 New file…', () => act('touch')], ['⤒ Upload here…', () => act('upload')], ['⟳ Refresh', () => act('refresh')], ...(tab.kind === 'term' ? [['⇢ cd terminal here', () => act('cd')]] : []), ['Copy folder path', () => copyText(tab.cwd)]];
    if (!f) return ctxMenu(e, here);
    ctxMenu(e, [
      [f.dir ? '📂 Open' : '✎ Open in editor', () => openItem(f)],
      ['⤓ Download…', () => act('download')],
      ['Rename…', () => act('rename')],
      ['Permissions (chmod)…', () => act('chmod')],
      ['Copy path', () => copyText(P(tab.cwd, f.name))],
      '-', ...here, '-',
      [`✕ Delete${sel.size > 1 ? ` ${sel.size} items` : ''}`, () => act('delete')],
    ]);
  });
  $('.p', el).addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    let v = $('.p', el).value.trim().replace(/^"(.*)"$/, '$1');
    if (!v) return;
    if (/^~(?=$|[\\/])/.test(v)) v = (tab.home || '') + v.slice(1);
    else if (!/^([a-z]:|[\\/])/i.test(v)) v = P(tab.cwd, v);
    load(v);
  });
  const list = $('.list', el);
  list.addEventListener('dragover', e => { e.preventDefault(); list.classList.add('drop'); });
  list.addEventListener('dragleave', () => list.classList.remove('drop'));
  list.addEventListener('drop', async e => {
    e.preventDefault(); list.classList.remove('drop');
    const paths = [...e.dataTransfer.files].map(f => api.pathFor(f)).filter(Boolean);
    if (paths.length) { await run(() => call('upload', tab.cwd, paths), `Uploaded ${paths.length} item(s)`); load(); }
  });
  const run = async (fn, okMsg) => { try { const r = await fn(); if (okMsg && r !== false) toast(okMsg, 'ok'); $('.prog', el).textContent = ''; return r; } catch (e) { toast(e.message, 'bad'); } };

  $('.bar', el).addEventListener('click', async e => {
    const a = e.target.closest('button') && e.target.closest('button').dataset.a; if (!a) return;
    if (!tab.connId && !isLocal(tab)) return toast('Not connected', 'bad');
    const cwd = tab.cwd;
    if (a === 'up') return load(P(cwd, '..'));
    if (a === 'refresh') return load(cwd);
    if (a === 'home') return load(tab.home);
    if (a === 'mkdir' || a === 'touch') { const r = await ask(a === 'mkdir' ? 'New folder' : 'New file', [['n', 'Name']]); if (r && r.n) { await run(() => call(a, P(cwd, r.n))); load(cwd); } return; }
    if (a === 'upload') { await run(() => call('upload', cwd), 'Upload complete'); return load(cwd); }
    if (a === 'download') { const s = selected(); if (!s.length) return toast('Select files first'); return run(() => call('download', s.map(f => P(cwd, f.name))), 'Download complete'); }
    if (a === 'edit') { const f = one(); if (f && !f.dir) openRemoteFile(tab, P(cwd, f.name)); return; }
    if (a === 'rename') { const f = one(); if (!f) return; const r = await ask('Rename', [['n', 'New name']], { n: f.name }); if (r && r.n && r.n !== f.name) { await run(() => call('rename', P(cwd, f.name), P(cwd, r.n))); load(cwd); } return; }
    if (a === 'chmod') { const f = one(); if (!f) return; const r = await ask(`Permissions — ${f.name}`, [['m', 'Octal mode (e.g. 644, 755)']], { m: (f.mode & 0o7777).toString(8) }); if (r && /^[0-7]{3,4}$/.test(r.m)) { await run(() => call('chmod', P(cwd, f.name), r.m)); load(cwd); } return; }
    if (a === 'delete') { const s = selected(); if (!s.length) return; if (!(await confirmBox(`Delete ${s.length} item(s) permanently? Folders are deleted recursively.`))) return; await run(() => call('remove', s.map(f => P(cwd, f.name))), 'Deleted'); return load(cwd); }
    if (a === 'cd') {
      if (tab.session.type === 'shell') return input(tab, `cd "${cwd}"\r`);
      const p = tab.session.type === 'wsl' ? cwd.replace(/^[\\/]{2}wsl(\.localhost|\$)[\\/][^\\/]+/i, '').replace(/\\/g, '/') || '/' : cwd;
      return input(tab, `cd '${p.replace(/'/g, `'\\''`)}'\r`);
    }
  });
  return { load, el };
}
api.on('sftp:progress', (id, name, t, total) => {
  for (const el of $$(`.sftp[data-conn="${id}"] .prog`)) el.textContent = `${name}: ${fmtSize(t)} / ${fmtSize(total)} (${Math.round(100 * t / (total || 1))}%)`;
});

// ---------------- text editor ----------------
const MODE_DEPS = { htmlmixed: ['xml', 'javascript', 'css'], php: ['xml', 'javascript', 'css', 'htmlmixed', 'clike'], markdown: ['xml'], jsx: ['xml', 'javascript'], gfm: ['markdown'] };
const loaded = new Set();
const loadScript = src => loaded.has(src) ? Promise.resolve() : new Promise((ok, ko) => { const s = document.createElement('script'); s.src = src; s.onload = () => { loaded.add(src); ok(); }; s.onerror = ko; document.body.append(s); });
async function setMode(cm, name) {
  const info = CodeMirror.findModeByFileName(name) || (/(^|\/)(\.bashrc|\.profile|[^.]+)$/.test(name) ? CodeMirror.findModeByName('Shell') : null);
  if (!info || info.mode === 'null') return 'Plain text';
  // only fetch modes not already registered (sql etc. are loaded statically) — never re-inject,
  // which can corrupt CodeMirror's Doc prototype inside a packaged asar ("doc.iter is not a function")
  for (const m of [...(MODE_DEPS[info.mode] || []), info.mode]) {
    if (!CodeMirror.modes[m]) await loadScript(`../node_modules/codemirror/mode/${m}/${m}.js`).catch(() => {});
  }
  try { cm.setOption('mode', info.mime || info.mode); } catch { return 'Plain text'; }
  return info.name;
}

function openEditor({ title = 'untitled', text = '', path = null, remote = null }) {
  const pane = h(`<div class="pane"><div class="edbar"><button data-a="save">💾 Save</button><button data-a="saveas">Save as…</button><button data-a="find">Find</button><button data-a="replace">Replace</button><label><input type="checkbox" data-a="wrap"> Wrap</label><span class="grow"></span><span class="dim mode"></span><span class="dim" style="margin-left:10px">${esc(remote ? remote.path : path || 'new file')}</span></div></div>`);
  const tab = { id: uid(), kind: 'editor', title, pane, path, remote, status: 'up' };
  const cm = CodeMirror(pane, {
    value: typeof text === 'string' ? text : String(text ?? ''), lineNumbers: true, matchBrackets: true, indentUnit: 2, tabSize: 4, theme: S().appTheme === 'light' ? 'default' : 'material-darker',
    extraKeys: { 'Ctrl-S': () => saveEd(), 'Ctrl-F': 'findPersistent', 'Ctrl-H': 'replace', 'Ctrl-G': 'jumpToLine' },
  });
  tab.cm = cm;
  setMode(cm, title).then(n => { $('.mode', pane).textContent = n; });
  cm.on('change', () => { if (!tab.dirty) { tab.dirty = true; renderTabs(); } });
  async function saveEd(as) {
    try {
      if (tab.remote && !as) await api.call('fs', tab.remote.target, 'write', tab.remote.path, cm.getValue());
      else { const p = await api.call('file:save', as ? null : tab.path, cm.getValue()); if (!p) return; tab.path = p; tab.remote = null; tab.title = p.split(/[\\/]/).pop(); }
      tab.dirty = false; renderTabs(); toast('Saved', 'ok');
    } catch (e) { toast(e.message, 'bad'); }
  }
  tab.save = saveEd;
  $('.edbar', pane).addEventListener('click', e => {
    const a = e.target.dataset.a;
    if (a === 'save') saveEd(); if (a === 'saveas') saveEd(true);
    if (a === 'find') cm.execCommand('findPersistent'); if (a === 'replace') cm.execCommand('replace');
    if (a === 'wrap') cm.setOption('lineWrapping', e.target.checked);
  });
  addTab(tab);
  setTimeout(() => cm.refresh(), 50);
  return tab;
}
async function openRemoteFile(tab, path) {
  try { const target = fsTarget(tab); const text = await api.call('fs', target, 'read', path); return openEditor({ title: path.split(/[\\/]/).pop(), text, remote: { target, path } }); }
  catch (e) { toast(e.message, 'bad'); }
}

// ---------------- macros ----------------
const encodeKeys = s => s.replace(/\r\n?/g, '\n').replace(/[\x00-\x09\x0b-\x1f\x7f]/g, c => c === '\t' ? '{TAB}' : c === '\x1b' ? '{ESC}' : c === '\x7f' ? '{BS}' : `{^${String.fromCharCode(c.charCodeAt(0) + 64)}}`);
const decodeKeys = s => s.replace(/\n/g, '\r').replace(/\{ENTER\}/g, '\r').replace(/\{TAB\}/g, '\t').replace(/\{ESC\}/g, '\x1b').replace(/\{BS\}/g, '\x7f').replace(/\{\^([@-_])\}/g, (_, c) => String.fromCharCode(c.charCodeAt(0) - 64));

async function playMacro(m) {
  const t = active && active.kind === 'term' ? active : null;
  if (!t) return toast('Open a terminal first', 'bad');
  for (const part of m.text.split(/(\{WAIT:\d+\})/)) {
    const w = /^\{WAIT:(\d+)\}$/.exec(part);
    if (w) { await sleep(+w[1]); continue; }
    for (const chunk of decodeKeys(part).split(/(?<=\r)/)) { if (chunk) { input(t, chunk); await sleep(40); } }
  }
}
function editMacro(m = { id: uid(), name: '', text: '' }) {
  const body = h(`<div class="macro"><div class="form"><label class="k">Name</label><input class="n" value="${esc(m.name)}"></div>
    <p class="dim">Each line is typed followed by Enter. Special keys: <kbd>{TAB}</kbd> <kbd>{ESC}</kbd> <kbd>{BS}</kbd> <kbd>{^C}</kbd> (Ctrl+C) <kbd>{WAIT:1000}</kbd> (pause ms). End without a newline to not press Enter.</p>
    <textarea class="tx">${esc(m.text)}</textarea></div>`);
  modal(m.name ? `Macro — ${m.name}` : 'New macro', body, [{ label: 'Cancel' }, {
    label: 'Save', cls: 'primary', onClick: () => {
      m.name = $('.n', body).value.trim() || 'Macro'; m.text = $('.tx', body).value;
      const i = V.macros.findIndex(x => x.id === m.id); i >= 0 ? (V.macros[i] = m) : V.macros.push(m);
      save('macros'); renderSide();
    },
  }]);
}
async function toggleRecord() {
  if (!recording) { recording = { data: '' }; $('#btnRecord').classList.add('rec'); $('#btnRecord').lastChild.textContent = 'Stop'; toast('Recording macro… type in any terminal, then click Stop'); return; }
  const data = recording.data; recording = null;
  $('#btnRecord').classList.remove('rec'); $('#btnRecord').lastChild.textContent = 'Record';
  if (!data) return toast('Nothing recorded');
  editMacro({ id: uid(), name: '', text: encodeKeys(data) });
}

// ---------------- sidebar ----------------
// Folders (sessions, connections, schema trees) start collapsed; the ones the user opens stay open while the app runs.
const openFolders = new Set();
document.addEventListener('toggle', e => { const k = e.target.dataset && e.target.dataset.fold; if (k) e.target.open ? openFolders.add(k) : openFolders.delete(k); }, true);
const foldAttr = (key, force = false) => `data-fold="${esc(key)}"${force || openFolders.has(key) ? ' open' : ''}`;
let sideMode = 'sessions';
let sessFilter = '';
const SIDE_TITLES = { sessions: 'Sessions', sftp: 'Files', db: 'Databases', docker: 'Docker', macros: 'Macros' };
function renderSide() {
  if (!V) return;
  $$('#rail button').forEach(b => b.classList.toggle('on', b.dataset.side === sideMode));
  $('#sidehead').innerHTML = `<span>${SIDE_TITLES[sideMode]}</span><span class="grow"></span>`;
  const body = $('#sidebody');
  body.oncontextmenu = null;
  if (sideMode === 'sessions') {
    const root = { kids: {}, items: [] };
    const f = sessFilter.toLowerCase();
    for (const s of V.sessions.filter(s => !f || `${s.name} ${s.host || ''} ${s.folder || ''}`.toLowerCase().includes(f))) {
      let n = root; for (const p of (s.folder || '').split('/').filter(Boolean)) n = n.kids[p] = n.kids[p] || { kids: {}, items: [] };
      n.items.push(s);
    }
    const count = n => n.items.length + Object.values(n.kids).reduce((a, k) => a + count(k), 0);
    const draw = (n, path = '') => Object.keys(n.kids).sort().map(k => `<details class="folder" ${foldAttr(`sess:${path}/${k}`, !!f)}><summary>${esc(k)} <span class="dim">(${count(n.kids[k])})</span></summary><div>${draw(n.kids[k], `${path}/${k}`)}</div></details>`).join('') +
      n.items.sort((a, b) => a.name.localeCompare(b.name)).map(s => `<div class="item" data-id="${s.id}" title="${esc(s.host || s.url || s.command || '')}"><span class="badge ${s.type}">${s.type}</span><span class="name">${esc(s.name)}</span><span class="acts"><button data-a="edit" title="Edit">✎</button><button data-a="dup" title="Duplicate">⧉</button><button data-a="del" class="danger" title="Delete">✕</button></span></div>`).join('');
    body.innerHTML = `<div class="quick"><input id="quickc" placeholder="Quick connect: user@host:port"><button id="quickgo">Go</button></div>
      <div class="quick"><input id="sfilter" placeholder="Filter sessions…" value="${esc(sessFilter)}"><button id="newsess" title="New session">＋</button></div>
      ${draw(root) || '<p class="dim">No sessions yet. Click ＋ or import from MobaXterm (Tools).</p>'}
      ${wslDistros.filter(d => !/^docker-desktop/i.test(d)).length ? `<details class="folder" ${foldAttr('sess:wsl', !!f)}><summary>WSL (detected)</summary><div>${wslDistros.filter(d => !/^docker-desktop/i.test(d)).map(d => `<div class="item" data-wsl="${esc(d)}" title="Double-click to open"><span class="badge wsl">wsl</span><span class="name">${esc(d)}</span></div>`).join('')}</div></details>` : ''}`;
    $('#sfilter').oninput = e => { sessFilter = e.target.value; const pos = e.target.selectionStart; renderSide(); const i = $('#sfilter'); i.focus(); i.setSelectionRange(pos, pos); };
    $('#newsess').onclick = () => editSession();
    const quick = () => {
      const m = /^(?:([^@]+)@)?([^:\s]+)(?::(\d+))?$/.exec($('#quickc').value.trim());
      if (!m) return toast('Use user@host[:port]', 'bad');
      connect({ id: uid(), type: 'ssh', name: $('#quickc').value.trim(), username: m[1] || '', host: m[2], port: +m[3] || 22, x11: true, monitor: true });
    };
    $('#quickgo').onclick = quick;
    $('#quickc').onkeydown = e => e.key === 'Enter' && quick();
    body.onclick = async e => {
      const it = e.target.closest('.item'); const a = e.target.dataset.a;
      if (!it || !a) return;
      const s = V.sessions.find(x => x.id === it.dataset.id);
      if (a === 'edit') editSession(s);
      if (a === 'dup') { V.sessions.push({ ...s, id: uid(), name: s.name + ' (copy)' }); save('sessions'); renderSide(); }
      if (a === 'del' && await confirmBox(`Delete session "${s.name}"?`)) { V.sessions = V.sessions.filter(x => x !== s); save('sessions'); renderSide(); }
    };
    body.ondblclick = e => {
      const it = e.target.closest('.item'); if (!it || e.target.dataset.a) return;
      if (it.dataset.wsl) return connect({ id: uid(), type: 'wsl', name: 'WSL ' + it.dataset.wsl, distro: it.dataset.wsl });
      connect(V.sessions.find(x => x.id === it.dataset.id));
    };
    body.oncontextmenu = e => {
      const it = e.target.closest('.item'); if (!it) return;
      e.preventDefault();
      if (it.dataset.wsl) return ctxMenu(e, [['Open', () => connect({ id: uid(), type: 'wsl', name: 'WSL ' + it.dataset.wsl, distro: it.dataset.wsl })], ['Save as a session…', () => editSession({ id: uid(), type: 'wsl', name: 'WSL ' + it.dataset.wsl, distro: it.dataset.wsl })]]);
      sessionMenu(e, V.sessions.find(x => x.id === it.dataset.id));
    };
  } else if (sideMode === 'sftp') {
    body.onclick = body.ondblclick = null;
    const t = active;
    if (!t || t.kind !== 'term' || !['ssh', 'wsl', 'shell'].includes(t.session.type) || t.status !== 'up') { body.innerHTML = '<p class="dim">Activate a connected SSH, WSL or local terminal tab to browse its files here (SFTP for SSH, the Windows/WSL filesystem for local tabs).<br><br>Drag &amp; drop files from Explorer onto the list to upload/copy.</p>'; return; }
    if (!t.sideView || t.sideView.conn !== t.connId) { t.sideView = sftpView(t, body); t.sideView.conn = t.connId; t.sideView.load(); }
    else if (t.sideView.el.parentNode !== body) body.replaceChildren(t.sideView.el);
  } else if (sideMode === 'db') {
    body.onclick = body.ondblclick = null;
    renderDbSide(body);
  } else if (sideMode === 'docker') {
    body.onclick = body.ondblclick = null;
    const t = active;
    if (!t || t.kind !== 'term' || t.session.type !== 'ssh' || t.status !== 'up') { body.innerHTML = '<p class="dim">Activate a connected SSH tab to manage the Docker containers on that host.</p>'; return; }
    body.innerHTML = '<div class="quick"><button id="dkr" class="grow">⟳ Refresh</button></div><div id="dkl" class="dim">Loading…</div>';
    let list = [];
    const load = async () => {
      try {
        list = await api.call('docker', t.connId, 'list');
        $('#dkl').classList.remove('dim');
        $('#dkl').innerHTML = list.map((c, i) => `<div class="item" data-i="${i}" title="${esc(c.Image)} — ${esc(c.Status)}${c.Ports ? '\n' + esc(c.Ports) : ''}"><span class="dot ${c.State === 'running' ? 'up' : 'down'}"></span><span class="name">${esc(c.Names)}<br><span class="dim" style="font-size:11px">${esc(c.Image)}</span></span>
          <span class="acts" style="display:flex"><button data-d="shell" title="Shell">>_</button><button data-d="logs" title="Follow logs">📜</button>${c.State === 'running' ? '<button data-d="stop" title="Stop">■</button>' : '<button data-d="start" title="Start">▶</button>'}<button data-d="restart" title="Restart">⟳</button></span></div>`).join('') || '<p class="dim">No containers.</p>';
      } catch (e) { $('#dkl').textContent = e.message; }
    };
    $('#dkr').onclick = load;
    body.onclick = async e => {
      const a = e.target.dataset.d; const it = e.target.closest('.item'); if (!a || !it) return;
      const c = list[+it.dataset.i];
      if (!/^\w[\w.-]*$/.test(c.ID)) return;
      if (a === 'shell') return connect({ ...t.session, id: uid(), name: `🐳 ${c.Names}`, monitor: false, command: `docker exec -it ${c.ID} sh -c "command -v bash >/dev/null && exec bash || exec sh"` });
      if (a === 'logs') return connect({ ...t.session, id: uid(), name: `📜 ${c.Names}`, monitor: false, command: `docker logs -f --tail 300 ${c.ID}` });
      if ((a === 'stop' || a === 'restart') && !(await confirmBox(`${a} container ${c.Names}?`))) return;
      try { e.target.disabled = true; await api.call('docker', t.connId, a, c.ID); toast(`${c.Names}: ${a} OK`, 'ok'); } catch (err) { toast(err.message, 'bad'); }
      load();
    };
    load();
  } else {
    body.onclick = body.ondblclick = null;
    body.innerHTML = `<div class="quick"><button id="mnew" class="grow">＋ New macro</button><button id="mrec">● Record</button><button id="mimp" title="Import a macros file exported from MobaXterm">⇣ Import</button></div>
      ${V.macros.map((m, i) => `<div class="item" data-id="${m.id}"><span class="badge">${i < 9 ? 'C+A+' + (i + 1) : '#'}</span><span class="name">${esc(m.name)}</span><span class="acts" style="display:flex"><button data-a="play" title="Play in active terminal (or all with MultiExec)">▶</button><button data-a="edit">✎</button><button data-a="del" class="danger">✕</button></span></div>`).join('') || '<p class="dim">No macros. Record one or create it manually. Unlimited macros, stored encrypted.</p>'}`;
    $('#mnew').onclick = () => editMacro();
    $('#mrec').onclick = toggleRecord;
    $('#mimp').onclick = () => importMobaFiles();
    body.onclick = async e => {
      const it = e.target.closest('.item'); const a = e.target.dataset.a; if (!it || !a) return;
      const m = V.macros.find(x => x.id === it.dataset.id);
      if (a === 'play') playMacro(m);
      if (a === 'edit') editMacro(m);
      if (a === 'del' && await confirmBox(`Delete macro "${m.name}"?`)) { V.macros = V.macros.filter(x => x !== m); save('macros'); renderSide(); }
    };
  }
}
// vertical rail: click an icon to switch panel; click the active one again to hide/show the panel
$('#rail').onclick = e => {
  const b = e.target.closest('button'); if (!b) return;
  const side = $('#side');
  if (b.dataset.side === sideMode && !side.classList.contains('collapsed')) side.classList.add('collapsed');
  else { side.classList.remove('collapsed'); sideMode = b.dataset.side; renderSide(); }
  requestAnimationFrame(() => tabs.forEach(fitTab));
};

function renderHome() {
  let ids = []; try { ids = JSON.parse(localStorage.recent || '[]'); } catch {}
  const rec = ids.map(id => V.sessions.find(s => s.id === id)).filter(Boolean);
  $('#home').innerHTML = `<div class="hero"><h1>${esc(S().brandName)}</h1><div class="dim">SSH · SFTP · WSL · Databases · RDP · VNC · Telnet · Serial · X11 · Tunnels · Docker · Macros</div>
    <div class="cards"><button data-act="newSession"><b>＋</b>New session</button><button data-act="localShell"><b>⌨</b>Local terminal</button><button data-act="importMobaFull"><b>⇣</b>Import MobaXterm</button><button data-act="importDBeaver"><b>⛃</b>Import DBeaver</button><button data-act="newDb"><b>⛃</b>Database</button><button data-act="palette"><b>⌘</b>Command palette</button><button data-act="tunnels"><b>⇄</b>Tunnels</button></div>
    ${rec.length ? `<div class="recent"><div class="dim" style="cursor:default">Recent sessions</div>${rec.map(s => `<div data-recent="${s.id}"><span class="badge ${s.type}">${s.type}</span> ${esc(s.name)}</div>`).join('')}</div>` : ''}</div>`;
}
$('#home').addEventListener('click', e => { const r = e.target.closest('[data-recent]'); if (r) connect(V.sessions.find(s => s.id === r.dataset.recent)); });

const copyText = (t, what = 'Copied') => { navigator.clipboard.writeText(String(t)); toast(what, 'ok'); };

function sessionMenu(e, s) {
  if (!s) return;
  const userHost = `${s.username ? s.username + '@' : ''}${s.host || ''}`;
  const isSsh = s.type === 'ssh' || s.type === 'sftp';
  const persist = () => { save('sessions'); renderSide(); };
  ctxMenu(e, [
    ['▶ Connect', () => connect(s)],
    ...(s.type === 'ssh' ? [['📁 Open SFTP browser', () => connect({ ...s, id: uid(), type: 'sftp', name: s.name + ' (SFTP)' })]] : []),
    ...(isSsh ? [['⇄ New tunnel through this session…', () => editTunnel({ id: uid(), name: '', type: 'L', sessionId: s.id }, () => {})], ['🔑 Install public key on server…', () => installKeyUI(s)]] : []),
    '-',
    ['✎ Edit…', () => editSession(s)],
    ['Rename…', async () => { const r = await ask('Rename session', [['n', 'Name']], { n: s.name }); if (r && r.n) { s.name = r.n; persist(); } }],
    ['Move to folder…', async () => { const r = await ask('Move to folder', [['f', 'Folder (e.g. Prod/Web, empty = top level)']], { f: s.folder || '' }); if (r) { s.folder = r.f; persist(); } }],
    ['⧉ Duplicate', () => { V.sessions.push({ ...s, id: uid(), name: s.name + ' (copy)' }); persist(); }],
    '-',
    ...(s.host ? [['Copy host', () => copyText(s.host)], ['Copy user@host', () => copyText(userHost)]] : []),
    ...(isSsh ? [['Copy ssh command', () => copyText(`ssh ${+s.port && +s.port !== 22 ? `-p ${s.port} ` : ''}${userHost}`)]] : []),
    ...(s.password ? [['Forget saved password', async () => { if (await confirmBox(`Forget the saved password of "${s.name}"?`)) { delete s.password; persist(); } }]] : []),
    '-',
    ['✕ Delete', async () => { if (await confirmBox(`Delete session "${s.name}"?`)) { V.sessions = V.sessions.filter(x => x !== s); persist(); } }],
  ]);
}

// Drag `handle` to resize `target` along 'x' (width) or 'y' (height). Size is remembered under `key`.
function splitter(handle, target, axis, key, min = 60, onMove) {
  const prop = axis === 'x' ? 'width' : 'height';
  try { const saved = localStorage[key]; if (saved) target.style[prop] = saved; } catch {}
  handle.addEventListener('mousedown', e => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const size = axis === 'x' ? target.offsetWidth : target.offsetHeight;
    const max = (axis === 'x' ? target.parentNode.offsetWidth : target.parentNode.offsetHeight) - min;
    handle.classList.add('drag'); document.body.classList.add('dragging');
    const move = ev => { target.style[prop] = Math.max(min, Math.min(max, size + (axis === 'x' ? ev.clientX : ev.clientY) - start)) + 'px'; onMove && onMove(); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', () => {
      document.removeEventListener('mousemove', move);
      handle.classList.remove('drag'); document.body.classList.remove('dragging');
      try { localStorage[key] = target.style[prop]; } catch {}
      onMove && onMove();
    }, { once: true });
  });
}

// sidebar resize
$('#resizer').onmousedown = e => {
  const left = $('#side').getBoundingClientRect().left;
  const move = ev => { $('#side').style.width = Math.max(180, Math.min(700, ev.clientX - left)) + 'px'; };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', () => { document.removeEventListener('mousemove', move); tabs.forEach(fitTab); }, { once: true });
};

// ---------------- dialogs: tunnels ----------------
let activeTunnels = new Set();
api.on('tun:status', (id, on) => { on ? activeTunnels.add(id) : activeTunnels.delete(id); refreshStatus(); if (tunnelsView) tunnelsView(); });
let tunnelsView = null;
function tunnels() {
  const body = h('<div></div>');
  const draw = async () => {
    activeTunnels = new Set(await api.call('tun:active'));
    const sess = id => (V.sessions.find(s => s.id === id) || {}).name || '?';
    const desc = t => t.type === 'L' ? `localhost:${t.localPort} → ${t.remoteHost}:${t.remotePort}` : t.type === 'R' ? `remote:${t.remotePort} → ${t.localHost || 'localhost'}:${t.localPort}` : `SOCKS5 proxy on localhost:${t.localPort}`;
    body.innerHTML = `<p class="dim" style="margin-top:0">Local (-L), remote (-R) and dynamic SOCKS (-D) port forwarding over SSH. Tunnels run independently of terminal tabs.</p>
      <table class="tbl"><tr><th></th><th>Name</th><th>Type</th><th>Via SSH</th><th>Forward</th><th></th></tr>
      ${V.tunnels.map(t => `<tr data-id="${t.id}"><td><span class="dot ${activeTunnels.has(t.id) ? 'up' : ''}"></span></td><td>${esc(t.name)}</td><td>${{ L: 'Local', R: 'Remote', D: 'Dynamic' }[t.type]}</td><td>${esc(sess(t.sessionId))}</td><td class="mono">${esc(desc(t))}</td>
      <td style="white-space:nowrap">${activeTunnels.has(t.id) ? '<button data-a="stop">■ Stop</button>' : '<button data-a="start">▶ Start</button>'} <button data-a="edit">✎</button> <button data-a="del" class="danger">✕</button></td></tr>`).join('') || '<tr><td colspan="6" class="dim">No tunnels yet.</td></tr>'}</table>`;
  };
  tunnelsView = () => body.isConnected ? draw() : (tunnelsView = null);
  body.onclick = async e => {
    const tr = e.target.closest('tr'); const a = e.target.dataset.a; if (!tr || !a) return;
    const t = V.tunnels.find(x => x.id === tr.dataset.id);
    try {
      if (a === 'start') { e.target.disabled = true; await api.call('tun:start', t); toast(`Tunnel ${t.name} started`, 'ok'); }
      if (a === 'stop') await api.call('tun:stop', t.id);
      if (a === 'edit') return editTunnel(t, draw);
      if (a === 'del') { await api.call('tun:stop', t.id); V.tunnels = V.tunnels.filter(x => x !== t); save('tunnels'); }
    } catch (err) { toast(err.message, 'bad'); }
    draw();
  };
  draw();
  modal('SSH Tunneling', body, [{ label: '＋ New tunnel', onClick: () => { editTunnel(null, draw); return false; } }, { label: 'Close', cls: 'primary' }], 'wide');
}
async function editTunnel(t, done) {
  const sshs = V.sessions.filter(s => s.type === 'ssh').map(s => [s.id, s.name]);
  if (!sshs.length) return toast('Create an SSH session first — tunnels go through it', 'bad');
  const r = await ask(t ? 'Edit tunnel' : 'New tunnel', [
    ['name', 'Name'], ['type', 'Type', 'select', 'L', [['L', 'Local (-L): local port → remote host'], ['R', 'Remote (-R): remote port → local host'], ['D', 'Dynamic (-D): SOCKS5 proxy']]],
    ['sessionId', 'Via SSH session', 'select', sshs[0][0], sshs], ['localPort', 'Local port', 'number'], ['bind', 'Bind address', 'text', '127.0.0.1'],
    ['remoteHost', 'Remote host (Local type)', 'text', '127.0.0.1'], ['remotePort', 'Remote port', 'number'], ['localHost', 'Local target host (Remote type)', 'text', '127.0.0.1'],
    ['autostart', 'Start automatically on unlock', 'check'],
  ], t || {}, 'Save');
  if (!r) return;
  if (!r.localPort && r.type !== 'R') return toast('Local port is required', 'bad');
  const out = { ...(t || { id: uid() }), ...r, name: r.name || `${r.type} ${r.localPort || ''}→${r.remotePort || ''}` };
  const i = V.tunnels.findIndex(x => x.id === out.id); i >= 0 ? (V.tunnels[i] = out) : V.tunnels.push(out);
  await save('tunnels'); done && done();
}

// ---------------- dialogs: servers ----------------
let srvLog = [];
api.on('srv:log', m => { srvLog.push(m); srvLog = srvLog.slice(-300); const p = $('#srvlog'); if (p) { p.textContent = srvLog.join('\n'); p.scrollTop = 1e9; } refreshStatus(); });
async function serversDlg() {
  const cfg = S().servers || {};
  const status = await api.call('srv:status');
  const body = h(`<div><p class="dim" style="margin-top:0">Embedded servers to move files to/from network devices and hosts. Bind to 127.0.0.1 to keep them local; 0.0.0.0 exposes them on your network.</p><div class="grid2"></div><pre class="out" id="srvlog"></pre></div>`);
  const mk = (kind, label, extra) => {
    const fs = h(`<fieldset><legend>${label} <span class="dot ${status[kind] ? 'up' : ''}"></span></legend></fieldset>`);
    const f = form([['root', 'Root folder', 'dir'], ['port', 'Port', 'number', kind === 'http' ? 8080 : 69], ['bind', 'Bind address', 'text', '0.0.0.0'], ...extra], cfg[kind] || {});
    const btn = h(`<button class="${status[kind] ? '' : 'primary'}" style="margin-top:10px">${status[kind] ? '■ Stop' : '▶ Start'}</button>`);
    btn.onclick = async () => {
      try {
        if (status[kind]) { await api.call('srv:stop', kind); delete status[kind]; }
        else { const v = readForm(f); V.settings.servers = { ...cfg, [kind]: v }; save('settings'); status[kind] = await api.call('srv:start', kind, v); }
        btn.textContent = status[kind] ? '■ Stop' : '▶ Start'; btn.className = status[kind] ? '' : 'primary';
        $('.dot', fs).classList.toggle('up', !!status[kind]);
      } catch (e) { toast(e.message, 'bad'); }
    };
    fs.append(f, btn);
    return fs;
  };
  $('.grid2', body).append(mk('http', 'HTTP file server', []), mk('tftp', 'TFTP server', [['allowWrite', 'Allow uploads (PUT)', 'check', true]]));
  $('#srvlog', body) && ($('#srvlog', body).textContent = srvLog.join('\n') || 'Server log…');
  modal('Embedded servers', body, [{ label: 'Close', cls: 'primary' }], 'wide');
}

// ---------------- dialogs: tools ----------------
function toolsDlg() {
  const body = h(`<div class="grid2">
    <fieldset><legend>Port scanner</legend><div class="row"><input id="psH" placeholder="Host"><input id="psP" value="21,22,23,25,53,80,110,143,443,445,3306,3389,5432,5900,8080,8443"></div><button id="psGo">Scan</button><pre class="out" id="psO" hidden></pre></fieldset>
    <fieldset><legend>Network scanner</legend><div class="row"><input id="nsH" placeholder="Subnet prefix, e.g. 192.168.1"><input id="nsP" value="22,80,443,445,3389"></div><button id="nsGo">Scan /24</button><pre class="out" id="nsO" hidden></pre></fieldset>
    <fieldset><legend>DNS lookup</legend><div class="row"><input id="dnH" placeholder="example.com"><button id="dnGo">Lookup</button></div><pre class="out" id="dnO" hidden></pre></fieldset>
    <fieldset><legend>Wake-on-LAN</legend><div class="row"><input id="wlM" placeholder="MAC aa:bb:cc:dd:ee:ff"><input id="wlB" value="255.255.255.255"><button id="wlGo">Wake</button></div></fieldset>
    <fieldset><legend>Password generator</legend><div class="row"><input id="pgL" type="number" value="24" style="max-width:70px"><label><input type="checkbox" id="pgS" checked> symbols</label><button id="pgGo">Generate</button></div><div class="row"><input id="pgO" class="mono" readonly><button id="pgC">Copy</button></div></fieldset>
    <fieldset><legend>SSH key generator</legend><div class="row"><select id="kgT"><option value="ed25519">Ed25519</option><option value="rsa">RSA 4096</option><option value="ecdsa">ECDSA</option></select><input id="kgC" placeholder="comment (user@host)"><input id="kgP" type="password" placeholder="passphrase (optional)"></div><button id="kgGo">Generate &amp; save…</button><pre class="out" id="kgO" hidden></pre></fieldset>
    <fieldset><legend>Network commands (open in terminal)</legend><div class="row"><input id="ncH" placeholder="Host / IP"></div><div class="row">
      <button data-nc="ping -t {h}">Ping</button><button data-nc="tracert {h}">Traceroute</button><button data-nc="pathping {h}">PathPing</button><button data-nc="nslookup {h}">nslookup</button><button data-nc="netstat -ano">Netstat</button><button data-nc="ipconfig /all">IP config</button><button data-nc="arp -a">ARP table</button><button data-nc="route print">Routes</button></div></fieldset>
    <fieldset><legend>Import &amp; install</legend><div class="row"><button id="imMoba">Import MobaXterm (sessions + passwords + macros)</button></div><div class="row"><button id="imMobaF" title="Passwords .txt and macros file exported from MobaXterm's own menus">MobaXterm exported passwords / macros files</button></div><div class="row"><button id="imMobaS">Sessions only (quick)</button><button id="imDBeaver">Import DBeaver databases</button></div><div class="row">
      <button data-nc="winget install -e --id marha.VcXsrv">Install X server (VcXsrv)</button><button data-nc="winget install -e --id TigerVNC.TigerVNC">Install TigerVNC viewer</button></div></fieldset>
  </div>`);
  const out = (id, text) => { const p = $(id, body); p.hidden = false; p.textContent = text; };
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } catch (e) { toast(e.message, 'bad'); } btn.disabled = false; };
  $('#psGo', body).onclick = e => busy(e.target, async () => { out('#psO', 'Scanning…'); const r = await api.call('tool:scan', $('#psH', body).value.trim(), $('#psP', body).value); out('#psO', r.length ? 'Open ports: ' + r.join(', ') : 'No open ports found'); });
  $('#nsGo', body).onclick = e => busy(e.target, async () => { out('#nsO', 'Scanning 254 hosts…'); const r = await api.call('tool:netscan', $('#nsH', body).value.trim().replace(/\.$/, ''), $('#nsP', body).value); out('#nsO', r.map(x => `${x.host.padEnd(16)} ${(x.name || '').padEnd(28)} ${x.open.join(',')}`).join('\n') || 'No hosts found'); });
  $('#dnGo', body).onclick = e => busy(e.target, async () => { const r = await api.call('tool:dns', $('#dnH', body).value.trim()); out('#dnO', Object.entries(r).filter(([, v]) => v.length).map(([k, v]) => `${k.padEnd(6)} ${v.map(x => typeof x === 'object' ? (x.exchange ? `${x.priority} ${x.exchange}` : JSON.stringify(x)) : x).join('\n       ')}`).join('\n') || 'No records'); });
  $('#wlGo', body).onclick = e => busy(e.target, async () => { await api.call('tool:wol', $('#wlM', body).value, $('#wlB', body).value); toast('Magic packet sent', 'ok'); });
  $('#pgGo', body).onclick = async () => { $('#pgO', body).value = await api.call('tool:pass', $('#pgL', body).value, $('#pgS', body).checked); };
  $('#pgC', body).onclick = () => { navigator.clipboard.writeText($('#pgO', body).value); toast('Copied', 'ok'); };
  $('#kgGo', body).onclick = e => busy(e.target, async () => {
    const k = await api.call('tool:keygen', $('#kgT', body).value, { comment: $('#kgC', body).value, passphrase: $('#kgP', body).value, bits: 4096 });
    const passphrase = $('#kgP', body).value;
    const p = await api.call('tool:savekey', k.private, k.public);
    out('#kgO', (p ? `Saved ${p} and ${p}.pub\n\n` : 'Not saved to a file (you can still keep it in the vault below).\n\n') + k.public);
    afterKeygen(k, p, passphrase);
  });
  body.addEventListener('click', e => {
    const c = e.target.dataset.nc; if (!c) return;
    const host = $('#ncH', body).value.trim();
    if (c.includes('{h}') && !host) return toast('Enter a host first', 'bad');
    connect({ id: uid(), type: 'shell', name: c.split(' ')[0] + (host && c.includes('{h}') ? ' ' + host : ''), command: `cmd.exe /k ${c.replace('{h}', host)}` });
  });
  $('#imMoba', body).onclick = () => importMobaFull();
  $('#imMobaS', body).onclick = importMoba;
  $('#imMobaF', body).onclick = () => importMobaFiles();
  $('#imDBeaver', body).onclick = () => importDBeaver();
  modal('Tools', body, [{ label: 'Close', cls: 'primary' }], 'wide');
}
async function importMoba() {
  try {
    const list = await api.call('moba:import');
    if (!list) return;
    const key = s => `${s.type}|${s.host || s.port || s.command}|${s.port}|${s.username || ''}`;
    const have = new Set(V.sessions.map(key));
    const fresh = list.filter(s => !have.has(key(s))).map(s => ({ ...s, folder: s.folder ? 'MobaXterm/' + s.folder : 'MobaXterm', monitor: true }));
    V.sessions.push(...fresh); await save('sessions'); renderSide();
    toast(`Imported ${fresh.length} session(s) (${list.length - fresh.length} already present). Passwords are not imported — you will be asked on first connect.`, 'ok');
  } catch (e) { toast(e.message, 'bad'); }
}

// ---------------- dialogs: password manager ----------------
function passwords() {
  const body = h('<div></div>');
  const mask = (v, i) => v ? `<span class="mono pw" data-v="${i}">••••••••</span> <button data-a="show" data-v="${i}">👁</button> <button data-a="copy" data-v="${i}">Copy</button>` : '<span class="dim">—</span>';
  let secrets = [];
  const draw = () => {
    secrets = [];
    const sec = v => (secrets.push(v), secrets.length - 1);
    const sp = V.sessions.filter(s => s.password || s.passphrase);
    body.innerHTML = `<h3 style="margin-top:0">Saved credentials <button data-a="addc" style="float:right">＋ Add</button></h3>
      <p class="dim">Reusable logins: pick one in any session ("Or saved credential").</p>
      <table class="tbl"><tr><th>Name</th><th>Username</th><th>Password</th><th>Key file</th><th></th></tr>
      ${V.credentials.map(c => `<tr data-c="${c.id}"><td>${esc(c.name)}</td><td>${esc(c.username)}</td><td>${mask(c.password, sec(c.password))}</td><td class="mono">${esc(c.keyFile || '')}${c.keyData ? ' <span class="badge" title="A copy of the key is stored in the vault">🔒 in vault</span>' : ''}</td><td><button data-a="editc">✎</button> <button data-a="delc" class="danger">✕</button></td></tr>`).join('') || '<tr><td colspan="5" class="dim">None</td></tr>'}</table>
      <h3>Session passwords</h3>
      <table class="tbl"><tr><th>Session</th><th>Login</th><th>Password</th><th></th></tr>
      ${sp.map(s => `<tr data-s="${s.id}"><td>${esc(s.name)}</td><td>${esc((s.username || '') + '@' + (s.host || ''))}</td><td>${mask(s.password, sec(s.password))}</td><td><button data-a="clears" class="danger">Forget</button></td></tr>`).join('') || '<tr><td colspan="4" class="dim">None</td></tr>'}</table>
      <h3>Known SSH host keys</h3>
      <table class="tbl"><tr><th>Host</th><th>Fingerprint</th><th></th></tr>
      ${Object.entries(V.knownHosts || {}).map(([k, v]) => `<tr data-k="${esc(k)}"><td>${esc(k)}</td><td class="mono">${esc(v)}</td><td><button data-a="delk" class="danger">✕</button></td></tr>`).join('') || '<tr><td colspan="3" class="dim">None</td></tr>'}</table>`;
  };
  body.onclick = async e => {
    const a = e.target.dataset.a; if (!a) return;
    const tr = e.target.closest('tr');
    if (a === 'show') { const s = $(`.pw[data-v="${e.target.dataset.v}"]`, body); s.textContent = s.textContent.startsWith('•') ? secrets[e.target.dataset.v] : '••••••••'; return; }
    if (a === 'copy') { navigator.clipboard.writeText(secrets[e.target.dataset.v]); toast('Copied — clipboard clears in 30 s', 'ok'); const v = secrets[e.target.dataset.v]; setTimeout(() => navigator.clipboard.readText().then(t => t === v && navigator.clipboard.writeText('')).catch(() => {}), 30000); return; }
    if (a === 'addc' || a === 'editc') {
      const c = a === 'editc' ? V.credentials.find(x => x.id === tr.dataset.c) : null;
      const r = await ask(c ? 'Edit credential' : 'New credential', [['name', 'Name'], ['username', 'Username'], ['password', 'Password', 'password'], ['keyFile', 'Private key file', 'file'], ['keyInVault', 'Keep a copy of the key inside the encrypted vault (keeps working if the file moves; included in vault backups)', 'check'], ['passphrase', 'Key passphrase', 'password']], c || {}, 'Save');
      if (!r) return;
      const item = { ...(c || { id: uid() }), ...r, name: r.name || r.username };
      try { await keyToVault(item, c); } catch (e) { return toast(e.message, 'bad'); }
      if (c) Object.assign(c, item); else V.credentials.push(item);
      await save('credentials');
    }
    if (a === 'delc' && await confirmBox('Delete this credential?')) { V.credentials = V.credentials.filter(x => x.id !== tr.dataset.c); await save('credentials'); }
    if (a === 'clears') { const s = V.sessions.find(x => x.id === tr.dataset.s); delete s.password; delete s.passphrase; await save('sessions'); }
    if (a === 'delk') { delete V.knownHosts[tr.dataset.k]; await save('knownHosts'); }
    draw();
  };
  draw();
  modal('Password manager', body, [
    { label: 'Change master password', onClick: async () => { await changeMaster(); return false; } },
    { label: 'Backup encrypted vault…', onClick: async () => { if (await api.call('vault:export')) toast('Vault backup saved (still encrypted)', 'ok'); return false; } },
    { label: 'Close', cls: 'primary' },
  ], 'wide');
}
async function changeMaster() {
  const r = await ask('Change master password', [['a', 'New password', 'password'], ['b', 'Confirm', 'password']], {}, 'Change');
  if (!r) return;
  if (r.a.length < 6 || r.a !== r.b) return toast(r.a.length < 6 ? 'Use at least 6 characters' : 'Passwords do not match', 'bad');
  await api.call('vault:password', r.a); toast('Master password changed', 'ok');
}

// ---------------- dialogs: settings / customizer ----------------
function settingsDlg() {
  const s = S();
  const fields = [
    ['heading', 'Appearance'],
    ['appTheme', 'Application theme', 'select', 'dark', [['dark', 'Dark'], ['light', 'Light']]], ['accent', 'Accent color', 'color'], ['brandName', 'Branding name (title)'],
    ['heading', 'Terminal'],
    ['termTheme', 'Color scheme', 'select', '', Object.keys(THEMES)], ['fontFamily', 'Font family'], ['fontSize', 'Font size', 'number'],
    ['cursorStyle', 'Cursor', 'select', '', ['block', 'bar', 'underline']], ['cursorBlink', 'Blinking cursor', 'check'], ['scrollback', 'Scrollback lines', 'number'],
    ['copyOnSelect', 'Copy on select', 'check'], ['rightClickPaste', 'Paste on right-click', 'check'], ['confirmClose', 'Confirm before closing connected tabs', 'check'],
    ['highlight', 'Syntax highlighting in terminal', 'check'], ['highlightRules', 'Custom highlight rules (regex => SGR color, one per line; empty = defaults)', 'textarea'],
    ['monitor', 'Remote monitoring bar (SSH)', 'check'],
    ['heading', 'Sessions & X11'],
    ['defaultShell', 'Default local shell', 'datalist', '', SHELLS], ['x11Display', 'X11 display number', 'number'], ['autoStartX', 'Start X server on unlock', 'check'],
    ['vncViewer', 'VNC viewer executable', 'file'],
    ['heading', 'Security & logging'],
    ['autoLockMin', 'Auto-lock vault after idle minutes (0 = never; closes connections)', 'number'],
    ['autoLog', 'Log every terminal session to files', 'check'], ['logDir', 'Log folder', 'dir'],
    ['heading', 'Databases'],
    ['dbRowLimit', 'Default max rows per result', 'number'],
    ['heading', 'Customizer — disable protocols'],
    ...Object.entries(TYPES).map(([k, l]) => ['dis_' + k, `Disable ${l}`, 'check']),
  ];
  const vals = { ...s, ...Object.fromEntries(s.disabledTypes.map(t => ['dis_' + t, true])) };
  if (!vals.highlightRules) vals.highlightRules = '';
  const f = form(fields, vals);
  const hint = h(`<p class="dim full" style="margin:0">Default highlight rules:<br><span class="mono">${Highlight.DEFAULT_RULES.map(r => esc(r.pattern) + ' => ' + r.color).join('<br>')}</span></p>`);
  f.append(hint);
  modal('Settings & Customizer', f, [
    { label: 'Reset app…', cls: 'danger', onClick: async () => { await resetApp(); return false; } },
    { label: 'Export config…', onClick: async () => { await exportConfig(); return false; } },
    { label: 'Import config…', onClick: async () => { await importConfig(); return false; } },
    { label: 'Cancel' },
    {
      label: 'Save', cls: 'primary', onClick: () => {
        const v = readForm(f);
        const disabledTypes = Object.keys(TYPES).filter(k => v['dis_' + k]);
        for (const k of Object.keys(v)) if (k.startsWith('dis_')) delete v[k];
        V.settings = { ...V.settings, ...v, disabledTypes };
        save('settings'); applySettings(); renderHome(); toast('Settings saved', 'ok');
      },
    },
  ], 'wide');
}
// Permanently delete the vault (all sessions, passwords, credentials, macros, DB connections + scripts, tunnels, settings).
async function resetApp() {
  const r = await ask('Reset TermuCraft — delete ALL data', [
    ['heading', 'This permanently deletes every saved session, password, credential, macro, database connection, script, tunnel and setting on this PC. It cannot be undone. Export a backup first if you might need it.'],
    ['c', 'Type DELETE to confirm'],
  ], {}, 'Delete everything');
  if (!r) return false;
  if (r.c !== 'DELETE') { toast('Nothing deleted — type DELETE exactly', 'bad'); return false; }
  await api.call('vault:reset');
  try { localStorage.clear(); } catch {}
  leaving = true; location.reload();
  return true;
}

async function exportConfig() {
  const r = await ask('Export configuration', [['secrets', 'Include passwords (file will NOT be encrypted)', 'check', false]], {}, 'Export');
  if (!r) return;
  const strip = o => { const x = { ...o }; delete x.password; delete x.passphrase; delete x.keyData; delete x.keyInVault; return x; };
  const data = { termucraft: 1, settings: V.settings, sessions: r.secrets ? V.sessions : V.sessions.map(strip), macros: V.macros, tunnels: V.tunnels, credentials: r.secrets ? V.credentials : V.credentials.map(strip), dbs: r.secrets ? V.dbs : V.dbs.map(strip) };
  const p = await api.call('file:save', null, JSON.stringify(data, null, 2));
  if (p) toast('Exported to ' + p, 'ok');
}
async function importConfig() {
  const f = await api.call('file:open'); if (!f) return;
  let d; try { d = JSON.parse(f.text); } catch { return toast('Not a TermuCraft config file', 'bad'); }
  if (!d.termucraft && !d.mobacraft) return toast('Not a TermuCraft config file', 'bad'); // mobacraft = files from the old name
  const merge = (k) => { const ids = new Set(V[k].map(x => x.id)); V[k].push(...(d[k] || []).filter(x => !ids.has(x.id))); };
  ['sessions', 'macros', 'tunnels', 'credentials', 'dbs'].forEach(merge);
  V.settings = { ...V.settings, ...(d.settings || {}) };
  await save('sessions', 'macros', 'tunnels', 'credentials', 'dbs', 'settings');
  applySettings(); renderSide(); toast('Configuration imported', 'ok');
}

// ---------------- X server ----------------
async function xserver() {
  try {
    const st = await api.call('x:status');
    if (!st.installed) {
      if (await confirmBox('No X server found. Install VcXsrv now with winget? (opens a terminal)')) connect({ id: uid(), type: 'shell', name: 'Install VcXsrv', command: 'cmd.exe /k winget install -e --id marha.VcXsrv' });
      return;
    }
    await api.call(st.running ? 'x:stop' : 'x:start');
    toast(st.running ? 'X server stopped' : `X server started on display :${+S().x11Display || 0}`, 'ok');
  } catch (e) { toast(e.message, 'bad'); }
  setTimeout(refreshStatus, 600);
}
api.on('x:status', () => refreshStatus());

async function refreshStatus() {
  if (!V) return;
  const [x, srv, tun] = await Promise.all([api.call('x:status'), api.call('srv:status'), api.call('tun:active')]);
  activeTunnels = new Set(tun);
  $('#btnX').classList.toggle('on', x.running);
  $('#stLeft').innerHTML = `🔓 Vault unlocked · <b>${V.sessions.length}</b> sessions · <b>${V.macros.length}</b> macros`;
  $('#stRight').innerHTML = [
    `X11: <b>${x.running ? 'running :' + (+S().x11Display || 0) : x.installed ? 'stopped' : 'not installed'}</b>`,
    `Tunnels: <b>${tun.length}</b>`,
    ...Object.entries(srv).map(([k, p]) => `${k.toUpperCase()}: <b>:${p}</b>`),
  ].join(' · ');
}

// ---------------- toolbar & shortcuts ----------------
const ACTIONS = {
  newSession: () => editSession(),
  localShell: () => connect({ id: uid(), type: 'shell', name: 'Local: ' + S().defaultShell.split(/[\\/ ]/).filter(Boolean).pop(), command: S().defaultShell }),
  openEditor: async () => { const r = await ask('Text editor', [['mode', 'Open', 'select', 'new', [['new', 'New empty file'], ['open', 'Open local file…']]]]); if (!r) return; if (r.mode === 'new') return openEditor({}); const f = await api.call('file:open'); if (f) openEditor({ title: f.path.split(/[\\/]/).pop(), text: f.text, path: f.path }); },
  servers: serversDlg, tools: toolsDlg, tunnels, passwords, settings: settingsDlg, xserver, importMoba,
  record: toggleRecord,
  multiExec: () => { multiExec = !multiExec; $('#btnMulti').classList.toggle('on', multiExec); renderTabs(); toast(multiExec ? 'MultiExec ON — typing goes to all checked terminals' : 'MultiExec OFF'); },
  tile: () => { if (split) unsplit(); const on = $('#panes').classList.toggle('tile'); $('#btnTile').classList.toggle('on', on); if (on) layoutTile(); else { $('#panes').style.gridTemplateColumns = $('#panes').style.gridTemplateRows = ''; requestAnimationFrame(() => tabs.forEach(fitTab)); } },
  lock: async () => { if (await confirmBox(`Lock the vault? All connections will be closed.${tabs.some(unsavedWork) ? ' Unsaved changes and uncommitted transactions will be lost.' : ''}`)) { await api.call('vault:lock'); leaving = true; location.reload(); } },
  newDb: () => editDb(),
  palette: () => palette(),
  importMobaFull: () => importMobaFull(),
  importMobaFiles: () => importMobaFiles(),
  importDBeaver: () => importDBeaver(),
};

// command palette: sessions, databases, WSL, macros, tabs and actions in one fuzzy list
function palette() {
  const acts = [['New session', 'newSession'], ['Local terminal', 'localShell'], ['Text editor', 'openEditor'], ['New database connection', 'newDb'], ['Embedded servers', 'servers'], ['Tools', 'tools'],
    ['SSH tunnels', 'tunnels'], ['Password manager', 'passwords'], ['Settings', 'settings'], ['Toggle MultiExec', 'multiExec'], ['Toggle tile view', 'tile'], ['Record macro', 'record'],
    ['Start/stop X server', 'xserver'], ['Import MobaXterm sessions', 'importMobaFull'], ['Import MobaXterm exported passwords / macros files', 'importMobaFiles'], ['Lock vault', 'lock']];
  const items = [
    ...tabs.map(t => ({ k: 'tab', label: t.title, run: () => activate(t) })),
    ...V.sessions.map(s => ({ k: s.type, label: s.name, sub: s.host || s.distro || s.command || '', run: () => connect(s) })),
    ...V.dbs.map(d => ({ k: 'db', label: d.name, sub: ENGINES[d.engine], run: () => openDb(d) })),
    ...wslDistros.filter(d => !/^docker-desktop/i.test(d)).map(d => ({ k: 'wsl', label: 'WSL ' + d, run: () => connect({ id: uid(), type: 'wsl', name: 'WSL ' + d, distro: d }) })),
    ...V.macros.map(m => ({ k: 'macro', label: 'Run macro: ' + m.name, run: () => playMacro(m) })),
    ...acts.map(([l, a]) => ({ k: 'action', label: l, run: () => ACTIONS[a]() })),
  ];
  const body = h('<div><input placeholder="Type to search sessions, databases, WSL, macros, actions…"><div class="pl"></div></div>');
  const m = modal('', body, [], 'palette');
  $('h2', m.el.closest('.modal')).remove();
  let shown = [], sel = 0;
  const score = (q, s) => { s = s.toLowerCase(); let i = 0; for (const c of q) { i = s.indexOf(c, i); if (i < 0) return -1; i++; } return s.startsWith(q) ? 2 : s.includes(q) ? 1 : 0; };
  const draw = () => {
    const q = $('input', body).value.toLowerCase().trim();
    shown = items.map(x => [x, q ? score(q, `${x.label} ${x.sub || ''}`) : 0]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([x]) => x);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    $('.pl', body).innerHTML = shown.map((x, i) => `<div class="item ${i === sel ? 'on' : ''}" data-i="${i}"><span class="badge ${x.k}">${x.k}</span><span class="name">${esc(x.label)}</span><span class="dim">${esc(x.sub || '')}</span></div>`).join('') || '<p class="dim">No match</p>';
  };
  const go = i => { const x = shown[i]; if (x) { m.close(); x.run(); } };
  $('input', body).oninput = () => { sel = 0; draw(); };
  $('input', body).onkeydown = e => {
    if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, shown.length - 1); draw(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); draw(); e.preventDefault(); }
    if (e.key === 'Enter') { e.stopPropagation(); go(sel); }
  };
  $('.pl', body).onclick = e => { const it = e.target.closest('.item'); if (it) go(+it.dataset.i); };
  draw();
}
document.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b && V) ACTIONS[b.dataset.act](); });
document.addEventListener('keydown', e => {
  if (!V) return;
  const k = e.code;
  if (e.ctrlKey && e.shiftKey) {
    const map = { KeyN: 'newSession', KeyT: 'localShell', KeyM: 'multiExec', KeyR: 'record', KeyP: 'palette' };
    if (map[k]) { e.preventDefault(); return ACTIONS[map[k]](); }
    if (k === 'KeyW' && active) { e.preventDefault(); return closeTab(active); }
  }
  if (e.ctrlKey && k === 'Tab' && tabs.length) { e.preventDefault(); const i = tabs.indexOf(active); activate(tabs[(i + (e.shiftKey ? -1 : 1) + tabs.length) % tabs.length]); }
  if (e.ctrlKey && e.altKey && /^Digit[1-9]$/.test(k)) { const m = V.macros[+k.slice(5) - 1]; if (m) { e.preventDefault(); playMacro(m); } }
}, true);
window.addEventListener('resize', () => tabs.forEach(fitTab));
let leaving = false;
const unsavedWork = t => t.dirty || (t.txPending && t.txPending()) || (t.gridEdits && t.gridEdits());
window.addEventListener('beforeunload', e => { if (!leaving && tabs.some(unsavedWork)) { e.preventDefault(); e.returnValue = ''; } });

boot();

// ---------------- end-to-end smoke test (npm run smoke) ----------------
window.smoke = async ({ port, live, dbs = [], tmp, keyFile, canInstallKey }) => {
  const r = { checks: {}, errors: [] };
  window.addEventListener('error', e => r.errors.push(e.message));
  const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (await f()) return true; } catch {} await sleep(100); } return false; };
  const text = t => { const b = t.term.buffer.active; let s = ''; for (let i = 0; i < b.length; i++) s += b.getLine(i).translateToString(true) + '\n'; return s; };
  const check = async (name, f) => { try { r.checks[name] = !!(await f()); } catch (e) { r.checks[name] = false; r.errors.push(`${name}: ${e.message}`); } };

  await check('vault create', async () => { await unlock('smoke-password', true); return V && Array.isArray(V.sessions); });
  await check('local shell (cmd)', async () => {
    const t = await connect({ id: uid(), type: 'shell', name: 'cmd', command: 'cmd.exe' }) || active;
    await until(() => active.status === 'up');
    input(active, 'echo SMOKE_%COMPUTERNAME%\r');
    return until(() => /SMOKE_\w+/.test(text(active).replace(/SMOKE_%COMPUTERNAME%/g, '')));
  });
  const fake = { id: uid(), type: 'ssh', name: 'fake-sshd', host: '127.0.0.1', port, username: 'u', password: 'p', x11: false, monitor: true };
  V.sessions.push(fake); await save('sessions'); renderSide();
  let sshTab;
  await check('ssh connect + shell', async () => { await connect(fake); sshTab = active; return until(() => text(sshTab).includes('welcome')); });
  await check('ssh typing', async () => { input(sshTab, 'hello\r'); return until(() => text(sshTab).includes('echo:hello')); });
  await check('sftp sidebar lists files', async () => { sideMode = 'sftp'; renderSide(); return until(() => $('#sidebody').textContent.includes('hello.txt')); });
  await check('sftp edit + save', async () => {
    const ed = await openRemoteFile(sshTab, '/hello.txt');
    if (ed.cm.getValue() !== 'hi from sftp') return false;
    ed.cm.setValue('edited'); await ed.save();
    const back = await api.call('fs', { conn: sshTab.connId }, 'read', '/hello.txt');
    await closeTab(ed, true); activate(sshTab);
    return back === 'edited';
  });
  await check('macro playback', async () => { V.macros.push({ id: uid(), name: 'm', text: 'macro1\n' }); await playMacro(V.macros[0]); return until(() => text(sshTab).includes('echo:macro1')); });
  await check('multiexec to 2 terminals', async () => {
    await connect(fake); const t2 = active; await until(() => text(t2).includes('welcome'));
    ACTIONS.multiExec(); input(t2, 'multi\r'); ACTIONS.multiExec();
    return until(() => text(t2).includes('echo:multi') && text(sshTab).includes('echo:multi'));
  });
  await check('tile layout', async () => { ACTIONS.tile(); await sleep(300); const ok = $('#panes').classList.contains('tile'); ACTIONS.tile(); return ok; });
  await check('dialogs open', async () => {
    for (const a of ['newSession', 'servers', 'tools', 'tunnels', 'passwords', 'settings', 'newDb', 'palette', 'importMobaFull', 'importDBeaver']) { await ACTIONS[a](); await sleep(150); if (!$('#modals .modal')) throw new Error(a); $$('#modals .back').forEach(b => b.remove()); }
    return true;
  });
  await check('dbeaver scan + preview (real workspace, counts only)', async () => {
    const found = await api.call('dbeaver:scan');
    r.dbeaverFound = found.length;
    if (!found.length) return true; // nothing to import on this PC; not a failure
    const p = await api.call('dbeaver:preview', found[0].dir);
    r.dbeaverStats = p.stats; // counts only, no secret values
    return p.stats.total >= 0;
  });
  const footBtn = label => [...$$('#modals .foot button')].find(b => b.textContent === label);
  const wizard = async (open, previewLabel) => {
    await open(); await sleep(300);
    footBtn(previewLabel).click();
    if (!(await until(() => footBtn('Import selected'), 20000))) throw new Error('no preview');
    footBtn('Import selected').click();
    if (!(await until(() => !$('#modals .modal'), 15000))) throw new Error('import did not finish');
  };
  await check('dbeaver import: scripts linked as text, re-import makes no duplicates', async () => {
    if (!(await api.call('dbeaver:scan')).length) return true;
    const count = () => [V.dbs.length, V.dbs.reduce((a, d) => a + (d.scripts || []).length, 0), V.sessions.length];
    await wizard(importDBeaver, 'Preview'); const c1 = count();
    await wizard(importDBeaver, 'Preview'); const c2 = count();
    r.dbeaverImport = { connections: c1[0], scripts: c1[1], afterReimport: c2 };
    if (c1.join() !== c2.join()) throw new Error(`duplicates on re-import ${c1} -> ${c2}`);
    const d = V.dbs.find(x => (x.scripts || []).length);
    if (d) {
      const s = d.scripts[0];
      if (typeof s.sql !== 'string') throw new Error('script sql is not text');
      // open the script on a throwaway SQLite copy of the connection: never connect to the user's real servers
      openDb({ ...d, id: uid(), engine: 'sqlite', file: tmp + '\\script-check.db', password: '' }, undefined, s); await sleep(700);
      const t = tabs.find(x => x.script === s);
      if (!t || t.cm.getValue() !== s.sql) throw new Error('script did not load into the SQL editor');
      await closeTab(t, true);
    }
    if (r.errors.some(e => /iter/.test(e))) throw new Error(r.errors.find(e => /iter/.test(e)));
    return true;
  });
  await check('db panel: connected / not connected sections + scripts under connections', async () => {
    sideMode = 'db'; renderSide();
    const txt = $('#sidebody').textContent;
    return !V.dbs.length || (/Not connected/.test(txt) && (!V.dbs.some(d => (d.scripts || []).length) || $$('#sidebody .script').length > 0));
  });
  await check('moba import twice: no duplicates, no "[credential]" usernames', async () => {
    const s = await api.call('moba:scan'); if (!s.iniPath && !s.hasRegistry) return true;
    const count = () => [V.sessions.length, V.credentials.length, V.macros.length];
    await wizard(importMobaFull, 'Scan & preview'); const c1 = count();
    await wizard(importMobaFull, 'Scan & preview'); const c2 = count();
    r.mobaImport = { sessions: c1[0], credentials: c1[1], macros: c1[2], afterReimport: c2 };
    if (c1.join() !== c2.join()) throw new Error(`duplicates on re-import ${c1} -> ${c2}`);
    const bad = V.sessions.filter(x => /^\[.*\]$/.test(x.username || ''));
    if (bad.length) throw new Error(`${bad.length} session(s) still show a [credential] as username`);
    r.mobaImport.linkedToCredential = V.sessions.filter(x => x.credentialId).length;
    return true;
  });
  await check('moba scan (local)', async () => { const s = await api.call('moba:scan'); r.mobaScan = { ini: !!s.iniPath, reg: s.hasRegistry }; return true; });
  await check('editor opens sql/js/path-named files (doc.iter repro)', async () => {
    for (const t of [{ title: 'q.sql', text: 'select 1' }, { title: 'Scripts/Script-1.sql', text: 'select * from t;' }, { title: 'a.js', text: 'const x=1' }, { title: 'notes', text: 'plain' }, { title: 'x.py', text: 'print(1)' }, { title: 'd.json', text: '{}' }, { title: 'r.md', text: '# h' }, { title: 'c.yaml', text: 'a: 1' }, { title: 's.sh', text: 'echo hi' }, { title: 'p.php', text: '<?php' }]) {
      const ed = openEditor(t);
      await sleep(250);
      if (ed.cm.getValue() !== t.text) throw new Error('value mismatch ' + t.title);
      await closeTab(ed, true);
    }
    return true;
  });
  await check('MobaXterm export files: passwords .txt + macros, linking, playback, no duplicates', async () => {
    const pwFile = tmp + '\\passwords.txt', macFile = tmp + '\\mxt.macros';
    await api.call('fs', { local: true }, 'write', pwFile, 'lab UI1(alice) = pw1=x\r\nplain(bob) = pw2\r\n');
    await api.call('fs', { local: true }, 'write', macFile, '[Macros]\r\nlogin=12:0:0:secretpw|258:13:1835009:RETURN|0:0:0:SLEEPEQUAL100|\r\ngrep=12:4:0:ps PIIPE grep x|258:13:1835009:RETURN|\r\n[MacrosHotkeys]\r\nlogin=0\r\n');
    const lab = { id: uid(), type: 'ssh', name: 'lab', host: '10.9.9.9', port: 22, username: '[lab UI1]' };
    V.sessions.push(lab); await save('sessions');
    const run = async () => { await importMobaFiles([pwFile, macFile]); await sleep(200); footBtn('Import selected').click(); await until(() => !$('#modals .modal')); };
    await run(); const c1 = [V.credentials.length, V.macros.length];
    await run(); const c2 = [V.credentials.length, V.macros.length];
    const cred = V.credentials.find(c => c.name === 'lab UI1');
    const grep = V.macros.find(m => m.name === 'grep'), login = V.macros.find(m => m.name === 'login');
    r.mobaFiles = { first: c1, second: c2, linked: lab.credentialId === (cred && cred.id), username: lab.username };
    if (c1.join() !== c2.join()) throw new Error(`duplicates ${c1} -> ${c2}`);
    if (!cred || cred.password !== 'pw1=x' || lab.username !== 'alice' || lab.credentialId !== cred.id) throw new Error('credential not imported/linked');
    if (grep.text !== 'ps | grep x\n' || login.text !== 'secretpw\n{WAIT:100}') throw new Error('macro text wrong');
    activate(sshTab); await playMacro(grep);
    return until(() => text(sshTab).includes('echo:ps | grep x'));
  });
  await check('tools ipc', async () => (await api.call('tool:pass', 30, true)).length === 30 && /^ssh-ed25519 /.test((await api.call('tool:keygen', 'ed25519', {})).public));
  await check('tunnel via ipc (socks)', async () => {
    const t = { id: uid(), name: 's', type: 'D', sessionId: fake.id, localPort: 0 }; V.tunnels.push(t); await save('tunnels');
    await api.call('tun:start', t); const on = (await api.call('tun:active')).includes(t.id); await api.call('tun:stop', t.id); return on;
  });
  await check('command palette', async () => { palette(); await sleep(100); const n = $$('.palette .pl .item').length; $$('#modals .back').forEach(b => b.remove()); return n > 5; });
  await check('tab context menu', async () => { await tabMenu({ clientX: 100, clientY: 100 }, sshTab); const ok = $$('.ctxmenu div').length >= 8; $$('.ctxmenu').forEach(m => m.remove()); return ok; });
  await check('local files panel', async () => {
    const cmdTab = tabs.find(t => t.session && t.session.type === 'shell'); activate(cmdTab); sideMode = 'sftp'; renderSide();
    return until(() => $$('#sidebody tbody tr').length > 0, 8000);
  });
  await check('auto session logging', async () => {
    V.settings.autoLog = true; V.settings.logDir = tmp; await save('settings');
    await connect({ id: uid(), type: 'shell', name: 'logme', command: 'cmd.exe' }); const lt = active;
    await until(() => lt.status === 'up'); input(lt, 'echo LOGGED_LINE\r'); await until(() => text(lt).includes('LOGGED_LINE\n'));
    await sleep(500); await closeTab(lt, true); await sleep(300);
    V.settings.autoLog = false; await save('settings');
    const f = (await api.call('fs', { local: true }, 'list', tmp)).find(x => x.name.startsWith('logme-'));
    return f && (await api.call('fs', { local: true }, 'read', tmp + '\\' + f.name)).includes('LOGGED_LINE');
  });
  if (wslDistros.some(d => !/^docker-desktop/i.test(d))) {
    const distro = wslDistros.find(d => !/^docker-desktop/i.test(d));
    let wt;
    await check(`wsl ${distro}: shell`, async () => {
      await connect({ id: uid(), type: 'wsl', name: 'WSL ' + distro, distro }); wt = active;
      await until(() => wt.status === 'up'); await sleep(1500);
      input(wt, 'echo WSL_$((40+2))\r');
      return until(() => text(wt).includes('WSL_42'), 60000);
    });
    await check(`wsl ${distro}: files panel`, async () => { activate(wt); sideMode = 'sftp'; renderSide(); return until(() => $('#sidebody .p') && /wsl/i.test($('#sidebody .p').value), 15000); });
  }
  // databases
  const dbText = t => $('.grid', t.pane).textContent;
  const sqliteDb = { id: uid(), name: 'smoke-sqlite', engine: 'sqlite', file: tmp + '\\smoke.db', env: 'dev' };
  V.dbs.push(sqliteDb); await save('dbs');
  let dt;
  await check('db sqlite: create + select', async () => {
    dt = await openDb(sqliteDb);
    await dt.run('create table fruits(id integer primary key, name text); insert into fruits(name) values (\'apple\'),(\'pear\'); select * from fruits order by id');
    return until(() => dbText(dt).includes('pear') && $$('tbody tr[data-ri]', $('.grid', dt.pane)).length === 2);
  });
  await check('db sqlite: schema tree + autocomplete tables', async () => until(() => $('.tree', dt.pane).textContent.includes('fruits') && dt.cm.getOption('hintOptions').tables.fruits));
  await check('db sqlite: export helpers via ipc', async () => (await api.call('db:classify', 'delete from fruits'))[0].danger.includes('WHERE'));
  await check('db: 200-row default, export first N / all re-runs the query', async () => {
    await api.call('db:query', dt.connId, 'create table big(n integer); with recursive c(n) as (select 0 union all select n + 1 from c where n < 249) insert into big select n from c');
    await dt.run('select n from big order by n');
    if (!(await until(() => dt.results.length && dt.results[dt.cur].rows.length === 200 && dt.results[dt.cur].truncated))) throw new Error('grid did not cap at 200');
    const r1 = await api.call('db:exportQuery', dt.connId, 'select n from big order by n', 2147483647, 'csv', 'big', 'sqlite');
    const r2 = await api.call('db:exportQuery', dt.connId, 'select n from big order by n', 220, 'json', 'big', 'sqlite');
    let refused = false; try { await api.call('db:exportQuery', dt.connId, 'delete from big', 10, 'csv', 'big', 'sqlite'); } catch (e) { refused = /read queries/.test(e.message); }
    r.export = { all: r1.rows, firstN: r2.rows, writeRefused: refused };
    return r1.rows === 250 && r2.rows === 220 && refused;
  });
  await check('db: DBeaver features — grid edit/add/delete + save, WHERE filter, explain, format, manual commit, properties', async () => {
    const grid = () => $('.grid', dt.pane), rowsNow = () => dt.results[dt.cur].rows.map(x => x[1]).join(',');
    const btn = sel => $(sel, dt.pane).click();
    const enter = async (ri, ci, text) => {
      const td = $(`tbody tr[data-ri="${ri}"]`, grid()).cells[ci + 1];
      td.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await sleep(30);
      const inp = $('td.ed input', grid()); if (!inp) throw new Error('no inline editor');
      inp.value = text; inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(30);
    };
    await dt.run(await api.call('db:selectSql', 'sqlite', '', 'fruits', 200), { table: 'fruits', schema: '' });
    if (!(await until(() => dt.results[0] && dt.results[0].editable === true))) throw new Error('fruits not editable: ' + dt.results[0].noEditWhy);
    await enter(0, 1, 'banana');                                                   // edit apple -> banana
    $('tbody tr[data-ri="1"] td.rn', grid()).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); window.dispatchEvent(new MouseEvent('mouseup')); // select row 2 (pear)
    btn('[data-x="delrow"]');
    btn('[data-x="addrow"]'); await sleep(30);
    $('td.ed input', grid()).dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true })); await sleep(30); // id: keep default, move to name
    const inp = $('td.ed input', grid()); inp.value = 'kiwi'; inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await sleep(30);
    const pending = $('.rstatus', dt.pane).textContent;
    btn('[data-x="saveedits"]');
    if (!(await until(() => rowsNow() === 'banana,kiwi'))) throw new Error(`after save: ${rowsNow()} (${pending})`);
    $('.wfilter', dt.pane).value = "name = 'kiwi'"; $('.wfilter', dt.pane).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    if (!(await until(() => rowsNow() === 'kiwi'))) throw new Error('WHERE filter: ' + rowsNow());
    dt.cm.setValue('select * from fruits where id = 1'); dt.cm.setCursor(0, 3); btn('[data-a="explain"]');
    if (!(await until(() => dt.results[0] && dt.results[0].command === 'EXPLAIN'))) throw new Error('no plan');
    dt.cm.setValue('select a,b from t where x=1'); btn('[data-a="format"]');
    if (!(await until(() => /^SELECT\n/.test(dt.cm.getValue())))) throw new Error('format: ' + dt.cm.getValue());
    btn('[data-a="tx"]'); if (!(await until(() => dt.tx.manual))) throw new Error('manual mode');
    await dt.run('delete from fruits where name = \'kiwi\'');
    if (!(await until(() => dt.tx.pending === 1 && /pending/.test($('[data-a="tx"]', dt.pane).textContent)))) throw new Error('pending count');
    btn('[data-a="rollback"]'); await until(() => !dt.tx.pending);
    btn('[data-a="tx"]'); await until(() => !dt.tx.manual);
    const [n] = await api.call('db:query', dt.connId, 'select count(*) from fruits');
    if (n.rows[0][0] !== 2) throw new Error('rollback did not restore: ' + n.rows[0][0]);
    const k = await api.call('db:keys', dt.connId, '', 'fruits');
    r.dbeaver = { saved: 'banana,kiwi', pk: k.pk, pendingStatus: pending.replace(/\s+/g, ' ').slice(0, 120) };
    await dt.run('select * from fruits order by id'); await until(() => $('tbody td:not(.rn)', grid()));
    return k.pk[0] === 'id';
  });
  await check('db: objects tree, FK navigation, ER diagram, compare/sync, result tabs + pin, ${vars}, value editor, split view', async () => {
    const grid = () => $('.grid', dt.pane), btn = sel => $(sel, dt.pane).click(), menuItem = async (el, text) => {
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 60, clientY: 60 })); await sleep(50);
      const it = $$('.ctxmenu div').find(x => x.textContent.includes(text)); if (!it) { $$('.ctxmenu').forEach(m => m.remove()); throw new Error(`no menu item "${text}"`); }
      it.click(); await sleep(50);
    };
    await dt.run("create table owners(id integer primary key, name text); insert into owners values (7, 'zoe'); create table pets(id integer primary key, owner_id int references owners(id), info text); insert into pets values (1, 7, '{\"a\":1}'); create table pets_copy(id integer primary key, owner_id int, info text); insert into pets_copy values (1, 7, 'old'), (9, 7, 'gone'); create trigger pets_tr after insert on pets begin select 1; end;");
    if (!(await until(() => $$('.tree .obj', dt.pane).some(o => /pets_tr/.test(o.textContent))))) throw new Error('trigger not listed in the tree');
    // FK navigation: pets.owner_id -> owners row opens in a new result tab
    const pets = () => $$('.tree summary[data-i]', dt.pane).find(x => /\bpets\b/.test(x.textContent) && !/copy/.test(x.textContent));
    pets().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    if (!(await until(() => dt.results.at(-1) && dt.results.at(-1).table === 'pets' && dt.results.at(-1).fks))) throw new Error('pets data / keys not loaded');
    const before = dt.results.length;
    await menuItem($('tbody tr[data-ri="0"]', grid()).cells[2], 'Open referenced row in owners');
    if (!(await until(() => dt.results.length === before + 1 && dt.results.at(-1).table === 'owners' && dt.results.at(-1).rows[0][1] === 'zoe'))) throw new Error('FK navigation failed');
    // pin + run replaces only unpinned results; run in new tab appends
    dt.results.at(-1).pinned = true;
    dt.cm.setValue('select 1 as one'); dt.cm.setCursor(0, 2); btn('[data-a="run"]');
    if (!(await until(() => dt.results.length === 2 && dt.results[0].pinned))) throw new Error('pin: ' + dt.results.length);
    btn('[data-a="runnew"]'); if (!(await until(() => dt.results.length === 3))) throw new Error('run in new tab');
    // ${variables}
    dt.cm.setValue('select name from owners where id = ${owner}'); dt.cm.setCursor(0, 5); btn('[data-a="run"]');
    if (!(await until(() => $('#modals input[data-k="owner"]')))) throw new Error('no variable prompt; modals: ' + $$('#modals .modal').map(m => m.textContent.slice(0, 120)).join(' | ') + ' grid: ' + $('.grid', dt.pane).textContent.slice(0, 200) + ' results: ' + dt.results.length);
    $('#modals input[data-k="owner"]').value = '7'; $$('#modals .foot button').find(b => b.textContent === 'Run').click();
    if (!(await until(() => dt.results.at(-1).rows[0] && dt.results.at(-1).rows[0][0] === 'zoe'))) throw new Error('variable substitution');
    // large value editor on a JSON cell, saved through the grid
    pets().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await until(() => dt.results.at(-1).table === 'pets' && dt.results.at(-1).editable);
    await menuItem($('tbody tr[data-ri="0"]', grid()).cells[3], 'large editor');
    const ta = await until(() => $('#modals textarea')) && $('#modals textarea');
    ta.value = '{"a": 2, "b": [1]}'; $$('#modals .foot button').find(b => b.textContent === 'Apply').click(); await sleep(50);
    btn('[data-x="saveedits"]');
    if (!(await until(() => dt.results.at(-1).rows[0] && dt.results.at(-1).rows[0][2] === '{"a":2,"b":[1]}'))) throw new Error('JSON edit: ' + dt.results.at(-1).rows[0]);
    // ER diagram for pets: pets + owners boxes and one relation
    await menuItem(pets(), 'ER diagram');
    if (!(await until(() => $('#modals svg g[data-b]') && $$('#modals .modal h2').some(x => /1 relation/.test(x.textContent))))) throw new Error('ER diagram: ' + $$('#modals .modal h2').map(x => x.textContent).join(' | ') + ' boxes=' + $$('#modals svg g[data-b]').length);
    const erBoxes = $$('#modals svg g[data-b]').length; $$('#modals .back').forEach(b => b.remove());
    // compare pets -> pets_copy on the same connection, then open the sync SQL in the editor
    await menuItem(pets(), 'Compare / sync');
    await until(() => $('#modals input[data-k="table"]'));
    $('#modals input[data-k="table"]').value = 'pets_copy'; $$('#modals .foot button').find(b => b.textContent === 'Compare').click();
    if (!(await until(() => $$('#modals .foot button').some(b => /sync statement/.test(b.textContent))))) throw new Error('compare result; toasts: ' + $$('#toasts .toast').map(t => t.textContent).join(' | ') + ' modals: ' + $$('#modals .modal').map(m => m.textContent.slice(0, 150)).join(' | '));
    $$('#modals .foot button').find(b => /sync statement/.test(b.textContent)).click(); await sleep(100);
    const syncSql = dt.cm.getValue();
    if (!/DELETE FROM "pets_copy" WHERE "id" = 9/.test(syncSql) || !/UPDATE "pets_copy"/.test(syncSql)) throw new Error('sync SQL: ' + syncSql.slice(0, 200));
    // split view with another tab
    const other = tabs.find(x => x !== dt);
    if (other) { setSplit(dt, other); await sleep(100); if (!$('#panes').classList.contains('split') || !other.pane.classList.contains('inSplit')) throw new Error('split view'); unsplit(); activate(dt); }
    r.dbeaverMore = { erBoxes, syncLines: syncSql.split('\n').length };
    await dt.run('select * from fruits order by id'); await until(() => $('tbody td:not(.rn)', grid()));
    return erBoxes === 2;
  });
  await check('ssh keys: key kept in the vault logs in after the file is gone; install public key (ssh-copy-id)', async () => {
    if (!keyFile) return true;
    const s = { id: uid(), type: 'ssh', name: 'smoke-key', host: '127.0.0.1', port, username: 'u', keyFile, keyInVault: true };
    await keyToVault(s);
    if (!/PRIVATE KEY/.test(s.keyData || '')) throw new Error('key not copied into the vault');
    s.keyFile = tmp + '\\gone\\id_smoke'; // the file "moved": the vault copy must be used
    V.sessions.push(s); await save('sessions');
    connect(s);
    const kt = await until(() => tabs.find(x => x.session === s && x.status === 'up'), 15000);
    if (!kt) throw new Error('could not log in with the key from the vault');
    await closeTab(tabs.find(x => x.session === s), true);
    const pub = await api.call('key:public', s.id);
    let installed = 'skipped';
    if (canInstallKey) {
      installed = await api.call('ssh:installKey', s.id, {});
      const again = await api.call('ssh:installKey', s.id, {});
      if (installed !== 'added' || again !== 'already') throw new Error(`install: ${installed} then ${again}`);
    }
    r.sshKeys = { pubType: pub.split(' ')[0], installed };
    V.sessions = V.sessions.filter(x => x !== s); await save('sessions');
    return pub.startsWith('ssh-ed25519 ');
  });
  await check('db: ODBC database type from the driver manager (Windows CSV driver)', async () => {
    const drv = (await api.call('odbc:drivers')).find(x => /text driver/i.test(x));
    if (!drv) return true;
    const dir = tmp + '\\odbc';
    await api.call('fs', { local: true }, 'mkdir', dir);
    await api.call('fs', { local: true }, 'write', dir + '\\people.csv', 'id,name\n1,ann\n2,bob\n3,cy\n');
    // add the type through the driver manager UI, leaving the template empty so the preset fills it
    driverManager(); await until(() => $$('#modals .foot button').some(b => /Add database type/.test(b.textContent)));
    $$('#modals .foot button').find(b => /Add database type/.test(b.textContent)).click();
    await until(() => $('#modals [data-k="driver"]'));
    $('#modals [data-k="name"]').value = 'CSV files'; $('#modals [data-k="driver"]').value = drv;
    $$('#modals .foot button').find(b => b.textContent === 'Save').click();
    await until(() => (V.dbDrivers || []).some(t => t.name === 'CSV files'));
    const type = V.dbDrivers.find(t => t.name === 'CSV files');
    $$('#modals .back').forEach(b => b.remove());
    if (!type || !/Extensions=/.test(type.template) || type.flavor !== 'mssql') throw new Error('preset not applied: ' + JSON.stringify(type));
    const conn = { id: uid(), name: 'smoke-csv', engine: 'odbc', driverId: type.id, file: dir, env: 'dev' };
    V.dbs.push(conn); await save('dbs');
    const ot = await openDb(conn);
    if (!(await until(() => /people\.csv/.test($('.tree', ot.pane).textContent), 15000))) throw new Error('csv table not in the tree: ' + $('.tree', ot.pane).textContent);
    $$('.tree summary[data-i]', ot.pane).find(x => /people/.test(x.textContent)).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    if (!(await until(() => ot.results[0] && ot.results[0].rows.length === 3))) throw new Error('csv data view: ' + JSON.stringify(ot.results[0] && ot.results[0].sql));
    r.odbc = { driver: drv, sql: ot.results[0].sql, rows: ot.results[0].rows.length, readOnlyBecause: ot.results[0].noEditWhy || '' };
    await closeTab(ot, true);
    return true;
  });
  await check('db: Run executes only the statement under the cursor (no blank lines between statements)', async () => {
    dt.cm.setValue("select 'first' as q;\nselect 'second' as q;\nselect 'third' as q;\nselect 'fourth' as q;");
    dt.cm.setCursor(1, 5); $('[data-a="run"]', dt.pane).click();
    if (!(await until(() => dt.results.length && dt.results.at(-1).sql === "select 'second' as q"))) throw new Error('ran: ' + dt.results.map(x => x.sql).join(' | '));
    const ran = dt.results.filter(x => !x.pinned).map(x => x.rows[0] && x.rows[0][0]);
    return ran.length === 1 && ran[0] === 'second';
  });
  await check('db: word wrap in the SQL editor (Alt+Z) and in result cells, remembered', async () => {
    const sq = $('.sqlwrapchk', dt.pane), cw = $('.cellwrapchk', dt.pane);
    sq.checked = true; sq.dispatchEvent(new Event('change'));
    cw.checked = true; cw.dispatchEvent(new Event('change'));
    await dt.run("select 'line one\nline two' as multi"); await until(() => $('tbody td:not(.rn)', $('.grid', dt.pane)));
    const td = $('tbody td:not(.rn)', $('.grid', dt.pane));
    const ok = dt.cm.getOption('lineWrapping') && $('.grid', dt.pane).classList.contains('wrap') && getComputedStyle(td).whiteSpace === 'pre-wrap' && localStorage['mxc.sqlWrap'] === '1';
    sq.checked = false; sq.dispatchEvent(new Event('change')); cw.checked = false; cw.dispatchEvent(new Event('change'));
    await dt.run('select * from fruits order by id'); await until(() => $('tbody td:not(.rn)', $('.grid', dt.pane)));
    return ok && !dt.cm.getOption('lineWrapping') && localStorage['mxc.cellWrap'] === '0';
  });
  await check('db grid: mouse + keyboard selection (cells, drag, Shift/Ctrl, rows, columns), copy, virtual rows, binary text, export formats', async () => {
    activate(dt); await sleep(100);
    const grid = $('.grid', dt.pane), td = (ri, ci) => $(`tbody tr[data-ri="${ri}"]`, grid).cells[ci + 1];
    const down = (el, o = {}) => { const b = el.getBoundingClientRect(); el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: b.left + 4, clientY: b.top + 4, ...o })); window.dispatchEvent(new MouseEvent('mouseup')); };
    const key = (k, o = {}) => grid.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
    let clip = null; const realWrite = navigator.clipboard.writeText; navigator.clipboard.writeText = t => { clip = t; return Promise.resolve(); }; // the smoke window may not have focus
    const copied = async (headers = false) => { clip = null; key('c', { ctrlKey: true, shiftKey: headers }); await sleep(30); return clip; };
    const want = async (what, got, exp) => { if (got !== exp) throw new Error(`${what}: ${JSON.stringify(got)} expected ${JSON.stringify(exp)}`); };
    await dt.run("select 1 as a, 'x' as b, 10 as c union all select 2, 'y', 20 union all select 3, 'z', 30");
    await until(() => $('tbody tr[data-ri="2"]', grid));
    down(td(0, 0)); down(td(1, 1), { shiftKey: true });
    await want('Shift+click block', await copied(), '1\tx\r\n2\ty');
    down(td(0, 0), { buttons: 1 }); { const b = td(2, 2).getBoundingClientRect(); td(0, 0).dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: b.left, clientY: b.top })); window.dispatchEvent(new MouseEvent('mousemove', { clientX: b.left + 4, clientY: b.top + 4 })); window.dispatchEvent(new MouseEvent('mouseup')); }
    await want('drag-select with column names', await copied(true), 'a\tb\tc\r\n1\tx\t10\r\n2\ty\t20\r\n3\tz\t30');
    down($('th[data-c="0"]', grid)); down($('th[data-c="2"]', grid), { ctrlKey: true });
    await want('two columns (header click + Ctrl+click)', await copied(), '1\t10\r\n2\t20\r\n3\t30');
    if (!/sum 66 · avg 11/.test($('.selinfo', dt.pane).textContent)) throw new Error('selection sum: ' + $('.selinfo', dt.pane).textContent);
    down($('tr[data-ri="0"] td.rn', grid)); down($('tr[data-ri="2"] td.rn', grid), { shiftKey: true });
    await want('rows (row numbers + Shift)', await copied(), '1\tx\t10\r\n2\ty\t20\r\n3\tz\t30');
    down(td(0, 1)); down(td(2, 1), { ctrlKey: true });
    await want('Ctrl+click cells', await copied(), 'x\r\nz');
    down(td(0, 0)); key('ArrowDown', { shiftKey: true }); key('ArrowRight', { shiftKey: true });
    await want('Shift+arrows', await copied(), '1\tx\r\n2\ty');
    key('a', { ctrlKey: true }); await want('Ctrl+A', (await copied()).split('\r\n').length, 3);
    // virtual rows: 5000 rows, only the visible part is in the page; Ctrl+End reaches the last row
    await dt.run('with recursive c(n) as (select 1 union all select n + 1 from c where n < 5000) select n, n * 2 as d from c', { limit: 5000 });
    await until(() => dt.results.at(-1).rows.length === 5000 && $('tbody tr[data-ri]', grid));
    const rendered = $$('tbody tr[data-ri]', grid).length;
    down(td(0, 0)); key('End', { ctrlKey: true }); await sleep(100);
    const last = $('tbody tr[data-ri="4999"]', grid);
    if (rendered > 300 || !last || last.cells[2].textContent !== '10000' || !last.cells[2].classList.contains('cf')) throw new Error(`virtual rows: ${rendered} rendered, last=${last && last.textContent}`);
    // binary values: printable UTF-8 shown as text, other bytes as hex
    await dt.run("select X'68c3a96c6c6f' as t, X'00ff' as h");
    await until(() => dt.results.at(-1).rows[0]);
    await want('binary', dt.results.at(-1).rows[0].join('|'), 'héllo|0x00ff');
    // every export format, all rows re-run from the server
    const out = {};
    for (const fmt of (await api.call('db:exportFormats')).map(x => x.id)) {
      const res = await api.call('db:exportQuery', dt.connId, 'select n, \'v\' || n as s from big order by n', 2147483647, fmt, 'big', 'sqlite', { nullText: 'NULL' });
      const text = await api.call('fs', { local: true }, 'read', res.file);
      out[fmt] = text.length;
      if (res.rows !== 250 || (fmt === 'xlsx' ? !text.startsWith('PK') : !text.includes('v249'))) throw new Error(`export ${fmt}: ${res.rows} rows, ${text.slice(0, 80)}`);
    }
    navigator.clipboard.writeText = realWrite;
    r.gridSelection = { rendered, exports: out };
    await dt.run('select * from fruits order by id'); await until(() => $('tbody td:not(.rn)', grid));
    return true;
  });
  await check('navigator: tree and sidebar folders start collapsed; F4 on a name opens it', async () => {
    activate(dt);
    if ($$('.tree details[open]', dt.pane).length) throw new Error('tree has open folders: ' + $$('.tree details[open] > summary', dt.pane).map(x => x.textContent.trim()).join(', '));
    if (!$$('.tree details.folder > summary', dt.pane).some(x => /^Tables/.test(x.textContent)) || !$$('.tree details.folder > summary', dt.pane).some(x => /^Triggers/.test(x.textContent))) throw new Error('no Tables / Triggers folders');
    dt.cm.setValue('select * from fruits'); dt.cm.setCursor(0, 17);
    dt.cm.triggerOnKeyDown({ type: 'keydown', keyCode: 115, preventDefault() {}, stopPropagation() {} }); // F4
    if (!(await until(() => $$('#modals .modal h2').some(x => /Properties — fruits/.test(x.textContent))))) throw new Error('F4 did not open the table');
    $$('#modals .back').forEach(b => b.remove());
    const opened = $$('.tree details[open] > summary', dt.pane).map(x => x.textContent.trim().split(' ')[0]);
    if (!opened.includes('Tables')) throw new Error('F4 did not reveal the table: ' + opened);
    const s = { id: uid(), type: 'ssh', name: 'fold-test', host: 'h', folder: 'smokefold/inner' }; V.sessions.push(s);
    sideMode = 'sessions'; renderSide();
    const fold = () => $('#sidebody details[data-fold="sess:/smokefold"]');
    if (!fold() || fold().open) throw new Error('session folder not collapsed');
    fold().open = true; await sleep(30); renderSide();
    const kept = fold().open;
    V.sessions = V.sessions.filter(x => x !== s); openFolders.delete('sess:/smokefold'); renderSide();
    return kept;
  });
  await check('right-click menus (session, db, script, table, cell, files) + splitter drag', async () => {
    const menu = async (el, min) => { el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); await sleep(50); const n = $$('.ctxmenu div').length; $$('.ctxmenu').forEach(m => m.remove()); if (n < min) throw new Error(`menu on ${el.className || el.tagName} had ${n} items`); };
    sideMode = 'sessions'; renderSide(); await menu($('#sidebody .item[data-id]'), 8);
    sideMode = 'db'; dbExpanded.add(sqliteDb.id); sqliteDb.scripts = [{ id: uid(), name: 's.sql', sql: 'select 1' }]; renderSide();
    await menu($(`#sidebody details.dbconn[data-id="${sqliteDb.id}"] > summary`), 8);
    await menu($(`#sidebody details.dbconn[data-id="${sqliteDb.id}"] .script`), 5);
    activate(dt); await menu($('.tree summary[data-i]', dt.pane), 8); await menu($('.grid tbody td:not(.rn)', dt.pane), 8);
    const before = $('.sqlwrap', dt.pane).offsetHeight, hs = $('.hsplit', dt.pane), y = hs.getBoundingClientRect().top;
    hs.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: y }));
    document.dispatchEvent(new MouseEvent('mousemove', { clientY: y + 60 })); document.dispatchEvent(new MouseEvent('mouseup', {}));
    const after = $('.sqlwrap', dt.pane).offsetHeight;
    r.splitter = { before, after };
    if (Math.abs(after - before - 60) > 2) throw new Error(`splitter moved ${after - before}px, expected 60`);
    return true;
  });
  await check('db read-only enforced in main', async () => {
    const ro = { ...sqliteDb, id: uid(), name: 'ro', readOnly: true }; V.dbs.push(ro); await save('dbs');
    const t = await openDb(ro);
    let refused = false; try { await api.call('db:query', t.connId, 'delete from fruits where id = 1'); } catch (e) { refused = /Read-only/.test(e.message); }
    const [c] = await api.call('db:query', t.connId, 'select count(*) from fruits');
    await closeTab(t, true);
    return refused && c.rows[0][0] === 2;
  });
  for (const cfg of dbs) {
    for (const via of ['direct', 'ssh']) {
      const d = { id: uid(), name: `${cfg.engine}-${via}`, env: 'dev', ...cfg, ...(via === 'ssh' ? { sshId: fake.id } : {}) };
      V.dbs.push(d); await save('dbs');
      await check(`db ${cfg.engine} (${via}): query + schema`, async () => {
        const t = await openDb(d);
        if (t.status !== 'up') throw new Error($('.tree', t.pane).textContent);
        await t.run("select 1 as one, 'x' as two" + (cfg.engine === 'oracle' ? ' from dual' : ''));
        const ok = await until(() => /one/i.test(dbText(t)) && dbText(t).includes('x')) && await until(() => !/Loading/.test($('.tree', t.pane).textContent));
        // navigator folders (collapsed) and grid selection + copy on a real server
        const folders = () => $$('.tree details.folder > summary', t.pane).map(x => x.textContent.trim().split(' (')[0]);
        if (cfg.expectFolders && !(await until(() => cfg.expectFolders.every(f => folders().includes(f))))) throw new Error('tree folders: ' + folders().join(', ')); // routines load just after the tables
        if ($$('.tree details[open]', t.pane).length) throw new Error('tree not collapsed');
        let clip = null; const realWrite = navigator.clipboard.writeText; navigator.clipboard.writeText = x => { clip = x; return Promise.resolve(); };
        const g = $('.grid', t.pane); g.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })); g.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, shiftKey: true, bubbles: true }));
        await sleep(30); navigator.clipboard.writeText = realWrite;
        if (!/^one\ttwo\r\n1\tx$/i.test(clip || '')) throw new Error('copy: ' + JSON.stringify(clip));
        await closeTab(t, true);
        return ok;
      });
    }
  }
  for (const [i, l] of live.entries()) {
    const s = { id: uid(), type: 'ssh', name: `live-${i}`, host: l.host, port: l.port, username: l.user, password: l.pass, x11: false, monitor: true };
    V.sessions.push(s);
    let t;
    await check(`live ${l.host}: shell`, async () => { await connect(s); t = active; return until(() => /[$#>]\s*$/m.test(text(t)), 25000); });
    await check(`live ${l.host}: uname`, async () => { input(t, 'uname -sr; echo __DONE__\r'); return until(() => /Linux|BSD|Darwin/.test(text(t)) && text(t).includes('__DONE__\n'), 15000); });
    await check(`live ${l.host}: sftp list home`, async () => (await api.call('fs', { conn: t.connId }, 'list', t.home)).length >= 0);
    await check(`live ${l.host}: monitor`, async () => { const m = await api.call('mon', t.connId); r[`mon-${l.host}`] = m; return m.cpu >= 0 && m.mem > 0; });
    await check(`live ${l.host}: highlight`, async () => { input(t, 'echo "error warning ok 10.1.2.3"\r'); return until(() => text(t).includes('10.1.2.3'), 8000); });
    r[`docker-${l.host}`] = await api.call('docker', t.connId, 'list').then(x => `${x.length} containers`, e => 'n/a: ' + e.message.slice(0, 80));
  }
  sideMode = live.length ? 'sftp' : 'db'; dbExpanded.add((V.dbs.find(x => (x.scripts || []).length) || {}).id); renderSide(); if (live.length) { activate(tabs.at(-1)); updateMonitor(true); await sleep(2500); }
  r.tabs = tabs.map(t => t.title); r.dom = $$('#tabs .tab').length;
  // last: wipe the smoke vault (it may now hold real imported passwords) and prove reset works
  await check('reset app deletes all data', async () => { await api.call('vault:reset'); return !(await api.call('vault:status')).exists; });
  r.ok = Object.values(r.checks).every(Boolean) && !r.errors.length;
  return r;
};
