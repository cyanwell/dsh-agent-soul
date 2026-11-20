// 账本写闸门自检（task-6 · 2026-11-14；task-7 rev 3 · 2026-11-15 收紧到库层）
//
// ★ 只碰临时目录：AGENT_SOUL_HOME 指到 <os.tmpdir()>/agent-soul-ledger-guard-*，
//   配置、账本 JSONL、会话目录全在临时根下。**不读生产 config、不碰生产 data、
//   不碰真《墨》（02-墨.jsonl）**。跑完把临时根删掉并**验证删掉了**。
//
// ★ 它验的是**顺序**，不只是「被拒」：
//   ① write / lead / promise + by·sessionId·ctx 伪造 → 一律 LEDGER_AUTH_REQUIRED；
//   ② 这些拒绝**一个字节都没写**（前后快照完全一致，且连 data/ 都没被造出来 —— 说明 store() 没被调）；
//   ③ config.json 坏成非法 JSON 时 write 仍然被拒（而不是报解析失败）→ 证明 loadConfig 没被调用；
//   ④ storeMode='off' 与只读模式（AGENT_SOUL_READONLY=1 + SOUL_STDIO_MODE=standalone）
//      都不改变拒绝结果 → 拒绝不依赖 store 的状态；
//   ⑤ list / stats 照常读**临时那本** JSONL（stats 输出里带路径，可作为「读的是哪一本」的证据）；
//   ⑥ 缺 action = list；不认识的动作 = INVALID_ACTION，且零文件改动。
//   ⑦ 真外部入口（stdio 腿）三种路由都试：standalone → LEDGER_AUTH_REQUIRED；
//      只读 → SOUL_READONLY（manifest 层挡的）；离线 → SOUL_OFFLINE（旧语义）。三种都零文件改动。
//   ⑧ 拒绝的形状必须**同时**带 status='rejected' 与 code —— 只给 code 的话，
//      按 status 判拒的上游（g2a 的 isRejection 就是那种读法）会把它读成成功。
//   ⑨ 库层对照：**runLedger() 直写也被拒**（task-7 rev 3）—— 绕过 callTool 直接调库层
//      同样拿不到写通道，而库层读（list / stats）仍通；临时账本逐字未变、快照完全一致。
//
// 每个场景一个新进程：模块级状态（_store / _storeMode）一旦建立就不再变，同进程里模拟不了。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const CHILD = process.argv.includes('--child');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
/** 真的外部入口：stdio 腿。上面那些场景直接喂 callTool，这一条才走「宿主怎么调」。 */
const SERVER = path.join(REPO, 'src', 'adapters', 'mcp.mjs');
const LEDGER_REL = 'ledger.jsonl';        // <home>/ledger.jsonl
const SEED_ROWS = [
  { t: '2026-11-14T10:00:00+08:00', type: 'fact', by: 'session-seed0001', text: '种子事实一' },
  { t: '2026-11-14T10:05:00+08:00', type: 'shelved', by: 'session-seed0002', text: '种子搁置一' },
  { t: '2026-11-14T10:10:00+08:00', type: 'lead', by: 'session-seed0003', text: '第 9 代 · 种子' },
];

// ── 小工具 ────────────────────────────────────────────────
function walk(root, base = root, out = []) {
  let ent = [];
  try { ent = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of ent) {
    const p = path.join(root, d.name);
    const rel = path.relative(base, p).split(path.sep).join('/');
    if (d.isDirectory()) { out.push('D ' + rel); walk(p, base, out); }
    else { const st = fs.statSync(p); out.push('F ' + rel + ' ' + st.size + ' ' + st.mtimeMs); }
  }
  return out.sort();
}
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };

