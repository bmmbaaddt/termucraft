// In-process SSH/SFTP server used by the tests and the app smoke test.
const fs = require('fs');
const path = require('path');
const net = require('net');
const { Server, utils } = require('ssh2');

// opts.authorizedKey: a public key (OpenSSH line or parsed) that may log in as "u" with public-key auth
function startSshServer(sftpRoot, opts = {}) {
  const allowed = opts.authorizedKey && utils.parseKey(opts.authorizedKey);
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const srv = new Server({ hostKeys: [hostKey] }, client => {
    client.on('error', () => {});
    client.on('authentication', ctx => {
      if (ctx.method === 'password' && ctx.username === 'u' && ctx.password === 'p') return ctx.accept();
      if (ctx.method === 'publickey' && allowed && ctx.username === 'u' && ctx.key.algo === allowed.type && ctx.key.data.equals(allowed.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept(); // key check before signing
        if (allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true) return ctx.accept();
      }
      ctx.reject(allowed ? ['password', 'publickey'] : ['password']);
    });
    client.on('ready', () => {
      client.on('tcpip', (accept, reject, info) => {
        const s = net.connect(info.destPort, info.destIP, () => { const ch = accept(); ch.pipe(s).pipe(ch); });
        s.on('error', () => reject());
      });
      client.on('request', (accept, reject, name, info) => {
        if (name !== 'tcpip-forward') return reject();
        const ls = net.createServer(sock => client.forwardOut(info.bindAddr, info.bindPort, sock.remoteAddress, sock.remotePort, (e, ch) => e ? sock.destroy() : sock.pipe(ch).pipe(sock)));
        ls.listen(info.bindPort || 0, '127.0.0.1', () => accept(ls.address().port));
        client.on('close', () => ls.close());
      });
      client.on('session', accept => {
        const session = accept();
        session.on('pty', a => a && a());
        session.on('shell', a => { const st = a(); st.write('welcome\r\n'); st.on('data', d => st.write('echo:' + d)); });
        session.on('exec', (a, _r, info) => {
          const st = a();
          if (!opts.shell) { st.write('ran:' + info.command); st.exit(0); return st.end(); }
          // opts.shell = a real bash, HOME = opts.home: lets tests run genuine shell commands (authorized_keys install)
          const p = require('child_process').spawn(opts.shell, ['-c', info.command], { env: { ...process.env, HOME: opts.home }, windowsHide: true });
          p.stdout.pipe(st, { end: false }); p.stderr.pipe(st.stderr, { end: false });
          p.on('close', code => { st.exit(code || 0); st.end(); });
        });
        session.on('sftp', a => serveSftp(a(), sftpRoot));
      });
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

function serveSftp(sftp, root) {
  const { STATUS_CODE: S, OPEN_MODE: M } = utils.sftp;
  const handles = new Map(); let next = 0;
  const real = p => path.join(root, p.replace(/^\/+/, ''));
  const attrs = st => ({ mode: st.mode, size: st.size, uid: 0, gid: 0, atime: st.atime / 1000 | 0, mtime: st.mtime / 1000 | 0 });
  const h = v => { const b = Buffer.alloc(4); b.writeUInt32BE(next); handles.set(next++, v); return b; };
  const get = b => handles.get(b.readUInt32BE(0));
  const ok = (id, fn) => { try { fn(); sftp.status(id, S.OK); } catch { sftp.status(id, S.FAILURE); } };
  sftp.on('REALPATH', (id, p) => sftp.name(id, [{ filename: path.posix.resolve('/', p), longname: '', attrs: {} }]));
  sftp.on('STAT', (id, p) => { try { sftp.attrs(id, attrs(fs.statSync(real(p)))); } catch { sftp.status(id, S.NO_SUCH_FILE); } });
  sftp.on('LSTAT', (id, p) => { try { sftp.attrs(id, attrs(fs.statSync(real(p)))); } catch { sftp.status(id, S.NO_SUCH_FILE); } });
  sftp.on('OPENDIR', (id, p) => sftp.handle(id, h({ dir: real(p), done: false })));
  sftp.on('READDIR', (id, hb) => {
    const d = get(hb); if (d.done) return sftp.status(id, S.EOF); d.done = true;
    sftp.name(id, fs.readdirSync(d.dir).map(n => { const st = fs.statSync(path.join(d.dir, n)); return { filename: n, longname: `${st.isDirectory() ? 'd' : '-'}rw-r--r-- 1 u u ${st.size} Jan 1 00:00 ${n}`, attrs: attrs(st) }; }));
  });
  sftp.on('OPEN', (id, p, flags) => { try { sftp.handle(id, h({ fd: fs.openSync(real(p), flags & M.WRITE ? (flags & M.APPEND ? 'a' : 'w') : 'r') })); } catch { sftp.status(id, S.NO_SUCH_FILE); } });
  sftp.on('READ', (id, hb, off, len) => { const b = Buffer.alloc(len); const n = fs.readSync(get(hb).fd, b, 0, len, off); n ? sftp.data(id, b.slice(0, n)) : sftp.status(id, S.EOF); });
  sftp.on('WRITE', (id, hb, off, data) => ok(id, () => fs.writeSync(get(hb).fd, data, 0, data.length, off)));
  sftp.on('FSTAT', (id, hb) => sftp.attrs(id, attrs(fs.fstatSync(get(hb).fd))));
  sftp.on('FSETSTAT', id => sftp.status(id, S.OK));
  sftp.on('SETSTAT', id => sftp.status(id, S.OK));
  sftp.on('CLOSE', (id, hb) => { const x = get(hb); if (x && x.fd !== undefined) fs.closeSync(x.fd); handles.delete(hb.readUInt32BE(0)); sftp.status(id, S.OK); });
  sftp.on('MKDIR', (id, p) => ok(id, () => fs.mkdirSync(real(p))));
  sftp.on('REMOVE', (id, p) => ok(id, () => fs.unlinkSync(real(p))));
  sftp.on('RMDIR', (id, p) => ok(id, () => fs.rmdirSync(real(p))));
  sftp.on('RENAME', (id, a, b) => ok(id, () => fs.renameSync(real(a), real(b))));
}

module.exports = { startSshServer };
