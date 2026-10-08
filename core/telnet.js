// Telnet client: strips IAC negotiation, agrees to ECHO/SGA, sends terminal type and window size.
const net = require('net');
const IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240;
const ECHO = 1, SGA = 3, TTYPE = 24, NAWS = 31;

// Pure filter: returns the data bytes, calls reply(Buffer) for negotiation answers.
function createFilter(reply, getSize) {
  let st = 0, cmd = 0, sb = [];
  return buf => {
    const out = [];
    for (const b of buf) {
      if (st === 0) { if (b === IAC) st = 1; else out.push(b); }
      else if (st === 1) {
        if (b === IAC) { out.push(IAC); st = 0; }
        else if (b >= WILL && b <= DONT) { cmd = b; st = 2; }
        else if (b === SB) { sb = []; st = 3; }
        else st = 0;
      } else if (st === 2) {
        if (cmd === DO && b === NAWS) { reply(Buffer.from([IAC, WILL, NAWS])); reply(naws(getSize())); }
        else if (cmd === DO && b === TTYPE) reply(Buffer.from([IAC, WILL, TTYPE]));
        else if (cmd === DO) reply(Buffer.from([IAC, WONT, b]));
        else if (cmd === WILL) reply(Buffer.from([IAC, (b === ECHO || b === SGA) ? DO : DONT, b]));
        st = 0;
      } else if (st === 3) { if (b === IAC) st = 4; else sb.push(b); }
      else if (st === 4) {
        if (b === SE) {
          if (sb[0] === TTYPE && sb[1] === 1) reply(Buffer.concat([Buffer.from([IAC, SB, TTYPE, 0]), Buffer.from('xterm-256color'), Buffer.from([IAC, SE])]));
          st = 0;
        } else { sb.push(b); st = 3; }
      }
    }
    return Buffer.from(out);
  };
}

function naws({ cols, rows }) { return Buffer.from([IAC, SB, NAWS, cols >> 8, cols & 255, rows >> 8, rows & 255, IAC, SE]); }

function telnet(host, port, size, onData, onClose) {
  const sock = net.connect(+port || 23, host);
  const filter = createFilter(b => sock.write(b), () => size);
  sock.on('data', d => { const out = filter(d); if (out.length) onData(out.toString('utf8')); });
  sock.on('error', e => onData(`\r\n[telnet error: ${e.message}]\r\n`));
  sock.on('close', onClose);
  return {
    write: d => sock.write(Buffer.from(d, 'utf8').toString('binary').replace(/\xff/g, '\xff\xff'), 'binary'),
    resize: (cols, rows) => { size = { cols, rows }; sock.write(naws(size)); },
    close: () => sock.destroy(),
  };
}

module.exports = { telnet, createFilter };
