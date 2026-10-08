/* TermuCraft — database workbench (uses helpers from app.js) */
'use strict';
const ENGINES = { postgres: 'PostgreSQL', mysql: 'MySQL / MariaDB', oracle: 'Oracle', mssql: 'SQL Server', sqlite: 'SQLite', odbc: 'Other (ODBC)' };
// Custom database types (DBeaver's "Driver Manager"): an ODBC driver the USER installed + a connection-string template.
// TermuCraft never downloads drivers. Presets only pre-fill the template for well-known drivers.
const dbType = d => d && d.engine === 'odbc' && d.driverId ? (V.dbDrivers || []).find(t => t.id === d.driverId) : null;
const dbTemplate = d => (dbType(d) || {}).template || d.connectionString || '';
// SQL flavor used to generate SQL (quoting, LIMIT/TOP/FETCH FIRST, literals) for a connection
const sqlFlavor = d => d.engine === 'odbc' ? ((dbType(d) || {}).flavor || d.flavor || 'ansi') : d.engine;
const needsDbPassword = d => d.engine === 'sqlite' ? false : d.engine === 'odbc' ? /\{password\}/.test(dbTemplate(d)) : true;
const FLAVOR_OPTS = [['postgres', 'Standard: "quotes" + LIMIT n'], ['mysql', 'MySQL-like: `quotes` + LIMIT n'], ['mssql', 'SQL Server / Access-like: [quotes] + TOP n'], ['oracle', 'Oracle / DB2-like: "quotes" + FETCH FIRST n ROWS'], ['ansi', 'Plain: "quotes", no limit clause']];
const ODBC_PRESETS = [
  { name: 'IBM Db2', driver: /db2/i, template: 'Driver={%D};Database={database};Hostname={host};Port={port};Protocol=TCPIP;Uid={user};Pwd={password};', port: 50000, flavor: 'oracle' },
  { name: 'Snowflake', driver: /snowflake/i, template: 'Driver={%D};Server={host};Database={database};Uid={user};Pwd={password};', port: 443, flavor: 'postgres', explain: 'EXPLAIN' },
  { name: 'ClickHouse', driver: /clickhouse/i, template: 'Driver={%D};Host={host};Port={port};Database={database};Username={user};Password={password};', port: 8123, flavor: 'postgres', explain: 'EXPLAIN' },
  { name: 'Teradata', driver: /teradata/i, template: 'Driver={%D};DBCName={host};Database={database};Uid={user};Pwd={password};', port: 1025, flavor: 'ansi', explain: 'EXPLAIN' },
  { name: 'Informix', driver: /informix/i, template: 'Driver={%D};Host={host};Service={port};Server=<informix server name>;Database={database};Uid={user};Pwd={password};Protocol=onsoctcp;', port: 9088, flavor: 'ansi' },
  { name: 'SAP HANA', driver: /hdbodbc|hana/i, template: 'Driver={%D};ServerNode={host}:{port};DatabaseName={database};Uid={user};Pwd={password};', port: 30015, flavor: 'postgres' },
  { name: 'Firebird', driver: /firebird/i, template: 'Driver={%D};Dbname={host}/{port}:{database};Uid={user};Pwd={password};', port: 3050, flavor: 'ansi' },
  { name: 'Vertica', driver: /vertica/i, template: 'Driver={%D};Servername={host};Port={port};Database={database};Uid={user};Pwd={password};', port: 5433, flavor: 'postgres', explain: 'EXPLAIN' },
  { name: 'MS Access file', driver: /access driver \(\*\.mdb/i, template: 'Driver={%D};Dbq={file};Uid={user};Pwd={password};', flavor: 'mssql', fileKind: 'file' },
  { name: 'Excel workbook', driver: /excel driver/i, template: 'Driver={%D};Dbq={file};ReadOnly=1;', flavor: 'mssql', fileKind: 'file' },
  { name: 'CSV / text folder', driver: /text driver/i, template: 'Driver={%D};Dbq={file};Extensions=csv,txt,tab;', flavor: 'mssql', fileKind: 'dir' },
];

const ENV_COLORS = { dev: 'var(--ok)', test: 'var(--warn)', prod: 'var(--bad)' };

function dbFields(engine, vals = {}) {
  const creds = [['', '— none —'], ...V.credentials.map(c => [c.id, `${c.name} (${c.username || ''})`])];
  const sshs = [['', '— direct connection —'], ...V.sessions.filter(s => s.type === 'ssh').map(s => [s.id, s.name])];
  const common = [['name', 'Connection name'], ['folder', 'Folder']];
  const safety = [['heading', 'Safety'], ['env', 'Environment', 'select', 'dev', [['dev', 'Development'], ['test', 'Test'], ['prod', 'Production (confirm every write)']]], ['readOnly', 'Read-only connection (writes are refused)', 'check']];
  if (engine === 'sqlite') return [...common, ['file', 'Database file', 'file'], ...safety];
  if (engine === 'odbc') {
    const type = dbType(vals), tpl = type ? type.template : '';
    const uses = k => !type || tpl.includes(`{${k}}`);
    return [...common,
      ...(type ? [['heading', `${type.name} — ODBC driver "${type.driver || '?'}"`]] : [['connectionString', 'ODBC connection string. Placeholders: {host} {port} {database} {user} {password} {file}', 'textarea', 'Driver={…};Server={host};Port={port};Database={database};Uid={user};Pwd={password};'],
        ['flavor', 'SQL flavor (quoting / row limits)', 'select', 'ansi', FLAVOR_OPTS], ['explainPrefix', 'Explain command (optional, e.g. EXPLAIN)']]),
      ...(uses('host') ? [['host', 'Host', 'text', 'localhost']] : []), ...(uses('port') ? [['port', 'Port', 'number', type && type.port || '']] : []),
      ...(uses('database') ? [['database', 'Database']] : []), ...(uses('file') ? [['file', type && type.fileKind === 'dir' ? 'Folder' : 'File', type && type.fileKind === 'dir' ? 'dir' : 'file']] : []),
      ...(uses('user') ? [['user', 'Username']] : []), ...(uses('password') ? [['password', 'Password', 'password'], ['credentialId', 'Or saved credential', 'select', '', creds]] : []),
      ...(uses('host') ? [['heading', 'Network'], ['sshId', 'Connect through SSH session (needs {host} and {port} in the template)', 'select', '', sshs]] : []),
      ...safety];
  }
  const port = { postgres: 5432, mysql: 3306, oracle: 1521, mssql: 1433 }[engine];
  const dbLabel = engine === 'oracle' ? 'Service name (or :SID)' : 'Database';
  return [...common, ['host', 'Host', 'text', 'localhost'], ['port', 'Port', 'number', port], ['database', dbLabel], ['user', 'Username'], ['password', 'Password', 'password'], ['credentialId', 'Or saved credential', 'select', '', creds],
    ['heading', 'Network'], ['sshId', 'Connect through SSH session (host is resolved on the SSH server)', 'select', '', sshs], ['ssl', 'Use SSL/TLS', 'check'], ['sslVerify', 'Verify server certificate', 'check', true], ['timeout', 'Query timeout (seconds, 0 = none)', 'number', 0],
    ...safety];
}

function editDb(d = null) {
  let engine = d ? d.engine : 'postgres';
  let vals = d ? { ...d } : {};
  const key = () => engine === 'odbc' && vals.driverId ? 'odbc:' + vals.driverId : engine;
  const body = h(`<div><div class="types"></div><div class="slot"></div></div>`);
  const draw = () => {
    $('.types', body).innerHTML = Object.entries(ENGINES).map(([k, l]) => `<button data-t="${k}">${l}</button>`).join('')
      + (V.dbDrivers || []).map(t => `<button data-t="odbc:${t.id}" title="ODBC driver: ${esc(t.driver || '')}">${esc(t.name)}</button>`).join('')
      + '<button data-t="drivers" title="Add other database types (DBeaver-style driver manager)">⚙ Database types…</button>';
    $$('.types button', body).forEach(b => b.classList.toggle('on', b.dataset.t === key()));
    $('.slot', body).replaceChildren(form(dbFields(engine, vals), vals));
  };
  $('.types', body).onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    vals = { ...vals, ...readForm($('.slot', body)) };
    if (b.dataset.t === 'drivers') return driverManager(() => draw());
    const [eng, id] = b.dataset.t.split(':');
    engine = eng; vals.driverId = id || ''; delete vals.port; draw();
  };
  draw();
  const collect = () => {
    const v = readForm($('.slot', body));
    const out = { ...(d || { id: uid() }), ...vals, ...v, engine, driverId: engine === 'odbc' ? vals.driverId || '' : undefined };
    if (engine === 'odbc' ? !dbTemplate(out) : engine === 'sqlite' ? !v.file : !v.host) throw new Error(engine === 'odbc' ? 'Enter an ODBC connection string or pick a database type' : engine === 'sqlite' ? 'Choose a database file' : 'Host is required');
    const t = dbType(out);
    out.name = v.name || (engine === 'sqlite' || (engine === 'odbc' && !v.host && v.file) ? String(v.file).split(/[\\/]/).filter(Boolean).pop() : `${v.user ? v.user + '@' : ''}${v.host || (t ? t.name : 'odbc')}/${v.database || ''}`);
    return out;
  };
  const store = () => {
    const out = collect();
    const i = V.dbs.findIndex(x => x.id === out.id); i >= 0 ? (V.dbs[i] = out) : V.dbs.push(out);
    save('dbs'); renderSide(); return out;
  };
  modal(d ? `Edit database — ${d.name}` : 'New database connection', body, [
    { label: 'Test connection', onClick: async () => { const c = collect(); delete c.id; await api.call('db:test', c); toast('Connection OK', 'ok'); return false; } },
    { label: 'Cancel' },
    { label: 'Save', onClick: () => { store(); } },
    { label: 'Save & open', cls: 'primary', onClick: () => { openDb(store()); } },
  ], 'wide');
}

