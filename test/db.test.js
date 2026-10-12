const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../core/db');

test('splitSql handles quotes, comments, dollar blocks and GO', () => {
  assert.deepEqual(db.splitSql("select 'a;b'; select 2 -- x;y\n; /* ; */ select 3"), ["select 'a;b'", 'select 2 -- x;y', '/* ; */ select 3']);
  assert.deepEqual(db.splitSql('create function f() returns int as $$ begin return 1; end $$ language plpgsql; select 1'), ['create function f() returns int as $$ begin return 1; end $$ language plpgsql', 'select 1']);
  assert.deepEqual(db.splitSql('select 1\nGO\nselect [a;b]\ngo'), ['select 1', 'select [a;b]']);
  assert.deepEqual(db.splitSql("select 'it''s;'; ;  -- only comment"), ["select 'it''s;'"]);
});

test('statementAt: Run executes only the statement under the cursor', () => {
  const sql = "select 1;\nselect 'a;b' from t;\nupdate t\n  set x = 1\n  where id = 2;\nselect 4";
  const at = s => db.statementAt(sql, sql.indexOf(s));
  assert.equal(at('select 1'), 'select 1');
  assert.equal(at('a;b'), "select 'a;b' from t");          // ";" inside a string does not split
  assert.equal(at('set x'), 'update t\n  set x = 1\n  where id = 2'); // a multi-line statement is taken whole
  assert.equal(db.statementAt(sql, sql.indexOf(';')), 'select 1');      // cursor right at the ";"
  assert.equal(db.statementAt(sql, sql.indexOf(';') + 1), 'select 1');  // end of that line
  assert.equal(at('select 4'), 'select 4');
  assert.equal(db.statementAt('create trigger tr after insert on t begin select 1; select 2; end;\nselect 3', 30), 'create trigger tr after insert on t begin select 1; select 2; end;');
});

test('splitSql keeps BEGIN…END bodies, DELIMITER and Oracle "/" blocks together', () => {
  const s = db.splitSql;
  // sqlite / mysql trigger with a body
  assert.deepEqual(s('create trigger tr after insert on t begin update x set a = 1; delete from y; end; select 1'),
    ['create trigger tr after insert on t begin update x set a = 1; delete from y; end;', 'select 1']);
  // CASE … END inside a block does not close it early; END IF does not count
  assert.equal(s('create procedure p() begin if a then set b = case when 1 then 2 end; end if; select 1; end; select 2').length, 2);
  // MySQL DELIMITER scripts
  assert.deepEqual(s('DELIMITER $$\ncreate procedure p() begin select 1; end$$\nDELIMITER ;\nselect 2;'), ['create procedure p() begin select 1; end', 'select 2']);
  // Oracle: declarations before BEGIN, "/" terminator, package spec without BEGIN
  assert.deepEqual(s('create or replace procedure p is x number; begin x := 1; end;\n/\nselect 1 from dual'), ['create or replace procedure p is x number; begin x := 1; end;', 'select 1 from dual']);
  assert.deepEqual(s('declare v int; begin v := 1; end;\nselect 2 from dual'), ['declare v int; begin v := 1; end;', 'select 2 from dual']);
  assert.deepEqual(s('create package pk as procedure a; end pk;\n/\nselect 1'), ['create package pk as procedure a; end pk;', 'select 1']);
  // postgres: $$ bodies, functions without BEGIN outside $$, plain CASE in a query
  assert.deepEqual(s('create function f() returns int as $$ begin return 1; end $$ language plpgsql; select case when 1=1 then 1 end; select 3'),
    ['create function f() returns int as $$ begin return 1; end $$ language plpgsql', 'select case when 1=1 then 1 end', 'select 3']);
  assert.deepEqual(s('create function f() returns int deterministic return 1; select 2'), ['create function f() returns int deterministic return 1', 'select 2']);
  // a division "/" mid-line is not a terminator; pg trigger without body splits normally
  assert.deepEqual(s('select 4 / 2; create trigger t before insert on x for each row execute function f(); select 1'), ['select 4 / 2', 'create trigger t before insert on x for each row execute function f()', 'select 1']);
});

