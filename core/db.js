// Database client core: one interface over PostgreSQL, MySQL/MariaDB, SQL Server and SQLite.
// open(cfg) -> { engine, query(sql, opts) -> [result], schema() -> [{schema, name, type, columns}], cancel(), close() }
// result = { columns: [name], rows: [[...]], rowCount, truncated, affected, command, ms }

// ---------- SQL text helpers ----------
// Split a script into statements: respects quotes, comments, $tag$ blocks, SQL Server GO lines, MySQL DELIMITER lines,
// Oracle "/" lines, and BEGIN … END bodies of triggers / procedures / functions / PL/SQL blocks (their inner ";" stay).
const BLOCK_START = /^(?:CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:DEFINER\s*=\s*\S+|EDITIONABLE|NONEDITIONABLE)\s+)*(?:FUNCTION|PROCEDURE|TRIGGER|PACKAGE|TYPE\s+BODY)|DECLARE|BEGIN)\b/i;
const isBlock = stmt => BLOCK_START.test(stripComments(stmt).trim());
function splitSqlRanges(sql) {
  const out = []; let cur = '', i = 0, delim = ';', segStart = 0;
  let block = null; // per statement: { depth, begun, dollar, header } once the statement is a code block
  const n = sql.length;
  // next = index just after the terminator; each statement remembers where it sits in the script
  const push = next => { out.push({ text: cur, start: segStart, end: next }); cur = ''; block = null; segStart = next; };
  const lineStart = () => i === 0 || sql[i - 1] === '\n';
  while (i < n) {
    const c = sql[i], c2 = sql.slice(i, i + 2);
    if (c2 === '--') { const e = sql.indexOf('\n', i); const j = e < 0 ? n : e; cur += sql.slice(i, j); i = j; continue; }
    if (c2 === '/*') { const e = sql.indexOf('*/', i + 2); const j = e < 0 ? n : e + 2; cur += sql.slice(i, j); i = j; continue; }
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const close = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < n) { if (sql[j] === close) { if (sql[j + 1] === close) { j += 2; continue; } break; } if (sql[j] === '\\' && c !== '[' && c !== '"') j++; j++; }
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '$' && !(delim !== ';' && sql.startsWith(delim, i))) {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) { if (block) block.dollar = true; const e = sql.indexOf(m[0], i + m[0].length); const j = e < 0 ? n : e + m[0].length; cur += sql.slice(i, j); i = j; continue; }
    }
    if (lineStart()) {
      const dl = /^DELIMITER[ \t]+(\S+)[ \t]*(?:\r?\n|$)/i.exec(sql.slice(i));
      if (dl) { push(i + dl[0].length); delim = dl[1]; i += dl[0].length; continue; }
      if (/^GO[ \t]*(\r?\n|$)/i.test(sql.slice(i))) { push(i + 2); i += 2; continue; }
      const sl = /^\/[ \t]*(?:\r?\n|$)/.exec(sql.slice(i));
      if (sl) { push(i + sl[0].length); i += sl[0].length; continue; }
    }
    if (/[A-Za-z_]/.test(c) && !/[\w$]/.test(sql[i - 1] || '')) {
      const word = /^[A-Za-z_]\w*/.exec(sql.slice(i))[0];
      if (!block && !stripComments(cur).trim() && BLOCK_START.test(sql.slice(i))) block = { depth: 0, begun: false, dollar: false, header: false };
      if (block) {
        const W = word.toUpperCase();
        if (W === 'BEGIN' || W === 'CASE') { block.depth++; if (W === 'BEGIN') block.begun = true; }
        else if (W === 'END' && !/^END\s+(IF|LOOP|WHILE|REPEAT|FOR)\b/i.test(sql.slice(i))) block.depth--;
        else if (W === 'IS' || W === 'AS' || W === 'DECLARE') block.header = true; // Oracle/T-SQL declarations may precede BEGIN
      }
      cur += word; i += word.length; continue;
    }
    if (sql.startsWith(delim, i)) {
      // inside a code block: keep going until its outermost END (or, without BEGIN, the declaration header ends)
      const open = block && !block.dollar && (block.depth > 0 || (!block.begun && block.depth === 0 && block.header));
      if (delim !== ';' || !open) {
        if (block && (block.begun || block.header) && !block.dollar && delim === ';') cur += ';'; // PL/SQL needs "END;" — keep the block's own terminator
        push(i + delim.length); i += delim.length; continue;
      }
    }
    cur += c; i++;
  }
  out.push({ text: cur, start: segStart, end: n });
  return out.filter(x => stripComments(x.text).trim()).map(x => ({ ...x, text: x.text.trim(), start: x.start + (x.text.length - x.text.trimStart().length) }));
}
const splitSql = sql => splitSqlRanges(sql).map(x => x.text);
// The statement the cursor is in (DBeaver's Ctrl+Enter): from its first character to its terminator. A cursor in the
// gap after a statement (e.g. right after its ";") belongs to that statement. -> text or ''
function statementAt(sql, offset) {
  const list = splitSqlRanges(sql);
  const hit = list.find(x => offset >= x.start && offset <= x.end) || list.filter(x => x.end <= offset).pop();
  return hit ? hit.text : '';
}

const stripComments = s => s.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
const stripStrings = s => s.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g, "''");

const READ_KW = new Set(['SELECT', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'VALUES', 'TABLE', 'USE', 'SET']);
// -> { write: bool, danger: string|null }
function classify(stmt) {
  const s = stripStrings(stripComments(stmt)).trim().replace(/\s+/g, ' ');
  const U = s.toUpperCase();
  const kw = (U.match(/^[A-Z]+/) || [''])[0];
  let write = !READ_KW.has(kw);
  if (kw === 'WITH') write = /\b(INSERT|UPDATE|DELETE|MERGE)\b/.test(U);
  if (kw === 'SELECT' && /\bINTO\b/.test(U) && !/\bINTO\s+@/.test(U)) write = true; // SELECT ... INTO new_table
  if (kw === 'EXPLAIN' && /\bANALY[SZ]E\b/.test(U) && /\b(INSERT|UPDATE|DELETE)\b/.test(U)) write = true;
  if (kw === 'PRAGMA') write = /=/.test(U);
  let danger = null;
  if (/^(DROP|TRUNCATE)\b/.test(U)) danger = `${kw} statement`;
  else if (/^ALTER\b/.test(U) && /\bDROP\b/.test(U)) danger = 'ALTER … DROP';
  else if (/^DELETE\b/.test(U) && !/\bWHERE\b/.test(U)) danger = 'DELETE without WHERE (all rows)';
  else if (/^UPDATE\b/.test(U) && !/\bWHERE\b/.test(U)) danger = 'UPDATE without WHERE (all rows)';
  else if (/^(GRANT|REVOKE)\b/.test(U)) danger = `${kw} (permissions)`;
  return { write, danger };
}

