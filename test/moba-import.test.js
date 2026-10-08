const test = require('node:test');
const assert = require('node:assert');
const imp = require('../core/moba-import');
const mc = require('../core/moba-crypto');

const MP = 'MyMaster1';
const enc = s => mc.safeEncrypt(s, MP);

test('parseReg parses a MobaXterm .reg export', () => {
  const reg = `Windows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Software\\Mobatek\\MobaXterm]\r\n"SessionP"="abc"\r\n\r\n[HKEY_CURRENT_USER\\Software\\Mobatek\\MobaXterm\\P]\r\n"root@10.0.0.1"="${enc('secret1')}"\r\n"ssh22:bob@host"="${enc('p@ss:2')}"\r\n`;
  const r = imp.parseReg(reg);
  assert.ok(Object.keys(r).some(k => k.endsWith('MobaXterm\\P')));
});

test('buildPreview decrypts passwords, credentials and macros with master password', () => {
  const reg = [
    '[HKEY_CURRENT_USER\\Software\\Mobatek\\MobaXterm\\P]',
    `"root@10.0.0.1"="${enc('secret1')}"`,
    `"ssh22:bob@host.example"="${enc('p@ss2')}"`,
    '[HKEY_CURRENT_USER\\Software\\Mobatek\\MobaXterm\\C]',
    `"prod-db"="dbuser:${enc('dbpass')}"`,
    `"plain"="${enc('justpass')}"`,
    '[HKEY_CURRENT_USER\\Software\\Mobatek\\MobaXterm\\M]',
    `"deploy"="AA:/${enc('cd /srv\ndeploy.sh\n')}"`,
  ].join('\r\n');
  const ini = ['[Bookmarks]', 'SubRep=', 'ImgNum=42',
    'web=#109#0%10.0.0.1%22%root%%-1%-1%%%%%0%0%0%%%-1%0#MobaFont#0# #-1'].join('\r\n');

  const p = imp.buildPreview({ ini, reg, masterPassword: MP });
  assert.deepEqual(p.stats, { sessions: 1, passwords: 2, passwordsOk: 2, credentials: 2, credentialsOk: 2, linkedSessions: 0, macros: 1, macrosOk: 1 });
  const root = p.passwords.find(x => x.host === '10.0.0.1');
  assert.deepEqual([root.user, root.password], ['root', 'secret1']);
  assert.equal(p.passwords.find(x => x.host === 'host.example').password, 'p@ss2');
  const prod = p.credentials.find(c => c.name === 'prod-db');
  assert.deepEqual([prod.username, prod.password], ['dbuser', 'dbpass']);
  assert.equal(p.credentials.find(c => c.name === 'plain').password, 'justpass');
  assert.equal(p.macros[0].text, 'cd /srv\ndeploy.sh\n');
  void mc;
});

test('sessions using a stored credential get the real username, even without a master password', () => {
  const ini = ['[Bookmarks]', 'SubRep=', 'ImgNum=42',
    'web node=#109#0%10.0.0.7%22%[web cred]%%-1%-1%%%%%0%0%0%%%-1%0#MobaFont#0# #-1',
    'other=#109#0%10.0.0.8%22%[missing cred]%%-1%-1%%%%%0%0%0%%%-1%0#MobaFont#0# #-1'].join('\r\n');
  const reg = `[HKEY_CURRENT_USER\\Software\\Mobatek\\MobaXterm\\C]\r\n"web cred"="alice:${enc('alicepw')}"`;
  const withMp = imp.buildPreview({ ini, reg, masterPassword: MP });
  const s = withMp.sessions.find(x => x.host === '10.0.0.7');
  assert.deepEqual([s.username, s.credentialName], ['alice', 'web cred']);
  assert.equal(withMp.credentials[0].password, 'alicepw');
  assert.equal(withMp.stats.linkedSessions, 2);
  // unknown credential: username must not stay as "[missing cred]"
  assert.equal(withMp.sessions.find(x => x.host === '10.0.0.8').username, '');
  // no master password: password unknown, but username still resolved from the plaintext prefix
  const noMp = imp.buildPreview({ ini, reg });
  assert.equal(noMp.sessions.find(x => x.host === '10.0.0.7').username, 'alice');
  assert.deepEqual([noMp.credentials[0].username, noMp.credentials[0].ok], ['alice', false]);
});

test('empty identity does not hang (regression): classic path is skipped, not looped', () => {
  // no master password and no origUser/origHost — must finish, not spin in pad20
  const reg = `[HKEY_CURRENT_USER\\Software\\Mobatek\\MobaXterm\\P]\r\n"root@10.0.0.1"="${enc('x')}"`;
  const p = imp.buildPreview({ reg });
  assert.equal(p.passwords[0].ok, false);
  assert.throws(() => mc.passwordKey('', '', 'root', 'h'), /empty/);
  assert.throws(() => mc.decryptSecret('abcd', { sysUser: '', sysHost: '', connHost: 'h' }), /decrypt/);
});

test('buildPreview flags wrong master password without crashing', () => {
  const reg = `[HKEY_CURRENT_USER\\Software\\Mobatek\\MobaXterm\\P]\r\n"root@h"="${enc('secret')}"`;
  const p = imp.buildPreview({ reg, masterPassword: 'wrong' });
  assert.equal(p.stats.passwordsOk, 0);
  assert.equal(p.passwords[0].ok, false);
});

test('buildPreview parses ini [Passwords] section (portable MobaXterm)', () => {
  const ini = `[Passwords]\r\nuser@portable="${enc('portpw')}"\r\n`;
  const p = imp.buildPreview({ ini, masterPassword: MP });
  assert.equal(p.passwords[0].password, 'portpw');
});

test('classic password import (no master password) via original identity', () => {
  const ct = mc.classicDecrypt; // sanity: build a classic ciphertext using the key then decrypt
  const key = mc.passwordKey('winuser', 'WINPC', 'root', '10.0.0.1');
  // encrypt manually with the same substitution (reuse reference via round-trip on known plaintext)
  // Easiest: ensure decrypt of a value our own encrypt would produce. We emulate encrypt:
  const plain = 'classicPW';
  // build ciphertext by inverse of classicDecrypt (no obfuscation chars)
  let k = Buffer.from(key); const out = [];
  for (const ch of Buffer.from(plain, 'latin1')) {
    const l = ch & 0x0f, hi = ch >> 4;
    out.push(k[l]); k = Buffer.concat([k.slice(-1), k.slice(0, -1)]);
    out.push(k[hi]); k = Buffer.concat([k.slice(-1), k.slice(0, -1)]);
  }
  const cipher = Buffer.from(out).toString('latin1');
  const reg = `[HKEY_CURRENT_USER\\Software\\Mobatek\\MobaXterm\\P]\r\n"root@10.0.0.1"="${cipher}"`;
  const p = imp.buildPreview({ reg, origUser: 'winuser', origHost: 'WINPC' });
  assert.equal(p.passwords[0].password, plain);
});
