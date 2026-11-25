// 状态台的数据聚合 —— GET /api/status 的唯一实现。
//
// ★★ 这个文件存在的理由，是把「读数」和「画法」分开。
//   src/web/status.html 只负责画；这里只负责**如实拿到数**。
//   两边一旦混在一起，就会出现本项目反复付代价的那个形状：
//   **两张图各算各的，然后谁也不对。**
//
// ★★ 三条铁律（每一条都是踩出来的，不是风格）：
//   ① **读不到就是 null，绝不写 0。** 「0」和「文件不在」在界面上必须长得不一样，
//      否则一次静默失败会变成一个看起来很正常的读数。
//   ② **每层都带 provenance。** 进程可能跑着旧代码、配置可能在启动后被改过 ——
//      不标出「这是谁、什么时候、哪份快照算出来的」，图上的「好」可能来自几天前的进程。
//   ③ **分母逐会话读。** contextWindow 不是常数（实测 2397 个文件里 7 种值），
//      统一套 1048576 会把小窗口会话算成 5%、把大窗口算成 500%。
//
// ★ 这个模块**不启动任何东西、不写任何文件**，纯读。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normId } from '../organs/ledger.mjs';
import {
  appRoot, devPathOr,
  wakerLedgerFileOf, wakerDeliveredFileOf, diaryDirOf, skillsDirsOf,
} from '../config.mjs';
import { readHuanqi } from '../organs/huanqi-read.mjs';
import { readWakerLedger, readWakerDelivered } from '../organs/waker-read.mjs';
// ★ 2026-11-10（F 切片）：回声哨兵的真实结果 / 定点清理的回执 —— 都只读文件，**不在这里触发探测**。
import { readEchoSentinel } from '../organs/echo-sentinel.mjs';
import { readCleanupState } from '../organs/cleanup.mjs';
import { Diary } from './diary.mjs';
import { openMetaStore } from '../db/index.mjs';

// ── 0 · 常量与路径 ────────────────────────────────────────────────────

/** 活跃会话窗口。★ 30 分钟不是拍的：写入粒度是「步」，5 分钟会把跑长工具的活会话判死。 */
export const ACTIVE_WINDOW_MS = 30 * 60 * 1000;
/** stat 结果的内存 TTL。★ readdir 不带 mtime，stat 是唯一来源；全量 stat 约 300ms，不能每请求都做。 */
const STAT_TTL_MS = 20 * 1000;
/** 解析上限：projcache 单文件最大实测 319KB，2MB 是给异常留的闸。 */
const MAX_PARSE_BYTES = 2 * 1024 * 1024;
/** 最多解析几个 —— 30 分钟窗口实测 6–7 个，留余量。 */
const MAX_PARSE_FILES = 40;

// ★ 2026-11-10（R1）：开发机默认值收进 config.mjs 的 DEV_PATHS，且「目录存在才用」。
//   分发版这里落到 <安装根>/workspace/dsh-home —— 不读开发机上那个不存在的目录。
//   ★ 判据放在函数里（不是模块常量）：常量在 import 那一刻就固化了，等于把"这台机器有
//     D:/AI/dsh"这个事实写进进程 —— 正是 R1 要消灭的那种假设。
export function dshHomeOf(opts) {
  return String((opts && opts.dshHome) || process.env.DSH_HOME
    || devPathOr('dshHome', path.join(appRoot(), 'workspace', 'dsh-home')));
}
export function projcacheDirOf(opts) {
  return path.join(dshHomeOf(opts), 'storages', 'session_projcache', 'sessions');
}
function soulRootOf(config) {
  const own = config && config.soul && config.soul.root;
  if (own) return own;
  // ★ 2026-11-11：分发版（软件）没有 config.soul.root，而本机书房真的在 D:/AI/yanqing-soul。
  //   devPathOr 的判据是「目录存在才用」—— 开发机行为一字不变，装到别人机器上也不会瞎读。
  return devPathOr('soulRoot', null);
}
function ledgerFileOf(config) {
  const r = soulRootOf(config);
  if (r) return path.join(r, '02-墨.jsonl');
  if (config && config.ledger && config.ledger.file) return config.ledger.file;
  return null;
}
function configFileOf(opts) {
  return (opts && opts.configFile) || path.join(appRoot(), 'config.json');
}

// ── 1 · 小工具 ────────────────────────────────────────────────────────

function safeStat(f) { try { return fs.statSync(f); } catch { return null; } }
function safeJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function isDir(f) { try { return fs.statSync(f).isDirectory(); } catch { return false; } }

/** 百分比：一位小数。分母无效时返回 null —— 不是 0，是「算不出来」。 */
function pctOf(used, win) {
  const u = Number(used), w = Number(win);
  if (!Number.isFinite(u) || !Number.isFinite(w) || w <= 0) return null;
  return Math.round((u / w) * 1000) / 10;
}
/** 本地时分秒，用来在 provenance 里说人话。 */
function hm(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function mb(n) { return Math.round(n / 1048576 * 10) / 10; }

/** 一个「无读数」条目。★ value:null 是约定：页面见 null 就画「无读数」而不是 0。 */
function na(label, why, unit) {
  return { label, value: null, unit: unit || '', na: true, why: String(why || '读不到') };
}
function row(label, value, unit, extra) {
  if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) {
    return na(label, (extra && extra.why) || '读不到', unit);
  }
  return Object.assign({ label, value, unit: unit || '' }, extra || {});
}

// ── 2 · 核心元信息 ────────────────────────────────────────────────────

/**
 * 进程 + 配置快照。
 * ★ 为什么单列：本机踩过 —— core 22:44:49 启动，config.json 22:48 被改，
 *   于是 /api/organs 说「自主关闭」而 soul_autonomy 说「开」。**图上看不出哪个是旧的。**
 */
export function readCore(config, opts) {
  const now = Date.now();
  const startedAtMs = now - process.uptime() * 1000;
  const cf = configFileOf(opts);
  const st = safeStat(cf);
  const cfgMs = st ? st.mtimeMs : null;
  return {
    pid: process.pid,
    startedAtMs,
    startedAt: new Date(startedAtMs).toISOString(),
    uptimeSec: Math.round(process.uptime()),
    configFile: cf,
    configMtimeMs: cfgMs,
    configMtime: cfgMs ? new Date(cfgMs).toISOString() : null,
    // ★ 允许 2 秒容差：进程启动前那一刻本来就刚读过配置。
    configNewerThanBoot: cfgMs !== null && cfgMs > startedAtMs + 2000,
    node: process.version,
    port: (config && config.port) || null,
    dataDir: (config && config.dataDir) || null,
    rssMB: Math.round(process.memoryUsage().rss / 1048576),
  };
}

/** 出处那一行：pid / 启动 / 配置快照。每层都带 —— 防止「图上是好的，其实旧进程说的」。 */
export function coreTag(core) {
  return 'pid ' + core.pid + ' / core 启动 ' + hm(core.startedAtMs) +
    ' / 配置快照 ' + (core.configMtimeMs ? hm(core.configMtimeMs) : '无');
}

// ── 3 · 水位 ①：当前 lead 会话 ────────────────────────────────────────

/**
 * 读《墨》最后一条 lead 的署名（8 位），去 projcache 里找那个会话文件。
 *
 * ★ 为什么不拼路径：by 只有 8 位，且文件名有**两种拼写** ——
 *   顶层会话带 session- 前缀，子会话 / 具名 id 不带。两种都要试。
 * ★ 为什么 8 位够：实测 2397 个文件归成约 1900 个唯一 8 位 key，真会话没有碰撞
 *   （唯一共用的前缀是 clawbot-，它不是十六进制，按具名规则走）。
 */
export async function readLeadWater(config, opts) {
  const o = opts || {};
  const dir = projcacheDirOf(o);
  const out = { ok: false, pct: null, used: null, window: null, source: null, why: null };

  // ── ① 动态优先：先问「现在是哪一条 lead」 ─────────────────────────────
  // ★ 为什么不能只认账本（2026-11-11 爀曦指出）：lead 随交接换人，**会话 id 每次都变**。
  //   账本里最后一条 lead 的 8 位签名是**静态快照** —— 它答的是「谁最后写了账本」，
  //   不是「现在活着的主脑是谁」。心跳已经把这件事解对了（primarySessionId），
  //   所以这里复用同一个解析器（organs/lead-target.mjs），**不写第二套判据**。
  const dyn = await currentLeadId(config, o);
  // ★★★ 2026-11-13（第二批）：**state 命中就不用开文件。**
  //   判据：bridge 每轮推来的 state 里 sessionId 与当前 lead 是同一个 —— 那它就是那个会话的水位，
  //   contextTokens 与 projcache 的 pressureTokens 同源（都是 input + cacheRead）。
  //   ★ 省掉的是「读 projcache 目录 + 解析 1.6MB JSON」这两步，也就是最后一条能看见的 DSH 路径依赖。
  //   ★ 拿不到（state 里没 sessionId / 对不上 / 没 contextTokens）就**原样往下走**，
  //     不是「降级」，是「这条路这次不适用」—— 状态台原本的两条路都还在。
  if (dyn.ok && o.control && typeof o.control.snapshot === 'function') {
    let hitState = null
    try {
      const hosts = o.control.snapshot() || []
      for (const h of hosts) {
        const st = h && h.state
        if (!st || !st.sessionId) continue
        if (String(st.sessionId) !== String(dyn.sessionId)) continue
        if (!Number.isFinite(Number(st.contextTokens)) || Number(st.contextTokens) <= 0) continue
        hitState = { host: h.host, st }
        break
      }
    } catch { /* 快照拿不到就往下走原路 */ }
    if (hitState) {
      const st = hitState.st
      const used = Number(st.contextTokens)
      const win = Number(st.contextWindow) > 0 ? Number(st.contextWindow) : null
      return {
        ok: true,
        pct: win ? pctOf(used, win) : null,
        used, window: win,
        source: 'bridge state（' + (hitState.host || 'host') + '）· ' + String(st.turnId || ''),
        why: null,
        title: st.sessionTitle === undefined ? null : st.sessionTitle,
        isSub: st.isSub === undefined ? null : st.isSub,
        leadBy: dyn.sessionId,
        leadIdSource: dyn.source || TARGET_SOURCE_FALLBACK,
        matches: 1,
        seq: null,
        fromState: true,
      }
    }
  }
  if (dyn.ok) {
    const hit = pickProjcacheForSession(dir, dyn.sessionId);
    if (hit) {
      const filled = hydrateFromProjcache(path.join(dir, hit.n), hit.n, hit.st);
      if (filled.ok) {
        filled.leadBy = dyn.sessionId;
        filled.leadIdSource = dyn.source || TARGET_SOURCE_FALLBACK;
        filled.matches = 1;
        filled.source = '心跳 ' + filled.leadIdSource + ' → ' + hit.n +
          (filled.seq !== undefined ? ' · contextPressure.seq ' + filled.seq : '') +
          ' · 文件 ' + hm(hit.st.mtimeMs) + ' 写过';
        return filled;
      }
      out.why = filled.why || null;
    } else {
      out.why = '心跳给出 lead=' + dyn.sessionId + '，但 projcache 里没有它的文件';
    }
  } else if (dyn.why) {
    out.why = dyn.why;
  }

  // ── ② 兜底：账本最后一条 lead 的 8 位签名（静态判据，保留给「心跳读不到」的情况） ──
  const ledger = ledgerFileOf(config);
  if (!ledger) {
    out.why = [out.why, '没有账本路径（config.soul.root 未配）'].filter(Boolean).join('；');
    return out;
  }
  let lines;
  try { lines = fs.readFileSync(ledger, 'utf8').split('\n'); }
  catch (e) { out.why = '读不到《墨》：' + String((e && e.message) || e); return out; }

  let lead = null, leadCount = 0;
  for (const s of lines) {
    if (!s.trim()) continue;
    let r; try { r = JSON.parse(s); } catch { continue; }
    if (!r || r.type !== 'lead') continue;
    leadCount++;
    lead = r;
  }
  if (!lead) { out.why = '《墨》里没有 lead 记录'; return out; }

  const by = String(lead.by || '');
  const key = normId(by);
  out.leadBy = by;
  out.leadAt = lead.t || null;
  out.leadSummary = String((lead['概要'] !== undefined ? lead['概要'] : lead.text) || '').slice(0, 60);
  out.leadCount = leadCount;
  if (!key) { out.why = 'lead 没有署名（by 为空）'; return out; }

  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { out.why = '读不到 projcache：' + dir; return out; }

  const bare = (n) => (n.startsWith('session-') ? n.slice(8) : n);
  const hex8 = /^[0-9a-f]{8}$/.test(key);
  let hits = names.filter((n) => {
    if (!n.endsWith('.json')) return false;
    const b = bare(n);
    // ★ 十六进制前缀按「前 8 位相等」匹配；具名 id 按「到第一个 - 为止整段」匹配。
    return hex8 ? b.slice(0, 8) === key : b.split('-')[0] === key.split('-')[0];
  });
  if (!hits.length) { out.why = 'projcache 里找不到 lead 会话（' + key + '，两种拼写都试过）'; return out; }

  // 多个命中时取最新那个，并把命中数说出去 —— 不静默挑一个。
  hits = hits.map((n) => ({ n, st: safeStat(path.join(dir, n)) }))
    .filter((x) => x.st)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  if (!hits.length) { out.why = '命中文件 stat 失败'; return out; }

  const file = path.join(dir, hits[0].n);
  const filled = hydrateFromProjcache(file, hits[0].n, hits[0].st);
  if (!filled.ok) return filled;
  filled.matches = hits.length;
  // ★ source 是给人看的一句话：哪一个文件、哪一段、什么 seq、什么时候写的。
  filled.leadBy = by;
  filled.leadIdSource = 'ledger-8hex';
  filled.source = '《墨》最后一条 lead by=' + by + ' → ' + hits[0].n +
    (filled.seq !== undefined ? ' · contextPressure.seq ' + filled.seq : '') +
    ' · 文件 ' + hm(hits[0].st.mtimeMs) + ' 写过';
  return filled;
}

