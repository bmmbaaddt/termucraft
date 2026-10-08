const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const dbe = require('../core/dbeaver');

// Encrypt like DBeaver so we can validate the decryptor (IV prepended, AES-128-CBC, NoPadding + manual pad).
function dbeaverEncrypt(obj) {
  const iv = crypto.randomBytes(16);
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  const pad = (16 - (data.length % 16)) % 16;
  const c = crypto.createCipheriv('aes-128-cbc', dbe.LOCAL_KEY, iv).setAutoPadding(false);
  return Buffer.concat([iv, c.update(Buffer.concat([data, Buffer.alloc(pad)])), c.final()]);
}

test('decryptCredentials round-trips DBeaver-format blob', () => {
  const creds = { 'postgres-jdbc-1': { user: 'admin', password: 's3cr3t' }, 'mysql8-2': { user: 'root', password: 'p@ss' } };
  assert.deepEqual(dbe.decryptCredentials(dbeaverEncrypt(creds)), creds);
});

test('fromUrl parses jdbc urls', () => {
  assert.deepEqual(dbe.fromUrl('postgres', 'jdbc:postgresql://db.host:5433/mydb'), { host: 'db.host', port: 5433, database: 'mydb' });
  assert.deepEqual(dbe.fromUrl('oracle', 'jdbc:oracle:thin:@//ora.host:1521/ORCLPDB1'), { host: 'ora.host', port: 1521, database: 'ORCLPDB1' });
  assert.deepEqual(dbe.fromUrl('oracle', 'jdbc:oracle:thin:@ora.host:1522:XE'), { host: 'ora.host', port: 1522, database: 'XE' });
  assert.equal(dbe.fromUrl('mssql', 'jdbc:sqlserver://sql.host:1433;databaseName=app').database, 'app');
});

test('buildPreview maps providers, merges passwords and SSH tunnels', () => {
  const dataSources = {
    folders: { Prod: {} },
    connections: {
      'postgres-jdbc-1': { provider: 'postgresql', driver: 'postgres-jdbc', name: 'prod pg', folder: 'Prod', configuration: { host: 'pg.host', port: '5432', database: 'app' } },
      'oracle-2': { provider: 'oracle', driver: 'oracle_thin', name: 'warehouse', configuration: { url: 'jdbc:oracle:thin:@//ora:1521/ORCL' } },
      'mysql8-3': { provider: 'mysql', driver: 'mysql8', name: 'tunnelled', configuration: { host: 'internal.db', port: '3306', handlers: { ssh_tunnel: { enabled: true, user: 'ec2', properties: { host: 'bastion.example', port: '22' } } } } },
      'sqlite-4': { provider: 'sqlite', driver: 'sqlite_jdbc', name: 'local', configuration: { url: 'jdbc:sqlite:C:/data/app.db' } },
      'mongo-5': { provider: 'mongodb', driver: 'mongodb', name: 'nope', configuration: {} },
    },
  };
  // real DBeaver nesting: per-connection object with "#connection" and "ssh_tunnel" sub-entries
  const creds = {
    'postgres-jdbc-1': { '#connection': { user: 'pguser', password: 'pgpass' } },
    'mysql8-3': { '#connection': { user: 'dbuser', password: 'dbpass' }, 'ssh_tunnel': { user: 'ec2', password: 'sshpass' } },
  };
  const p = dbe.buildPreview({ dataSources, credsBuffer: dbeaverEncrypt(creds) });
  assert.deepEqual(p.stats, { total: 5, importable: 4, unsupported: 1, withPassword: 2, sshTunnels: 1, linkedScripts: 0, unlinkedScripts: 0 });

  const pg = p.dbs.find(d => d.name === 'prod pg');
  assert.deepEqual([pg.engine, pg.host, pg.port, pg.database, pg.user, pg.password, pg.env, pg.folder], ['postgres', 'pg.host', 5432, 'app', 'pguser', 'pgpass', 'prod', 'DBeaver/Prod']);
  const ora = p.dbs.find(d => d.name === 'warehouse');
  assert.deepEqual([ora.engine, ora.host, ora.port, ora.database], ['oracle', 'ora', 1521, 'ORCL']);
  const my = p.dbs.find(d => d.name === 'tunnelled');
  assert.ok(my.sshId && p.sshSessions[0].host === 'bastion.example' && p.sshSessions[0].password === 'sshpass');
  assert.equal(my.password, 'dbpass');
  const lite = p.dbs.find(d => d.name === 'local');
  assert.deepEqual([lite.engine, lite.file], ['sqlite', 'C:/data/app.db']);
  assert.ok(p.dbs.find(d => d.name === 'nope').unsupported);
});

test('scripts are linked to their connection via project-metadata default-datasource', () => {
  const dataSources = { connections: {
    'pg-1': { provider: 'postgresql', name: 'pg', configuration: { host: 'h1', database: 'app' } },
    'my-2': { provider: 'mysql', name: 'my', configuration: { host: 'h2' } },
  } };
  const scripts = [
    { rel: 'Scripts/Script-1.sql', path: 'C:/w/Scripts/Script-1.sql' },
    { rel: 'Scripts\\Script-2.sql', path: 'C:/w/Scripts/Script-2.sql' },
    { rel: 'Scripts/orphan.sql', path: 'C:/w/Scripts/orphan.sql' },
  ];
  const resources = {
    'Scripts/Script-1.sql': { 'default-datasource': 'pg-1', 'default-catalog': 'reports' },
    'Scripts/Script-2.sql': { 'default-datasource': 'my-2' },
  };
  const p = dbe.buildPreview({ dataSources, credsBuffer: null, scripts, resources });
  const pg = p.dbs.find(d => d.name === 'pg');
  assert.equal(pg.dbeaverId, 'pg-1');
  assert.deepEqual(pg.scripts.map(s => [s.name, s.database]), [['Script-1.sql', 'reports']]);
  assert.deepEqual(p.dbs.find(d => d.name === 'my').scripts.map(s => s.name), ['Script-2.sql']);
  assert.deepEqual(p.unlinkedScripts.map(s => s.name), ['orphan.sql']);
  assert.deepEqual([p.stats.linkedScripts, p.stats.unlinkedScripts], [2, 1]);
});

test('buildPreview survives missing credentials file', () => {
  const p = dbe.buildPreview({ dataSources: { connections: { a: { provider: 'postgresql', name: 'x', configuration: { host: 'h' } } } }, credsBuffer: null });
  assert.equal(p.dbs[0].host, 'h');
  assert.equal(p.stats.withPassword, 0);
});
