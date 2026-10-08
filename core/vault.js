// Encrypted store for everything the app persists: sessions, credentials, macros, tunnels, settings.
// AES-256-GCM, key = scrypt(master password). The whole file is one sealed blob.
const crypto = require('crypto');
const fs = require('fs');

const empty = () => ({ sessions: [], credentials: [], macros: [], tunnels: [], dbs: [], dbHistory: [], dbDrivers: [], knownHosts: {}, settings: {} });
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

class Vault {
  constructor(file) { this.file = file; this.key = null; this.data = null; }
  exists() { return fs.existsSync(this.file); }

  create(password) {
    if (!password) throw new Error('Master password required');
    this.salt = crypto.randomBytes(16);
    this.key = crypto.scryptSync(password, this.salt, 32, KDF);
    this.data = empty();
    this.save();
  }

  unlock(password) {
    const box = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const salt = Buffer.from(box.salt, 'base64');
    const key = crypto.scryptSync(password, salt, 32, KDF);
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    let plain;
    try { plain = Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()]); }
    catch { throw new Error('Wrong master password'); }
    this.salt = salt; this.key = key;
    this.data = { ...empty(), ...JSON.parse(plain.toString('utf8')) };
  }

  save(data) {
    if (!this.key) throw new Error('Vault locked');
    if (data) this.data = { ...empty(), ...data };
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(this.data), 'utf8'), c.final()]);
    const b = x => x.toString('base64');
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, salt: b(this.salt), iv: b(iv), tag: b(c.getAuthTag()), ct: b(ct) }));
    fs.renameSync(tmp, this.file); // atomic replace, never leaves a half-written vault
  }

  changePassword(password) {
    if (!password) throw new Error('Master password required');
    this.salt = crypto.randomBytes(16);
    this.key = crypto.scryptSync(password, this.salt, 32, KDF);
    this.save();
  }
}

module.exports = { Vault };