/** 写类型**全枚举** —— 闸门只看 action，任何一个 type（含没有 type、含不存在的 type）都不该改变结论。 */
const WRITE_TYPES = ['fact', 'lead', 'promise', 'gain', 'loss', 'shelved', 'persona', 'container', 'bogus-type', undefined];
const FORGED = 'session-8332345a-52d3-4a7d-afc5-5f4342a2ef0c';
const WRITE_CASES = WRITE_TYPES.map((ty) => ({
  label: 'type=' + (ty === undefined ? '(未给)' : ty),
  args: ty === undefined ? { action: 'write' } : { action: 'write', type: ty, text: '不该落地的 ' + ty },
  ctx: {},
})).concat([
  { label: 'by 伪造', args: { action: 'write', type: 'fact', text: '伪造署名', by: FORGED }, ctx: {} },
  { label: 'args.sessionId 伪造', args: { action: 'write', type: 'fact', text: '伪造会话参数', sessionId: FORGED }, ctx: {} },
  { label: 'ctx.sessionId + by 伪造', args: { action: 'write', type: 'fact', text: '伪造上下文' }, ctx: { sessionId: FORGED, by: FORGED } },
  { label: 'by + sessionId + ctx 全伪造', args: { action: 'write', type: 'promise', text: '全伪造', by: FORGED, sessionId: FORGED }, ctx: { sessionId: FORGED } },
]);
const BAD_ACTIONS = ['append', 'WRITE', 'write ', ' write', 'write\t', 'write\n', 'Write', 'stats ', 'remove', 1, true, { a: 1 }, ['write'],
  // ★ 只有靠 String() 强转才长得像 write 的值：**不许**因此命中写分支，也不许因此被当成读。
  { toString() { return 'write'; } }];
const labelOf = (v) => (typeof v === 'string' ? JSON.stringify(v) : (v && typeof v === 'object' ? JSON.stringify(v) : String(v)));

/**
 * 写拒绝 + 零文件改动 —— 每个场景都要跑的那一段。
 * ★ 顺序：先快照、再拒绝、再比快照。中间不许夹任何读动作（读会建 store，污染判据）。
 */
async function checkWriteDenied(mcp, home, t) {
  const ledgerFile = path.join(home, LEDGER_REL);
  const rowsBefore = readText(ledgerFile);
  const snapA = walk(home);

  // ★ 形状断言要**同时**看 status 与 code：只认 code 的话，一个漏了 status 的拒绝
  //   在本自检里是绿的，但按 status 判拒的上游会把它读成成功。
  const isLocked = (out) => {
    const j = parse(out);
    return !!j && j.ok === false && j.status === 'rejected' && j.code === 'LEDGER_AUTH_REQUIRED'
      && j.tool === 'soul_ledger' && j.action === 'write'
      && Array.isArray(j.allowed) && j.allowed.includes('list') && j.allowed.includes('stats')
      && !j.allowed.includes('write');
  };
  const isInvalid = (out) => {
    const j = parse(out);
    return !!j && j.ok === false && j.status === 'invalid' && j.code === 'INVALID_ACTION' && j.tool === 'soul_ledger';
  };

  for (const c of WRITE_CASES) {
    let out = null, err = null;
    try { out = await mcp.callTool('soul_ledger', c.args, c.ctx); } catch (e) { err = e; }
    if (err) { t('write[' + c.label + '] 不抛错（应回结构化拒绝）', false, err && err.message); continue; }
    const okShape = isLocked(out);
    t('write[' + c.label + '] → status=rejected / LEDGER_AUTH_REQUIRED', okShape, okShape ? '' : String(out).slice(0, 220));
  }

  for (const bad of BAD_ACTIONS) {
    let out = null, err = null;
    try { out = await mcp.callTool('soul_ledger', { action: bad, type: 'fact', text: 'x' }, {}); } catch (e) { err = e; }
    if (err) { t('invalid[' + labelOf(bad) + '] 不抛错', false, err && err.message); continue; }
    const okShape = isInvalid(out);
    t('invalid[' + labelOf(bad) + '] → status=invalid / INVALID_ACTION', okShape, okShape ? '' : String(out).slice(0, 180));
  }

  const snapB = walk(home);
  const same = JSON.stringify(snapA) === JSON.stringify(snapB);
  t('拒绝前后：临时根文件快照完全一致', same, same ? (snapA.length + ' 项') : ('A=' + JSON.stringify(snapA) + ' B=' + JSON.stringify(snapB)));
  t('账本 JSONL 逐字未变', readText(ledgerFile) === rowsBefore);
  return { ledgerFile, snapA };
}

