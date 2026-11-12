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

/** 书房文件数：按根目录缓存 60 秒（一次全 walk 实测 445ms / 1925 文件，不能每请求都走）。 */
let soulCache = null;
async function fillSoulStats(root) {
  if (!root) return null;
  const now = Date.now();
  if (soulCache && soulCache.root === root && now - soulCache.at < 60000) return soulCache.st;
  try {
    const { SoulIndex } = await import('../organs/soul-scan.mjs');
    const ix = new SoulIndex(root, { ttl: 60000 });
    ix.refresh();
    const s = ix.stats();
    soulCache = { root, at: now, st: s };
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
    // ★ 没建就建一次 —— 与 /api/overview 同一条路（server.warmup 在启动时已经建好，
    //   这里只是兜底：否则刚启动那一秒打开状态台，会看到一个假的「索引行 无读数」）。
    //   代价只在「真的没建」时付一次（0.65s），之后是内存里的 Map。
    if (!store.ixBuilt && typeof store.buildIndex === 'function') {
      try { store.buildIndex(); } catch { /* 建不起来就照实说没建 */ }
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

export function readOpsLayer(ctx) {
  const { config, core, opts } = ctx;
  const p = coreTag(opts.core);
  const items = [];
  const dataDir = (config && config.dataDir) || null;

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
    items.push(na('回声哨兵', sen.why || '没有可信结果（UNKNOWN）'));
  } else if (!sen.record || sen.record.probeOk !== true) {
    // ★ 探测本身失败：这不是「回声坏了」，也不是「回声好了」—— 是**不知道**。
    items.push({
      label: '回声哨兵', value: null, unit: '', na: true,
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
      label: '回声哨兵',
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
    level: 'warn', items,
    note: '哨兵读的是 <dataDir>/echo-sentinel.json 里的**真实探测结果**（没跑过/失败/成功三态分开）；备份只有手工 .bak 源码副本，会话容器本身没有备份。',
    provenance: p + ' · data/shutdown.log + ' + backupSub + ' + echo-sentinel.json + cleanup-receipts.json',
  };
}

/**
 * Ⅵ · 事件 —— **只读**权威台账，全文件扫描，不读渲染后的摘要。
 *
 * ★★ 2026-11-10（三项死读数修复之二）：
 *   这一层原来就读对了路径（<状态目录>/lead-waker-台账.json），但只数 stage.done / stage.held，
 *   不给文件名、不给 mtime，也不给四视图 —— 而真台账里 stage 只有 done/held 两种值，
 *   真正的「要审计没审」藏在 charter=ask 里（本机实测 5 条）。只数 stage 会把它读成 0。
 *
 *   现在：读模型统一走 organs/waker-read.mjs（与 /api/organs 的台账卡、soul_waker 的 state 同一实现），
 *   四视图用 organs/waker.mjs 的 viewsOf（**状态机只有一份**），并强制标出**源路径 + mtime**。
 */
export function readEventsLayer(ctx) {
  const { config, opts } = ctx;
  const o = opts || {};
  const p = coreTag(o.core);
  // ★ 生产只有一条路：config.mjs 的 wakerLedgerFileOf()（目录判据与文件名都在那里）。
  // ★ 夹具旁路（o.statusDir）**只给自检 / 离线探针用**：它把目录直接指到临时目录，
  //   从而绕过上面那份判据 —— 所以文件名在这里出现了第二个字面量。这不是第二套判据：
  //   生产调用点（server.mjs 的 /api/live 与 /api/organs、soul_waker、gatherStatus）都不传
  //   o.statusDir，只有 tools/status-three-readings-selftest.mjs 传（它要指向 %TEMP%）。
  //   ★ 2026-11-10（独立验收 §5.2 后续清理）：这条旁路只加标注，不重构 —— 生产行为一个字没动。
  const file = o.statusDir ? path.join(o.statusDir, 'lead-waker-台账.json') : wakerLedgerFileOf(config);
  const deliveredFile = o.statusDir ? path.join(o.statusDir, 'lead-waker-已投递.json') : wakerDeliveredFileOf(config);
  const items = [];
  const data = {
    ledgerFile: file, deliveredFile, total: null, stages: null, decisions: null, charters: null,
    counts: null, badge: null, mtimeMs: null, updatedAt: null, ok: false, why: null,
  };

  const led = readWakerLedger({ file });
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

  const dl = readWakerDelivered({ file: deliveredFile });
  if (dl.ok) {
    data.delivered = { sent: dl.sent, inflight: dl.inflight, maxWaitMs: dl.maxWaitMs, pollAgoMs: dl.pollAgoMs, fails: dl.fails, dayCount: dl.dayCount, mtimeMs: dl.mtimeMs };
    items.push(row('投递', dl.sent, '条', { sub: '今日 ' + (dl.dayCount || 0) + ' · 失败重试 ' + dl.fails + ' 次' }));
    items.push(row('轮询', dl.pollAgoMs === null ? '—' : (dl.pollAgoMs < 60000 ? '刚刚' : Math.round(dl.pollAgoMs / 60000) + ' 分钟前'), '',
      { sub: 'lastPollAt · 文件 ' + hm(dl.mtimeMs) }));
    items.push(dl.inflight
      ? row('未回执', dl.inflight + ' 条', '', {
        sub: '最长已等 ' + (dl.maxWaitMs > 3600000 ? (dl.maxWaitMs / 3600000).toFixed(1) + ' 小时' : Math.round(dl.maxWaitMs / 60000) + ' 分钟'),
        bad: dl.maxWaitMs > 3600000,
      })
      : row('未回执', '0 条', ''));
  } else {
    items.push(na('投递账', dl.why));
  }

  const longWait = !!(data.delivered && data.delivered.maxWaitMs > 3600000);
  // ★ 2026-11-11：**「文件不存在」不是「错误」**。
  //   台账还没接过（本机 dist 装在 workspace、真台账在书房 30-状态）——那是「还没接线」，
  //   画成 error 会让人以为坏了。真正的 error 只留给「文件在、但读不动 / 格式坏了」。
  //   这条与项目里「读不到写 null 不写 0」是同一条纪律的另一面：坏与空必须分得开。
  const noLedgerFile = !led.ok && /不存在|ENOENT|no such file/i.test(String(led.why || ''));
  return {
    key: 'events', name: 'Ⅵ · 事件', title: '台账 / 投递 / 唤醒',
    level: !led.ok ? (noLedgerFile ? 'warn' : 'error') : (longWait ? 'warn' : 'ok'), items, data,
    note: (noLedgerFile ? '★ 这台机器上还没有事件台账（' + file + ' 不存在）—— 不是故障，是还没接线。' : '★ 读的是 ' + file + '（真事件）') + '，**只读**：本次修复不迁移、不改写权威文件。'
      + '（data/ledger.json 是另一本旧账，本机实测 1 条 2026-11-07 的待办 —— 别再拿它当台账。）'
      + (longWait ? ' 有一条投递卡了 1 小时以上，没有超时判定。' : ''),
    provenance: p + ' · ' + file + (led.ok ? '（' + led.total + ' 条 · mtime ' + hm(led.mtimeMs) + '）' : ''),
  };
}

// ── 8 · 总装 ──────────────────────────────────────────────────────────

/**
 * 一次拿全。**任何一层读失败都不许让整个请求挂掉** —— 每层独立 try/catch。
 * @param {{config:object, store?:object, persona?:object, tools?:object,
 *          autonomy?:object, loop?:object, dshHome?:string, configFile?:string, statusDir?:string}} opts
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

  const lead = await safe(() => readLeadWater(config, opts2),
    { ok: false, pct: null, used: null, window: null, source: null, why: '读 lead 水位时抛错' });
  const active = await safe(() => readActiveWater(config, opts2),
    { ok: false, count: 0, top: null, window: null, items: [], why: '读活跃会话时抛错' });
  const mirror = await safe(() => readMirrorWater({ config, store: o.store, persona: o.persona }),
    { pct: null, used: null, window: null, note: '无读数（抛错）' });

  const layers = {
    echo: await safe(() => readEchoLayer({ store: o.store, config, opts: opts2 }), { key: 'echo', items: [], level: 'error' }),
    vital: await safe(() => readVitalLayer({ autonomy: o.autonomy, loop: o.loop, config, opts: opts2 }), { key: 'vital', items: [], level: 'error' }),
    capability: await safe(() => readCapabilityLayer({ tools: o.tools, config, opts: opts2 }), { key: 'capability', items: [], level: 'error' }),
    archive: await safe(() => readArchiveLayer({ config, persona: o.persona, opts: opts2 }), { key: 'archive', items: [], level: 'error' }),
    ops: await safe(() => readOpsLayer({ config, core, opts: opts2 }), { key: 'ops', items: [], level: 'error' }),
    events: await safe(() => readEventsLayer({ config, opts: opts2 }), { key: 'events', items: [], level: 'error' }),
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
        tookMs: active.tookMs, why: active.why || null, ok: !!active.ok,
      },
      mirror: {
        pct: mirror.pct, used: mirror.used, window: mirror.window,
        note: mirror.note || '不是水位，是镜像帧字符估算',
        ruler: mirror.ruler || null, session: mirror.session || null,
        frameCount: mirror.frameCount || null, ok: mirror.ok !== false,
      },
    },
    layers,
    provenance: {
      readFrom: tag,
      note: '每层的出处写在 layers.*.provenance；三格水位各有自己的 source。',
    },
  };
}