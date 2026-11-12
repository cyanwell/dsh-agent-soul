// 回声哨兵自检（F 切片）—— 三态必须分得开，且**成功来自一次真的探测**
//
// ★ 这个自检替掉的是一行硬编码：
//     na('回声哨兵', '未运行：echo-doctor.mjs 是 CLI，没有路由 / MCP 工具 / 器官，也没落结果文件')
//   那句话把「不知道」写成了「没这个东西」。现在要证的是：
//     ① 没有结果 → UNKNOWN（说清「没跑过」），不是「健康」也不是「故障」；
//     ② 有结果但**探测失败** → 如实记 error、时刻、退出码/超时，state 仍是 unknown；
//     ③ 有结果且探测成功 → 真实 state（ok/warn/error）+ 总判 + 计数 + 延迟 + 时刻；
//     ④ 结果过期 → stale 标出来，不许冒充「现在」；
//     ⑤ 状态台（readOpsLayer）读的就是这个文件 —— 不是另算一份。
//
// ★ 中间那些假 doctor 只用来打靶解析/超时/坏输出这几个分支。
//   **真探测那一条（F2）跑的是本机真的 echo-doctor.mjs** —— 没有它，这个自检就只是自娱自乐。
//
// 跑法：node tools/echo-sentinel-selftest.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEchoSentinel, readEchoSentinel, parseDoctorJson, sentinelFileOf,
} from '../src/organs/echo-sentinel.mjs';
import { readOpsLayer } from '../src/web/status-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const REAL_DOCTOR = 'D:/AI/memory/hub/echo-doctor.mjs';

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')); } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')); } };

const TMP_ROOT = fs.realpathSync(os.tmpdir());
const DATA = fs.mkdtempSync(path.join(TMP_ROOT, 'agent-soul-echo-sentinel-'));
{
  const real = fs.realpathSync(DATA);
  const prod = (() => { try { return fs.realpathSync(path.join(ROOT, 'data')); } catch { return path.join(ROOT, 'data'); } })();
  if (!(real === TMP_ROOT || real.startsWith(TMP_ROOT + path.sep)) || real === prod || real.startsWith(prod + path.sep)) {
    throw new Error('临时目录不在 os.tmpdir() 下（或落进了生产 data/）：' + real);
  }
}
const FILE = sentinelFileOf(DATA);

const docDir = path.join(DATA, 'doctors');
fs.mkdirSync(docDir, { recursive: true });
function makeDoctor(name, body) {
  const f = path.join(docDir, name + '.mjs');
  fs.writeFileSync(f, body, 'utf8');
  return f;
}

const GOOD = makeDoctor('good', [
  'const report = { at: "2026-11-10 23:00:00", mode: "fast", overall: "warn",',
  '  counts: { error: 0, warn: 2, ok: 9, pending: 3 }, ms: 12,',
  '  checks: [ { id: "mo", label: "《墨》账本", status: "ok", detail: "747 条" },',
  '            { id: "hot", label: "L1 热记忆", status: "warn", detail: "MEMORY 92%" } ] };',
  'process.stdout.write("一些日志前缀\\n" + JSON.stringify(report));',
  'process.exit(0);',
].join('\n'));

const EXIT2 = makeDoctor('exit2', [
  'const report = { at: "2026-11-10 23:00:00", mode: "fast", overall: "error",',
  '  counts: { error: 1, warn: 4, ok: 7, pending: 3 }, ms: 20,',
  '  checks: [ { id: "mo", label: "《墨》账本", status: "error", detail: "读不出来" } ] };',
  'process.stdout.write(JSON.stringify(report));',
  'process.exit(2);   // ★ doctor 用「退出码 != 0」表示有 error —— 不是「体检器坏了」',
].join('\n'));

const BAD = makeDoctor('bad', 'process.stdout.write("not json at all"); process.exit(0);');
const SLOW = makeDoctor('slow', 'setTimeout(() => { process.stdout.write("{}"); }, 5000);');

console.log('临时数据 ' + DATA + '\n');
console.log('=== 回声哨兵自检（F）===');

