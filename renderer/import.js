/* TermuCraft — import wizards for MobaXterm (sessions+passwords+macros) and DBeaver (DB connections+scripts). */
'use strict';

function checkList(items, label) {
  // items: [{ id, html, checked }]. Returns an element with a select-all + rows; .selected() -> ids.
  const el = h(`<div><label class="dim" style="display:block;margin:6px 0 2px"><input type="checkbox" class="all" checked> ${esc(label)} (${items.length})</label><div class="cl" style="max-height:230px;overflow:auto;border:1px solid var(--line);border-radius:6px">${items.map(i => `<label class="item" style="display:flex;gap:8px"><input type="checkbox" data-id="${i.id}" ${i.checked === false ? '' : 'checked'}><span class="name" style="flex:1">${i.html}</span></label>`).join('') || '<p class="dim" style="padding:8px">none</p>'}</div></div>`);
  $('.all', el).onchange = e => $$('[data-id]', el).forEach(c => { c.checked = e.target.checked; });
  el.selected = () => $$('[data-id]', el).filter(c => c.checked).map(c => c.dataset.id);
  return el;
}
const sessionKey = s => `${s.type}|${(s.host || s.command || s.distro || '').toLowerCase()}|${s.port || ''}|${(s.username || '').toLowerCase()}`;

// ---- shared merge helpers (no duplicates on repeated imports) ----
const lcn = s => (s || '').toLowerCase();
const credByName = n => V.credentials.find(c => lcn(c.name) === lcn(n));
// list: [{ name, username, password|undefined }]. overwrite=true replaces an existing password.
function mergeCredentials(list, overwrite) {
  let made = 0, updated = 0;
  for (const x of list) {
    const ex = credByName(x.name);
    if (ex) {
      if (!ex.username && x.username) ex.username = x.username;
      if (x.password !== undefined && (overwrite || !ex.password)) ex.password = x.password;
      updated++;
    } else { V.credentials.push({ id: uid(), name: x.name, username: x.username || '', password: x.password || '' }); made++; }
  }
  return { made, updated };
}
// "[credential name]" usernames -> real username + credentialId (also repairs sessions from older imports)
function linkSessions(extraCreds = []) {
  let linked = 0;
  for (const s of V.sessions) {
    const m = /^\[(.*)\]$/.exec(s.username || '');
    if (m) { s.credentialName = m[1]; const c = credByName(m[1]) || extraCreds.find(x => lcn(x.name) === lcn(m[1])); s.username = c ? c.username || '' : ''; }
    if (s.credentialName) { const c = credByName(s.credentialName); if (c && s.credentialId !== c.id) { s.credentialId = c.id; linked++; } if (c && !s.username) s.username = c.username; }
  }
  return linked;
}
// list: [{ user, host, password }] -> attach to a matching session, else keep as a "user@host" credential
function mergePasswords(list) {
  let attached = 0, made = 0;
  for (const x of list) {
    const match = V.sessions.find(s => !s.credentialId && lcn(s.host) === lcn(x.host) && (!x.user || lcn(s.username) === lcn(x.user)) && ['ssh', 'sftp', 'telnet', 'rdp', 'vnc'].includes(s.type));
    if (match) { match.password = x.password; attached++; continue; }
    const name = x.user ? `${x.user}@${x.host}` : x.host;
    const ex = credByName(name);
    if (ex) ex.password = x.password; else { V.credentials.push({ id: uid(), name, username: x.user || '', password: x.password }); made++; }
  }
  return { attached, made };
}
// list: [{ name, text }] in TermuCraft macro format; same name = update
function mergeMacros(list) {
  let added = 0, updated = 0;
  for (const x of list) {
    const ex = V.macros.find(mm => lcn(mm.name) === lcn(x.name));
    if (ex) { ex.text = x.text; updated++; } else { V.macros.push({ id: uid(), name: x.name, text: x.text }); added++; }
  }
  return { added, updated };
}

