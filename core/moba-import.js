// Build a TermuCraft import preview from a MobaXterm.ini and/or a registry export (.reg).
// Decrypts passwords, credentials and macros with core/moba-crypto. Pure (no fs / no IPC) so it is unit-testable.
const { parseMobaIni } = require('./moba');
const mc = require('./moba-crypto');

// --- .reg parsing (UTF-16 text already decoded to a JS string) ---
// Returns { 'HKEY...\\Sub': { valueName: stringValue } }. Only REG_SZ values are kept.
function parseReg(text) {
  const out = {}; let cur = null;
  const lines = text.replace(/\\\r?\n\s*/g, '').split(/\r?\n/); // join line-continuations
  for (const line of lines) {
    const sec = /^\[(.+)\]$/.exec(line.trim());
    if (sec) { cur = out[sec[1]] = out[sec[1]] || {}; continue; }
    if (!cur) continue;
    const m = /^"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"$/.exec(line.trim());
    if (m) cur[unesc(m[1])] = unesc(m[2]);
  }
  return out;
}
const unesc = s => s.replace(/\\(.)/g, (_, c) => c);

const regSub = (reg, leaf) => {
  const key = Object.keys(reg).find(k => k.replace(/\\$/, '').toLowerCase().endsWith('\\mobaxterm\\' + leaf));
  return key ? reg[key] : {};
};

// Parse the [Passwords]/[Macros] sections of an ini into { name: value } maps.
function iniSection(text, name) {
  const out = {}; let inside = false;
  for (const raw of (text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { inside = line.toLowerCase() === `[${name.toLowerCase()}]`; continue; }
    if (inside && line.includes('=')) { const i = line.indexOf('='); out[line.slice(0, i)] = line.slice(i + 1); }
  }
  return out;
}

// Password entry name -> { proto, port, user, host }. e.g. "ssh22:paas@localhost", "paas@localhost", "user@host"
function parsePwName(name) {
  const m = /^(?:([a-z]+)(\d+)?:)?([^@]*)@(.+)$/i.exec(name);
  if (!m) return { user: '', host: name };
  return { proto: m[1], port: m[2], user: m[3], host: m[4] };
}

// Macro value -> base64 body candidates (format seen: "XX:/<base64>").
function macroCandidates(v) {
  const out = [v];
  const slash = v.indexOf(':/'); if (slash >= 0) out.push(v.slice(slash + 2));
  const colon = v.indexOf(':'); if (colon >= 0) out.push(v.slice(colon + 1));
  return out;
}

// opts: { ini, reg, masterPassword, origUser, origHost }
// Returns { sessions, passwords:[{name,user,host,password,ok}], credentials:[{name,username,password,ok}],
//           macros:[{name,text,ok}], stats, needMaster, needIdentity }
function buildPreview(opts) {
  const reg = opts.reg ? parseReg(opts.reg) : {};
  const pwMap = { ...regSub(reg, 'p'), ...iniSection(opts.ini, 'Passwords') };
  const credMap = regSub(reg, 'c');
  const macroMap = { ...regSub(reg, 'm'), ...iniSection(opts.ini, 'Macros') };
  const sessionP = (regSub(reg, '') || {}).SessionP || iniSection(opts.ini, '').SessionP;
  const ctxBase = { masterPassword: opts.masterPassword, sessionP, sysUser: opts.origUser, sysHost: opts.origHost };

  const sessions = opts.ini ? parseMobaIni(opts.ini) : [];

  const passwords = Object.entries(pwMap).map(([name, value]) => {
    const p = parsePwName(name);
    const r = { name, user: p.user, host: p.host, proto: p.proto, port: p.port };
    try { r.password = mc.decryptSecret(value, { ...ctxBase, connUser: p.user, connHost: p.host }); r.ok = true; }
    catch (e) { r.ok = false; r.error = e.message; }
    return r;
  });

  // Credentials: "username:ciphertext" — the username is plain text, so it is known even when the
  // password can't be decrypted (no/wrong master password).
  const credentials = Object.entries(credMap).map(([name, value]) => {
    const colon = value.indexOf(':');
    const r = { name, username: colon > 0 ? value.slice(0, colon) : '', ok: false };
    for (const ct of colon > 0 ? [value.slice(colon + 1), value] : [value]) {
      try { r.password = mc.decryptSecret(ct, ctxBase, 'credential'); r.ok = true; break; } catch {}
    }
    if (!r.ok) r.error = 'Could not decrypt password';
    return r;
  });

  // Sessions that use a stored credential carry "[credential name]" in the username field:
  // resolve the real username and remember which credential to link on import.
  const credByName = new Map(credentials.map(c => [c.name.toLowerCase(), c]));
  for (const s of sessions) {
    const m = /^\[(.*)\]$/.exec(s.username || '');
    if (!m) continue;
    s.credentialName = m[1];
    const c = credByName.get(m[1].toLowerCase());
    s.username = c ? c.username : '';
  }

  const macros = Object.entries(macroMap).filter(([k]) => k).map(([name, value]) => {
    const r = { name };
    for (const cand of macroCandidates(value)) {
      try { const t = mc.decryptSecret(cand, { masterPassword: opts.masterPassword, sessionP }, 'credential'); r.text = t; r.ok = true; break; } catch {}
    }
    if (!r.ok) { r.raw = value; r.error = 'Could not decrypt'; }
    return r;
  });

  const anyEncrypted = Object.keys(pwMap).length + Object.keys(credMap).length + Object.keys(macroMap).length > 0;
  const decrypted = passwords.filter(p => p.ok).length + credentials.filter(c => c.ok).length;
  return {
    sessions, passwords, credentials, macros,
    stats: { sessions: sessions.length, passwords: passwords.length, passwordsOk: passwords.filter(p => p.ok).length,
      credentials: credentials.length, credentialsOk: credentials.filter(c => c.ok).length, linkedSessions: sessions.filter(s => s.credentialName).length,
      macros: macros.length, macrosOk: macros.filter(m => m.ok).length },
    needMaster: anyEncrypted && !opts.masterPassword && decrypted === 0 && Object.keys(pwMap).length > 0 && !sessionP && !opts.origUser,
    sessionPFound: !!sessionP,
  };
}

module.exports = { buildPreview, parseReg, parsePwName, iniSection, macroCandidates };
