// 三项死读数修复 · 隔离夹具（无生产配置、无生产数据写入、不启服务）
//
// 用法：
//   node tools/status-three-readings-selftest.mjs
//
// ★★ 它证明什么（每条都对应交接里的一条要求）：
//   ① 换气：无读数时**给原因**，不出现「0 / 3」；有真值时读的是 stalled / stallThreshold；
//      DSH 侧读的是 dsh-huanqi 账本里的 credit / creditMax（真数据，不是估算）。
//   ② 台账：合成台账里各 stage / decision / charter 都数对；四视图与 waker.viewsOf 同一实现；
//      全文件扫描（重复 key、非法 stage 都要显出来）；文件不在 → 无读数 + 原因。
//   ③ 自主：配置快照与运行时判定分开；**时间不同 → snapshot-stale（不叫冲突）**；
//      同一时点仍相反 → conflict + 原因；一致 → agree。
//   ④ 只读：Ledger 的 readOnly 实例拒绝 ingest/decide，且文件 hash 字节不变。
//   ⑤ 真实台账：只读核对总数与状态计数，前后 hash / mtime / bytes 必须一致。
//
// ★ 夹具全部在系统临时目录里建，跑完删掉并断言删干净 —— **不碰生产 data、不读生产 config.json**。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { readHuanqi, readDetectorMap, readDshHuanqi, huanqiCard } from '../src/organs/huanqi-read.mjs';
import { readWakerLedger, readWakerDelivered, wakerCard } from '../src/organs/waker-read.mjs';
import { readVitalLayer, readEventsLayer, gatherStatus } from '../src/web/status-data.mjs';
import { Ledger } from '../src/organs/waker.mjs';

const REAL_LEDGER = 'D:\\AI\\yanqing-soul\\30-状态\\lead-waker-台账.json';

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) { pass++; console.log('[PASS] ' + name); }
  else { fail++; failures.push(name); console.log('[FAIL] ' + name + (detail === undefined ? '' : '  →  ' + JSON.stringify(detail))); }
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const mk = (...p) => { fs.mkdirSync(path.join(...p), { recursive: true }); return path.join(...p); };
const write = (f, obj) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1), 'utf8'); };
const core = () => ({ pid: 1, startedAtMs: Date.now() - 60000, configMtimeMs: null, uptimeSec: 60, node: process.version, rssMB: 1 });

