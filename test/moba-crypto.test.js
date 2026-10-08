const test = require('node:test');
const assert = require('node:assert');
const mc = require('../core/moba-crypto');
let vectors; try { vectors = require('./vectors/moba-vectors.json'); } catch {}

test('safe (master password) decrypt matches reference vectors', { skip: !vectors && 'no vectors' }, () => {
  for (const v of vectors.safe) assert.equal(mc.safeDecrypt(v.cipher, v.master).toString('latin1'), v.plain);
});

test('safe encrypt round-trips and matches reference ciphertext', () => {
  for (const v of (vectors ? vectors.safe : [])) assert.equal(mc.safeEncrypt(v.plain, v.master), v.cipher);
  assert.equal(mc.safeDecrypt(mc.safeEncrypt('hunter2!', 'mpw'), 'mpw').toString(), 'hunter2!');
});

test('classic password decrypt matches reference vectors', { skip: !vectors && 'no vectors' }, () => {
  for (const v of vectors.password) {
    const key = mc.passwordKey(v.sysUser, v.sysHost, v.connUser, v.connHost);
    assert.equal(mc.classicDecrypt(v.cipher, key).toString('latin1'), v.plain);
  }
});

test('classic credential decrypt matches reference vectors', { skip: !vectors && 'no vectors' }, () => {
  for (const v of vectors.credential) assert.equal(mc.classicDecrypt(v.cipher, mc.credentialKey(v.sessionP)).toString('latin1'), v.plain);
});

test('decryptSecret picks the right scheme and validates', () => {
  const v = vectors.safe[0];
  assert.equal(mc.decryptSecret(v.cipher, { masterPassword: v.master }), v.plain);
  assert.throws(() => mc.decryptSecret(v.cipher, { masterPassword: v.master + 'x', sysUser: 'a', sysHost: 'b', connHost: 'c' }), /decrypt/);
  const p = vectors.password[0];
  assert.equal(mc.decryptSecret(p.cipher, { sysUser: p.sysUser, sysHost: p.sysHost, connUser: p.connUser, connHost: p.connHost }), p.plain);
  const c = vectors.credential[0];
  assert.equal(mc.decryptSecret(c.cipher, { sessionP: c.sessionP }, 'credential'), c.plain);
});