// ── F1 没有结果 ────────────────────────────────────────────
{
  const none = readEchoSentinel({ dataDir: DATA });
  ok('F1a 没跑过 → ok:false / state=unknown（不是「健康」）', none.ok === false && none.state === 'unknown', none.why);
  ok('F1b 说清是「还没跑过」，不是「坏了」', /还没有|从未/.test(String(none.why)), none.why);

  const layer = readOpsLayer({ config: { dataDir: DATA }, core: core(), opts: { core: core() } });
  const item = (layer.items || []).find((x) => x.label === '回声哨兵');
  ok('F1c 状态台显示 UNKNOWN（na:true），文案带原因', !!item && item.na === true && /还没有|从未/.test(String(item.why)), item ? item.why : '(没这一项)');
}

// ── F2 **真实探测**（本机 echo-doctor.mjs）──────────────────
{
  if (!fs.existsSync(REAL_DOCTOR)) {
    ok('F2 真探测（跳过：本机没有 echo-doctor.mjs）', false, REAL_DOCTOR);
  } else {
    const s = createEchoSentinel({ dataDir: DATA, doctorPath: REAL_DOCTOR, timeoutMs: 60000 });
    const rec = await s.probe('selftest');
    ok('F2a 真探测跑通了（probe.ok）', rec.probe && rec.probe.ok === true, rec.probe ? ('code=' + rec.probe.exitCode + ' ' + (rec.probe.error || '')) : '(没有 probe)');
    ok('F2b state 是体检器的真实总判', ['ok', 'warn', 'error'].includes(rec.state), 'state=' + rec.state + ' overall=' + rec.overall + ' counts=' + JSON.stringify(rec.counts));
    ok('F2c 延迟与耗时都记了', Number.isFinite(rec.probe.latencyMs) && rec.probe.latencyMs > 0, rec.probe.latencyMs + 'ms（报告内 ' + rec.reportMs + 'ms）');
    ok('F2d 证据里有「哪份体检器、什么时候的」', rec.evidence && rec.evidence.doctorPath === REAL_DOCTOR && !!rec.evidence.doctorMtime, rec.evidence && rec.evidence.doctorMtime);
    ok('F2e 结果落在隔离 data 下（不碰生产记忆）', fs.existsSync(FILE) && fs.realpathSync(FILE).startsWith(fs.realpathSync(DATA)), FILE);
    ok('F2f fast 层：不深检（evidence.note 说明）', /fast/.test(String(rec.evidence && rec.evidence.note)) && rec.probe.mode === 'fast', String(rec.evidence && rec.evidence.note));

    const cur = readEchoSentinel({ dataDir: DATA });
    ok('F2g 读回来的 state/时间与写入一致', cur.ok === true && cur.state === rec.state && cur.at === rec.at && cur.stale === false, cur.at + ' state=' + cur.state);
  }
}

// ── F3 成功（ok/warn）+ 前缀噪声 ──────────────────────────
{
  const s = createEchoSentinel({ dataDir: DATA, doctorPath: GOOD });
  const rec = await s.probe('warn-branch');
  ok('F3a 有 JSON 混在日志里也能解析', rec.probe.ok === true && rec.state === 'warn', 'state=' + rec.state);
  ok('F3b counts / checks 原样带出来', rec.counts && rec.counts.warn === 2 && rec.checks.length === 2, JSON.stringify(rec.counts));
}

// ── F4 非零退出码 + 有 JSON = 体检结论，不是探测失败 ────────
{
  const s = createEchoSentinel({ dataDir: DATA, doctorPath: EXIT2 });
  const rec = await s.probe('exit2');
  ok('F4 退出码 2 且有 JSON → probe.ok=true，state=error', rec.probe.ok === true && rec.state === 'error' && rec.probe.exitCode === 2, 'exit=' + rec.probe.exitCode + ' state=' + rec.state);
}

// ── F5 输出不是 JSON → 探测失败，state 仍是 unknown ────────
{
  const s = createEchoSentinel({ dataDir: DATA, doctorPath: BAD });
  const rec = await s.probe('bad-json');
  ok('F5a 非 JSON → probe.ok=false（不静默当成功）', rec.probe.ok === false && rec.state === 'unknown', rec.probe.error);
  ok('F5b 失败原因带机器可读 code', rec.probe.code === 'BAD_JSON', rec.probe.code);
}