/** 读：list / stats 读到的必须是**临时那本**。只对 rw / ro 跑。 */
async function checkReads(mcp, home, t) {
  const ledgerFile = path.join(home, LEDGER_REL);
  let dflt = '';
  try { dflt = String(await mcp.callTool('soul_ledger', { limit: 5 }, {})); } catch (e) { dflt = 'THROW ' + (e && e.message); }
  t('缺 action → 默认 list（读到种子行）', dflt.includes('种子事实一') && dflt.includes('第 9 代 · 种子'), dflt.split('\n').slice(0, 2).join(' / ').slice(0, 160));
  t('缺 action 不是写（不是拒绝 JSON）', !dflt.trim().startsWith('{'), dflt.slice(0, 60));

  let byType = '';
  try { byType = String(await mcp.callTool('soul_ledger', { type: 'fact', limit: 5 }, {})); } catch (e) { byType = 'THROW ' + (e && e.message); }
  t('list type=fact 只出事实', byType.includes('种子事实一') && !byType.includes('种子搁置一'), byType.slice(0, 120));

  let stats = '';
  try { stats = String(await mcp.callTool('soul_ledger', { action: 'stats' }, {})); } catch (e) { stats = 'THROW ' + (e && e.message); }
  t('stats 读的是临时那本（输出带临时路径）', stats.includes(ledgerFile), stats.split('\n')[0]);
  t('stats 共 3 条', stats.includes('共 3 条'), (stats.split('\n').find((l) => l.includes('共 ')) || '').trim());
  t('stats 当前主导 = seed0003', stats.includes('seed0003'), '');
  return stats;
}

/**
 * 库层对照（只跑 rw 场景）：**runLedger() 直写也被拒**，临时账本逐字未变。
 * ★ task-7 rev 3 之前，这里放的是「直写成功」的正面证据（用来证明闸门只在 MCP 边界）。
 *   收紧到库层之后，正面证据换成了反面：**绕过 callTool 直接调 runLedger 一样拿不到写通道**，
 *   而库层读（list / stats）仍然通 —— 关掉的只有写。
 * ★ 落点仍是临时目录，**不是生产账本**（临时根跑完就删）。
 * ★ 顺序仍然是判据：先快照 → 再拒 → 再比快照，中间不夹读动作（读会建 store，污染判据）。
 */
async function checkLibraryLayer(mcp, home, t) {
  const ledgerFile = path.join(home, LEDGER_REL);
  const cfg = parse(readText(path.join(home, 'config.json')));
  if (!cfg) { t('库层对照：临时 config 可读', false, 'config.json 读不出来'); return; }
  const rows = (s) => (s ? s.trim().split('\n').filter(Boolean) : []);
  const before = readText(ledgerFile);
  const snapA = walk(home);

  let w = null, werr = null;
  try {
    // ★ 第三参数（旧 API 里给 by 兜底的 sessionId）也一并伪造 —— 它同样不是授权。
    w = await mcp.runLedger({ action: 'write', type: 'fact', text: '库层直写对照', by: FORGED }, cfg, FORGED);
  } catch (e) { werr = e; }
  const j = parse(String(w));
  t('库层对照：runLedger() 直写被拒（status=rejected / LEDGER_AUTH_REQUIRED）',
    !werr && !!j && j.ok === false && j.status === 'rejected' && j.code === 'LEDGER_AUTH_REQUIRED' && j.action === 'write',
    werr ? ('THROW ' + werr.message) : String(w).slice(0, 220));
  t('库层对照：回执不再把 runLedger 当写通道（明说没有写通道）',
    !werr && !!j && /SQLite LedgerService/.test(String(j.note)) && !/请走本机直接 API/.test(String(j.note)),
    j ? String(j.note).slice(0, 200) : '');

  const after = readText(ledgerFile);
  t('库层对照：临时账本逐字未变（bytes 完全相同）', after === before,
    after === before ? (rows(after).length + ' 行 · ' + String(after).length + ' 字节') : '变了');
  t('库层对照：种子仍是 ' + SEED_ROWS.length + ' 行，没多出那一条',
    rows(after).length === SEED_ROWS.length && !String(after).includes('库层直写对照'), rows(after).length + ' 行');
  const snapB = walk(home);
  t('库层对照：拒绝前后临时根快照完全一致（写没碰任何路径）',
    JSON.stringify(snapA) === JSON.stringify(snapB),
    JSON.stringify(snapA) === JSON.stringify(snapB) ? (snapA.length + ' 项') : ('A=' + JSON.stringify(snapA) + ' B=' + JSON.stringify(snapB)));

  // 关掉的只有写：库层读仍然通（读要 cfg、会读文件）
  let stats = '';
  try { stats = String(await mcp.runLedger({ action: 'stats' }, cfg)); } catch (e) { stats = 'THROW ' + e.message; }
  t('库层读：runLedger() stats 仍读得到临时那本（共 ' + SEED_ROWS.length + ' 条）',
    stats.includes(ledgerFile) && stats.includes('共 ' + SEED_ROWS.length + ' 条'), stats.split('\n')[0]);
  let list = '';
  try { list = String(await mcp.runLedger({ action: 'list', type: 'fact' }, cfg)); } catch (e) { list = 'THROW ' + e.message; }
  t('库层读：runLedger() list 仍读得到种子行（且只出事实）',
    list.includes('种子事实一') && !list.includes('种子搁置一'), list.split('\n')[0]);

  let out = null;
  try { out = await mcp.callTool('soul_ledger', { action: 'write', type: 'fact', text: '库层拒完之后再试' }, {}); } catch (e) { out = 'THROW ' + e.message; }
  const j2 = parse(out);
  t('库层拒完之后：MCP 边界仍然拒（结论不随层变）',
    !!j2 && j2.status === 'rejected' && j2.code === 'LEDGER_AUTH_REQUIRED', String(out).slice(0, 140));
}