test('classify flags writes and dangerous statements', () => {
  const c = s => db.classify(s);
  assert.deepEqual(c('SELECT * FROM t'), { write: false, danger: null });
  assert.deepEqual(c("select 'drop table x' from t"), { write: false, danger: null });
  assert.equal(c('-- hi\nshow tables').write, false);
  assert.equal(c('with x as (select 1) select * from x').write, false);
  assert.equal(c('with x as (delete from t returning *) select * from x').write, true);
  assert.equal(c('insert into t values (1)').write, true);
  assert.equal(c('select * into newt from t').write, true);
  assert.equal(c('delete from t where id = 1').danger, null);
  assert.match(c('DELETE FROM t').danger, /without WHERE/);
  assert.match(c("update t set a = 'where'").danger, /without WHERE/);
  assert.match(c('drop table t').danger, /DROP/);
  assert.match(c('truncate t').danger, /TRUNCATE/);
  assert.equal(c('pragma table_info(t)').write, false);
});

test('export helpers', () => {
  assert.equal(db.toCsv(['a', 'b'], [[1, 'x,"y"'], [null, 'z']]), 'a,b\r\n1,"x,""y"""\r\n,z');
  assert.equal(db.toInserts('mysql', 't', ['a', 'b'], [[1, "o'k"]]), "INSERT INTO `t` (`a`, `b`) VALUES (1, 'o''k');");
  assert.deepEqual(JSON.parse(db.toJson(['a'], [[1]])), [{ a: 1 }]);
  assert.equal(db.selectSql('mssql', 'dbo', 'x]y', 5), 'SELECT TOP 5 * FROM [dbo].[x]]y];');
  assert.equal(db.selectSql('postgres', 'public', 't'), 'SELECT * FROM "public"."t" LIMIT 200;');
});

test('sqlite: query, schema, ddl, limit, read-only', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mxdb-')), 't.db');
  const c = await db.open({ engine: 'sqlite', file });
  const r = await c.query("create table users(id integer primary key, name text not null, blob b); insert into users(name) values ('a'),('b'),('c'); select * from users order by id", { limit: 2 });
  assert.equal(r.length, 3);
  assert.equal(r[1].affected, 3);
  assert.deepEqual(r[2].columns, ['id', 'name', 'blob']);
  assert.deepEqual(r[2].rows, [[1, 'a', null], [2, 'b', null]]);
  assert.equal(r[2].truncated, true);
  const s = await c.schema();
  assert.deepEqual(s.map(t => [t.name, t.columns.map(x => x.name)]), [['users', ['id', 'name', 'blob']]]);
  assert.match(await c.ddl('', 'users'), /CREATE TABLE users/);
  await assert.rejects(c.query('select * from nope'), /no such table[\s\S]*In statement/);
  c.close();
  const ro = await db.open({ engine: 'sqlite', file, readOnly: true });
  assert.equal((await ro.query('select count(*) n from users'))[0].rows[0][0], 3);
  await assert.rejects(ro.query('delete from users where id = 1'), /Read-only/);
  ro.close();
});

