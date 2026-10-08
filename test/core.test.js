const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const dgram = require('dgram');
const { utils } = require('ssh2');

const { Vault } = require('../core/vault');
const { parseMobaIni } = require('../core/moba');
const H = require('../core/highlight');
const { createFilter } = require('../core/telnet');
const { httpServer, tftpServer, safeJoin } = require('../core/servers');
const tools = require('../core/tools');
const ssh = require('../core/ssh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mxc-'));

test('vault: create, unlock, wrong password, change password', () => {
  const f = path.join(tmp, 'v.json');
  const v = new Vault(f);
  v.create('pw1');
  v.data.sessions.push({ id: 1, password: 'secret' });
  v.save();
  assert.ok(!fs.readFileSync(f, 'utf8').includes('secret'));
  const v2 = new Vault(f);
  assert.throws(() => v2.unlock('nope'), /Wrong master password/);
  v2.unlock('pw1');
  assert.equal(v2.data.sessions[0].password, 'secret');
  v2.changePassword('pw2');
  const v3 = new Vault(f);
  assert.throws(() => v3.unlock('pw1'));
  v3.unlock('pw2');
  assert.equal(v3.data.sessions.length, 1);
});

test('moba import parses bookmarks and folders', () => {
  const ini = [
    '[Misc]', 'x=1', '[Bookmarks]', 'SubRep=', 'ImgNum=42',
    'web (root)=#109#0%10.0.0.5%2222%root%%-1%-1%%%%%0%0%0%_AppDataDir_\\MobaXterm\\home\\.ssh\\id_rsa.pub%%-1%0#MobaFont%10#0# #-1',
    'vnc=#128#5%62.1.1.1%5901%%0%%%#MobaFont#0# #-1',
    'COM1  (Communications Port (COM1))=#131#8%0%1009600%3%0%0%1%2%COM1  (Communications Port (COM1))#MobaFont#0# #-1',
    'WSL-Ubuntu=#105#14%Ubuntu%',
    '[Bookmarks_1]', 'SubRep=Prod\\DB', 'ImgNum=41', 'db1=#91#4%db1.local%3389%admin%0#MobaFont#0# #-1',
    '[Passwords]', 'ignored=#109#0%x%22%',
  ].join('\r\n');
  const s = parseMobaIni(ini);
  assert.equal(s.length, 5);
  assert.deepEqual([s[0].type, s[0].host, s[0].port, s[0].username, s[0].x11], ['ssh', '10.0.0.5', 2222, 'root', true]);
  assert.ok(s[0].keyFile.endsWith('id_rsa.pub') && !s[0].keyFile.includes('_AppDataDir_'));
  assert.deepEqual([s[1].type, s[1].port], ['vnc', 5901]);
  assert.deepEqual([s[2].type, s[2].port, s[2].baud], ['serial', 'COM1', 9600]);
  assert.deepEqual([s[3].type, s[3].command], ['shell', 'wsl.exe -d Ubuntu']);
  assert.deepEqual([s[4].type, s[4].folder, s[4].username], ['rdp', 'Prod/DB', 'admin']);
});

test('highlight colors keywords, skips escapes and pre-colored text', () => {
  const c = H.compile();
  const st = { colored: false };
  assert.equal(H.highlight('build failed at 10.1.2.3', c, st), 'build \x1b[1;31mfailed\x1b[0m at \x1b[36m10.1.2.3\x1b[0m');
  assert.equal(H.highlight('\x1b[32merror\x1b[0m error', c, st), '\x1b[32merror\x1b[0m \x1b[1;31merror\x1b[0m');
  assert.equal(st.colored, false);
  assert.equal(H.highlight('\x1b[31m', c, st), '\x1b[31m');
  assert.equal(H.highlight('error', c, st), 'error'); // still inside remote color across chunks
  const custom = H.compile([{ pattern: '(foo|bar)baz', color: '35' }, { pattern: 'zap', color: '34' }]);
  assert.equal(H.highlight('foobaz zap', custom, { colored: false }), '\x1b[35mfoobaz\x1b[0m \x1b[34mzap\x1b[0m');
  assert.equal(H.highlight('x', H.compile([{ pattern: '(', color: '1' }]), {}), 'x');
});