// ── 3b · 找「现在的 lead 是哪条会话」──────────────────────────────────

/** 心跳没标来源时的兜底文案（不是失败：心跳回 primarySessionId 就说明它解析成功了）。 */
const TARGET_SOURCE_FALLBACK = 'heartbeat-lead';

/**
 * 问一次「现在是哪条 lead」。
 *
 * ★ 真源只有一个：organs/lead-target.mjs（它读 GET /heartbeat/auto 的 primarySessionId）。
 *   本进程启动时那个解析器挂在 globalThis.__leadTarget 上 —— 复用**同一个实例**，
 *   因为两个实例会各自缓存一份「上次解析到的 lead」，交接时正好各说各话。
 * ★ 先读缓存（同步、零请求），缓存里没有才现读一次（一次 HTTP，≤1.5s）。
 */
async function currentLeadId(config, o) {
  let resolver = globalThis.__leadTarget || null;
  if (!resolver) {
    try {
      const mod = await import('../organs/lead-target.mjs');
      resolver = mod.createLeadTargetResolver({ config });
    } catch (e) {
      return { ok: false, sessionId: null, source: null, why: '拿不到 lead 解析器：' + String((e && e.message) || e) };
    }
  }
  const readNow = () => { try { return resolver.current(); } catch { return null; } };
  let cur = readNow();
  if (!cur || cur.ok !== true || !cur.sessionId) {
    try { await resolver.refresh(); } catch { /* 读不到就照实说，不抛 */ }
    cur = readNow();
  }
  if (!cur) return { ok: false, sessionId: null, source: null, why: 'lead 解析器没有给结果' };
  if (cur.ok !== true || !cur.sessionId) {
    return { ok: false, sessionId: null, source: cur.source || null,
      why: String(cur.why || '心跳没给出 primarySessionId').slice(0, 200) };
  }
  return { ok: true, sessionId: String(cur.sessionId), source: cur.leadSource || cur.source || TARGET_SOURCE_FALLBACK, why: null };
}

/**
 * 按**完整 session id** 找它的 projcache 文件。
 * ★ 文件名有两种拼写（带 / 不带 session- 前缀，见上面 readLeadWater 的注释），两种都试；
 *   命中多个取最新，不静默挑一个 —— 命中数写进 matches。
 */
function pickProjcacheForSession(dir, sessionId) {
  const bare = (n) => (n.startsWith('session-') ? n.slice(8) : n);
  const want = String(sessionId || '');
  if (!want) return null;
  const wantBare = bare(want);
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const hits = names
    .filter((n) => n.endsWith('.json'))
    .map((n) => ({ n, main: bare(n).slice(0, -5) }))
    .filter((x) => x.main === want || x.main === wantBare
      || x.main.startsWith(want + '-') || x.main.startsWith(wantBare + '-'))
    .map((x) => ({ n: x.n, st: safeStat(path.join(dir, x.n)) }))
    .filter((x) => x.st)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  return hits[0] || null;
}

/**
 * 把一份 projcache 读成水位读数（纯读，不碰账本）。
 * ★ 两条口子共用它：动态路径（心跳给的完整 id）与兜底路径（账本 8 位签名）。
 *   以前这套解析内联在 readLeadWater 里，只能走一条路 —— 复制第二份就是这场事故的起点。
 */
function hydrateFromProjcache(filePath, name, st) {
  const out = { ok: false, pct: null, used: null, window: null, source: null, why: null };
  const j = safeJson(filePath);
  const rows = (j && j.record && j.record.rows) || {};
  // ★ seq 在外层（rows.contextPressure.seq），val 里只有 4 个读数 —— 别在 val 上找 seq。
  const cpRow = rows.contextPressure;
  const cp = cpRow && cpRow.val;
  if (!cp) { out.why = '文件里没有 contextPressure 段（可能是空会话）'; return out; }
  const used = Number(cp.pressureTokens);
  const win = Number(cp.contextWindow);
  if (!Number.isFinite(used)) { out.why = 'pressureTokens 不是数字'; return out; }
  if (!Number.isFinite(win) || win <= 0) { out.why = 'contextWindow 缺失 —— 不套默认分母'; return out; }

  const title = rows.title && rows.title.val ? String(rows.title.val) : null;
  const isSub = !!(rows.subagent && rows.subagent.val && rows.subagent.val.identity);

  out.ok = true;
  out.pct = pctOf(used, win);
  out.used = used;
  out.window = win;
  out.title = title;
  out.isSub = isSub;
  out.seq = cpRow.seq;
  out.file = name;
  out.mtimeMs = st ? st.mtimeMs : null;
  out.staleMs = st ? Date.now() - st.mtimeMs : null;
  return out;
}

// ── 4 · 水位 ②：活跃会话 ──────────────────────────────────────────────

/** name -> {mtimeMs, size, at}。★ 只缓存 stat，不缓存内容 —— 内容会变，mtime 也变。 */
const statCache = new Map();
let statSweepAt = 0;

function sweepStats(dir) {
  const now = Date.now();
  const fresh = now - statSweepAt < STAT_TTL_MS && statCache.size > 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return { names: [], err: '读不到 projcache 目录：' + dir }; }
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    if (fresh && statCache.has(n)) continue;     // 缓存期内只 stat 新出现的文件
    const st = safeStat(path.join(dir, n));
    if (!st) { statCache.delete(n); continue; }
    statCache.set(n, { mtimeMs: st.mtimeMs, size: st.size, at: now });
  }
  // 清掉已经消失的文件
  for (const n of [...statCache.keys()]) if (!names.includes(n)) statCache.delete(n);
  if (!fresh) statSweepAt = now;
  return { names: [...statCache.keys()], err: null };
}

/** 解析一个 projcache 文件 → 水位 + 标题（含子会话判据）。 */
export function parseProjcache(file) {
  const j = safeJson(file);
  if (!j) return { ok: false, why: 'JSON 解析失败' };
  const rows = (j.record && j.record.rows) || j.rows || null;
  if (!rows) return { ok: false, why: '没有 rows 段' };
  const cpRow = rows.contextPressure;
  const cp = cpRow && cpRow.val;
  if (!cp) return { ok: false, why: '没有 contextPressure（空会话）' };
  const used = Number(cp.pressureTokens);
  const win = Number(cp.contextWindow);
  if (!Number.isFinite(used)) return { ok: false, why: 'pressureTokens 不是数字' };
  if (!Number.isFinite(win) || win <= 0) return { ok: false, why: 'contextWindow 缺失' };
  // ★ 子会话的 title.val 是 prompt 前 20 字 —— 六条子会话会变成六行复读机。
  //   真名在 subagent.val.identity.label 里。
  const sub = rows.subagent && rows.subagent.val;
  const isSub = !!(sub && sub.identity);
  const title = isSub
    ? String((sub.identity.label || sub.identity.mode || '子会话')).slice(0, 60)
    : String((rows.title && rows.title.val) || '(无标题)').slice(0, 60);
  return {
    ok: true, used, window: win, pct: pctOf(used, win), title, isSub,
    seq: cpRow.seq, surfaceTokens: Number(cp.surfaceTokens) || null,
    lastMessageAt: rows.timeContext && rows.timeContext.val ? rows.timeContext.val.lastMessageTime : null,
  };
}

/**
 * 活跃会话 = mtime 在窗口内的那些。
 * ★ 只 stat 全目录（约 300ms，走 20 秒内存缓存），**只解析命中的几个**（实测 8ms）。
 *   全量解析 2397 个文件实测 1319ms —— 不能放进 HTTP 同步路径。
 */