test('sqlite: keys, explain, grid edits, manual commit', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mxdb-')), 't.db');
  const c = await db.open({ engine: 'sqlite', file });
  await c.query("create table p(id integer primary key); create table k(a int, b text, p_id int references p(id), note text, primary key (a, b)); create unique index k_note on k(note); insert into p values (1); insert into k values (1, 'x', 1, 'n1'), (2, 'y', null, 'n2')");
  const k = await c.keys('', 'k');
  assert.deepEqual(k.pk, ['a', 'b']);
  assert.ok(k.indexes.find(i => i.name === 'k_note' && i.unique && i.columns[0] === 'note'));
  assert.deepEqual(k.fks.map(f => [f.columns, f.refTable, f.refColumns]), [[['p_id'], 'p', ['id']]]);
  assert.ok((await c.explain('select * from k where a = 1;')).rows.length > 0);
  const e = ch => db.editSql('sqlite', '', 'k', ch);
  assert.equal(await c.applyEdits([e({ type: 'update', key: { a: 1, b: 'x' }, set: { note: "it's" } }), e({ type: 'insert', values: { a: 3, b: 'z' } }), e({ type: 'delete', key: { a: 2, b: 'y' } })]), 3);
  const rows = async () => (await c.query('select a, note from k order by a'))[0].rows;
  assert.deepEqual(await rows(), [[1, "it's"], [3, null]]);
  // a key that matches nothing rolls back the whole batch
  await assert.rejects(c.applyEdits([e({ type: 'update', key: { a: 1, b: 'x' }, set: { note: 'changed' } }), e({ type: 'delete', key: { a: 9, b: 'q' } })]), /Expected 1 row, 0 affected/);
  assert.deepEqual(await rows(), [[1, "it's"], [3, null]]);
  // manual commit: rollback discards, commit keeps
  await c.setAutoCommit(false);
  await c.query("update k set note = 'tmp' where a = 1");
  assert.deepEqual(c.txState(), { manual: true, pending: 1 });
  await c.rollback();
  assert.deepEqual(await rows(), [[1, "it's"], [3, null]]);
  await c.query('delete from k where a = 3');
  await c.commit();
  await c.setAutoCommit(true);
  assert.deepEqual(await rows(), [[1, "it's"]]);
  assert.deepEqual(c.txState(), { manual: false, pending: 0 });
  // streaming: the grid gets limit rows and "more", exports get every row with full binary values
  await c.query("create table big(n integer, b blob); with recursive s(n) as (select 1 union all select n + 1 from s where n < 2500) insert into big select n, randomblob(400) from s");
  const [g] = await c.query('select n from big order by n', { limit: 10 });
  assert.deepEqual([g.rows.length, g.truncated, g.rowCount], [10, true, null]);
  let seen = 0, batches = 0, blobLen = 0;
  const st = await c.stream('select n, b from big order by n', 2400, (cols, rows) => { batches++; seen += rows.length; blobLen = rows[0][1].length; });
  assert.deepEqual([st.rows, st.more, seen, batches >= 3, blobLen], [2400, true, 2400, true, 802]);
  await assert.rejects(c.stream('delete from big', 1, () => {}), /Only read/);
  const w = db.exportWriter('csv'); assert.equal(w.head(['a', 'b']) + w.rows(['a', 'b'], [[1, 'x,y']]), 'a,b\r\n1,"x,y"\r\n');
  c.close();
});

test('sqlite: objects + source, compare tables across two databases and apply the sync SQL', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxdb-'));
  const a = await db.open({ engine: 'sqlite', file: path.join(dir, 'a.db') }), b = await db.open({ engine: 'sqlite', file: path.join(dir, 'b.db') });
  await a.query("create table t(id integer primary key, name text, price real); insert into t values (1,'a',1.5),(2,'b',2),(3,'c',3); create trigger tr after insert on t begin select 1; end");
  await b.query("create table t(id integer primary key, name text, price real, extra text); insert into t values (1,'a',1.50,'x'),(2,'B',2,null),(4,'d',4,null)");
  const o = await a.objects();
  assert.deepEqual(o.map(x => [x.type, x.name]), [['TRIGGER', 'tr']]);
  assert.match(await a.source(o[0]), /begin select 1; end/i);
  const s = { engine: 'sqlite', schema: '', table: 't' };
  const r = await db.compareTables(a, s, b, s);
  assert.deepEqual([r.same, r.different, r.onlySource, r.onlyTarget], [1, 1, 1, 1]); // 1.5 == 1.50 counts as same
  await b.applyEdits(r.sql);
  const again = await db.compareTables(a, s, b, s);
  assert.deepEqual([again.same, again.sql.length], [3, 0]);
  assert.equal((await b.query('select extra from t where id = 1'))[0].rows[0][0], 'x'); // target-only column untouched
  a.close(); b.close();
});

test('odbc: connection-string template escaping', () => {
  const cs = db.odbcConnString({ template: 'Driver={Some Driver};Server={host};Port={port};Database={database};Uid={user};Pwd={password};', host: 'h', port: 50000, database: 'd b', user: 'u', password: 'p;w}x' });
  assert.equal(cs, 'Driver={Some Driver};Server=h;Port=50000;Database={d b};Uid=u;Pwd={p;w}}x};');
  assert.equal(db.selectSql('ansi', 'S', 'T', 10, 'a = 1'), 'SELECT * FROM "S"."T" WHERE a = 1;');
});

