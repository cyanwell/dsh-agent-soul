// 账本只读自检（task-7 rev 3 · 2026-11-15）
//
// ★ 前身是 2026-11-09 的「写读分叉」自检：那时 runLedger() 还能写，验的是
//   「写进去的那本 == 读出来的那本」。
// ★★ task-7 rev 3 之后 runLedger() 的 action=write **永久关闭**：原始 JSONL 账本只读，
//   替代它的 SQLite LedgerService 尚未实现 —— 现在没有任何写通道。所以改验两件事：
//     ① 写：每一种账本类型、每一种伪造身份、每一种缺失 / 坏掉的配置，都回
//        LEDGER_AUTH_REQUIRED，且**一个路径都没被碰**（父目录都不许被造出来）；
//        顺序另有机械判据：拒绝分支在源码里排在 organs/ledger 动态 import 与
//        resolveLedgerPath 之前，且 cfg 做成「一读就抛」的 Proxy 仍能拿到拒绝。
//     ② 读：list / stats 仍然读得到**显式写进临时 fixture** 的种子 JSONL。
//
// ★ 种子是这里逐行写出来的（不是从生产《墨》拷、也不是 runLedger 写进去的）：
//   读到的东西只能来自 fixture，不可能来自被验的那条代码路径。
// ★ 全在临时目录里造：**不读生产 config、不碰 D:/AI/agent-soul/data、不碰 02-墨.jsonl**，
//   跑完删掉并验证删掉了。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TYPES, LABEL } from '../src/organs/ledger.mjs';
import {
  runLedger, resolveLedgerPath,
  LEDGER_WRITE_LOCK_CODE, LEDGER_MCP_READ_ACTIONS,
} from '../src/adapters/mcp-tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', 'src', 'adapters', 'mcp-tools.mjs');

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
const FORGED = 'session-8332345a-52d3-4a7d-afc5-5f4342a2ef0c';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-ledger-'));
const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const lines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length : -1);
const row = (type, text, by) => JSON.stringify({ t: '2026-11-09T10:00:00+08:00', type, by, text }) + '\n';

/** 目录树快照（相对路径 + size + mtime）——「一个路径都没被碰」的判据。 */
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

/** 拒绝回执的形状：status 与 code 都要有 —— 只给 code 的话，按 status 判拒的上游会读成成功。 */
function isLocked(out) {
  const j = parse(out);
  return !!j && j.ok === false && j.status === 'rejected' && j.code === LEDGER_WRITE_LOCK_CODE
    && j.tool === 'soul_ledger' && j.action === 'write'
    && Array.isArray(j.allowed)
    && LEDGER_MCP_READ_ACTIONS.every((a) => j.allowed.includes(a))
    && !j.allowed.includes('write');
}

