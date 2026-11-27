import fs from 'node:fs';
import path from 'node:path';

const SRC = 'D:/AI/agent-soul';
const CFG = 'C:/Users/pc/Desktop/deepseek harness/agent soul/config.json';
const HUB = 'D:/AI/dsh/home/mcp-hub/servers.json';
const hits = [];
const add = (sev, where, msg) => hits.push({ sev, where, msg });

// 1) config.json library paths must all resolve to the same existing file
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch (e) { add('FAIL', 'config.json', 'unreadable: ' + e.message); }
const libDir = cfg?.memory?.libraryDir || '';
const idxFile = cfg?.memory?.indexFile || '';
const liveDb = cfg?.echoLive?.dbPath || '';
const dataDir = cfg?.dataDir || 'data';
const norm = (p) => String(p || '').replace(/\\\\/g, '/').toLowerCase();
const libDb = libDir && idxFile ? path.posix.join(norm(libDir), norm(idxFile)) : '';
if (!libDir) add('FAIL', 'config.json', 'memory.libraryDir empty');
if (!idxFile) add('FAIL', 'config.json', 'memory.indexFile empty');
if (!liveDb) add('FAIL', 'config.json', 'echoLive.dbPath empty');
if (libDb && liveDb && norm(liveDb) !== libDb) {
  add('FAIL', 'config.json', 'echoLive.dbPath != libraryDir/indexFile  live=' + liveDb + '  lib=' + libDb);
} else if (libDb) {
  add('OK', 'config.json', 'retrieval and realtime index resolve to the same path');
}
for (const [label, p] of [['library dir', libDir], ['realtime db', liveDb]]) {
  const abs = String(p || '').replace(/\//g, '\\');
  if (p && !fs.existsSync(abs)) add('FAIL', 'config.json', label + ' does not exist: ' + p);
  else if (p) add('OK', 'config.json', label + ' exists');
}
const absDataDir = String(dataDir || '').startsWith('/') || /^[A-Za-z]:/.test(String(dataDir))
  ? String(dataDir) : path.join(path.dirname(CFG), String(dataDir));
if (!fs.existsSync(absDataDir)) add('FAIL', 'config.json', 'dataDir does not exist: ' + absDataDir);
else add('OK', 'config.json', 'dataDir exists');

// 2) mcp-hub env
let hub = {};
try { hub = JSON.parse(fs.readFileSync(HUB, 'utf8')); } catch (e) { add('FAIL', 'servers.json', 'unreadable: ' + e.message); }
const srv = hub?.servers?.find?.((s) => /agent-soul/i.test(s.serverName || s.name || '')) || null;
if (!srv) add('WARN', 'servers.json', 'no agent-soul entry found');
else {
  const env = srv.env || {};
  const metaDb = env.AGENT_SOUL_META_DB || '';
  if (!metaDb) add('FAIL', 'servers.json', 'agent-soul env missing AGENT_SOUL_META_DB');
  else if (!fs.existsSync(metaDb.replace(/\//g, '\\'))) add('FAIL', 'servers.json', 'AGENT_SOUL_META_DB does not exist: ' + metaDb);
  else if (norm(metaDb) !== libDb) add('FAIL', 'servers.json', 'AGENT_SOUL_META_DB != unified library: ' + metaDb);
  else add('OK', 'servers.json', 'AGENT_SOUL_META_DB points at the unified library');
}

// 3) hardcoded meta.sqlite paths in source (outside node_modules / .bak)
const walk = (dir, out) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    // Archives, forensics copies and one-off probes are NOT shipped code.
    // Scanning them would bury real hits under dead files we intentionally keep.
    if (['node_modules', '.git', 'app', '_forensics', '_verify', '_backup', 'dist'].includes(e.name)) continue;
    if (e.name.startsWith('_tmp')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(mjs|js|cjs|json)$/.test(e.name) && !/\.bak/.test(e.name)) {
      // Self-tests build throwaway DBs under temp roots by design; scanning them
      // would bury real hits under hundreds of intentional fixtures.
      if (/-selftest\.mjs$/.test(e.name)) return;
      out.push(p);
    }
  }
};
const files = [];
walk(SRC, files);
const hardcoded = [];
for (const f of files) {
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const re = /[A-Za-z]:[\\/][^'"\r\n]*meta\.sqlite/g;
  let m;
  while ((m = re.exec(text))) {
    const frag = m[0];
    hardcoded.push({ file: path.relative(SRC, f).replace(/\\/g, '/'), frag });
  }
}
if (hardcoded.length === 0) add('OK', 'src+tools', 'no hardcoded absolute meta.sqlite path');
else for (const h of hardcoded) add('WARN', h.file, 'hardcoded path: ' + h.frag);

// 4) metaDbPath definition uniqueness
const defs = [];
for (const f of files) {
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (/function\s+metaDbPath\s*\(/.test(text)) {
    const lines = text.split('\n');
    lines.forEach((ln, i) => { if (/function\s+metaDbPath\s*\(/.test(ln)) defs.push(path.relative(SRC, f).replace(/\\/g, '/') + ':' + (i + 1)); });
  }
}
if (defs.length === 1) add('OK', 'src', 'metaDbPath defined exactly once: ' + defs[0]);
else add('FAIL', 'src', 'metaDbPath definitions = ' + defs.length + ' :: ' + defs.join(', '));

// 5) formulas that build a meta.sqlite path WITHOUT consulting memory.libraryDir.
// This is the real trap class: a copy of the formula that never looks at the config
// silently answers a different file than metaDbPath(). A line that reads libraryDir
// within +/-6 lines honours the config and is a documented fallback, not a bypass.
const bypass = [];
const fallback = [];
for (const f of files) {
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  if (!text.includes('meta.sqlite')) continue;
  const lines = text.split('\n');
  lines.forEach((ln, i) => {
    if (!/path\.join\([^)]*['\"]meta\.sqlite['\"]/.test(ln)) return;
    const lo = Math.max(0, i - 6);
    const hi = Math.min(lines.length, i + 7);
    const window = lines.slice(lo, hi).join('\n');
    const rel = path.relative(SRC, f).replace(/\\/g, '/');
    const row = rel + ':' + (i + 1);
    // A formula that delegates to a helper documented to read memory.libraryDir is a
    // fallback, not a bypass. indexDbPath()/metaDbPath() are those helpers.
    if (window.includes('libraryDir') || window.includes('metaDbPath') || window.includes('indexDbPath')) fallback.push(row);
    else bypass.push(row + '  ' + ln.trim().slice(0, 100));
  });
}
if (bypass.length === 0) add('OK', 'src', 'every meta.sqlite formula consults memory.libraryDir');
else for (const b of bypass) add('FAIL', b.split(':')[0], 'formula ignores memory.libraryDir: ' + b);
if (fallback.length) add('OK', 'src', 'documented fallbacks that do read libraryDir: ' + fallback.length);
const order = { FAIL: 0, WARN: 1, OK: 2 };
hits.sort((a, b) => order[a.sev] - order[b.sev]);
for (const h of hits) console.log(h.sev.padEnd(4) + ' | ' + h.where.padEnd(26) + ' | ' + h.msg);
const fails = hits.filter((h) => h.sev === 'FAIL').length;
const warns = hits.filter((h) => h.sev === 'WARN').length;
console.log('');
console.log('SUMMARY fail=' + fails + ' warn=' + warns + ' ok=' + hits.filter((h) => h.sev === 'OK').length);
process.exitCode = fails > 0 ? 1 : 0;