test('telnet filter strips negotiation and answers', () => {
  const replies = [];
  const f = createFilter(b => replies.push([...b]), () => ({ cols: 100, rows: 40 }));
  const out = f(Buffer.from([65, 255, 253, 31, 255, 251, 1, 255, 253, 5, 255, 255, 66, 255, 250, 24, 1, 255, 240, 67]));
  assert.equal(out.toString('latin1'), 'A\xffBC');
  assert.deepEqual(replies[0], [255, 251, 31]);
  assert.deepEqual(replies[1], [255, 250, 31, 0, 100, 0, 40, 255, 240]);
  assert.deepEqual(replies[2], [255, 253, 1]);
  assert.deepEqual(replies[3], [255, 252, 5]);
  assert.ok(Buffer.from(replies[4]).toString('latin1').includes('xterm-256color'));
});

test('http server serves files and blocks traversal', async () => {
  const root = path.join(tmp, 'www'); fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello');
  assert.equal(safeJoin(root, '/../../etc/passwd'), path.join(root, 'etc', 'passwd'));
  const srv = await httpServer({ root, port: 0, bind: '127.0.0.1' });
  const get = p => new Promise(ok => http.get({ port: srv.port, path: p }, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => ok([r.statusCode, b])); }));
  assert.deepEqual(await get('/a.txt'), [200, 'hello']);
  assert.match((await get('/'))[1], /a\.txt/);
  assert.equal((await get('/../core.test.js'))[0], 404);
  srv.close();
});

test('tftp server: get and put (multi-block)', async () => {
  const root = path.join(tmp, 'tftp'); fs.mkdirSync(root);
  const big = Buffer.alloc(1300, 7); fs.writeFileSync(path.join(root, 'cfg.bin'), big);
  const srv = await tftpServer({ root, port: 0, bind: '127.0.0.1' });
  const sock = dgram.createSocket('udp4');
  await new Promise(r => sock.bind(0, '127.0.0.1', r));
  const rq = (op, name) => Buffer.concat([Buffer.from([0, op]), Buffer.from(name + '\0octet\0')]);

  const got = await new Promise(ok => {
    const chunks = [];
    sock.on('message', function h(m, r) {
      chunks.push(m.slice(4));
      sock.send(Buffer.from([0, 4, m[2], m[3]]), r.port, r.address);
      if (m.length < 516) { sock.removeListener('message', h); ok(Buffer.concat(chunks)); }
    });
    sock.send(rq(1, 'cfg.bin'), srv.port, '127.0.0.1');
  });
  assert.ok(got.equals(big));

  const up = Buffer.alloc(700, 9);
  await new Promise(ok => {
    let block = 0;
    sock.on('message', (m, r) => {
      const n = m.readUInt16BE(2);
      if (n === 2) return setTimeout(ok, 50);
      block = n + 1;
      sock.send(Buffer.concat([Buffer.from([0, 3, 0, block]), up.slice((block - 1) * 512, block * 512)]), r.port, r.address);
    });
    sock.send(rq(2, 'up.bin'), srv.port, '127.0.0.1');
  });
  assert.ok(fs.readFileSync(path.join(root, 'up.bin')).equals(up));
  sock.close(); srv.close();
});

test('tools: ports, probe, passwords, keys', async () => {
  assert.deepEqual(tools.parsePorts('22, 80,100-102'), [22, 80, 100, 101, 102]);
  const s = net.createServer().listen(0, '127.0.0.1');
  await new Promise(r => s.once('listening', r));
  const p = s.address().port;
  assert.deepEqual(await tools.portScan('127.0.0.1', `${p}`), [p]);
  s.close();
  assert.equal(tools.genPassword(32).length, 32);
  const k = tools.genKey('ed25519', { comment: 'me@x' });
  assert.match(k.public, /^ssh-ed25519 .* me@x$/);
  assert.ok(!(utils.parseKey(k.private) instanceof Error));
  assert.throws(() => tools.wol('zz'), /Invalid MAC/);
});

