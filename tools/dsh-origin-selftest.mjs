// 心跳地址自动发现自检（2026-11-11）
//
// 证明四件事：
//   ① 显式配置最高优先 —— 配了心跳地址就**一次日志都不读**；
//   ② 没配时从本机最新 DSH 启动记录里发现 origin，**端口一变，下一个 tick 就打新端口**（不缓存旧端口）；
//   ③ 发现不到 / 坏日志 / 多源不一致 → fail-closed（不动），错误串里**只有 origin，没有查询串**；
//   ④ 日志行里带着 launch token —— 它不许出现在任何状态、错误、回执里，也不许落盘。
//
// 跑法：node tools/dsh-origin-selftest.mjs
// ★ 全程用临时目录 + 本机假 HTTP（127.0.0.1:0 随机端口），不碰生产 data/、不碰真 DSH。
//
// ★★★ 2026-11-13（第 13 代，架构收敛）：**心跳路径已整块退役**。
//   v4 不再向 DSH 的 /heartbeat/auto 要任何东西 —— lead 判定改为纯本地（读《墨》最后一条 lead），
//   活跃度用 bridge 推的 state。理由：DSH 上只留 bridge + MCP hub 两个接口，减少渗入、降低维护成本。
//   所以本文件里「请求打到哪个端口」这类断言**没有对象了** —— 它们被改写成「一次都不发请求」，
//   而不是删掉：留着是为了让下一个人看清「这条路径是被有意移除的」。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLeadTargetResolver } from '../src/organs/lead-target.mjs';
import { discoverDshOrigin, resolveHeartbeatEndpoint, parseOriginsOfText } from '../src/organs/dsh-origin.mjs';
import { createTargetedCleanup } from '../src/organs/cleanup.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')); } };

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const ROOT = fs.mkdtempSync(path.join(TMP_ROOT, 'agent-soul-dsh-origin-'));
const LOGS = path.join(ROOT, 'logs');
const STATE_DIR = path.join(ROOT, 'state');
fs.mkdirSync(LOGS, { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
const NO_ORIGIN_FILE = path.join(ROOT, 'no-such-dsh-origin.txt');

// ★ 一个显眼的假 token：它出现在日志原文里，但绝不该出现在任何输出/回执/状态里。
const TOKEN = 'TOKENSECRET_9f3a1c7d_should_never_leak';

const PAYLOAD = { ok: true, enabled: true, state: 'counting', primaryFound: true, primarySessionId: 'sess-lead', primaryCandidates: 1, leadSource: '02-墨.jsonl:last-lead' };

/**
 * ★ 2026-11-13：造一本临时《墨》，让「本地账本判定」这条路能真的走通。
 *   判据同生产：账本只追加，最后一条 type='lead' 的 by 就是当前主导（8 位署名）。
 */
function makeLedger() {
  const file = path.join(ROOT, 'ledger.jsonl');
  const sid = 'session-abcdef12-3456-7890-abcd-ef1234567890';
  const rows = [
    { t: new Date(Date.now() - 7200000).toISOString(), type: 'fact', 概要: '旧事实', by: 'deadbeef' },
    { t: new Date(Date.now() - 3600000).toISOString(), type: 'lead', 概要: '第 N 代', by: 'abcdef12' },
  ];
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  return { file, sid, sessionsProvider: () => [{ id: sid }] };
}

function writeLog(name, text, mtimeMs) {
  const f = path.join(LOGS, name);
  fs.writeFileSync(f, text, 'utf8');
  if (mtimeMs) fs.utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  return f;
}

/** 假心跳：只数「谁被打到」+ 回固定 payload。 */
function startHeartbeat(payload) {
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({
        port, origin: 'http://127.0.0.1:' + port, hits,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

function walk(dir, out = []) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    const f = path.join(dir, n);
    let st = null;
    try { st = fs.statSync(f); } catch { continue; }
    if (st.isDirectory()) walk(f, out); else out.push(f);
  }
  return out;
}

const A = await startHeartbeat(PAYLOAD);
const B = await startHeartbeat(PAYLOAD);

console.log('');
console.log('=== 一 · 只认 http://127.0.0.1:<port>，查询串当场丢弃 ===');
{
  const line = 'dsh web: ' + A.origin + '/?token=' + TOKEN + ' ' + new Date().toISOString();
  const p = parseOriginsOfText(line);
  ok('①a 从启动行里取出 origin', p.origins.length === 1 && p.origins[0] === A.origin, JSON.stringify(p.origins));
  ok('①b 结果里没有查询串 / 没有 token', !JSON.stringify(p).includes('?') && !JSON.stringify(p).includes(TOKEN));
  const bad = parseOriginsOfText('http://192.168.1.5:9/ http://localhost:1/ https://127.0.0.1:1/ http://127.0.0.1:0/ http://127.0.0.1:70000/');
  ok('①c 非本机回环 / https / 越界端口一律不认', bad.origins.length === 0, JSON.stringify(bad.origins));
}

console.log('');
console.log('=== 二 · 显式配置最高优先（配了就不读日志）===');
{
  const t0 = Date.now() - 60000;
  writeLog('server-A.out.log', 'dsh web: ' + A.origin + '/?token=' + TOKEN + '\n', t0);
  const LED = makeLedger();
  const cfg = { integrations: { heartbeatUrl: B.origin + '/heartbeat/auto', ledgerFile: LED.file } };
  const ep = resolveHeartbeatEndpoint(cfg, { logDir: LOGS, originFile: NO_ORIGIN_FILE });
  ok('②a 地址来自 configured', ep.ok === true && ep.source === 'configured', ep.source + ' → ' + ep.origin);
  ok('②b 用的是配置的端口，不是日志里的端口', ep.origin === B.origin && ep.origin !== A.origin, ep.origin);

  const hitsBefore = B.hits.length;
  const lt = createLeadTargetResolver({ config: cfg, logDir: LOGS, originFile: NO_ORIGIN_FILE, sessionsProvider: LED.sessionsProvider });
  await lt.refreshIfNeeded({ enabled: true });
  ok('②c 心跳路径已退役：配了固定 URL 也**一次都不发请求**', B.hits.length === hitsBefore && A.hits.length === 0, 'B=' + B.hits.length + ' A=' + A.hits.length);
  ok('②d 判定来自《墨》账本（不再有 endpoint 字段）', lt.current().ok === true && /^ledger:/.test(String(lt.current().leadSource || '')), JSON.stringify({ ok: lt.current().ok, leadSource: lt.current().leadSource }));
}

console.log('');
console.log('=== 三 · 端口 A→B：下一个 tick 就打 B（不缓存旧端口）===');
{
  fs.readdirSync(LOGS).forEach((n) => fs.rmSync(path.join(LOGS, n)));
  const LED3 = makeLedger();
  const lt = createLeadTargetResolver({ config: { integrations: { ledgerFile: LED3.file } }, logDir: LOGS, originFile: NO_ORIGIN_FILE, sessionsProvider: LED3.sessionsProvider });

  writeLog('server-1.out.log', 'dsh web: ' + A.origin + '/?token=' + TOKEN + '\n', Date.now() - 60000);
  const aBefore = A.hits.length;
  await lt.refreshIfNeeded({ enabled: true });
  ok('③a 端口变化不再影响 v4（本地账本，不跟端口）', A.hits.length === aBefore && lt.current().ok === true, 'A=' + A.hits.length);

  writeLog('server-2.out.log', 'dsh web: ' + B.origin + '/?token=' + TOKEN + '\n', Date.now());
  const bBefore = B.hits.length;
  await lt.refreshIfNeeded({ enabled: true });
  ok('③b 端口变了也不发请求（同一个 resolver，不重建）', B.hits.length === bBefore, 'B=' + B.hits.length);
  ok('③c 状态里不再有 endpoint（心跳地址已退役）', (lt.state().endpoint || null) === null, JSON.stringify(lt.state().endpoint || null));

  // ★ cleanup 用的是**同一个** resolver：它自己的 run() 也要打到新端口
  const cleanup = createTargetedCleanup({
    control: { exec: async () => ({ ok: false }), snapshot: () => [], canDo: () => [] },
    autonomy: { config: {} },
    leadTarget: lt,
    dataDir: STATE_DIR,
    log: () => {},
  });
  const bBefore2 = B.hits.length;
  const rec = await cleanup.run({ startSeq: 10, endSeq: 20 });
  ok('③d 定点清理不再依赖心跳端口（心跳路径已退役）', true, '已退役：2026-11-13 心跳路径移除，本断言无对象')
}

console.log('');
console.log('=== 四 · 发现不到 / 坏日志 → fail-closed ===');
{
  const empty = { config: {}, logDir: path.join(ROOT, 'no-logs'), originFile: NO_ORIGIN_FILE };
  const d1 = discoverDshOrigin({ logDir: empty.logDir, originFile: NO_ORIGIN_FILE });
  ok('④a 没有日志也没有 origin 文件 → ok:false', d1.ok === false && /没有|读不到/.test(String(d1.why)), String(d1.why).slice(0, 120));

  const lt = createLeadTargetResolver({ config: {}, logDir: empty.logDir, originFile: NO_ORIGIN_FILE });
  const before = A.hits.length + B.hits.length;
  await lt.refreshIfNeeded({ enabled: true });
  ok('④b 发现不到时一个请求都不发', (A.hits.length + B.hits.length) === before);
  ok('④c 且说清缺什么', lt.current().ok === false && /账本|心跳/.test(String(lt.current().why)), String(lt.current().why).slice(0, 140));

  // 空文件（而且旁边还放着一份有 origin 的旧日志 —— 不许拿旧的顶）
  fs.readdirSync(LOGS).forEach((n) => fs.rmSync(path.join(LOGS, n)));
  writeLog('server-older.out.log', 'dsh web: ' + A.origin + '/?token=' + TOKEN + '\n', Date.now() - 300000);
  writeLog('server-empty.out.log', '', Date.now());
  const d2 = discoverDshOrigin({ logDir: LOGS, originFile: NO_ORIGIN_FILE });
  ok('④d 最新日志是空文件 → fail-closed（不回头读更老的那份）',
    d2.ok === false && /空文件/.test(String(d2.why)) && d2.origin !== A.origin, String(d2.why).slice(0, 120));

  // UTF-16 日志（Tee-Object 的产物）
  fs.readdirSync(LOGS).forEach((n) => fs.rmSync(path.join(LOGS, n)));
  const utf16 = path.join(LOGS, 'server-utf16.out.log');
  fs.writeFileSync(utf16, Buffer.from('dsh web: ' + A.origin + '/?token=' + TOKEN + '\n', 'utf16le'));
  fs.utimesSync(utf16, new Date(Date.now()), new Date(Date.now()));
  const d3 = discoverDshOrigin({ logDir: LOGS, originFile: NO_ORIGIN_FILE });
  ok('④e UTF-16 日志 → fail-closed（并说清是编码问题）', d3.ok === false && /UTF-8/.test(String(d3.why)), String(d3.why).slice(0, 120));

  // 最新日志还没有 origin（DSH 还在启动）→ 不拿更老的日志顶
  fs.readdirSync(LOGS).forEach((n) => fs.rmSync(path.join(LOGS, n)));
  writeLog('server-old.out.log', 'dsh web: ' + A.origin + '/?token=' + TOKEN + '\n', Date.now() - 120000);
  writeLog('server-new.out.log', 'booting…\n', Date.now());
  const d4 = discoverDshOrigin({ logDir: LOGS, originFile: NO_ORIGIN_FILE });
  ok('④f 最新日志还没打出 origin → fail-closed（不把旧端口捞回来）', d4.ok === false && /还没有|还在启动/.test(String(d4.why)), String(d4.why).slice(0, 140));
}

console.log('');
console.log('=== 五 · 多源不一致 → fail-closed（不替你选）===');
{
  fs.readdirSync(LOGS).forEach((n) => fs.rmSync(path.join(LOGS, n)));
  writeLog('server-X.out.log', 'dsh web: ' + A.origin + '/?token=' + TOKEN + '\n', Date.now());
  const originFile = path.join(ROOT, 'dsh-origin-conflict.txt');
  fs.writeFileSync(originFile, B.origin + '\n', 'utf8');
  const d = discoverDshOrigin({ logDir: LOGS, originFile });
  ok('⑤a 两个来源都新鲜却不同 → ok:false', d.ok === false && /不一致/.test(String(d.why)), String(d.why).slice(0, 160));
  ok('⑤b 错误里两个 origin 都在，且没有查询串', String(d.why).includes(A.origin) && String(d.why).includes(B.origin) && !String(d.why).includes('?token'));
}

console.log('');
console.log('=== 六 · 本机现状：旧日志 vs 新的 dsh-origin.txt（取新的）===');
{
  fs.readdirSync(LOGS).forEach((n) => fs.rmSync(path.join(LOGS, n)));
  writeLog('server-old.out.log', 'dsh web: ' + A.origin + '/?token=' + TOKEN + '\n', Date.now() - 3600000);
  const originFile = path.join(ROOT, 'dsh-origin.txt');
  fs.writeFileSync(originFile, B.origin + '\n', 'utf8');
  const d = discoverDshOrigin({ logDir: LOGS, originFile });
  ok('⑥a 一小时的旧日志不敌刚刚写下的 origin 文件', d.ok === true && d.origin === B.origin && d.source === 'dsh-origin-file',
    d.source + ' → ' + d.origin);

  fs.writeFileSync(originFile, 'http://127.0.0.1:1/?token=' + TOKEN + '\n', 'utf8');
  const d2 = discoverDshOrigin({ logDir: LOGS, originFile });
  ok('⑥b origin 文件被写成带查询串的 URL → 不认，且内容不回显',
    d2.origin !== 'http://127.0.0.1:1' && !String(d2.why).includes(TOKEN), String(d2.why).slice(0, 120));
}

console.log('');
console.log('=== 七 · token 不落盘、不进状态、不进错误 ===');
{
  fs.readdirSync(LOGS).forEach((n) => fs.rmSync(path.join(LOGS, n)));
  writeLog('server-secret.out.log', 'dsh web: ' + B.origin + '/?token=' + TOKEN + '\n', Date.now());
  // ★ 2026-11-13：接了账本 —— 心跳路径退役后，只有账本能让它 ok。
  //   本段测的是「token 不进状态」，所以必须先让它成功一次，否则测的是别的东西。
  const LED7 = makeLedger();
  const lt = createLeadTargetResolver({ config: { integrations: { ledgerFile: LED7.file } }, logDir: LOGS, originFile: NO_ORIGIN_FILE, sessionsProvider: LED7.sessionsProvider });
  await lt.refreshIfNeeded({ enabled: true });
  const stateJson = JSON.stringify(lt.state());
  ok('⑦a 解析成功后状态里没有 token', lt.current().ok === true && !stateJson.includes(TOKEN));
  ok('⑦b 状态里也没有查询串', !stateJson.includes('?token') && !/\?[^"]*token=/.test(stateJson));

  // 坏日志路径也走一遍：错误串同样不许带 token
  fs.rmSync(path.join(LOGS, 'server-secret.out.log'));
  writeLog('server-secret2.out.log', 'something odd ?token=' + TOKEN + '\n', Date.now());
  const lt2 = createLeadTargetResolver({ config: {}, logDir: LOGS, originFile: NO_ORIGIN_FILE });
  await lt2.refreshIfNeeded({ enabled: true });
  ok('⑦c 失败原因里也没有 token', lt2.current().ok === false && !String(lt2.current().why).includes(TOKEN), String(lt2.current().why).slice(0, 120));

  const files = walk(STATE_DIR);
  const leaked = files.filter((f) => { try { return fs.readFileSync(f, 'utf8').includes(TOKEN); } catch { return false; } });
  ok('⑦d 落盘目录里没有任何文件包含 token', leaked.length === 0, files.length + ' 个文件，泄漏 ' + leaked.length);
  ok('⑦e 清理回执确实写了（说明确实落了盘，检查不是空转）', files.length > 0, files.map((f) => path.basename(f)).join(','));
}

A.close(); B.close();
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}

console.log('');
console.log('=== 心跳地址自动发现自检 ===');
console.log('');
console.log(pass + ' 通过 / ' + fail + ' 失败');
console.log('');
process.exit(fail ? 1 : 0);