// ---------------- MobaXterm export files (Passwords .txt / Macros) ----------------
async function importMobaFiles(paths) {
  let p;
  try { p = await api.call('moba:exportFiles', paths); } catch (e) { return toast(e.message, 'bad'); }
  if (!p) return;
  const credsEl = checkList(p.credentials.map((x, i) => ({ id: String(i), html: `🔑 ${esc(x.name)} <span class="dim">${esc(x.username)}${x.password ? '' : ' · empty password'}${credByName(x.name) ? ' · already here — will update' : ''}</span>` })), 'Credentials (linked to sessions that use them)');
  const pwsEl = checkList(p.passwords.map((x, i) => ({ id: String(i), html: `${esc(x.user ? x.user + '@' : '')}${esc(x.host)}` })), 'Session passwords');
  const macEl = checkList(p.macros.map((x, i) => ({ id: String(i), html: `⏺ ${esc(x.name)} <span class="dim">${esc(x.text.replace(/\n/g, '⏎').slice(0, 50))}${x.unknown.length ? ` · ⚠ ${x.unknown.length} step(s) not converted` : ''}${V.macros.some(m => lcn(m.name) === lcn(x.name)) ? ' · already here — will update' : ''}</span>` })), 'Macros');
  const warn = [
    p.skipped.length ? `${p.skipped.length} line(s) in the password file were not recognised and will be skipped.` : '',
    p.macros.some(x => x.unknown.length) ? 'Some macro steps use keys TermuCraft does not know yet; those steps are left out (check those macros after import).' : '',
  ].filter(Boolean).map(t => `<p class="dim">${esc(t)}</p>`).join('');
  const body = h(`<div><div class="dim">${esc(p.files.join(', '))}</div>${warn}</div>`);
  body.append(credsEl, pwsEl, macEl);
  modal('Import MobaXterm export files', body, [
    { label: 'Cancel' },
    {
      label: 'Import selected', cls: 'primary', onClick: async () => {
        const c = mergeCredentials(credsEl.selected().map(i => p.credentials[+i]), true);
        const linked = linkSessions();
        const pw = mergePasswords(pwsEl.selected().map(i => p.passwords[+i]));
        const mr = mergeMacros(macEl.selected().map(i => p.macros[+i]));
        await save('sessions', 'credentials', 'macros');
        renderSide(); refreshStatus();
        toast(`Imported ${c.made} new / ${c.updated} updated credentials (${linked} sessions linked), ${pw.attached + pw.made} session passwords, ${mr.added} new / ${mr.updated} updated macros. You can now delete the exported password file.`, 'ok');
      },
    },
  ], 'wide');
}

