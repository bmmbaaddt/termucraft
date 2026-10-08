const { app, BrowserWindow, ipcMain, dialog, shell: eshell, Menu, session: esession } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
const { StringDecoder } = require('string_decoder');
const pty = require('node-pty');
const { Vault } = require('./core/vault');
const ssh = require('./core/ssh');
const { telnet } = require('./core/telnet');
const servers = require('./core/servers');
const tools = require('./core/tools');
const { parseMobaIni } = require('./core/moba');
const db = require('./core/db');
const mobaImport = require('./core/moba-import');
const mobaFiles = require('./core/moba-files');
const dbeaver = require('./core/dbeaver');

const SMOKE = process.argv.includes('--smoke');
if (SMOKE) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mxc-smoke-')));

let win;
const vaultFile = path.join(app.getPath('userData'), 'vault.json');
// The app was called MobaCraft before: carry the vault over once (a copy; the old file is left as a backup).
// Only for the normal data folder: a custom --user-data-dir (tests, demos) must never receive the real vault.
const defaultData = path.resolve(app.getPath('userData')) === path.resolve(app.getPath('appData'), app.getName());
if (!SMOKE && defaultData && !fs.existsSync(vaultFile)) {
  const old = path.join(app.getPath('appData'), 'MobaCraft', 'vault.json');
  if (fs.existsSync(old)) { fs.mkdirSync(path.dirname(vaultFile), { recursive: true }); fs.copyFileSync(old, vaultFile); }
}
const vault = new Vault(vaultFile);
const conns = new Map(); let nextId = 1;
const tunnels = new Map();
const running = {}; // embedded servers
const send = (ch, ...a) => win && !win.isDestroyed() && win.webContents.send(ch, ...a);
// only our own page (file://) may call into the main process
const handle = (name, fn) => ipcMain.handle(name, (e, ...a) => {
  if (!e.senderFrame || !e.senderFrame.url.startsWith('file://')) throw new Error('Blocked IPC from ' + (e.senderFrame && e.senderFrame.url));
  return fn(...a);
});
const settings = () => (vault.data && vault.data.settings) || {};
const unlocked = () => { if (!vault.key) throw new Error('Vault locked'); };

// ---------- vault ----------
handle('vault:status', () => ({ exists: vault.exists(), unlocked: !!vault.key, smoke: SMOKE }));
handle('vault:create', pw => { if (vault.exists()) throw new Error('Vault exists'); vault.create(pw); return vault.data; });
handle('vault:unlock', pw => { vault.unlock(pw); return vault.data; });
handle('vault:get', () => { unlocked(); return vault.data; });
// partial save: top-level keys merge, so main-owned keys (knownHosts) are not clobbered by a stale renderer copy
handle('vault:save', part => { unlocked(); vault.save({ ...vault.data, ...part }); return true; });
handle('vault:lock', () => {
  for (const c of conns.values()) try { c.close(); } catch {}
  for (const t of tunnels.values()) try { t.h.close(); t.c.end(); } catch {}
  for (const d of dbs.values()) try { d.conn.close(); d.tunnel && d.tunnel.close(); } catch {}
  for (const id of [...logs.keys()]) stopLog(id);
  conns.clear(); tunnels.clear(); dbs.clear();
  vault.key = null; vault.data = null;
});
// Delete ALL app data (vault with sessions, passwords, macros, DB connections). Works locked too (forgot password).
handle('vault:reset', () => {
  for (const c of conns.values()) try { c.close(); } catch {}
  for (const t of tunnels.values()) try { t.h.close(); t.c.end(); } catch {}
  for (const d of dbs.values()) try { d.conn.close(); d.tunnel && d.tunnel.close(); } catch {}
  for (const id of [...logs.keys()]) stopLog(id);
  conns.clear(); tunnels.clear(); dbs.clear();
  for (const f of [vault.file, vault.file + '.tmp']) fs.rmSync(f, { force: true });
  vault.key = null; vault.data = null;
  return true;
});
handle('vault:password', pw => { unlocked(); vault.changePassword(pw); return true; });
handle('vault:export', async () => {
  const r = await dialog.showSaveDialog(win, { defaultPath: 'termucraft-vault.json' });
  if (!r.canceled) fs.copyFileSync(vault.file, r.filePath);
  return !r.canceled;
});

async function verifyHost(hostPort, fp) {
  if (SMOKE) return true;
  const known = vault.data.knownHosts[hostPort];
  if (known === fp) return true;
  const { response } = await dialog.showMessageBox(win, known ? {
    type: 'warning', title: 'HOST KEY CHANGED', buttons: ['Cancel', 'Accept new key'], defaultId: 0, cancelId: 0,
    message: `WARNING: the host key of ${hostPort} has changed!`,
    detail: `Old: ${known}\nNew: ${fp}\n\nThis could be a man-in-the-middle attack. Only accept if you know the server was reinstalled.`,
  } : {
    type: 'question', title: 'Unknown host', buttons: ['Accept', 'Cancel'], defaultId: 0, cancelId: 1,
    message: `First connection to ${hostPort}`, detail: `Host key fingerprint:\n${fp}\n\nTrust this host and remember its key?`,
  });
  if (response !== (known ? 1 : 0)) return false;
  vault.data.knownHosts[hostPort] = fp; vault.save();
  return true;
}

