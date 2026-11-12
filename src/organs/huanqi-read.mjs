// 换气读模型 —— 两把尺子各报各的，谁也不冒充谁。
//
// ★★ 这个文件存在的理由（2026-11-10 三项死读数修复之一）：
//   状态台（web/status-data.mjs）与器官卡（web/server.mjs /api/organs）**以前各读各的**，
//   一个读 `loop.__huanqiByRound`（全库没有一处赋值 → 空 Map），另一个也读它、
//   却取 `d.streak`（判定器上根本没有这个字段，真实字段叫 `stalled`）→ 恒为 0，
//   于是界面上长期写着「0 / 3」。**0 和「没有人在换气观测里」在界面上必须长得不一样。**
//   所以判定逻辑收进这里一处，两个调用方都问它 —— 这个项目反复付代价的形状就是「两张图各算各的」。
//
// ── 两把尺子 ────────────────────────────────────────────────────────
//
// ① 本进程（agent-soul 自己的换气器官）
//    src/index.mjs 的 huanqiByRound 是 Map<sessionId, HuanqiDetector>；
//    HuanqiDetector 的真实字段（organs/huanqi.mjs:129-178）：
//      stalled / stallThreshold / history[] / lastGrams
//    含义：stalled = **连续几次没产出**；stallThreshold = **熔断阈值**（到就 breakTurn）。
//    ★ 这里**没有 credit** —— credit 是 DSH 侧 dsh-huanqi 插件的口径，不在这一把尺子上。
//      把两者硬凑成一个数，等于用两把尺子量一次长度。
//
// ② DSH 侧（dsh-huanqi 插件落盘的账本）
//    <DSH_HOME>/state/dsh-huanqi.json     → credit / creditMax / stats.circuitBreaks …
//    <DSH_HOME>/state/huanqi-turns.jsonl  → 每回合一行：credit / creditMax / verdict / hadOutput
//    出处（读源码查实，不是猜）：
//      D:\AI\dsh-tools\dsh-huanqi\src\index.ts:1309-1314  CreditLedger.defaultPath()
//      D:\AI\dsh-tools\dsh-huanqi\src\index.ts:2171       turnsFile = join(stateDir,'huanqi-turns.jsonl')
//      D:\AI\dsh-tools\dsh-huanqi\src\index.ts:3846+      诊断行写入 credit/creditMax/verdict
//    ★ 两个文件都可能不存在（插件没装 / DSH_HOME 不是这个）→ **无读数 + 原因**，绝不写 0。
//
// ── 纪律 ──────────────────────────────────────────────────────────────
//   · 不做任何字符估算（这是「读数」，不是「大概」）。
//   · 不写任何文件；只 stat / 读尾部。
//   · 读不到就是 null + why，「0」只允许出现在**真的读到 0** 的时候。

import fs from 'node:fs';
import path from 'node:path';
import { devPathOr } from '../config.mjs';

/** 尾部读多少字节找最后一行 —— 单行实测 < 4KB，64KB 是给 diag 段留的余量。 */
const TAIL_BYTES = 64 * 1024;

function statOf(f) { try { return fs.statSync(f); } catch { return null; } }

/** 读文件尾部的最后一条可解析 JSON 行（长行可能被切半，往前找）。 */
export function readTailJsonLine(file, bytes) {
  const st = statOf(file);
  if (!st) return { err: '文件不存在：' + file };
  const len = Math.min(bytes || TAIL_BYTES, st.size);
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (e) { return { err: '打不开：' + String((e && e.message) || e) }; }
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const s = lines[i].trim();
      if (!s.startsWith('{')) continue;      // 第一行常被切半
      try { return { rec: JSON.parse(s), size: st.size, mtimeMs: st.mtimeMs }; } catch { continue; }
    }
    return { err: '尾部 ' + len + ' 字节里没有可解析的 JSON 行' };
  } finally {
    try { fs.closeSync(fd); } catch { /* 关不掉就算了 */ }
  }
}