test('monitor output parser', () => {
  const out = '0.10 0.20 0.30 1/100 42\ncpu  100 0 100 800 0 0 0 0\ncpu  150 0 150 850 0 0 0 0\n1000 250\n37%\n12345.6\n2\n500 600\n';
  const m = ssh.parseMonitor(out);
  assert.deepEqual([m.cpu, m.mem, m.disk, m.users, m.load, m.rx], [67, 25, 37, 2, '0.10 0.20 0.30', 500]);
});

const { startSshServer } = require('./fake-sshd');

const read = (stream, until) => new Promise(ok => { let b = ''; const f = d => { b += d; if (b.includes(until)) { stream.removeListener('data', f); ok(b); } }; stream.on('data', f); });

test('ssh: auth, host key TOFU, shell, exec, sftp, tunnels, jump host', async () => {
  const root = path.join(tmp, 'sftp'); fs.mkdirSync(root);
  const srv = await startSshServer(root);
  const port = srv.address().port;
  const base = { host: '127.0.0.1', port, username: 'u', password: 'p' };

  const seen = [];
  const verifyHost = async (hp, fp) => { seen.push([hp, fp]); return true; };
  await assert.rejects(ssh.connect({ ...base, password: 'bad' }), /authentication/i);
  await assert.rejects(ssh.connect(base, { verifyHost: async () => false }), /verif/i);

  const c = await ssh.connect(base, { verifyHost });
  assert.match(seen.at(-1)[1], /^SHA256:/);
  assert.equal(seen.at(-1)[0], `127.0.0.1:${port}`);

  const sh = await ssh.shell(c, { cols: 100, rows: 30 });
  await read(sh, 'welcome');
  sh.write('ls\n');
  assert.match(await read(sh, 'echo:ls'), /echo:ls/);

  assert.equal(await ssh.exec(c, 'uname'), 'ran:uname');

  // sftp
  await ssh.sftpOp(c, 'mkdir', '/dir');
  const local = path.join(tmp, 'up.txt'); fs.writeFileSync(local, 'payload');
  await ssh.sftpOp(c, 'fastPut', local, '/dir/up.txt');
  assert.equal(fs.readFileSync(path.join(root, 'dir', 'up.txt'), 'utf8'), 'payload');
  const ls = await ssh.sftpList(c, '/');
  assert.deepEqual(ls.map(f => [f.name, f.dir]), [['dir', true]]);
  await ssh.sftpOp(c, 'rename', '/dir/up.txt', '/dir/b.txt');
  const dl = path.join(tmp, 'dl.txt');
  await ssh.sftpOp(c, 'fastGet', '/dir/b.txt', dl);
  assert.equal(fs.readFileSync(dl, 'utf8'), 'payload');
  await ssh.sftpOp(c, 'unlink', '/dir/b.txt');
  await ssh.sftpOp(c, 'rmdir', '/dir');
  assert.deepEqual(fs.readdirSync(root), []);

  // a target TCP echo service
  const echo = net.createServer(s => s.pipe(s)).listen(0, '127.0.0.1');
  await new Promise(r => echo.once('listening', r));
  const ePort = echo.address().port;
  const roundtrip = (p, pre) => new Promise((ok, ko) => {
    const s = net.connect(p, '127.0.0.1', () => { if (pre) s.write(pre); s.write('ping'); });
    let b = Buffer.alloc(0); s.on('data', d => { b = Buffer.concat([b, d]); if (b.toString('latin1').endsWith('ping')) { s.destroy(); ok(b); } }); s.on('error', ko);
  });

  const L = await ssh.startTunnel(c, { type: 'L', localPort: 0, remoteHost: '127.0.0.1', remotePort: ePort });
  assert.ok((await roundtrip(L.port)).toString().endsWith('ping'));
  L.close();

  const D = await ssh.startTunnel(c, { type: 'D', localPort: 0 });
  const req = Buffer.concat([Buffer.from([5, 1, 0]), Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, ePort >> 8, ePort & 255])]);
  // send greeting, wait, then CONNECT + data
  const socksOut = await new Promise((ok, ko) => {
    const s = net.connect(D.port, '127.0.0.1', () => s.write(req.slice(0, 3)));
    let stage = 0, b = Buffer.alloc(0);
    s.on('data', d => {
      if (stage === 0) { stage = 1; s.write(req.slice(3)); return; }
      b = Buffer.concat([b, d]);
      if (stage === 1 && b.length >= 10) { stage = 2; b = b.slice(10); s.write('ping'); }
      if (stage === 2 && b.toString().endsWith('ping')) { s.destroy(); ok('ping'); }
    });
    s.on('error', ko);
  });
  assert.equal(socksOut, 'ping');
  D.close();

  // remote forward: server listens on a free port and tunnels it back to the echo service
  const free = await new Promise(r => { const t = net.createServer().listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => r(p)); }); });
  const R = await ssh.startTunnel(c, { type: 'R', remotePort: free, localPort: ePort });
  assert.ok((await roundtrip(free)).toString().endsWith('ping'));
  R.close();

  // jump host: connect to the same server through itself
  const j = await ssh.connect({ ...base, jump: base }, { verifyHost });
  assert.equal(await ssh.exec(j, 'id'), 'ran:id');
  j.end();

  echo.close(); c.end(); srv.close();
});