// session -> ssh2 connect options (credential + jump host resolved from the vault)
function resolveSsh(s, extra = {}, depth = 0) {
  const cred = vault.data.credentials.find(c => c.id === s.credentialId) || {};
  const r = {
    host: s.host, port: s.port || 22, username: s.username || cred.username,
    password: extra.password || s.password || cred.password,
    keyFile: s.keyFile || cred.keyFile, keyData: s.keyData || cred.keyData, passphrase: s.passphrase || cred.passphrase, agent: s.agent,
  };
  const j = s.jumpId && vault.data.sessions.find(x => x.id === s.jumpId);
  if (j && depth < 5) r.jump = resolveSsh(j, {}, depth + 1);
  else if (s.jumpHost) r.jump = { host: s.jumpHost, port: s.jumpPort || 22, username: s.jumpUser || r.username, password: r.password, keyFile: r.keyFile, keyData: r.keyData, passphrase: r.passphrase, agent: s.agent };
  return r;
}
const sshConnect = (s, extra) => ssh.connect(resolveSsh(s, extra), { verifyHost, x11Display: +settings().x11Display || 0 });

// "C:\Program Files\x.exe" -a b  ->  [file, args]
const splitCmd = c => (c.match(/"[^"]*"|\S+/g) || []).map(x => x.replace(/^"|"$/g, ''));

// ---------- terminal sessions ----------
handle('sess:open', async (s, { cols = 80, rows = 24, password } = {}) => {
  unlocked();
  if (settings().disabledTypes && settings().disabledTypes.includes(s.type)) throw new Error(`${s.type} sessions are disabled in Settings`);
  const id = nextId++;
  const dec = new StringDecoder('utf8');
  const out = d => {
    const t = typeof d === 'string' ? d : dec.write(d);
    const log = logs.get(id); if (log) log.write(stripAnsi(t));
    send('data', id, t);
  };
  const exit = () => { stopLog(id); if (conns.delete(id)) send('exit', id); };
  if (settings().autoLog && settings().logDir) startLog(id, path.join(settings().logDir, `${safeName(s.name || s.type)}-${stamp()}.log`));

  if (s.type === 'ssh' || s.type === 'sftp') {
    const c = await sshConnect(s, { password });
    c.on('close', exit);
    c.on('error', e => out(`\r\n\x1b[31m[${e.message}]\x1b[0m\r\n`));
    const conn = { client: c, close: () => c.end(), write() {}, resize() {} };
    if (s.type === 'ssh') {
      const st = await ssh.shell(c, { cols, rows, x11: !!s.x11 });
      st.on('data', out); st.stderr.on('data', out);
      st.on('close', () => c.end());
      Object.assign(conn, { write: d => st.write(d), resize: (co, ro) => st.setWindow(ro, co, 0, 0) });
      if (s.startDir) st.write(`cd '${s.startDir.replace(/'/g, `'\\''`)}'\n`);
      if (s.command) st.write(s.command + '\n');
    }
    conns.set(id, conn);
    return { id, home: await ssh.sftpOp(c, 'realpath', '.').catch(() => '/') };
  }

  if (s.type === 'telnet') {
    conns.set(id, telnet(s.host, s.port || 23, { cols, rows }, out, exit));
    return { id };
  }

  if (s.type === 'serial') {
    const { SerialPort } = require('serialport');
    const port = new SerialPort({ path: s.port, baudRate: +s.baud || 9600, dataBits: +s.dataBits || 8, parity: s.parity || 'none', stopBits: +s.stopBits || 1 });
    await new Promise((ok, ko) => port.once('open', ok).once('error', ko));
    port.on('data', out); port.on('close', exit);
    port.on('error', e => out(`\r\n[serial error: ${e.message}]\r\n`));
    conns.set(id, { write: d => port.write(d), resize() {}, close: () => port.close() });
    return { id };
  }

  if (s.type === 'shell' || s.type === 'wsl') {
    let file, args;
    if (s.type === 'wsl') {
      file = 'wsl.exe'; args = [];
      if (s.distro) args.push('-d', s.distro);
      if (s.user) args.push('-u', s.user);
      args.push('--cd', s.startDir || '~');
    } else [file, ...args] = splitCmd(s.command || settings().defaultShell || 'bash');
    let env = process.env;
    if (file === 'bash') [file, args, env] = localBash();
    const p = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: s.cwd || os.homedir(), env });
    p.onData(out); p.onExit(exit);
    conns.set(id, { write: d => p.write(d), resize: (co, ro) => p.resize(co, ro), close: () => p.kill() });
    return { id, home: s.type === 'wsl' ? `\\\\wsl.localhost\\${s.distro || defaultDistro()}\\home` : (s.cwd || os.homedir()) };
  }

  if (s.type === 'rdp') return launchRdp(s);
  if (s.type === 'vnc') return launchVnc(s);
  if (s.type === 'browser') { await eshell.openExternal(s.url); return { external: true }; }
  throw new Error('Unknown session type ' + s.type);
});

handle('sess:write', (id, d) => { const c = conns.get(id); c && c.write(d); });
handle('sess:resize', (id, cols, rows) => { const c = conns.get(id); c && c.resize(cols, rows); });
handle('sess:close', id => { stopLog(id); const c = conns.get(id); if (c) { conns.delete(id); try { c.close(); } catch {} } });

// ---------- session logging ----------
const logs = new Map();
const stripAnsi = t => t.replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r(?=\n)/g, '');
const safeName = n => String(n).replace(/[^\w.@-]+/g, '_').slice(0, 60);
const stamp = () => new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
function startLog(id, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  logs.set(id, fs.createWriteStream(file, { flags: 'a' }));
  return file;
}
function stopLog(id) { const l = logs.get(id); if (l) { l.end(); logs.delete(id); } }
handle('log:start', async (id, name) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(settings().logDir || app.getPath('documents'), `${safeName(name)}-${stamp()}.log`) });
  return r.canceled ? null : startLog(id, r.filePath);
});
handle('log:stop', id => stopLog(id));
handle('log:active', id => logs.has(id));

// ---------- WSL ----------
function wslList() {
  const r = cp.spawnSync('wsl.exe', ['-l', '-q'], { windowsHide: true, timeout: 10000 });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout.toString('utf16le').split(/\r?\n/).map(x => x.replace(/\0/g, '').trim()).filter(Boolean);
}
const defaultDistro = () => wslList()[0] || 'Ubuntu';
handle('wsl:list', wslList);
handle('serial:list', async () => (await require('serialport').SerialPort.list()).map(p => p.path));

function launchRdp(s) {
  const cred = vault.data.credentials.find(c => c.id === s.credentialId) || {};
  const user = s.username || cred.username || '', pass = s.password || cred.password;
  const host = s.host + (s.port && +s.port !== 3389 ? ':' + s.port : '');
  const lines = [
    `full address:s:${host}`, `username:s:${user}`, `screen mode id:i:${s.fullscreen ? 2 : 1}`,
    `desktopwidth:i:${s.width || 1600}`, `desktopheight:i:${s.height || 900}`, 'session bpp:i:32',
    `redirectclipboard:i:1`, `drivestoredirect:s:${s.drives ? '*' : ''}`, `administrative session:i:${s.admin ? 1 : 0}`,
    `audiomode:i:${s.audio ? 0 : 2}`, 'prompt for credentials:i:0', 'authentication level:i:2',
  ];
  const file = path.join(app.getPath('temp'), `termucraft-${Date.now()}.rdp`);
  fs.writeFileSync(file, lines.join('\r\n'));
  if (pass && user) {
    // stored in Windows Credential Manager for mstsc, removed again after logon window
    cp.spawnSync('cmdkey', [`/generic:TERMSRV/${s.host}`, `/user:${user}`, `/pass:${pass}`], { windowsHide: true });
    setTimeout(() => cp.spawn('cmdkey', [`/delete:TERMSRV/${s.host}`], { windowsHide: true }), 60000);
  }
  cp.spawn('mstsc.exe', [file], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => fs.rm(file, () => {}), 60000);
  return { external: true };
}

function findExe(cands) { return cands.find(p => p && fs.existsSync(p)); }

// "bash": a Linux-style local shell like MobaXterm's. Git Bash if installed, else WSL, else PowerShell.
function localBash() {
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')];
  const git = findExe(pf.filter(Boolean).map(d => path.join(d, 'Git', 'bin', 'bash.exe')));
  if (git) return [git, ['--login', '-i'], { ...process.env, CHERE_INVOKING: '1', TERM: 'xterm-256color', MSYSTEM: 'MINGW64' }];
  if (findExe([path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wsl.exe')]) && wslList().some(d => !/^docker-desktop/.test(d))) return ['wsl.exe', ['--cd', '~'], process.env];
  return ['powershell.exe', [], process.env];
}

function launchVnc(s) {
  const pf = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']];
  const viewer = findExe([settings().vncViewer, ...pf.flatMap(p => p ? [
    `${p}\\TigerVNC\\vncviewer.exe`, `${p}\\TightVNC\\tvnviewer.exe`, `${p}\\RealVNC\\VNC Viewer\\vncviewer.exe`, `${p}\\uvnc bvba\\UltraVNC\\vncviewer.exe`,
  ] : [])]);
  if (!viewer) throw new Error('No VNC viewer found. Install one (Tools > Install TigerVNC) or set its path in Settings.');
  cp.spawn(viewer, [`${s.host}::${s.port || 5900}`], { detached: true, stdio: 'ignore' }).unref();
  return { external: true };
}

// ---------- SFTP ----------
const client = id => { const c = conns.get(id); if (!c || !c.client) throw new Error('Not an SSH session'); return c.client; };
const rjoin = (a, b) => path.posix.join(a, b);

async function uploadPath(c, id, local, remoteDir) {
  const dest = rjoin(remoteDir, path.basename(local));
  if (fs.statSync(local).isDirectory()) {
    await ssh.sftpOp(c, 'mkdir', dest).catch(() => {});
    for (const f of fs.readdirSync(local)) await uploadPath(c, id, path.join(local, f), dest);
  } else {
    await ssh.sftpOp(c, 'fastPut', local, dest, { step: (t, _c, total) => send('sftp:progress', id, path.basename(local), t, total) });
  }
}

async function downloadPath(c, id, remote, localDir) {
  const dest = path.join(localDir, path.posix.basename(remote));
  const st = await ssh.sftpOp(c, 'stat', remote);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of await ssh.sftpList(c, remote)) await downloadPath(c, id, rjoin(remote, f.name), dest);
  } else {
    await ssh.sftpOp(c, 'fastGet', remote, dest, { step: (t, _c, total) => send('sftp:progress', id, path.posix.basename(remote), t, total) });
  }
}

async function removePath(c, p) {
  const st = await ssh.sftpOp(c, 'lstat', p);
  if (!st.isDirectory()) return ssh.sftpOp(c, 'unlink', p);
  for (const f of await ssh.sftpList(c, p)) await removePath(c, rjoin(p, f.name));
  return ssh.sftpOp(c, 'rmdir', p);
}

const MAX_EDIT = 10 * 1024 * 1024;
const sftpOps = {
  list: (c, _id, dir) => ssh.sftpList(c, dir),
  realpath: (c, _id, p) => ssh.sftpOp(c, 'realpath', p),
  isDir: async (c, _id, p) => (await ssh.sftpOp(c, 'stat', p)).isDirectory(),
  mkdir: (c, _id, p) => ssh.sftpOp(c, 'mkdir', p),
  touch: async (c, _id, p) => { const h = await ssh.sftpOp(c, 'open', p, 'a'); await ssh.sftpOp(c, 'close', h); },
  rename: (c, _id, a, b) => ssh.sftpOp(c, 'rename', a, b),
  chmod: (c, _id, p, mode) => ssh.sftpOp(c, 'chmod', p, parseInt(mode, 8)),
  remove: async (c, _id, paths) => { for (const p of paths) await removePath(c, p); },
  upload: async (c, id, dir, locals) => {
    if (!locals || !locals.length) {
      const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
      if (r.canceled) return false; locals = r.filePaths;
    }
    for (const l of locals) await uploadPath(c, id, l, dir);
    return true;
  },
  download: async (c, id, remotes) => {
    const r = await dialog.showOpenDialog(win, { title: 'Download to folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return false;
    for (const p of remotes) await downloadPath(c, id, p, r.filePaths[0]);
    eshell.openPath(r.filePaths[0]);
    return true;
  },
  read: async (c, _id, p) => {
    const st = await ssh.sftpOp(c, 'stat', p);
    if (st.size > MAX_EDIT) throw new Error('File too large for the editor (>10 MB)');
    return (await ssh.sftpOp(c, 'readFile', p)).toString('utf8');
  },
  write: (c, _id, p, text) => ssh.sftpOp(c, 'writeFile', p, Buffer.from(text, 'utf8')),
};
// Local / WSL file browser backend with the same operations as SFTP
const localOps = {
  list: dir => fs.readdirSync(dir, { withFileTypes: true }).map(d => {
    let st = null; try { st = fs.statSync(path.join(dir, d.name)); } catch {}
    return { name: d.name, size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0, mode: st ? st.mode : 0, dir: st ? st.isDirectory() : d.isDirectory(), link: d.isSymbolicLink(), perm: st ? (st.mode & 0o777).toString(8) : '' };
  }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name)),
  realpath: p => { const r = path.resolve(p || os.homedir()); try { return fs.realpathSync(r); } catch { return r; } },
  isDir: p => fs.statSync(p).isDirectory(),
  mkdir: p => fs.mkdirSync(p),
  touch: p => fs.closeSync(fs.openSync(p, 'a')),
  rename: (a, b) => fs.renameSync(a, b),
  chmod: (p, m) => fs.chmodSync(p, parseInt(m, 8)),
  remove: ps => ps.forEach(p => fs.rmSync(p, { recursive: true })),
  upload: async (dir, locals) => {
    if (!locals || !locals.length) { const r = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] }); if (r.canceled) return false; locals = r.filePaths; }
    for (const l of locals) fs.cpSync(l, path.join(dir, path.basename(l)), { recursive: true });
    return true;
  },
  download: async ps => {
    const r = await dialog.showOpenDialog(win, { title: 'Copy to folder', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled) return false;
    for (const p of ps) fs.cpSync(p, path.join(r.filePaths[0], path.basename(p)), { recursive: true });
    return true;
  },
  read: p => { if (fs.statSync(p).size > MAX_EDIT) throw new Error('File too large for the editor (>10 MB)'); return fs.readFileSync(p, 'utf8'); },
  write: (p, text) => fs.writeFileSync(p, text, 'utf8'),
};
// target: { conn: id } for SFTP over an SSH connection, { local: true } for local/WSL paths
handle('fs', (target, op, ...a) => {
  if (target.local) { if (!localOps[op]) throw new Error('Unsupported'); return localOps[op](...a); }
  if (!sftpOps[op]) throw new Error('Unsupported');
  return sftpOps[op](client(target.conn), target.conn, ...a);
});
handle('mon', id => ssh.monitor(client(id)));

// ---------- Docker on SSH hosts ----------
const DOCKER_ID = /^\w[\w.-]*$/;
handle('docker', async (id, action, cid) => {
  const c = client(id);
  if (action === 'list') {
    const out = await ssh.exec(c, "docker ps -a --format '{{json .}}' 2>&1");
    const lines = out.trim().split('\n').filter(Boolean);
    try { return lines.map(l => JSON.parse(l)); } catch { throw new Error(out.trim().slice(0, 400) || 'docker is not available'); }
  }
  if (!['start', 'stop', 'restart'].includes(action) || !DOCKER_ID.test(cid)) throw new Error('Invalid docker action');
  return ssh.exec(c, `docker ${action} ${cid} 2>&1`);
});

// ---------- databases ----------
const dbs = new Map();
async function dbOpen(cfg) {
  const cred = vault.data.credentials.find(c => c.id === cfg.credentialId) || {};
  const c = { ...cfg, user: cfg.user || cred.username, password: cfg.password || cred.password };
  if (c.engine === 'odbc') { // custom database type from the driver manager, or a raw connection string
    const type = (vault.data.dbDrivers || []).find(t => t.id === c.driverId);
    if (c.driverId && !type) throw new Error('The database type of this connection was deleted (Database types…)');
    Object.assign(c, type ? { template: type.template, explainPrefix: type.explain, port: c.port || type.port } : { template: c.connectionString });
  }
  let tunnel = null;
  if (c.sshId && c.engine !== 'sqlite') {
    const s = vault.data.sessions.find(x => x.id === c.sshId);
    if (!s) throw new Error('SSH session for the tunnel not found');
    const sc = await sshConnect(s);
    try {
      const t = await ssh.startTunnel(sc, { type: 'L', localPort: 0, remoteHost: c.host || '127.0.0.1', remotePort: +c.port || db.DEFAULT_PORTS[c.engine] });
      tunnel = { close: () => { t.close(); sc.end(); } };
      Object.assign(c, { host: '127.0.0.1', port: t.port });
    } catch (e) { sc.end(); throw e; }
  }
  try { return { conn: await db.open(c), tunnel }; } catch (e) { tunnel && tunnel.close(); throw e; }
}
// saved connections are read from the vault so read-only / environment flags can't be overridden by the page
const savedDb = cfg => (cfg.id && (vault.data.dbs || []).find(d => d.id === cfg.id)) || cfg;
handle('db:test', async cfg => { unlocked(); const { conn, tunnel } = await dbOpen(cfg); await conn.close(); tunnel && tunnel.close(); return true; });
handle('db:open', async cfg => {
  unlocked();
  const id = nextId++;
  const saved = savedDb(cfg);
  // the page may supply a database switch or a password typed at connect time; safety flags always come from the vault
  dbs.set(id, await dbOpen({ ...saved, database: cfg.database || saved.database, password: cfg.password || saved.password }));
  return { id };
});
const dbc = id => { const d = dbs.get(id); if (!d) throw new Error('Database connection closed'); return d.conn; };
handle('db:query', (id, sql, opts) => dbc(id).query(sql, opts));
handle('db:schema', id => dbc(id).schema());
handle('db:databases', id => dbc(id).databases());
handle('db:ddl', (id, schema, table) => dbc(id).ddl(schema, table));
handle('db:cancel', id => dbc(id).cancel());
// ODBC drivers installed on this PC (64-bit registry view = what this 64-bit app can load). Read locally, nothing is downloaded.
handle('odbc:drivers', () => {
  const r = cp.spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers'], { windowsHide: true, encoding: 'utf8' });
  return (r.stdout || '').split(/\r?\n/).map(l => /^\s{4}(.+?)\s{4}REG_SZ\s{4}Installed/i.exec(l)).filter(Boolean).map(m => m[1]);
});
handle('db:keys', (id, schema, table) => dbc(id).keys(schema, table));
handle('db:objects', id => dbc(id).objects());
handle('db:source', (id, obj) => dbc(id).source(obj));
handle('db:compare', (srcId, s, dstId, t) => db.compareTables(dbc(srcId), s, dbc(dstId), t));
handle('db:explain', (id, sql) => dbc(id).explain(sql));
handle('db:editSql', (engine, schema, table, changes) => changes.map(ch => db.editSql(engine, schema, table, ch)));
handle('db:applyEdits', (id, stmts) => dbc(id).applyEdits(stmts));
// action: 'state' | 'manual' | 'auto' | 'commit' | 'rollback'  -> { manual, pending }
handle('db:tx', async (id, action) => {
  const c = dbc(id);
  if (action === 'manual' || action === 'auto') await c.setAutoCommit(action === 'auto');
  if (action === 'commit' || action === 'rollback') await c[action]();
  return c.txState();
});
const SQL_DIALECT = { postgres: 'postgresql', mysql: 'mariadb', mssql: 'transactsql', oracle: 'plsql', sqlite: 'sqlite' };
handle('db:format', (sql, engine) => require('sql-formatter').format(sql, { language: SQL_DIALECT[engine] || 'sql', keywordCase: 'upper' }));
handle('db:close', async id => { const d = dbs.get(id); if (d) { dbs.delete(id); try { await d.conn.close(); } catch {} d.tunnel && d.tunnel.close(); } });
async function writeExport(fmt, columns, rows, table, engine) {
  const r = SMOKE ? { filePath: path.join(app.getPath('userData'), `export-${Date.now()}.${fmt}`) }
    : await dialog.showSaveDialog(win, { defaultPath: `${safeName(table || 'result')}.${fmt}` });
  if (r.canceled) return null;
  const text = fmt === 'csv' ? db.toCsv(columns, rows) : fmt === 'json' ? db.toJson(columns, rows) : db.toInserts(engine, table || 'table_name', columns, rows);
  fs.writeFileSync(r.filePath, text, 'utf8');
  return r.filePath;
}
handle('db:export', (fmt, columns, rows, table, engine) => writeExport(fmt, columns, rows, table, engine));
// Re-run a READ query with a bigger row limit and stream it into a file batch by batch (server cursor -> disk:
// memory stays flat even for millions of rows; binary values are written in full).
handle('db:exportQuery', async (id, sql, limit, fmt, table, engine) => {
  const stmts = db.splitSql(sql);
  if (stmts.some(s => db.classify(s).write)) throw new Error('Only read queries (SELECT…) can be re-run for export');
  if (!stmts.length) throw new Error('Nothing to export');
  const r = SMOKE ? { filePath: path.join(app.getPath('userData'), `export-${Date.now()}.${fmt}`) }
    : await dialog.showSaveDialog(win, { defaultPath: `${safeName(table || 'result')}.${fmt}` });
  if (r.canceled) return null;
  const tmp = r.filePath + '.part', fd = fs.openSync(tmp, 'w'), w = db.exportWriter(fmt, table, engine);
  let started = false, res;
  try {
    res = await dbc(id).stream(stmts[stmts.length - 1], Math.max(1, +limit || 1), (cols, rows) => {
      if (!started) { fs.writeSync(fd, w.head(cols)); started = true; }
      fs.writeSync(fd, w.rows(cols, rows));
    });
    if (!started) fs.writeSync(fd, w.head(res.columns));
    fs.writeSync(fd, w.tail());
    fs.closeSync(fd);
    fs.renameSync(tmp, r.filePath);
  } catch (e) { try { fs.closeSync(fd); } catch {} fs.rmSync(tmp, { force: true }); throw e; }
  return { file: r.filePath, rows: res.rows, more: res.more };
});
handle('db:selectSql', (engine, schema, table, limit, where, order) => db.selectSql(engine, schema, table, limit || 200, where, order));
handle('db:classify', script => db.splitSql(script).map(s => ({ sql: s, ...db.classify(s) })));

// ---------- tunnels ----------
handle('tun:start', async t => {
  unlocked();
  if (tunnels.has(t.id)) return true;
  const s = vault.data.sessions.find(x => x.id === t.sessionId);
  if (!s) throw new Error('Tunnel SSH session not found');
  const c = await sshConnect(s);
  try {
    const h = await ssh.startTunnel(c, t);
    tunnels.set(t.id, { c, h });
    c.on('close', () => { if (tunnels.delete(t.id)) send('tun:status', t.id, false); });
    send('tun:status', t.id, true);
    return true;
  } catch (e) { c.end(); throw e; }
});
handle('tun:stop', id => { const t = tunnels.get(id); if (t) { tunnels.delete(id); t.h.close(); t.c.end(); send('tun:status', id, false); } });
handle('tun:active', () => [...tunnels.keys()]);

// ---------- embedded servers ----------
handle('srv:start', async (kind, opts) => {
  if (running[kind]) return running[kind].port;
  const log = m => send('srv:log', `${new Date().toLocaleTimeString()} ${m}`);
  if (!opts.root || !fs.existsSync(opts.root)) throw new Error('Choose an existing root folder');
  running[kind] = await (kind === 'http' ? servers.httpServer : servers.tftpServer)({ ...opts, port: +opts.port, log });
  log(`${kind.toUpperCase()} server listening on ${opts.bind || '0.0.0.0'}:${running[kind].port}, root ${opts.root}`);
  return running[kind].port;
});
handle('srv:stop', kind => { if (running[kind]) { running[kind].close(); delete running[kind]; send('srv:log', `${kind.toUpperCase()} server stopped`); } });
handle('srv:status', () => Object.fromEntries(Object.entries(running).map(([k, v]) => [k, v.port])));

// ---------- tools ----------
handle('tool:scan', (h, p) => tools.portScan(h, p));
handle('tool:netscan', (pre, p) => tools.netScan(pre, p));
handle('tool:dns', n => tools.dnsLookup(n));
handle('tool:wol', (m, b) => tools.wol(m, b));
handle('tool:pass', (l, s) => tools.genPassword(+l, s));
handle('tool:keygen', (t, o) => tools.genKey(t, o));
// read a private key file so it can be kept inside the vault (checked to really be a private key first)
handle('key:read', (p, passphrase) => {
  const text = ssh.readKey(p).toString('utf8');
  try { ssh.publicKeyOf(text, passphrase); } catch (e) { if (!/encrypted/i.test(e.message)) throw e; }
  return text;
});
// public key of a session's (or credential's) private key: from the vault copy or the key file
handle('key:public', (sessionId, credId) => {
  unlocked();
  const s = sessionId ? vault.data.sessions.find(x => x.id === sessionId) : { credentialId: credId };
  if (!s) throw new Error('Session not found');
  const r = resolveSsh(s);
  if (!r.keyData && !r.keyFile) throw new Error('No private key set: paste a public key or set a key first');
  return ssh.publicKeyOf(r.keyData || ssh.readKey(r.keyFile), r.passphrase);
});
// ssh-copy-id: log in once (password or existing key) and append the public key to ~/.ssh/authorized_keys
handle('ssh:installKey', async (sessionId, { password, publicKey } = {}) => {
  unlocked();
  const s = vault.data.sessions.find(x => x.id === sessionId);
  if (!s) throw new Error('Save the session first');
  let pub = publicKey;
  if (!pub) { const r = resolveSsh(s); if (!r.keyData && !r.keyFile) throw new Error('No public key given and the session has no private key'); pub = ssh.publicKeyOf(r.keyData || ssh.readKey(r.keyFile), r.passphrase); }
  const c = await sshConnect(s, { password });
  try { return await ssh.installPublicKey(c, pub); } finally { c.end(); }
});
handle('tool:savekey', async (priv, pub) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(os.homedir(), '.ssh', 'id_termucraft') });
  if (r.canceled) return null;
  fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
  fs.writeFileSync(r.filePath, priv, { mode: 0o600 });
  fs.writeFileSync(r.filePath + '.pub', pub);
  return r.filePath;
});

// ---------- X server (VcXsrv) ----------
const vcxsrv = () => findExe([`${process.env.ProgramFiles}\\VcXsrv\\vcxsrv.exe`, `${process.env['ProgramFiles(x86)']}\\VcXsrv\\vcxsrv.exe`]);
let xproc = null;
handle('x:status', () => ({ installed: !!vcxsrv(), running: !!xproc }));
handle('x:start', () => {
  if (xproc) return true;
  const exe = vcxsrv();
  if (!exe) throw new Error('VcXsrv is not installed (use "Install X server")');
  const d = +settings().x11Display || 0;
  xproc = cp.spawn(exe, [`:${d}`, '-multiwindow', '-clipboard', '-wgl', '-ac'], { stdio: 'ignore' });
  xproc.on('exit', () => { xproc = null; send('x:status'); });
  return true;
});
handle('x:stop', () => { if (xproc) xproc.kill(); });

// ---------- files ----------
handle('file:pick', async (opts = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: [opts.dir ? 'openDirectory' : 'openFile'], defaultPath: opts.defaultPath });
  return r.canceled ? null : r.filePaths[0];
});
handle('file:open', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  if (r.canceled) return null;
  if (fs.statSync(r.filePaths[0]).size > MAX_EDIT) throw new Error('File too large for the editor (>10 MB)');
  return { path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], 'utf8') };
});
handle('file:save', async (p, text) => {
  if (!p) { const r = await dialog.showSaveDialog(win, {}); if (r.canceled) return null; p = r.filePath; }
  fs.writeFileSync(p, text, 'utf8');
  return p;
});
handle('open:url', u => /^(https?|mailto):/i.test(u) && eshell.openExternal(u));
handle('moba:import', async () => {
  let f = path.join(process.env.APPDATA || '', 'MobaXterm', 'MobaXterm.ini');
  if (!fs.existsSync(f)) {
    const r = await dialog.showOpenDialog(win, { filters: [{ name: 'MobaXterm', extensions: ['ini', 'mxtsessions'] }] });
    if (r.canceled) return null; f = r.filePaths[0];
  }
  return parseMobaIni(fs.readFileSync(f, 'latin1'));
});

// ---------- full MobaXterm import (sessions + passwords + credentials + macros) ----------
const readText = (p, enc) => { try { return fs.readFileSync(p, enc); } catch { return null; } };
function exportMobaRegistry() {
  // Export HKCU MobaXterm to a temp .reg (UTF-16) then read it. Same format as a cross-device export.
  const out = path.join(app.getPath('temp'), `mxc-moba-${Date.now()}.reg`);
  const r = cp.spawnSync('reg', ['export', 'HKCU\\Software\\Mobatek\\MobaXterm', out, '/y'], { windowsHide: true });
  if (r.status !== 0) return null;
  const text = readText(out, 'ucs2');
  fs.rm(out, () => {});
  return text;
}
handle('moba:scan', () => {
  const ini = path.join(process.env.APPDATA || '', 'MobaXterm', 'MobaXterm.ini');
  let hasRegistry = false;
  try { hasRegistry = cp.spawnSync('reg', ['query', 'HKCU\\Software\\Mobatek\\MobaXterm'], { windowsHide: true }).status === 0; } catch {}
  return { iniPath: fs.existsSync(ini) ? ini : null, hasRegistry, user: os.userInfo().username, host: os.hostname() };
});
// opts: { source:'local'|'files', iniPath, regPath, masterPassword, origUser, origHost }
handle('moba:preview', async opts => {
  let ini = null, reg = null;
  if (opts.source === 'local') {
    const def = path.join(process.env.APPDATA || '', 'MobaXterm', 'MobaXterm.ini');
    ini = readText(opts.iniPath || def, 'latin1');
    reg = exportMobaRegistry();
  } else {
    if (!opts.iniPath && !opts.regPath) {
      const r = await dialog.showOpenDialog(win, { title: 'Select MobaXterm.ini and/or exported .reg', properties: ['openFile', 'multiSelections'], filters: [{ name: 'MobaXterm export', extensions: ['ini', 'mxtsessions', 'reg'] }] });
      if (r.canceled) return null;
      for (const f of r.filePaths) f.toLowerCase().endsWith('.reg') ? (reg = readText(f, 'ucs2')) : (ini = readText(f, 'latin1'));
    } else { if (opts.iniPath) ini = readText(opts.iniPath, 'latin1'); if (opts.regPath) reg = readText(opts.regPath, 'ucs2'); }
  }
  if (!ini && !reg) throw new Error('Nothing to import (no ini or registry data found)');
  // local MobaXterm encrypted with this PC's identity when no master password was set — use it by default
  const origUser = opts.origUser || (opts.source === 'local' ? os.userInfo().username : '');
  const origHost = opts.origHost || (opts.source === 'local' ? os.hostname() : '');
  const preview = mobaImport.buildPreview({ ini, reg, masterPassword: opts.masterPassword, origUser, origHost });
  // diagnostics so the UI can explain "found vs decrypted" and portable-vs-registry
  preview.diag = { regExport: reg != null, iniFound: ini != null, origUser, origHost, source: opts.source };
  return preview;
});

// ---------- MobaXterm's own exports: passwords .txt and macros file (plain text, no decryption) ----------
function readExportText(p) {
  if (fs.statSync(p).size > 5 * 1024 * 1024) throw new Error(`${path.basename(p)} is too large to be a MobaXterm export`);
  const b = fs.readFileSync(p);
  if (b[0] === 0xff && b[1] === 0xfe) return b.toString('utf16le').replace(/^﻿/, '');
  const u = b.toString('utf8');
  return u.includes('�') ? b.toString('latin1') : u; // ANSI export
}
handle('moba:exportFiles', async paths => {
  if (!paths || !paths.length) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select the passwords .txt and/or macros file exported from MobaXterm', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'MobaXterm exports', extensions: ['txt', 'macros', 'mxtmacros', 'ini'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled) return null;
    paths = r.filePaths;
  }
  const out = { credentials: [], passwords: [], macros: [], skipped: [], files: [] };
  for (const p of paths) {
    const text = readExportText(p);
    out.files.push(path.basename(p));
    if (/^\s*\[Macros\]/mi.test(text) || /^[^=\r\n]*=\d+:\d+:\d+:/m.test(text)) out.macros.push(...mobaFiles.parseMacroExport(text));
    else { const r = mobaFiles.parsePasswordExport(text); out.credentials.push(...r.credentials); out.passwords.push(...r.passwords); out.skipped.push(...r.skipped); }
  }
  if (!out.credentials.length && !out.passwords.length && !out.macros.length) throw new Error('No passwords or macros found in the selected file(s)');
  return out;
});

// ---------- DBeaver import ----------
handle('dbeaver:scan', () => {
  const roots = [path.join(process.env.APPDATA || '', 'DBeaverData'), path.join(os.homedir(), '.local', 'share', 'DBeaverData')];
  const found = [];
  for (const root of roots) {
    for (const ws of (fs.existsSync(root) ? fs.readdirSync(root) : [])) {
      if (!/^workspace/.test(ws)) continue;
      const wsPath = path.join(root, ws);
      for (const proj of (fs.existsSync(wsPath) ? fs.readdirSync(wsPath) : [])) {
        const d = path.join(wsPath, proj, '.dbeaver');
        if (fs.existsSync(path.join(d, 'data-sources.json'))) found.push({ dir: path.join(wsPath, proj), label: `${ws}/${proj}` });
      }
    }
  }
  return found;
});
function scriptsIn(dir) {
  const out = [];
  const scan = d => { for (const e of (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : [])) { const p = path.join(d, e.name); if (e.isDirectory()) scan(p); else if (/\.sql$/i.test(e.name)) out.push(p); } };
  scan(path.join(dir, 'Scripts')); scan(dir);
  return [...new Set(out)];
}
handle('dbeaver:preview', async dir => {
  if (!dir) { const r = await dialog.showOpenDialog(win, { title: 'Select DBeaver project folder (contains .dbeaver)', properties: ['openDirectory'] }); if (r.canceled) return null; dir = r.filePaths[0]; }
  const dot = fs.existsSync(path.join(dir, '.dbeaver')) ? path.join(dir, '.dbeaver') : dir;
  const dsText = readText(path.join(dot, 'data-sources.json'), 'utf8') || readText(path.join(dir, 'data-sources.json'), 'utf8');
  if (!dsText) throw new Error('No data-sources.json found in that folder');
  let dataSources; try { dataSources = JSON.parse(dsText); } catch { throw new Error('data-sources.json is not valid JSON'); }
  const credsBuffer = (() => { try { return fs.readFileSync(path.join(dot, 'credentials-config.json')); } catch { return null; } })();
  let resources = {};
  try { resources = JSON.parse(readText(path.join(dot, 'project-metadata.json'), 'utf8') || '{}').resources || {}; } catch {}
  const scripts = scriptsIn(dir).slice(0, 500).map(p => ({ path: p, rel: path.relative(dir, p) }));
  return { ...dbeaver.buildPreview({ dataSources, credsBuffer, scripts, resources }), dir };
});
// text MUST be a string: a Buffer reaches CodeMirror as a non-string "document" and crashes it (doc.iter is not a function)
handle('dbeaver:scripts', paths => paths.map(p => ({ name: path.basename(p), path: p, text: readText(p, 'utf8') || '' })));

// ---------- app ----------
app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  esession.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-read', 'clipboard-sanitized-write'].includes(perm)));
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 900, minHeight: 560, backgroundColor: '#1b1d23', title: 'TermuCraft',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }, // spellcheck could fetch dictionaries
  });
  win.webContents.on('before-input-event', (_e, i) => { if (i.type === 'keyDown' && i.key === 'F12') win.webContents.toggleDevTools(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) eshell.openExternal(url); return { action: 'deny' }; });
  // the renderer blocks unload while work is unsaved; Electron would then silently ignore the close button -> ask instead
  win.webContents.on('will-prevent-unload', e => {
    const r = dialog.showMessageBoxSync(win, { type: 'warning', buttons: ['Close anyway', 'Cancel'], defaultId: 1, cancelId: 1, title: 'TermuCraft',
      message: 'You have unsaved work', detail: 'Unsaved editor/script changes, unsaved grid edits or uncommitted transactions will be lost.' });
    if (r === 0) e.preventDefault();
  });
  win.webContents.on('will-navigate', (e, url) => { if (url !== win.webContents.getURL()) e.preventDefault(); }); // reload (lock/reset) allowed
  await win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (SMOKE) runSmoke();
});

app.on('window-all-closed', () => {
  for (const c of conns.values()) try { c.close(); } catch {}
  for (const t of tunnels.values()) try { t.c.end(); } catch {}
  if (xproc) xproc.kill();
  app.quit();
});

// End-to-end smoke test: drives the real UI against an in-process SSH server (and live hosts if MXC_LIVE is set).
async function runSmoke() {
  const { startSshServer } = require('./test/fake-sshd');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mxc-sftp-'));
  fs.writeFileSync(path.join(root, 'hello.txt'), 'hi from sftp');
  // a key the fake server accepts, plus (when Git Bash exists) a real shell so "install public key" can be checked
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxc-key-')), home = fs.mkdtempSync(path.join(os.tmpdir(), 'mxc-home-'));
  const kp = require('ssh2').utils.generateKeyPairSync('ed25519');
  fs.writeFileSync(path.join(keyDir, 'id_smoke'), kp.private);
  const bash = ['C:\\Program Files\\Git\\bin\\bash.exe'].find(p => fs.existsSync(p));
  const srv = await startSshServer(root, { authorizedKey: kp.public, shell: bash, home: home.replace(/\\/g, '/') });
  let code = 1;
  try {
    const live = process.env.MXC_LIVE ? JSON.parse(process.env.MXC_LIVE) : [];
    const dbsCfg = process.env.MXC_SMOKE_DBS ? JSON.parse(process.env.MXC_SMOKE_DBS) : [];
    const res = await win.webContents.executeJavaScript(`window.smoke(${JSON.stringify({ port: srv.address().port, live, dbs: dbsCfg, tmp: root, keyFile: path.join(keyDir, 'id_smoke'), canInstallKey: !!bash })})`);
    console.log('SMOKE RESULT', JSON.stringify(res, null, 1));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, 'smoke.png'), img.toPNG());
    code = res.ok ? 0 : 1;
  } catch (e) { console.error('SMOKE ERROR', e); }
  srv.close();
  for (const d of [keyDir, home]) fs.rmSync(d, { recursive: true, force: true });
  // the smoke vault can contain real imported passwords — never leave it behind
  for (const f of [vault.file, vault.file + '.tmp']) fs.rmSync(f, { force: true });
  app.exit(code);
}