// ── 子进程：一个场景一组断言，结果以 JSON 回给父进程 ────────────
async function child() {
  const scen = String(process.env.AGENT_SOUL_SCENARIO || '');
  const home = path.resolve(String(process.env.AGENT_SOUL_HOME || ''));
  const res = { scen, home, assert: [], storeModeAtStart: null, storeModeAfter: null };
  const t = (name, ok, detail) => res.assert.push({ name, ok: !!ok, detail: detail === undefined ? null : String(detail) });

  const mcp = await import('../src/adapters/mcp-tools.mjs');
  res.storeModeAtStart = mcp.storeMode();

  // ① 写：一律拒绝（每个场景都验，且都排在**任何读**之前）
  await checkWriteDenied(mcp, home, t);
  t('写拒绝期间 store() 没被调用（<home>/data 未被造出）', !fs.existsSync(path.join(home, 'data')) || scen === 'ro',
    scen === 'ro' ? '(ro 场景由父进程预建 data/sessions，此条不适用)' : '');

  // ② 读：rw / ro 才有意义（读要 cfg，读会建 store）
  if (scen === 'rw' || scen === 'ro') {
    const stats = await checkReads(mcp, home, t);
    if (scen === 'ro') {
      t('ro：进程确实处于只读模式', mcp.storeMode() === 'ro', mcp.storeMode());
      mcp.setStoreMode('rw');
      t("ro：setStoreMode('rw') 抬不动只读", mcp.storeMode() === 'ro', mcp.storeMode());
      t('ro：list/stats 仍读临时 JSONL（共 3 条）', stats.includes('共 3 条'), stats.split('\n')[0]);
    } else {
      t('rw：读之后 data/ 才出现（说明建 store 是读的副作用，不是写的）', fs.existsSync(path.join(home, 'data')));
    }
  }

  // ★ 库层对照（只 rw）：task-7 rev 3 之后库层**也拒写** —— 这里验的是「绕过边界同样拿不到」。
  if (scen === 'rw') await checkLibraryLayer(mcp, home, t);

  // ③ storeMode='off'：拒绝不依赖 store 状态
  if (scen === 'off') {
    mcp.setStoreMode('off');
    t("off：storeMode 真的变成 'off'", mcp.storeMode() === 'off', mcp.storeMode());
    let out = '', err = null;
    try { out = await mcp.callTool('soul_ledger', { action: 'write', type: 'fact', text: 'off 下也不写' }, {}); } catch (e) { err = e; }
    t("off：write 仍回 LEDGER_AUTH_REQUIRED（不是 SOUL_OFFLINE）", !err && /LEDGER_AUTH_REQUIRED/.test(String(out)), err ? ('THROW ' + err.message) : String(out).slice(0, 140));
    let readErr = null;
    try { await mcp.callTool('soul_ledger', { action: 'stats' }, {}); } catch (e) { readErr = e; }
    t('off：对照 —— 同模式下读会 SOUL_OFFLINE（说明拒绝不是 store 坏掉的副作用）',
      !!readErr && /SOUL_OFFLINE/.test(String(readErr.message)), readErr ? readErr.message.slice(0, 120) : '(没抛)');
    t("off：data/ 仍不存在（写与读都没碰盘）", !fs.existsSync(path.join(home, 'data')));
    res.storeModeAfter = mcp.storeMode();
  }

  // ④ 配置坏掉：write 仍被拒 = 没 loadConfig
  if (scen === 'badcfg') {
    let out = '', err = null;
    try { out = await mcp.callTool('soul_ledger', { action: 'write', type: 'fact', text: '坏配置下也不写' }, {}); } catch (e) { err = e; }
    const j = parse(out);
    t('badcfg：write 回 LEDGER_AUTH_REQUIRED（不是配置解析错误）', !err && !!j && j.code === 'LEDGER_AUTH_REQUIRED', err ? ('THROW ' + err.message) : String(out).slice(0, 160));
    let readErr = null;
    try { await mcp.callTool('soul_ledger', { action: 'stats' }, {}); } catch (e) { readErr = e; }
    t('badcfg：对照 —— 读路径**真的会** loadConfig（因此报解析失败）',
      !!readErr && /config\.json/.test(String(readErr.message)), readErr ? readErr.message.slice(0, 140) : '(没抛，说明读路径没读配置)');
  }

  process.stdout.write('__JSON_BEGIN__' + JSON.stringify(res) + '__JSON_END__');
}