// DBeaver-style driver manager: database types backed by an ODBC driver installed on this PC (nothing is downloaded).
async function driverManager(onChange = () => {}) {
  let installed = [];
  try { installed = await api.call('odbc:drivers'); } catch {}
  const body = h(`<div><p class="dim" style="margin-top:0">Add a database type by picking an <b>ODBC driver installed on this PC</b> (64-bit). Get the driver from the database vendor's site and install it yourself — TermuCraft never downloads anything.</p><div class="list"></div>
    <p class="dim" style="margin-bottom:0">ODBC drivers installed: ${installed.length ? installed.map(x => `<span class="badge">${esc(x)}</span>`).join(' ') : 'none found'}</p></div>`);
  const draw = () => {
    $('.list', body).innerHTML = (V.dbDrivers || []).map(t => `<div class="item" data-id="${t.id}"><span class="name"><b>${esc(t.name)}</b> <span class="dim">${esc(t.driver || '')}${installed.length && t.driver && !installed.includes(t.driver) ? ' — <span style="color:var(--bad)">driver not installed here</span>' : ''}</span></span><span class="acts" style="display:flex"><button data-a="edit">✎</button><button data-a="del" class="danger">✕</button></span></div>`).join('')
      || '<p class="dim">No custom database types yet.</p>';
  };
  draw();
  const edit = async (t = null) => {
    const presetOf = drv => ODBC_PRESETS.find(p => p.driver.test(drv || ''));
    const r = await ask(t ? `Edit database type — ${t.name}` : 'Add database type', [
      ['name', 'Name (shown in the connection dialog)'],
      ['driver', 'ODBC driver (as installed on this PC)', 'datalist', '', installed],
      ['heading', 'Leave the template empty to fill it from a known preset (Db2, Snowflake, ClickHouse, Teradata, Informix, SAP HANA, Firebird, Vertica, Access, Excel, CSV) when the driver name matches.'],
      ['template', 'Connection string template — placeholders {host} {port} {database} {user} {password} {file}', 'textarea'],
      ['port', 'Default port', 'number'],
      ['flavor', 'SQL flavor (quoting / row limits)', 'select', 'ansi', FLAVOR_OPTS],
      ['explain', 'Explain command (optional, e.g. EXPLAIN)'],
      ['fileKind', 'File field', 'select', '', [['', 'File (if the template uses {file})'], ['dir', 'Folder']]],
    ], t || {}, 'Save');
    if (!r) return;
    if (!r.driver) return toast('Pick the ODBC driver', 'bad');
    const p = presetOf(r.driver);
    const out = { ...(t || { id: uid() }), ...r, name: r.name || (p ? p.name : r.driver) };
    if (!out.template && p) Object.assign(out, { template: p.template.replace('%D', r.driver), port: r.port || p.port || '', flavor: p.flavor, explain: r.explain || p.explain || '', fileKind: r.fileKind || p.fileKind || '' });
    if (!out.template) out.template = `Driver={${r.driver}};Server={host};Port={port};Database={database};Uid={user};Pwd={password};`;
    V.dbDrivers = V.dbDrivers || [];
    const i = V.dbDrivers.findIndex(x => x.id === out.id); i >= 0 ? (V.dbDrivers[i] = out) : V.dbDrivers.push(out);
    await save('dbDrivers'); draw(); onChange();
  };
  $('.list', body).onclick = async e => {
    const a = e.target.dataset.a; if (!a) return;
    const t = V.dbDrivers.find(x => x.id === e.target.closest('.item').dataset.id);
    if (a === 'edit') return edit(t);
    const used = V.dbs.filter(x => x.driverId === t.id).length;
    if (a === 'del' && await confirmBox(`Delete database type "${t.name}"?${used ? ` ${used} connection(s) use it and will stop working.` : ''}`)) { V.dbDrivers = V.dbDrivers.filter(x => x !== t); await save('dbDrivers'); draw(); onChange(); }
  };
  modal('Database types (ODBC drivers)', body, [{ label: '＋ Add database type', onClick: () => { edit(); return false; } }, { label: 'Close', cls: 'primary' }], 'wide');
}

// connection status from open DB tabs: 'up' (connected), 'down' (last attempt failed), '' (not connected)
const dbTabs = d => tabs.filter(t => t.kind === 'db' && t.db && t.db.id === d.id);
const dbStatus = d => { const ts = dbTabs(d); return ts.some(t => t.status === 'up') ? 'up' : ts.some(t => t.status === 'wait') ? 'wait' : ts.length ? 'down' : ''; };
const dbExpanded = new Set();
let dbFilter = '';

function renderDbSide(body) {
  const f = dbFilter.toLowerCase();
  const match = d => !f || `${d.name} ${d.host || ''} ${d.database || ''} ${d.file || ''} ${(d.scripts || []).map(s => s.name).join(' ')}`.toLowerCase().includes(f);
  const list = V.dbs.filter(match);
  const connected = list.filter(d => dbStatus(d) === 'up' || dbStatus(d) === 'wait');
  const rest = list.filter(d => !connected.includes(d));
  const conn = d => {
    const st = dbStatus(d), sc = d.scripts || [];
    const open = dbExpanded.has(d.id) || (f && sc.some(s => s.name.toLowerCase().includes(f)));
    return `<details class="dbconn" data-id="${d.id}" ${open ? 'open' : ''}><summary class="item" title="${esc(d.engine === 'sqlite' ? d.file : `${d.host}:${d.port || ''}${d.database ? '/' + d.database : ''}`)} — double-click to open">
      <span class="dot ${st}" title="${{ up: 'Connected', wait: 'Connecting…', down: 'Connection failed', '': 'Not connected' }[st]}"></span>
      <span class="badge db">${d.engine === 'postgres' ? 'pg' : d.engine === 'odbc' ? esc(((dbType(d) || {}).name || 'odbc').slice(0, 10)) : d.engine}</span>
      <span class="name">${esc(d.name)}${sc.length ? ` <span class="dim">(${sc.length})</span>` : ''}</span>
      ${d.env === 'prod' ? '<span class="badge" style="color:var(--bad)">prod</span>' : ''}${d.readOnly ? '<span class="badge">ro</span>' : ''}
      <span class="acts"><button data-a="newscript" title="New SQL script">＋</button><button data-a="edit" title="Edit">✎</button><button data-a="dup" title="Duplicate">⧉</button><button data-a="del" class="danger" title="Delete">✕</button></span></summary>
      <div class="scripts">${sc.map(s => `<div class="item script" data-s="${s.id}" title="Open in a SQL editor on this connection${s.database ? ' (' + esc(s.database) + ')' : ''}"><span>📄</span><span class="name">${esc(s.name)}</span><span class="acts"><button data-a="rens" title="Rename">✎</button><button data-a="dels" class="danger" title="Delete script">✕</button></span></div>`).join('') || '<div class="dim" style="padding:2px 8px 4px 26px;font-size:12px">No scripts — click ＋ to add one</div>'}</div></details>`;
  };
  const byFolder = ds => {
    const g = {}; for (const d of ds) (g[d.folder || ''] = g[d.folder || ''] || []).push(d);
    return Object.keys(g).sort().map(k => k ? `<details class="folder" open><summary>${esc(k)} <span class="dim">(${g[k].length})</span></summary><div>${g[k].map(conn).join('')}</div></details>` : g[k].map(conn).join('')).join('');
  };
  $('#sidehead').innerHTML = `<span>Databases</span><span class="grow"></span><span style="text-transform:none;letter-spacing:0;font-weight:400">${connected.length} connected · ${V.dbs.length}</span>`;
  body.innerHTML = `<div class="quick"><button id="dbnew" class="grow">＋ New</button><button id="dbimp" title="Import connections + scripts from DBeaver">⇣ DBeaver</button></div>
    <div class="quick"><input id="dbfilter" placeholder="Filter connections & scripts…" value="${esc(dbFilter)}"></div>
    ${!V.dbs.length ? '<p class="dim">PostgreSQL, MySQL/MariaDB, Oracle, SQL Server, SQLite, and any other database with an ODBC driver (⚙ Database types in the connection dialog). Connections can go through any saved SSH session, can be read-only or production, and their passwords are stored in the encrypted vault.</p>' : ''}
    ${connected.length ? `<div class="dbsec">● Connected (${connected.length})</div>${connected.map(conn).join('')}` : ''}
    ${rest.length ? `<div class="dbsec">○ Not connected (${rest.length})</div>${byFolder(rest)}` : ''}
    ${V.dbs.length && !list.length ? '<p class="dim">No match</p>' : ''}`;
  $('#dbnew').onclick = () => editDb();
  $('#dbimp').onclick = () => importDBeaver();
  $('#dbfilter').oninput = e => { dbFilter = e.target.value; const pos = e.target.selectionStart; renderSide(); const i = $('#dbfilter'); i.focus(); i.setSelectionRange(pos, pos); };
  for (const det of $$('details.dbconn', body)) det.addEventListener('toggle', () => det.open ? dbExpanded.add(det.dataset.id) : dbExpanded.delete(det.dataset.id));
  body.onclick = async e => {
    const a = e.target.dataset.a; if (!a) return;
    e.preventDefault(); // don't toggle the <details> when an action button is clicked
    const d = V.dbs.find(x => x.id === e.target.closest('details.dbconn').dataset.id);
    const sEl = e.target.closest('.script'); const s = sEl && (d.scripts || []).find(x => x.id === sEl.dataset.s);
    if (a === 'edit') editDb(d);
    if (a === 'dup') { V.dbs.push({ ...d, id: uid(), name: d.name + ' (copy)', dbeaverId: undefined, scripts: (d.scripts || []).map(x => ({ ...x, id: uid() })) }); save('dbs'); renderSide(); }
    if (a === 'del' && await confirmBox(`Delete connection "${d.name}" and its ${(d.scripts || []).length} script(s)?`)) { V.dbs = V.dbs.filter(x => x !== d); save('dbs'); renderSide(); }
    if (a === 'newscript') { const r = await ask(`New script — ${d.name}`, [['n', 'Script name']], { n: `Script-${(d.scripts || []).length + 1}.sql` }); if (r && r.n) { const ns = { id: uid(), name: r.n, sql: '' }; (d.scripts = d.scripts || []).push(ns); dbExpanded.add(d.id); await save('dbs'); renderSide(); openScript(d, ns); } }
    if (a === 'rens' && s) { const r = await ask('Rename script', [['n', 'Name']], { n: s.name }); if (r && r.n) { s.name = r.n; await save('dbs'); renderSide(); tabs.filter(t => t.script === s).forEach(t => { t.title = `${d.name} · ${s.name}`; }); renderTabs(); } }
    if (a === 'dels' && s && await confirmBox(`Delete script "${s.name}"?`)) { d.scripts = d.scripts.filter(x => x !== s); await save('dbs'); renderSide(); }
  };
  body.ondblclick = e => {
    if (e.target.dataset.a) return;
    const det = e.target.closest('details.dbconn'); if (!det) return;
    const d = V.dbs.find(x => x.id === det.dataset.id);
    const sEl = e.target.closest('.script');
    if (sEl) return openScript(d, d.scripts.find(x => x.id === sEl.dataset.s));
    e.preventDefault();
    const existing = dbTabs(d).find(t => !t.script && t.status !== 'down');
    existing ? activate(existing) : openDb(d);
  };
  body.oncontextmenu = e => {
    const det = e.target.closest('details.dbconn'); if (!det) return;
    e.preventDefault();
    const d = V.dbs.find(x => x.id === det.dataset.id);
    const sEl = e.target.closest('.script');
    if (sEl) return scriptMenu(e, d, d.scripts.find(x => x.id === sEl.dataset.s));
    dbMenu(e, d);
  };
  // single click on a script opens it too (like DBeaver's navigator)
  for (const el of $$('.script', body)) el.addEventListener('click', e => { if (e.target.dataset.a) return; const d = V.dbs.find(x => x.id === el.closest('details.dbconn').dataset.id); openScript(d, d.scripts.find(x => x.id === el.dataset.s)); });
}

const dbUrl = d => d.engine === 'sqlite' ? d.file : `${d.engine}://${d.user ? d.user + '@' : ''}${d.host}:${d.port || ''}${d.database ? '/' + d.database : ''}`;
const persistDbs = () => { save('dbs'); renderSide(); };

function dbMenu(e, d) {
  const open = dbTabs(d);
  ctxMenu(e, [
    ['▶ Open SQL editor', () => { const t = open.find(x => !x.script && x.status !== 'down'); t ? activate(t) : openDb(d); }],
    ['＋ New script…', async () => { const r = await ask(`New script — ${d.name}`, [['n', 'Script name']], { n: `Script-${(d.scripts || []).length + 1}.sql` }); if (r && r.n) { const ns = { id: uid(), name: r.n, sql: '' }; (d.scripts = d.scripts || []).push(ns); dbExpanded.add(d.id); persistDbs(); openScript(d, ns); } }],
    ...(open.length ? [['■ Disconnect (close its tabs)', async () => { for (const t of open) await closeTab(t); renderSide(); }]] : []),
    '-',
    ['✎ Edit connection…', () => editDb(d)],
    ['Rename…', async () => { const r = await ask('Rename connection', [['n', 'Name']], { n: d.name }); if (r && r.n) { d.name = r.n; persistDbs(); } }],
    ['Move to folder…', async () => { const r = await ask('Move to folder', [['f', 'Folder (empty = top level)']], { f: d.folder || '' }); if (r) { d.folder = r.f; persistDbs(); } }],
    [d.readOnly ? 'Allow writes (turn off read-only)' : 'Make read-only', async () => { if (d.readOnly && !(await confirmBox(`Allow write statements on "${d.name}"?`))) return; d.readOnly = !d.readOnly; persistDbs(); toast(`${d.name}: ${d.readOnly ? 'read-only' : 'writes allowed'} (applies to newly opened tabs)`); }],
    ['⧉ Duplicate', () => { V.dbs.push({ ...d, id: uid(), name: d.name + ' (copy)', dbeaverId: undefined, scripts: (d.scripts || []).map(x => ({ ...x, id: uid() })) }); persistDbs(); }],
    '-',
    ['Copy connection URL', () => copyText(dbUrl(d))],
    ...(d.host ? [['Copy host', () => copyText(d.host)]] : []),
    ...(d.password ? [['Forget saved password', async () => { if (await confirmBox(`Forget the saved password of "${d.name}"?`)) { delete d.password; persistDbs(); } }]] : []),
    '-',
    ['✕ Delete', async () => { if (await confirmBox(`Delete connection "${d.name}" and its ${(d.scripts || []).length} script(s)?`)) { V.dbs = V.dbs.filter(x => x !== d); persistDbs(); } }],
  ]);
}