export function readActiveWater(config, opts) {
  const o = opts || {};
  const dir = projcacheDirOf(o);
  const win = Number.isFinite(o.windowMs) ? o.windowMs : ACTIVE_WINDOW_MS;
  const now = Date.now();
  const sw = sweepStats(dir);
  const out = {
    ok: false, count: 0, top: null, latest: null, window: null, items: [],
    windowMs: win, windowLabel: Math.round(win / 60000) + ' 分钟 mtime 窗口',
    scanned: 0, parsed: 0, unreadable: 0, why: null, tookMs: 0,
  };
  if (sw.err) { out.why = sw.err; return out; }
  const t0 = Date.now();
  out.scanned = statCache.size;

  const recent = [...statCache.entries()]
    .filter(([, v]) => now - v.mtimeMs <= win)
    .sort((a, b) => b[1].mtimeMs - a[1].mtimeMs)
    .slice(0, MAX_PARSE_FILES);

  for (const [name, st] of recent) {
    if (st.size > MAX_PARSE_BYTES) { out.unreadable++; continue; }
    const p = parseProjcache(path.join(dir, name));
    if (!p.ok) { out.unreadable++; continue; }
    out.parsed++;
    out.items.push({
      file: name, id: name.replace(/^session-/, '').replace(/\.json$/, ''),
      title: p.title, isSub: p.isSub, pct: p.pct, used: p.used, window: p.window,
      seq: p.seq, mtimeMs: st.mtimeMs, ageMin: Math.max(0, Math.round((now - st.mtimeMs) / 60000)),
      lastMessageAt: p.lastMessageAt,
    });
  }
  out.tookMs = Date.now() - t0;
  out.items.sort((a, b) => (b.pct || 0) - (a.pct || 0));
  out.count = out.items.length;
  out.latest = out.items.length
    ? [...out.items].sort((a, b) => b.mtimeMs - a.mtimeMs)[0] : null;
  // ★ top = **水位最高**的那条（最接近过线的），不是最新的一条 —— 状态台要盯的是风险。
  out.top = out.items[0] || null;
  out.window = out.top ? out.top.window : null;
  out.ok = true;
  if (!out.count) out.why = '窗口内没有活跃会话（不是报错，是真的安静）';
  return out;
}

// ── 5 · 水位 ③：镜像帧字符估算（不是水位）──────────────────────────────

/**
 * ★ 这一格**不是水位**，是「本进程对被镜像的 DSH 帧做的一次字符估算」。
 *   算式照搬 src/yantai/panel.mjs 的 readWater（人格层 + 最近 N 帧，estimateTokens 数出来）。
 *   它和 DSH 的 pressureTokens 是两把尺子，实测差约 20 倍 —— 页面上必须写清是哪一把。
 */
export async function readMirrorWater(ctx) {
  const { config, store, persona } = ctx || {};
  if (!store) return { pct: null, used: null, window: null, note: '无读数：进程里没有 store', why: 'no-store' };
  try {
    const { readWater } = await import('../yantai/panel.mjs');
    const w = readWater({ config, store, persona });
    return {
      pct: Number.isFinite(w.pct) ? Math.round(w.pct * 1000) / 10 : null,
      used: w.used, window: w.window,
      session: w.session, frameCount: w.frameCount, state: w.state,
      ruler: w.ruler,
      note: '不是水位，是镜像帧字符估算',
      ok: !!w.ok,
    };
  } catch (e) {
    return { pct: null, used: null, window: null, note: '无读数：' + String((e && e.message) || e), why: 'throw' };
  }
}

// ── 6 · 缓存字节（与 server.mjs 同一个实现，避免两把尺子）─────────────────

/**
 * _index.cache / _index.fp 的字节数。
 * ★ 路径唯一来源是 store.cacheFile / store.fpFile（store.mjs:84 写的就是它们）；
 *   拼 store.root 会多一层目录 → stat 失败被吞成 0 → 「0 MB」和「文件不存在」长得一样。
 * ★ 一个都 stat 不到 → null（未知），不是 0。
 */
export function measureCacheBytes(store, config) {
  const d = (config && config.dataDir) || null;
  const c = (store && store.cacheFile) || (d && path.join(d, '_index.cache'));
  const f = (store && store.fpFile) || (d && path.join(d, '_index.fp'));
  const ns = [c, f].filter(Boolean).map((x) => { const s = safeStat(x); return s ? s.size : null; });
  if (!ns.length || ns.every((n) => n === null)) return null;
  return ns.reduce((a, n) => a + (n || 0), 0);
}

// ── 7 · 六层 ──────────────────────────────────────────────────────────

/* ★★★ 2026-11-14（第 14 代）：书房文件数改成 **stale-while-revalidate**。
 *
 * 原来是「缓存 60 秒，过期就同步全 walk」。两个问题叠加：
 *   ① 面板切页的间隔通常**超过 60 秒** → 每次切页都赶在缓存过期后 → 每次付 445ms；
 *   ② 那一趟 walk 是**同步**的（ix.refresh()），不只是让这次请求慢，
 *      是把整个事件循环按住 445ms —— 同进程里所有别的请求一起等。
 *      实测：/api/organs 冷启动 13ms、跑久了 1197ms，92 倍差就是这么来的。
 *
 * 现在：
 *   · TTL 60s → 10 分钟（书房文件数是慢变量，十分钟的误差没有意义）；
 *   · 过期后**立刻返回旧值**，刷新丢到后台，不在请求路径上；
 *   · 后台刷新加锁（soulRefreshing），并发请求不会叠着 walk；
 *   · 首次（没有旧值）仍然同步算一次 —— 宁可第一次慢，也不要显示一个假的 0。
 *     （「无读数」和「0 个文件」是两件事，这条在本文件其它地方也写着。）
 */
const SOUL_TTL_MS = 10 * 60 * 1000;
let soulCache = null;
let soulRefreshing = false;

function refreshSoulStatsInBackground(root) {
  if (soulRefreshing) return;
  soulRefreshing = true;
  Promise.resolve()
    .then(() => import('../organs/soul-scan.mjs'))
    .then(({ SoulIndex }) => {
      const ix = new SoulIndex(root, { ttl: SOUL_TTL_MS });
      ix.refresh();
      soulCache = { root, at: Date.now(), st: ix.stats() };
    })
    .catch(() => { /* 刷不出来就继续用旧的；下一次过期再试 */ })
    .finally(() => { soulRefreshing = false; });
}

async function fillSoulStats(root) {
  if (!root) return null;
  const now = Date.now();
  const hit = soulCache && soulCache.root === root;
  if (hit && now - soulCache.at < SOUL_TTL_MS) return soulCache.st;
  if (hit) {
    // 过期：先给旧的，后台刷（请求路径 0ms）
    refreshSoulStatsInBackground(root);
    return soulCache.st;
  }
  // 首次：**先读清单缓存**（实测 27ms），没有再退回全量遍历。
  // ★ 2026-11-17（阶段 1）：原来这里无条件同步 refresh() —— 一个「读书房有几个文件」的调用
  //   要按住事件循环 1.6~4 秒。现在缓存命中就 27ms；没命中才付一次遍历的代价（并落缓存）。
  try {
    const { SoulIndex } = await import('../organs/soul-scan.mjs');
    const ix = new SoulIndex(root, { ttl: SOUL_TTL_MS, cacheDir: (config && config.dataDir) || undefined });
    const hit = typeof ix.loadManifestFromCache === 'function' ? ix.loadManifestFromCache() : false;
    if (!hit) {
      if (typeof ix.refreshAsync === 'function') await ix.refreshAsync({ force: true, yieldMs: 32 });
      else ix.refresh(true);
    }
    const s = ix.stats();
    soulCache = { root, at: Date.now(), st: s };
    return s;
  } catch { return null; }
}

export async function readEchoLayer(ctx) {
  const { store, config, opts } = ctx;
  const p = coreTag(opts.core);
  const items = [];
  let sessions = null, indexRows = null, dataMB = null, cacheB = null, note = '';

  if (store) {
    try {
      const metas = store.list();
      sessions = metas.length;
      let bytes = 0;
      for (const m of metas) bytes += Number(m.bytes) || 0;
      dataMB = mb(bytes);
    } catch (e) { note += '会话列表读失败；'; }
    // ★★★ 2026-11-17（阶段 2）：**这里原来会同步建索引，已改掉。**
    //
    //   原注释说「代价只在真的没建时付一次（0.65s）」—— 那句话在缓存小的时候成立，
    //   在本机已经不成立了。实测（fs-watch 抓到调用栈）：
    //     readFileSync _index.cache  124.8MB  **1,669 ms**
    //       ← store.mjs:469  ← status-data.mjs:602  ← status-data.mjs:1518
    //   也就是说：**/api/status 一条请求，就可能同步整读 124.8MB 的索引缓存。**
    //   而它正好落在面板刷新路径上 —— 「刷一下状态台，事件循环停 1.7 秒」。
    //
    //   现在的口径：**发现没建就如实说「未建」，同时踢一次后台构建**，绝不在这里同步建。
    //   这与阶段 2 对 echoStats 的处理是同一条判据：**请求路径不做重活，只报读数**。
    if (!store.ixBuilt) {
      let kicked = false;
      try {
        if (typeof store.buildIndexAsync === 'function') {
          store.buildIndexAsync({ yieldMs: 8 }).catch(() => { /* 建不起来就下次再说 */ });
          kicked = true;
        }
      } catch { /* 拉不起来也不阻塞请求 */ }
      // 记在 note 里 —— 面板上要能看出「这是还没建，不是没有」
      note += kicked ? '索引未建，已在后台开始构建；' : '索引未建（无分片构建能力）；';
    }
    if (store.ixBuilt && store.ix) {
      let n = 0;
      for (const [, arr] of store.ix) n += Array.isArray(arr) ? arr.length : 0;
      indexRows = n;
    }
    cacheB = measureCacheBytes(store, config);
  }
  const soul = await fillSoulStats(soulRootOf(config) || (opts && opts.soulRoot));

  items.push(row('会话容器', sessions, '个'));
  items.push(indexRows === null
    ? na('索引行', store ? '索引未建（进程还没预热，或这是首次请求）' : '进程里没有 store')
    : row('索引行', indexRows, '行'));
  items.push(row('数据体积', dataMB, 'MB'));
  items.push(cacheB === null
    ? na('索引缓存', '两个缓存文件都 stat 不到 —— 未知，不是 0 字节')
    : row('索引缓存', mb(cacheB), 'MB'));
  items.push(soul ? row('书房文件', soul.files, '个') : na('书房文件', 'config.soul.root 没配，或 walk 失败'));
  items.push(soul ? row('书房体积', soul.mb, 'MB') : na('书房体积', '同上'));

  const level = (sessions === null && soul === null) ? 'error' : (indexRows === null ? 'warn' : 'ok');
  return {
    key: 'echo', name: 'Ⅰ · ECHO', title: '记忆 / 索引 / 检索',
    level, items,
    note: note || '索引行来自本进程内存索引；书房是另一套索引（echo_stats 报 soulFiles 0，两份互不知情）。',
    provenance: p + ' · store.list / store.ix / measureCacheBytes + SoulIndex',
  };
}

/**
 * 自主读数缓存 —— 15 秒。
 * ★ 为什么它值得一个缓存：Autonomy.check() 要 stat 每一个会话的 frames.jsonl，
 *   实测 174ms。而它的结论按「分钟」变，15 秒的旧值不会被任何人看出来。
 *   ★ 只缓存这一个 174ms 的活；水位、事件那些便宜的直接读，不缓存。
 */
let autonomyMemo = null;

/** 今日已动的「有效」次数。
 *  ★ 与 autonomy.decidePhase 用同一把尺子：runsTodayDate 不是今天就算 0。
 *    否则面板会把昨天的 24 次报成今天的（而器官那边说预算还有）—— 两个数都「真」，但尺子不同。 */
function todayRunsOf(state) {
  if (!state) return null;
  const today = new Date().toISOString().slice(0, 10);
  return state.runsTodayDate === today ? (Number(state.runsToday) || 0) : 0;
}

const AGREE_TEXT = { agree: '一致', 'snapshot-stale': '快照落后（不是冲突）', conflict: '同一时点仍相反', 'unknown-time': '分不清时点', unknown: '无法比较' };