// Windows ships an ODBC text driver: a folder of .csv files becomes a database
const TEXT_DRIVER = 'Microsoft Access Text Driver (*.txt, *.csv)';
const hasTextDriver = process.platform === 'win32' && require('child_process').spawnSync('reg', ['query', 'HKLM\\SOFTWARE\\ODBC\\ODBCINST.INI\\ODBC Drivers', '/v', TEXT_DRIVER], { windowsHide: true }).status === 0;
test('odbc: query, stream, schema over the Windows text driver', { skip: !hasTextDriver && 'ODBC text driver not installed' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mxodbc-'));
  fs.writeFileSync(path.join(dir, 'fruit.csv'), 'id,name\n' + Array.from({ length: 2500 }, (_, i) => `${i + 1},f${i + 1}`).join('\n') + '\n');
  const c = await db.open({ engine: 'odbc', template: `Driver={${TEXT_DRIVER}};Dbq={file};Extensions=csv;`, file: dir });
  const s = await c.schema();
  assert.deepEqual(s.map(t => [t.name, t.columns.map(x => x.name)]), [['fruit.csv', ['id', 'name']]]);
  const [r] = await c.query(db.selectSql('mssql', '', 'fruit.csv', 5) + '\nselect * from [fruit.csv] where id > 2490', { limit: 3 }).then(x => x.slice(-1));
  assert.deepEqual([r.rows.length, r.truncated, r.rows[0]], [3, true, [2491, 'f2491']]);
  let n = 0; const st = await c.stream('select * from [fruit.csv]', 2500, (_c, rows) => { n += rows.length; });
  assert.deepEqual([n, st.more], [2500, false]);
  assert.deepEqual((await c.keys('', 'fruit.csv')).pk, []); // text driver has no keys: grid stays read-only
  c.close();
});

// keys / explain / grid edits / manual commit on a live server; table t has primary key id
async function liveEdits(c, engine, schema, t) {
  const k = await c.keys(schema, t);
  assert.deepEqual(k.pk.map(x => x.toLowerCase()), ['id']);
  assert.ok(k.indexes.length >= 1);
  assert.ok((await c.explain(`select * from ${t} where id = 1`)).rows.length > 0);
  const id = engine === 'oracle' ? 'ID' : 'id', name = engine === 'oracle' ? 'NAME' : 'name';
  const e = ch => db.editSql(engine, schema, t, ch);
  await c.applyEdits([e({ type: 'update', key: { [id]: 1 }, set: { [name]: "o'k\\" } }), e({ type: 'insert', values: { [id]: 3, [name]: 'new' } })]);
  const names = async () => (await c.query(`select ${name} from ${t} order by ${id}`))[0].rows.map(r => r[0]);
  assert.equal((await names())[0], "o'k\\");
  await assert.rejects(c.applyEdits([e({ type: 'delete', key: { [id]: 3 } }), e({ type: 'delete', key: { [id]: 99 } })]), /Expected 1 row/);
  assert.equal((await names()).length, 3);
  await c.setAutoCommit(false);
  await c.query(`delete from ${t} where ${id} = 3`);
  await c.rollback();
  assert.equal((await names()).length, 3);
  await c.query(`delete from ${t} where ${id} = 3`);
  await c.setAutoCommit(true); // commits
  assert.equal((await names()).length, 2);
  // streaming stops after the limit and leaves the connection usable (mysql kills the rest server-side)
  const [g] = await c.query(`select * from ${t} order by ${id}`, { limit: 1 });
  assert.deepEqual([g.rows.length, g.truncated, g.rowCount], [1, true, null]);
  let n = 0; const st = await c.stream(`select * from ${t}`, 1, (_c, rows) => { n += rows.length; });
  assert.deepEqual([n, st.more], [1, true]);
  assert.equal((await names()).length, 2);
  // a routine with a BEGIN…END body survives the script splitter and shows up as an object with its source
  const fn = `${t}_fn`;
  const create = {
    postgres: `create function ${fn}() returns int language plpgsql as $$ begin return 1; end $$`,
    mysql: `create procedure ${fn}() begin select 1; select 2; end`,
    mssql: `create procedure ${fn} as begin select 1; select 2; end`,
    oracle: `create or replace procedure ${fn.toUpperCase()} is v number; begin v := 1; v := v + 1; end;`,
  }[engine];
  await c.query(create + ';\nselect 1' + (engine === 'oracle' ? ' from dual' : ''));
  const o = (await c.objects()).find(x => x.name.toLowerCase().startsWith(fn.toLowerCase()));
  assert.ok(o, 'routine listed');
  assert.match(await c.source(o), /begin/i);
  await c.query(`drop ${engine === 'postgres' ? 'function' : 'procedure'} ${engine === 'oracle' ? fn.toUpperCase() : fn}`);
}