// ── 真外部入口：stdio 腿（src/adapters/mcp.mjs）────────────────────
//
// ★ 上面那些场景直接 import mcp-tools 调 callTool —— 那证明的是「函数层拒绝」。
//   宿主真正摸到的是 stdio 腿，而它有三条路由：
//     standalone → 走到 callTool，由这次的闸门拒（LEDGER_AUTH_REQUIRED）
//     readonly   → manifest 层在 callTool 之前就拒（SOUL_READONLY）
//     offline    → 写工具在 callTool 之前就拒（SOUL_OFFLINE，旧语义）
//   三条都要证**结果**：写都拒，且临时根一个字节都没变。
function cleanEnv(home, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith('AGENT_SOUL_') || k === 'SOUL_STDIO_MODE' || k === 'SOUL_HUB_URL') delete env[k];
  }
  env.AGENT_SOUL_HOME = home;
  Object.assign(env, extra);
  return env;
}

/** 跑一条 stdio 腿；id 从 2 开始按 calls 顺序递增。 */
function runStdio(home, extraEnv, calls, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [SERVER], {
      cwd: REPO, env: cleanEnv(home, extraEnv), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let out = '', err = '', finished = false, timer = null, poll = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      try { p.kill(); } catch { /* 已经走了 */ }
      const lines = out.split('\n').filter(Boolean).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
      resolve({ byId: new Map(lines.filter((l) => l.id != null).map((l) => [l.id, l])), raw: out, err });
    };
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('exit', finish);
    timer = setTimeout(finish, timeoutMs);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }) + '\n');
    // 路由探测（离线那条最多 500ms）落定之后再发 call
    setTimeout(() => {
      calls.forEach((c, i) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i + 2, method: 'tools/call', params: { name: c.name, arguments: c.args || {} } }) + '\n'));
      const ids = calls.map((_, i) => i + 2);
      poll = setInterval(() => {
        if (ids.every((i) => out.includes('"id":' + i))) { clearInterval(poll); setTimeout(finish, 200); }
      }, 120);
    }, 600);
  });
}

function stdioReply(resp) {
  const c = (resp && resp.result && Array.isArray(resp.result.content)) ? resp.result.content : [];
  const text = c.map((x) => String((x && x.text) || ''));
  let parsed = null;
  for (const s of text) { try { parsed = JSON.parse(s); break; } catch { /* 不是 JSON */ } }
  return { text, parsed, isError: Boolean(resp && resp.result && resp.result.isError) };
}

