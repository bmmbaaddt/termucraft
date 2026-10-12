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
    return Object.keys(g).sort().map(k => k ? `<details class="folder" ${foldAttr('dbf:' + k, !!f)}><summary>${esc(k)} <span class="dim">(${g[k].length})</span></summary><div>${g[k].map(conn).join('')}</div></details>` : g[k].map(conn).join('')).join('');
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
  // DBeaver-style navigator: schema › Tables / Views / Materialized views / Functions / Procedures / Packages /
  // Sequences / Triggers. Everything starts collapsed (opened folders stay open); typing a filter opens the folders with matches.
  const TABLE_KINDS = [['TABLE', '▦', 'Tables'], ['VIEW', '👁', 'Views'], ['MVIEW', '◫', 'Materialized views']];
  const OBJ_KINDS = [['FUNCTION', 'ƒ', 'Functions'], ['PROCEDURE', '⚙', 'Procedures'], ['PACKAGE', '📦', 'Packages'], ['SEQUENCE', '#', 'Sequences'], ['TRIGGER', '⚡', 'Triggers']];
  const treeKey = (...p) => `tree:${d.id}:${p.join(':')}`;
  const kindIcon = type => (TABLE_KINDS.find(k => k[0] === type) || TABLE_KINDS[0])[1];
  function drawTree() {
    const f = $('.tfilter', pane).value.toLowerCase(), hit = n => !f || n.toLowerCase().includes(f);
    const schemas = [...new Set([...schema.map(t => t.schema || ''), ...objects.map(o => o.schema || '')])].sort();
    const folder = (key, label, n, inner) => n ? `<details class="folder" ${foldAttr(key, !!f)}><summary>${label} <span class="dim">(${n})</span></summary><div>${inner}</div></details>` : '';
    const tableItem = t => { const i = schema.indexOf(t); return `<details class="tbl" ${foldAttr(treeKey('t', t.schema || '', t.name))}><summary data-i="${i}" title="Double-click: view data · right-click: more">${kindIcon(t.type)} ${esc(t.name)}<span class="acts"><button data-t="data" data-i="${i}" title="View data">▤</button><button data-t="ddl" data-i="${i}" title="DDL">DDL</button><button data-t="count" data-i="${i}" title="Row count">#</button></span></summary>
        <div>${t.columns.map(c => `<div class="col"><span>${esc(c.name)}</span><span class="dim">${esc(c.type)}${c.nullable ? '' : ' · not null'}</span></div>`).join('')}</div></details>`; };
    const html = schemas.map(s => {
      const ts = schema.filter(t => (t.schema || '') === s && hit(t.name)), os = objects.map((o, i) => [o, i]).filter(([o]) => (o.schema || '') === s && hit(o.name));
      const inner = TABLE_KINDS.map(([k, , label]) => { const l = ts.filter(t => t.type === k); return folder(treeKey(s, k), label, l.length, l.map(tableItem).join('')); }).join('')
        + OBJ_KINDS.map(([k, icon, label]) => { const l = os.filter(([o]) => o.type === k); return folder(treeKey(s, k), label, l.length, l.map(([o, i]) => `<div class="obj" data-o="${i}" title="Double-click: show source">${icon} ${esc(o.name)}</div>`).join('')); }).join('');
      return schemas.length > 1 || s ? folder(treeKey(s), esc(s || 'main'), ts.length + os.length, inner) : inner;
    }).join('');
    $('.tree', pane).classList.remove('dim');
    $('.tree', pane).innerHTML = html || `<p class="dim">${f ? 'No match' : 'No tables'}</p>`;
  }
  // F4 / Ctrl+click on a name in the SQL editor (DBeaver "open declaration"): finds the table, view, materialized view
  // or routine, opens its folders in the navigator, and shows it (properties, or the routine's source).
  function openObjectAt(pos) {
    const w = cm.findWordAt(pos), name = cm.getRange(w.anchor, w.head);
    if (!/^[\w$]+$/.test(name)) return false;
    const before = cm.getRange(CodeMirror.Pos(w.anchor.line, 0), w.anchor);
    const sm = /([\w$]+)["`\]]?\.["`[]?$/.exec(before), sch = sm ? sm[1].toLowerCase() : null;
    const lc = name.toLowerCase(), inSchema = x => sch === null || (x.schema || '').toLowerCase() === sch;
    const t = schema.find(x => x.name.toLowerCase() === lc && inSchema(x));
    const oi = t ? -1 : objects.findIndex(o => o.name.toLowerCase().replace(/\(.*$|\s+on\s.*$/, '') === lc && inSchema(o));
    if (!t && oi < 0) { toast(`"${name}" is not a table, view or routine of this connection`); return true; }
    const o = t || objects[oi], s = o.schema || '';
    openFolders.add(treeKey(s)); openFolders.add(treeKey(s, t ? t.type : o.type));
    $('.tfilter', pane).value = ''; drawTree();
    const el = t ? $(`.tree summary[data-i="${schema.indexOf(t)}"]`, pane) : $(`.tree .obj[data-o="${oi}"]`, pane);
    if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 2000); }
    t ? showProps(t) : showSource(o);
    return true;
  }
  cm.addKeyMap({ F4: c => { openObjectAt(c.getCursor()); } });
  cm.getWrapperElement().addEventListener('mousedown', e => {
    if (!e.ctrlKey || e.button !== 0) return;
    const pos = cm.coordsChar({ left: e.clientX, top: e.clientY }, 'window');
    if (/^[\w$]+$/.test(cm.getRange(cm.findWordAt(pos).anchor, cm.findWordAt(pos).head)) && schema.length) { e.preventDefault(); openObjectAt(pos); }
  }, true);
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
      ...(t.type === 'TABLE' ? [['ER diagram (this table + related)…', () => erDiagram(t)]] : []),
      ['⇄ Compare / sync data with another table…', () => compareWith(t)],
      '-',
      ['Insert SELECT into editor', () => ins(`SELECT ${cols || '*'}\nFROM ${fullName(t)};`)],
      ...(t.type === 'TABLE' ? [
        ['Insert INSERT into editor', () => ins(`INSERT INTO ${fullName(t)} (${cols})\nVALUES (${t.columns.map(() => '?').join(', ')});`)],
        ['Insert UPDATE into editor', () => ins(`UPDATE ${fullName(t)}\nSET ${t.columns.map(c => `${quote(c.name)} = ?`).join(',\n    ')}\nWHERE …;`)],
        ['Insert DELETE into editor', () => ins(`DELETE FROM ${fullName(t)}\nWHERE …;`)]] : []),
      ...(t.type === 'MVIEW' ? [['Insert REFRESH into editor', () => ins(SQLX === 'oracle' ? `BEGIN DBMS_MVIEW.REFRESH('${t.schema ? t.schema + '.' : ''}${t.name}'); END;` : `REFRESH MATERIALIZED VIEW ${fullName(t)};`)]] : []),
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

  async function run(sql, { table = null, schema: sch = null, where = '', order = '', quiet = false, append = false, limit = 0 } = {}) {
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
      const res = await api.call('db:query', tab.connId, sql, { limit: limit || +$('.lim', pane).value || 1000 });
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
      tab.view = []; $('.grid', pane).innerHTML = `<pre class="out" style="color:var(--bad);margin:8px">${esc(e.message)}</pre>`;
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
    catch (e) { tab.view = []; $('.grid', pane).innerHTML = `<pre class="out" style="color:var(--bad);margin:8px">${esc(e.message)}</pre>`; }
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
    const tablesOnly = schema.filter(t => t.type === 'TABLE');
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

  // ---- result grid (DBeaver-style): only the visible rows are in the page (smooth with 100k+ rows), fixed column
  // widths (drag a header edge), cell / row / column selection with mouse and keyboard, Ctrl+C copies the selection.
  let sortCol = -1, sortDir = 1, rowH = 24, win = '', drag = null;
  const grid = $('.grid', pane);
  grid.tabIndex = 0;
  const resetSel = () => { tab.sel = { ranges: [], anchor: null, focus: null, mode: 'cell' }; };
  resetSel();
  tab.view = [];
  const rnW = () => Math.max(44, String(tab.view.length).length * 8 + 22);
  const lastIdx = () => ({ r: tab.view.length - 1, c: tab.results[tab.cur].columns.length - 1 });
  const rect = (a, b) => ({ r0: Math.min(a.r, b.r), r1: Math.max(a.r, b.r), c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) });
  const inSel = (ri, ci) => tab.sel.ranges.some(R => ri >= R.r0 && ri <= R.r1 && ci >= R.c0 && ci <= R.c1);
  const spread = k => { const s = new Set(); for (const R of tab.sel.ranges) for (let i = R[k + '0']; i <= R[k + '1']; i++) s.add(i); return [...s].sort((a, b) => a - b); };
  const selRowIdx = () => spread('r'), selColIdx = () => spread('c');
  const selRows = () => selRowIdx().map(i => tab.view[i]);
  // mode: 'cell' | 'row' (whole rows, row numbers) | 'col' (whole columns, headers). Shift extends from the anchor, Ctrl adds.
  function select(to, { shift = false, ctrl = false, mode = 'cell' } = {}) {
    const s = tab.sel, L = lastIdx();
    if (L.r < 0) return;
    const span = R => mode === 'row' ? { ...R, c0: 0, c1: L.c } : mode === 'col' ? { ...R, r0: 0, r1: L.r } : R;
    if (shift && s.anchor) s.ranges[Math.max(0, s.ranges.length - 1)] = span(rect(s.anchor, to));
    else if (ctrl && s.ranges.length > 1 && mode === 'cell' && s.ranges.some(R => R.r0 === to.r && R.r1 === to.r && R.c0 === to.c && R.c1 === to.c)) s.ranges = s.ranges.filter(R => !(R.r0 === to.r && R.r1 === to.r && R.c0 === to.c && R.c1 === to.c)); // Ctrl+click again: unselect
    else { s.ranges = [...(ctrl ? s.ranges : []), span(rect(to, to))]; s.anchor = to; }
    s.focus = to; s.mode = mode;
    paintSel();
  }
  const selectAll = () => { const L = lastIdx(); if (L.r < 0) return; tab.sel = { ranges: [{ r0: 0, r1: L.r, c0: 0, c1: L.c }], anchor: { r: 0, c: 0 }, focus: tab.sel.focus || { r: 0, c: 0 }, mode: 'cell' }; paintSel(); };
  function paintSel() {
    const r = tab.results[tab.cur]; if (!r || !r.columns.length) return;
    const f = tab.sel.focus;
    for (const tr of grid.querySelectorAll('tbody tr[data-ri]')) {
      const ri = +tr.dataset.ri; let any = false;
      for (let ci = 0; ci < r.columns.length; ci++) {
        const td = tr.cells[ci + 1], on = inSel(ri, ci); any = any || on;
        td.classList.toggle('cs', on); td.classList.toggle('cf', !!f && f.r === ri && f.c === ci);
      }
      tr.cells[0].classList.toggle('cs', any);
    }
    const cols = new Set(selColIdx());
    grid.querySelectorAll('thead th[data-c]').forEach(th => th.classList.toggle('cs', cols.has(+th.dataset.c)));
    // selection summary like DBeaver's status: size, and sum / average when the values are numbers
    const el = $('.selinfo', pane); if (!el) return;
    const rows = selRowIdx(), cs = selColIdx();
    let cells = 0, sum = 0, nums = 0;
    for (const ri of rows) for (const ci of cs) if (inSel(ri, ci)) {
      cells++; const v = val(r, tab.view[ri], ci);
      if (typeof v === 'number' || (typeof v === 'string' && /^\s*-?\d+(\.\d+)?(e[+-]?\d+)?\s*$/i.test(v))) { sum += +v; nums++; }
    }
    el.textContent = cells > 1 ? ` · selected: ${rows.length} row(s) × ${cs.length} column(s) = ${cells} cell(s)${nums > 1 ? ` · sum ${+sum.toFixed(6)} · avg ${+(sum / nums).toFixed(6)}` : ''}` : '';
  }
  // Tab-separated like DBeaver / Excel. One cell is copied as-is; with several cells, values holding tabs, line breaks
  // or quotes are quoted so a spreadsheet pastes them into one cell.
  function selText(headers = false) {
    const r = tab.results[tab.cur], rows = selRowIdx(), cols = selColIdx(), one = rows.length * cols.length === 1 && !headers;
    const txt = v => { const s = v === null || v === undefined ? '' : String(v); return !one && /[\t\r\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const lines = rows.map(ri => cols.map(ci => inSel(ri, ci) ? txt(val(r, tab.view[ri], ci)) : '').join('\t'));
    if (headers) lines.unshift(cols.map(ci => txt(r.columns[ci])).join('\t'));
    return { text: lines.join('\r\n'), rows: rows.length, cols: cols.length, one };
  }
  function copySel(headers = false) {
    if (!tab.results[tab.cur] || !tab.sel.ranges.length) return toast('Select cells first');
    const s = selText(headers);
    copyText(s.text, s.one ? 'Copied value' : `Copied ${s.rows} row(s) × ${s.cols} column(s)`);
  }
  // scrolls a cell into view (rows outside the rendered window are placed by their computed position)
  function reveal({ r: ri, c: ci }) {
    const r = tab.results[tab.cur], head = $('thead', grid).offsetHeight, tr = $(`tbody tr[data-ri="${ri}"]`, grid);
    const y = tr ? tr.offsetTop : head + ri * rowH, hh = tr ? tr.offsetHeight : rowH;
    if (y - head < grid.scrollTop) grid.scrollTop = y - head; else if (y + hh > grid.scrollTop + grid.clientHeight) grid.scrollTop = y + hh - grid.clientHeight;
    const x = rnW() + r.widths.slice(0, ci).reduce((a, b) => a + b, 0), w = r.widths[ci];
    if (x - rnW() < grid.scrollLeft) grid.scrollLeft = x - rnW(); else if (x + w > grid.scrollLeft + grid.clientWidth) grid.scrollLeft = x + w - grid.clientWidth;
    renderRows();
  }
  const measure = (() => { const c = document.createElement('canvas').getContext('2d'); c.font = '12.5px Consolas, "Cascadia Mono", monospace'; return s => c.measureText(s).width; })();
  const colWidths = r => r.columns.map((c, ci) => {
    const plan = r.command === 'EXPLAIN';
    let w = measure(c) * 1.1 + 44; // bold header + sort arrow + key icon
    for (let i = 0; i < Math.min(r.rows.length, 200); i++) { const v = r.rows[i][ci]; if (v !== null && v !== undefined) w = Math.max(w, measure(String(v).slice(0, plan ? 400 : 60)) + 20); }
    return Math.round(Math.min(plan ? 1600 : 360, Math.max(56, w)));
  });

  function drawResults() {
    $('.rtabs', pane).innerHTML = tab.results.map((r, i) => `<span class="rtab ${i === tab.cur ? 'on' : ''}" data-i="${i}" title="${esc(r.sql.slice(0, 300))}\n\nRight-click: pin / close">${r.pinned ? '📌 ' : ''}${r.command === 'EXPLAIN' ? 'Execution plan' : r.columns.length ? `${esc(r.table || 'Result ' + (i + 1))} (${r.rowCount ?? r.rows.length + '+'})` : `Statement ${i + 1}`}<b class="rx" title="Close">×</b></span>`).join('');
    sortCol = -1; resetSel();
    const r = tab.results[tab.cur], isTable = !!(r && r.table && !r.inferred && r.columns.length);
    $('.wfilter', pane).hidden = $('.ofilter', pane).hidden = !isTable;
    if (isTable) { $('.wfilter', pane).value = r.where || ''; $('.ofilter', pane).value = r.order || ''; }
    drawGrid((r && r.scroll) || { top: 0, left: 0 });
    if (r && r.editable === undefined) prepEdit(r).then(() => { if (tab.results[tab.cur] === r) drawGrid(); });
  }
  function drawGrid(pos = { top: grid.scrollTop, left: grid.scrollLeft }) {
    const r = tab.results[tab.cur], g = grid;
    $('.edits', pane).hidden = !(r && r.editable);
    if (!r) { g.innerHTML = ''; tab.view = []; return; }
    $('[data-x="saveedits"]', pane).disabled = $('[data-x="revert"]', pane).disabled = !hasEdits(r);
    if (!r.columns.length) { tab.view = []; g.innerHTML = `<p style="padding:10px">✔ ${r.affected != null ? `${r.affected} row(s) affected` : esc(r.command || 'OK')} <span class="dim">· ${r.ms} ms</span></p><pre class="out" style="margin:0 10px">${esc(r.sql)}</pre>`; $('.rstatus', pane).textContent = ''; return; }
    const f = $('.rfilter', pane).value.toLowerCase();
    let rows = f ? r.rows.filter(row => row.some(v => v !== null && String(v).toLowerCase().includes(f))) : r.rows.slice();
    if (sortCol >= 0) rows.sort((a, b) => { const x = a[sortCol], y = b[sortCol]; return (x === null) - (y === null) || (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sortDir; });
    const ed = r.ed || freshEdits();
    rows = rows.concat(ed.added);
    tab.view = rows;
    if (!r.widths) r.widths = colWidths(r);
    const pk = new Set(r.pk || []), rw = rnW();
    g.innerHTML = `<table class="rgrid${r.command === 'EXPLAIN' ? ' plan' : ''}" style="width:${rw + r.widths.reduce((a, b) => a + b, 0)}px"><colgroup><col style="width:${rw}px">${r.widths.map(w => `<col style="width:${w}px">`).join('')}</colgroup>
      <thead><tr><th class="rn" title="Select all (Ctrl+A)">#</th>${r.columns.map((c, i) => `<th data-c="${i}" class="${pk.has(c) ? 'pk' : ''}" title="${esc(c)}&#10;Click: select the column (drag, Shift or Ctrl for more) · arrow: sort · drag the right edge: resize"><span class="so" title="Sort">${i === sortCol ? (sortDir > 0 ? '▲' : '▼') : '⇅'}</span>${esc(c)}<span class="rs"></span></th>`).join('')}</tr></thead><tbody></tbody></table>`;
    win = '';
    renderRows(pos.top);
    g.scrollTop = pos.top; g.scrollLeft = pos.left;
    const n = ed.changes.size + ed.deleted.size + ed.added.length, shown = rows.length - ed.added.length;
    $('.rstatus', pane).innerHTML = `${r.rows.length - shown ? `${shown} of ` : ''}${r.rows.length} row(s)${r.truncated ? ` — first ${r.rows.length}${r.rowCount != null ? ` of ${r.rowCount}` : ', more on the server'} <button data-x="more" title="Load 5× more rows (raises Max rows)">Fetch more</button> <button data-x="all" title="Load every row of the result">Fetch all</button>` : ''} · ${r.ms} ms`
      + (r.editable ? ` · <span title="Double-click, Enter or F2 edits a cell; typing starts editing">editable</span>${n ? ` · <b>${n} unsaved change(s)</b>` : ''}` : r.table && r.noEditWhy ? ` · read-only: ${esc(r.noEditWhy)}` : '')
      + '<span class="selinfo"></span>';
    paintSel();
  }
  function renderRows(st = grid.scrollTop) {
    const r = tab.results[tab.cur], tb = $('tbody', grid); if (!r || !tb || !r.columns.length) return;
    // ponytail: wrapped cells have uneven heights, so wrap mode (and plans) render every row; virtualize by measured heights if wrapped views of huge results matter
    const n = tab.view.length, all = grid.classList.contains('wrap') || r.command === 'EXPLAIN';
    const a = all ? 0 : Math.max(0, Math.floor(st / rowH) - 30), b = all ? n : Math.min(n, a + Math.ceil((grid.clientHeight || 800) / rowH) + 60);
    if (win === `${a}:${b}`) return;
    win = `${a}:${b}`;
    const ed = r.ed || freshEdits(), added = new Set(ed.added), max = all ? 5000 : 1000, nc = r.columns.length + 1;
    const cell = (v, cls = '') => v === undefined ? `<td class="def ${cls}">(default)</td>` : v === null ? `<td class="null ${cls}">NULL</td>` : typeof v === 'number' ? `<td class="num ${cls}">${v}</td>`
      : `<td class="${cls}">${esc(String(v).length > max ? String(v).slice(0, max) + '…' : String(v))}</td>`;
    const pad = hh => hh > 0 ? `<tr class="pad"><td colspan="${nc}" style="height:${hh}px"></td></tr>` : '';
    let html = pad(a * rowH);
    for (let i = a; i < b; i++) {
      const row = tab.view[i], c = ed.changes.get(row);
      html += `<tr data-ri="${i}" class="${ed.deleted.has(row) ? 'del' : ''}${added.has(row) ? ' new' : ''}"><td class="rn">${added.has(row) ? '＋' : i + 1}</td>${row.map((v, ci) => c && ci in c ? cell(c[ci], 'chg') : cell(v)).join('')}</tr>`;
    }
    tb.innerHTML = html + pad((n - b) * rowH);
    const first = !all && $('tr[data-ri]', tb), hh = first && first.getBoundingClientRect().height;
    if (hh && Math.abs(hh - rowH) > 0.01) { rowH = hh; win = ''; return renderRows(st); }
    paintSel();
  }
  grid.addEventListener('scroll', () => requestAnimationFrame(() => renderRows()));

  // mouse: click / Shift+click / Ctrl+click / drag on cells, on row numbers (whole rows) or on headers (whole columns); # = all
  grid.addEventListener('mousedown', e => {
    const r = tab.results[tab.cur];
    if (e.button !== 0 || !r || !r.columns.length || e.target.closest('td.ed')) return;
    const th = e.target.closest('th'), td = e.target.closest('td');
    if (th && e.target.classList.contains('rs')) { const c = +th.dataset.c; drag = { mode: 'resize', c, x: e.clientX, w: r.widths[c] }; e.preventDefault(); return; }
    if (th && e.target.classList.contains('so')) return; // sort arrow: handled on click
    const f = tab.sel.focus || { r: 0, c: 0 };
    let pos, mode = 'cell';
    if (th && th.classList.contains('rn')) { e.preventDefault(); grid.focus({ preventScroll: true }); return selectAll(); }
    if (th) { pos = { r: f.r, c: +th.dataset.c }; mode = 'col'; }
    else if (td && td.parentNode.dataset.ri) { const ri = +td.parentNode.dataset.ri; if (td.classList.contains('rn')) { pos = { r: ri, c: f.c }; mode = 'row'; } else pos = { r: ri, c: td.cellIndex - 1 }; }
    else return;
    e.preventDefault(); // no text selection while dragging
    const open = $('td.ed input', grid); if (open) open.blur(); // commit an inline edit first
    grid.focus({ preventScroll: true });
    select(pos, { shift: e.shiftKey, ctrl: e.ctrlKey, mode });
    drag = { mode };
  });
  window.addEventListener('mousemove', e => {
    if (!drag || !pane.isConnected) return;
    const r = tab.results[tab.cur]; if (!r || !r.widths) return;
    if (drag.mode === 'resize') {
      r.widths[drag.c] = Math.max(30, Math.round(drag.w + e.clientX - drag.x));
      const t = $('table', grid); t.querySelectorAll('col')[drag.c + 1].style.width = r.widths[drag.c] + 'px';
      t.style.width = rnW() + r.widths.reduce((a, b) => a + b, 0) + 'px';
      return;
    }
    const b = grid.getBoundingClientRect(), head = $('thead', grid).offsetHeight;
    if (drag.mode !== 'col') { if (e.clientY > b.bottom - 6) grid.scrollTop += rowH; else if (e.clientY < b.top + head) grid.scrollTop -= rowH; }
    if (drag.mode !== 'row') { if (e.clientX > b.right - 6) grid.scrollLeft += 40; else if (e.clientX < b.left + rnW()) grid.scrollLeft -= 40; }
    renderRows();
    const x = drag.mode === 'row' ? b.left + 4 : Math.min(Math.max(e.clientX, b.left + rnW() + 2), b.right - 16);
    const y = drag.mode === 'col' ? b.top + head / 2 : Math.min(Math.max(e.clientY, b.top + head + 2), b.bottom - 16);
    const el = document.elementFromPoint(x, y), cellEl = el && el.closest('td, th');
    if (!cellEl || !grid.contains(cellEl)) return;
    const f = tab.sel.focus || { r: 0, c: 0 };
    if (drag.mode === 'col') { if (cellEl.dataset.c && +cellEl.dataset.c !== f.c) select({ r: f.r, c: +cellEl.dataset.c }, { shift: true, mode: 'col' }); return; }
    const ri = cellEl.parentNode.dataset.ri; if (ri === undefined) return;
    if (drag.mode === 'row') { if (+ri !== f.r) select({ r: +ri, c: f.c }, { shift: true, mode: 'row' }); }
    else if (cellEl.cellIndex > 0 && (f.r !== +ri || f.c !== cellEl.cellIndex - 1)) select({ r: +ri, c: cellEl.cellIndex - 1 }, { shift: true });
  });
  window.addEventListener('mouseup', () => { drag = null; });
  grid.addEventListener('click', e => {
    const so = e.target.closest('th .so'); if (!so) return;
    const c = +so.parentNode.dataset.c; sortDir = c === sortCol ? -sortDir : 1; sortCol = c;
    resetSel(); drawGrid();
  });
  // keyboard (DBeaver): arrows / Tab / Home / End / PgUp / PgDn move (Shift extends, Ctrl jumps to the edge),
  // Ctrl+A all, Ctrl+C copy, Ctrl+Shift+C copy with column names, Enter / F2 edit, Shift+Enter view value,
  // Delete marks the selected rows for deletion, typing starts editing the cell
  grid.addEventListener('keydown', e => {
    if (e.target !== grid) return;
    const r = tab.results[tab.cur]; if (!r || !r.columns.length || !tab.view.length) return;
    const L = lastIdx(), f = tab.sel.focus || { r: 0, c: 0 }, k = e.key, ctrl = e.ctrlKey || e.metaKey;
    const page = Math.max(1, Math.floor(grid.clientHeight / rowH) - 2);
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1], PageUp: [-page, 0], PageDown: [page, 0] };
    let to = null;
    if (moves[k]) { const [dr, dc] = moves[k]; to = ctrl && !k.startsWith('Page') ? { r: dr ? (dr < 0 ? 0 : L.r) : f.r, c: dc ? (dc < 0 ? 0 : L.c) : f.c } : { r: f.r + dr, c: f.c + dc }; }
    else if (k === 'Home') to = { r: ctrl ? 0 : f.r, c: 0 };
    else if (k === 'End') to = { r: ctrl ? L.r : f.r, c: L.c };
    else if (k === 'Tab') to = { r: f.r, c: f.c + (e.shiftKey ? -1 : 1) };
    if (to) {
      e.preventDefault();
      to = { r: Math.max(0, Math.min(L.r, to.r)), c: Math.max(0, Math.min(L.c, to.c)) };
      const ext = e.shiftKey && k !== 'Tab';
      select(to, { shift: ext, mode: ext ? tab.sel.mode : 'cell' });
      return reveal(to);
    }
    const key = k.toLowerCase();
    if (ctrl && key === 'a') { e.preventDefault(); return selectAll(); }
    if (ctrl && key === 'c') { e.preventDefault(); return copySel(e.shiftKey); }
    if (!tab.sel.focus) return;
    if (k === 'Enter' || k === 'F2') { e.preventDefault(); if (e.shiftKey || !editCell(f.r, f.c)) viewValue(r, f.r, f.c); return; }
    if (k === 'Delete' && r.editable) { e.preventDefault(); return deleteRows(r, selRows()); }
    if (k === 'Escape') { tab.sel.ranges = [rect(f, f)]; tab.sel.anchor = f; return paintSel(); }
    if (k.length === 1 && !ctrl && !e.altKey && r.editable && editCell(f.r, f.c, k)) e.preventDefault();
  });

  // ---- editing ----
  const at = td => ({ ri: +td.parentNode.dataset.ri, ci: td.cellIndex - 1 });
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
  // typed = the key that started editing (replaces the value, like DBeaver / Excel)
  function editCell(ri, ci, typed) {
    const r = tab.results[tab.cur], row = tab.view[ri];
    if (!r || !r.editable || !row || !r.colEditable || !r.colEditable[ci] || r.ed.deleted.has(row)) return false;
    tab.sel.focus = { r: ri, c: ci };
    if (!$(`tbody tr[data-ri="${ri}"]`, grid)) reveal({ r: ri, c: ci });
    const td = $(`tbody tr[data-ri="${ri}"]`, grid).cells[ci + 1];
    const cur = val(r, row, ci);
    td.classList.add('ed');
    const isDate = /^date$/i.test(r.colTypes[ci] || ''); // plain DATE columns get a date picker (no timezone involved)
    td.innerHTML = `<input${isDate ? ' type="date"' : ''}>`;
    const inp = td.firstChild;
    inp.value = typed !== undefined && !isDate ? typed : cur === null || cur === undefined ? '' : isDate ? String(cur).slice(0, 10) : String(cur);
    inp.focus(); if (typed === undefined || isDate) inp.select();
    let done = false;
    const finish = (ok, back = false) => {
      if (done) return; done = true;
      if (back) setTimeout(() => grid.focus({ preventScroll: true })); // keyboard finish: keep working in the grid
      if (!ok) return drawGrid();
      let v = inp.value;
      if (v === '' && (cur === null || cur === undefined)) v = cur; // left empty: keep NULL / default
      else if (typeof cur === 'number' && v.trim() !== '' && !isNaN(+v)) v = +v;
      setCell(r, row, ci, v);
    };
    inp.onkeydown = e => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true, true);
      else if (e.key === 'Escape') finish(false, true);
      else if (e.key === 'Tab') { e.preventDefault(); finish(true); let n = ci + (e.shiftKey ? -1 : 1); while (n >= 0 && n < r.columns.length && !r.colEditable[n]) n += e.shiftKey ? -1 : 1; editCell(ri, n); }
    };
    inp.onblur = () => finish(true);
    return true;
  }
  // rows an action applies to: the selected rows when the clicked row is one of them, otherwise just that row
  const targetRows = (r, row) => { const sel = selRows(); return row && !sel.includes(row) ? [row] : sel; };
  function deleteRows(r, rows) {
    if (!rows.length) return toast('Select rows first (click a cell or the row numbers)');
    let removed = false;
    for (const row of rows) {
      if (r.ed.added.includes(row)) { r.ed.added = r.ed.added.filter(x => x !== row); removed = true; }
      else if (r.ed.deleted.has(row)) r.ed.deleted.delete(row);
      else r.ed.deleted.add(row);
    }
    if (removed) resetSel(); // new rows were dropped: row positions changed
    drawGrid();
  }
  function addRow(r, from = null) {
    const row = r.columns.map((c, i) => from && !(r.pk || []).includes(c) ? val(r, from, i) : undefined);
    r.ed.added.push(row); drawGrid();
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
  // Fetch more: 5× the rows (raises Max rows). Fetch all: every row, this once.
  async function fetchMore(all = false) {
    const r = tab.results[tab.cur], lim = $('.lim', pane);
    const limit = all ? 2147483647 : Math.max(+lim.value || 200, r.rows.length) * 5;
    if (!all) lim.value = limit;
    if (r.table && !r.inferred) run(await api.call('db:selectSql', SQLX, r.schema, r.table, limit, r.where, r.order), { table: r.table, schema: r.schema, where: r.where, order: r.order, limit });
    else run(r.sql, { limit });
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
    const was = tab.results[tab.cur]; if (was) was.scroll = { top: grid.scrollTop, left: grid.scrollLeft }; // come back to the same place
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
  $('.rfilter', pane).oninput = () => { resetSel(); drawGrid({ top: 0, left: grid.scrollLeft }); };
  $('.rstatus', pane).onclick = e => { if (e.target.dataset.x === 'more') fetchMore(); if (e.target.dataset.x === 'all') fetchMore(true); };
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
    const td = e.target.closest('td'); if (!td || td.parentNode.dataset.ri === undefined || td.classList.contains('rn') || td.classList.contains('ed')) return;
    const { ri, ci } = at(td), r = tab.results[tab.cur];
    if (!editCell(ri, ci)) viewValue(r, ri, ci);
  });
  // the selected cells as a table: selected columns × rows that have a selected cell
  const selTable = () => {
    const r = tab.results[tab.cur], cols = selColIdx();
    return { columns: cols.map(i => r.columns[i]), rows: selRowIdx().map(ri => cols.map(ci => inSel(ri, ci) ? val(r, tab.view[ri], ci) ?? null : null)) };
  };
  let textFormats = null;
  // DBeaver "Advanced copy": the selection in any text format
  async function copyAs() {
    const r = tab.results[tab.cur]; if (!r || !tab.sel.ranges.length) return toast('Select cells first');
    textFormats = textFormats || (await api.call('db:exportFormats')).filter(x => x.text);
    const o = await ask('Copy selection as', [['fmt', 'Format', 'select', 'csv', textFormats.map(x => [x.id, x.label])], ['header', 'Include column names', 'check', true], ['nullText', 'Write NULL as (empty = nothing)']], {}, 'Copy');
    if (!o) return;
    const t = selTable();
    copyText(await api.call('db:exportText', o.fmt, t.columns, t.rows, r.table, SQLX, o), `Copied ${t.rows.length} row(s) × ${t.columns.length} column(s) as ${o.fmt.toUpperCase()}`);
  }
  // widest value of a column (all loaded rows), capped so one huge value can't make the column unusable
  const fitWidth = (r, c) => Math.round(Math.min(1200, Math.max(56, measure(r.columns[c]) * 1.1 + 44,
    ...tab.view.slice(0, 5000).map(row => { const v = val(r, row, c); return v === null || v === undefined ? 0 : measure(String(v).slice(0, 200)) + 20; }))));
  $('.grid', pane).addEventListener('contextmenu', e => {
    const r = tab.results[tab.cur]; if (!r || !r.columns.length || !tab.view.length) return;
    const th = e.target.closest('th[data-c]');
    if (th) {
      e.preventDefault(); const c = +th.dataset.c;
      if (!selColIdx().includes(c) || tab.sel.mode !== 'col') select({ r: (tab.sel.focus || { r: 0 }).r, c }, { mode: 'col' });
      return ctxMenu(e, [['Sort ascending', () => { sortCol = c; sortDir = 1; resetSel(); drawGrid(); }], ['Sort descending', () => { sortCol = c; sortDir = -1; resetSel(); drawGrid(); }], ['Clear sort', () => { sortCol = -1; resetSel(); drawGrid(); }, sortCol < 0], '-',
        ['Copy column values (Ctrl+C)', () => copySel()], ['Copy with column name (Ctrl+Shift+C)', () => copySel(true)], ['Copy as… (CSV, JSON, Markdown, SQL, HTML, XML, TXT)', copyAs], ['Copy column name', () => copyText(r.columns[c])],
        ['Fit column width to its values', () => { r.widths[c] = fitWidth(r, c); drawGrid(); }],
        ...(r.table && !r.inferred ? [['Filter on the server: ORDER BY this column', () => { $('.ofilter', pane).value = `${quote(r.columns[c])} ${sortCol === c && sortDir > 0 ? 'DESC' : 'ASC'}`; applyFilter(); }]] : []),
        '-', ['⤓ Export…', () => exportResult(r)]]);
    }
    const td = e.target.closest('td'); if (!td || td.parentNode.dataset.ri === undefined) return;
    e.preventDefault();
    const { ri, ci: ci0 } = at(td), row = tab.view[ri], ci = Math.max(0, ci0);
    // right-click outside the selection selects that cell (or row), like DBeaver
    if (ci0 < 0) { if (!selRowIdx().includes(ri)) select({ r: ri, c: ci }, { mode: 'row' }); }
    else if (!inSel(ri, ci)) select({ r: ri, c: ci });
    const v = val(r, row, ci), col = r.columns[ci];
    const lit = v === null || v === undefined ? 'NULL' : sqlLit(v);
    const fk = (r.fks || []).find(f => f.columns.includes(col) && f.columns.every(c => r.columns.includes(c)));
    const nRows = targetRows(r, row).length;
    const ed = r.editable ? [
      ['✎ Edit cell (Enter / F2)', () => editCell(ri, ci), !r.colEditable[ci]],
      ['✎ Edit value in a large editor (text / JSON)…', () => bigEditor(r, ri, ci), !r.colEditable[ci]],
      ['Set NULL', () => setCell(r, row, ci, null), !r.colEditable[ci]],
      ['＋ Add row', () => addRow(r)],
      ['⧉ Duplicate row', () => addRow(r, row)],
      [r.ed.deleted.has(row) ? '↶ Undelete row' : `− Delete row${nRows > 1 ? `s (${nRows})` : ''} (Delete)`, () => deleteRows(r, targetRows(r, row))],
      ['Preview save SQL…', async () => { const s = await editSqlOf(r); modal('Changes to save', h(`<pre class="out" style="max-height:60vh">${esc(s.join(';\n') + (s.length ? ';' : '-- no changes'))}</pre>`), [{ label: 'Close', cls: 'primary' }], 'wide'); }, !hasEdits(r)],
      '-'] : [];
    ctxMenu(e, [
      ...ed,
      ...(fk ? [[`↗ Open referenced row in ${fk.refTable}`, () => openRef(r, row, fk)], '-'] : []),
      ['View value… (Shift+Enter)', () => viewValue(r, ri, ci)],
      ['Copy (Ctrl+C)', () => copySel()],
      ['Copy with column names (Ctrl+Shift+C)', () => copySel(true)],
      ['Copy as… (CSV, JSON, Markdown, SQL, HTML, XML, TXT)', copyAs],
      ['Copy column name', () => copyText(col)],
      ['Select all (Ctrl+A)', selectAll],
      '-',
      ['Find this value in the grid', () => { $('.rfilter', pane).value = v === null || v === undefined ? '' : String(v); resetSel(); drawGrid({ top: 0, left: grid.scrollLeft }); }],
      ...(r.table && !r.inferred ? [['Filter on the server: WHERE column = value', () => { $('.wfilter', pane).value = `${quote(col)} ${v === null ? 'IS NULL' : '= ' + lit}`; applyFilter(); }]] : []),
      ['Insert WHERE condition into editor', () => { cm.replaceSelection(`${quote(col)} ${v === null ? 'IS NULL' : '= ' + lit}`); cm.focus(); }],
      '-',
      ['⤓ Export…', () => exportResult(r)],
    ]);
  });
  $('.rbar', pane).addEventListener('click', async e => {
    const x = e.target.dataset.x; if (!x) return;
    const r = tab.results[tab.cur]; if (!r || !r.columns.length) return toast('No result set');
    if (x === 'addrow') return addRow(r);
    if (x === 'delrow') return deleteRows(r, selRows());
    if (x === 'saveedits') return saveEdits();
    if (x === 'revert') { r.ed = freshEdits(); return drawGrid(); }
    if (x === 'copy') {
      if (selRowIdx().length * selColIdx().length > 1) return copySel(true);
      const rows = tab.view.filter(row => !r.ed || !r.ed.added.includes(row));
      return copyText(await api.call('db:exportText', 'tsv', r.columns, rows, r.table, SQLX, {}), `Copied ${rows.length} rows with column names`);
    }
    if (x === 'export') exportResult(r);
  });

  // Export (DBeaver's data transfer): rows in the grid, the selected cells, or re-run the query for the first N / all
  // rows (read queries only, streamed straight to the file).
  async function exportResult(r) {
    const shown = tab.view.filter(x => !r.ed || !r.ed.added.includes(x));
    const filtered = shown.length !== r.rows.length || sortCol >= 0;
    const nr = selRowIdx().length, nc = selColIdx().length;
    const formats = await api.call('db:exportFormats');
    const o = await ask('Export result', [
      ['fmt', 'Format', 'select', 'csv', formats.map(x => [x.id, x.label])],
      ['rows', 'Rows', 'select', r.truncated || r.clipped ? 'all' : nr * nc > 1 ? 'sel' : 'shown', [
        ['shown', `Rows shown in the grid (${shown.length}${filtered ? ', filtered/sorted' : ''})${r.clipped ? ' — long binary values are cut here' : ''}`],
        ...(nr * nc > 1 ? [['sel', `Selected cells only (${nr} rows × ${nc} columns)`]] : []),
        ['first', 'First N rows (runs the query again)'],
        ['all', 'All rows (runs the query again, no limit)']]],
      ['n', 'N (for "First N rows")', 'number', 10000],
      ['heading', 'Options'],
      ['header', 'Include column names', 'check', true],
      ['delimiter', 'CSV delimiter', 'select', ',', [[',', 'Comma ,'], [';', 'Semicolon ;'], ['\t', 'Tab'], ['|', 'Pipe |']]],
      ['nullText', 'Write NULL as (CSV / TSV / TXT / Markdown / HTML; empty = nothing)'],
      ['bom', 'Start with a UTF-8 BOM (helps Excel open CSV / TSV / TXT with accents correctly)', 'check'],
      ['heading', r.truncated ? `The grid holds the first ${r.rows.length} rows because of "Max rows" (the rest was not downloaded). "All rows" exports everything, streamed straight to the file.` : 'Re-running ignores the grid filter and sort; it exports the query result.'],
    ], {}, 'Export');
    if (!o) return;
    const opts = { header: o.header, delimiter: o.delimiter, nullText: o.nullText, bom: o.bom };
    try {
      let res;
      $('.rstatus', pane).textContent = 'Exporting…';
      if (o.rows === 'shown') res = await api.call('db:export', o.fmt, r.columns, shown, r.table, SQLX, opts);
      else if (o.rows === 'sel') { const t = selTable(); res = await api.call('db:export', o.fmt, t.columns, t.rows, r.table, SQLX, opts); }
      else {
        const limit = o.rows === 'all' ? 2147483647 : Math.max(1, +o.n || 10000);
        // a table data view was generated with a row limit: regenerate it with the requested one, keeping its WHERE / ORDER BY
        const sql = r.table && !r.inferred ? await api.call('db:selectSql', SQLX, r.schema, r.table, limit, r.where, r.order) : r.sql;
        res = await api.call('db:exportQuery', tab.connId, sql, limit, o.fmt, r.table, SQLX, opts);
      }
      drawGrid();
      if (res) toast(`Exported ${res.rows} rows to ${res.file}${res.more ? ' (more rows exist: raise N)' : ''}`, 'ok');
    } catch (e) { drawGrid(); toast(e.message, 'bad'); }
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
