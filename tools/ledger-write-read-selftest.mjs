// 账本「写读分叉」自检 —— 2026-11-09
//
// 修的那个 bug：写走 cfg.ledger.file || dataDir/ledger.jsonl（不经选源），
// 读走 pickLedger 三级（命中 soul.root/02-墨.jsonl）—— 于是写进兜底账、读走《墨》，
// 两边都不报错。这个自检只盯一件事：
//   **写进去的那本，和读出来的那本，是不是同一个文件。**
//
// ★ 全部在临时目录里造，不碰 D:/AI/agent-soul/data，不读生产 config，不启动服务。
//   直接调 runLedger()，配置由这里显式传进去。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runLedger, resolveLedgerPath } from '../src/adapters/mcp-tools.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-ledger-'));
const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); return p; };
const lines = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length : -1);
const row = (type, text, by) => JSON.stringify({ t: '2026-11-09T10:00:00+08:00', type, by, text }) + '\n';
const countOf = (p, needle) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(needle).length - 1 : -1);

async function main() {
  // ── ① 两本账并存：这就是 bug 的原形 ───────────────────────────
  const soul = path.join(ROOT, 'soul');
  const data = path.join(ROOT, 'data');
  const mo = mk(path.join(soul, '02-墨.jsonl'));
  const fallback = mk(path.join(data, 'ledger.jsonl'));
  fs.appendFileSync(mo, row('fact', '墨里的老一行', 'sess-old'));
  fs.appendFileSync(fallback, row('container', '兜底账里的孤儿行', 'qq-lead-session-bf00a6ed'));
  const cfgA = { dataDir: data, soul: { root: soul } };   // ★ 没有 ledger.file

  const pickedA = await resolveLedgerPath(cfgA);
  push('★ 选源命中 soul.root 的《墨》（不是兜底账）', pickedA.file === mo && pickedA.exists === true,
    pickedA.file + '  source=' + pickedA.source);

  const moBefore = lines(mo), fbBefore = lines(fallback);
  const wA = await runLedger({ action: 'write', type: 'fact', text: '这条必须写进墨', by: 'sess-new' }, cfgA);
  push('写回执成功', /^✓ 已记入账本/.test(wA), oneLine(wA).slice(0, 120));
  push('★ 回执说出了落点（不再是「已记入账本」四个字）', wA.includes(mo), oneLine(wA).slice(0, 120));
  push('★ 写进《墨》+1 行', lines(mo) === moBefore + 1, moBefore + ' → ' + lines(mo));
  push('★★ 兜底账**一行没动**', lines(fallback) === fbBefore, fbBefore + ' → ' + lines(fallback));

  // 写进去的那本 = 读出来的那本：用 stats 的抬头核对（那里会印路径）
  const sA = await runLedger({ action: 'stats' }, cfgA);
  const statsPath = (sA.split('\n')[0].match(/^账本 (.+?)（选源：/) || [])[1] || '';
  push('★★ 写与读指向同一个文件', statsPath === mo, 'stats 读出: ' + statsPath);

  // 内容层再核一次：写的那句能从 list 里读回来
  const lA = await runLedger({ action: 'list', type: 'fact', limit: 10 }, cfgA);
  push('★★ 刚写的那条能被读回来', lA.includes('这条必须写进墨'), oneLine(lA).slice(0, 160));

  // ── ② 未配置 + 没有账本文件：不许写兜底账 ───────────────────────
  const data2 = path.join(ROOT, 'data2');
  fs.mkdirSync(data2, { recursive: true });
  const cfgB = { dataDir: data2 };                        // ★ 没有 ledger.file，没有 soul.root

  const pickedB = await resolveLedgerPath(cfgB);
  push('选源没找到（exists=false）', pickedB.exists === false, 'source=' + pickedB.source + ' tried=' + pickedB.tried.join(' / '));

  const wB = await runLedger({ action: 'write', type: 'fact', text: '不该落地的一条', by: 'sess-x' }, cfgB);
  push('★ 未配置时明确报 UNCONFIGURED', /UNCONFIGURED/.test(wB), oneLine(wB).slice(0, 140));
  push('★★ 兜底账 <dataDir>/ledger.jsonl **没有被创建**', !fs.existsSync(path.join(data2, 'ledger.jsonl')),
    path.join(data2, 'ledger.jsonl') + ' exists=' + fs.existsSync(path.join(data2, 'ledger.jsonl')));
  push('data2 里没有多出任何 jsonl', fs.readdirSync(data2).filter((f) => f.endsWith('.jsonl')).length === 0,
    JSON.stringify(fs.readdirSync(data2)));

  const lB = await runLedger({ action: 'list' }, cfgB);
  push('读也说清「文件不存在」而不是「没有记录」', /不存在/.test(lB) && !/没有符合条件的记录/.test(lB), oneLine(lB).slice(0, 140));

  // ── ③ 一个候选都没有（连 dataDir 都没配）─────────────────────────
  const wC = await runLedger({ action: 'write', type: 'fact', text: 'x', by: 'sess-y' }, {});
  push('★ 一个候选都没有也报 UNCONFIGURED', /UNCONFIGURED/.test(wC), oneLine(wC).slice(0, 140));

  // ── ④ 显式 config.ledger.file 优先，两份都写它 ────────────────────
  const explicit = mk(path.join(ROOT, 'explicit', 'my-ledger.jsonl'));
  fs.appendFileSync(explicit, row('fact', '显式配的那本', 'sess-e'));
  const cfgD = { dataDir: data, soul: { root: soul }, ledger: { file: explicit } };
  const pickedD = await resolveLedgerPath(cfgD);
  push('① 级（config.ledger.file）优先于《墨》', pickedD.file === explicit, 'source=' + pickedD.source);

  const moBeforeD = lines(mo);
  const wD = await runLedger({ action: 'write', type: 'gain', text: '写进显式那本', by: 'sess-d' }, cfgD);
  push('★ 写进显式那本', /^✓/.test(wD) && lines(explicit) === 2, lines(explicit) + ' 行 · ' + oneLine(wD).slice(0, 100));
  push('★ 《墨》一行没被动', lines(mo) === moBeforeD, moBeforeD + ' → ' + lines(mo));
  const lD = await runLedger({ action: 'list', limit: 5 }, cfgD);
  push('★ 读也是显式那本', lD.includes('写进显式那本'), oneLine(lD).slice(0, 140));

  // ── ⑤ 只追加：写两次，行数 +2，不重写旧行 ─────────────────────────
  const n1 = lines(mo);
  await runLedger({ action: 'write', type: 'fact', text: '第二笔', by: 'sess-new' }, cfgA);
  await runLedger({ action: 'write', type: 'fact', text: '第三笔', by: 'sess-new' }, cfgA);
  push('★ 只追加，旧行没被重写', lines(mo) === n1 + 2 && countOf(mo, '墨里的老一行') === 1, n1 + ' → ' + lines(mo));
}

let threw = null;
try { await main(); } catch (e) { threw = e; }
if (threw) push('没抛异常', false, threw && threw.stack ? threw.stack.split('\n').slice(0, 3).join(' | ') : String(threw));

console.log('');
console.log('=== 账本写读一致性自检（临时目录：' + ROOT + '）===');
console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log('');
console.log(ok.length + ' 通过 / ' + bad.length + ' 失败');
console.log('');

try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
process.exit(bad.length ? 1 : 0);