// views / materialized views in the navigator with their DDL, long GROUP_CONCAT, binary values shown as text
async function liveNavigator(c, engine) {
  const v = 'mxc_v' + (Date.now() % 100000), mv = v + 'm';
  const t = engine === 'oracle' ? 'dual' : '(select 1 as n) x';
  await c.query(`create view ${v} as select 1 as n from ${t}`);
  const hasMv = engine === 'postgres' || engine === 'oracle';
  if (hasMv) await c.query(`create materialized view ${mv} as select 2 as n from ${t}`);
  const s = await c.schema(), find = n => s.find(x => x.name.toLowerCase() === n);
  assert.equal(find(v).type, 'VIEW');
  assert.match(await c.ddl(find(v).schema, find(v).name), /view/i);
  if (hasMv) { assert.equal(find(mv).type, 'MVIEW'); assert.ok(find(mv).columns.length); assert.match(await c.ddl(find(mv).schema, find(mv).name), /materialized view/i); }
  const bin = { postgres: "select 'hi'::bytea, '\\x00ff'::bytea", mysql: "select cast('hi' as binary), unhex('00ff')", oracle: "select to_blob(utl_raw.cast_to_raw('hi')), hextoraw('00FF') from dual" }[engine];
  if (bin) { const [b] = await c.query(bin); assert.deepEqual(b.rows[0].map(x => String(x).toLowerCase()), ['hi', '0x00ff']); }
  if (engine === 'mysql') { const [g] = await c.query("select group_concat(x) from (select repeat('a', 2000) as x union all select repeat('b', 2000)) t"); assert.equal(String(g.rows[0][0]).length, 4001); }
  if (hasMv) await c.query(`drop materialized view ${mv}`);
  await c.query(`drop view ${v}`);
}

// Real servers: set MXC_PG / MXC_MYSQL to a JSON connection config to run these.
for (const [env, engine] of [['MXC_PG', 'postgres'], ['MXC_MYSQL', 'mysql'], ['MXC_MSSQL', 'mssql']]) {
  test(`${engine} live`, { skip: !process.env[env] && `${env} not set` }, async () => {
    const cfg = { engine, ...JSON.parse(process.env[env]) };
    const c = await db.open(cfg);
    const t = 'mxc_test_' + Date.now();
    await c.query(`create table ${t} (id int primary key, name varchar(20), created date); insert into ${t} values (1, 'x;y', '2024-01-02'), (2, null, null)`);
    const [r] = await c.query(`select id, name, created from ${t} order by id`);
    assert.deepEqual(r.columns, ['id', 'name', 'created']);
    assert.equal(r.rows[0][1], 'x;y');
    assert.match(String(r.rows[0][2]), /^2024-01-0[12]/);
    assert.equal(r.rows[1][1], null);
    const s = await c.schema();
    assert.ok(s.find(x => x.name === t && x.columns.length === 3));
    assert.ok((await c.databases()).length > 0);
    assert.ok((await c.ddl(s.find(x => x.name === t).schema, t)).includes('name'));
    await liveEdits(c, engine, s.find(x => x.name === t).schema, t);
    await liveNavigator(c, engine);
    await c.query(`drop table ${t}`);
    c.close();
    const ro = await db.open({ ...cfg, readOnly: true });
    await assert.rejects(ro.query(`create table ${t} (id int)`), /Read-only/);
    ro.close();
  });
}

// Oracle lives in its own env var because its config differs (service name).
test('oracle live', { skip: !process.env.MXC_ORACLE && 'MXC_ORACLE not set' }, async () => {
  const cfg = { engine: 'oracle', ...JSON.parse(process.env.MXC_ORACLE) };
  const c = await db.open(cfg);
  const t = 'MXC_T' + (Date.now() % 100000);
  await c.query(`create table ${t} (id number primary key, name varchar2(20))`);
  await c.query(`insert into ${t} values (1, 'x;y')`);
  const [r] = await c.query(`select id, name from ${t} order by id`);
  assert.deepEqual(r.columns.map(x => x.toUpperCase()), ['ID', 'NAME']);
  assert.equal(r.rows[0][1], 'x;y');
  const s = await c.schema();
  assert.ok(s.find(x => x.name === t));
  assert.ok((await c.ddl(s.find(x => x.name === t).schema, t)).length > 0);
  await c.query(`insert into ${t} values (2, null)`);
  await liveEdits(c, 'oracle', s.find(x => x.name === t).schema, t);
  await liveNavigator(c, 'oracle');
  await c.query(`drop table ${t}`);
  c.close();
  const ro = await db.open({ ...cfg, readOnly: true });
  await assert.rejects(ro.query(`create table ${t} (id number)`), /Read-only/);
  ro.close();
});