/**
 * 两个来源怎么比 —— **时间不同不叫冲突**。
 *
 * ★ 旧版把「本进程 enabled ≠ 磁盘 enabled」一律写成「两个来源不一致，重启一次才生效」。
 *   可那两件事本来就可以发生在两个时刻：进程 22:44:49 读配置，config.json 22:48 被改成相反的。
 *   那种情况叫**旧快照**，不叫冲突 —— 把旧快照叫冲突，读的人会去查一个不存在的矛盾。
 *
 * 判据：
 *   值相同                      → agree
 *   值不同 且 配置 mtime > 快照时刻 → snapshot-stale（差的是时间，不是结论）
 *   值不同 且 配置 mtime ≤ 快照时刻 → conflict（同一时点的配置给出相反结论 —— 这才要看原因）
 *   快照时刻未知                → unknown-time（旧进程没记这个时间，不猜）
 */
export function autonomyAgreement(inProc, disk, cfgMtimeMs) {
  if (!inProc) return { status: 'unknown', why: '本进程没有 autonomy 器官' };
  if (!disk || disk.enabled === null || disk.enabled === undefined) return { status: 'unknown', why: '磁盘 config.json 里没有 autonomy.enabled' };
  const a = !!inProc.enabled, b = !!disk.enabled;
  if (a === b) return { status: 'agree', why: null };
  const at = inProc.configAtMs;
  if (!Number.isFinite(at)) {
    return { status: 'unknown-time', why: '本进程视为「' + (a ? '开' : '关') + '」、磁盘写的是「' + (b ? '开' : '关') + '」，但旧进程没有记录配置快照时刻 —— 分不清是两个时点的差，还是同一时点的矛盾' };
  }
  if (Number.isFinite(cfgMtimeMs) && cfgMtimeMs > at + 2000) {
    return { status: 'snapshot-stale', why: '配置在进程读它之后被改过：快照读于 ' + hm(at) + '，config.json mtime ' + hm(cfgMtimeMs) + ' → 本进程持的是「' + (a ? '开' : '关') + '」，磁盘现在是「' + (b ? '开' : '关') + '」' };
  }
  return { status: 'conflict', why: '同一时点的配置给出相反结论：本进程快照「' + (a ? '开' : '关') + '」（读于 ' + hm(at) + '），磁盘「' + (b ? '开' : '关') + '」（mtime ' + (Number.isFinite(cfgMtimeMs) ? hm(cfgMtimeMs) : '未知') + '）—— 不是时间差，要查环境变量 / 显式覆盖 / 默认值' };
}

/**
 * Ⅱ VITAL —— 呼吸 / 自主 / 换气。
 *
 * ★★ 三件事各报各的，不许合并（2026-11-10 三项死读数修复之三 + 之一）：
 *   ① 自主有三个**不同语义**的东西：运行时判定（phase）、配置快照（进程启动时读的那份）、
 *      磁盘配置（现在文件里那份）。三者各带自己的时间戳。
 *   ② 换气有**两条一手源**：本进程换气器官（连续 / 熔断阈值）、DSH 侧 dsh-huanqi 账本（credit）。
 *      ★ 它们语义不同，不合并、不相加；读不到就是无读数 + 原因，绝不写 0 冒充。
 */
export function readVitalLayer(ctx) {
  const { autonomy, config, opts } = ctx;
  const o = opts || {};
  const p = coreTag(o.core);
  const items = [];
  const data = { runtime: null, configSnapshot: null, disk: null, state: null, agreement: null, huanqi: null, conflict: null };

  // ── ① 自主：运行时判定（本进程） ────────────────────────────────────
  let inProc = null;
  if (autonomy && typeof autonomy.check === 'function') {
    try {
      const t0 = Date.now();
      // ★ 缓存必须绑在**同一个 autonomy 实例**上：以前只按时间判 15 秒，
      //   换个实例传进来（自检夹具、就地重启）也会拿到上一条的结论 —— 那是跨实例的污染。
      const hit = autonomyMemo && autonomyMemo.autonomy === autonomy && (t0 - autonomyMemo.at) < 15000;
      let c = hit ? autonomyMemo.c : null;
      const cached = !!c;
      if (!c) {
        c = autonomy.check();
        autonomyMemo = { autonomy, at: Date.now(), c };
      }
      const cfgAt = Number.isFinite(autonomy.configAtMs) ? autonomy.configAtMs : null;
      inProc = {
        phase: c.phase, reason: c.reason,
        enabled: !!(autonomy.config && autonomy.config.enabled),
        configAtMs: cfgAt,
        idleMinutes: c.idle && c.idle.ok ? c.idle.minutes : null,
        threshold: (autonomy.config && autonomy.config.idleThresholdMinutes) || null,
        maxRunsPerDay: (autonomy.config && autonomy.config.maxRunsPerDay) || null,
        runsToday: todayRunsOf(autonomy.state),
        runsTodayRaw: autonomy.state ? (autonomy.state.runsToday === undefined ? null : autonomy.state.runsToday) : null,
        runsTodayDate: autonomy.state ? (autonomy.state.runsTodayDate || null) : null,
        at: autonomyMemo.at, tookMs: cached ? 0 : Date.now() - t0, cached,
        source: '本进程 Autonomy.check()（结果缓存 15 秒）',
      };
      items.push(row('自主（运行时判定）', c.phase, '', { sub: c.reason, at: hm(autonomyMemo.at) }));
      data.runtime = inProc;
      // ★ 兼容旧字段（data.inProcess）—— 老页面 / 老探针可能还在读它
      data.inProcess = inProc;
    } catch (e) {
      items.push(na('自主（运行时判定）', 'Autonomy.check() 抛错：' + String((e && e.message) || e)));
    }
  } else {
    items.push(na('自主（运行时判定）', '进程里没有 autonomy 器官'));
  }

  // ── ② 自主：配置快照（进程启动那一刻读到的那份） ─────────────────────
  if (inProc) {
    data.configSnapshot = {
      enabled: inProc.enabled, threshold: inProc.threshold, maxRunsPerDay: inProc.maxRunsPerDay,
      atMs: inProc.configAtMs,
      source: 'Autonomy 构造时读到的配置（进程启动那一刻）',
    };
    items.push(Number.isFinite(inProc.configAtMs)
      ? row('自主（配置快照）', (inProc.enabled ? '开' : '关') + ' · 阈值 ' + inProc.threshold + ' 分钟', '',
        { at: hm(inProc.configAtMs), sub: '预算 ' + inProc.maxRunsPerDay + ' 次/日 · 进程启动时读入' })
      : na('自主（配置快照）', '旧进程没有记录配置快照时刻（autonomy.configAtMs 缺失）—— 不猜它是几点的配置'));
  }

  // ── ③ 自主：磁盘配置（MCP 侧 / 下次启动会读到的那份） ─────────────────
  const cf = configFileOf(o);
  const st = safeStat(cf);
  const diskCfg = safeJson(cf);
  const diskEnabled = diskCfg && diskCfg.autonomy && diskCfg.autonomy.enabled !== undefined
    ? !!diskCfg.autonomy.enabled
    : null;
  data.disk = {
    configFile: cf,
    configMtimeMs: st ? st.mtimeMs : null,
    enabled: diskEnabled,
    threshold: diskCfg && diskCfg.autonomy && diskCfg.autonomy.idleThresholdMinutes ? diskCfg.autonomy.idleThresholdMinutes : null,
    source: '磁盘 config.json 的 autonomy 段（MCP 侧进程启动时读的就是这一份）',
  };
  data.diskConfig = data.disk;
  items.push(diskEnabled === null
    ? na('自主（磁盘配置）', diskCfg ? 'config.json 里没有 autonomy 段' : '读不到 config.json：' + cf)
    : row('自主（磁盘配置）', (diskEnabled ? '开' : '关') + ' · 阈值 ' + (data.disk.threshold || '默认 15') + ' 分钟', '',
      { at: st ? hm(st.mtimeMs) : '', sub: cf }));

  // ── ④ 自主：状态文件（今日已动 / 上次自主时刻） ───────────────────────
  const stateFile = config && config.dataDir ? path.join(config.dataDir, 'autonomy.json') : null;
  const sst = stateFile ? safeStat(stateFile) : null;
  const state = stateFile ? safeJson(stateFile) : null;
  data.state = {
    file: stateFile, mtimeMs: sst ? sst.mtimeMs : null,
    runsTodayRaw: state ? state.runsToday : null,
    runsTodayDate: state ? state.runsTodayDate : null,
    effectiveToday: todayRunsOf(state),
    lastAutonomousAt: state ? state.lastAutonomousAt : null,
  };
  if (sst) {
    const eff = data.state.effectiveToday;
    const stale = state && data.state.runsTodayDate && data.state.runsTodayDate !== new Date().toISOString().slice(0, 10);
    items.push(row('自主状态文件', '今日已动 ' + (eff === null ? '?' : eff) + ' 次', '',
      { at: hm(sst.mtimeMs), sub: stale ? '文件里最后一次写的是 ' + data.state.runsTodayDate + ' 的 ' + data.state.runsTodayRaw + ' 次（不是今天）' : 'runsTodayDate 是今天' }));
  } else {
    items.push(na('自主状态文件', 'data/autonomy.json 不存在 —— 从没自己动过，就没这份状态'));
  }

  // ── ⑤ 两个来源怎么比（时间不同不叫冲突） ─────────────────────────────
  const ag = autonomyAgreement(inProc, data.disk, st ? st.mtimeMs : null);
  data.agreement = ag;
  data.conflict = ag.status === 'conflict' ? { why: ag.why, hint: '不是时间差 —— 去查环境变量 / 显式覆盖 / 默认值' } : null;
  if (ag.status === 'agree') {
    items.push(row('两个来源', '一致', '', { sub: '本进程快照与磁盘配置都是「' + (inProc.enabled ? '开' : '关') + '」' }));
  } else if (ag.status === 'snapshot-stale') {
    items.push(row('两个来源', AGREE_TEXT[ag.status], '', { sub: ag.why, bad: true }));
  } else if (ag.status === 'conflict') {
    items.push(row('两个来源', AGREE_TEXT[ag.status], '', { sub: ag.why, bad: true }));
  } else {
    items.push(na('两个来源', AGREE_TEXT[ag.status] + '：' + ag.why));
  }

  // ── ⑥ 换气：两条一手源，各报各的 ─────────────────────────────────────
  data.huanqi = readHuanqi({ map: ctx.loop && ctx.loop.__huanqiByRound, dshHome: dshHomeOf(o) });
  const hqA = data.huanqi.agentSoul;
  const hqD = data.huanqi.dsh;
  if (hqA.ok) {
    const w = hqA.worst;
    items.push(row('换气（本进程）', w.stalled + ' / ' + (w.threshold === null ? '?' : w.threshold), '', {
      at: w.lastAt ? hm(w.lastAt) : hm(hqA.atMs),
      sub: '最紧 ' + String(w.sid || '').slice(0, 12) + ' · 观测 ' + (w.observed === null ? '?' : w.observed) + ' 次 · 熔断阈值 ' + (w.threshold === null ? '未知' : w.threshold),
    }));
  } else {
    items.push(na('换气（本进程）', hqA.why));
  }
  if (hqD.ok) {
    items.push(row('换气（DSH 额度）', hqD.credit + ' / ' + (hqD.creditMax === null ? '?' : hqD.creditMax), '', {
      at: hqD.turnsMtimeMs ? hm(hqD.turnsMtimeMs) : hm(hqD.ledgerMtimeMs),
      sub: '累计熔断 ' + (hqD.stats && hqD.stats.circuitBreaks !== null ? hqD.stats.circuitBreaks : '?')
        + ' 次 · 续跑 ' + (hqD.stats && hqD.stats.continuations !== null ? hqD.stats.continuations : '?')
        + (hqD.lastTurn && hqD.lastTurn.verdict ? ' · 最近 ' + hqD.lastTurn.verdict : ''),
    }));
  } else {
    items.push(na('换气（DSH 额度）', hqD.why));
  }

  const level = (ag.status === 'conflict' || !inProc || (!hqA.ok && !hqD.ok)) ? 'warn' : 'ok';
  return {
    key: 'vital', name: 'Ⅱ · VITAL', title: '呼吸 / 自主 / 换气',
    level, items, data,
    note: '自主分成三个时点（运行时判定 / 配置快照 / 磁盘配置），各带时间戳；只有「同一时点仍相反」才叫冲突。'
      + '换气有两条一手源，语义不同、不合并：本进程报连续与熔断阈值，DSH 报额度 credit。',
    provenance: p + ' · Autonomy.check()（同 /api/organs）+ ' + cf
      + ' + ' + (stateFile || '（无状态文件）')
      + ' + ' + (hqA.ok ? 'loop.__huanqiByRound' : '（无换气判定表）')
      + ' + ' + (hqD.ok ? hqD.ledgerFile : '（无 DSH 换气账本）'),
  };
}