function scriptMenu(e, d, s) {
  if (!s) return;
  ctxMenu(e, [
    ['▶ Open', () => openScript(d, s)],
    ['Rename…', async () => { const r = await ask('Rename script', [['n', 'Name']], { n: s.name }); if (r && r.n) { s.name = r.n; persistDbs(); tabs.filter(t => t.script === s).forEach(t => { t.title = `${d.name} · ${s.name}`; }); renderTabs(); } }],
    ['⧉ Duplicate', () => { d.scripts.push({ ...s, id: uid(), name: s.name.replace(/(\.sql)?$/i, ' (copy)$1') }); persistDbs(); }],
    ['Copy SQL', () => copyText(s.sql || '', 'SQL copied')],
    ['Save to .sql file…', async () => { const p = await api.call('file:save', null, s.sql || ''); if (p) toast('Saved ' + p, 'ok'); }],
    '-',
    ['✕ Delete', async () => { if (await confirmBox(`Delete script "${s.name}"?`)) { d.scripts = d.scripts.filter(x => x !== s); persistDbs(); } }],
  ]);
}

function openScript(d, s) {
  const open = tabs.find(t => t.kind === 'db' && t.script === s);
  return open ? activate(open) : openDb(d, s.database || undefined, s);
}

// ---------------- DB tab ----------------
// script: optional { id, name, sql, database } saved on the connection (DBeaver-style); Ctrl+S saves back to it
async function openDb(d, database, script = null) {
  const SQLX = sqlFlavor(d); // engine name for SQL generation (custom ODBC types borrow a flavor)
  const pane = h(`<div class="pane dbpane">
    <div class="dbnav"><div class="quick"><select class="dbsel" title="Database"></select><button data-a="refresh" title="Refresh schema">⟳</button><button data-a="er" title="ER diagram of the listed tables (filter first to narrow it)">ER</button></div>
      <input class="tfilter" placeholder="Filter tables…" style="width:100%;margin-bottom:6px"><div class="tree dim">Loading schema…</div></div>
    <div class="vsplit" title="Drag to resize"></div>
    <div class="dbmain">
      <div class="edbar"><span class="envtag" style="background:${ENV_COLORS[d.env || 'dev']}">${esc((d.env || 'dev').toUpperCase())}${d.readOnly ? ' · READ-ONLY' : ''}</span>
        <button data-a="run" class="primary" title="Run selection or statement at cursor (Ctrl+Enter)">▶ Run</button>
        <button data-a="runnew" title="Run into a new result tab, keeping the current results (Ctrl+\\)">▶ New tab</button>
        <button data-a="script" title="Run whole script (Alt+X)">▶▶ Script</button>
        <button data-a="cancel" title="Cancel running query">■ Cancel</button>
        <button data-a="explain" title="Execution plan of the statement at the cursor (Ctrl+Shift+E)">Explain</button>
        <button data-a="format" title="Format the selection or the whole script (Ctrl+Shift+F)">Format</button>
        <button data-a="tx" class="txbtn" title="Switch between auto-commit and manual commit (transactions)">Auto-commit</button>
        <button data-a="commit" hidden title="Commit the transaction">✔ Commit</button><button data-a="rollback" hidden title="Roll back the transaction">↶ Rollback</button>
        <button data-a="savescript" title="Save as a script on this connection (Ctrl+S)">💾 Save</button>
        <button data-a="history" title="Query history">History</button><button data-a="save" title="Save the editor text to a .sql file">⤓ .sql</button><button data-a="open" title="Load a .sql file into the editor">⤒ .sql</button>
        <span class="grow"></span><label class="dim" title="Word wrap in the SQL editor (Alt+Z)"><input type="checkbox" class="sqlwrapchk"> Wrap</label><label class="dim">Max rows <input class="lim" type="number" value="${+S().dbRowLimit || 200}" style="width:80px"></label></div>
      <div class="sqlwrap"></div>
      <div class="hsplit" title="Drag to resize"></div>
      <div class="results"><div class="rtabs"></div>
        <div class="rbar"><input class="wfilter" hidden placeholder="WHERE …  (Enter: filter on the server)" title="Server-side filter, e.g.  status = 'active' AND id > 100"><input class="ofilter" hidden placeholder="ORDER BY …" title="Server-side sort, e.g.  created_at DESC">
          <input class="rfilter" placeholder="Find in rows…" title="Filters the rows already loaded"><label class="dim" title="Show long and multi-line values wrapped inside the cells"><input type="checkbox" class="cellwrapchk"> Wrap cells</label><span class="grow"></span>
          <span class="edits" hidden><button data-x="addrow" title="Add a row">＋ Row</button><button data-x="delrow" title="Delete the selected rows (click row numbers to select)">− Row</button><button data-x="saveedits" class="primary" title="Save changes to the database">💾 Save</button><button data-x="revert" title="Discard unsaved changes">Revert</button></span>
          <button data-x="export" title="Export rows to CSV / JSON / SQL — shown rows, first N, or all">⤓ Export…</button><button data-x="copy" title="Copy shown rows as TSV">Copy</button></div>
        <div class="grid"><p class="dim" style="padding:10px">Ctrl+Enter runs the statement under the cursor (or the selection). Ctrl+Space autocompletes tables and columns. Double-click a table in the tree to view its data.</p></div>
        <div class="rstatus dim"></div></div>
    </div></div>`);
  const tab = { id: uid(), kind: 'db', title: script ? `${d.name} · ${script.name}` : d.name + (database ? ` [${database}]` : ''), pane, status: 'wait', db: d, script, results: [], cur: 0 };
  const cm = CodeMirror($('.sqlwrap', pane), {
    value: String((script && script.sql) || ''), mode: { postgres: 'text/x-pgsql', mysql: 'text/x-mariadb', mssql: 'text/x-mssql', oracle: 'text/x-plsql', sqlite: 'text/x-sqlite' }[d.engine] || 'text/x-sql',
    lineNumbers: true, matchBrackets: true, indentUnit: 2, theme: S().appTheme === 'light' ? 'default' : 'material-darker',
    extraKeys: { 'Ctrl-Enter': async () => run(await currentSql()), 'Alt-X': () => run(cm.getValue()), 'Ctrl-Space': 'autocomplete', 'Ctrl-F': 'findPersistent', 'Ctrl-S': () => saveScript(),
      'Shift-Ctrl-E': () => explain(), 'Shift-Ctrl-F': () => formatSql(), 'Ctrl-\\': async () => run(await currentSql(), { append: true }) },
    hintOptions: { hint: (c, o) => sqlHint(c, o), tables: {}, completeSingle: false },
  });
  cm.setSize('100%', '100%');
  // word wrap: SQL editor and result cells, each remembered across tabs and restarts
  const pref = (k, v) => { try { if (v === undefined) return localStorage[k] === '1'; localStorage[k] = v ? '1' : '0'; } catch {} return false; };
  const setSqlWrap = on => { cm.setOption('lineWrapping', on); $('.sqlwrapchk', pane).checked = on; pref('mxc.sqlWrap', on); };
  const setCellWrap = on => { $('.grid', pane).classList.toggle('wrap', on); $('.cellwrapchk', pane).checked = on; pref('mxc.cellWrap', on); if (tab.results && tab.results.length) drawGrid(); };
  $('.sqlwrapchk', pane).onchange = e => setSqlWrap(e.target.checked);
  $('.cellwrapchk', pane).onchange = e => setCellWrap(e.target.checked);
  cm.addKeyMap({ 'Alt-Z': () => setSqlWrap(!cm.getOption('lineWrapping')) });
  // Autocomplete like DBeaver: tables, table./alias. columns, keywords (sql-hint), plus bare column names of the
  // tables the statement uses; pops up by itself while typing.
  let hintTables = {};
  function sqlHint(c, o) {
    const res = CodeMirror.hint.sql(c, o) || { list: [], from: c.getCursor(), to: c.getCursor() };
    const cur = c.getCursor(), tok = c.getTokenAt(cur);
    if (!/^[\w$]+$/.test(tok.string)) return res;
    const stmt = currentBlock().text.toLowerCase(), w = tok.string.toLowerCase();
    const used = Object.keys(hintTables).filter(n => { const i = stmt.indexOf(n.toLowerCase()); return i >= 0 && !/[\w$]/.test(stmt[i - 1] || '') && !/[\w$]/.test(stmt[i + n.length] || ''); });
    const have = new Set(res.list.map(x => typeof x === 'string' ? x : x.text));
    const cols = [...new Set(used.flatMap(n => hintTables[n]))].filter(x => x.toLowerCase().startsWith(w) && x.toLowerCase() !== w && !have.has(x));
    return cols.length ? { list: [...cols, ...res.list], from: CodeMirror.Pos(cur.line, tok.start), to: CodeMirror.Pos(cur.line, tok.end) } : res;
  }
  cm.on('inputRead', (c, ch) => {
    if (c.state.completionActive || ch.origin !== '+input' || ch.text.length > 1) return;
    const typed = ch.text[0], type = c.getTokenAt(c.getCursor()).type || '';
    if (/string|comment/.test(type)) return;
    const before = c.getLine(ch.from.line).slice(0, ch.from.ch + 1);
    if (typed === '.' || (/^[\w$]$/.test(typed) && /(^|[^\w$])[\w$]{2}$/.test(before))) c.showHint({ completeSingle: false });
  });
  tab.cm = cm;
  splitter($('.vsplit', pane), $('.dbnav', pane), 'x', 'mxc.dbNavW', 120);
  splitter($('.hsplit', pane), $('.sqlwrap', pane), 'y', 'mxc.sqlH', 60, () => cm.refresh());
  cm.on('change', () => { if (!tab.dirty) { tab.dirty = true; renderTabs(); } });
  new ResizeObserver(() => cm.refresh()).observe($('.sqlwrap', pane));
  addTab(tab);
  const sideRefresh = () => { renderTabs(); if (sideMode === 'db') renderSide(); };

  async function saveScript() {
    if (!tab.script) {
      const r = await ask(`Save script on ${d.name}`, [['n', 'Script name']], { n: `Script-${(d.scripts || []).length + 1}.sql` });
      if (!r || !r.n) return;
      tab.script = { id: uid(), name: r.n, database: database || '' };
      (d.scripts = d.scripts || []).push(tab.script);
      tab.title = `${d.name} · ${r.n}`; dbExpanded.add(d.id);
    }
    tab.script.sql = cm.getValue();
    await save('dbs');
    tab.dirty = false; sideRefresh(); toast(`Saved script "${tab.script.name}"`, 'ok');
  }

  // connect; ask for the password when none is saved or the server rejects it
  async function connectTab(password) {
    tab.status = 'wait'; sideRefresh();
    try {
      const r = await api.call('db:open', { id: d.id, database, password });
      tab.connId = r.id; tab.status = 'up'; sideRefresh();
      tab.tx = { manual: false, pending: 0 }; drawTx(); // a new connection starts in auto-commit
      return true;
    } catch (e) {
      tab.status = 'down'; sideRefresh();
      $('.tree', pane).classList.remove('dim');
      $('.tree', pane).innerHTML = `<p class="err" style="white-space:pre-wrap">${esc(e.message)}</p><button data-a="reconnect">⟳ Connect again</button>`;
      if (needsDbPassword(d) && /password|authenticat|access denied|login failed|ORA-01017|28P01|28000|no pg_hba|SASL/i.test(e.message)) {
        const r = await ask(`Password for ${d.user || '(user)'} @ ${d.name}`, [['password', 'Password', 'password'], ['save', 'Save password in vault', 'check', true]], {}, 'Connect');
        if (r) { if (r.save) { d.password = r.password; await save('dbs'); } return connectTab(r.password); }
      } else toast(e.message, 'bad');
      return false;
    }
  }

  let schema = [], objects = [];
  async function loadSchema() {
    $('.tree', pane).textContent = 'Loading schema…';
    try { schema = await api.call('db:schema', tab.connId); } catch (e) { $('.tree', pane).textContent = e.message; return; }
    const tables = {};
    for (const t of schema) { tables[t.name] = t.columns.map(c => c.name); if (t.schema) tables[`${t.schema}.${t.name}`] = tables[t.name]; }
    hintTables = tables;
    api.call('db:objects', tab.connId).then(o => { objects = o || []; drawTree(); }).catch(() => { objects = []; });
    cm.setOption('hintOptions', { hint: (c, o) => sqlHint(c, o), tables, completeSingle: false });
    drawTree();
  }
  function drawTree() {
    const f = $('.tfilter', pane).value.toLowerCase();
    const bySchema = {};
    schema.filter(t => !f || t.name.toLowerCase().includes(f)).forEach((t, i) => (bySchema[t.schema] = bySchema[t.schema] || []).push([t, schema.indexOf(t)]));
    const objsOf = {};
    objects.forEach((o, i) => { if (f && !o.name.toLowerCase().includes(f)) return; (objsOf[o.schema] = objsOf[o.schema] || []).push([o, i]); bySchema[o.schema] = bySchema[o.schema] || []; });
    const KIND = { FUNCTION: ['ƒ', 'Functions'], PROCEDURE: ['⚙', 'Procedures'], PACKAGE: ['📦', 'Packages'], SEQUENCE: ['#', 'Sequences'], TRIGGER: ['⚡', 'Triggers'] };
    const objFolders = s => Object.keys(KIND).map(k => { const list = (objsOf[s] || []).filter(([o]) => o.type === k); return list.length ? `<details class="folder"><summary>${KIND[k][1]} <span class="dim">(${list.length})</span></summary><div>${list.map(([o, i]) => `<div class="obj" data-o="${i}" title="Double-click: show source">${KIND[k][0]} ${esc(o.name)}</div>`).join('')}</div></details>` : ''; }).join('');
    const multi = Object.keys(bySchema).length > 1;
    $('.tree', pane).classList.remove('dim');
    $('.tree', pane).innerHTML = Object.entries(bySchema).map(([s, ts]) => {
      const items = ts.map(([t, i]) => `<details class="tbl"><summary data-i="${i}" title="Double-click: view data">${t.type === 'VIEW' ? '👁' : '▦'} ${esc(t.name)}<span class="acts"><button data-t="data" data-i="${i}" title="View data">▤</button><button data-t="ddl" data-i="${i}" title="DDL">DDL</button><button data-t="count" data-i="${i}" title="Row count">#</button></span></summary>
        <div>${t.columns.map(c => `<div class="col"><span>${esc(c.name)}</span><span class="dim">${esc(c.type)}${c.nullable ? '' : ' · not null'}</span></div>`).join('')}</div></details>`).join('');
      return multi || s ? `<details class="folder" ${multi && !f ? '' : 'open'}><summary>${esc(s || 'main')} <span class="dim">(${ts.length})</span></summary><div>${items}${objFolders(s)}</div></details>` : items + objFolders(s);
    }).join('') || '<p class="dim">No tables</p>';
  }
  $('.tfilter', pane).oninput = drawTree;
  const quote = x => { const q = { postgres: '"', sqlite: '"', oracle: '"', mysql: '`', mssql: '[' }[SQLX] || '"'; return q === '[' ? `[${x.replace(/]/g, ']]')}]` : q + x.split(q).join(q + q) + q; };
  const fullName = t => `${t.schema ? quote(t.schema) + '.' : ''}${quote(t.name)}`;
  async function tableAction(kind, t) {
    if (kind === 'data') return run(await api.call('db:selectSql', SQLX, t.schema, t.name, +$('.lim', pane).value || 200), { table: t.name, schema: t.schema });
    if (kind === 'props') return showProps(t);
    if (kind === 'ddl') { try { const ddl = await api.call('db:ddl', tab.connId, t.schema, t.name); modal(`DDL — ${t.name}`, h(`<pre class="out" style="max-height:60vh">${esc(ddl)}</pre>`), [{ label: 'Copy', onClick: () => { navigator.clipboard.writeText(ddl); return false; } }, { label: 'Insert into editor', onClick: () => cm.replaceSelection(ddl + '\n') }, { label: 'Close', cls: 'primary' }], 'wide'); } catch (err) { toast(err.message, 'bad'); } }
    if (kind === 'count') { try { const [r] = await api.call('db:query', tab.connId, `SELECT COUNT(*) FROM ${fullName(t)}`, { limit: 1 }); toast(`${t.name}: ${r.rows[0][0]} rows`, 'ok'); } catch (err) { toast(err.message, 'bad'); } }
  }
  $('.tree', pane).addEventListener('click', async e => {
    const b = e.target.closest('button[data-t]'); if (!b) return;
    e.preventDefault();
    tableAction(b.dataset.t, schema[+b.dataset.i]);
  });
  $('.tree', pane).addEventListener('contextmenu', e => {
    const s = e.target.closest('summary[data-i]');
    const col = e.target.closest('.col');
    const ob = e.target.closest('.obj[data-o]');
    if (ob) { e.preventDefault(); const o = objects[+ob.dataset.o]; return ctxMenu(e, [['Show source…', () => showSource(o)], ['Insert source into editor', () => showSource(o, true)], ['Copy name', () => copyText(o.name)]]); }
    if (!s && !col) return;
    e.preventDefault();
    if (col) { const name = col.firstElementChild.textContent; return ctxMenu(e, [['Copy column name', () => copyText(name)], ['Insert into editor', () => { cm.replaceSelection(quote(name)); cm.focus(); }]]); }
    const t = schema[+s.dataset.i];
    const cols = t.columns.map(c => quote(c.name)).join(', ');
    const ins = sql => { cm.replaceSelection(sql + '\n'); cm.focus(); };
    ctxMenu(e, [
      ['▤ View data (first 200)', () => tableAction('data', t)],
      ['# Count rows', () => tableAction('count', t)],
      ['DDL…', () => tableAction('ddl', t)],
      ['Properties (keys, indexes, foreign keys)…', () => tableAction('props', t)],
      ['ER diagram (this table + related)…', () => erDiagram(t)],
      ['⇄ Compare / sync data with another table…', () => compareWith(t)],
      '-',
      ['Insert SELECT into editor', () => ins(`SELECT ${cols || '*'}\nFROM ${fullName(t)};`)],
      ['Insert INSERT into editor', () => ins(`INSERT INTO ${fullName(t)} (${cols})\nVALUES (${t.columns.map(() => '?').join(', ')});`)],
      ['Insert UPDATE into editor', () => ins(`UPDATE ${fullName(t)}\nSET ${t.columns.map(c => `${quote(c.name)} = ?`).join(',\n    ')}\nWHERE …;`)],
      ['Insert DELETE into editor', () => ins(`DELETE FROM ${fullName(t)}\nWHERE …;`)],
      '-',
      ['Copy table name', () => copyText(fullName(t))],
      ['Copy column list', () => copyText(cols)],
    ]);
  });
  $('.tree', pane).addEventListener('dblclick', async e => {
    const ob = e.target.closest('.obj[data-o]'); if (ob) return showSource(objects[+ob.dataset.o]);
    const s = e.target.closest('summary[data-i]'); if (!s) return;
    tableAction('data', schema[+s.dataset.i]);
  });

  // database switcher
  const loadDatabases = () => api.call('db:databases', tab.connId).then(list => {
    const sel = $('.dbsel', pane);
    if (!list.length) { sel.hidden = true; return; }
    const cur = database || d.database || '';
    sel.innerHTML = (cur && !list.includes(cur) ? [cur, ...list] : ['', ...list]).map(n => `<option ${n === cur ? 'selected' : ''} value="${esc(n)}">${esc(n || '(default)')}</option>`).join('');
    sel.onchange = async () => {
      const n = sel.value;
      if (d.engine === 'postgres') { // a postgres connection is bound to one database: reopen the tab
        if ((tab.txPending() || tab.gridEdits()) && !(await confirmBox('Switching database reconnects: uncommitted changes and unsaved grid edits will be lost. Continue?'))) { sel.value = database || d.database || ''; return; }
        if (tab.script) tab.script.sql = cm.getValue(); closeTab(tab, true); openDb(d, n, tab.script); return;
      }
      if (d.engine === 'oracle') { await run(`ALTER SESSION SET CURRENT_SCHEMA = "${n.replace(/"/g, '')}"`, { quiet: true }); }
      else { const qn = d.engine === 'mssql' ? `[${n.replace(/]/g, ']]')}]` : '`' + n.replace(/`/g, '``') + '`'; await run(`USE ${qn}`, { quiet: true }); }
      tab.title = `${d.name} [${n}]`; renderTabs(); loadSchema();
    };
  }).catch(() => { $('.dbsel', pane).hidden = true; });

  // the lines around the cursor up to the nearest blank lines -> { text, start } (start = offset of its first line)
  function currentBlock() {
    const ln = cm.getCursor().line, last = cm.lineCount() - 1;
    const blank = i => !cm.getLine(i).trim();
    let a = ln, b = ln;
    if (blank(ln)) return { text: '', start: 0 };
    while (a > 0 && !blank(a - 1)) a--;
    while (b < last && !blank(b + 1)) b++;
    return { text: cm.getRange({ line: a, ch: 0 }, { line: b, ch: cm.getLine(b).length }), start: cm.indexFromPos({ line: a, ch: 0 }) };
  }
  // What Run / Ctrl+Enter executes (like DBeaver): the selection, otherwise only the statement the cursor is in —
  // cut at its ";" (quotes, comments and BEGIN…END bodies respected), never the statements around it.
  async function currentSql() {
    if (cm.somethingSelected()) return cm.getSelection();
    const blk = currentBlock();
    if (!blk.text.trim()) return '';
    return api.call('db:statementAt', blk.text, cm.indexFromPos(cm.getCursor()) - blk.start);
  }

  // ---- transactions: auto-commit / manual commit (DBeaver's transaction mode) ----
  tab.tx = { manual: false, pending: 0 };
  tab.txPending = () => tab.tx.manual ? tab.tx.pending : 0; // closeTab / lock / window close warn about these
  tab.gridEdits = () => tab.results.some(hasEdits);
  function drawTx() {
    const b = $('[data-a="tx"]', pane), { manual, pending } = tab.tx;
    b.textContent = manual ? `Manual commit${pending ? ` · ${pending} pending` : ''}` : 'Auto-commit';
    b.classList.toggle('manual', manual);
    $('[data-a="commit"]', pane).hidden = $('[data-a="rollback"]', pane).hidden = !manual;
  }
  async function txDo(action) {
    if (tab.status !== 'up') return toast('Not connected', 'bad');
    try {
      tab.tx = await api.call('db:tx', tab.connId, action); drawTx();
      if (action === 'commit' || action === 'rollback') toast(action === 'commit' ? 'Committed' : 'Rolled back', 'ok');
      if (action === 'manual') toast('Manual commit: changes stay in a transaction until you Commit or Roll back');
    } catch (e) { toast(e.message, 'bad'); }
  }
  const refreshTx = () => tab.connId && api.call('db:tx', tab.connId, 'state').then(st => { tab.tx = st; drawTx(); }).catch(() => {});

  // ---- grid editing state (per result) ----
  const hasEdits = r => !!(r && r.ed && (r.ed.changes.size || r.ed.deleted.size || r.ed.added.length));
  const freshEdits = () => ({ changes: new Map(), deleted: new Set(), added: [] });
  const discardOk = async (list = tab.results) => !list.some(hasEdits) || confirmBox('Discard unsaved changes in the result grid?');
  const val = (r, row, ci) => { const c = r.ed && r.ed.changes.get(row); return c && ci in c ? c[ci] : row[ci]; };

  // A plain "SELECT … FROM one_table [WHERE/ORDER BY …]" result is editable like a table view (DBeaver does the same).
  function inferTable(r) {
    if (!r.columns.length || /\b(join|union|intersect|except|group\s+by|distinct|having)\b/i.test(r.sql)) return;
    const m = /^\s*select\s+[\s\S]+?\s+from\s+((?:[`"[]?[\w$ ]+?[`"\]]?\.)?[`"[]?[\w$]+[`"\]]?)(?:\s+(?:as\s+)?\w+)?\s*(?:where\b|order\b|limit\b|fetch\b|offset\b|$)/i.exec(r.sql.replace(/;\s*$/, ''));
    if (!m) return;
    const list = /^\s*select\s+([\s\S]+?)\s+from\s/i.exec(r.sql)[1];
    if (!list.split(',').every(x => /^\s*(?:\*|(?:[`"[]?[\w$]+[`"\]]?\.)?(?:\*|[`"[]?[\w$]+[`"\]]?))\s*$/.test(x))) return;
    const parts = m[1].split('.').map(x => x.replace(/^[`"[]|[`"\]]$/g, ''));
    const [sc, tn] = parts.length > 1 ? parts : [null, parts[0]];
    const hits = schema.filter(t => t.name.toLowerCase() === tn.toLowerCase() && (sc === null || (t.schema || '').toLowerCase() === sc.toLowerCase()));
    if (hits.length === 1) { r.table = hits[0].name; r.schema = hits[0].schema; r.inferred = true; }
  }

  // Editable = known table, not read-only, primary key fully present in the result. Binary columns stay read-only.
  // Loads keys for a table result: primary key (editing), foreign keys (navigation), column types (value editors).
  // Editable = not read-only and the primary key is fully present in the result. Binary columns stay read-only.
  async function prepEdit(r) {
    if (r.editable !== undefined) return;
    r.editable = false;
    if (!r.table || !r.columns.length || r.command === 'EXPLAIN') return;
    try {
      const k = await api.call('db:keys', tab.connId, r.schema, r.table);
      const t = schema.find(x => x.name === r.table && (x.schema || '') === (r.schema || ''));
      r.pk = k.pk; r.fks = k.fks;
      r.colTypes = r.columns.map(c => { const tc = t && t.columns.find(x => x.name === c); return tc ? tc.type || '' : null; });
      r.colEditable = r.colTypes.map(ty => ty !== null && !/blob|binary|bytea|image|raw|geometry|geography/i.test(ty));
      r.editable = !d.readOnly && k.pk.length > 0 && k.pk.every(p => r.columns.includes(p)) && new Set(r.columns).size === r.columns.length;
      r.noEditWhy = r.editable ? '' : d.readOnly ? 'read-only connection' : k.pk.length ? 'the primary key columns are not all in the result' : 'the table has no primary key';
    } catch (e) { r.noEditWhy = e.message.split('\n')[0]; }
    if (r.editable) r.ed = freshEdits();
  }

  async function run(sql, { table = null, schema: sch = null, where = '', order = '', quiet = false, append = false } = {}) {
    if (!sql.trim()) return toast('Nothing to run');
    if (tab.status !== 'up') return toast('Not connected', 'bad');
    if (!quiet && !append && !(await discardOk(tab.results.filter(x => !x.pinned)))) return;
    const typed = sql;
    // DBeaver-style script variables: ${name} is asked once and remembered for this tab
    const vars = table || quiet ? [] : [...new Set([...sql.matchAll(/\$\{([A-Za-z_]\w*)\}/g)].map(m => m[1]))];
    if (vars.length) {
      const v = await ask('Script variables', [...vars.map(n => [n, '${' + n + '}']), ['heading', 'Values are inserted as typed: add quotes yourself for text, e.g. \'abc\'.']], tab.vars || {}, 'Run');
      if (!v) return;
      tab.vars = { ...tab.vars, ...v };
      sql = sql.replace(/\$\{([A-Za-z_]\w*)\}/g, (m, n) => v[n] ?? m);
    }
    const stmts = await api.call('db:classify', sql);
    if (d.readOnly && stmts.some(s => s.write)) return toast('This connection is read-only — write statements are blocked.', 'bad');
    const danger = stmts.filter(s => s.danger);
    if (danger.length && !(await confirmBox(`Dangerous statement${danger.length > 1 ? 's' : ''}:\n\n${danger.map(s => `• ${s.danger}: ${s.sql.slice(0, 120)}`).join('\n')}\n\nRun anyway?`))) return;
    if (!danger.length && d.env === 'prod' && stmts.some(s => s.write) && !(await confirmBox(`PRODUCTION database "${d.name}" — run ${stmts.filter(s => s.write).length} write statement(s)?`))) return;
    tab.running = true; $('.rstatus', pane).textContent = 'Running…';
    const t0 = Date.now();
    try {
      const res = await api.call('db:query', tab.connId, sql, { limit: +$('.lim', pane).value || 1000 });
      if (!quiet) {
        const fresh = res.map(r => ({ ...r, table, schema: sch, where, order }));
        if (!table && fresh.length === 1) inferTable(fresh[0]);
        const keep = append ? tab.results : tab.results.filter(x => x.pinned);
        tab.results = [...keep, ...fresh];
        tab.last = { sql, opts: { table, schema: sch, where, order } };
        const lastSet = res.findLastIndex(r => r.columns.length);
        tab.cur = keep.length + (lastSet >= 0 ? lastSet : res.length - 1);
        drawResults();
      }
      if (!quiet) $('.rstatus', pane).textContent = `${res.length} statement(s) · ${Date.now() - t0} ms`;
      if (!table) { V.dbHistory = [{ sql: typed, at: Date.now(), db: d.name }, ...(V.dbHistory || []).filter(x => x.sql !== typed)].slice(0, 300); save('dbHistory'); }
      if (stmts.some(s => /^\s*(create|drop|alter)\b/i.test(s.sql))) loadSchema();
    } catch (e) {
      $('.grid', pane).innerHTML = `<pre class="out" style="color:var(--bad);margin:8px">${esc(e.message)}</pre>`;
      $('.rstatus', pane).textContent = `Error after ${Date.now() - t0} ms`;
    } finally { tab.running = false; refreshTx(); }
  }
  tab.run = run;

  async function explain() {
    const sql = await currentSql();
    if (!sql.trim()) return toast('Put the cursor on a statement (or select one)');
    if (tab.status !== 'up') return toast('Not connected', 'bad');
    const keep = tab.results.filter(x => x.pinned);
    if (!(await discardOk(tab.results.filter(x => !x.pinned)))) return;
    try { tab.results = [...keep, await api.call('db:explain', tab.connId, sql)]; tab.cur = tab.results.length - 1; drawResults(); }
    catch (e) { $('.grid', pane).innerHTML = `<pre class="out" style="color:var(--bad);margin:8px">${esc(e.message)}</pre>`; }
  }

  async function formatSql() {
    try {
      const sel = cm.somethingSelected();
      const out = await api.call('db:format', sel ? cm.getSelection() : cm.getValue(), SQLX);
      if (!sel) cm.execCommand('selectAll');
      cm.replaceSelection(out); // undoable with Ctrl+Z
    } catch (e) { toast('Could not format: ' + e.message.split('\n')[0], 'bad'); }
  }

  async function showSource(o, insert = false) {
    try {
      const src = await api.call('db:source', tab.connId, o);
      if (insert) { cm.replaceSelection(src + '\n'); cm.focus(); return; }
      modal(`${o.type.toLowerCase()} — ${o.schema ? o.schema + '.' : ''}${o.name}`, h(`<pre class="out" style="max-height:65vh">${esc(src)}</pre>`),
        [{ label: 'Copy', onClick: () => { navigator.clipboard.writeText(src); toast('Copied', 'ok'); return false; } }, { label: 'Insert into editor', onClick: () => cm.replaceSelection(src + '\n') }, { label: 'Close', cls: 'primary' }], 'wide');
    } catch (e) { toast(e.message, 'bad'); }
  }

  // ER diagram (DBeaver-style): boxes with columns (🔑 primary key, ↗ foreign key) and lines for foreign keys.
  // focus = a table: draws it with the tables it references and the tables referencing it. Boxes can be dragged.
  async function erDiagram(focus = null) {
    const f = $('.tfilter', pane).value.toLowerCase();
    const tablesOnly = schema.filter(t => t.type !== 'VIEW');
    let list = focus ? [focus] : tablesOnly.filter(t => !f || t.name.toLowerCase().includes(f));
    if (!list.length) return toast('No tables to draw');
    if (list.length > 80) { toast(`Showing the first 80 of ${list.length} tables: type in the table filter to narrow it`); list = list.slice(0, 80); }
    const keyCache = new Map(), keysOf = async t => {
      const id = `${t.schema || ''}.${t.name}`;
      if (!keyCache.has(id)) { try { keyCache.set(id, await api.call('db:keys', tab.connId, t.schema, t.name)); } catch { keyCache.set(id, { pk: [], fks: [] }); } }
      return keyCache.get(id);
    };
    const findTable = (sch, name) => tablesOnly.find(x => x.name.toLowerCase() === String(name).toLowerCase() && (!sch || (x.schema || '').toLowerCase() === String(sch).toLowerCase()));
    for (const [i, t] of list.entries()) { $('.rstatus', pane).textContent = `ER diagram: reading keys ${i + 1}/${list.length}…`; await keysOf(t); }
    if (focus) { // add parents (referenced) and children (referencing) of the focused table
      for (const fk of (await keysOf(focus)).fks) { const p = findTable(fk.refSchema, fk.refTable); if (p && !list.includes(p)) list.push(p); }
      const others = tablesOnly.filter(t => !list.includes(t)).slice(0, 300);
      for (const [i, t] of others.entries()) {
        $('.rstatus', pane).textContent = `ER diagram: looking for tables that reference ${focus.name} ${i + 1}/${others.length}…`;
        if ((await keysOf(t)).fks.some(fk => findTable(fk.refSchema, fk.refTable) === focus)) list.push(t);
      }
      for (const t of list) await keysOf(t); // parents added above
    }
    $('.rstatus', pane).textContent = '';
    const W = 220, LH = 17, HEAD = 24, GAP = 60, MAXC = 14;
    const cols = Math.max(1, Math.ceil(Math.sqrt(list.length)));
    const boxes = list.map(t => {
      const k = keyCache.get(`${t.schema || ''}.${t.name}`), shown = t.columns.slice(0, MAXC);
      return { t, k, shown, fkCols: new Set(k.fks.flatMap(x => x.columns)), x: 0, y: 0, h: HEAD + LH * (shown.length + (t.columns.length > MAXC ? 1 : 0)) + 6 };
    });
    let y = 20;
    for (let r = 0; r * cols < boxes.length; r++) {
      const row = boxes.slice(r * cols, r * cols + cols);
      row.forEach((b, c) => { b.x = 20 + c * (W + GAP); b.y = y; });
      y += Math.max(...row.map(b => b.h)) + GAP;
    }
    const links = [];
    for (const b of boxes) for (const fk of b.k.fks) { const to = boxes.find(x => x.t === findTable(fk.refSchema, fk.refTable)); if (to) links.push({ from: b, to, fk }); }
    const colY = (b, name) => { const i = b.shown.findIndex(c => c.name === name); return b.y + HEAD + (i < 0 ? 0 : i * LH + LH / 2) + 3; };
    const path = ({ from, to, fk }) => {
      const y1 = colY(from, fk.columns[0]), y2 = colY(to, fk.refColumns[0]);
      // boxes side by side: facing edges; same column (or self): loop out on the right so the line never crosses a box
      if (to.x >= from.x + W + 10) return `M${from.x + W} ${y1} C${from.x + W + 40} ${y1}, ${to.x - 40} ${y2}, ${to.x} ${y2}`;
      if (from.x >= to.x + W + 10) return `M${from.x} ${y1} C${from.x - 40} ${y1}, ${to.x + W + 40} ${y2}, ${to.x + W} ${y2}`;
      const x1 = from.x + W, x2 = to.x + W, out = Math.max(x1, x2) + 30 + Math.min(60, Math.abs(y2 - y1) / 6);
      return `M${x1} ${y1} C${out} ${y1}, ${out} ${y2}, ${x2} ${y2}`;
    };
    const boxSvg = (b, i) => `<g data-b="${i}" transform="translate(${b.x},${b.y})" style="cursor:move">
      <rect width="${W}" height="${b.h}" rx="6" fill="var(--bg2)" stroke="${b.t === focus ? 'var(--accent)' : 'var(--line)'}" stroke-width="${b.t === focus ? 2 : 1}"/>
      <rect width="${W}" height="${HEAD}" rx="6" fill="var(--bg3)"/>
      <text x="8" y="16" font-weight="600" fill="var(--fg)">${esc(b.t.name.length > 28 ? b.t.name.slice(0, 27) + '…' : b.t.name)}</text>
      ${b.shown.map((c, j) => `<text x="8" y="${HEAD + j * LH + 15}" fill="${b.k.pk.includes(c.name) ? '#f59e0b' : 'var(--fg)'}">${b.k.pk.includes(c.name) ? '🔑' : b.fkCols.has(c.name) ? '↗' : '·'} ${esc(c.name.slice(0, 22))}<tspan fill="var(--dim)"> ${esc(String(c.type || '').slice(0, 14))}</tspan></text>`).join('')}
      ${b.t.columns.length > MAXC ? `<text x="8" y="${HEAD + b.shown.length * LH + 15}" fill="var(--dim)">… ${b.t.columns.length - MAXC} more</text>` : ''}</g>`;
    const body = h(`<div style="overflow:auto;height:70vh;border:1px solid var(--line);border-radius:6px"><svg xmlns="http://www.w3.org/2000/svg" width="${20 + cols * (W + GAP)}" height="${y}" style="font:12px Consolas, monospace"></svg></div>`);
    const svg = $('svg', body);
    const draw = () => { svg.innerHTML = `<defs><marker id="erArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="var(--accent)"/></marker></defs>`
      + links.map(l => `<path d="${path(l)}" fill="none" stroke="var(--accent)" stroke-width="1.4" marker-end="url(#erArrow)"><title>${esc(`${l.from.t.name}(${l.fk.columns.join(', ')}) → ${l.to.t.name}(${l.fk.refColumns.join(', ')})`)}</title></path>`).join('')
      + boxes.map(boxSvg).join(''); };
    draw();
    let drag = null;
    svg.addEventListener('mousedown', e => { const g = e.target.closest('g[data-b]'); if (g) { const b = boxes[+g.dataset.b]; drag = { b, dx: e.clientX - b.x, dy: e.clientY - b.y }; e.preventDefault(); } });
    window.addEventListener('mousemove', e => { if (!drag) return; drag.b.x = Math.max(0, e.clientX - drag.dx); drag.b.y = Math.max(0, e.clientY - drag.dy); draw(); });
    window.addEventListener('mouseup', () => { drag = null; });
    const m = modal(`ER diagram — ${focus ? focus.name + ' and related tables' : list.length + ' table(s)'} · ${links.length} relation(s)`, body, [
      { label: 'Save as SVG…', onClick: async () => {
        const css = getComputedStyle(document.documentElement);
        const text = svg.outerHTML.replace(/var\((--[\w-]+)\)/g, (_m, v) => css.getPropertyValue(v).trim() || '#888');
        const p = await api.call('file:save', null, text); if (p) toast('Saved ' + p, 'ok'); return false;
      } },
      { label: 'Close', cls: 'primary' },
    ], 'wide');
    m.el.closest('.modal').style.width = 'min(1400px, 95vw)';
  }

  // Data compare / sync (DBeaver "Compare data"): summary + reviewable SQL that makes the target equal the source.
  async function compareWith(t) {
    const targets = tabs.filter(x => x.kind === 'db' && x.status === 'up' && x.connId);
    const r = await ask(`Compare data — ${t.schema ? t.schema + '.' : ''}${t.name} (source)`, [
      ['to', 'Target connection (an open, connected DB tab)', 'select', String(tab.id), targets.map(x => [String(x.id), x.title])],
      ['schema', 'Target schema (empty = default)', 'text', t.schema || ''],
      ['table', 'Target table', 'text', t.name],
      ['heading', 'Rows are matched by the source primary key (up to 200,000 rows per table). Nothing is changed: you get a summary and the SQL that would make the target equal to the source, to review and run yourself.'],
    ], {}, 'Compare');
    if (!r) return;
    const dt = targets.find(x => String(x.id) === r.to);
    if (!dt) return toast('Target tab is not connected', 'bad');
    $('.rstatus', pane).textContent = 'Comparing…';
    try {
      const res = await api.call('db:compare', tab.connId, { engine: SQLX, schema: t.schema, table: t.name }, dt.connId, { engine: sqlFlavor(dt.db), schema: r.schema, table: r.table });
      $('.rstatus', pane).textContent = '';
      const row = (k, v, cls = '') => `<tr><td>${k}</td><td class="num ${cls}">${v}</td></tr>`;
      const body = `<table class="rgrid" style="margin-bottom:10px">${row('Rows in source', res.sourceRows)}${row('Rows in target', res.targetRows)}${row('Identical', res.same)}
        ${row('Different → UPDATE', res.different, res.different ? 'chg' : '')}${row('Only in source → INSERT', res.onlySource)}${row('Only in target → DELETE', res.onlyTarget)}</table>
        <p class="dim">Matched by ${esc(res.pk.join(', '))} · compared columns: ${esc(res.columns.join(', '))}${res.missingInTarget.length ? `<br>Not in the target (ignored): ${esc(res.missingInTarget.join(', '))}` : ''}</p>`;
      modal(`Compare ${t.name} → ${dt.title} · ${r.table}`, body, [
        ...(res.sql.length ? [{ label: `Open ${res.sql.length} sync statement(s) in the target editor`, cls: 'primary', onClick: () => {
          const text = `-- Sync ${r.table} to match ${d.name}.${t.name}: ${res.onlyTarget} delete(s), ${res.different} update(s), ${res.onlySource} insert(s). Review before running (Alt+X runs the script).\n${res.sql.join(';\n')};\n`;
          dt.cm.replaceRange((dt.cm.getValue().trim() ? '\n\n' : '') + text, CodeMirror.Pos(dt.cm.lastLine()));
          activate(dt);
        } }] : []),
        { label: 'Close' },
      ]);
    } catch (e) { $('.rstatus', pane).textContent = ''; toast(e.message.split('\n')[0], 'bad'); }
  }

  async function showProps(t) {
    try {
      const k = await api.call('db:keys', tab.connId, t.schema, t.name), pk = new Set(k.pk);
      const tbl = (head, rows) => rows.length ? `<table class="rgrid" style="margin-bottom:12px"><tr>${head.map(x => `<th>${x}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(x => `<td>${esc(String(x))}</td>`).join('')}</tr>`).join('')}</table>` : '<p class="dim">None</p>';
      modal(`Properties — ${t.schema ? t.schema + '.' : ''}${t.name}`, `<div style="max-height:65vh;overflow:auto">
        <h3>Columns</h3>${tbl(['Name', 'Type', 'Nullable', 'Key'], t.columns.map(c => [c.name, c.type, c.nullable ? 'yes' : 'no', pk.has(c.name) ? 'PRIMARY KEY' : '']))}
        <h3>Indexes</h3>${tbl(['Name', 'Columns', 'Unique'], k.indexes.map(i => [i.name, i.columns.join(', '), i.unique ? 'yes' : '']))}
        <h3>Foreign keys</h3>${tbl(['Name', 'Columns', 'References'], k.fks.map(f => [f.name, f.columns.join(', '), `${f.refSchema ? f.refSchema + '.' : ''}${f.refTable} (${f.refColumns.join(', ')})`]))}</div>`,
      [{ label: 'Close', cls: 'primary' }], 'wide');
    } catch (e) { toast(e.message, 'bad'); }
  }

  let sortCol = -1, sortDir = 1;
  function drawResults() {
    $('.rtabs', pane).innerHTML = tab.results.map((r, i) => `<span class="rtab ${i === tab.cur ? 'on' : ''}" data-i="${i}" title="${esc(r.sql.slice(0, 300))}\n\nRight-click: pin / close">${r.pinned ? '📌 ' : ''}${r.command === 'EXPLAIN' ? 'Execution plan' : r.columns.length ? `${esc(r.table || 'Result ' + (i + 1))} (${r.rowCount ?? r.rows.length + '+'})` : `Statement ${i + 1}`}<b class="rx" title="Close">×</b></span>`).join('');
    sortCol = -1; tab.sel = new Set(); tab.anchor = null;
    const r = tab.results[tab.cur], isTable = !!(r && r.table && !r.inferred && r.columns.length);
    $('.wfilter', pane).hidden = $('.ofilter', pane).hidden = !isTable;
    if (isTable) { $('.wfilter', pane).value = r.where || ''; $('.ofilter', pane).value = r.order || ''; }
    drawGrid();
    if (r && r.editable === undefined) prepEdit(r).then(() => { if (tab.results[tab.cur] === r) drawGrid(); });
  }
  function drawGrid() {
    const r = tab.results[tab.cur]; const g = $('.grid', pane);
    $('.edits', pane).hidden = !(r && r.editable);
    if (!r) { g.innerHTML = ''; return; }
    $('[data-x="saveedits"]', pane).disabled = $('[data-x="revert"]', pane).disabled = !hasEdits(r);
    if (!r.columns.length) { g.innerHTML = `<p style="padding:10px">✔ ${r.affected != null ? `${r.affected} row(s) affected` : esc(r.command || 'OK')} <span class="dim">· ${r.ms} ms</span></p><pre class="out" style="margin:0 10px">${esc(r.sql)}</pre>`; $('.rstatus', pane).textContent = ''; return; }
    const f = $('.rfilter', pane).value.toLowerCase();
    let rows = f ? r.rows.filter(row => row.some(v => v !== null && String(v).toLowerCase().includes(f))) : r.rows.slice();
    if (sortCol >= 0) rows.sort((a, b) => { const x = a[sortCol], y = b[sortCol]; return (x === null) - (y === null) || (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sortDir; });
    const ed = r.ed || freshEdits(), added = new Set(ed.added);
    rows = rows.concat(ed.added);
    tab.view = rows;
    const pk = new Set(r.pk || []);
    const max = g.classList.contains('wrap') ? 5000 : 300; // wrapped cells show (much) more of long values
    const cell = (v, cls = '') => v === undefined ? `<td class="def ${cls}">(default)</td>` : v === null ? `<td class="null ${cls}">NULL</td>` : typeof v === 'number' ? `<td class="num ${cls}">${v}</td>` : `<td class="${cls}">${esc(String(v).slice(0, max))}</td>`;
    g.innerHTML = `<table class="rgrid${r.command === 'EXPLAIN' ? ' plan' : ''}"><thead><tr><th class="rn">#</th>${r.columns.map((c, i) => `<th data-c="${i}" class="${pk.has(c) ? 'pk' : ''}">${esc(c)}${i === sortCol ? (sortDir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((row, i) => { const c = ed.changes.get(row); return `<tr class="${ed.deleted.has(row) ? 'del' : ''}${added.has(row) ? ' new' : ''}${tab.sel.has(row) ? ' sel' : ''}"><td class="rn" title="Click to select (Ctrl/Shift for more)">${added.has(row) ? '＋' : i + 1}</td>${row.map((v, ci) => c && ci in c ? cell(c[ci], 'chg') : cell(v)).join('')}</tr>`; }).join('')}</tbody></table>`;
    const n = ed.changes.size + ed.deleted.size + ed.added.length;
    $('.rstatus', pane).innerHTML = `${r.rows.length - (rows.length - ed.added.length) ? `${rows.length - ed.added.length} of ` : ''}${r.rows.length} row(s)${r.truncated ? ` — first ${r.rows.length}${r.rowCount != null ? ` of ${r.rowCount}` : ', more on the server'} <button data-x="more" title="Load more rows (raises Max rows)">Fetch more</button>` : ''} · ${r.ms} ms`
      + (r.editable ? ` · <span title="Double-click a cell to edit">editable</span>${n ? ` · <b>${n} unsaved change(s)</b>` : ''}` : r.table && r.noEditWhy ? ` · read-only: ${esc(r.noEditWhy)}` : '');
  }

  // ---- editing ----
  const at = td => { const tr = td.parentNode; return { ri: [...tr.parentNode.children].indexOf(tr), ci: [...tr.children].indexOf(td) - 1 }; };
  function setCell(r, row, ci, v) {
    if (r.ed.added.includes(row)) row[ci] = v;
    else {
      const c = { ...(r.ed.changes.get(row) || {}) };
      const same = v === row[ci] || (v !== null && v !== undefined && row[ci] !== null && String(v) === String(row[ci]));
      if (same) delete c[ci]; else c[ci] = v;
      Object.keys(c).length ? r.ed.changes.set(row, c) : r.ed.changes.delete(row);
    }
    drawGrid();
  }
  function editCell(ri, ci) {
    const r = tab.results[tab.cur], row = tab.view[ri];
    if (!r || !r.editable || !row || !r.colEditable[ci] || r.ed.deleted.has(row)) return false;
    const td = $('.grid tbody', pane).children[ri].children[ci + 1];
    const cur = val(r, row, ci);
    td.classList.add('ed');
    const isDate = /^date$/i.test(r.colTypes[ci] || ''); // plain DATE columns get a date picker (no timezone involved)
    td.innerHTML = `<input${isDate ? ' type="date"' : ''}>`;
    const inp = td.firstChild;
    inp.value = cur === null || cur === undefined ? '' : isDate ? String(cur).slice(0, 10) : String(cur);
    inp.focus(); inp.select();
    let done = false;
    const finish = ok => {
      if (done) return; done = true;
      if (!ok) return drawGrid();
      let v = inp.value;
      if (v === '' && (cur === null || cur === undefined)) v = cur; // left empty: keep NULL / default
      else if (typeof cur === 'number' && v.trim() !== '' && !isNaN(+v)) v = +v;
      setCell(r, row, ci, v);
    };
    inp.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      else if (e.key === 'Escape') finish(false);
      else if (e.key === 'Tab') { e.preventDefault(); finish(true); let n = ci + (e.shiftKey ? -1 : 1); while (n >= 0 && n < r.columns.length && !r.colEditable[n]) n += e.shiftKey ? -1 : 1; editCell(ri, n); }
    };
    inp.onblur = () => finish(true);
    return true;
  }
  const targetRows = (r, row) => { const sel = tab.sel.size ? [...tab.sel] : []; return row && !tab.sel.has(row) ? [row] : sel; };
  function deleteRows(r, rows) {
    if (!rows.length) return toast('Select rows first (click the row numbers)');
    for (const row of rows) {
      if (r.ed.added.includes(row)) r.ed.added = r.ed.added.filter(x => x !== row);
      else if (r.ed.deleted.has(row)) r.ed.deleted.delete(row);
      else r.ed.deleted.add(row);
    }
    tab.sel = new Set(); drawGrid();
  }
  function addRow(r, from = null) {
    const row = r.columns.map((c, i) => from && !(r.pk || []).includes(c) ? val(r, from, i) : undefined);
    r.ed.added.push(row); drawGrid();
    const g = $('.grid', pane); g.scrollTop = g.scrollHeight;
    const first = r.colEditable.findIndex(Boolean);
    if (first >= 0) editCell(tab.view.length - 1, first);
  }
  async function editSqlOf(r) {
    const key = row => Object.fromEntries(r.pk.map(p => [p, row[r.columns.indexOf(p)]]));
    const changes = [
      ...[...r.ed.deleted].map(row => ({ type: 'delete', key: key(row) })),
      ...[...r.ed.changes].filter(([row]) => !r.ed.deleted.has(row)).map(([row, c]) => ({ type: 'update', key: key(row), set: Object.fromEntries(Object.entries(c).map(([ci, v]) => [r.columns[ci], v])) })),
      ...r.ed.added.map(row => ({ type: 'insert', values: Object.fromEntries(row.map((v, ci) => [r.columns[ci], v]).filter(([, v]) => v !== undefined)) })),
    ];
    return api.call('db:editSql', SQLX, r.schema, r.table, changes);
  }
  async function saveEdits() {
    const r = tab.results[tab.cur]; if (!hasEdits(r)) return;
    const stmts = await editSqlOf(r);
    if (d.env === 'prod' && !(await confirmBox(`PRODUCTION database "${d.name}" — save ${stmts.length} change(s)?\n\n${stmts.slice(0, 12).join(';\n')}${stmts.length > 12 ? `\n… and ${stmts.length - 12} more` : ''}`))) return;
    try {
      await api.call('db:applyEdits', tab.connId, stmts);
      toast(`Saved ${stmts.length} change(s)${tab.tx.manual ? ' — Commit to make them permanent' : ''}`, 'ok');
      r.ed = freshEdits();
      await run(r.sql, r.inferred ? {} : { table: r.table, schema: r.schema, where: r.where, order: r.order });
    } catch (e) { toast(e.message, 'bad'); refreshTx(); }
  }
  async function fetchMore() {
    const r = tab.results[tab.cur], lim = $('.lim', pane);
    lim.value = Math.max(+lim.value || 200, r.rows.length) * 5;
    if (r.table && !r.inferred) run(await api.call('db:selectSql', SQLX, r.schema, r.table, +lim.value, r.where, r.order), { table: r.table, schema: r.schema, where: r.where, order: r.order });
    else run(r.sql);
  }
  async function applyFilter() {
    const r = tab.results[tab.cur]; if (!r || !r.table) return;
    const where = $('.wfilter', pane).value, order = $('.ofilter', pane).value;
    run(await api.call('db:selectSql', SQLX, r.schema, r.table, +$('.lim', pane).value || 200, where, order), { table: r.table, schema: r.schema, where, order });
  }
  $('.wfilter', pane).onkeydown = $('.ofilter', pane).onkeydown = e => { if (e.key === 'Enter') applyFilter(); };

  async function closeResults(keepFn) {
    const gone = tab.results.filter(x => !keepFn(x));
    if (!(await discardOk(gone))) return;
    const cur = tab.results[tab.cur];
    tab.results = tab.results.filter(keepFn);
    tab.cur = Math.max(0, tab.results.includes(cur) ? tab.results.indexOf(cur) : tab.results.length - 1);
    drawResults();
  }
  $('.rtabs', pane).onclick = e => {
    const t = e.target.closest('.rtab'); if (!t) return;
    const r = tab.results[+t.dataset.i];
    if (e.target.classList.contains('rx')) return closeResults(x => x !== r);
    tab.cur = +t.dataset.i; drawResults();
  };
  $('.rtabs', pane).oncontextmenu = e => {
    const t = e.target.closest('.rtab'); if (!t) return;
    e.preventDefault();
    const r = tab.results[+t.dataset.i];
    ctxMenu(e, [
      [r.pinned ? 'Unpin (next run replaces it)' : '📌 Pin (keep it when running again)', () => { r.pinned = !r.pinned; drawResults(); }],
      ['Close', () => closeResults(x => x !== r)],
      ['Close all others', () => closeResults(x => x === r || x.pinned)],
      ['Copy SQL', () => copyText(r.sql)],
    ]);
  };
  $('.rfilter', pane).oninput = drawGrid;
  $('.rstatus', pane).onclick = e => { if (e.target.dataset.x === 'more') fetchMore(); };
  $('.grid', pane).addEventListener('click', e => {
    const th = e.target.closest('th[data-c]');
    if (th) { const c = +th.dataset.c; sortDir = c === sortCol ? -sortDir : 1; sortCol = c; return drawGrid(); }
    const rn = e.target.closest('td.rn'); if (!rn) return;
    const ri = at(rn).ri, row = tab.view[ri];
    if (e.shiftKey && tab.anchor !== null) tab.sel = new Set(tab.view.slice(Math.min(tab.anchor, ri), Math.max(tab.anchor, ri) + 1));
    else if (e.ctrlKey) tab.sel.has(row) ? tab.sel.delete(row) : tab.sel.add(row);
    else tab.sel = new Set(tab.sel.size === 1 && tab.sel.has(row) ? [] : [row]);
    tab.anchor = ri; drawGrid();
  });
  const sqlLit = v => typeof v === 'number' ? String(v) : `'${(SQLX === 'mysql' ? String(v).replace(/\\/g, '\\\\') : String(v)).replace(/'/g, "''")}'`;
  // DBeaver "Navigate to referenced row": opens the parent row in a new result tab
  async function openRef(r, row, fk) {
    const where = fk.columns.map((c, i) => { const v = val(r, row, r.columns.indexOf(c)); return `${quote(fk.refColumns[i])} ${v === null || v === undefined ? 'IS NULL' : '= ' + sqlLit(v)}`; }).join(' AND ');
    run(await api.call('db:selectSql', SQLX, fk.refSchema, fk.refTable, +$('.lim', pane).value || 200, where, ''), { table: fk.refTable, schema: fk.refSchema, where, append: true });
  }
  // long text / JSON editor for one cell
  function bigEditor(r, ri, ci) {
    const row = tab.view[ri], cur = val(r, row, ci);
    let txt = cur === null || cur === undefined ? '' : String(cur), json = false;
    try { if (/^\s*[[{]/.test(txt)) { txt = JSON.stringify(JSON.parse(txt), null, 2); json = true; } } catch {}
    const body = h(`<div><textarea class="mono" spellcheck="false" style="width:100%;height:55vh;white-space:pre">${esc(txt)}</textarea>
      <label class="dim"><input type="checkbox" class="nul"${cur === null ? ' checked' : ''}> NULL</label>${json ? ' <span class="dim">· JSON is checked and saved compact</span>' : ''}</div>`);
    modal(`${r.columns[ci]} — row ${ri + 1}`, body, [
      { label: 'Cancel' },
      { label: 'Format JSON', onClick: () => { const ta = $('textarea', body); try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); } catch (e) { toast('Not valid JSON: ' + e.message, 'bad'); } return false; } },
      { label: 'Apply', cls: 'primary', onClick: () => {
        let v = $('.nul', body).checked ? null : $('textarea', body).value;
        if (json && v !== null) { try { v = JSON.stringify(JSON.parse(v)); } catch (e) { toast('Not valid JSON: ' + e.message, 'bad'); return false; } }
        if (typeof cur === 'number' && v !== null && v.trim() !== '' && !isNaN(+v)) v = +v;
        setCell(r, row, ci, v);
      } },
    ], 'wide');
  }
  function viewValue(r, ri, ci) {
    const v = val(r, tab.view[ri], ci);
    let txt = v === null ? 'NULL' : v === undefined ? '(default)' : String(v);
    try { if (/^[[{]/.test(txt)) txt = JSON.stringify(JSON.parse(txt), null, 2); } catch {}
    modal(`${r.columns[ci]} — row ${ri + 1}`, h(`<pre class="out" style="max-height:60vh">${esc(txt)}</pre>`), [{ label: 'Copy', onClick: () => { navigator.clipboard.writeText(txt); toast('Copied', 'ok'); return false; } }, { label: 'Close', cls: 'primary' }]);
  }
  $('.grid', pane).addEventListener('dblclick', e => {
    const td = e.target.closest('td'); if (!td || td.classList.contains('rn') || td.classList.contains('ed')) return;
    const { ri, ci } = at(td), r = tab.results[tab.cur];
    if (!editCell(ri, ci)) viewValue(r, ri, ci);
  });
  $('.grid', pane).addEventListener('contextmenu', e => {
    const r = tab.results[tab.cur]; if (!r || !r.columns.length) return;
    const th = e.target.closest('th[data-c]');
    if (th) {
      e.preventDefault(); const c = +th.dataset.c;
      return ctxMenu(e, [['Sort ascending', () => { sortCol = c; sortDir = 1; drawGrid(); }], ['Sort descending', () => { sortCol = c; sortDir = -1; drawGrid(); }], ['Copy column name', () => copyText(r.columns[c])],
        ['Copy column values', () => copyText(tab.view.map(row => val(r, row, c) ?? '').join('\n'), `Copied ${tab.view.length} values`)],
        ...(r.table && !r.inferred ? [['Filter on the server: ORDER BY this column', () => { $('.ofilter', pane).value = `${quote(r.columns[c])} ${sortCol === c && sortDir > 0 ? 'DESC' : 'ASC'}`; applyFilter(); }]] : [])]);
    }
    const td = e.target.closest('td'); if (!td) return;
    e.preventDefault();
    const { ri, ci: ci0 } = at(td), row = tab.view[ri], ci = Math.max(0, ci0);
    const v = val(r, row, ci), col = r.columns[ci];
    const lit = v === null || v === undefined ? 'NULL' : sqlLit(v);
    const fk = (r.fks || []).find(f => f.columns.includes(col) && f.columns.every(c => r.columns.includes(c)));
    const rowObj = () => Object.fromEntries(r.columns.map((c, i) => [c, val(r, row, i) ?? null]));
    const ed = r.editable ? [
      ['✎ Edit cell', () => editCell(ri, ci), !r.colEditable[ci]],
      ['✎ Edit value in a large editor (text / JSON)…', () => bigEditor(r, ri, ci), !r.colEditable[ci]],
      ['Set NULL', () => setCell(r, row, ci, null), !r.colEditable[ci]],
      ['＋ Add row', () => addRow(r)],
      ['⧉ Duplicate row', () => addRow(r, row)],
      [r.ed.deleted.has(row) ? '↶ Undelete row' : `− Delete row${targetRows(r, row).length > 1 ? `s (${targetRows(r, row).length})` : ''}`, () => deleteRows(r, targetRows(r, row))],
      ['Preview save SQL…', async () => { const s = await editSqlOf(r); modal('Changes to save', h(`<pre class="out" style="max-height:60vh">${esc(s.join(';\n') + (s.length ? ';' : '-- no changes'))}</pre>`), [{ label: 'Close', cls: 'primary' }], 'wide'); }, !hasEdits(r)],
      '-'] : [];
    ctxMenu(e, [
      ...ed,
      ...(fk ? [[`↗ Open referenced row in ${fk.refTable}`, () => openRef(r, row, fk)], '-'] : []),
      ['View value…', () => viewValue(r, ri, ci)],
      ['Copy value', () => copyText(v === null || v === undefined ? '' : v)],
      ['Copy row (tab-separated)', () => copyText(r.columns.map((_, i) => val(r, row, i) ?? '').join('\t'))],
      ['Copy row as JSON', () => copyText(JSON.stringify(rowObj(), null, 2))],
      ['Copy row as INSERT', async () => copyText((await api.call('db:editSql', SQLX, r.schema, r.table || 'my_table', [{ type: 'insert', values: rowObj() }]))[0] + ';')],
      ['Copy column name', () => copyText(col)],
      '-',
      ['Find this value in the grid', () => { $('.rfilter', pane).value = v === null || v === undefined ? '' : String(v); drawGrid(); }],
      ...(r.table && !r.inferred ? [['Filter on the server: WHERE column = value', () => { $('.wfilter', pane).value = `${quote(col)} ${v === null ? 'IS NULL' : '= ' + lit}`; applyFilter(); }]] : []),
      ['Insert WHERE condition into editor', () => { cm.replaceSelection(`${quote(col)} ${v === null ? 'IS NULL' : '= ' + lit}`); cm.focus(); }],
      '-',
      ['⤓ Export…', () => exportResult(r, tab.view.filter(x => !r.ed || !r.ed.added.includes(x)))],
    ]);
  });
  $('.rbar', pane).addEventListener('click', async e => {
    const x = e.target.dataset.x; if (!x) return;
    const r = tab.results[tab.cur]; if (!r || !r.columns.length) return toast('No result set');
    if (x === 'addrow') return addRow(r);
    if (x === 'delrow') return deleteRows(r, [...tab.sel]);
    if (x === 'saveedits') return saveEdits();
    if (x === 'revert') { r.ed = freshEdits(); return drawGrid(); }
    const rows = (tab.view || r.rows).filter(row => !r.ed || !r.ed.added.includes(row));
    if (x === 'copy') { navigator.clipboard.writeText([r.columns, ...rows].map(row => row.map(v => v === null ? '' : String(v).replace(/[\t\n]/g, ' ')).join('\t')).join('\n')); return toast(`Copied ${rows.length} rows (TSV)`, 'ok'); }
    if (x === 'export') exportResult(r, rows);
  });

  // Export: rows shown in the grid, or re-run the query for the first N / all rows (read queries only).
  async function exportResult(r, shown) {
    const filtered = shown.length !== r.rows.length;
    const o = await ask('Export result', [
      ['fmt', 'Format', 'select', 'csv', [['csv', 'CSV'], ['json', 'JSON'], ['sql', 'SQL INSERT statements']]],
      ['rows', 'Rows', 'select', r.truncated ? 'all' : 'shown', [
        ['shown', `Rows shown in the grid (${shown.length}${filtered ? ', filtered/sorted' : ''})`],
        ['first', 'First N rows (runs the query again)'],
        ['all', 'All rows (runs the query again, no limit)']]],
      ['n', 'N (for "First N rows")', 'number', 10000],
      ['heading', r.truncated ? `The grid shows the first ${r.rows.length} rows because of "Max rows" (the rest was not downloaded). Re-running exports more, streamed straight to the file.` : 'Re-running ignores the grid filter and sort; it exports the query result.'],
    ], {}, 'Export');
    if (!o) return;
    try {
      if (o.rows === 'shown') { const p = await api.call('db:export', o.fmt, r.columns, shown, r.table, SQLX); if (p) toast(`Exported ${shown.length} rows to ${p}`, 'ok'); return; }
      const limit = o.rows === 'all' ? 2147483647 : Math.max(1, +o.n || 10000);
      // a table data view was generated with LIMIT 200 — regenerate it with the requested limit
      const sql = r.table && /^SELECT (TOP \d+ )?\* FROM /i.test(r.sql) ? await api.call('db:selectSql', SQLX, r.schema, r.table, limit) : r.sql;
      $('.rstatus', pane).textContent = 'Exporting…';
      const res = await api.call('db:exportQuery', tab.connId, sql, limit, o.fmt, r.table, SQLX);
      $('.rstatus', pane).textContent = '';
      if (res) toast(`Exported ${res.rows} rows to ${res.file}`, 'ok');
    } catch (e) { $('.rstatus', pane).textContent = ''; toast(e.message, 'bad'); }
  }
  $('.edbar', pane).addEventListener('click', async e => {
    const a = e.target.closest('button') && e.target.closest('button').dataset.a; if (!a) return;
    if (a === 'run') run(await currentSql());
    if (a === 'script') run(cm.getValue());
    if (a === 'explain') explain();
    if (a === 'runnew') run(await currentSql(), { append: true });
    if (a === 'format') formatSql();
    if (a === 'tx') txDo(tab.tx.manual ? 'auto' : 'manual');
    if (a === 'commit' || a === 'rollback') txDo(a);
    if (a === 'cancel') { if (!tab.running) return toast('No query running'); api.call('db:cancel', tab.connId).then(() => toast('Cancel requested'), err => toast(err.message, 'bad')); }
    if (a === 'savescript') saveScript();
    if (a === 'save') { const p = await api.call('file:save', null, cm.getValue()); if (p) toast('Saved ' + p, 'ok'); }
    if (a === 'open') { const f = await api.call('file:open'); if (f) cm.setValue(f.text); }
    if (a === 'history') {
      const list = (V.dbHistory || []);
      const body = h(`<div><input class="hf" placeholder="Search history…" style="width:100%;margin-bottom:8px"><div class="hl"></div></div>`);
      const draw = () => { const f = $('.hf', body).value.toLowerCase(); $('.hl', body).innerHTML = list.filter(x => !f || x.sql.toLowerCase().includes(f)).slice(0, 100).map((x, i) => `<div class="item" data-i="${list.indexOf(x)}"><span class="badge">${esc(x.db)}</span><span class="name mono">${esc(x.sql.replace(/\s+/g, ' ').slice(0, 140))}</span><span class="dim">${new Date(x.at).toLocaleString()}</span></div>`).join('') || '<p class="dim">Empty</p>'; };
      $('.hf', body).oninput = draw; draw();
      const m = modal('Query history', body, [{ label: 'Clear history', cls: 'danger', onClick: async () => { V.dbHistory = []; await save('dbHistory'); } }, { label: 'Close', cls: 'primary' }], 'wide');
      $('.hl', body).onclick = e2 => { const it = e2.target.closest('.item'); if (it) { cm.replaceSelection(list[+it.dataset.i].sql + '\n'); m.close(); } };
    }
  });
  $('[data-a="er"]', pane).onclick = () => tab.status === 'up' ? erDiagram() : toast('Not connected', 'bad');
  $('[data-a="refresh"]', pane).onclick = () => tab.status === 'up' ? loadSchema() : connectTab().then(ok => ok && (loadSchema(), loadDatabases()));
  $('.tree', pane).addEventListener('click', e => { if (e.target.dataset.a === 'reconnect') connectTab().then(ok => ok && (loadSchema(), loadDatabases())); });
  setSqlWrap(pref('mxc.sqlWrap')); setCellWrap(pref('mxc.cellWrap'));
  setTimeout(() => { cm.refresh(); cm.focus(); }, 50);

  // no saved password (and no saved credential): ask before the first attempt, like SSH sessions do
  let firstPw;
  const cred = V.credentials.find(c => c.id === d.credentialId);
  if (needsDbPassword(d) && !d.password && !(cred && cred.password)) {
    const r = await ask(`Password for ${d.user || (cred && cred.username) || '(user)'} @ ${d.name}`, [['password', 'Password (leave empty if none)', 'password'], ['save', 'Save password in vault', 'check', true]], {}, 'Connect');
    if (r) { firstPw = r.password; if (r.save && r.password) { d.password = r.password; await save('dbs'); } }
  }
  if (await connectTab(firstPw)) { loadSchema(); loadDatabases(); }
  return tab;
}
