// Network & utility tools: port scan, network sweep, DNS, Wake-on-LAN, key & password generation.
const net = require('net');
const dgram = require('dgram');
const dns = require('dns').promises;
const crypto = require('crypto');
const { utils } = require('ssh2');

function probe(host, port, timeout = 800) {
  return new Promise(ok => {
    const s = net.connect({ host, port });
    const end = r => { s.destroy(); ok(r); };
    s.setTimeout(timeout, () => end(false));
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
  });
}

// "22,80,8000-8010" -> [22,80,8000..8010]
function parsePorts(spec) {
  const out = new Set();
  for (const part of String(spec).split(',').map(s => s.trim()).filter(Boolean)) {
    const [a, b] = part.split('-').map(Number);
    for (let p = a; p <= (b || a) && p <= 65535; p++) if (p > 0) out.add(p);
  }
  return [...out];
}

async function pool(items, n, fn) {
  const res = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; res[k] = await fn(items[k]); } }));
  return res;
}

async function portScan(host, spec, timeout) {
  const ports = parsePorts(spec);
  const open = await pool(ports, 200, p => probe(host, p, timeout));
  return ports.filter((_, i) => open[i]);
}

// prefix "192.168.1" -> hosts answering on any of the given ports
async function netScan(prefix, spec = '22,80,443,445,3389', timeout = 500) {
  const ports = parsePorts(spec);
  const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
  const found = await pool(hosts, 64, async h => {
    const open = (await Promise.all(ports.map(p => probe(h, p, timeout)))).map((o, i) => o && ports[i]).filter(Boolean);
    if (!open.length) return null;
    const name = await dns.reverse(h).then(r => r[0], () => '');
    return { host: h, name, open };
  });
  return found.filter(Boolean);
}

async function dnsLookup(name) {
  const r = {};
  for (const t of ['A', 'AAAA', 'CNAME', 'MX', 'NS', 'TXT']) r[t] = await dns.resolve(name, t).catch(() => []);
  return r;
}

function wol(mac, broadcast = '255.255.255.255') {
  const hex = mac.replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) throw new Error('Invalid MAC');
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(hex, 'hex'))]);
  return new Promise((ok, ko) => {
    const s = dgram.createSocket('udp4');
    s.bind(() => { s.setBroadcast(true); s.send(pkt, 9, broadcast, e => { s.close(); e ? ko(e) : ok(true); }); });
  });
}

function genPassword(length = 20, symbols = true) {
  const set = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789' + (symbols ? '!@#$%^&*()-_=+[]{}' : '');
  return Array.from({ length }, () => set[crypto.randomInt(set.length)]).join('');
}

function genKey(type = 'ed25519', { bits = 4096, comment = '', passphrase = '' } = {}) {
  const opts = { comment };
  if (type === 'rsa') opts.bits = +bits;
  if (passphrase) Object.assign(opts, { passphrase, cipher: 'aes256-ctr' });
  return utils.generateKeyPairSync(type, opts); // { private, public }
}

module.exports = { probe, parsePorts, portScan, netScan, dnsLookup, wol, genPassword, genKey };