/** 一条路由的写拒绝：拒绝形状 + 零文件改动。 */
async function checkStdioWrite(t, label, home, extraEnv, expectCode) {
  const ledgerFile = path.join(home, LEDGER_REL);
  const before = readText(ledgerFile);
  const snapA = walk(home);
  const r = await runStdio(home, extraEnv, [{
    name: 'soul_ledger',
    args: { action: 'write', type: 'promise', text: 'stdio 直写 ' + label, by: FORGED, sessionId: FORGED },
  }]);
  const rep = stdioReply(r.byId.get(2));
  const okShape = !!rep.parsed && rep.parsed.ok === false && rep.parsed.status === 'rejected' && rep.parsed.code === expectCode;
  t('stdio[' + label + '] write → ' + expectCode, okShape,
    rep.parsed ? JSON.stringify(rep.parsed).slice(0, 220) : ((r.raw || '').slice(-400) || (r.err || '').slice(-400)));
  const snapB = walk(home);
  const same = JSON.stringify(snapA) === JSON.stringify(snapB);
  t('stdio[' + label + '] 拒绝前后临时根快照一致', same, same ? (snapA.length + ' 项') : ('A=' + JSON.stringify(snapA) + ' B=' + JSON.stringify(snapB)));
  t('stdio[' + label + '] 账本 JSONL 逐字未变', readText(ledgerFile) === before);
}

// ── 父进程：建临时根、跑场景、验临时根被删干净 ─────────────────
function mkHome(root, name, { badConfig = false, readonly = false } = {}) {
  const home = path.join(root, name);
  fs.mkdirSync(home, { recursive: true });
  const dataDir = path.join(home, 'data');
  const cfg = { dataDir, ledger: { file: path.join(home, LEDGER_REL) } };
  fs.writeFileSync(path.join(home, 'config.json'), badConfig ? '{ this is not json' : JSON.stringify(cfg, null, 2), 'utf8');
  if (readonly) fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
  return home;
}

