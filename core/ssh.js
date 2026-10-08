// SSH: connections (password/key/agent/keyboard-interactive, jump host, X11), tunnels, SOCKS, remote monitoring.
const { Client, utils } = require('ssh2');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');

function readKey(path) {
  if (!path) return undefined;
  // MobaXterm sessions often point at the .pub; the private key sits next to it
  if (path.endsWith('.pub') && fs.existsSync(path.slice(0, -4))) path = path.slice(0, -4);
  return fs.readFileSync(path);
}

// "ssh-ed25519 AAAA… comment" for a private key (PEM/OpenSSH/PPK text or Buffer); encrypted keys need the passphrase
function publicKeyOf(priv, passphrase) {
  const k = utils.parseKey(priv, passphrase || undefined);
  if (k instanceof Error) throw new Error(/passphrase/i.test(k.message) ? 'The key is encrypted: enter its passphrase' : 'Not a supported private key: ' + k.message);
  const key = Array.isArray(k) ? k[0] : k;
  return `${key.type} ${key.getPublicSSH().toString('base64')}${key.comment ? ' ' + key.comment : ''}`;
}

// Like ssh-copy-id: append the key to ~/.ssh/authorized_keys once, fixing permissions. -> 'added' | 'already'
async function installPublicKey(c, pub) {
  const line = String(pub).trim().split(/\r?\n/)[0];
  if (!/^(ssh-[a-z0-9-]+|ecdsa-sha2-[a-z0-9-]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/=]+( .*)?$/.test(line)) throw new Error('Not an OpenSSH public key line (ssh-ed25519 AAAA… comment)');
  const q = "'" + line.replace(/'/g, "'\\''") + "'", f = '~/.ssh/authorized_keys';
  const out = await exec(c, `umask 077; mkdir -p ~/.ssh && touch ${f} && chmod 700 ~/.ssh && chmod 600 ${f} && ` +
    `if grep -qxF ${q} ${f}; then echo TC_ALREADY; else [ -n "$(tail -c1 ${f})" ] && echo >> ${f}; echo ${q} >> ${f} && echo TC_ADDED; fi`);
  if (/TC_ALREADY/.test(out)) return 'already';
  if (/TC_ADDED/.test(out)) return 'added';
  throw new Error('Could not update ~/.ssh/authorized_keys: ' + out.trim().slice(0, 200));
}

// s: { host, port, username, password, keyFile, keyData, passphrase, agent, x11, jump: <same shape> }
// hooks: { verifyHost(hostPort, fingerprint) -> Promise<bool>, x11Display }
function connect(s, hooks = {}) {
  return new Promise(async (resolve, reject) => {
    let jump = null, sock;
    try {
      if (s.jump) {
        jump = await connect(s.jump, hooks);
        sock = await new Promise((ok, ko) => jump.forwardOut('127.0.0.1', 0, s.host, +s.port || 22, (e, ch) => e ? ko(e) : ok(ch)));
      }
    } catch (e) { jump && jump.end(); return reject(e); }

    const c = new Client();
    const hostPort = `${s.host}:${+s.port || 22}`;
    c.on('ready', () => resolve(c));
    c.on('error', e => { jump && jump.end(); reject(e); });
    c.on('close', () => jump && jump.end());
    c.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => finish(prompts.map(() => s.password || '')));
    c.on('x11', (info, accept, rejectX) => {
      const x = net.connect(6000 + (hooks.x11Display || 0), '127.0.0.1');
      x.once('error', () => rejectX());
      x.once('connect', () => { const ch = accept(); ch.pipe(x).pipe(ch); x.on('error', () => ch.close()); ch.on('error', () => x.destroy()); });
    });
    try {
      c.connect({
        host: s.host, port: +s.port || 22, sock, username: s.username,
        password: s.password || undefined,
        privateKey: s.keyData || readKey(s.keyFile), passphrase: s.passphrase || undefined, // keyData = key kept in the vault
        agent: s.agent ? (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : process.env.SSH_AUTH_SOCK) : undefined,
        tryKeyboard: true, readyTimeout: 20000, keepaliveInterval: 15000,
        hostVerifier: (key, cb) => {
          if (!hooks.verifyHost) return cb(true);
          const fp = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');
          hooks.verifyHost(hostPort, fp).then(cb, () => cb(false));
        },
      });
    } catch (e) { jump && jump.end(); reject(e); }
  });
}

function shell(c, { cols = 80, rows = 24, x11 = false } = {}) {
  return new Promise((ok, ko) => c.shell({ term: 'xterm-256color', cols, rows }, x11 ? { x11: true } : {}, (e, st) => e ? ko(e) : ok(st)));
}

function exec(c, cmd) {
  return new Promise((ok, ko) => c.exec(cmd, (e, st) => {
    if (e) return ko(e);
    let out = '';
    st.on('data', d => out += d).stderr.on('data', () => {});
    st.on('close', () => ok(out));
  }));
}

function sftp(c) {
  if (!c._sftp) c._sftp = new Promise((ok, ko) => c.sftp((e, s) => e ? (c._sftp = null, ko(e)) : ok(s)));
  return c._sftp;
}

