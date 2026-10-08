// Import sessions from a MobaXterm.ini / .mxtsessions file ([Bookmarks*] sections).
// Line format: name=#<icon>#<type>%field0%field1%...#<terminal settings>#...
// Passwords are not imported: MobaXterm keeps them encrypted under its own master key.
const { randomUUID } = require('crypto');

const TYPES = { 0: 'ssh', 1: 'telnet', 4: 'rdp', 5: 'vnc', 7: 'sftp', 8: 'serial', 10: 'shell', 11: 'browser', 14: 'wsl' };
const BAUDS = [921600, 460800, 230400, 115200, 57600, 38400, 19200, 9600, 4800, 2400, 1200];

function expand(p) {
  return (p || '').replace('_AppDataDir_', process.env.APPDATA || '').replace('_ProfileDir_', process.env.USERPROFILE || '');
}

function parseLine(name, value, folder) {
  const m = /^#\d+#(\d+)%(.*)$/.exec(value);
  if (!m || !TYPES[m[1]]) return null;
  const f = m[2].split('#')[0].split('%');
  const s = { id: randomUUID(), name, folder, type: TYPES[m[1]] };
  switch (s.type) {
    case 'ssh': case 'sftp':
      Object.assign(s, { host: f[0], port: +f[1] || 22, username: f[2] || '', x11: f[4] === '-1', keyFile: expand(f[13]) });
      if (f[6]) Object.assign(s, { jumpHost: f[6], jumpPort: +f[7] || 22, jumpUser: f[8] || '' });
      break;
    case 'telnet': Object.assign(s, { host: f[0], port: +f[1] || 23 }); break;
    case 'rdp': Object.assign(s, { host: f[0], port: +f[1] || 3389, username: f[2] || '' }); break;
    case 'vnc': Object.assign(s, { host: f[0], port: +f[1] || 5900 }); break;
    case 'browser': Object.assign(s, { url: /^\w+:\/\//.test(f[0]) ? f[0] : 'http://' + f[0] }); break;
    case 'serial': {
      const port = (/COM\d+/.exec(m[2]) || ['COM1'])[0];
      Object.assign(s, { port, baud: BAUDS.find(b => String(f[1]).endsWith(String(b))) || 9600 });
      break;
    }
    case 'shell': Object.assign(s, { command: f[0] || 'cmd.exe' }); break;
    case 'wsl': Object.assign(s, { type: 'shell', command: `wsl.exe${f[0] ? ' -d ' + f[0] : ''}` }); break;
  }
  return s;
}

function parseMobaIni(text) {
  const sessions = [];
  let inBookmarks = false, folder = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) { inBookmarks = /^\[Bookmarks(_\d+)?\]$/.test(line); folder = ''; continue; }
    if (!inBookmarks || !line.includes('=')) continue;
    const i = line.indexOf('=');
    const key = line.slice(0, i), value = line.slice(i + 1);
    if (key === 'SubRep') { folder = value.replace(/\\/g, '/'); continue; }
    if (key === 'ImgNum') continue;
    const s = parseLine(key.trim(), value, folder);
    if (s) sessions.push(s);
  }
  return sessions;
}

module.exports = { parseMobaIni };