async function main() {
  // ── ① 临时 fixture：三个位置各造一本「老 JSONL」（逐行显式写）──────────
  const soul = path.join(ROOT, 'soul');
  const data = path.join(ROOT, 'data');
  const mo = mk(path.join(soul, '02-墨.jsonl'));
  const fallback = mk(path.join(data, 'ledger.jsonl'));
  const explicit = mk(path.join(ROOT, 'explicit', 'my-ledger.jsonl'));

  // ★ 8 类全种上 —— 「每一种账本类型都拒写」才有东西可对照
  const SEED_BY = { lead: 'session-seed0003' };
  const seedRows = TYPES.map((ty, i) => row(ty, '墨种子:' + ty, SEED_BY[ty] || 'session-seed00' + (10 + i)));
  fs.writeFileSync(mo, seedRows.join(''), 'utf8');
  fs.writeFileSync(fallback, row('container', '兜底账里的孤儿行', 'qq-lead-session-bf00a6ed'), 'utf8');
  fs.writeFileSync(explicit, row('fact', '显式那本的一行', 'session-seed-explicit'), 'utf8');

  const cfgA = { dataDir: data, soul: { root: soul } };              // ★ 没有 ledger.file
  const cfgExplicit = { ...cfgA, ledger: { file: explicit } };

  // 读的选源仍是 pickLedger 三级（写已经不选源了）
  const pickedA = await resolveLedgerPath(cfgA);
  push('读选源命中 soul.root 的《墨》（不是兜底账）', pickedA.file === mo && pickedA.exists === true,
    pickedA.file + '  source=' + pickedA.source);
  const pickedExplicit = await resolveLedgerPath(cfgExplicit);
  push('读选源：config.ledger.file 优先于《墨》', pickedExplicit.file === explicit, 'source=' + pickedExplicit.source);

  // ── ② 写：一律拒，且一个路径都没被碰 ─────────────────────────────────
  const deep = path.join(ROOT, 'never', 'deep', 'ledger.jsonl');     // 父目录**不存在**
  const poisoned = new Proxy({}, {
    get() { throw new Error('cfg 被读取了 —— 写路径不该碰配置'); },
    has() { throw new Error('cfg 被探测了 —— 写路径不该碰配置'); },
  });

  const defaultActions = [undefined, null, ''];
  for (const raw of defaultActions) {
    const args = raw === undefined ? {} : { action: raw };
    const out = await runLedger(args, cfgA);
    const j = parse(out);
    push('missing/null/empty action defaults to list', !j && typeof out === 'string' && out.includes('墨种子:lead'), raw === undefined ? 'missing' : String(raw));
  }
  const INVALID_ACTIONS = ['append', 'WRITE', 'write ', 1, true, {}, ['write'], { toString() { return 'write'; } }];
  const invalidBefore = walk(ROOT);
  for (const raw of INVALID_ACTIONS) {
    let out = null, err = null;
    try { out = await runLedger({ action: raw }, poisoned); } catch (e) { err = e; }
    const j = parse(out);
    push('invalid action=' + (typeof raw === 'string' ? raw : (JSON.stringify(raw) || typeof raw)) + ' → INVALID_ACTION before cfg access', !err && j && j.status === 'invalid' && j.code === 'INVALID_ACTION', err ? err.message : oneLine(out));
  }
  push('invalid action probes leave temp filesystem unchanged', JSON.stringify(invalidBefore) === JSON.stringify(walk(ROOT)));

  const CASES = [
    ...TYPES.map((ty) => ({
      label: 'type=' + ty + '（' + LABEL[ty] + '）',
      args: { action: 'write', type: ty, text: '不该落地的 ' + ty }, cfg: cfgA,
    })),
    { label: 'type 未给', args: { action: 'write', text: '没有类型' }, cfg: cfgA },
    { label: 'type 不存在', args: { action: 'write', type: 'bogus-type', text: '没有这个类型' }, cfg: cfgA },
    { label: 'by 伪造', args: { action: 'write', type: 'fact', text: '伪造署名', by: FORGED }, cfg: cfgA },
    { label: 'args.sessionId 伪造', args: { action: 'write', type: 'fact', text: '伪造会话参数', sessionId: FORGED }, cfg: cfgA },
    { label: '第三参数 sessionId 伪造（旧 API 的 by 兜底）', args: { action: 'write', type: 'promise', text: '伪造第三参数' }, cfg: cfgA, sess: FORGED },
    { label: 'by + sessionId + 第三参数全伪造', args: { action: 'write', type: 'lead', text: '全伪造', by: FORGED, sessionId: FORGED }, cfg: cfgA, sess: FORGED },
    { label: 'cfg = 空对象（absent）', args: { action: 'write', type: 'fact', text: 'x' }, cfg: {} },
    { label: 'cfg = undefined（absent）', args: { action: 'write', type: 'fact', text: 'x' }, cfg: undefined },
    { label: 'cfg = null（malformed）', args: { action: 'write', type: 'fact', text: 'x' }, cfg: null },
    { label: 'cfg = 字符串（malformed）', args: { action: 'write', type: 'fact', text: 'x' }, cfg: 'not-a-config' },
    { label: 'cfg.ledger.file 是数字（malformed）', args: { action: 'write', type: 'fact', text: 'x' }, cfg: { ledger: { file: 42 }, dataDir: path.join(ROOT, 'data3') } },
    { label: 'cfg 指向不存在的深路径', args: { action: 'write', type: 'fact', text: 'x' }, cfg: { ledger: { file: deep } } },
    { label: '★ cfg 是「一读就抛」的 Proxy（证明选源没被调用）', args: { action: 'write', type: 'fact', text: 'x' }, cfg: poisoned },
  ];

  const snapA = walk(ROOT);
  const moBefore = readText(mo), fbBefore = readText(fallback), exBefore = readText(explicit);

  for (const c of CASES) {
    let out = null, err = null;
    try { out = await runLedger(c.args, c.cfg, c.sess); } catch (e) { err = e; }
    if (err) { push('write[' + c.label + '] 不抛错', false, err.message); continue; }
    push('write[' + c.label + '] → rejected / ' + LEDGER_WRITE_LOCK_CODE, isLocked(out), oneLine(out).slice(0, 180));
  }

  const snapB = walk(ROOT);
  push('★★ 拒绝前后：临时根快照完全一致（一个路径都没被碰）',
    JSON.stringify(snapA) === JSON.stringify(snapB),
    JSON.stringify(snapA) === JSON.stringify(snapB) ? (snapA.length + ' 项') : ('A=' + JSON.stringify(snapA) + ' B=' + JSON.stringify(snapB)));
  push('★★ 《墨》fixture 逐字未变', readText(mo) === moBefore, (moBefore || '').length + ' 字节');
  push('★★ 兜底账 fixture 逐字未变', readText(fallback) === fbBefore, (fbBefore || '').length + ' 字节');
  push('★★ 显式账 fixture 逐字未变', readText(explicit) === exBefore, (exBefore || '').length + ' 字节');
  push('★★ 行数没涨：《墨》仍是 ' + TYPES.length + ' 行', lines(mo) === TYPES.length, String(lines(mo)));
  push('★★ 不存在的深路径没被造出来（连父目录都没有）', !fs.existsSync(path.join(ROOT, 'never')), path.join(ROOT, 'never'));
  push('★★ 缺失的 dataDir 没被 mkdir（data3 不存在）', !fs.existsSync(path.join(ROOT, 'data3')));
  const jsonl = walk(ROOT).filter((l) => /^F .*\.jsonl /.test(l));
  push('临时根里仍然只有 3 本 jsonl，没有第四本', jsonl.length === 3, JSON.stringify(jsonl));

  // ── ③ 顺序：write 与 invalid 拒绝都必须早于 import / 选源 / LedgerBase ───
  const src = fs.readFileSync(SRC, 'utf8');
  const fnStart = src.indexOf('export async function runLedger');
  const fnBody = fnStart < 0 ? '' : src.slice(fnStart, src.indexOf('\n}\n', fnStart));
  const iWriteGate = fnBody.indexOf("if (action === 'write') return ledgerLockedReply('write');");
  const iInvalidGate = fnBody.indexOf('LEDGER_INVALID_ACTION_CODE');
  const iImport = fnBody.indexOf("await import('../organs/ledger.mjs')");
  const iResolve = fnBody.indexOf('await resolveLedgerPath(cfg)');
  const iLedger = fnBody.indexOf('new LedgerBase(');
  for (const [label, gate] of [['write', iWriteGate], ['invalid', iInvalidGate]]) {
    push('★★ ' + label + ' 拒绝在 organs/ledger 动态 import 之前', gate >= 0 && iImport > gate, 'gate=' + gate + ' import=' + iImport);
    push('★★ ' + label + ' 拒绝在 resolveLedgerPath 之前', gate >= 0 && iResolve > gate, 'gate=' + gate + ' resolve=' + iResolve);
    push('★★ ' + label + ' 拒绝在 LedgerBase 构造之前', gate >= 0 && iLedger > gate, 'gate=' + gate + ' LedgerBase=' + iLedger);
  }

  // ── ④ 读：list / stats 仍然读得到显式种在 fixture 里的行 ────────────────
  const lAll = await runLedger({ action: 'list', limit: 50 }, cfgA);
  push('读 list：8 类种子都能读回来', TYPES.every((ty) => String(lAll).includes('墨种子:' + ty)), oneLine(lAll).slice(0, 160));
  const lFact = await runLedger({ action: 'list', type: 'fact', limit: 10 }, cfgA);
  push('读 list type=fact：只出事实行', String(lFact).includes('墨种子:fact') && !String(lFact).includes('墨种子:shelved'),
    oneLine(lFact).slice(0, 140));
  const sA = await runLedger({ action: 'stats' }, cfgA);
  const statsPath = (String(sA).split('\n')[0].match(/^账本 (.+?)（选源：/) || [])[1] || '';
  push('★★ stats 读的是《墨》fixture（不是兜底账）', statsPath === mo, 'stats 读出: ' + statsPath);
  push('读 stats：共 ' + TYPES.length + ' 条', String(sA).includes('共 ' + TYPES.length + ' 条'),
    (String(sA).split('\n').find((l) => l.includes('共 ')) || '').trim());
  push('读 stats：当前主导 = seed0003', String(sA).includes('session-seed0003'), '');
  const lExplicit = await runLedger({ action: 'list', limit: 5 }, cfgExplicit);
  push('读 list：显式账那本优先（读到它自己的行）', String(lExplicit).includes('显式那本的一行'), oneLine(lExplicit).slice(0, 140));

  const data2 = path.join(ROOT, 'data2'); fs.mkdirSync(data2, { recursive: true });
  const lB = await runLedger({ action: 'list' }, { dataDir: data2 });
  push('读：文件不存在时说「不存在」而不是「没有记录」', /不存在/.test(String(lB)) && !/没有符合条件的记录/.test(String(lB)),
    oneLine(lB).slice(0, 140));
  push('读：缺文件时也不新建兜底账', !fs.existsSync(path.join(data2, 'ledger.jsonl')), JSON.stringify(fs.readdirSync(data2)));
}

let threw = null;
try { await main(); } catch (e) { threw = e; }
if (threw) push('没抛异常', false, threw && threw.stack ? threw.stack.split('\n').slice(0, 3).join(' | ') : String(threw));

console.log('');
console.log('=== 账本只读自检（临时目录：' + ROOT + '）===');
console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log('');
console.log(ok.length + ' 通过 / ' + bad.length + ' 失败');
console.log('');

let cleaned = false;
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 下面统一判 */ }
cleaned = !fs.existsSync(ROOT);
console.log(cleaned ? '✓ 临时目录已删除并验证不存在' : '✗ 临时目录没删掉：' + ROOT);
console.log('');
process.exit(bad.length || !cleaned ? 1 : 0);