const TMP = path.join(os.tmpdir(), 'agent-soul-three-readings-' + process.pid + '-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
console.log('夹具目录: ' + TMP);

// ── A · 换气：无读数 ──────────────────────────────────────────────────
{
  const snap = readHuanqi({ map: undefined, dshHome: path.join(TMP, 'no-such-dsh') });
  ok(snap.agentSoul.ok === false, 'A1 判定表未挂载 → agentSoul.ok=false');
  ok(typeof snap.agentSoul.why === 'string' && snap.agentSoul.why.length > 0, 'A2 无读数带原因', snap.agentSoul.why);
  ok(snap.dsh.ok === false && typeof snap.dsh.why === 'string', 'A3 DSH 账本不存在 → 无读数 + 原因', snap.dsh.why);
  const card = huanqiCard(snap);
  ok(card.value === '—', 'A4 器官卡 value 是「—」而不是 0/3', card.value);
  ok(!/0\s*\/\s*3/.test(card.value + ' ' + card.note), 'A5 卡上不出现「0 / 3」', card.value + ' | ' + card.note);
  ok(card.level === 'warn', 'A6 无读数时 level=warn（未知 ≠ ok）', card.level);
}

// ── B · 换气：真值（本进程 + DSH 账本）────────────────────────────────
{
  const now = Date.now();
  // ★ 旧 bug 的形状：字段叫 streak。这里显式放一个只有 streak 的旧对象，必须报「字段不认识」，不能报 0。
  const legacy = readDetectorMap(new Map([['session-legacy', { streak: 2, stallThreshold: 3 }]]));
  ok(legacy.ok === false && legacy.unreadable === 1, 'B1 只有 streak 的旧对象 → 无读数（不是 0）', legacy.why);
  ok(huanqiCard(readHuanqi({ map: new Map([['s', { streak: 2 }]]) })).value === '—', 'B2 旧字段 → 卡上仍是「—」');

  const map = new Map([
    ['session-aaaa1111', { stalled: 2, stallThreshold: 3, history: [{ at: now - 1000, reason: 'reasoning-only' }, { at: now, reason: 'reasoning-only' }] }],
    ['session-bbbb2222', { stalled: 0, stallThreshold: 3, history: [{ at: now, reason: null }] }],
  ]);
  const dm = readDetectorMap(map);
  ok(dm.ok && dm.sessions === 2 && dm.worst.sid === 'session-aaaa1111', 'B3 取「最紧」的那条会话');
  ok(dm.worst.stalled === 2 && dm.worst.threshold === 3 && dm.worst.observed === 2, 'B4 读数 = stalled 2 / 阈值 3 / 观测 2 次');

  const dsh = path.join(TMP, 'dsh-home');
  write(path.join(dsh, 'state', 'dsh-huanqi.json'), { credit: 4, creditMax: 6, normalTurns: 1, turnsSinceOutput: 0, stats: { continuations: 439, circuitBreaks: 124, anomalies: 438 }, lastAnomalyAt: now - 5000 });
  write(path.join(dsh, 'state', 'huanqi-turns.jsonl'), [
    JSON.stringify({ t: '2026-11-10T04:04:47.999Z', sid: 'session-1', kind: 'completed', hadOutput: true, credit: 6, creditMax: 6, verdict: 'skip:had-output' }),
    JSON.stringify({ t: '2026-11-10T04:05:57.212Z', sid: 'session-2', kind: 'completed', hadOutput: true, credit: 5, creditMax: 6, verdict: 'skip:had-output' }),
    JSON.stringify({ t: '2026-11-10T04:06:57.212Z', sid: 'session-2', kind: 'empty', hadOutput: false, credit: 4, creditMax: 6, verdict: 'continue:credit=4' }),
  ].join('\n') + '\n');
  const dh = readDshHuanqi({ dshHome: dsh });
  ok(dh.ok && dh.credit === 4 && dh.creditMax === 6, 'B5 DSH 账本 credit 4/6 读到', { credit: dh.credit, max: dh.creditMax });
  ok(dh.stats && dh.stats.circuitBreaks === 124, 'B6 累计熔断次数读到（124）', dh.stats);
  ok(dh.lastTurn && dh.lastTurn.verdict === 'continue:credit=4' && dh.lastTurn.sid === 'session-2', 'B7 最近一回合取的是**最后一行**', dh.lastTurn);

  const card = huanqiCard(readHuanqi({ map, dshHome: dsh }));
  ok(card.value === '2 / 3', 'B8 换气卡 = 「2 / 3」（真实字段，不是常量）', card.value);
  ok(/DSH 额度 4\/6/.test(card.note), 'B9 卡上带 DSH 额度 4/6', card.note);
  ok(card.level === 'warn', 'B10 stalled 2 ≥ 阈值3-1 → warn', card.level);
}

// ── C/D/E · 自主：三种关系 ────────────────────────────────────────────
const dataDir = mk(TMP, 'data');
const today = new Date().toISOString().slice(0, 10);
write(path.join(dataDir, 'autonomy.json'), { runsToday: 3, runsTodayDate: today, lastAutonomousAt: new Date().toISOString() });
const stub = (enabled, configAtMs) => ({
  config: { enabled, idleThresholdMinutes: 15, maxRunsPerDay: 24, ignoreSessions: [] },
  configAtMs,
  state: { runsToday: 3, runsTodayDate: today },
  check: () => ({ phase: enabled ? 'idle' : 'disabled', reason: enabled ? '他 3 分钟前还在，静息中' : '总开关关闭', idle: { ok: true, minutes: 3 } }),
});
const vitality = (autonomy, configFile) => readVitalLayer({
  autonomy, loop: undefined, config: { dataDir },
  opts: { core: core(), configFile, dshHome: path.join(TMP, 'no-such-dsh') },
});
const itemOf = (layer, label) => (layer.items || []).find((x) => String(x.label).indexOf(label) === 0);

{
  // C · 时间不同：配置在「快照之后」被改过 → 不许叫冲突
  const cfgFile = path.join(TMP, 'cfg-stale.json');
  write(cfgFile, { autonomy: { enabled: false, idleThresholdMinutes: 15 } });
  const at = Date.now() - 10 * 60 * 1000;
  const v = vitality(stub(true, at), cfgFile);
  ok(v.data.agreement.status === 'snapshot-stale', 'C1 快照晚于进程读配置 → snapshot-stale（不是冲突）', v.data.agreement);
  ok(v.data.conflict === null, 'C2 snapshot-stale 时 data.conflict 为 null');
  const it = itemOf(v, '两个来源');
  ok(it && it.value === '快照落后（不是冲突）' && /配置在进程读它之后被改过/.test(it.sub || ''), 'C3 文案写清「是时间差」', it);
  ok(/snapshot-stale/.test(JSON.stringify(v.data.agreement)) && /mtime/.test(v.data.agreement.why), 'C4 原因里带两个时间戳', v.data.agreement.why);
}
{
  // D · 同一时点仍相反 → 才是冲突，并且要给出原因
  const cfgFile = path.join(TMP, 'cfg-conflict.json');
  write(cfgFile, { autonomy: { enabled: false, idleThresholdMinutes: 15 } });
  const past = Date.now() - 60 * 60 * 1000;
  fs.utimesSync(cfgFile, past / 1000, past / 1000);            // 配置比快照还旧
  const v = vitality(stub(true, Date.now() - 10 * 60 * 1000), cfgFile);
  ok(v.data.agreement.status === 'conflict', 'D1 同一时点仍相反 → conflict', v.data.agreement);
  ok(v.data.conflict && /同一时点的配置给出相反结论/.test(v.data.conflict.why), 'D2 冲突给原因（不是只说「不一致」）', v.data.conflict);
  const it = itemOf(v, '两个来源');
  ok(it && it.bad === true && /环境变量/.test(it.sub || ''), 'D3 冲突行标红并指向排查方向', it);
}
{
  // E · 一致
  const cfgFile = path.join(TMP, 'cfg-agree.json');
  write(cfgFile, { autonomy: { enabled: true, idleThresholdMinutes: 15 } });
  const v = vitality(stub(true, Date.now() - 10 * 60 * 1000), cfgFile);
  ok(v.data.agreement.status === 'agree', 'E1 两边都开 → agree', v.data.agreement);
  const it = itemOf(v, '两个来源');
  ok(it && it.value === '一致' && !it.bad, 'E2 一致的行不标红', it);
  ok(!!itemOf(v, '自主（运行时判定）') && !!itemOf(v, '自主（配置快照）') && !!itemOf(v, '自主（磁盘配置）'), 'E3 三个时点各占一行');
  ok(itemOf(v, '换气（本进程）').na === true && itemOf(v, '换气（DSH 额度）').na === true, 'E4 没给换气源 → 两行都是无读数（不是 0）');
  ok(v.level === 'warn', 'E5 有读不到的东西时 level=warn', v.level);
}
{
  // F · 旧进程没有 configAtMs → 不猜
  const cfgFile = path.join(TMP, 'cfg-old.json');
  write(cfgFile, { autonomy: { enabled: false } });
  const s = stub(true, undefined);
  const v = vitality(s, cfgFile);
  ok(v.data.agreement.status === 'unknown-time', 'F1 缺 configAtMs → unknown-time（不判冲突）', v.data.agreement);
}

// ── G · 台账：合成一本，四种视图 + 非法值 + 重复 key ──────────────────
{
  const stDir = mk(TMP, 'status');
  const ev = (o) => Object.assign({ key: 'k', t: '2026-11-10T00:00:00.000Z', title: 't', from: 'f', tier: 'act', stage: 'pending', wakeCount: 0, wokenAt: null, decision: null, charter: 'unchecked', charterNote: '', decidedAt: null, note: '', fromSession: '' }, o);
  const events = [
    ev({ key: 'k1', stage: 'woken', decision: null, charter: 'unchecked' }),          // 要你执行
    ev({ key: 'k2', stage: 'done', decision: 'resume', charter: 'pass' }),             // 已执行 + 自定
    ev({ key: 'k3', stage: 'held', decision: 'hold', charter: 'pass' }),               // 自定
    ev({ key: 'k4', stage: 'auditing', decision: 'audit', charter: 'unchecked' }),     // 待审计
    ev({ key: 'k5', stage: 'stuck', decision: null, charter: 'unchecked' }),           // 待审计（叫不醒）
    ev({ key: 'k6', stage: 'pending', decision: null, charter: 'ask' }),               // 待审计（ask）
    ev({ key: 'k6', stage: 'pending', decision: null, charter: 'ask' }),               // 重复 key
    ev({ key: 'k7', stage: 'weird', decision: null, charter: 'unchecked' }),           // 非法 stage
  ];
  write(path.join(stDir, 'lead-waker-台账.json'), { version: 1, updatedAt: '2026-11-10T00:00:00.000Z', events });
  const L = readEventsLayer({ config: { dataDir, soul: { root: path.join(TMP, 'soul') } }, opts: { core: core(), statusDir: stDir } });
  ok(L.data.ok && L.data.total === 8, 'G1 总数按全文件扫描（8 条，含重复）', L.data.total);
  ok(L.data.counts.act === 1, 'G2 要你执行 = 1', L.data.counts);
  ok(L.data.counts.done === 1, 'G3 已执行（decision=resume）= 1', L.data.counts);
  // ★ 4 条而不是 3：k6 在数组里出现两次（重复 key）。**行计数按数组数**，
  //   只有「未处理」那个合计数按 key 去重 —— 两个数回答两个问题，别互相冒充。
  ok(L.data.counts.audit === 4, 'G4 待审计行 = 4（audit 1 + stuck 1 + ask 2，含重复 key 那一行）', L.data.counts);
  ok(L.data.counts.auto === 2, 'G5 自定（有 decision 且 charter=pass）= 2', L.data.counts);
  ok(L.data.stages.weird === 1 && L.data.unknownStage === 1, 'G6 非法 stage 原样显示、单独计数', { stages: L.data.stages, unknown: L.data.unknownStage });
  ok(L.data.duplicateKeys === 1, 'G7 重复 key 数得出来（不静默去重）', L.data.duplicateKeys);
  ok(L.data.stages.done === 1 && L.data.stages.held === 1, 'G8 stage 分布按原值计数（done 1 / held 1）', L.data.stages);
  ok(L.data.mtimeMs > 0 && /lead-waker-台账\.json$/.test(L.data.ledgerFile), 'G9 读数带源路径 + mtime', { file: L.data.ledgerFile, mtime: L.data.mtimeMs });
  ok(/只读/.test(L.note) && /不迁移/.test(L.note), 'G10 note 明说只读、不迁移');
  ok(wakerCard(readWakerLedger({ file: path.join(stDir, 'lead-waker-台账.json') })).value === '4 未处理', 'G11 器官卡「未处理」= act ∪ audit（按 key 去重）= 4');
}
{
  // H · 台账文件不存在 → 无读数 + 原因，不是 0
  const L = readEventsLayer({ config: { dataDir }, opts: { core: core(), statusDir: path.join(TMP, 'empty-status') } });
  const it = (L.items || []).find((x) => String(x.label).indexOf('事件台账') === 0);
  ok(it && it.na === true && /不存在/.test(it.why || ''), 'H1 文件不在 → 无读数 + 原因', it);
  ok(L.level === 'error', 'H2 读不到台账时整层 error（不是 ok）', L.level);
}

// ── I · 只读闸：Ledger(readOnly) 拒绝写 ──────────────────────────────
{
  const f = path.join(TMP, 'ro-ledger.json');
  write(f, { version: 1, events: [{ key: 'x', stage: 'pending' }] });
  const h0 = sha(f), m0 = fs.statSync(f).mtimeMs;
  const L = new Ledger(f, { readOnly: true });
  const r1 = L.ingest({ key: 'y', title: 'nope' });
  const r2 = L.decide('x', { decision: 'resume' });
  const r3 = L.markWoken('x');
  ok(r1.ok === false && r2.ok === false && r3.ok === false, 'I1 只读实例三种写都被拒', [r1.err, r2.err, r3.err]);
  ok(sha(f) === h0 && fs.statSync(f).mtimeMs === m0, 'I2 只读实例跑完，文件 hash / mtime 一字未动');
}

// ── J · 真实台账：只读核对（不复制、不改写）───────────────────────────
{
  if (!fs.existsSync(REAL_LEDGER)) {
    console.log('[SKIP] J 真实台账不在本机：' + REAL_LEDGER);
  } else {
    const h0 = sha(REAL_LEDGER), s0 = fs.statSync(REAL_LEDGER);
    const raw = JSON.parse(fs.readFileSync(REAL_LEDGER, 'utf8'));
    const evs = Array.isArray(raw) ? raw : raw.events || [];
    const recount = { total: evs.length, done: 0, held: 0, pending: 0, woken: 0, pass: 0, ask: 0, unchecked: 0 };
    for (const e of evs) {
      if (e.decision === 'resume') recount.done++;
      if (e.decision === 'hold') recount.held++;
      if (e.stage === 'pending') recount.pending++;
      if (e.stage === 'woken') recount.woken++;
      if (e.charter === 'pass') recount.pass++;
      if (e.charter === 'ask') recount.ask++;
      if (e.charter === 'unchecked') recount.unchecked++;
    }
    const led = readWakerLedger({ file: REAL_LEDGER });
    ok(led.ok, 'J1 真实台账读得出来', led.why);
    ok(led.total === recount.total, 'J2 总数与独立重数一致（' + recount.total + '）', { reader: led.total, recount: recount.total });
    ok((led.decisions.resume || 0) === recount.done && (led.decisions.hold || 0) === recount.held, 'J3 done/held 与独立重数一致', { reader: led.decisions, recount });
    ok((led.charters.pass || 0) === recount.pass && (led.charters.ask || 0) === recount.ask && (led.charters.unchecked || 0) === recount.unchecked, 'J4 charter 三项与独立重数一致', { reader: led.charters, recount });
    const h1 = sha(REAL_LEDGER), s1 = fs.statSync(REAL_LEDGER);
    ok(h0 === h1 && s0.mtimeMs === s1.mtimeMs && s0.size === s1.size, 'J5 读完 true 台账 hash / mtime / bytes 全未变');
    console.log('     真实台账: total=' + recount.total + ' · done=' + recount.done + ' · held=' + recount.held
      + ' · pending=' + recount.pending + ' · woken=' + recount.woken
      + ' · charter pass=' + recount.pass + '/ask=' + recount.ask + '/unchecked=' + recount.unchecked
      + ' · mtime=' + new Date(s0.mtimeMs).toISOString() + ' · ' + s0.size + 'B');
  }
}

// ── L · 端到端：gatherStatus 的六层都不许整层抛错 ────────────────────
{
  const stDir = mk(TMP, 'status-e2e');
  write(path.join(stDir, 'lead-waker-台账.json'), { version: 1, events: [
    { key: 'e1', t: '2026-11-10T01:00:00.000Z', title: '一条真事件', from: 'group:1', tier: 'act', stage: 'done', decision: 'resume', charter: 'pass' },
    { key: 'e2', t: '2026-11-10T02:00:00.000Z', title: '待审计', from: 'group:1', tier: 'watch', stage: 'auditing', decision: 'audit', charter: 'unchecked' },
  ] });
  const cfgFile = path.join(TMP, 'cfg-e2e.json');
  write(cfgFile, { autonomy: { enabled: false } });
  const g = await gatherStatus({
    config: { dataDir, soul: { root: mk(TMP, 'soul-e2e') }, statusDir: stDir, diary: { dir: path.join(TMP, 'diary') } },
    persona: null, tools: null,
    autonomy: stub(false, Date.now() - 1000),
    loop: { __huanqiByRound: new Map([['session-x', { stalled: 1, stallThreshold: 3, history: [] }]]) },
    configFile: cfgFile, dshHome: path.join(TMP, 'no-such-dsh'),
  });
  const errs = Object.entries(g.layers).filter(([, L]) => L && L.error).map(([k, L]) => k + ': ' + L.error);
  ok(errs.length === 0, 'L1 六层都没有整层抛错', errs);
  ok(g.layers.vital.level === 'warn' || g.layers.vital.level === 'ok', 'L2 vital 有 level', g.layers.vital.level);
  const hq = itemOf(g.layers.vital, '换气（本进程）');
  ok(hq && !hq.na && hq.value === '1 / 3', 'L3 端到端把真实的 stalled 带出来了（1 / 3）', hq);
  ok(g.layers.events.data.total === 2 && g.layers.events.data.counts.audit === 1, 'L4 端到端台账计数 = 2 条 / 待审计 1', g.layers.events.data.counts);
  ok(!!g.watermarks && !!g.provenance, 'L5 watermarks / provenance 仍在（没破坏原有形状）');
}

// ── 清理 ─────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });
ok(!fs.existsSync(TMP), 'K1 夹具目录已删除（不在磁盘上留第二份权威）', TMP);

console.log('');
console.log('=== 结果：' + pass + ' passed / ' + fail + ' failed ===');
if (fail) { console.log('失败项：' + failures.join(' | ')); process.exit(1); }