/**
 * ① 本进程的换气判定表。
 * @param {Map} map  loop.__huanqiByRound（可能不存在）
 * @returns {{ok:boolean, sessions:number, unreadable:number, worst:object|null, atMs:number, why:string|null, rows:Array}}
 */
export function readDetectorMap(map) {
  const out = {
    ok: false, ruler: '本进程 loop.__huanqiByRound（HuanqiDetector.stalled）',
    sessions: 0, unreadable: 0, worst: null, atMs: Date.now(), why: null, rows: [],
  };
  if (!map || typeof map[Symbol.iterator] !== 'function') {
    out.why = '进程里没有换气判定表（loop.__huanqiByRound 未挂载）';
    return out;
  }
  for (const [sid, d] of map) {
    const stalled = d && Number.isFinite(d.stalled) ? d.stalled : null;
    const threshold = d && Number.isFinite(d.stallThreshold) ? d.stallThreshold : null;
    const hist = d && Array.isArray(d.history) ? d.history : null;
    const last = hist && hist.length ? hist[hist.length - 1] : null;
    out.rows.push({
      sid: String(sid || '').slice(0, 64),
      stalled, threshold,
      observed: hist ? hist.length : null,
      lastAt: last && Number.isFinite(last.at) ? last.at : null,
      lastReason: last ? (last.reason || null) : null,
    });
    if (stalled === null) out.unreadable++;
  }
  out.sessions = out.rows.length;
  const readable = out.rows.filter((r) => r.stalled !== null);
  if (!readable.length) {
    out.why = out.rows.length
      ? '判定表里 ' + out.rows.length + ' 个条目都没有 stalled 字段（字段名对不上）'
      : '判定表是空的：本进程还没有任何会话进入换气观测';
    return out;
  }
  readable.sort((a, b) => (b.stalled - a.stalled) || (b.observed || 0) - (a.observed || 0));
  out.worst = readable[0];
  out.ok = true;
  return out;
}

/**
 * ② DSH 侧 dsh-huanqi 的额度账本 + 最近一回合。
 * @param {{dshHome?:string}} opts
 */
export function readDshHuanqi(opts) {
  const o = opts || {};
  const home = o.dshHome || process.env.DSH_HOME || devPathOr('dshHome', null);
  const out = {
    ok: false, ruler: 'DSH 侧 dsh-huanqi 账本（credit/creditMax）',
    dshHome: home || null, ledgerFile: null, ledgerMtimeMs: null,
    turnsFile: null, turnsMtimeMs: null, turnsBytes: null,
    credit: null, creditMax: null, normalTurns: null, turnsSinceOutput: null,
    lastAnomalyAt: null, stats: null, lastTurn: null, why: null,
  };
  if (!home) {
    out.why = '没有 DSH_HOME（config.mjs 的开发默认也不存在）→ 读不到 dsh-huanqi 账本';
    return out;
  }
  const dir = path.join(home, 'state');
  const ledgerFile = path.join(dir, 'dsh-huanqi.json');
  const turnsFile = path.join(dir, 'huanqi-turns.jsonl');
  out.ledgerFile = ledgerFile;
  out.turnsFile = turnsFile;

  const lf = statOf(ledgerFile);
  if (!lf) {
    out.why = '账本不存在：' + ledgerFile + '（dsh-huanqi 插件没装，或 DSH_HOME 不是这个）';
    return out;
  }
  out.ledgerMtimeMs = lf.mtimeMs;
  let j = null;
  try { j = JSON.parse(fs.readFileSync(ledgerFile, 'utf8')); }
  catch (e) { out.why = '账本解析失败：' + String((e && e.message) || e); return out; }
  if (!j || typeof j !== 'object') { out.why = '账本不是对象：' + ledgerFile; return out; }

  const credit = Number(j.credit), max = Number(j.creditMax);
  if (!Number.isFinite(credit)) { out.why = '账本里 credit 不是数字（字段名可能变了）'; return out; }
  out.credit = credit;
  out.creditMax = Number.isFinite(max) ? max : null;
  out.normalTurns = Number.isFinite(Number(j.normalTurns)) ? Number(j.normalTurns) : null;
  out.turnsSinceOutput = Number.isFinite(Number(j.turnsSinceOutput)) ? Number(j.turnsSinceOutput) : null;
  out.lastAnomalyAt = Number.isFinite(Number(j.lastAnomalyAt)) ? Number(j.lastAnomalyAt) : null;
  out.stats = j.stats && typeof j.stats === 'object' ? {
    continuations: Number.isFinite(Number(j.stats.continuations)) ? Number(j.stats.continuations) : null,
    circuitBreaks: Number.isFinite(Number(j.stats.circuitBreaks)) ? Number(j.stats.circuitBreaks) : null,
    anomalies: Number.isFinite(Number(j.stats.anomalies)) ? Number(j.stats.anomalies) : null,
  } : null;

  // 最近一回合：turns 只是「最近一次观察」，读不到不影响账本读数
  const t = readTailJsonLine(turnsFile, TAIL_BYTES);
  if (t && t.rec) {
    out.turnsMtimeMs = t.mtimeMs;
    out.turnsBytes = t.size;
    out.lastTurn = {
      t: t.rec.t || null, sid: t.rec.sid ? String(t.rec.sid).slice(0, 64) : null,
      kind: t.rec.kind || null, hadOutput: t.rec.hadOutput === true,
      credit: Number.isFinite(Number(t.rec.credit)) ? Number(t.rec.credit) : null,
      creditMax: Number.isFinite(Number(t.rec.creditMax)) ? Number(t.rec.creditMax) : null,
      verdict: t.rec.verdict ? String(t.rec.verdict).slice(0, 80) : null,
    };
  } else {
    out.turnsWhy = t && t.err ? t.err : '读不到 huanqi-turns.jsonl';
  }
  out.ok = true;
  return out;
}