// Promisified SFTP op: sftpOp(c, 'mkdir', path) etc.
async function sftpOp(c, op, ...args) {
  const s = await sftp(c);
  return new Promise((ok, ko) => s[op](...args, (e, r) => e ? ko(e) : ok(r)));
}

async function sftpList(c, dir) {
  const list = await sftpOp(c, 'readdir', dir);
  return list.map(f => ({
    name: f.filename, size: f.attrs.size, mtime: f.attrs.mtime * 1000, mode: f.attrs.mode,
    dir: (f.attrs.mode & 0o170000) === 0o040000, link: (f.attrs.mode & 0o170000) === 0o120000,
    perm: f.longname ? f.longname.split(/\s+/)[0] : (f.attrs.mode & 0o777).toString(8),
  })).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
}

// ---- remote node monitoring (Linux /proc) ----
const MON_CMD = 'LC_ALL=C; cat /proc/loadavg; head -1 /proc/stat; sleep 1; head -1 /proc/stat; ' +
  'free -b | awk \'NR==2{print $2, $3}\'; df -P / | awk \'NR==2{print $5}\'; cut -d" " -f1 /proc/uptime; who | wc -l; ' +
  'awk \'NR>2{r+=$2;t+=$10}END{print r, t}\' /proc/net/dev';

function parseMonitor(out) {
  const l = out.trim().split('\n');
  if (l.length < 8) throw new Error('unsupported host');
  const cpu = s => { const n = s.trim().split(/\s+/).slice(1).map(Number); return { idle: n[3] + (n[4] || 0), total: n.reduce((a, b) => a + b, 0) }; };
  const a = cpu(l[1]), b = cpu(l[2]);
  const [memTotal, memUsed] = l[3].split(' ').map(Number);
  const [rx, tx] = l[7].split(' ').map(Number);
  return {
    load: l[0].split(' ').slice(0, 3).join(' '),
    cpu: Math.round(100 * (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total))),
    mem: Math.round(100 * memUsed / memTotal), memTotal,
    disk: parseInt(l[4]), uptime: +l[5], users: +l[6], rx, tx,
  };
}

const monitor = async c => parseMonitor(await exec(c, MON_CMD));

// ---- tunnels ----
function pipe(a, b) { a.pipe(b).pipe(a); a.on('error', () => b.destroy()); b.on('error', () => a.destroy()); }

// t: { type: 'L'|'R'|'D', bind, localPort, remoteHost, remotePort }. Returns { close() }.
function startTunnel(c, t) {
  return new Promise((ok, ko) => {
    if (t.type === 'R') {
      const handler = (info, accept) => {
        if (info.destPort !== +t.remotePort) return;
        const s = net.connect(+t.localPort, t.localHost || '127.0.0.1');
        s.once('connect', () => pipe(s, accept())); s.once('error', () => {});
      };
      c.on('tcp connection', handler);
      return c.forwardIn(t.bind || '127.0.0.1', +t.remotePort, e => e ? ko(e) : ok({
        close: () => { c.removeListener('tcp connection', handler); c.unforwardIn(t.bind || '127.0.0.1', +t.remotePort, () => {}); },
      }));
    }
    const srv = net.createServer(sock => {
      sock.on('error', () => {});
      if (t.type === 'D') return socks5(sock, (host, port, done) => c.forwardOut('127.0.0.1', 0, host, port, done));
      c.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, t.remoteHost, +t.remotePort, (e, ch) => e ? sock.destroy() : pipe(sock, ch));
    });
    srv.once('error', ko);
    srv.listen(+t.localPort, t.bind || '127.0.0.1', () => ok({ close: () => srv.close(), port: srv.address().port }));
  });
}

// Minimal SOCKS5 (no auth, CONNECT only, IPv4/domain/IPv6).
function socks5(sock, open) {
  sock.once('data', hello => {
    if (hello[0] !== 5) return sock.destroy();
    sock.write(Buffer.from([5, 0]));
    sock.once('data', req => {
      if (req[0] !== 5 || req[1] !== 1) { sock.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }
      let host, i;
      if (req[3] === 1) { host = [...req.slice(4, 8)].join('.'); i = 8; }
      else if (req[3] === 3) { host = req.slice(5, 5 + req[4]).toString(); i = 5 + req[4]; }
      else if (req[3] === 4) { host = req.slice(4, 20).toString('hex').match(/.{4}/g).join(':'); i = 20; }
      else return sock.destroy();
      const port = req.readUInt16BE(i);
      const rest = req.slice(i + 2);
      open(host, port, (e, ch) => {
        if (e) return sock.end(Buffer.from([5, 5, 0, 1, 0, 0, 0, 0, 0, 0]));
        sock.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        if (rest.length) ch.write(rest);
        pipe(sock, ch);
      });
    });
  });
}

module.exports = { connect, publicKeyOf, installPublicKey, readKey, shell, exec, sftp, sftpOp, sftpList, monitor, parseMonitor, startTunnel, socks5 };
