// Terminal syntax highlighting: colors keywords / IPs / MACs in plain output text.
// Leaves escape sequences intact and never recolors text the remote program already colored.
// Loaded both by Node (tests) and by the renderer via <script>.
(function (root) {
  const DEFAULT_RULES = [
    { pattern: '\\b(?:error|errors|failed|failure|fatal|denied|refused|critical|exception|panic|unreachable)\\b', color: '1;31' },
    { pattern: '\\b(?:warn|warning|warnings|deprecated|timeout|timed out)\\b', color: '1;33' },
    { pattern: '\\b(?:ok|success|successful|succeeded|done|passed|active|running|enabled|up)\\b', color: '1;32' },
    { pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:/\\d{1,2})?\\b', color: '36' },
    { pattern: '\\b[0-9a-f]{2}(?::[0-9a-f]{2}){5}\\b', color: '35' },
  ];
  const ESC = /(\x1b\[[0-9;?<>=]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_])/;

  function compile(rules) {
    const ok = (rules || DEFAULT_RULES).filter(r => { try { new RegExp(r.pattern); return true; } catch { return false; } });
    // user patterns may contain their own groups: record where each rule's outer group sits
    const offsets = []; let n = 0;
    for (const r of ok) { offsets.push(n); n += new RegExp(r.pattern + '|').exec('').length; }
    return { re: new RegExp(ok.map(r => `(${r.pattern})`).join('|'), 'gi'), colors: ok.map(r => r.color), offsets };
  }

  // state = { colored: bool } persists across chunks of one terminal.
  // ponytail: a keyword split across two chunks is not highlighted; buffer partial words if that annoys.
  function highlight(text, compiled, state) {
    if (!compiled.colors.length) return text;
    return text.split(ESC).map((part, i) => {
      if (i % 2) {
        const sgr = /^\x1b\[([0-9;]*)m$/.exec(part);
        if (sgr) state.colored = !(sgr[1] === '' || /^0*$/.test(sgr[1]) || /^(0*;)*(39|0)$/.test(sgr[1]));
        return part;
      }
      if (state.colored || !part) return part;
      return part.replace(compiled.re, (m, ...g) => {
        const idx = compiled.offsets.findIndex(o => g[o] !== undefined);
        return `\x1b[${compiled.colors[idx]}m${m}\x1b[0m`;
      });
    }).join('');
  }

  const api = { DEFAULT_RULES, compile, highlight };
  if (typeof module !== 'undefined') module.exports = api; else root.Highlight = api;
})(this);