test('binary values: printable UTF-8 is decoded, other bytes are hex, big values are cut only in the grid preview', () => {
  assert.equal(db.toCell(Buffer.from('héllo, wörld\n')), 'héllo, wörld\n');
  assert.equal(db.toCell(new Uint8Array([0xde, 0xad, 0xbe, 0xef])), '0xdeadbeef');
  assert.equal(db.toCell(Buffer.from([0x00, 0x41])), '0x0041');                 // control bytes stay hex
  assert.equal(db.toCell(new Uint8Array([0x68, 0x69]).buffer), 'hi');           // ODBC ArrayBuffer
  const big = Buffer.from('é'.repeat(40000));                                    // 80,000 bytes, cut inside a character
  assert.match(db.toCell(big), /^é+ … \[80000 bytes\]$/);
  assert.equal(db.toCell(big, true), 'é'.repeat(40000));
});

test('export formats: every value whole, options for header / delimiter / NULL text / BOM', () => {
  const cols = ['id', 'note'], rows = [[1, 'a|b\nc'], [22, null]];
  const t = (fmt, o) => db.exportText(fmt, cols, rows, 'tbl', 'postgres', o);
  assert.equal(t('csv', { delimiter: ';', nullText: 'NULL' }), 'id;note\r\n1;"a|b\nc"\r\n22;NULL\r\n');
  assert.equal(t('tsv', { header: false }), '1\t"a|b\nc"\r\n22\t\r\n');
  assert.equal(t('txt'), '| id | note  |\r\n|----|-------|\r\n|  1 | a|b c |\r\n| 22 |       |\r\n');
  assert.equal(t('md'), '| id | note |\n| --- | --- |\n| 1 | a\\|b<br>c |\n| 22 |  |\n');
  assert.match(t('html'), /<tr><td class="n">1<\/td><td>a\|b\nc<\/td><\/tr>/);
  assert.match(t('xml'), /<column name="note" null="true"\/>/);
  assert.deepEqual(JSON.parse(t('json')), [{ id: 1, note: 'a|b\nc' }, { id: 22, note: null }]);
  assert.equal(t('csv', { bom: true }).charCodeAt(0), 0xfeff);
  assert.equal(db.exportText('txt', cols, [], 't'), '| id | note |\r\n|----|------|\r\n');      // no rows: header only
});

test('xlsx export is a valid zip with the sheet inside', () => {
  const zlib = require('zlib');
  const w = db.exportWriter('xlsx', 'my/sheet', 'postgres');
  const sheet = w.head(['n', 's']) + w.rows(['n', 's'], [[1.5, 'x<y'], [null, 'é']]) + w.tail();
  const zip = db.xlsxZip(Buffer.from(sheet), 'my/sheet');
  // walk the local file headers and inflate each entry
  const files = {};
  for (let p = 0; zip.readUInt32LE(p) === 0x04034b50;) {
    const size = zip.readUInt32LE(p + 18), nl = zip.readUInt16LE(p + 26), name = zip.toString('utf8', p + 30, p + 30 + nl);
    const data = zlib.inflateRawSync(zip.subarray(p + 30 + nl, p + 30 + nl + size));
    assert.equal(zlib.crc32(data), zip.readUInt32LE(p + 14));
    files[name] = data.toString(); p += 30 + nl + size;
  }
  assert.deepEqual(Object.keys(files).sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  assert.match(files['xl/worksheets/sheet1.xml'], /<c><v>1.5<\/v><\/c><c t="inlineStr"><is><t xml:space="preserve">x&lt;y<\/t>/);
  assert.match(files['xl/workbook.xml'], /name="my sheet"/);
});