// ---------- identifier quoting / helper SQL ----------
const Q = {
  postgres: s => '"' + String(s).replace(/"/g, '""') + '"',
  sqlite: s => '"' + String(s).replace(/"/g, '""') + '"',
  mysql: s => '`' + String(s).replace(/`/g, '``') + '`',
  mssql: s => '[' + String(s).replace(/]/g, ']]') + ']',
  oracle: s => '"' + String(s).replace(/"/g, '""') + '"',
  ansi: s => '"' + String(s).replace(/"/g, '""') + '"', // ODBC types: standard quoting, no row-limit clause (streaming caps rows)
};
// SQL flavors a custom ODBC database type can borrow for quoting / LIMIT / literals
const FLAVORS = { postgres: 'Standard: "quotes" + LIMIT n', mysql: 'MySQL-like: `quotes` + LIMIT n', mssql: 'SQL Server-like: [quotes] + TOP n', oracle: 'Oracle/DB2-like: "quotes" + FETCH FIRST n ROWS', ansi: 'Plain: "quotes", no limit clause' };
const fullName = (engine, schema, table) => schema ? `${Q[engine](schema)}.${Q[engine](table)}` : Q[engine](table);
// where / order: DBeaver-style server-side data filter typed by the user
function selectSql(engine, schema, table, limit = 200, where = '', order = '') {
  const name = fullName(engine, schema, table);
  const w = where && where.trim() ? ` WHERE ${where.trim()}` : '', o = order && order.trim() ? ` ORDER BY ${order.trim()}` : '';
  if (engine === 'mssql') return `SELECT TOP ${limit} * FROM ${name}${w}${o};`;
  if (engine === 'oracle') return `SELECT * FROM ${name}${w}${o} FETCH FIRST ${limit} ROWS ONLY;`;
  if (engine === 'ansi') return `SELECT * FROM ${name}${w}${o};`;
  return `SELECT * FROM ${name}${w}${o} LIMIT ${limit};`;
}

// SQL literal; MySQL also treats backslash as an escape character inside strings
const lit = (engine, v) => v === null || v === undefined ? 'NULL' : typeof v === 'number' || typeof v === 'boolean' ? String(v)
  : `'${(engine === 'mysql' ? String(v).replace(/\\/g, '\\\\') : String(v)).replace(/'/g, "''")}'`;

// One grid edit -> one statement, keyed by primary key (DBeaver-style data editing).
// change = { type: 'update', key: {pkCol: v}, set: {col: v} } | { type: 'insert', values: {col: v} } | { type: 'delete', key }
function editSql(engine, schema, table, change) {
  const q = Q[engine], name = fullName(engine, schema, table);
  const where = k => Object.entries(k).map(([c, v]) => v === null ? `${q(c)} IS NULL` : `${q(c)} = ${lit(engine, v)}`).join(' AND ');
  if (change.type === 'update') return `UPDATE ${name} SET ${Object.entries(change.set).map(([c, v]) => `${q(c)} = ${lit(engine, v)}`).join(', ')} WHERE ${where(change.key)}`;
  if (change.type === 'delete') return `DELETE FROM ${name} WHERE ${where(change.key)}`;
  const cols = Object.keys(change.values);
  if (!cols.length) return engine === 'mysql' ? `INSERT INTO ${name} () VALUES ()` : `INSERT INTO ${name} DEFAULT VALUES`;
  return `INSERT INTO ${name} (${cols.map(q).join(', ')}) VALUES (${cols.map(c => lit(engine, change.values[c])).join(', ')})`;
}

// flat rows -> { pk: [col], indexes: [{name, unique, columns}], fks: [{name, columns, refSchema, refTable, refColumns}] }
function keysFrom(pk, idx, fk) {
  const ix = new Map(), fx = new Map();
  for (const r of idx) { if (!ix.has(r.name)) ix.set(r.name, { name: r.name, unique: r.uniq === true || +r.uniq === 1, columns: [] }); ix.get(r.name).columns.push(r.col); }
  for (const r of fk) { if (!fx.has(r.name)) fx.set(r.name, { name: r.name, columns: [], refSchema: r.rs, refTable: r.rt, refColumns: [] }); fx.get(r.name).columns.push(r.col); fx.get(r.name).refColumns.push(r.rcol); }
  return { pk, indexes: [...ix.values()], fks: [...fx.values()] };
}

const SYS = { postgres: "('pg_catalog','information_schema')", mysql: "('mysql','information_schema','performance_schema','sys')", mssql: "('sys','INFORMATION_SCHEMA')" };

// ---------- drivers ----------
const sslOpt = cfg => cfg.ssl ? { rejectUnauthorized: !!cfg.sslVerify } : undefined;

async function openPostgres(cfg) {
  const { Client, types: pgTypes } = require('pg');
  // date/time as the server's text: JS Date conversion shifts dates by the local timezone (2024-01-02 -> 2024-01-01T21:00Z)
  const TEXT_OIDS = new Set([1082, 1083, 1114, 1184, 1266]);
  const types = { getTypeParser: (oid, fmt) => TEXT_OIDS.has(oid) ? (v => v) : pgTypes.getTypeParser(oid, fmt) };
  const mk = () => new Client({ types, host: cfg.host, port: +cfg.port || 5432, user: cfg.user, password: cfg.password, database: cfg.database || 'postgres', ssl: sslOpt(cfg), connectionTimeoutMillis: 15000, application_name: 'TermuCraft' });
  const c = mk(); await c.connect();
  c.on('error', () => {});
  if (cfg.readOnly) await c.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
  if (cfg.timeout) await c.query(`SET statement_timeout = ${+cfg.timeout * 1000}`);
  const run = async sql => {
    const r = await c.query({ text: sql, rowMode: 'array' });
    const last = Array.isArray(r) ? r[r.length - 1] : r;
    return { columns: (last.fields || []).map(f => f.name), rows: last.rows || [], affected: last.fields && last.fields.length ? null : last.rowCount, command: last.command };
  };
  return {
    run,
    schema: async () => tables(
      await c.query(`select table_schema::text, table_name::text, table_type::text from information_schema.tables where table_schema not in ${SYS.postgres} and table_schema not like 'pg_toast%'
        union all select n.nspname::text, c.relname::text, 'MATERIALIZED VIEW' from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'm' order by 1,2`),
      await c.query(`select table_schema::text, table_name::text, column_name::text, data_type::text, is_nullable::text, ordinal_position::int as pos from information_schema.columns where table_schema not in ${SYS.postgres}
        union all select n.nspname::text, c.relname::text, a.attname::text, format_type(a.atttypid, a.atttypmod), case when a.attnotnull then 'NO' else 'YES' end, a.attnum::int from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
          where c.relkind = 'm' and a.attnum > 0 and not a.attisdropped order by 1, 2, 6`), r => r.rows),
    databases: async () => (await c.query('select datname from pg_database where not datistemplate order by 1')).rows.map(r => r.datname),
    ddl: async (schema, table) => {
      const v = (await c.query(`select c.relkind, pg_get_viewdef(c.oid, true) as def from pg_class c where c.oid = $1::regclass`, [fullName('postgres', schema, table)])).rows[0];
      if (v && (v.relkind === 'v' || v.relkind === 'm')) return `CREATE ${v.relkind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${fullName('postgres', schema, table)} AS
${v.def}`;
      const r = await c.query(`select column_name, data_type, character_maximum_length, is_nullable, column_default from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position`, [schema, table]);
      const cols = r.rows.map(x => `  ${Q.postgres(x.column_name)} ${x.data_type}${x.character_maximum_length ? `(${x.character_maximum_length})` : ''}${x.is_nullable === 'NO' ? ' NOT NULL' : ''}${x.column_default ? ' DEFAULT ' + x.column_default : ''}`);
      const idx = await c.query('select indexdef from pg_indexes where schemaname=$1 and tablename=$2', [schema, table]);
      return `CREATE TABLE ${Q.postgres(schema)}.${Q.postgres(table)} (\n${cols.join(',\n')}\n);\n\n${idx.rows.map(i => i.indexdef + ';').join('\n')}`;
    },
    // functions, procedures, sequences, triggers (DBeaver's other object folders)
    objects: async () => (await c.query(`
      select n.nspname as schema, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as name, case p.prokind when 'p' then 'PROCEDURE' else 'FUNCTION' end as type, p.oid::text as id
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname not in ${SYS.postgres} and n.nspname not like 'pg_%' and p.prokind in ('f', 'p')
      union all select sequence_schema, sequence_name, 'SEQUENCE', null from information_schema.sequences where sequence_schema not in ${SYS.postgres}
      union all select n.nspname, t.tgname || ' on ' || c.relname, 'TRIGGER', t.oid::text from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
        where not t.tgisinternal and n.nspname not in ${SYS.postgres}
      order by 3, 1, 2`)).rows,
    source: async o => {
      if (o.type === 'SEQUENCE') {
        const r = (await c.query('select * from pg_sequences where schemaname = $1 and sequencename = $2', [o.schema, o.name])).rows[0] || {};
        return `CREATE SEQUENCE ${fullName('postgres', o.schema, o.name)} START ${r.start_value} INCREMENT ${r.increment_by} MINVALUE ${r.min_value} MAXVALUE ${r.max_value}${r.cycle ? ' CYCLE' : ''};\n-- last value: ${r.last_value ?? '(not used yet)'}`;
      }
      return (await c.query(`select ${o.type === 'TRIGGER' ? 'pg_get_triggerdef' : 'pg_get_functiondef'}($1::oid) as d`, [o.id])).rows[0].d + ';';
    },
    keys: async (schema, table) => {
      const rel = [fullName('postgres', schema, table)];
      const att = (arr, owner) => `cross join lateral unnest(${arr}::int2[]) with ordinality k(att, n) join pg_attribute a on a.attrelid = ${owner} and a.attnum = k.att`;
      const pk = await c.query(`select a.attname::text as col from pg_index i ${att('i.indkey', 'i.indrelid')} where i.indrelid = $1::regclass and i.indisprimary order by k.n`, rel);
      const idx = await c.query(`select ic.relname as name, i.indisunique as uniq, a.attname::text as col from pg_index i join pg_class ic on ic.oid = i.indexrelid ${att('i.indkey', 'i.indrelid')} where i.indrelid = $1::regclass order by 1, k.n`, rel);
      const fk = await c.query(`select c.conname as name, a.attname::text as col, fn.nspname as rs, fc.relname as rt, fa.attname::text as rcol from pg_constraint c
        cross join lateral unnest(c.conkey, c.confkey) with ordinality k(att, fatt, n) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att
        join pg_attribute fa on fa.attrelid = c.confrelid and fa.attnum = k.fatt join pg_class fc on fc.oid = c.confrelid join pg_namespace fn on fn.oid = fc.relnamespace
        where c.conrelid = $1::regclass and c.contype = 'f' order by 1, k.n`, rel);
      return keysFrom(pk.rows.map(r => r.col), idx.rows, fk.rows);
    },
    explain: stmt => run(`EXPLAIN ${stmt}`),
    // server-side cursor: only limit+1 rows ever leave the server
    fetch: (sql, limit, onBatch) => new Promise((ok, ko) => {
      const Cursor = require('pg-cursor');
      const cur = c.query(new Cursor(sql, null, { rowMode: 'array' }));
      let got = 0, columns = null;
      const step = () => cur.read(Math.min(BATCH, limit + 1 - got), (err, rows, result) => {
        if (err) return cur.close(() => ko(err));
        if (!columns) columns = ((result && result.fields) || []).map(f => f.name);
        got += rows.length;
        const more = got > limit;
        if (more) rows = rows.slice(0, rows.length - (got - limit));
        if (rows.length) onBatch(columns, rows);
        if (more || !rows.length) return cur.close(() => ok({ columns, more }));
        step();
      });
      step();
    }),
    cancel: async () => { const k = mk(); await k.connect(); await k.query('select pg_cancel_backend($1)', [c.processID]); await k.end(); },
    close: () => c.end(),
  };
}

async function openMysql(cfg) {
  const mysql = require('mysql2/promise');
  const opts = { host: cfg.host, port: +cfg.port || 3306, user: cfg.user, password: cfg.password, database: cfg.database || undefined, ssl: sslOpt(cfg), connectTimeout: 15000, rowsAsArray: true, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true };
  const c = await mysql.createConnection(opts);
  c.on('error', () => {});
  if (cfg.readOnly) await c.query('SET SESSION TRANSACTION READ ONLY');
  // GROUP_CONCAT results are silently cut at 1024 characters by default
  await c.query('SET SESSION group_concat_max_len = 4294967295').catch(() => {});
  if (cfg.timeout) await c.query(`SET SESSION max_execution_time = ${+cfg.timeout * 1000}`).catch(() => {});
  return {
    run: async sql => {
      const [rows, fields] = await c.query(sql);
      if (!fields) return { columns: [], rows: [], affected: rows.affectedRows, command: 'OK' };
      return { columns: fields.map(f => f.name), rows };
    },
    schema: async () => {
      const [t] = await c.query({ sql: `select table_schema, table_name, table_type from information_schema.tables where table_schema not in ${SYS.mysql} order by 1,2`, rowsAsArray: false });
      const [col] = await c.query({ sql: `select table_schema, table_name, column_name, data_type, is_nullable from information_schema.columns where table_schema not in ${SYS.mysql} order by table_schema, table_name, ordinal_position`, rowsAsArray: false });
      return tables({ rows: t.map(lower) }, { rows: col.map(lower) }, r => r.rows);
    },
    databases: async () => (await c.query({ sql: 'show databases', rowsAsArray: true }))[0].map(r => r[0]),
    ddl: async (schema, table) => (await c.query(`SHOW CREATE TABLE ${Q.mysql(schema)}.${Q.mysql(table)}`))[0][0][1] + ';',
    objects: async () => (await c.query({ sql: `select routine_schema as \`schema\`, routine_name as name, routine_type as type from information_schema.routines where routine_schema not in ${SYS.mysql}
      union all select trigger_schema, trigger_name, 'TRIGGER' from information_schema.triggers where trigger_schema not in ${SYS.mysql} order by 3, 1, 2`, rowsAsArray: false }))[0].map(lower),
    source: async o => {
      const [rows] = await c.query({ sql: `SHOW CREATE ${o.type} ${Q.mysql(o.schema)}.${Q.mysql(o.name)}`, rowsAsArray: false });
      const r = lower(rows[0] || {});
      return (r['create function'] || r['create procedure'] || r['sql original statement'] || '(definition not visible — needs privileges)') + ';';
    },
    keys: async (schema, table) => {
      const q = async sql => (await c.query({ sql, values: [schema, table], rowsAsArray: false }))[0].map(lower);
      const pk = await q(`select column_name as col from information_schema.key_column_usage where table_schema = ? and table_name = ? and constraint_name = 'PRIMARY' order by ordinal_position`);
      const idx = await q(`select index_name as name, non_unique = 0 as uniq, column_name as col from information_schema.statistics where table_schema = ? and table_name = ? order by index_name, seq_in_index`);
      const fk = await q(`select constraint_name as name, column_name as col, referenced_table_schema as rs, referenced_table_name as rt, referenced_column_name as rcol from information_schema.key_column_usage where table_schema = ? and table_name = ? and referenced_table_name is not null order by constraint_name, ordinal_position`);
      return keysFrom(pk.map(r => r.col), idx, fk);
    },
    explain: async stmt => { const [rows, fields] = await c.query(`EXPLAIN ${stmt}`); return { columns: fields.map(f => f.name), rows }; },
    // streams rows; once past the limit the rest of the query is killed on the server instead of downloaded.
    // Resolves only after the KILL went through, so it can never hit the next query on this connection.
    fetch: (sql, limit, onBatch) => new Promise((ok, ko) => {
      let columns = [], buf = [], got = 0, more = false, kill = null, settled = false;
      const flush = () => { if (buf.length) onBatch(columns, buf); buf = []; };
      const finish = err => { if (settled) return; settled = true; Promise.resolve(kill).then(() => { if (err) return ko(err); flush(); ok({ columns, more }); }); };
      const q = c.connection.query({ sql, rowsAsArray: true });
      q.on('fields', f => { columns = (f || []).map(x => x.name); });
      q.on('result', row => {
        if (more) return;
        if (got === limit) {
          more = true;
          kill = mysql.createConnection(opts).then(k => k.query(`KILL QUERY ${c.threadId}`).finally(() => k.end())).catch(() => {});
          return;
        }
        got++; buf.push(row); if (buf.length >= BATCH) flush();
      });
      q.on('error', e => finish(more && (e.errno === 1317 || /interrupted/i.test(e.message)) ? null : e));
      q.on('end', () => finish(null));
    }),
    cancel: async () => { const k = await mysql.createConnection(opts); await k.query(`KILL QUERY ${c.threadId}`); await k.end(); },
    close: () => c.end(),
  };
}
const lower = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]));

async function openMssql(cfg) {
  const sql = require('mssql');
  const pool = new sql.ConnectionPool({
    server: cfg.host, port: +cfg.port || 1433, user: cfg.user, password: cfg.password, database: cfg.database || undefined,
    options: { encrypt: !!cfg.ssl, trustServerCertificate: !cfg.sslVerify, appName: 'TermuCraft', readOnlyIntent: !!cfg.readOnly },
    pool: { max: 1 }, connectionTimeout: 15000, requestTimeout: cfg.timeout ? +cfg.timeout * 1000 : 0,
  });
  await pool.connect();
  pool.on('error', () => {});
  let current = null;
  const run = async text => {
    const req = current = pool.request();
    req.arrayRowMode = true;
    try {
      const r = await req.query(text);
      const i = (r.recordsets || []).length - 1;
      if (i < 0) return { columns: [], rows: [], affected: (r.rowsAffected || []).reduce((a, b) => a + b, 0), command: 'OK' };
      return { columns: (r.columns[i] || []).map(c => c.name), rows: r.recordsets[i] };
    } finally { current = null; }
  };
  return {
    run,
    schema: async () => tables(
      await pool.request().query(`select table_schema, table_name, table_type from information_schema.tables where table_schema not in ${SYS.mssql} order by 1,2`),
      await pool.request().query(`select table_schema, table_name, column_name, data_type, is_nullable from information_schema.columns order by table_schema, table_name, ordinal_position`), r => r.recordset),
    databases: async () => (await pool.request().query('select name from sys.databases order by 1')).recordset.map(r => r.name),
    ddl: async (schema, table) => {
      const def = (await pool.request().input('q', fullName('mssql', schema, table)).query(`select object_definition(object_id(@q)) as d`)).recordset[0];
      if (def && def.d) return def.d; // views (tables have no definition text)
      const r = await pool.request().input('s', schema).input('t', table).query(`select column_name, data_type, character_maximum_length, is_nullable from information_schema.columns where table_schema=@s and table_name=@t order by ordinal_position`);
      return `CREATE TABLE ${Q.mssql(schema)}.${Q.mssql(table)} (\n${r.recordset.map(x => `  ${Q.mssql(x.column_name)} ${x.data_type}${x.character_maximum_length ? `(${x.character_maximum_length < 0 ? 'max' : x.character_maximum_length})` : ''}${x.is_nullable === 'NO' ? ' NOT NULL' : ''}`).join(',\n')}\n);`;
    },
    objects: async () => (await pool.request().query(`select schema_name(o.schema_id) as [schema], o.name as name,
        case when o.type = 'P' then 'PROCEDURE' when o.type = 'TR' then 'TRIGGER' when o.type = 'SO' then 'SEQUENCE' else 'FUNCTION' end as type, cast(o.object_id as varchar(20)) as id
      from sys.objects o where o.type in ('P', 'FN', 'IF', 'TF', 'TR', 'SO') and o.is_ms_shipped = 0 order by 3, 1, 2`)).recordset,
    source: async o => {
      if (o.type === 'SEQUENCE') {
        const r = (await pool.request().input('id', +o.id).query('select start_value, increment, current_value from sys.sequences where object_id = @id')).recordset[0] || {};
        return `CREATE SEQUENCE ${fullName('mssql', o.schema, o.name)} START WITH ${r.start_value} INCREMENT BY ${r.increment};\n-- current value: ${r.current_value}`;
      }
      return (await pool.request().input('id', +o.id).query('select object_definition(@id) as d')).recordset[0].d || '(definition is encrypted or not visible)';
    },
    keys: async (schema, table) => {
      const q = async sql => (await pool.request().input('s', schema).input('t', table).input('q', fullName('mssql', schema, table)).query(sql)).recordset;
      const pk = await q(`select kcu.column_name as col from information_schema.table_constraints tc join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
        where tc.table_schema = @s and tc.table_name = @t and tc.constraint_type = 'PRIMARY KEY' order by kcu.ordinal_position`);
      const idx = await q(`select i.name as name, i.is_unique as uniq, c.name as col from sys.indexes i join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id
        join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id where i.object_id = object_id(@q) and i.name is not null and ic.is_included_column = 0 order by i.name, ic.key_ordinal`);
      const fk = await q(`select fk.name as name, pc.name as col, schema_name(rt.schema_id) as rs, rt.name as rt, rc.name as rcol from sys.foreign_keys fk
        join sys.foreign_key_columns fkc on fkc.constraint_object_id = fk.object_id join sys.columns pc on pc.object_id = fkc.parent_object_id and pc.column_id = fkc.parent_column_id
        join sys.tables rt on rt.object_id = fkc.referenced_object_id join sys.columns rc on rc.object_id = fkc.referenced_object_id and rc.column_id = fkc.referenced_column_id
        where fk.parent_object_id = object_id(@q) order by fk.name, fkc.constraint_column_id`);
      return keysFrom(pk.map(r => r.col), idx, fk);
    },
    // SHOWPLAN must be alone in its batch; the single pooled connection keeps the setting between batches
    // streams rows of the first result set; cancels the request once past the limit
    fetch: (text, limit, onBatch) => new Promise((ok, ko) => {
      const req = current = pool.request();
      req.stream = true; req.arrayRowMode = true;
      let columns = [], buf = [], got = 0, more = false, sets = 0, settled = false;
      const flush = () => { if (buf.length) onBatch(columns, buf); buf = []; };
      const finish = err => { if (settled) return; settled = true; current = null; if (err) return ko(err); flush(); ok({ columns, more }); };
      req.on('recordset', cols => { if (++sets === 1) columns = Array.isArray(cols) ? cols.map(x => x.name) : Object.keys(cols); });
      req.on('row', row => {
        if (more || sets > 1) return;
        if (got === limit) { more = true; req.cancel(); return; }
        got++; buf.push(row); if (buf.length >= BATCH) flush();
      });
      req.on('error', e => finish(more && /cancel/i.test(`${e.code} ${e.message}`) ? null : e));
      req.on('done', () => finish(null));
      req.query(text);
    }),
    explain: async stmt => { await run('SET SHOWPLAN_TEXT ON'); try { return await run(stmt); } finally { await run('SET SHOWPLAN_TEXT OFF'); } },
    cancel: async () => { if (current) current.cancel(); },
    close: () => pool.close(),
  };
}

// ponytail: node:sqlite is synchronous, a long query blocks the main process until it finishes.
async function openSqlite(cfg) {
  const { DatabaseSync } = require('node:sqlite');
  if (!cfg.file) throw new Error('Choose a SQLite database file');
  const db = new DatabaseSync(cfg.file, { readOnly: !!cfg.readOnly });
  const run = async text => {
    const st = db.prepare(text);
    const cols = st.columns ? st.columns().map(c => c.name) : null;
    if (cols && cols.length === 0) { const r = st.run(); return { columns: [], rows: [], affected: Number(r.changes), command: 'OK' }; }
    const rows = st.all();
    const columns = cols || (rows[0] ? Object.keys(rows[0]) : []);
    return { columns, rows: rows.map(r => columns.map(c => r[c])) };
  };
  return {
    run,
    schema: async () => {
      const t = db.prepare("select name, type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by name").all();
      return t.map(x => ({ schema: '', name: x.name, type: x.type === 'view' ? 'VIEW' : 'TABLE', columns: db.prepare(`pragma table_info(${Q.sqlite(x.name)})`).all().map(c => ({ name: c.name, type: c.type, nullable: !c.notnull })) }));
    },
    databases: async () => [],
    ddl: async (_s, table) => (db.prepare('select sql from sqlite_master where name = ?').get(table) || {}).sql + ';',
    objects: async () => db.prepare("select '' as schema, name, 'TRIGGER' as type from sqlite_master where type = 'trigger' order by name").all(),
    source: async o => (db.prepare("select sql from sqlite_master where type = 'trigger' and name = ?").get(o.name) || {}).sql + ';',
    keys: async (_s, table) => {
      const t = Q.sqlite(table);
      const pk = db.prepare(`pragma table_info(${t})`).all().filter(c => c.pk).sort((a, b) => a.pk - b.pk).map(c => c.name);
      const idx = db.prepare(`pragma index_list(${t})`).all().flatMap(i => db.prepare(`pragma index_info(${Q.sqlite(i.name)})`).all().map(c => ({ name: i.name, uniq: i.unique, col: c.name })));
      const fk = db.prepare(`pragma foreign_key_list(${t})`).all().map(r => ({ name: `fk_${r.id}`, col: r.from, rs: '', rt: r.table, rcol: r.to }));
      return keysFrom(pk, idx, fk);
    },
    explain: stmt => run(`EXPLAIN QUERY PLAN ${stmt}`),
    fetch: async (text, limit, onBatch) => {
      const st = db.prepare(text);
      const columns = st.columns().map(c => c.name);
      if (st.setReturnArrays) st.setReturnArrays(true);
      let buf = [], got = 0, more = false;
      for (const row of st.iterate()) {
        if (got === limit) { more = true; break; }
        got++; buf.push(Array.isArray(row) ? row : columns.map(c => row[c]));
        if (buf.length >= BATCH) { onBatch(columns, buf); buf = []; }
      }
      if (buf.length) onBatch(columns, buf);
      return { columns, more };
    },
    cancel: async () => {},
    close: () => db.close(),
  };
}

function tables(t, c, rowsOf) {
  const map = new Map();
  for (const r of rowsOf(t)) map.set(`${r.table_schema}.${r.table_name}`, { schema: r.table_schema, name: r.table_name, type: /MATERIALIZED/i.test(r.table_type) ? 'MVIEW' : /VIEW/i.test(r.table_type) ? 'VIEW' : 'TABLE', columns: [] });
  for (const r of rowsOf(c)) { const x = map.get(`${r.table_schema}.${r.table_name}`); if (x) x.columns.push({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES' }); }
  return [...map.values()];
}

// Oracle via node-oracledb thin mode (no Oracle Instant Client needed).
// database field = service name (default) or SID (prefix with ':').
async function openOracle(cfg) {
  const oracledb = require('oracledb');
  oracledb.fetchAsString = [oracledb.CLOB, oracledb.NCLOB, oracledb.NUMBER, oracledb.DATE];
  oracledb.fetchAsBuffer = [oracledb.BLOB]; // otherwise BLOBs arrive as Lob stream objects
  const svc = cfg.database || 'XEPDB1';
  const cs = cfg.connectString || `${cfg.host}:${+cfg.port || 1521}/${svc.replace(/^:/, '')}`.replace(/\/:/, ':');
  const c = await oracledb.getConnection({ user: cfg.user, password: cfg.password, connectString: cs });
  if (cfg.timeout) c.callTimeout = +cfg.timeout * 1000;
  const owner = (cfg.user || '').toUpperCase();
  let autoCommit = !cfg.readOnly;
  const run = async text => {
    const sql = isBlock(text) ? text : text.replace(/;\s*$/, '');
    const r = await c.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit, maxRows: 100000 });
    if (!r.metaData) return { columns: [], rows: [], affected: r.rowsAffected ?? 0, command: 'OK' };
    return { columns: r.metaData.map(m => m.name), rows: r.rows };
  };
  return {
    run,
    schema: async () => {
      // the current schema's own tables/views (follows ALTER SESSION SET CURRENT_SCHEMA)
      const cur = (await c.execute(`select sys_context('userenv','current_schema') s from dual`)).rows[0][0] || owner;
      const t = await c.execute(`select t.owner, t.table_name, case when m.mview_name is null then 'TABLE' else 'MATERIALIZED VIEW' end typ from all_tables t left join all_mviews m on m.owner = t.owner and m.mview_name = t.table_name where t.owner=:o union all select owner, view_name, 'VIEW' from all_views where owner=:o`, { o: cur }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const col = await c.execute(`select owner, table_name, column_name, data_type, nullable from all_tab_columns where owner=:o order by table_name, column_id`, { o: cur }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      return tables({ rows: t.rows.map(r => ({ table_schema: r.OWNER, table_name: r.TABLE_NAME, table_type: r.TYP })) },
        { rows: col.rows.map(r => ({ table_schema: r.OWNER, table_name: r.TABLE_NAME, column_name: r.COLUMN_NAME, data_type: r.DATA_TYPE, is_nullable: r.NULLABLE === 'Y' ? 'YES' : 'NO' })) }, r => r.rows);
    },
    databases: async () => (await c.execute('select username from all_users order by 1')).rows.map(r => r[0]),
    ddl: async (schema, table) => {
      for (const kind of ['MATERIALIZED_VIEW', 'TABLE', 'VIEW']) { try { return String((await c.execute('select dbms_metadata.get_ddl(:k, :t, :s) from dual', { k: kind, t: table, s: schema })).rows[0][0]); } catch {} }
      { const r = await c.execute(`select column_name, data_type, nullable from all_tab_columns where owner=:s and table_name=:t order by column_id`, { s: schema, t: table }, { outFormat: oracledb.OUT_FORMAT_OBJECT }); return `CREATE TABLE "${schema}"."${table}" (\n${r.rows.map(x => `  "${x.COLUMN_NAME}" ${x.DATA_TYPE}${x.NULLABLE === 'N' ? ' NOT NULL' : ''}`).join(',\n')}\n);`; }
    },
    objects: async () => {
      const cur = (await c.execute(`select sys_context('userenv','current_schema') from dual`)).rows[0][0] || owner;
      return (await c.execute(`select owner "schema", object_name "name", object_type "type" from all_objects where owner = :o and object_type in ('FUNCTION', 'PROCEDURE', 'PACKAGE', 'TRIGGER', 'SEQUENCE') order by 3, 2`, { o: cur }, { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows;
    },
    source: async o => String((await c.execute('select dbms_metadata.get_ddl(:t, :n, :s) from dual', { t: o.type, n: o.name, s: o.schema })).rows[0][0]),
    keys: async (schema, table) => {
      const q = async sql => (await c.execute(sql, { s: schema, t: table }, { outFormat: oracledb.OUT_FORMAT_OBJECT })).rows;
      const pk = await q(`select cc.column_name "col" from all_constraints c join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name
        where c.owner = :s and c.table_name = :t and c.constraint_type = 'P' order by cc.position`);
      const idx = await q(`select i.index_name "name", case when i.uniqueness = 'UNIQUE' then 1 else 0 end "uniq", ic.column_name "col" from all_indexes i
        join all_ind_columns ic on ic.index_owner = i.owner and ic.index_name = i.index_name where i.table_owner = :s and i.table_name = :t order by i.index_name, ic.column_position`);
      const fk = await q(`select c.constraint_name "name", cc.column_name "col", r.owner "rs", r.table_name "rt", rc.column_name "rcol" from all_constraints c
        join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name join all_constraints r on r.owner = c.r_owner and r.constraint_name = c.r_constraint_name
        join all_cons_columns rc on rc.owner = r.owner and rc.constraint_name = r.constraint_name and rc.position = cc.position
        where c.owner = :s and c.table_name = :t and c.constraint_type = 'R' order by c.constraint_name, cc.position`);
      return keysFrom(pk.map(r => r.col), idx, fk);
    },
    // result set cursor: no row cap, only limit+1 rows are fetched
    fetch: async (text, limit, onBatch) => {
      const r = await c.execute(text.replace(/;\s*$/, ''), [], { resultSet: true, outFormat: oracledb.OUT_FORMAT_ARRAY, autoCommit });
      if (!r.resultSet) return { columns: [], more: false };
      const columns = r.metaData.map(m => m.name);
      let got = 0, more = false;
      try {
        for (;;) {
          const rows = await r.resultSet.getRows(Math.min(BATCH, limit + 1 - got));
          if (!rows.length) break;
          got += rows.length;
          if (got > limit) { more = true; rows.length -= got - limit; }
          if (rows.length) onBatch(columns, rows);
          if (more) break;
        }
      } finally { await r.resultSet.close(); }
      return { columns, more };
    },
    explain: async stmt => { await run(`EXPLAIN PLAN FOR ${stmt.replace(/;\s*$/, '')}`); return run('SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY())'); },
    setAutoCommit: on => { autoCommit = on && !cfg.readOnly; },
    commit: () => c.commit(),
    rollback: () => c.rollback(),
    cancel: async () => { try { await c.break(); } catch {} },
    close: () => c.close(),
  };
}

// transaction SQL per engine; oracle uses the driver's autoCommit flag + commit()/rollback()
const TX = {
  postgres: { lazy: true, begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' },
  sqlite: { lazy: true, begin: 'BEGIN', commit: 'COMMIT', rollback: 'ROLLBACK' },
  mysql: { on: 'SET autocommit=1', off: 'SET autocommit=0', begin: 'START TRANSACTION', commit: 'COMMIT', rollback: 'ROLLBACK' },
  mssql: { on: 'SET IMPLICIT_TRANSACTIONS OFF', off: 'SET IMPLICIT_TRANSACTIONS ON', begin: 'BEGIN TRANSACTION', commit: 'IF @@TRANCOUNT > 0 COMMIT', rollback: 'IF @@TRANCOUNT > 0 ROLLBACK' },
  oracle: {},
  odbc: {},
};
// ---------- ODBC: any database with an ODBC driver installed on Windows (DB2, Snowflake, Teradata, Informix, HANA, …) ----------
// The connection string is a template: {host} {port} {database} {user} {password} {file} are filled in, values escaped
// for ODBC ({…} with "}" doubled when they contain ; { } or spaces). Nothing is downloaded: drivers come from the user.
const odbcValue = v => /[;{}=\s]/.test(String(v)) ? `{${String(v).replace(/}/g, '}}')}}` : String(v);
function odbcConnString(cfg) {
  const vals = { host: cfg.host, port: cfg.port, database: cfg.database, user: cfg.user, password: cfg.password, file: cfg.file };
  return String(cfg.template || '').replace(/\{(host|port|database|user|password|file)\}/g, (_m, k) => vals[k] == null ? '' : odbcValue(vals[k]));
}
async function openOdbc(cfg) {
  let odbc;
  try { odbc = require('odbc'); } catch { throw new Error('ODBC support is missing from this build'); }
  if (!cfg.template) throw new Error('No ODBC connection string: pick a database type or enter a connection string');
  const c = await odbc.connect({ connectionString: odbcConnString(cfg), connectionTimeout: 15, loginTimeout: 15 });
  const rowsOf = r => r.map(o => r.columns.map(x => o[x.name]));
  const run = async sql => {
    const r = await c.query(sql);
    if (!r.columns || !r.columns.length) return { columns: [], rows: [], affected: r.count >= 0 ? r.count : null, command: 'OK' };
    return { columns: r.columns.map(x => x.name), rows: rowsOf(r) };
  };
  const meta = async fn => { try { return await fn(); } catch { return []; } }; // catalog calls some drivers don't implement
  let manualTx = false, open = false;
  const end = async kind => { if (open) await c[kind](); open = false; if (manualTx) { await c.beginTransaction(); open = true; } };
  return {
    run,
    schema: async () => {
      const t = (await c.tables(null, null, null, null)).filter(x => /^(TABLE|VIEW)$/i.test(x.TABLE_TYPE || ''));
      const map = new Map(t.map(x => [`${x.TABLE_SCHEM || ''}.${x.TABLE_NAME}`, { schema: x.TABLE_SCHEM || '', name: x.TABLE_NAME, type: /VIEW/i.test(x.TABLE_TYPE) ? 'VIEW' : 'TABLE', columns: [] }]));
      for (const col of await meta(() => c.columns(null, null, null, null))) {
        const x = map.get(`${col.TABLE_SCHEM || ''}.${col.TABLE_NAME}`);
        if (x) x.columns.push({ name: col.COLUMN_NAME, type: col.TYPE_NAME, nullable: col.NULLABLE !== 0 });
      }
      return [...map.values()];
    },
    databases: async () => [],
    ddl: async (schema, table) => {
      const cols = await meta(() => c.columns(null, schema || null, table, null));
      return `-- generated from ODBC metadata
CREATE TABLE ${schema ? Q.ansi(schema) + '.' : ''}${Q.ansi(table)} (
${cols.map(x => `  ${Q.ansi(x.COLUMN_NAME)} ${x.TYPE_NAME}${x.COLUMN_SIZE && /char|binary/i.test(x.TYPE_NAME) ? `(${x.COLUMN_SIZE})` : ''}${x.NULLABLE === 0 ? ' NOT NULL' : ''}`).join(',\n')}
);`;
    },
    keys: async (schema, table) => {
      const pk = (await meta(() => c.primaryKeys(null, schema || null, table))).sort((a, b) => a.KEY_SEQ - b.KEY_SEQ).map(x => x.COLUMN_NAME);
      const fk = (await meta(() => c.foreignKeys(null, null, null, null, schema || null, table))).sort((a, b) => String(a.FK_NAME).localeCompare(String(b.FK_NAME)) || a.KEY_SEQ - b.KEY_SEQ)
        .map(x => ({ name: x.FK_NAME || `fk_${x.PKTABLE_NAME}`, col: x.FKCOLUMN_NAME, rs: x.PKTABLE_SCHEM || '', rt: x.PKTABLE_NAME, rcol: x.PKCOLUMN_NAME }));
      return keysFrom(pk, [], fk);
    },
    explain: async stmt => { if (!cfg.explainPrefix) throw new Error('No explain command set for this database type (Driver Manager → explain prefix)'); return run(`${cfg.explainPrefix} ${stmt}`); },
    fetch: async (sql, limit, onBatch) => {
      const cur = await c.query(sql, { cursor: true, fetchSize: BATCH });
      let got = 0, more = false, columns = [];
      try {
        while (!cur.noData) {
          const b = await cur.fetch();
          if (!columns.length && b.columns) columns = b.columns.map(x => x.name);
          if (!b.length) break;
          let rows = rowsOf(b);
          if (got + rows.length > limit) { more = true; rows = rows.slice(0, limit - got); }
          got += rows.length;
          if (rows.length) onBatch(columns, rows);
          if (more) break;
          if (got === limit && !cur.noData) { const peek = await cur.fetch(); more = peek.length > 0; break; }
        }
      } finally { await cur.close().catch(() => {}); }
      return { columns, more };
    },
    objects: async () => [],
    source: async () => { throw new Error('Not available over ODBC'); },
    setAutoCommit: async on => {
      manualTx = !on;
      if (!on && !open) { await c.beginTransaction(); open = true; }
      if (on && open) { await c.commit(); open = false; }
    },
    commit: () => end('commit'),
    rollback: () => end('rollback'),
    cancel: async () => { try { await c.cancel(); } catch {} },
    close: () => c.close(),
  };
}

const DRIVERS = { postgres: openPostgres, mysql: openMysql, mssql: openMssql, sqlite: openSqlite, oracle: openOracle, odbc: openOdbc };
const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mssql: 1433, oracle: 1521 };

const BATCH = 1000;
// row-returning statements that are streamed (limit+1 rows fetched, never the whole result)
const STREAMED = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);
// Binary values are shown like DBeaver's default "string" presentation: bytes that are valid, printable UTF-8 become
// text, anything else 0x… hex. full = whole value (exports); the grid gets the first PREVIEW bytes.
const PREVIEW = 65536;
const isBin = v => Buffer.isBuffer(v) || v instanceof Uint8Array || v instanceof ArrayBuffer; // ODBC returns ArrayBuffer
function binCell(v, full) {
  const all = Buffer.from(v instanceof ArrayBuffer ? new Uint8Array(v) : v), b = full || all.length <= PREVIEW ? all : all.subarray(0, PREVIEW);
  const more = b.length < all.length ? ` … [${all.length} bytes]` : '';
  try { // stream: a multi-byte character cut at the preview edge is not an error
    const t = new TextDecoder('utf-8', { fatal: true }).decode(b, { stream: !!more });
    if (!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(t)) return t + more;
  } catch {}
  return '0x' + b.toString('hex') + more;
}
const toCell = (v, full = false) => v === null || v === undefined ? null : typeof v === 'bigint' ? v.toString() : v instanceof Date ? v.toISOString() :
  isBin(v) ? binCell(v, full) : typeof v === 'object' ? JSON.stringify(v) : v;

// Node reports a refused IPv4+IPv6 connect as an AggregateError with an EMPTY message: turn it into something readable.
const NET_HINT = { ECONNREFUSED: 'connection refused — is the server running and the port right?', ETIMEDOUT: 'timed out — host unreachable or blocked by a firewall', ENOTFOUND: 'host name not found', EHOSTUNREACH: 'host unreachable', ECONNRESET: 'connection reset by the server' };
function connectError(e, cfg) {
  const inner = e && Array.isArray(e.errors) && e.errors.length ? e.errors[0] : e;
  const code = (inner && inner.code) || (e && e.code);
  if (!NET_HINT[code] && e && e.message) return e;
  const err = new Error(`Cannot connect to ${cfg.host || cfg.file || 'server'}${cfg.port ? ':' + cfg.port : ''}: ${NET_HINT[code] || (inner && inner.message) || code || 'connection failed'}`);
  err.code = code;
  return err;
}

async function open(cfg) {
  const d = DRIVERS[cfg.engine];
  if (!d) throw new Error('Unknown database engine ' + cfg.engine);
  let raw;
  try { raw = await d(cfg); } catch (e) { throw connectError(e, cfg); }
  // one connection = one query at a time (pg/mysql/mssql single connections); cancel/close bypass the queue
  let chain = Promise.resolve();
  const serial = fn => (...a) => { const p = chain.then(() => fn(...a)); chain = p.catch(() => {}); return p; };
  const drv = { ...raw, run: serial(raw.run), schema: serial(raw.schema), databases: serial(raw.databases), ddl: serial(raw.ddl), keys: serial(raw.keys), explain: serial(raw.explain), fetch: serial(raw.fetch), objects: serial(raw.objects), source: serial(raw.source) };
  // Manual-commit mode (DBeaver's "Manual commit"); postgres/sqlite open their transaction lazily at the first write.
  const tx = TX[cfg.engine];
  let manual = false, inTx = false, pending = 0;
  const begin = async () => { if (tx.lazy && !inTx) { await drv.run(tx.begin); inTx = true; } };
  const finish = async kind => {
    if (raw[kind]) await serial(raw[kind])();
    else if (!tx.lazy || inTx) await drv.run(tx[kind]);
    inTx = false; pending = 0;
  };
  return {
    ...drv,
    engine: cfg.engine,
    txState: () => ({ manual, pending }),
    async setAutoCommit(on) {
      if (on === !manual) return;
      if (on) await finish('commit'); // like DBeaver: switching back to auto-commit commits pending work
      if (raw.setAutoCommit) await raw.setAutoCommit(on); else if (tx.off) await drv.run(on ? tx.on : tx.off);
      manual = !on;
    },
    commit: () => finish('commit'),
    rollback: () => finish('rollback'),
    async explain(stmt) {
      const s = splitSql(stmt)[0] || stmt, t0 = Date.now();
      const r = await drv.explain(s);
      return { sql: s, columns: r.columns, rows: r.rows.map(row => row.map(toCell)), rowCount: r.rows.length, truncated: false, affected: null, command: 'EXPLAIN', ms: Date.now() - t0 };
    },
    // Grid edits, all-or-nothing. Each statement must hit exactly one row; otherwise the row changed,
    // was deleted, or the key is not unique, and nothing is saved.
    async applyEdits(stmts) {
      if (cfg.readOnly) throw new Error('Read-only connection');
      const own = !manual; // auto-commit: wrap in our own transaction
      if (!own) await begin();
      else if (raw.setAutoCommit) await raw.setAutoCommit(false);
      else { await drv.run(tx.begin); inTx = true; }
      try {
        for (const s of stmts) {
          const r = await drv.run(s);
          if (r.affected !== 1) throw new Error(`Expected 1 row, ${r.affected} affected${own ? ' — nothing was saved' : ''}\n${s.slice(0, 300)}`);
        }
        if (own) await finish('commit'); else pending += stmts.length;
      } catch (e) {
        if (own) await finish('rollback').catch(() => {});
        throw e;
      } finally { if (own && raw.setAutoCommit) await raw.setAutoCommit(true); }
      return stmts.length;
    },
    // Streams one read statement into onBatch(columns, rows) with full values (exports, data compare). -> { columns, rows, more }
    async stream(stmt, limit, onBatch) {
      if (classify(stmt).write) throw new Error('Only read queries (SELECT…) can be streamed');
      let n = 0;
      const f = await drv.fetch(stmt.replace(/;\s*$/, ''), limit, (c, batch) => { n += batch.length; onBatch(c, batch.map(row => row.map(v => toCell(v, true)))); });
      return { columns: f.columns, rows: n, more: f.more };
    },
    // Runs every statement of a script; read-only connections refuse writes before they reach the server.
    async query(script, { limit = 1000 } = {}) {
      const out = [];
      for (const stmt of splitSql(script)) {
        const write = classify(stmt).write;
        if (cfg.readOnly && write) throw new Error(`Read-only connection: refused to run\n${stmt.slice(0, 200)}`);
        if (manual && write) { await begin(); pending++; }
        const t0 = Date.now();
        let clipped = false; // a binary value was cut to its preview: exports must re-run the query for full values
        const cell = v => { if (v && isBin(v) && v.byteLength > PREVIEW) clipped = true; return toCell(v); };
        try {
          const kw = (stripComments(stmt).trim().match(/^[A-Za-z]+/) || [''])[0].toUpperCase();
          if (!write && STREAMED.has(kw)) {
            const rows = [];
            const f = await drv.fetch(stmt, limit, (_c, batch) => { for (const row of batch) rows.push(row.map(cell)); });
            // rowCount null = more rows exist on the server (not counted, not downloaded)
            out.push({ sql: stmt, columns: f.columns, rows, rowCount: f.more ? null : rows.length, truncated: f.more, clipped, affected: null, command: null, ms: Date.now() - t0 });
            continue;
          }
          const r = await drv.run(stmt);
          out.push({ sql: stmt, columns: r.columns, rows: r.rows.slice(0, limit).map(row => row.map(cell)), rowCount: r.rows.length, truncated: r.rows.length > limit, clipped, affected: r.affected ?? null, command: r.command || null, ms: Date.now() - t0 });
        } catch (e) { e.message = `${e.message}\n\nIn statement:\n${stmt.slice(0, 500)}`; e.partial = out; throw e; }
      }
      return out;
    },
  };
}

// ---------- data compare (DBeaver "Compare / Migrate data") ----------
// Matches rows by the source table's primary key and returns a summary plus the SQL that makes target equal source.
// s/t = { engine, schema, table }. Nothing is executed: the caller shows the SQL for review.
// ponytail: both tables are held in memory (capped by limit); binary columns compare as hex text and their sync SQL
// would write that text — exclude them, or diff chunk-by-chunk with ORDER BY pk if bigger tables matter.
async function compareTables(src, s, dst, t, { limit = 200000 } = {}) {
  const pk = (await src.keys(s.schema, s.table)).pk;
  if (!pk.length) throw new Error(`${s.table} has no primary key, so rows cannot be matched`);
  const load = async (conn, x) => {
    const rows = [];
    const r = await conn.stream(`SELECT * FROM ${fullName(x.engine, x.schema, x.table)}`, limit, (_c, b) => { for (const row of b) rows.push(row); });
    if (r.more) throw new Error(`${x.table} has more than ${limit} rows: too big to compare here`);
    return { cols: r.columns, idx: new Map(r.columns.map((c, i) => [c.toLowerCase(), i])), rows };
  };
  const A = await load(src, s), B = await load(dst, t);
  for (const p of pk) if (!B.idx.has(p.toLowerCase())) throw new Error(`The target table has no column "${p}"`);
  const common = A.cols.filter(c => B.idx.has(c.toLowerCase()));
  const get = (X, row, c) => row[X.idx.get(c.toLowerCase())];
  const tcol = c => B.cols[B.idx.get(c.toLowerCase())]; // the target's own spelling (e.g. Oracle upper case)
  const num = v => v !== null && v !== '' && typeof v !== 'boolean' && isFinite(v);
  const eq = (v, w) => v === null || w === null ? v === w : num(v) && num(w) ? +v === +w : String(v) === String(w);
  const keyOf = (X, row) => JSON.stringify(pk.map(p => { const v = get(X, row, p); return num(v) ? +v : v === null ? null : String(v); }));
  const keyFor = row => Object.fromEntries(pk.map(p => [tcol(p), get(B, row, p)]));
  const target = new Map(B.rows.map(r => [keyOf(B, r), r]));
  const inserts = [], updates = [], deletes = [], seen = new Set();
  let same = 0;
  for (const row of A.rows) {
    const k = keyOf(A, row); seen.add(k);
    const b = target.get(k);
    if (!b) { inserts.push(editSql(t.engine, t.schema, t.table, { type: 'insert', values: Object.fromEntries(common.map(c => [tcol(c), get(A, row, c)])) })); continue; }
    const set = {};
    for (const c of common) if (!eq(get(A, row, c), get(B, b, c))) set[tcol(c)] = get(A, row, c);
    if (Object.keys(set).length) updates.push(editSql(t.engine, t.schema, t.table, { type: 'update', key: keyFor(b), set })); else same++;
  }
  for (const [k, b] of target) if (!seen.has(k)) deletes.push(editSql(t.engine, t.schema, t.table, { type: 'delete', key: keyFor(b) }));
  return { pk, columns: common, missingInTarget: A.cols.filter(c => !B.idx.has(c.toLowerCase())), sourceRows: A.rows.length, targetRows: B.rows.length,
    onlySource: inserts.length, onlyTarget: deletes.length, different: updates.length, same, sql: [...deletes, ...updates, ...inserts] };
}

// ---------- export ----------
function toCsv(columns, rows) {
  const f = v => v === null ? '' : /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return [columns, ...rows].map(r => r.map(f).join(',')).join('\r\n');
}
function toInserts(engine, table, columns, rows) {
  const q = Q[engine] || Q.postgres;
  return rows.map(r => `INSERT INTO ${q(table)} (${columns.map(q).join(', ')}) VALUES (${r.map(v => lit(engine, v)).join(', ')});`).join('\n');
}
// Export formats (DBeaver's data transfer targets). ext = file extension, text = can also be copied to the clipboard.
const EXPORT_FORMATS = {
  csv: { label: 'CSV', ext: 'csv', text: true }, tsv: { label: 'TSV (tab-separated)', ext: 'tsv', text: true },
  txt: { label: 'TXT (aligned plain-text table)', ext: 'txt', text: true }, json: { label: 'JSON', ext: 'json', text: true },
  sql: { label: 'SQL INSERT statements', ext: 'sql', text: true }, md: { label: 'Markdown table', ext: 'md', text: true },
  html: { label: 'HTML table', ext: 'html', text: true }, xml: { label: 'XML', ext: 'xml', text: true },
  xlsx: { label: 'Excel workbook (.xlsx)', ext: 'xlsx', text: false },
};
const XLSX_MAX_ROWS = 1048576;
const xe = s => String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Streaming export: w = exportWriter(fmt, table, engine, opts); w.head(cols) + w.rows(cols, rows)... + w.tail();
// xlsx: the streamed text is the sheet, then w.pack(file, out) wraps it into the workbook.
// opts = { header = true, delimiter = ',', nullText = '', bom = false }. Values are written whole, never cut
// (except Excel's own limit of 32,767 characters per cell).
function exportWriter(fmt, table, engine, opts = {}) {
  const header = opts.header !== false, nul = opts.nullText || '', bom = opts.bom && ['csv', 'tsv', 'txt'].includes(fmt) ? '﻿' : '';
  const str = v => v === null || v === undefined ? nul : typeof v === 'object' ? JSON.stringify(v) : String(v);
  let n = 0;
  if (fmt === 'csv' || fmt === 'tsv') {
    const d = fmt === 'tsv' ? '\t' : opts.delimiter || ',', needs = new RegExp(`["\\r\\n${d === '\t' ? '\\t' : d.replace(/[\\^$.*+?()[\]{}|-]/g, '\\$&')}]`);
    const f = v => { const s = str(v); return needs.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const line = r => r.map(f).join(d) + '\r\n';
    return { head: c => bom + (header ? line(c) : ''), rows: (c, rows) => rows.map(line).join(''), tail: () => '' };
  }
  if (fmt === 'txt') { // column widths come from the header and the first batch; later, longer values just push their row wider
    let w = null;
    const flat = v => str(v).replace(/\r?\n|\r/g, ' ').replace(/\t/g, ' ');
    const line = r => '| ' + r.map((v, i) => { const s = flat(v); return typeof v === 'number' ? s.padStart(w[i]) : s.padEnd(w[i]); }).join(' | ') + ' |\r\n';
    const start = (c, rows) => {
      w = c.map((k, i) => Math.max(header ? String(k).length : 1, ...rows.map(r => flat(r[i]).length)));
      const sep = '|' + w.map(x => '-'.repeat(x + 2)).join('|') + '|\r\n';
      return bom + (header ? line(c) + sep : '');
    };
    return { head: () => '', rows: (c, rows) => (w ? '' : start(c, rows)) + rows.map(line).join(''), tail: c => w ? '' : start(c || [], []) };
  }
  if (fmt === 'json') return { head: () => '[\n', rows: (c, rows) => rows.map(r => (n++ ? ',\n' : '') + '  ' + JSON.stringify(Object.fromEntries(c.map((k, i) => [k, r[i] === undefined ? null : r[i]])))).join(''), tail: () => '\n]\n' };
  if (fmt === 'md') {
    const f = v => str(v).replace(/\|/g, '\\|').replace(/\r?\n|\r/g, '<br>');
    return { head: c => header ? `| ${c.map(f).join(' | ')} |\n|${c.map(() => ' --- ').join('|')}|\n` : '', rows: (c, rows) => rows.map(r => `| ${r.map(f).join(' | ')} |\n`).join(''), tail: () => '' };
  }
  if (fmt === 'html') return {
    head: c => `<!doctype html>\n<html><head><meta charset="utf-8"><title>${xe(table || 'Export')}</title><style>body{font:13px sans-serif}table{border-collapse:collapse}th,td{border:1px solid #bbb;padding:3px 8px;text-align:left;vertical-align:top;white-space:pre-wrap}th{background:#eee}td.n{text-align:right}td.null{color:#999;font-style:italic}</style></head><body>\n<table>\n${header ? `<tr>${c.map(k => `<th>${xe(k)}</th>`).join('')}</tr>\n` : ''}`,
    rows: (c, rows) => rows.map(r => `<tr>${r.map(v => v === null || v === undefined ? `<td class="null">${xe(nul)}</td>` : `<td${typeof v === 'number' ? ' class="n"' : ''}>${xe(str(v))}</td>`).join('')}</tr>\n`).join(''),
    tail: () => '</table>\n</body></html>\n',
  };
  if (fmt === 'xml') return {
    head: () => `<?xml version="1.0" encoding="UTF-8"?>\n<export table="${xe(table || '')}">\n`,
    rows: (c, rows) => rows.map(r => `  <row>\n${r.map((v, i) => v === null || v === undefined ? `    <column name="${xe(c[i])}" null="true"/>\n` : `    <column name="${xe(c[i])}">${xe(str(v))}</column>\n`).join('')}  </row>\n`).join(''),
    tail: () => '</export>\n',
  };
  if (fmt === 'xlsx') {
    const cellXml = (v, s = '') => v === null || v === undefined ? '<c/>' : typeof v === 'number' && isFinite(v) ? `<c${s}><v>${v}</v></c>`
      : `<c t="inlineStr"${s}><is><t xml:space="preserve">${xe(str(v).slice(0, 32767))}</t></is></c>`;
    const add = rows => { n += rows.length; if (n > XLSX_MAX_ROWS - (header ? 1 : 0)) throw new Error(`An Excel sheet holds at most ${XLSX_MAX_ROWS.toLocaleString('en')} rows: export this result as CSV instead`); };
    return {
      head: c => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0">${header ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' : ''}</sheetView></sheetViews><sheetData>\n${header ? `<row>${c.map(k => cellXml(k, ' s="1"')).join('')}</row>\n` : ''}`,
      rows: (c, rows) => { add(rows); return rows.map(r => `<row>${r.map(v => cellXml(v)).join('')}</row>\n`).join(''); },
      tail: () => '</sheetData></worksheet>\n',
      pack: (sheetFile, out) => require('fs').writeFileSync(out, xlsxZip(require('fs').readFileSync(sheetFile), table)),
    };
  }
  return { head: () => '', rows: (c, rows) => rows.length ? toInserts(engine, table || 'table_name', c, rows) + '\n' : '', tail: () => '' };
}
// whole export as one string (clipboard "Copy as …"); not for xlsx
function exportText(fmt, columns, rows, table, engine, opts) {
  const w = exportWriter(fmt, table, engine, opts);
  return w.head(columns) + w.rows(columns, rows) + w.tail(columns);
}
// ponytail: the sheet is read back whole to zip it; stream it through zlib if multi-GB workbooks ever matter
function xlsxZip(sheet, table) {
  const name = xe(String(table || 'Export').replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Export');
  return zip([
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>'],
    ['xl/worksheets/sheet1.xml', sheet],
  ]);
}
// minimal ZIP writer (deflate), enough for an .xlsx package
function zip(files) {
  const zlib = require('zlib'), parts = [], central = [];
  let off = 0;
  for (const [n, d] of files) {
    const name = Buffer.from(n), data = Buffer.isBuffer(d) ? d : Buffer.from(d), comp = zlib.deflateRawSync(data), crc = zlib.crc32(data);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(0, 10); h.writeUInt16LE(33, 12);
    h.writeUInt32LE(crc, 14); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(name.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(0, 12); c.writeUInt16LE(33, 14);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(name.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, name, comp); central.push(c, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}
const toJson = (columns, rows) => JSON.stringify(rows.map(r => Object.fromEntries(columns.map((c, i) => [c, r[i]]))), null, 2);

module.exports = { open, odbcConnString, FLAVORS, splitSql, statementAt, classify, selectSql, editSql, compareTables, toCsv, toJson, toInserts, exportWriter, exportText, EXPORT_FORMATS, xlsxZip, toCell, DEFAULT_PORTS, Q };