// ── F6 超时 → 杀子进程 + 如实记 ────────────────────────────
{
  const s = createEchoSentinel({ dataDir: DATA, doctorPath: SLOW, timeoutMs: 800 });
  const t0 = Date.now();
  const rec = await s.probe('timeout');
  const ms = Date.now() - t0;
  ok('F6a 超时 → probe.ok=false，timedOut=true', rec.probe.ok === false && rec.probe.timedOut === true, rec.probe.error);
  ok('F6b 真的被杀掉（800ms 超时后 ~1s 内返回，不是等 5s）', ms < 4000, ms + 'ms');
}

// ── F7 医生不存在 / F8 未配置 ─────────────────────────────
{
  const s1 = createEchoSentinel({ dataDir: DATA, doctorPath: path.join(DATA, 'nope.mjs') });
  const r1 = await s1.probe('missing');
  ok('F7 体检器不存在 → NOT_FOUND（不是「回声坏了」）', r1.probe.ok === false && r1.probe.code === 'NOT_FOUND', r1.probe.error);

  const s2 = createEchoSentinel({ dataDir: DATA, doctorPath: '' });
  const r2 = await s2.probe('unconfigured');
  ok('F8 没配 echoDoctorPath → UNCONFIGURED', r2.probe.ok === false && r2.probe.code === 'UNCONFIGURED', r2.probe.error);
}

// ── F9 过期 ────────────────────────────────────────────────
{
  const oldAt = new Date(Date.now() - 12 * 60 * 1000).toISOString();
  fs.writeFileSync(FILE, JSON.stringify({
    at: oldAt, state: 'ok', overall: 'ok', counts: { error: 0, warn: 0, ok: 10, pending: 2 },
    checks: [], probe: { ok: true, mode: 'fast', latencyMs: 2000, doctorPath: REAL_DOCTOR },
  }, null, 2), 'utf8');
  const cur = readEchoSentinel({ dataDir: DATA, ttlMs: 10 * 60 * 1000 });
  ok('F9a 12 分钟前的结果 → stale=true', cur.ok === true && cur.stale === true, cur.why);
  ok('F9b 过期的结果仍然给时刻与年龄（不隐藏）', cur.at === oldAt && cur.ageMs > 11 * 60 * 1000, cur.ageMs + 'ms');
}

// ── F10 状态台读的是同一份文件 ─────────────────────────────
{
  const layer = readOpsLayer({ config: { dataDir: DATA }, core: core(), opts: { core: core() } });
  const item = (layer.items || []).find((x) => x.label === '回声哨兵');
  ok('F10a 有结果时状态台显示真实 state', !!item && item.na !== true && item.value === 'OK', item ? item.value + ' · ' + item.sub : '(没这一项)');
  ok('F10b 带时刻与「已过期」标记', !!item && !!item.at && /过期/.test(String(item.sub)), item ? item.at + ' · ' + item.sub : '(没这一项)');
}

// ── F11 三态文案不同（同一函数，不同输入）──────────────────
{
  const probeFailFile = JSON.stringify({
    at: new Date().toISOString(), state: 'unknown', overall: null, counts: null, checks: [],
    probe: { ok: false, mode: 'fast', error: '探测超时（800ms，已杀掉子进程）', code: 'TIMEOUT' },
  }, null, 2);
  fs.writeFileSync(FILE, probeFailFile, 'utf8');
  const layer = readOpsLayer({ config: { dataDir: DATA }, core: core(), opts: { core: core() } });
  const item = (layer.items || []).find((x) => x.label === '回声哨兵');
  ok('F11 探测失败 → 显示「探测失败」而不是 UNKNOWN 也不显示成健康', !!item && item.na === true && /探测失败/.test(String(item.why)), item ? item.why : '(没这一项)');
}

// ── 收尾 ───────────────────────────────────────────────────
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}

console.log('');
console.log('────────────────────────────────────────────');
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);

function core() {
  return {
    pid: process.pid, startedAtMs: Date.now() - 60000, configFile: path.join(ROOT, 'config.json'),
    configMtimeMs: null, node: process.version, port: null, dataDir: DATA,
    rssMB: 1, uptimeSec: 60,
  };
}
