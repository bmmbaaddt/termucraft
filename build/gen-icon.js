// Generate a 256x256 PNG app icon (no dependencies): blue rounded square with a white ">_" prompt.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const N = 256;
const buf = Buffer.alloc(N * N * 4);
const bg = [0x1b, 0x1d, 0x23], accent = [0x3b, 0x82, 0xf6], white = [0xf2, 0xf4, 0xf8];
const put = (x, y, c, a = 255) => { if (x < 0 || y < 0 || x >= N || y >= N) return; const i = (y * N + x) * 4; buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = a; };
const r = 48;
const inRound = (x, y) => { const dx = Math.max(r - x, x - (N - 1 - r), 0), dy = Math.max(r - y, y - (N - 1 - r), 0); return dx * dx + dy * dy <= r * r; };
for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) put(x, y, accent, inRound(x, y) ? 255 : 0);
// ">" chevron
const thick = 16;
for (let t = 0; t < 70; t++) for (let w = 0; w < thick; w++) {
  put(70 + t + w, 78 + t, white); put(70 + t + w, 178 - t, white);
}
// "_" underscore
for (let x = 150; x < 205; x++) for (let w = 0; w < thick; w++) put(x, 168 + w, white);

// PNG encode
const raw = Buffer.alloc((N * 4 + 1) * N);
for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; buf.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
const crc = b => { let c = ~0; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c) >>> 0; };
const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const t = Buffer.from(type); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
fs.writeFileSync(path.join(__dirname, '..', 'renderer', 'icon.png'), png);
console.log('icon.png written', png.length, 'bytes');
