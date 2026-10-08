const test = require('node:test');
const assert = require('node:assert');
const mf = require('../core/moba-files');

test('password export: credentials and session passwords', () => {
  const txt = [
    'web UI1(alice) = s3cret',
    'plain(bob) = bob',
    'node (1)(root) = Pa=ss = word ',
    'empty(carol) = ',
    'ssh22:dave@10.0.0.5 = davepw',
    'eve@host.example = evepw',
    'garbage line',
    '',
  ].join('\r\n');
  const r = mf.parsePasswordExport(txt);
  assert.deepEqual(r.credentials, [
    { name: 'web UI1', username: 'alice', password: 's3cret' },
    { name: 'plain', username: 'bob', password: 'bob' },
    { name: 'node (1)', username: 'root', password: 'Pa=ss = word ' },
    { name: 'empty', username: 'carol', password: '' },
  ]);
  assert.deepEqual(r.passwords.map(p => [p.proto, p.port, p.user, p.host, p.password]),
    [['ssh', '22', 'dave', '10.0.0.5', 'davepw'], [undefined, undefined, 'eve', 'host.example', 'evepw']]);
  assert.deepEqual(r.skipped, ['garbage line']);
});

test('macro export: text, keys, waits and escapes', () => {
  const ini = [
    '[Macros]',
    'login=12:0:0:hunter2|258:13:1835009:RETURN|0:0:0:SLEEPEQUAL1200|',
    'typeonly=12:4:0:no enter here|',
    'grep=12:4:0:ps -eaf PIIPE grep java|258:13:1835009:RETURN|',
    'tabs=12:0:0:cd /ap|258:9:983041:TAB|12:0:0:sc|258:9:983041:TAB|258:13:1835009:RETURN|',
    'awk=12:4:0:kill $(ps PIIPE awk \'{print $2}\')|',
    'cfg=12:4:0:run --config__EQQUAL__a.xml &|',
    'jdbc=12:2:0:x jdbc__DBLDOT__edb__DBLDOT__//10.0.0.1__DBLDOT__5444/db|258:13:1835009:RETURN|',
    'odd=12:0:0:a|258:999:1:WEIRDKEY|',
    '[MacrosHotkeys]',
    'login=0',
  ].join('\r\n');
  const m = Object.fromEntries(mf.parseMacroExport(ini).map(x => [x.name, x]));
  assert.deepEqual(Object.keys(m), ['login', 'typeonly', 'grep', 'tabs', 'awk', 'cfg', 'jdbc', 'odd']);
  assert.equal(m.login.text, 'hunter2\n{WAIT:1200}');
  assert.equal(m.typeonly.text, 'no enter here');
  assert.equal(m.grep.text, 'ps -eaf | grep java\n');
  assert.equal(m.tabs.text, 'cd /ap{TAB}sc{TAB}\n');
  assert.equal(m.awk.text, "kill $(ps | awk '{print $2}')");
  assert.equal(m.cfg.text, 'run --config=a.xml &');
  assert.equal(m.jdbc.text, 'x jdbc:edb://10.0.0.1:5444/db\n');
  assert.deepEqual([m.odd.text, m.odd.unknown], ['a', ['258:999:1:WEIRDKEY']]);
});

test('macro names with spaces, dots and no [Macros] header', () => {
  const r = mf.parseMacroExport('cd /app/x..=12:4:0: cd /app/|\nps  jboss=12:4:0:ps|');
  assert.deepEqual(r.map(x => [x.name, x.text]), [['cd /app/x..', ' cd /app/'], ['ps  jboss', 'ps']]);
});