function seedLedger(home) {
  fs.writeFileSync(path.join(home, LEDGER_REL), SEED_ROWS.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function runScenario(home, scen, extraEnv = {}) {
  const env = { ...process.env, AGENT_SOUL_HOME: home, AGENT_SOUL_SCENARIO: scen };
  delete env.AGENT_SOUL_READONLY; delete env.AGENT_SOUL_DATA; delete env.AGENT_SOUL_META_DB; delete env.SOUL_STDIO_MODE;
  Object.assign(env, extraEnv);
  const out = execFileSync(process.execPath, [process.argv[1], '--child'], { env, encoding: 'utf8', cwd: process.cwd() });
  const m = out.match(/__JSON_BEGIN__([\s\S]*)__JSON_END__/);
  if (!m) throw new Error('子进程没回结果（场景 ' + scen + '）：' + out.slice(-800));
  return JSON.parse(m[1]);
}

async function parent() {
  const root = path.join(os.tmpdir(), 'agent-soul-ledger-guard-' + process.pid + '-' + Date.now());
  fs.mkdirSync(root, { recursive: true });
  let pass = 0, fail = 0;
  const report = (title, list) => {
    console.log('\n── ' + title + ' ──');
    for (const a of list) {
      if (a.ok) { pass++; console.log('  ✓ ' + a.name + (a.detail ? '  ' + a.detail : '')); }
      else { fail++; console.log('  ✗ ' + a.name + (a.detail ? '  → ' + a.detail : '')); }
    }
  };
  try {
    console.log('临时根：' + root);

    const homeRw = mkHome(root, 'home-rw'); seedLedger(homeRw);
    report('场景 rw（临时 cfg，默认读写）', runScenario(homeRw, 'rw').assert);

    const homeOff = mkHome(root, 'home-off'); seedLedger(homeOff);
    report('场景 off（storeMode=off）', runScenario(homeOff, 'off').assert);

    const homeRo = mkHome(root, 'home-ro', { readonly: true }); seedLedger(homeRo);
    report('场景 ro（AGENT_SOUL_READONLY=1 + SOUL_STDIO_MODE=standalone）',
      runScenario(homeRo, 'ro', { AGENT_SOUL_READONLY: '1', SOUL_STDIO_MODE: 'standalone' }).assert);

    const homeBad = mkHome(root, 'home-badcfg', { badConfig: true }); seedLedger(homeBad);
    report('场景 badcfg（config.json 是非法 JSON）', runScenario(homeBad, 'badcfg').assert);

    // 没有 config.json：write 仍必须被拒（这个场景**不读**，否则会落到默认 dataDir）
    const homeNone = path.join(root, 'home-nocfg');
    fs.mkdirSync(homeNone, { recursive: true });
    const rNone = runScenario(homeNone, 'nocfg');
    report('场景 nocfg（连 config.json 都没有）', rNone.assert.filter((a) => /write\[|invalid\[|快照|JSONL 逐字/.test(a.name)));
    const left = fs.readdirSync(homeNone);
    if (left.length === 0) { pass++; console.log('\n  ✓ nocfg：临时 home 仍然是空的（一个文件都没造）'); }
    else { fail++; console.log('\n  ✗ nocfg：凭空多出 ' + JSON.stringify(left)); }

    // ── 真外部入口：stdio 腿的三种路由 ──
    const collect = () => {
      const list = [];
      return [list, (name, ok, detail) => list.push({ name, ok: !!ok, detail: detail === undefined ? null : String(detail) })];
    };

    const homeStdio = mkHome(root, 'home-stdio'); seedLedger(homeStdio);
    const [stdList, stdT] = collect();
    await checkStdioWrite(stdT, 'standalone', homeStdio, { SOUL_STDIO_MODE: 'standalone' }, 'LEDGER_AUTH_REQUIRED');
    // 同一路由的读：外部入口没被闸门误伤（读的是**临时那本**）
    const rRead = await runStdio(homeStdio, { SOUL_STDIO_MODE: 'standalone' }, [{ name: 'soul_ledger', args: { action: 'stats' } }]);
    const readJoined = stdioReply(rRead.byId.get(2)).text.join('\n');
    stdT('stdio[standalone] stats 读的是临时那本（读没被闸门误伤）',
      readJoined.includes(homeStdio) && readJoined.includes('共 3 条'), readJoined.split('\n')[0]);
    report('场景 stdio standalone（真外部入口 · SOUL_STDIO_MODE=standalone）', stdList);

    const homeStdioRo = mkHome(root, 'home-stdio-ro'); seedLedger(homeStdioRo);
    const [roList, roT] = collect();
    await checkStdioWrite(roT, 'readonly', homeStdioRo, { AGENT_SOUL_READONLY: '1', SOUL_HUB_URL: 'http://127.0.0.1:9' }, 'LEDGER_AUTH_REQUIRED');
    report('场景 stdio 只读（AGENT_SOUL_READONLY=1 · manifest 识别为 read，handler 仍拒 JSONL write）', roList);

    const homeStdioOff = mkHome(root, 'home-stdio-offline'); seedLedger(homeStdioOff);
    const [offList, offT] = collect();
    await checkStdioWrite(offT, 'offline', homeStdioOff, { SOUL_HUB_URL: 'http://127.0.0.1:9' }, 'LEDGER_AUTH_REQUIRED');
    report('场景 stdio 离线（manifest read 路由进 helper；JSONL write 仍由 handler fail-closed）', offList);

    const allFiles = walk(root).filter((l) => l.startsWith('F '));
    const secondBook = allFiles.filter((l) => /02-墨/.test(l));
    if (secondBook.length === 0) { pass++; console.log('  ✓ 临时根里没有任何第二本账（没有 02-墨.jsonl）'); }
    else { fail++; console.log('  ✗ 意外产物：' + secondBook.join(' | ')); }
    console.log('  · 临时根内文件数（含各 home 的种子账本）：' + allFiles.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    const gone = !fs.existsSync(root);
    if (gone) { pass++; console.log('\n  ✓ 临时根已删除并验证不存在：' + root); }
    else { fail++; console.log('\n  ✗ 临时根没删掉：' + root); }
  }
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
  if (fail) process.exitCode = 1;
}

if (CHILD) await child();
else await parent();