// ---------------- MobaXterm ----------------
async function importMobaFull() {
  const scan = await api.call('moba:scan').catch(() => ({}));
  const body = h(`<div>
    <div class="form">
      <label class="k">Source</label><select class="src"><option value="local" ${scan.iniPath || scan.hasRegistry ? '' : 'disabled'}>This PC's MobaXterm${scan.iniPath || scan.hasRegistry ? '' : ' (not found)'}</option><option value="files">Files copied from another device</option></select>
      <label class="k">MobaXterm master password</label><div class="row"><input type="password" class="mp" placeholder="if you set one in MobaXterm"><button data-reveal type="button">👁</button></div>
    </div>
    <details class="adv"><summary class="dim">Advanced: cross-device without a master password</summary>
      <p class="dim" style="margin:6px 0">If the other MobaXterm had <b>no</b> master password, its per-session passwords are tied to that PC's Windows login. Enter the original device's details:</p>
      <div class="form"><label class="k">Original Windows username</label><input class="ou"><label class="k">Original computer name</label><input class="oh"></div>
    </details>
    <div class="slot"></div></div>`);
  body.querySelector('[data-reveal]').onclick = e => { const i = e.target.previousElementSibling; i.type = i.type === 'password' ? 'text' : 'password'; };
  if (!scan.iniPath && !scan.hasRegistry) $('.src', body).value = 'files';

  const m = modal('Import from MobaXterm', body, [
    { label: 'Help', onClick: () => { mobaHelp(); return false; } },
    { label: 'From exported files…', onClick: () => { importMobaFiles(); } },
    { label: 'Cancel' },
    { label: 'Scan & preview', cls: 'primary', onClick: async (b) => { await preview(b); return false; } },
  ], 'wide');

  async function preview(b) {
    const opts = { source: $('.src', body).value, masterPassword: $('.mp', body).value, origUser: $('.ou', body).value.trim(), origHost: $('.oh', body).value.trim() };
    $('.slot', body).innerHTML = '<p class="dim">Reading…</p>';
    let p; try { p = await api.call('moba:preview', opts); } catch (e) { $('.slot', body).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (!p) { $('.slot', body).innerHTML = ''; return; }
    renderMobaPreview($('.slot', body), p, m);
  }
}

function renderMobaPreview(slot, p, m) {
  const st = p.stats;
  const d = p.diag || {};
  let warn = '';
  if (!st.passwords && !st.macros && !st.credentials) warn = `<p class="err">No saved passwords or macros were found.${d.regExport === false && d.source === 'local' ? ' The registry export returned nothing — if this is the <b>portable</b> MobaXterm, use "Files from another device" and pick its <b>.ini</b> file instead.' : ' If this is the installed edition, make sure MobaXterm is closed and try again.'}</p>`;
  else if (st.passwords && !st.passwordsOk && !st.macrosOk) warn = '<p class="err">Found encrypted data but decrypted none — you almost certainly need to enter your MobaXterm <b>master password</b> above and scan again. (Without it, only passwords created on this same PC can be read.)</p>';
  else if (st.passwords && !st.passwordsOk) warn = '<p class="err">No passwords decrypted — wrong master password, or a no-master-password export from another PC (fill in the Advanced fields).</p>';
  const sess = checkList(p.sessions.map(s => ({ id: s.id, html: `<span class="badge ${s.type}">${s.type}</span> ${esc(s.name)} <span class="dim">${esc((s.username ? s.username + '@' : '') + (s.host || s.command || ''))}${s.credentialName ? ` · 🔑 ${esc(s.credentialName)}` : ''}</span>` })), 'Sessions');
  const pwOk = p.passwords.filter(x => x.ok);
  const pw = checkList(pwOk.map((x, i) => ({ id: String(i), html: `${esc(x.user || '(none)')}@${esc(x.host)} <span class="dim">→ ${'•'.repeat(Math.min(8, x.password.length))}</span>` })), 'Passwords (attached to matching sessions, else saved as credentials)');
  // credentials are useful even without a decrypted password: they carry the real username sessions refer to
  const credOk = p.credentials.filter(x => x.ok || x.username);
  const cred = checkList(credOk.map((x, i) => ({ id: String(i), html: `${esc(x.name)} <span class="dim">${esc(x.username || '')}${x.ok ? '' : ' · password not decrypted'}</span>` })), 'Credentials (linked to the sessions that use them)');
  const macroOk = p.macros.filter(x => x.ok);
  const mac = checkList(macroOk.map((x, i) => ({ id: String(i), html: `${esc(x.name)} <span class="dim">${esc((x.text || '').replace(/\n/g, '⏎').slice(0, 40))}</span>` })), 'Macros');

  slot.replaceChildren(h(`<div><hr><div class="dim">Decrypted: ${st.passwordsOk}/${st.passwords} passwords · ${st.credentialsOk}/${st.credentials} credentials · ${st.macrosOk}/${st.macros} macros</div>${warn}</div>`), sess, pw, cred, mac);
  const foot = m.el.closest('.modal').querySelector('.foot');
  foot.innerHTML = '';
  const cancel = h('<button>Close</button>'); cancel.onclick = () => m.close();
  const imp = h('<button class="primary">Import selected</button>');
  imp.onclick = async () => {
    try {
      imp.disabled = true;
      // credentials first: only fill a missing password from the registry (an export file is authoritative)
      const c = mergeCredentials(cred.selected().map(i => credOk[+i]).map(x => ({ name: x.name, username: x.username, password: x.ok ? x.password : undefined })), false);
      linkSessions(p.credentials);
      const have = new Map(V.sessions.map(s => [sessionKey(s), s]));
      const addedSessions = [];
      for (const id of sess.selected()) {
        const s = p.sessions.find(x => x.id === id); if (!s) continue;
        const k = sessionKey(s);
        if (have.has(k)) continue;
        const ns = { ...s, folder: s.folder ? 'MobaXterm/' + s.folder : 'MobaXterm', monitor: true };
        V.sessions.push(ns); have.set(k, ns); addedSessions.push(ns);
      }
      linkSessions();
      const pwr = mergePasswords(pw.selected().map(i => pwOk[+i]));
      const mr = mergeMacros(mac.selected().map(i => macroOk[+i]).map(x => ({ name: x.name, text: encodeKeys(x.text) })));
      await save('sessions', 'credentials', 'macros');
      renderSide(); refreshStatus();
      const skipped = sess.selected().length - addedSessions.length;
      toast(`Imported ${addedSessions.length} sessions${skipped ? ` (${skipped} already present)` : ''}, ${pwr.attached} passwords, ${c.made + pwr.made} new / ${c.updated} existing credentials, ${mr.added} new / ${mr.updated} updated macros`, 'ok');
      m.close();
    } catch (e) { toast(e.message, 'bad'); imp.disabled = false; }
  };
  foot.append(cancel, imp);
}
function mobaHelp() {
  modal('Importing from another device', h(`<div class="body" style="padding:0"><ol style="line-height:1.7">
    <li>On the other PC, copy <span class="mono">%APPDATA%\\MobaXterm\\MobaXterm.ini</span> (portable edition: the <span class="mono">.ini</span> next to <span class="mono">MobaXterm.exe</span>).</li>
    <li>If MobaXterm is the <b>installed</b> edition, also open a terminal there and run:<br><span class="mono">reg export HKCU\\Software\\Mobatek\\MobaXterm moba.reg</span></li>
    <li>Copy those files here over USB or another private channel — not email/chat — then delete them afterwards.</li>
    <li>Choose <b>Files copied from another device</b>, pick both files, and type the MobaXterm <b>master password</b> if one was set.</li>
    <li>No master password on the other PC? Open Advanced and enter that PC's Windows username and computer name (passwords were tied to them).</li>
  </ol><p class="dim">Everything is decrypted locally and stored in TermuCraft's encrypted vault. Nothing is uploaded.</p></div>`), [{ label: 'Got it', cls: 'primary' }]);
}

// ---------------- DBeaver ----------------
async function importDBeaver() {
  const found = await api.call('dbeaver:scan').catch(() => []);
  const body = h(`<div>
    <div class="form"><label class="k">DBeaver project</label>
      <select class="proj">${found.map((f, i) => `<option value="${i}">${esc(f.label)}</option>`).join('')}<option value="browse">Browse for a folder…</option></select></div>
    <div class="slot"><p class="dim">${found.length ? 'Click Preview to read connections.' : 'No DBeaver workspace found automatically — choose Browse.'}</p></div></div>`);
  const m = modal('Import from DBeaver', body, [{ label: 'Cancel' }, { label: 'Preview', cls: 'primary', onClick: async () => { await prev(); return false; } }], 'wide');
  async function prev() {
    const v = $('.proj', body).value;
    const dir = v === 'browse' || !found.length ? null : found[+v].dir;
    $('.slot', body).innerHTML = '<p class="dim">Reading…</p>';
    let p; try { p = await api.call('dbeaver:preview', dir); } catch (e) { $('.slot', body).innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
    if (!p) { $('.slot', body).innerHTML = ''; return; }
    renderDbeaverPreview($('.slot', body), p, m);
  }
}
const lcs = s => String(s || '').toLowerCase();
const dbKey = d => [d.engine, lcs(d.host), d.port || '', lcs(d.database), lcs(d.user), lcs(d.file)].join('|');
// an already-imported connection: same DBeaver id, or same engine/host/port/database/user/file
const existingDb = d => V.dbs.find(x => (d.dbeaverId && x.dbeaverId === d.dbeaverId) || dbKey(x) === dbKey(d));

function renderDbeaverPreview(slot, p, m) {
  const ok = p.dbs.filter(d => !d.unsupported);
  const dbList = checkList(ok.map((d, i) => ({ id: String(i), html: `<span class="badge db">${d.engine}</span> ${esc(d.name)} <span class="dim">${esc(d.file || `${d.host || '?'}:${d.port || ''}`)}${d.hasPassword ? ' · 🔑' : ''}${d.sshId ? ' · via SSH' : ''}${(d.scripts || []).length ? ` · 📄 ${d.scripts.length} script(s)` : ''}${existingDb(d) ? ' · <b>already imported — will update</b>' : ''}</span>` })), 'Database connections');
  const withScripts = h(`<label style="display:block;margin:8px 0"><input type="checkbox" checked> Import each connection's SQL scripts (${p.stats.linkedScripts || 0}) — they appear under the connection in the DB panel</label>`);
  const ssh = checkList(p.sshSessions.map((s, i) => ({ id: String(i), html: `<span class="badge ssh">ssh</span> ${esc(s.name)} <span class="dim">${esc(s.host)}</span>` })), 'SSH tunnels (added as SSH sessions)');
  const unl = p.unlinkedScripts || [];
  const scripts = checkList(unl.map((s, i) => ({ id: String(i), html: esc(s.rel || s.name), checked: false })), 'SQL scripts not tied to a connection (open in editor)');
  const credWarn = p.credError ? `<p class="err">Could not read saved passwords (${esc(p.credError)}). Connections import without passwords — you'll be asked when connecting.</p>` : '';
  const noPw = p.stats.importable - p.stats.withPassword;
  const pwNote = noPw > 0 ? `<p class="dim">${noPw} connection(s) have no saved password in DBeaver — you'll be asked for it the first time you connect.</p>` : '';
  const unsup = p.stats.unsupported ? `<p class="dim">${p.stats.unsupported} connection(s) use an engine TermuCraft doesn't support and were skipped.</p>` : '';
  slot.replaceChildren(h(`<div><hr><div class="dim">${p.stats.importable} importable · ${p.stats.withPassword} with password · ${p.stats.sshTunnels} SSH tunnels · ${p.stats.linkedScripts || 0} linked scripts</div>${credWarn}${pwNote}${unsup}</div>`), dbList, withScripts, ssh, scripts);
  const foot = m.el.closest('.modal').querySelector('.foot'); foot.innerHTML = '';
  const cancel = h('<button>Close</button>'); cancel.onclick = () => m.close();
  const imp = h('<button class="primary">Import selected</button>');
  imp.onclick = async () => {
    try {
      imp.disabled = true;
      // SSH tunnel sessions (reuse an identical existing session instead of duplicating)
      const sshIds = new Set(ssh.selected());
      const sshMap = {};
      p.sshSessions.forEach((s, i) => {
        if (!sshIds.has(String(i))) return;
        const ex = V.sessions.find(x => sessionKey(x) === sessionKey(s));
        if (ex) sshMap[s.id] = ex.id; else { const ns = { ...s, folder: 'DBeaver' }; V.sessions.push(ns); sshMap[s.id] = ns.id; }
      });
      const chosen = dbList.selected().map(i => ok[+i]);
      // script texts in one call (strings — see dbeaver:scripts)
      const paths = $('input', withScripts).checked ? chosen.flatMap(d => (d.scripts || []).map(s => s.path)) : [];
      const texts = new Map((paths.length ? await api.call('dbeaver:scripts', paths) : []).map(f => [f.path, f.text]));
      let added = 0, updated = 0, nScripts = 0;
      for (const src of chosen) {
        const scs = paths.length ? (src.scripts || []).map(s => ({ id: uid(), name: s.name, sql: texts.get(s.path) || '', database: s.database || '' })) : [];
        nScripts += scs.length;
        const sshId = src.sshId ? sshMap[src.sshId] : undefined;
        const ex = existingDb(src);
        if (ex) {
          if (!ex.password && src.password) ex.password = src.password;
          if (!ex.sshId && sshId) ex.sshId = sshId;
          ex.dbeaverId = ex.dbeaverId || src.dbeaverId;
          ex.scripts = ex.scripts || [];
          for (const s of scs) { const same = ex.scripts.find(x => x.name === s.name); if (same) same.sql = s.sql; else ex.scripts.push(s); }
          updated++;
          continue;
        }
        const d = { ...src, scripts: scs };
        for (const k of ['provider', 'driver', 'unsupported', 'hasPassword', 'ok']) delete d[k];
        if (sshId) d.sshId = sshId; else delete d.sshId;
        V.dbs.push(d); added++;
      }
      await save('dbs', 'sessions');
      if (added || updated) { sideMode = 'db'; $('#side').classList.remove('collapsed'); }
      renderSide(); refreshStatus();
      const scSel = scripts.selected();
      if (scSel.length && (scSel.length <= 15 || await confirmBox(`Open ${scSel.length} scripts in editor tabs?`))) {
        const files = await api.call('dbeaver:scripts', scSel.map(i => unl[+i].path));
        files.forEach(f => openEditor({ title: f.name, text: f.text, path: f.path }));
      }
      toast(`DBeaver: ${added} new, ${updated} updated connection(s), ${nScripts} script(s), ${Object.keys(sshMap).length} SSH session(s)`, 'ok');
      m.close();
    } catch (e) { toast(e.message, 'bad'); imp.disabled = false; }
  };
  foot.append(cancel, imp);
}
