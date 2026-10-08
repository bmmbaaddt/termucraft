// Decrypt MobaXterm-stored passwords, credentials and macros.
// Faithful port of HyperSine/how-does-MobaXterm-encrypt-password (public research).
// Two schemes, matching MobaXterm itself:
//   Safe   — a master password is set: AES-256-CFB8, key = SHA512(masterPw)[0:32], IV = AES-ECB(key, zeros).
//   Classic— no master password: a reversible substitution keyed by SessionP (credentials) or
//            by the connection's user+host plus the PC's user+host (passwords).
const crypto = require('crypto');

const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz+/';
const inAlpha = b => ALPHA.includes(String.fromCharCode(b));

function pad20(buf) { let s = Buffer.from(buf); if (!s.length) throw new Error('empty key seed'); while (s.length < 20) s = Buffer.concat([s, s]); return s; }

// Build the 16-byte substitution key. keySpace = 4 variants (upper/lower of two seeds).
function keyCrafter(keySpace) {
  const key = Buffer.from('0d5e9n1348/U2+67', 'ascii');
  for (let i = 0; i < key.length; i++) {
    const b = keySpace[(i + 1) % keySpace.length][i];
    if (!key.includes(b) && inAlpha(b)) key[i] = b;
  }
  return key;
}
function passwordKey(sysUser, sysHost, connUser, connHost) {
  const s1 = pad20(Buffer.concat([Buffer.from(sysUser), Buffer.from(sysHost)]));
  const s2 = pad20(Buffer.concat([Buffer.from(connUser), Buffer.from(connHost)]));
  return keyCrafter([up(s1), up(s2), lo(s1), lo(s2)]);
}
function credentialKey(sessionP) {
  const s = pad20(Buffer.from(sessionP));
  return keyCrafter([up(s), up(s), lo(s), lo(s)]);
}
const up = b => Buffer.from(b.toString('latin1').toUpperCase(), 'latin1');
const lo = b => Buffer.from(b.toString('latin1').toLowerCase(), 'latin1');

function classicDecrypt(ciphertext, keyInit) {
  let key = Buffer.from(keyInit);
  const ct = [];
  for (const ch of Buffer.from(ciphertext, 'ascii')) if (key.includes(ch)) ct.push(ch); // strip obfuscation chars
  if (ct.length % 2 !== 0) throw new Error('Invalid MobaXterm ciphertext');
  const out = Buffer.alloc(ct.length / 2);
  const rot = () => { key = Buffer.concat([key.slice(-1), key.slice(0, -1)]); };
  for (let i = 0; i < ct.length; i += 2) {
    const l = key.indexOf(ct[i]); rot();
    const hi = key.indexOf(ct[i + 1]); rot();
    if (l < 0 || hi < 0) throw new Error('Invalid MobaXterm ciphertext');
    out[i / 2] = 16 * hi + l;
  }
  return out;
}

// ---- Safe scheme (master password) ----
function safeKey(masterPw) { return crypto.createHash('sha512').update(Buffer.from(masterPw, 'latin1')).digest().subarray(0, 32); }
function safeDecrypt(b64, masterPw) {
  const key = safeKey(masterPw);
  const iv = crypto.createCipheriv('aes-256-ecb', key, null).setAutoPadding(false).update(Buffer.alloc(16));
  const d = crypto.createDecipheriv('aes-256-cfb8', key, iv).setAutoPadding(false);
  return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]);
}
function safeEncrypt(plain, masterPw) { // used only by self-tests
  const key = safeKey(masterPw);
  const iv = crypto.createCipheriv('aes-256-ecb', key, null).setAutoPadding(false).update(Buffer.alloc(16));
  const c = crypto.createCipheriv('aes-256-cfb8', key, iv).setAutoPadding(false);
  return Buffer.concat([c.update(Buffer.from(plain, 'latin1')), c.final()]).toString('base64');
}

// A decoded secret is "plausible" when it is printable text (no control bytes except tab/newline).
const plausible = buf => buf.length > 0 && buf.length < 4096 && ![...buf].some(b => b < 9 || (b > 13 && b < 32) || b === 127);

// High-level: decrypt one stored password. Tries Safe (if master pw given) then Classic.
// ctx: { masterPassword, sessionP, sysUser, sysHost, connUser, connHost }
function decryptSecret(value, ctx, kind = 'password') {
  const tries = [];
  if (ctx.masterPassword) tries.push(() => safeDecrypt(value, ctx.masterPassword));
  // classic paths need non-empty key seeds, or pad20 would spin forever
  if (kind === 'password' && ctx.sysUser && ctx.sysHost && ctx.connHost) tries.push(() => classicDecrypt(value, passwordKey(ctx.sysUser, ctx.sysHost, ctx.connUser || '', ctx.connHost)));
  if (ctx.sessionP) tries.push(() => classicDecrypt(value, credentialKey(ctx.sessionP)));
  for (const t of tries) { try { const r = t(); if (plausible(r)) return r.toString('latin1'); } catch {} }
  throw new Error('Could not decrypt (wrong master password?)');
}

module.exports = { safeKey, safeDecrypt, safeEncrypt, classicDecrypt, passwordKey, credentialKey, decryptSecret, plausible };