export async function readCapabilityLayer(ctx) {
  const { tools, config, opts } = ctx;
  const p = coreTag(opts.core);
  const home = dshHomeOf(opts);
  const items = [];

  const builtin = tools && tools.tools && typeof tools.tools.size === 'number' ? tools.tools.size : null;
  items.push(builtin === null ? na('内置工具', '进程里没有 tools 注册表') : row('内置工具', builtin, '个'));

  let mcp = null;
  try {
    const m = await import('../adapters/mcp-tools.mjs');
    mcp = Array.isArray(m.TOOLS) ? m.TOOLS.length : null;
  } catch { mcp = null; }
  items.push(mcp === null ? na('MCP 工具', '模块加载失败') : row('MCP 工具', mcp, '个'));

  // 插件包：数 profile 里装了哪些 dsh-* 包
  const profileDir = path.join(home, 'profiles', 'desktop', 'node_modules');
  let plugins = null;
  try {
    plugins = fs.readdirSync(profileDir).filter((n) => n.startsWith('dsh-') && isDir(path.join(profileDir, n))).length;
  } catch { plugins = null; }
  items.push(plugins === null ? na('插件包', '读不到 ' + profileDir) : row('插件包', plugins, '个', { sub: 'profiles/desktop' }));

  // 技能目录
  const skillsDir = path.join(home, 'skills');
  // ★ 2026-11-11：技能从「数目录」改成「真加载一遍」—— 数目录只能回答「有几个」，
  //   而真正要回答的是「叫什么、能不能读」。加载器与本进程的 soul_skill 工具**同一个实例**
  //   （globalThis.__skillLib），所以这里看到的名单就是工具看到的名单。
  let skills = null;
  let skillNames = [];
  let skillRoots = [];
  let skillWhy = null;
  try {
    const { SkillLibrary } = await import('../skills/index.mjs');
    const dirs = skillsDirsOf(config || {});
    skillRoots = dirs;
    if (!dirs.length) { skillWhy = '没有技能目录（config.skills.dirs 未配，且本机没有默认技能目录）'; }
    else {
      if (!globalThis.__skillLib) globalThis.__skillLib = new SkillLibrary({ dirs });
      else globalThis.__skillLib.dirs = dirs;
      skillNames = globalThis.__skillLib.list().map((x) => x.name);
      skills = skillNames.length;
    }
  } catch (e) { skillWhy = '加载器抛错：' + String((e && e.message) || e); }
  items.push(skills === null
    ? na('技能', skillWhy || ('读不到 ' + skillsDir))
    : row('技能', skills, '个', { sub: skillNames.slice(0, 6).join(' · ') + (skillNames.length > 6 ? ' …' : '') }));

  // ── 2026-11-11 · 从「数了几个」到「我会什么、哪个是桩」 ──────────────
  //   ★ 原来这一层只有计数，审计的原话是「没有一条能回答『我会什么』」。
  //     接管 DSH 之前，这张表是最该能看的：哪些能力真在、哪些只是举了手。
  //   ★ 全部只读；拿不到就是空数组 + 一行 na，不编。
  const names = { builtin: [], mcp: [], skills: [] };
  try { if (tools && tools.tools && typeof tools.tools.keys === 'function') names.builtin = [...tools.tools.keys()]; } catch { /* 拿不到就算 */ }
  try {
    const m = await import('../adapters/mcp-tools.mjs');
    names.mcp = (Array.isArray(m.TOOLS) ? m.TOOLS : []).map((t) => t && t.name).filter(Boolean);
  } catch { /* 拿不到就算 */ }
  try { names.skills = fs.readdirSync(skillsDir).filter((n) => isDir(path.join(skillsDir, n))); } catch { /* 拿不到就算 */ }

  // 桩：宿主在 hello.meta.stubs 里自报的「能力在、路没通」
  const stubs = [];
  try {
    const ctl = (opts && opts.control) || globalThis.__controlHub || null;
    const snap = ctl && typeof ctl.snapshot === 'function' ? ctl.snapshot() : (typeof ctl === 'function' ? ctl() : null);
    for (const h of (Array.isArray(snap) ? snap : [])) {
      for (const s of ((h && h.stubs) || [])) stubs.push(String(h.host || '?') + '/' + String(s));
    }
  } catch { /* 拿不到就算 */ }

  items.push(names.builtin.length
    ? row('内置工具名', names.builtin.join(' · '), '', { sub: 'v4 core 自己注册的那几个' })
    : na('内置工具名', '拿不到 tools 注册表'));
  items.push(names.mcp.length
    ? row('MCP 工具名', names.mcp.length > 8 ? (names.mcp.slice(0, 8).join(' · ') + ' …共 ' + names.mcp.length + ' 个') : names.mcp.join(' · '), '')
    : na('MCP 工具名', '拿不到 TOOLS 表'));
  items.push(stubs.length
    ? row('桩（能力在、路没通）', stubs.join(' · '), '', { bad: true, sub: '宿主在 hello.meta.stubs 里自报 —— 派过去只会等超时' })
    : row('桩（能力在、路没通）', '无', '', { sub: '宿主自报的桩：一个都没有' }));

  return {
    key: 'capability', name: 'Ⅲ · 能力', title: '工具 / 插件 / 技能',
    level: stubs.length ? 'warn' : 'ok', items,
    data: { names: { ...names, skills: skillNames }, stubs, skillRoots },
    note: stubs.length
      ? '★ 桩 ' + stubs.length + ' 个：能力声明了、路没通。接管前必须逐个转正或明确不迁。'
      : '★ 没有桩：宿主报的能力都能派。',
    provenance: p + ' · tools.tools.keys + adapters/mcp-tools.mjs:TOOLS + ' + skillsDir + ' + control.snapshot().stubs',
  };
}

export async function readArchiveLayer(ctx) {
  const { config, persona, opts } = ctx;
  const p = coreTag(opts.core);
  const items = [];
  let diaryN = null, diaryState = null;
  try {
    const d = new Diary(diaryDirOf(config), { maxSnippet: config && config.diary && config.diary.maxSnippet });
    const r = d.list();
    diaryState = r.state;
    diaryN = r.state && r.state.ok ? r.entries.length : null;
  } catch { diaryN = null; }
  items.push(diaryN === null
    ? na('日记', diaryState && diaryState.hint ? diaryState.hint : '读不到日记目录')
    : row('日记', diaryN, '篇'));

  let pr = null;
  try { pr = persona && persona.render ? persona.render() : null; } catch { pr = null; }
  items.push(pr ? row('人格层', pr.used + ' / ' + pr.budget + ' B', '', {
    pct: pr.budget ? Math.round(pr.used / pr.budget * 1000) / 10 : null,
    sub: pr.dropped && pr.dropped.length ? '裁掉 ' + pr.dropped.join('、') : '未裁剪',
  }) : na('人格层', '进程里没有 persona 层'));

  // 产物：目录 vs 表
  const idxDir = soulRootOf(config) ? path.join(soulRootOf(config), '40-产物索引') : null;
  let artFiles = null, artDirs = null;
  if (idxDir) {
    try {
      const es = fs.readdirSync(idxDir, { withFileTypes: true });
      artFiles = es.filter((e) => e.isFile()).length;
      artDirs = es.filter((e) => e.isDirectory()).length;
    } catch { artFiles = null; }
  }
  items.push(artFiles === null ? na('产物索引', '读不到 40-产物索引')
    : row('产物索引', artFiles + ' 文件 / ' + artDirs + ' 目录', '', { sub: '纯文件清单，无 hash / bytes / status' }));

  // ★ 2026-11-11：这一格原来只有一句「产物清单为零」—— 那是**结论**，不是读数。
  //   现在给出最近改动的三个产物名（只读目录 + stat），让这一层至少有东西可看；
  //   下面那行仍然如实说「表没接」，但把原因写清楚：不是坏，是还没接线。
  if (idxDir && artFiles) {
    let recent = [];
    try {
      recent = fs.readdirSync(idxDir, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => ({ n: e.name, st: safeStat(path.join(idxDir, e.name)) }))
        .filter((x) => x.st)
        .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
        .slice(0, 3);
    } catch { recent = []; }
    items.push(recent.length
      ? row('最近产物', recent.map((x) => x.n).join(' · '), '', { sub: '按 mtime 取前三 · 只是文件名，没有登记进表' })
      : na('最近产物', '目录读得到，但里面没有文件'));
  }
  items.push(na('产物表', 'src/db/artifacts.mjs 已写好（register/list/get/verify + 只追加事件），但**零 importer** —— 判定是未接，不是坏。接线要定三件事：source 根怎么选、登记由谁触发、写库与 v3 的边界。'));

  // 《墨》条数
  const lf = ledgerFileOf(config);
  let moN = null;
  if (lf) {
    try { moN = fs.readFileSync(lf, 'utf8').split('\n').filter((s) => s.trim()).length; } catch { moN = null; }
  }
  items.push(moN === null ? na('《墨》', '读不到账本') : row('《墨》', moN, '条'));

  return {
    key: 'archive', name: 'Ⅳ · 档案', title: '日记 / 人格 / 产物',
    level: artFiles === null ? 'error' : 'warn', items,
    note: '产物这一层只有目录、没有账 —— v4 的 artifact.register / list 一条也没接。',
    provenance: p + ' · /api/diary/list + /api/persona 同源 + ' + (idxDir || '（无产物索引目录）'),
  };
}

