// Embedded servers: HTTP file server and TFTP (read + write), both rooted at a folder.
const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');

// Resolve a client-supplied path inside root; null if it escapes.
function safeJoin(root, p) {
  const full = path.resolve(root, '.' + path.posix.normalize('/' + p.replace(/\\/g, '/')));
  return full === path.resolve(root) || full.startsWith(path.resolve(root) + path.sep) ? full : null;
}

const esc = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function httpServer({ root, port = 8080, bind = '0.0.0.0', log = () => {} }) {
  const srv = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    const file = safeJoin(root, url);
    log(`HTTP ${req.socket.remoteAddress} ${req.method} ${url}`);
    if (!file || req.method !== 'GET') { res.writeHead(403); return res.end('Forbidden'); }
    fs.stat(file, (e, st) => {
      if (e) { res.writeHead(404); return res.end('Not found'); }
      if (st.isDirectory()) {
        const base = url.endsWith('/') ? url : url + '/';
        const items = fs.readdirSync(file, { withFileTypes: true })
          .map(d => `<li><a href="${esc(encodeURI(base + d.name))}${d.isDirectory() ? '/' : ''}">${esc(d.name)}${d.isDirectory() ? '/' : ''}</a></li>`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<h3>${esc(url)}</h3><ul><li><a href="../">../</a></li>${items.join('')}</ul>`);
      }
      res.writeHead(200, { 'content-length': st.size, 'content-type': 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
  });
  return new Promise((ok, ko) => { srv.once('error', ko); srv.listen(port, bind, () => ok({ port: srv.address().port, close: () => srv.close() })); });
}

// TFTP (RFC 1350), octet/netascii treated as binary. Each transfer gets its own socket (TID).
// ponytail: fixed 512-byte blocks, no blksize option; add RFC 2348 if transfers of big images are slow.
function tftpServer({ root, port = 69, bind = '0.0.0.0', allowWrite = true, log = () => {} }) {
  const main = dgram.createSocket('udp4');
  const err = (code, msg) => Buffer.concat([Buffer.from([0, 5, 0, code]), Buffer.from(msg + '\0')]);

  main.on('message', (msg, rinfo) => {
    const op = msg.readUInt16BE(0);
    const [name] = msg.slice(2).toString().split('\0');
    const file = safeJoin(root, name);
    const s = dgram.createSocket('udp4');
    const send = b => s.send(b, rinfo.port, rinfo.address);
    s.bind(0, bind === '0.0.0.0' ? undefined : bind);
    log(`TFTP ${rinfo.address} ${op === 1 ? 'GET' : 'PUT'} ${name}`);
    if (!file || (op !== 1 && op !== 2) || (op === 2 && !allowWrite)) { send(err(2, 'Access violation')); return setTimeout(() => s.close(), 100); }

    let timer, tries = 0, last, finished = false;
    const arm = () => { clearTimeout(timer); if (!finished) timer = setTimeout(() => (++tries > 5 ? done() : (send(last), arm())), 1000); };
    // linger briefly so the final ACK flushes and a duplicate last block still gets re-ACKed
    const done = () => { clearTimeout(timer); if (!finished) { finished = true; setTimeout(() => { try { s.close(); } catch {} }, 500); } };
    const sendArm = b => { last = b; tries = 0; send(b); arm(); };

    if (op === 1) {
      let data;
      try { data = fs.readFileSync(file); } catch { send(err(1, 'File not found')); return setTimeout(done, 100); }
      let block = 1;
      const blockBuf = n => Buffer.concat([Buffer.from([0, 3, (n >> 8) & 255, n & 255]), data.slice((n - 1) * 512, n * 512)]);
      sendArm(blockBuf(block));
      s.on('message', m => {
        if (m.readUInt16BE(0) !== 4 || m.readUInt16BE(2) !== (block & 0xffff)) return;
        if ((block - 1) * 512 + 512 > data.length) return done(); // last (short) block acked
        sendArm(blockBuf(++block));
      });
    } else {
      const chunks = []; let expect = 1;
      sendArm(Buffer.from([0, 4, 0, 0]));
      s.on('message', m => {
        if (m.readUInt16BE(0) !== 3) return;
        const n = m.readUInt16BE(2);
        if (n === (expect & 0xffff)) { chunks.push(m.slice(4)); expect++; }
        send(Buffer.from([0, 4, n >> 8, n & 255]));
        arm();
        if (n === ((expect - 1) & 0xffff) && m.length - 4 < 512) { fs.writeFileSync(file, Buffer.concat(chunks)); done(); }
      });
    }
  });
  return new Promise((ok, ko) => { main.once('error', ko); main.bind(port, bind, () => ok({ port: main.address().port, close: () => main.close() })); });
}

module.exports = { httpServer, tftpServer, safeJoin };