/** 两把尺子一起拿。**不合并成一个数** —— 合了就没法判断该看哪一把。 */
export function readHuanqi(opts) {
  const o = opts || {};
  return {
    atMs: Date.now(),
    note: '两个来源语义不同：本进程报「连续无产出 / 熔断阈值」，DSH 报「换气额度 credit」。不要相加、不要互相校验。',
    agentSoul: readDetectorMap(o.map),
    dsh: readDshHuanqi(o),
  };
}

/** 器官卡（/api/organs 的 ① 换气）。★ 与状态台共用 readHuanqi —— 一处实现。 */
export function huanqiCard(snap) {
  const s = snap || readHuanqi({});
  const a = s.agentSoul, d = s.dsh;
  if (!a.ok && !d.ok) {
    return { name: '换气', key: 'huanqi', value: '—', note: '无读数：' + (a.why || '') + (d.why ? ' / ' + d.why : ''), level: 'warn' };
  }
  const parts = [];
  let value = '—', level = 'ok';
  if (a.ok) {
    const w = a.worst;
    const th = w.threshold === null ? '?' : w.threshold;
    value = w.stalled + ' / ' + th;
    parts.push('最紧的是 ' + String(w.sid || '').slice(0, 12) + '（连续 ' + w.stalled + ' 次没产出，熔断阈值 ' + th + '；观测 ' + (w.observed === null ? '?' : w.observed) + ' 次）');
    if (w.threshold !== null && w.stalled >= w.threshold) level = 'bad';
    else if (w.threshold !== null && w.stalled >= w.threshold - 1) level = 'warn';
  } else {
    parts.push('本进程：' + a.why);
  }
  if (d.ok) {
    parts.push('DSH 额度 ' + d.credit + '/' + (d.creditMax === null ? '?' : d.creditMax)
      + (d.stats && d.stats.circuitBreaks !== null ? ' · 累计熔断 ' + d.stats.circuitBreaks + ' 次' : '')
      + (d.lastTurn && d.lastTurn.verdict ? ' · 最近 ' + d.lastTurn.verdict : '') + '（' + d.ledgerFile + '）');
  } else {
    parts.push('DSH：' + d.why);
  }
  return { name: '换气', key: 'huanqi', value, note: parts.join('；'), level };
}