/** Read the single v9 ECHO store without probing external doctor or changing the DB. */
// ── echoStats 进程内缓存（阶段 2 · 2026-11-17）─────────────────────────────
//
// ★ 为什么必须缓存：analyzeEchoIntegrity 是**同步** SQL（node:sqlite 没有异步版），
//   实测单次 954ms~7.6s，而它落在 /api/status 与 /api/organs 的热路径上 ——
//   等于「面板刷一下，事件循环被按住一秒起」。
// ★ 为什么 TTL 是 30 秒：ECHO 索引只在**导入时**变（tools/echo-index-import.mjs，
//   手工/脚本触发，不是每秒）。30 秒的读数差异对状态台没有意义，而它能把
//   请求路径上的成本从「秒级」压到「几毫秒」。
// ★ 缓存的是**结论不是证据**：命中时回的是上一次真实算出来的 items，
//   并且带上 cached/ageMs —— 让人看得出「这是 20 秒前的读数」，不冒充此刻。
const ECHO_INTEGRITY_TTL_MS = 30 * 1000;
let echoIntegrityCache = null;   // { at, item }
let echoIntegrityInflight = null;

export function invalidateEchoIntegrityCache() {
  echoIntegrityCache = null;
}

export function readEchoIntegrityItem(config, opts) {
  const o = opts || {};
  const dataDir = config && config.dataDir;
  const echoDb = o.echoDbPath || (config && config.memory && config.memory.libraryDir
    ? path.join(config.memory.libraryDir, config.memory.indexFile || 'meta.sqlite')
    : (dataDir ? path.join(dataDir, 'meta.sqlite') : null));

  // ① 显式要求新鲜（排障 / 自检）：真的同步算一次。**只有这条路会阻塞**，而且是调用方自己点的。
  if (o.fresh === true) {
    const fresh = computeEchoIntegrityItem(config, o);
    echoIntegrityCache = { at: Date.now(), item: fresh };
    return fresh;
  }

  // ② 进程内缓存
  const now = Date.now();
  if (echoIntegrityCache && now - echoIntegrityCache.at < ECHO_INTEGRITY_TTL_MS) {
    return Object.assign({}, echoIntegrityCache.item, { cached: true, ageMs: now - echoIntegrityCache.at });
  }

  // ③ 磁盘读数 —— 由**子进程**算出来的那份
  //   ★★ 2026-11-17（阶段 2）：为什么必须走子进程，而不是在这里同步算：
  //     analyzeEchoIntegrity 是 node:sqlite 的**同步**调用，里面的 FTS5 全表 GROUP BY
  //     与 UNINDEXED 列上的孤儿检查让它单次耗时从 4 秒（分条实测）到 40 秒（整体实测）不等。
  //     同步函数一旦开始就没法中断 —— 放在请求路径上，等于把 /api/status 和 /api/organs 一起钉死。
  //     挪到子进程之后：它慢多久都与 core 无关，core 只读一个几百字节的 JSON。
  if (dataDir) {
    const got = readEchoProbeRecord(dataDir);
    if (got && got.at && now - got.at < ECHO_PROBE_TTL_MS) {
      const item = echoItemFromProbe(got.rec, now - got.at);
      echoIntegrityCache = { at: now, item };
      return item;
    }
    // ★★ 2026-11-17 修一个我自己造的事故：这里原来会**自动拉子进程**。
    //   实测后果：探针在某些页缓存状态下要跑几分钟，于是每过一次 SPAWN_GAP 就再拉一个 ——
    //   8 分钟里起了 **17 个** node 进程，每个都在同步扫 2.5GB 的 FTS5。
    //   那正是我要消灭的那种「多写者 + IO 重载」，只是换了个地方长出来。
    //   ★ 现在的口径：**读数只由显式动作产生**（node tools/echo-integrity-refresh.mjs
    //     或 POST /api/echo/integrity/refresh）。请求路径绝不自己起进程。
    //   没有读数就如实说「还没算过」—— 这比一个悄悄把机器拖垮的自动刷新诚实得多。
    if (got && got.at) {
      const item = echoItemFromProbe(got.rec, now - got.at);
      item.stale = true;
      return item;
    }
    return na('ECHO v9 索引', '索引体检正在后台计算（首次要几十秒；算完之前不阻塞任何请求）');
  }

  // ④ 没有 dataDir 的极端情况：退回同步算（宁可慢，也不给假数）
  return computeEchoIntegrityItem(config, o);
}

// ── 子进程体检的读数层（阶段 2 · 2026-11-17）────────────────────────────────
//
// ★ 三个常量各自的理由：
//   TTL 10 分钟 —— ECHO 索引只在**导入时**变（tools/echo-index-import.mjs，手工/脚本触发）。
//     10 分钟里它不可能变两次；而体检本身要几十秒，拉太勤只是白烧 CPU。
//   SPAWN 间隔 30 秒 —— 防止「读数过期」时每个请求都 spawn 一个（那会变成进程风暴）。
//   STALE_MAX 1 小时 —— 超过就明说「这份读数太旧」，不拿三小时前的结论冒充现在。
const ECHO_PROBE_TTL_MS = 10 * 60 * 1000;
const ECHO_PROBE_SPAWN_GAP_MS = 30 * 1000;
const ECHO_PROBE_STALE_MAX_MS = 60 * 60 * 1000;
const ECHO_PROBE_FILE = '_echo-integrity.json';
const ECHO_PROBE_SCRIPT = fileURLToPath(new URL('../db/echo-stats-probe.mjs', import.meta.url));
let echoProbeSpawnedAt = 0;

function echoProbePathOf(dataDir) {
  return path.join(dataDir, ECHO_PROBE_FILE);
}

function readEchoProbeRecord(dataDir) {
  try {
    const raw = fs.readFileSync(echoProbePathOf(dataDir), 'utf8');
    const rec = JSON.parse(raw);
    const at = Date.parse(rec && rec.at);
    return { rec, at: Number.isFinite(at) ? at : null };
  } catch { return null; }
}

/**
 * 起一个子进程去算体检。**只许显式调用**（CLI / 专用端点），不许在请求路径上自动调。
 * @returns {number|null} 子进程 pid；拉不起来 → null
 */
