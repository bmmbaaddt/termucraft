// Import DBeaver (Community) connections, credentials and SQL scripts into TermuCraft.
// credentials-config.json is AES-128-CBC with DBeaver's built-in local key; IV = first 16 bytes of the file.
// This only decrypts the user's own local DBeaver storage, which is the whole point of the feature.
const crypto = require('crypto');
const { randomUUID } = require('crypto');

const LOCAL_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex'); // DBeaver CE local secret key

function decryptCredentials(buf) {
  if (!buf || buf.length <= 16) return {};
  const d = crypto.createDecipheriv('aes-128-cbc', LOCAL_KEY, buf.subarray(0, 16)).setAutoPadding(false);
  const plain = Buffer.concat([d.update(buf.subarray(16)), d.final()]).toString('utf8');
  const end = plain.lastIndexOf('}');
  return JSON.parse(plain.slice(0, end + 1)); // NoPadding leaves trailing bytes after the JSON
}

const PROVIDER = { postgresql: 'postgres', mysql: 'mysql', mariadb: 'mysql', oracle: 'oracle', sqlite: 'sqlite', generic: null, sqlserver: 'mssql', mssql: 'mssql' };
const DEFAULT_PORT = { postgres: 5432, mysql: 3306, oracle: 1521, mssql: 1433 };

// Fall back to the JDBC URL when host/port/database are not stored as separate fields.
function fromUrl(engine, url = '') {
  const o = {};
  let m;
  if ((m = /\/\/([^:/;]+)(?::(\d+))?/.exec(url))) { o.host = m[1]; if (m[2]) o.port = +m[2]; }
  if (engine === 'oracle') {
    if ((m = /@\/\/?([^:/]+):(\d+)[/:](\w[\w.]*)/.exec(url))) Object.assign(o, { host: m[1], port: +m[2], database: m[3] });
    else if ((m = /@([^:/]+):(\d+):(\w+)/.exec(url))) Object.assign(o, { host: m[1], port: +m[2], database: m[3] });
  } else if (engine === 'mssql') {
    if ((m = /databaseName=([^;]+)/i.exec(url))) o.database = m[1];
  } else if ((m = /\/\/[^/]+\/([^?;]+)/.exec(url))) o.database = m[1];
  return o;
}

// opts: { dataSources (parsed json), credsBuffer (Buffer|null), folderPrefix,
//         scripts: [{ rel, path }] (rel = project-relative "Scripts/x.sql"), resources: project-metadata.json "resources" }
// Returns { dbs:[...], sshSessions:[...], unlinkedScripts:[...], stats }
// Each db gets dbeaverId (stable across re-imports) and scripts:[{ name, rel, path, database }] linked via default-datasource.
function buildPreview({ dataSources, credsBuffer, folderPrefix = 'DBeaver', scripts = [], resources = {} }) {
  let creds = {};
  let credError = null;
  try { creds = credsBuffer ? decryptCredentials(credsBuffer) : {}; } catch (e) { credError = e.message; }

  const folders = (dataSources && dataSources.folders) || {};
  const folderName = id => id ? `${folderPrefix}/${id}` : folderPrefix;
  const dbs = [], sshSessions = [];

  for (const [id, c] of Object.entries((dataSources && dataSources.connections) || {})) {
    const engine = PROVIDER[c.provider];
    const cfg = c.configuration || {};
    const base = { engine, provider: c.provider, driver: c.driver, name: c.name, id };
    if (!engine) { dbs.push({ ...base, unsupported: true }); continue; }

    // real format nests connection creds under "#connection"; older/simple blobs store them flat
    const centry = creds[id] || {};
    const cred = centry['#connection'] || centry;
    const d = {
      id: randomUUID(), engine, name: c.name || `${engine} ${cfg.host || ''}`,
      folder: c.folder ? folderName(c.folder) : folderPrefix,
      host: cfg.host, port: +cfg.port || undefined, database: cfg.database,
      user: cred.user || cfg.user || '', password: cred.password || '',
      env: /prod/i.test(c.name || '') || /prod/i.test((c.type || '')) ? 'prod' : 'dev',
      readOnly: !!(cfg['connection-read-only'] || c['read-only']),
    };
    Object.assign(d, fromUrl(engine, cfg.url), { host: cfg.host || fromUrl(engine, cfg.url).host });
    if (!d.port) d.port = DEFAULT_PORT[engine];
    if (engine === 'sqlite') { d.file = cfg.url ? cfg.url.replace(/^jdbc:sqlite:/, '') : (cfg.host || ''); delete d.host; delete d.port; }

    // SSH tunnel -> a TermuCraft SSH session the DB connects through
    const ssh = (cfg.handlers || {})['ssh_tunnel'] || (cfg.handlers || {})['ssh'];
    if (ssh && ssh.enabled !== false && ssh.properties) {
      const sc = centry['ssh_tunnel'] || centry['ssh'] || creds[id + '#ssh_tunnel'] || creds[id + '#ssh'] || {};
      const sid = randomUUID();
      sshSessions.push({
        id: sid, type: 'ssh', folder: folderPrefix, name: `${c.name} (SSH)`,
        host: ssh.properties.host || ssh.properties.hostName, port: +ssh.properties.port || 22,
        username: ssh.user || sc.user || ssh.properties.userName || '',
        password: ssh.password || sc.password || '', keyFile: ssh.properties.keyPath || ssh.properties.privateKeyPath || '',
        monitor: true,
      });
      d.sshId = sid;
    }
    d.ok = !!(d.host || d.file);
    d.hasPassword = !!d.password;
    d.dbeaverId = id;
    dbs.push(d);
  }

  // link scripts to their connection the way DBeaver does (project-metadata.json "default-datasource")
  const norm = p => p.replace(/\\/g, '/').toLowerCase();
  const meta = new Map(Object.entries(resources || {}).map(([k, v]) => [norm(k), v || {}]));
  const byId = new Map(dbs.filter(d => !d.unsupported).map(d => [d.dbeaverId, d]));
  const unlinkedScripts = [];
  for (const sc of scripts) {
    const m = meta.get(norm(sc.rel)) || {};
    const d = byId.get(m['default-datasource']);
    const entry = { name: sc.rel.split(/[\\/]/).pop(), rel: sc.rel, path: sc.path, database: m['default-catalog'] || '' };
    if (d) (d.scripts = d.scripts || []).push(entry); else unlinkedScripts.push(entry);
  }
  return {
    dbs, sshSessions, credError, unlinkedScripts,
    stats: { total: dbs.length, importable: dbs.filter(d => !d.unsupported).length, unsupported: dbs.filter(d => d.unsupported).length,
      withPassword: dbs.filter(d => d.hasPassword).length, sshTunnels: sshSessions.length,
      linkedScripts: scripts.length - unlinkedScripts.length, unlinkedScripts: unlinkedScripts.length },
  };
}

module.exports = { buildPreview, decryptCredentials, fromUrl, LOCAL_KEY };
