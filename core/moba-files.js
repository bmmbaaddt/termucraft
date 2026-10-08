// Parse files exported by MobaXterm's own menus (no decryption involved):
//  - password export (.txt): "credential name(username) = password"  or  "ssh22:user@host = password"
//  - macro export (.mxtmacros / any text with a [Macros] section): name=step|step|...|
//      12:<mode>:0:<text>          type text
//      258:<vk>:<scan>:<KEYNAME>   press a key (RETURN, TAB, ...)
//      0:0:0:SLEEPEQUAL<ms>        pause
//    Text escapes: PIIPE -> "|", __EQQUAL__ -> "=", __DBLDOT__ -> ":"
// Output macros use TermuCraft's macro text format: newline = Enter, {TAB} {ESC} {BS} {^X} {WAIT:ms}.

function parsePasswordExport(text) {
  const credentials = [], passwords = [], skipped = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, ''); // no trimming: a password may end with spaces
    if (!line.trim()) continue;
    let m = /^(.+?)\(([^()]*)\)\s=\s?(.*)$/.exec(line); // name(user) = password (password may contain " = ")
    if (m) { credentials.push({ name: m[1].trim(), username: m[2].trim(), password: m[3] }); continue; }
    m = /^(?:([a-z]+)(\d+)?:)?([^@\s=]*)@([^\s=]+)\s=\s?(.*)$/i.exec(line); // [ssh22:]user@host = password
    if (m) { passwords.push({ proto: m[1], port: m[2], user: m[3], host: m[4], password: m[5] }); continue; }
    skipped.push(line.slice(0, 40));
  }
  return { credentials, passwords, skipped };
}

const unescapeMoba = s => s.replace(/PIIPE/g, '|').replace(/__EQQUAL__/g, '=').replace(/__DBLDOT__/g, ':');

const KEYS = {
  RETURN: '\n', ENTER: '\n', TAB: '{TAB}', ESCAPE: '{ESC}', ESC: '{ESC}', BACK: '{BS}', BACKSPACE: '{BS}', SPACE: ' ',
  UP: '{ESC}[A', DOWN: '{ESC}[B', RIGHT: '{ESC}[C', LEFT: '{ESC}[D', HOME: '{ESC}[H', END: '{ESC}[F', DELETE: '{ESC}[3~', DEL: '{ESC}[3~',
  PRIOR: '{ESC}[5~', PAGEUP: '{ESC}[5~', NEXT: '{ESC}[6~', PAGEDOWN: '{ESC}[6~', INSERT: '{ESC}[2~',
};
const VK = { 13: '\n', 9: '{TAB}', 27: '{ESC}', 8: '{BS}', 32: ' ', 38: '{ESC}[A', 40: '{ESC}[B', 39: '{ESC}[C', 37: '{ESC}[D', 36: '{ESC}[H', 35: '{ESC}[F', 46: '{ESC}[3~' };

// one macro value -> { text, unknown: [step...] }
function convertMacro(value) {
  let text = ''; const unknown = [];
  for (const step of value.split('|')) {
    if (!step) continue;
    const m = /^(\d+):(\d+):(\d+):(.*)$/s.exec(step);
    if (!m) { unknown.push(step); continue; }
    const [, kind, a, , rest] = m;
    if (kind === '12') { text += unescapeMoba(rest); continue; }
    if (kind === '0') { const w = /^SLEEP(?:EQUAL|=)(\d+)$/i.exec(rest); if (w) { text += `{WAIT:${w[1]}}`; continue; } }
    if (kind === '258') {
      const name = rest.toUpperCase();
      const ctrl = /^CTRL\+?([A-Z@[\\\]^_])$/.exec(name);
      const k = KEYS[name] ?? (ctrl ? `{^${ctrl[1]}}` : VK[+a]);
      if (k !== undefined) { text += k; continue; }
    }
    unknown.push(step);
  }
  return { text, unknown };
}

// Returns [{ name, text, unknown }] from the [Macros] section (or the whole file if it has no sections).
function parseMacroExport(content) {
  const out = []; let inMacros = null;
  for (const raw of String(content).split(/\r?\n/)) {
    const line = raw.replace(/^﻿/, '');
    const sec = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sec) { inMacros = /^macros$/i.test(sec[1].trim()); continue; }
    if (inMacros === false || !line.trim()) continue;
    // the macro name never contains "=" (MobaXterm strips it); the value starts at the first "=" before a step
    const m = /^(.*?)=(\d+:\d+:\d+:.*)$/s.exec(line);
    if (!m) continue;
    out.push({ name: m[1].trim(), ...convertMacro(m[2]) });
  }
  return out;
}

module.exports = { parsePasswordExport, parseMacroExport, convertMacro, unescapeMoba };