export function spawnEchoProbe(dataDir, echoDb) {
  const now = Date.now();
  if (now - echoProbeSpawnedAt < ECHO_PROBE_SPAWN_GAP_MS) return null;
  echoProbeSpawnedAt = now;
  try {
    const child = spawn(process.execPath, [ECHO_PROBE_SCRIPT, echoProbePathOf(dataDir), echoDb], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    if (child && typeof child.unref === 'function') child.unref();
    return (child && child.pid) || null;
  } catch { return null; }
}

/** 子进程的 JSON → 与 computeEchoIntegrityItem 逐字段同形的 item */
function echoItemFromProbe(rec, ageMs) {
  const age = Number.isFinite(ageMs) ? ageMs : null;
  if (!rec || rec.ok !== true) {
    return Object.assign(
      na('ECHO v9 索引', '后台体检失败（UNKNOWN）：' + String((rec && rec.error) || '未知').slice(0, 150)),
      { probeAgeMs: age, probeAt: (rec && rec.at) || null }
    );
  }
  // ★ available 三态：true=表齐 / false=表不在 / undefined=旧读数没这个字段。
  //   缺失时按 ok 判 —— 不把「旧文件少一个键」读成「表没了」。
  if (rec.available === false || (rec.available === undefined && rec.ok !== true)) {
    return Object.assign(
      na('ECHO v9 索引', 'ECHO v9 表不可用（UNKNOWN）'),
      { probeAgeMs: age, probeAt: rec.at || null }
    );
  }
  const kinds = Array.isArray(rec.problemKinds) ? rec.problemKinds : [];
  // ★ aligned 三态照旧：缺失不许被压成 false（那等于替 Store 宣布「结构歪了」）
  const alignedKnown = rec.aligned === true ? true : (rec.aligned === false ? false : undefined);
  // ★★ 2026-11-17 修：原来判 rec.ok_（echoStats 里的那个键）。但探针输出的 ok
  //   是「探针自己成功了」，字段名也没有下划线 —— 于是 healthy 恒为 false，
  //   面板永远显示 DEGRADED。**这正是「读数本身在说谎」那种形状**：
  //   索引是好的，界面却一直报坏，而报坏的理由指向一个不存在的字段。
  //   判据改成它真正该看的两件事：对齐（aligned）与问题数（problems）。
  const problemN = Number.isFinite(rec.problems)
    ? rec.problems
    : (Array.isArray(rec.problemKinds) ? rec.problemKinds.length : null);
  const healthy = alignedKnown === true && problemN === 0;
  const sub = [
    'words ' + (Number.isFinite(rec.words) ? rec.words : '?'),
    'summaries ' + (Number.isFinite(rec.summaries) ? rec.summaries : '?'),
    'problems ' + (Number.isFinite(rec.problems) ? rec.problems : '?') + (kinds.length ? ' [' + kinds.join(', ') + ']' : ''),
    'search ' + (rec.searchable === true ? '可用' : '已闸住'),
    '体检 ' + (Number.isFinite(rec.ms) ? Math.round(rec.ms / 1000) + 's' : '?'),
  ].join(' · ');
  const item = {
    label: 'ECHO v9 索引',
    value: healthy ? 'OK' : 'DEGRADED',
    unit: '',
    bad: !healthy,
    sub,
    available: true,
    aligned: alignedKnown,
    ok: healthy,
    searchable: rec.searchable === true,
    problemKinds: kinds,
    counts: {
      words: Number.isFinite(rec.words) ? rec.words : null,
      summaries: Number.isFinite(rec.summaries) ? rec.summaries : null,
      problems: Number.isFinite(rec.problems) ? rec.problems : null,
    },
    probeAgeMs: age,
    probeAt: rec.at || null,
  };
  if (age !== null && age > ECHO_PROBE_STALE_MAX_MS) {
    item.stale = true;
    item.sub = '★ 读数已过期（' + Math.round(age / 60000) + ' 分钟前）· ' + sub;
  }
  return item;
}

function computeEchoIntegrityItem(config, opts) {
  const o = opts || {};
  const dataDir = config && config.dataDir;
  const echoDb = o.echoDbPath || (config && config.memory && config.memory.libraryDir
    ? path.join(config.memory.libraryDir, config.memory.indexFile || 'meta.sqlite')
    : (dataDir ? path.join(dataDir, 'meta.sqlite') : null));
  const injectedStore = o.echoStore || null;
  if (!injectedStore && !echoDb) return na('ECHO v9 索引', '没有 meta.sqlite 路径（UNKNOWN；未检查）');
  if (!injectedStore && !fs.existsSync(echoDb)) return na('ECHO v9 索引', 'meta.sqlite 不存在（UNKNOWN；未检查）');

  let store = injectedStore;
  let owned = false;
  try {
    if (!store) {
      store = openMetaStore({ path: echoDb, mode: 'readonly' });
      owned = true;
    }
    const stats = store.echoStats();
    if (!stats || stats.available !== true) {
      return na('ECHO v9 索引', (stats && stats.why) || 'ECHO v9 表不可用（UNKNOWN）');
    }
    const problems = Array.isArray(stats.problems) ? stats.problems : [];
    const kinds = Array.from(new Set(problems.map((x) => x && x.kind).filter(Boolean))).sort();
    // ★ 2026-11-15：aligned 是**三态**，不是布尔。缺失（undefined / Store 根本没报这一列）
    //   不能被压成 false —— 压了就等于替 Store 宣布「结构歪了」，那是**谎报故障**，
    //   severity 会落到 error；如实保留 undefined 才是「不知道对没对齐」，severity 落 warn。
    const alignedKnown = stats.aligned === true ? true : (stats.aligned === false ? false : undefined);
    const healthy = alignedKnown === true && stats.ok === true;
    const sub = [
      'words ' + (Number.isFinite(stats.words) ? stats.words : '?'),
      'summaries ' + (Number.isFinite(stats.summaries) ? stats.summaries : '?'),
      'problems ' + problems.length + (kinds.length ? ' [' + kinds.join(', ') + ']' : ''),
      'search ' + (stats.searchable === true ? '可用' : '已闸住')
    ].join(' · ');
    return {
      label: 'ECHO v9 索引', value: healthy ? 'OK' : 'DEGRADED', unit: '', bad: !healthy,
      sub, available: true,
      aligned: alignedKnown, ok: stats.ok === true, searchable: stats.searchable === true,
      problemKinds: kinds,
      counts: { words: Number.isFinite(stats.words) ? stats.words : null, summaries: Number.isFinite(stats.summaries) ? stats.summaries : null, problems: problems.length }
    };
  } catch (e) {
    return na('ECHO v9 索引', '读取失败（UNKNOWN）：' + String((e && e.message) || e).slice(0, 180));
  } finally {
    if (owned && store && typeof store.close === 'function') {
      try { store.close(); } catch { /* read result must survive close errors */ }
    }
  }
}

export function readOpsLayer(ctx) {
  const { config, core, opts } = ctx;
  const p = coreTag(opts.core);
  const items = [];
  const dataDir = (config && config.dataDir) || null;

  // ECHO v9 integrity uses the sole meta.sqlite through the readonly Store facade.
  const echoIntegrity = readEchoIntegrityItem(config, opts);
  items.push(echoIntegrity);

  // ★ 2026-11-15：严重度按「能不能用」分级。旧式 `na ? warn : aligned===false ? error : warn`
  //   把**健康**也报成 warn（available / aligned / ok / searchable 全 true、problems 空，照样 warn），
  //   于是 warn 同时表示「不知道」和「好的」—— 界面上再也分不出哪一种。
  //   四档（判据只看 ECHO 那一行，不吃别的运维项）：
  //     na / unavailable                 → warn（不知道；既不是坏了，也不是好了）
  //     aligned === false                → error（结构不对齐 → 搜索闸已关）
  //     aligned === true 且 ok === true  → ok（健康：**两票都要有**，缺一票不算健康）
  //     aligned === true 但 ok !== true  → warn（非致命：元数据审计有账，搜索仍可用）
  //     aligned 缺失（undefined）        → warn（没报过对齐＝不知道；不许被 ok===true 抬成 ok）
  //   ★ 2026-11-15 补的边角：旧判据写成 `ok === true → ok`，于是「aligned 没报、ok 说 true」
  //     也能算健康 —— 而契约是 aligned===true **且** ok===true。缺一票就退回 warn：
  //     不冒充 ok（没证据说健康），也不升 error（没证据说歪了）。
  //   ★ 只改这一层的 level；items / provenance / 脱敏 / 服务存活判据一个字没动
  //     （HTTP 200 与 body.ok 由 server.mjs 决定，不读这个 level）。
  const echoLevel = (echoIntegrity.na === true || echoIntegrity.available !== true) ? 'warn'
    : (echoIntegrity.aligned === false ? 'error'
      : (echoIntegrity.aligned === true && echoIntegrity.ok === true ? 'ok' : 'warn'));

  // shutdown.log
  let shut = null, shutStat = null;
  if (dataDir) {
    const f = path.join(dataDir, 'shutdown.log');
    shutStat = safeStat(f);
    if (shutStat) {
      try {
        const ls = fs.readFileSync(f, 'utf8').split('\n').filter((s) => s.trim());
        shut = ls.length ? JSON.parse(ls[ls.length - 1]) : null;
        if (shut) shut.lines = ls.length;
      } catch { shut = { parseError: true }; }
    }
  }
  items.push(shutStat
    ? row('优雅退出记录', shut && shut.graceful ? 'graceful（' + (shut.reason || '?') + '）' : '非优雅（' + (shut && shut.reason ? shut.reason : '?') + '）',
      '', { at: shut && shut.at && Number.isFinite(Date.parse(shut.at)) ? hm(Date.parse(shut.at)) : hm(shutStat.mtimeMs) })
    : na('优雅退出记录', 'data/shutdown.log 不存在 —— 从没落成过文件'));

  // 备份
  const bDirs = [];
  if (dataDir) bDirs.push(path.join(dataDir, '_backup'));
  // ★ 2026-11-10（R1）：开发机备份目录只在它存在时才纳入读数（分发版没有它）。
  const devBackup = devPathOr('backupDir', null);
  if (devBackup) bDirs.push(devBackup);
  let bTotal = 0, bOk = false;
  for (const d of bDirs) {
    try { bTotal += fs.readdirSync(d).length; bOk = true; } catch { /* 不存在就跳过 */ }
  }
  const backupSub = 'data/_backup' + (devBackup ? ' + ' + devBackup : '');
  items.push(bOk ? row('备份副本', bTotal, '个', { sub: backupSub })
    : na('备份副本', '两个备份目录都不存在'));

  // 回声哨兵 —— ★ 2026-11-10（F 切片）：读**哨兵的真实结果文件**，不再写死「未运行」。
  //
  //   三态必须在界面上长得不一样（这一条是这次改动的核心）：
  //     ① 没有结果            → UNKNOWN + 说清「没跑过」；
  //     ② 有结果但探测失败    → 「探测失败：<原因>」+ 时刻（**不许显示成健康**）；
  //     ③ 有结果且探测成功    → 真实 state + 总判 + 各档计数 + 延迟 + 时刻（过期要标出来）。
  //   ★ 只读：这里不触发探测。探测由 index.mjs 的启动那一次、/api/echo-sentinel 的按需那一次负责。
  const sen = readEchoSentinel({
    dataDir,
    ttlMs: (config && config.integrations && config.integrations.echoProbeTtlMs) || undefined,
  });
  if (!sen.ok) {
    items.push(na('ECHO 源域体检（外部旧 doctor）', sen.why || '没有可信结果（UNKNOWN）'));
  } else if (!sen.record || sen.record.probeOk !== true) {
    // ★ 探测本身失败：这不是「回声坏了」，也不是「回声好了」—— 是**不知道**。
    items.push({
      label: 'ECHO 源域体检（外部旧 doctor）', value: null, unit: '', na: true,
      why: '探测失败：' + String((sen.record && sen.record.error) || '未知原因'),
      at: sen.at && Number.isFinite(Date.parse(sen.at)) ? hm(Date.parse(sen.at)) : '',
    });
  } else {
    const c = sen.record.counts || {};
    const bits = [
      '总判 ' + (sen.record.overall || '?'),
      '错 ' + (c.error ?? '?') + ' / 警 ' + (c.warn ?? '?') + ' / 好 ' + (c.ok ?? '?'),
      sen.record.latencyMs != null ? '延迟 ' + sen.record.latencyMs + 'ms' : '延迟 —',
      'echo-doctor --fast',
    ];
    if (sen.stale) bits.push('★ 结果已过期，不是「现在」');
    const bad = sen.state === 'error' || !['ok', 'warn'].includes(sen.state);
    items.push({
      label: 'ECHO 源域体检（外部旧 doctor）',
      value: String(sen.state || 'unknown').toUpperCase(),
      unit: '',
      bad,
      at: sen.at && Number.isFinite(Date.parse(sen.at)) ? hm(Date.parse(sen.at)) : '',
      sub: bits.join(' · '),
    });
  }

  // 定点清理 —— ★ 2026-11-10（E 切片）：最近一条回执/失败原因。
  //   ★ 「没有回执」也是信息：它说明这台实例**从没调用过**，而不是调用过但坏了。
  const cl = readCleanupState({ dataDir });
  if (!cl.ok || !cl.last) {
    items.push(na('定点清理', cl.why || '还没有回执（从未调用过）'));
  } else {
    const l = cl.last;
    const when = l.at && Number.isFinite(Date.parse(l.at)) ? hm(Date.parse(l.at)) : '';
    if (l.ok) {
      const bits = [
        String(l.targetSession || '?'),
        // ★ 目标从哪来的（caller / autonomy.targetSession / heartbeat-lead）——
        //   交接之后「为什么清的是这个会话」必须能在这张卡上回答，而不是去翻代码。
        l.targetSource ? '来源 ' + l.targetSource : '',
        l.coverage || '',
        (Number.isFinite(l.framesAffected) ? l.framesAffected : '?') + ' 帧',
        l.bytesAffected == null ? '字节未量（宿主没给）' : l.bytesAffected + ' B',
        l.host ? '宿主 ' + l.host : '',
        l.pointer || '',
      ].filter(Boolean);
      items.push({ label: '定点清理', value: '成功 ' + String(l.opId || '').slice(0, 24), unit: '', at: when, sub: bits.join(' · ') });
    } else {
      items.push({
        label: '定点清理', value: null, unit: '', na: true,
        why: '失败 [' + (l.stage || '?') + ']' + (l.targetSource ? '（目标来源 ' + l.targetSource + '）' : '')
          + ' ' + String(l.reason || '').slice(0, 120),
        at: when,
      });
    }
  }

  // 进程自身
  items.push(row('RSS', core.rssMB, 'MB', { sub: 'node ' + core.node + ' · 已跑 ' + Math.round(core.uptimeSec / 60) + ' 分钟' }));

  return {
    key: 'ops', name: 'Ⅴ · 运维', title: '退出 / 备份 / 哨兵',
    level: echoLevel, items,
    note: 'ECHO v9 索引完整性以独立 ECHO v9 索引行判定；本 ops 层 level 只跟那一行走 —— ok = 已对齐且元数据审计无账，warn = 不知道（na / unavailable）或已对齐但元数据有非致命问题，error = 结构不对齐（搜索闸已关）。旧 doctor 仅报外部文件/日志体检，两者不互相覆盖。',
    provenance: p + ' · meta.sqlite（v4 ECHO integrity） + data/shutdown.log + ' + backupSub + ' + echo-sentinel.json（外部旧 doctor） + cleanup-receipts.json',
  };
}

/**
 * Ⅵ · 事件 —— production reads the live v4 Core Ledger shared with soul_waker and /api/waker.
 * Offline probes may pass statusDir to exercise the legacy file parser explicitly.
 * The shared organs/waker-read.mjs implementation owns normalization and all five views.
 */
export function readEventsLayer(ctx) {
  const { config, opts } = ctx;
  const o = opts || {};
  const p = coreTag(o.core);
  // Production reads the same live Core Ledger used by MCP and /api/waker.
  // Explicit statusDir remains only for offline probes that exercise legacy file parsing.
  const file = o.ledger ? String(o.ledger.file || '(Core ledger)')
    : (o.statusDir ? path.join(o.statusDir, 'lead-waker-台账.json') : wakerLedgerFileOf(config));
  const deliveredFile = o.statusDir ? path.join(o.statusDir, 'lead-waker-已投递.json') : wakerDeliveredFileOf(config);
  const items = [];
  const data = {
    ledgerFile: file, deliveredFile, total: null, stages: null, decisions: null, charters: null,
    counts: null, badge: null, mtimeMs: null, updatedAt: null, ok: false, why: null,
  };

  const led = o.ledger ? readWakerLedger({ ledger: o.ledger }) : readWakerLedger({ file });
  const fmt = (obj) => Object.entries(obj || {}).map(([k, v]) => k + ' ' + v).join(' · ');
  if (led.ok) {
    Object.assign(data, {
      ok: true, total: led.total, stages: led.stages, decisions: led.decisions, charters: led.charters,
      counts: led.counts, badge: led.badge, mtimeMs: led.mtimeMs, updatedAt: led.updatedAt,
      duplicateKeys: led.duplicateKeys, unknownStage: led.unknownStage,
    });
    items.push(row('事件总数', led.total, '条', { at: hm(led.mtimeMs), sub: '全文件扫描 · ' + file }));
    items.push(row('状态分布', fmt(led.stages), '', {
      sub: 'stage 原值，不归一化' + (led.unknownStage ? '；有 ' + led.unknownStage + ' 条是非法 stage（会被当 pending）' : '')
        + (led.duplicateKeys ? '；重复 key ' + led.duplicateKeys + ' 条' : ''),
    }));
    items.push(row('四视图', '要执行 ' + led.counts.act + ' · 待审计 ' + led.counts.audit + ' · 已执行 ' + led.counts.done + ' · 自定 ' + led.counts.auto, '',
      { sub: '与 waker.viewsOf 同一实现；未处理合计 ' + led.badge + '（act ∪ audit）' }));
    items.push(row('判定分布', fmt(led.decisions), '', { sub: 'decision 原值（未判为「未判」）' }));
    items.push(row('宪章结论', fmt(led.charters), '', { sub: 'unchecked 不等于通过' }));
    if (led.last) {
      const lastMs = Date.parse(led.last.t);
      items.push(row('最近一条', String(led.last.title || '').slice(0, 26), '', {
        at: Number.isFinite(lastMs) ? hm(lastMs) : String(led.last.t || '').slice(0, 16),
        sub: String(led.last.from || '').slice(0, 30),
      }));
    } else {
      items.push(na('最近一条', '台账是空的'));
    }
  } else {
    data.why = led.why;
    items.push(na('事件台账', led.why));
  }

  let longWait = false;
  if (o.ledger) {
    // The current v4 deliverer is in-memory and exposed by /api/events; do not
    // present the retired lead-waker delivery JSON as a current live metric.
    items.push(na('v4投递状态', '当前回执见 /api/events 的 deliverer.view'));
  } else {
    const dl = readWakerDelivered({ file: deliveredFile });
    if (dl.ok) {
      data.delivered = { sent: dl.sent, inflight: dl.inflight, maxWaitMs: dl.maxWaitMs, pollAgoMs: dl.pollAgoMs, fails: dl.fails, dayCount: dl.dayCount, mtimeMs: dl.mtimeMs };
      items.push(row('旧投递记录', dl.sent, '条', { sub: '历史文件 · 今日 ' + (dl.dayCount || 0) + ' · 失败重试 ' + dl.fails + ' 次' }));
      items.push(row('旧轮询记录', dl.pollAgoMs === null ? '—' : (dl.pollAgoMs < 60000 ? '刚刚' : Math.round(dl.pollAgoMs / 60000) + ' 分钟前'), '',
        { sub: 'lastPollAt · 文件 ' + hm(dl.mtimeMs) }));
      items.push(dl.inflight
        ? row('旧未回执记录', dl.inflight + ' 条', '', {
          sub: '最长已等 ' + (dl.maxWaitMs > 3600000 ? (dl.maxWaitMs / 3600000).toFixed(1) + ' 小时' : Math.round(dl.maxWaitMs / 60000) + ' 分钟'),
          bad: dl.maxWaitMs > 3600000,
        })
        : row('旧未回执记录', '0 条', ''));
      longWait = dl.maxWaitMs > 3600000;
    } else {
      items.push(na('旧投递记录', dl.why));
    }
  }
  // ★ 2026-11-11：**「文件不存在」不是「错误」**。
  //   台账还没接过（本机 dist 装在 workspace、真台账在书房 30-状态）——那是「还没接线」，
  //   画成 error 会让人以为坏了。真正的 error 只留给「文件在、但读不动 / 格式坏了」。
  //   这条与项目里「读不到写 null 不写 0」是同一条纪律的另一面：坏与空必须分得开。
  const noLedgerFile = !led.ok && /不存在|ENOENT|no such file/i.test(String(led.why || ''));
  return {
    key: 'events', name: 'Ⅵ · 事件', title: '台账 / 投递 / 唤醒',
    level: !led.ok ? (noLedgerFile ? 'warn' : 'error') : (longWait ? 'warn' : 'ok'), items, data,
    note: o.ledger
      ? '当前事件权威源：AgentSoul v4 Core soul_waker（ingest / decide 同一份Ledger）；旧状态目录快照不参与当前读数。'
        + (longWait ? ' 另有旧投递记录超过 1 小时未更新。' : '')
      : (noLedgerFile ? '兼容文件源不存在：' + file + '（离线探针/旧数据未接入）' : '兼容文件源：' + file)
        + (longWait ? ' 有旧投递记录卡了 1 小时以上。' : ''),
    provenance: p + ' · ' + file + (led.ok ? '（' + led.total + ' 条 · mtime ' + hm(led.mtimeMs) + '）' : ''),
  };
}

// ── 8 · 总装 ──────────────────────────────────────────────────────────

/**
 * 一次拿全。**任何一层读失败都不许让整个请求挂掉** —— 每层独立 try/catch。
 * @param {{config:object, store?:object, persona?:object, tools?:object, ledger?:object,
 *          autonomy?:object, loop?:object, dshHome?:string, configFile?:string, statusDir?:string, echoDbPath?:string, echoStore?:object}} opts
 *   ★ loop（2026-11-10）：把换气判定表交给读模型 —— `loop.__huanqiByRound` 是器官正在用的那一份。
 *     不给就是「无读数 + 原因」，不是 0。
 */
export async function gatherStatus(opts) {
  const o = opts || {};
  const t0 = Date.now();
  const config = o.config || {};
  const core = readCore(config, o);
  const opts2 = Object.assign({}, o, { core });
  const tag = coreTag(core);

  const safe = async (fn, fallback) => {
    try { return await fn(); }
    catch (e) {
      const f = Object.assign({}, fallback);
      f.error = String((e && e.message) || e);
      return f;
    }
  };

  /* ★★★ 2026-11-14（第 14 代）：**这九次读盘原来是一条串行的 await 链。**
   *
   * 实测：/api/status 一次 **3285ms**。而它们读的是**互不相干的东西** ——
   *   《墨》水位 / projcache 扫描 / 书房 walk / 运行态 / 能力面 / 归档 / ops / 事件账。
   * 没有任何一步依赖另一步的结果，串起来等于把九个 300ms 叠成三秒。
   * 而面板每切一次页面都拉它：3.3 秒 × 频繁切换 = 界面像死了，core 一直在重 I/O。
   *
   * 现在：**并行**。总耗时 = 最慢那一个，不再等于九者之和。
   * ★ 这条也是「切页就重新加载」那种卡顿的主因之一 —— 不是前端在乱请求，
   *   是**每一次请求本身就值三秒**。
   */
  // ★★ 2026-11-17：每一层都记一次自己的耗时。
  //   原来只有 tookMs（总），于是「哪一层慢」只能靠拆开跑（拆开就没有真实的并发竞争了）。
  //   现在每层带 ms —— 面板与排障都能直接看出是谁把首屏拖慢的。
  const timed = (fn, fallback) => async () => {
    const t = Date.now();
    const r = await safe(fn, fallback);
    if (r && typeof r === 'object') r.ms = Date.now() - t;
    return r;
  };
  const [lead, active, mirror, echoR, vitalR, capabilityR, archiveR, opsR, eventsR] = await Promise.all([
    timed(() => readLeadWater(config, opts2),
      { ok: false, pct: null, used: null, window: null, source: null, why: '读 lead 水位时抛错' })(),
    timed(() => readActiveWater(config, opts2),
      { ok: false, count: 0, top: null, window: null, items: [], why: '读活跃会话时抛错' })(),
    timed(() => readMirrorWater({ config, store: o.store, persona: o.persona }),
      { pct: null, used: null, window: null, note: '无读数（抛错）' })(),
    timed(() => readEchoLayer({ store: o.store, config, opts: opts2 }), { key: 'echo', items: [], level: 'error' })(),
    timed(() => readVitalLayer({ autonomy: o.autonomy, loop: o.loop, config, opts: opts2 }), { key: 'vital', items: [], level: 'error' })(),
    timed(() => readCapabilityLayer({ tools: o.tools, config, opts: opts2 }), { key: 'capability', items: [], level: 'error' })(),
    timed(() => readArchiveLayer({ config, persona: o.persona, opts: opts2 }), { key: 'archive', items: [], level: 'error' })(),
    timed(() => readOpsLayer({ config, core, opts: opts2 }), { key: 'ops', items: [], level: 'error' })(),
    timed(() => readEventsLayer({ config, opts: opts2 }), { key: 'events', items: [], level: 'error' })(),
  ]);

  const layers = {
    echo: echoR,
    vital: vitalR,
    capability: capabilityR,
    archive: archiveR,
    ops: opsR,
    events: eventsR,
  };

  return {
    at: new Date().toISOString(),
    atMs: Date.now(),
    tookMs: Date.now() - t0,
    core,
    watermarks: {
      lead: {
        pct: lead.pct, used: lead.used, window: lead.window,
        source: lead.source || lead.why || null,
        ok: !!lead.ok, why: lead.why || null,
        // ★★ 2026-11-13：`safe()` 把真实异常写进 `error`，而这里原来**只搬 why 不搬 error** ——
        //   于是抛错时前端只能看到写死的兜底文案（「读 lead 水位时抛错」），真因被吃掉。
        //   这正是「静默」的标准形状：错误存在，但没人看得见。
        error: lead.error || null,
        title: lead.title || null, file: lead.file || null, seq: lead.seq,
        leadBy: lead.leadBy || null, leadAt: lead.leadAt || null,
        leadCount: lead.leadCount || null, leadSummary: lead.leadSummary || null,
        mtimeMs: lead.mtimeMs || null, staleMs: Number.isFinite(lead.staleMs) ? lead.staleMs : null,
      },
      active: {
        count: active.count,
        top: active.top ? { title: active.top.title, pct: active.top.pct, isSub: active.top.isSub } : null,
        window: active.window,
        windowLabel: active.windowLabel, windowMs: active.windowMs,
        items: active.items, latest: active.latest,
        scanned: active.scanned, parsed: active.parsed, unreadable: active.unreadable,
        tookMs: active.tookMs, why: active.why || null, ok: !!active.ok, error: active.error || null,
      },
      mirror: {
        pct: mirror.pct, used: mirror.used, window: mirror.window,
        note: mirror.note || '不是水位，是镜像帧字符估算',
        ruler: mirror.ruler || null, session: mirror.session || null,
        frameCount: mirror.frameCount || null, ok: mirror.ok !== false, error: mirror.error || null,
      },
    },
    layers,
    provenance: {
      readFrom: tag,
      note: '每层的出处写在 layers.*.provenance；三格水位各有自己的 source。',
    },
  };
}