const BASH = ['C:\\Program Files\\Git\\bin\\bash.exe', '/bin/bash'].find(p => fs.existsSync(p));
test('ssh keys: key kept in the vault (no file) logs in; public key derivation; install like ssh-copy-id', { skip: !BASH && 'needs bash' }, async () => {
  const k = utils.generateKeyPairSync('ed25519', { comment: 'me@pc' });
  const pub = ssh.publicKeyOf(k.private);
  assert.equal(pub, k.public.trim());
  const enc = utils.generateKeyPairSync('ed25519', { passphrase: 'pp', cipher: 'aes256-ctr' });
  assert.throws(() => ssh.publicKeyOf(enc.private), /passphrase/);
  assert.equal(ssh.publicKeyOf(enc.private, 'pp'), enc.public.trim());
  const home = fs.mkdtempSync(path.join(tmp, 'home-'));
  const root = fs.mkdtempSync(path.join(tmp, 'kroot-'));
  const srv = await startSshServer(root, { authorizedKey: k.public, shell: BASH, home: home.replace(/\\/g, '/') });
  const base = { host: '127.0.0.1', port: srv.address().port, username: 'u' };
  // key only from memory (as stored in the vault), no password, no file
  const c = await ssh.connect({ ...base, keyData: k.private });
  // install twice: added, then already present; a file without a trailing newline is repaired first
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.ssh', 'authorized_keys'), 'ssh-rsa AAAAold old@key');
  assert.equal(await ssh.installPublicKey(c, pub), 'added');
  assert.equal(await ssh.installPublicKey(c, pub + '\n'), 'already');
  assert.equal(fs.readFileSync(path.join(home, '.ssh', 'authorized_keys'), 'utf8'), 'ssh-rsa AAAAold old@key\n' + pub + '\n');
  await assert.rejects(ssh.installPublicKey(c, "x'; rm -rf ~"), /Not an OpenSSH public key/);
  c.end(); srv.close();
  // wrong key is refused
  const other = utils.generateKeyPairSync('ed25519');
  const srv2 = await startSshServer(root, { authorizedKey: k.public });
  await assert.rejects(ssh.connect({ host: '127.0.0.1', port: srv2.address().port, username: 'u', keyData: other.private }), /authentication/i);
  srv2.close();
});
