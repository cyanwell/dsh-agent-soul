// 砚台（yantai）—— 把「我现在是什么状态」摊开成一屏。
//
// ★ 来源：老插件 dsh-agent-yantai 的宿主半（761 行）。**照搬的是判断，不是代码。**
//   老那份是 DSH 插件：宿主半 + client.js + /yantai/api/* 路由 + 速达应用清单 + 手机算力节点
//   + 便签/待办/项目三块。这里只留它 README 里点名的四块：
//     水位 / 未结的活 / 最近的账本 / 几扇门。
//   **没搬的三样，理由要说清**（不搬也不假装搬了）：
//     · 速达（应用清单 + 图标 + 启动）：那是「启动器」，不是「我是什么状态」；
//     · 算力节点（手机心跳）：要配一个外部地址，没配就是一格空的 —— 而它对这个软件的能力没有增量；
//     · 便签/待办/项目：那是**写**状态，砚台只读。写状态是别的器官的事。
//
// ★★ 这个文件有两种读者：页面上的人、以及改代码的人。
//   所以「水位是安全网，不是考核」这句话，**在 MOTTO 常量里出现一次**（随接口发出去，页面渲染），
//   **在注释里再出现一次**（给后者）。只写在注释里的原则，界面上的人看不见 —— 那就等于没有。

import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, watermarkOf, usedTokens, WATERMARK } from '../organs/context.mjs';
import { LedgerBase, LABEL, TYPES, normId } from '../organs/ledger.mjs';

/** ★ 这句话必须被渲染出来，不能只躺在注释里。页面里也硬编码了一份（静态 HTML），
 *  理由：接口挂了、JS 没跑，这句话也得在屏幕上 —— 安全网的说明书不能依赖一个 fetch。 */
export const MOTTO = '水位是安全网，不是考核。过线只该触发一个动作 —— 落盘；禁止第二个 —— 缩。';

/** 出处：爀曦 2026-10-14 的原话。写上来是为了让「这不是我的措辞」可核。 */
export const MOTTO_SRC = '2026-10-14：「不要因为上下文紧张，所以自己缩紧思考……它是给你兜底的，不是过来压力你的。」';

/** 水位算哪个会话：太大会话跳过。★ 实测本机有一个 347MB 的 frames.jsonl，
 *  store.load() 是整读 —— 让「打开一个页面」把 347MB 的 JSON 全解析一遍是不可接受的。 */
export const WATER_MAX_BYTES = 16 * 1024 * 1024;

/** 未结的活摆几条。★ 老版固定 9 条（slice(-9)）—— 一屏放得下，不滚动。 */
export const OPEN_LIMIT = 9;
/** 最近的账本摆几条 */
export const RECENT_LIMIT = 12;
/** 多少天算陈账 —— 和 SELF 里「陈账」那个口径对齐 */
export const STALE_DAYS = 7;

const DAY = 86400000;

// ── 小工具 ──────────────────────────────────────────────────

function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 3600000) return Math.max(1, Math.round(ms / 60000)) + ' 分钟前';
  if (ms < DAY) return Math.round(ms / 3600000) + ' 小时前';
  return Math.floor(ms / DAY) + ' 天前';
}

function fmtK(n) {
  if (!Number.isFinite(n)) return '—';
  return n >= 1024 ? Math.round(n / 1024) + 'K' : String(n);
}

/**
 * 一行账本 → 页面要的形状。
 *
 * ★★ 为什么要有这一步：**《墨》的字段分过家。**
 *   老版（348 行）正文写在 text，新版改名叫 概要，另加一个可缺省的 feel（一手感受）。
 *   只认一个字段的后果是：另一半行在界面上一片空白，而且不报错。
 *   —— 老版代码注释里就写着这一条，照搬它。
 */
export function normalizeRow(r, now) {
  const t = String((r && r.t) || '');
  const ms = Date.parse(t);
  const ageMs = Number.isFinite(ms) ? Math.max(0, (now || Date.now()) - ms) : NaN;
  return {
    t,
    type: r && r.type,
    label: (r && LABEL[r.type]) || (r && r.type) || '?',
    by: r && r.by ? String(r.by) : '',
    byNorm: r && r.by ? normId(r.by) : '',
    text: String((r && (r['概要'] !== undefined ? r['概要'] : r.text)) || '').trim(),
    feel: r && r.feel ? String(r.feel) : null,
    ref: r && r.ref ? String(r.ref) : null,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    age: fmtAge(ageMs),
  };
}

// ── 账本：选哪一份 ───────────────────────────────────────────

/**
 * 账本文件在哪 —— 三选一，且**把选中的那一份连同理由写进返回值**。
 *
 * ★★ 为什么不能只写「config.ledger.file || dataDir/ledger.jsonl」：
 *   这个软件里有两本完全不同的账 ——
 *     · 《墨》（书房里的 02-墨.jsonl）：承诺 / 事实 / 搁置 / 得失 / 人格 / 容器，只追加；
 *     · dataDir/ledger.jsonl：soul_ledger 这个 MCP 工具的默认落点（唤醒台账是第三本，别混）。
 *   砚台要看的是「欠着的那些活」，那在《墨》里。选错了**不会报错**，只会安安静静给人看一本空账
 *   —— 「装上、界面在、里面空的」，老版 README 把这种形状点过名，这里不再犯。
 *   所以顺序是：① config.ledger.file 显式配的最优先（谁配谁说了算）；
 *              ② config.soul.root 下真有 02-墨.jsonl 就用它（本机真名）；
 *              ③ 退到 dataDir/ledger.jsonl。
 *   ★ 一个都不存在时**不猜**：把找过的地方全带回去，界面照实说「没找到」。
 */
export function pickLedger(config) {
  const cands = [];
  const lf = config && config.ledger && config.ledger.file;
  if (lf) cands.push({ file: lf, source: 'config.ledger.file' });
  const soul = config && config.soul && config.soul.root;
  if (soul) cands.push({ file: path.join(soul, '02-墨.jsonl'), source: 'config.soul.root + 02-墨.jsonl' });
  if (config && config.dataDir) cands.push({ file: path.join(config.dataDir, 'ledger.jsonl'), source: 'config.dataDir + ledger.jsonl' });

  for (const c of cands) {
    if (fs.existsSync(c.file)) return { ...c, exists: true, tried: cands.map((x) => x.file) };
  }
  return {
    file: cands.length ? cands[cands.length - 1].file : '',
    source: cands.length ? cands[cands.length - 1].source : '(没有可选的账本路径)',
    exists: false,
    tried: cands.map((x) => x.file),
  };
}

/**
 * 拿一个能用的账本对象。
 *
 * ★ 宿主已经把账本接进来时（ctx.ledger 有 all/stats/list），优先用它。
 * ★ 但要**认形状，不认名字**：index.mjs 里那个 ledger 是唤醒台账（organs/waker.mjs 的 Ledger），
 *   它只有 find/ingest/markWoken/decide/views —— 没有 list({type}) / stats()。
 *   把唤醒台账当《墨》用，页面会一片空白而不报错。所以这里做一次能力探测，探不到就自己造一个。
 */
export function ledgerOf(ctx, info) {
  const given = ctx && ctx.ledger;
  if (given && typeof given.all === 'function' && typeof given.stats === 'function' && typeof given.list === 'function') {
    return { L: given, file: given.file || (info && info.file) || '', fromCtx: true };
  }
  // ★★ 文件不存在时**不给 LedgerBase** —— 给一个会「读到 0 条」的实例，界面上就是「账本是空的」，
  //   而真相是「这个文件根本不在」。**空和读不到必须分得开**，这一条是这本砚台最根上的判据
  //   （老版 README 点名过这个形状，自检第 ⑨ 节也有一条单独盯它）。
  if (!info || !info.file || !info.exists) return { L: null, file: (info && info.file) || '', fromCtx: false };
  return { L: new LedgerBase(info.file), file: info.file, fromCtx: false };
}

// ── ① 水位 ──────────────────────────────────────────────────

/**
 * 水位：**引擎下一次真会喂进模型的那个量**。
 *
 * ★★ 这里最容易错的地方是「两把尺子」——老版 README 专门写过。
 *   本软件的引擎（agent/loop.mjs:113-114）拼上下文只有两样：
 *       systemPrompt（人格层 + 时间/水位那几行） + store.recent(sid, context.maxFrames) 的最近 N 帧。
 *   所以「水位」＝ 人格 token + 最近 N 帧的 token，**和引擎用同一条规则**。
 *   ★ 不照抄 context.mjs 的 usedTokens()：它数的是**全部未压缩帧**，会话长到 500 帧时它会高估好几倍。
 *     它仍然有用 —— 但它是**另一把尺子**，所以这里两个都算，各自标名，不混着看。
 *
 * ★ 还有一把尺子更不能混：人格层的 used 是**字节**（Buffer.byteLength），预算也是字节；
 *   而窗口是 **token**。server.mjs 那张「人格占比」卡把 used(字节) 直接除以 window(token) ——
 *   那不是百分比，是两种单位相除（CJK 下大约高估 3 倍）。
 *   这里**没有照抄那行**：人格层用自己的尺子（bytes/budget），水位用 token/token。
 */
export function readWater(ctx) {
  const cfg = (ctx && ctx.config) || {};
  const win = Number(cfg.context && cfg.context.windowTokens) || 1048576;
  const maxFrames = Number(cfg.context && cfg.context.maxFrames) || 60;

  // 人格层（字节口径）
  let pr = null;
  try { pr = ctx.persona && ctx.persona.render ? ctx.persona.render() : null; } catch { pr = null; }
  const personaText = (pr && pr.text) || '';
  const personaTokens = estimateTokens(personaText);
  const persona = pr
    ? {
      used: pr.used,                 // 字节
      budget: pr.budget,             // 字节
      pct: pr.budget ? pr.used / pr.budget : null,
      dropped: pr.dropped || [],
      files: (ctx.persona && Array.isArray(ctx.persona.entries)) ? ctx.persona.entries.length : null,
      ruler: '字节 / 字节（同一把尺子）',
    }
    : null;

  // 挑一个会话：list() 已按 mtime 倒序，取最新的「不太大」的那个
  let sid = null, meta = null, frames = [], skippedBig = 0, why = null;
  try {
    const list = (ctx.store && ctx.store.list ? ctx.store.list() : []) || [];
    const small = list.filter((m) => !Number.isFinite(m.bytes) || m.bytes <= WATER_MAX_BYTES);
    skippedBig = list.length - small.length;
    meta = small[0] || null;
    if (meta && ctx.store.recent) { sid = meta.id; frames = ctx.store.recent(sid, maxFrames) || []; }
  } catch (e) {
    why = String((e && e.message) || e);
  }

  // 帧 token：和 loop 一样只用「最近 N 帧」；被压缩覆盖的区间跳过（与 usedTokens 同判据）
  const covered = [];
  for (const f of frames) {
    const m = f && f.meta;
    if (m && m.kind === 'compaction.summary' && Number.isFinite(m.start) && Number.isFinite(m.end)) covered.push([m.start, m.end]);
  }
  const inCovered = (seq) => covered.some(([a, b]) => seq >= a && seq <= b);
  let frameTokens = 0, frameCount = 0;
  for (const f of frames) {
    if (!f || f.type === 'session') continue;
    if (Number.isFinite(f.seq) && inCovered(f.seq)) continue;
    frameTokens += estimateTokens(f.text) + 4;   // 每帧 4 token 框架开销，与 context.mjs 同口径
    frameCount++;
  }

  const used = personaTokens + frameTokens;
  const wm = watermarkOf(used, win);

  // 另一把尺子：全帧（不截断）。只做对照，不做判据。
  let usedAll = null;
  try { usedAll = sid ? usedTokens(ctx.store, sid, personaText) : null; } catch { usedAll = null; }

  // ★ 过线只指一个动作。这里的措辞就是 MOTTO 的落地：不写「请压缩」，不写「节省」。
  const verdict = !wm ? '还没到该想它的水位 —— 不用缩，也不用为它做什么。'
    : wm.level === 'warn' ? '可以开始考虑整理 —— 听见就够了，不必立刻动手。'
      : wm.level === 'alert' ? '该落盘了：把还没写下来的写进一手层。★ 不是该缩。'
        : '红灯：先落盘 —— 把该留的写进一手层（《墨》一条 / 书房一个文件 / 结论写完整），再让引擎压。★ 动作是落盘，不是缩。';

  return {
    ok: used > 0,
    state: used > 0 ? 'OK' : 'EMPTY',
    hint: used > 0 ? null : '还没有可算的量：人格层没配、会话也没有帧 —— 这不是「水位 0%」，是「没东西可量」。',
    window: win,
    session: sid,
    sessionAge: meta ? fmtAge(Date.now() - meta.mtime) : null,
    sessionBytes: meta ? meta.bytes : null,
    maxFrames,
    skippedBig,
    why,
    personaTokens,
    frameTokens,
    frameCount,
    used,                        // ← 引擎口径：人格 + 最近 N 帧
    usedAll,                     // ← 另一把尺子：人格 + 全部未压缩帧
    left: Math.max(0, win - used),
    leftText: fmtK(Math.max(0, win - used)),
    pct: used / win,
    level: wm ? wm.level : 'ok',
    mark: wm ? wm.text : '还没到 45% —— 不提示',
    verdict,
    ruler: '自有估算：人格层 + 最近 ' + maxFrames + ' 帧（与 agent/loop.mjs 拼上下文同一条规则）。不是服务商回传的 usage。',
    bands: WATERMARK,
    persona,
  };
}

// ── ② 未结的活 ──────────────────────────────────────────────

/**
 * 账本读不到时的那句话。
 * ★ 一定要把「找过哪儿」说出来 —— 否则用户只知道没账，不知道该往哪儿放一本。
 */
function noLedgerHint(tried) {
  const list = Array.isArray(tried) ? tried.filter(Boolean) : [];
  return list.length
    ? '没找到账本文件。找过：' + list.join(' / ') + ' —— 配 config.ledger.file，或配 config.soul.root（下面放 02-墨.jsonl）。'
    : '没有账本可读：config.ledger.file / config.soul.root / config.dataDir 下面都没找到账本文件。';
}

/**
 * 未结的活 —— 《墨》里的 promise + shelved。
 *
 * ★ 为什么这两类放一起：它们是**同一件事的两个状态**（还欠着 / 先放下）。
 *   只显示 promise 会漏掉「搁置了但没结」的，只显示 shelved 会漏掉真欠着的。
 * ★ 陈账单独数：一条 42 天前搁置的账，和昨天搁置的，不是一个紧迫度。
 *   数出来但**不催** —— 砚台是「看一眼」，不是待办清单。
 */
export function readOpen(L, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const limit = o.limit || OPEN_LIMIT;
  if (!L) {
    return { ok: false, code: 'NO_LEDGER', rows: [], total: 0, promise: 0, shelved: 0, stale: 0, oldest: null,
      hint: noLedgerHint(o.tried) };
  }
  const all = [...L.list({ type: 'promise', limit: 100000 }), ...L.list({ type: 'shelved', limit: 100000 })]
    .map((r) => normalizeRow(r, now))
    .sort((a, b) => String(b.t).localeCompare(String(a.t)));

  const staleRows = all.filter((r) => Number.isFinite(r.ageMs) && r.ageMs > STALE_DAYS * DAY);
  const oldest = all.length ? all[all.length - 1] : null;
  let st = null;
  try { st = L.stats(); } catch { st = null; }

  return {
    ok: true,
    rows: all.slice(0, limit),
    total: all.length,
    promise: (st && st.byType && st.byType.promise) || all.filter((r) => r.type === 'promise').length,
    shelved: (st && st.byType && st.byType.shelved) || all.filter((r) => r.type === 'shelved').length,
    stale: staleRows.length,
    staleDays: STALE_DAYS,
    oldest: oldest ? { t: oldest.t, age: oldest.age, ageMs: oldest.ageMs, text: oldest.text.slice(0, 60) } : null,
    hint: all.length ? null : '账本是空的 —— 这一页没有欠着的活。★ 空 ≠ 读不到：文件在，只是没写。',
  };
}

// ── ③ 最近的账本 ────────────────────────────────────────────

/**
 * 最近几条 —— 回答「现在这件事接在哪条线上」。
 *
 * ★ 顺序用**落笔顺序**（LedgerBase.list 就是 append 序倒过来），不按 t 重排：
 *   这本账是只追加的，落笔序天然就是时间序；万一有人补写了旧日期的条目，
 *   那也是「刚写进去的」，摆在最上面才对。★ 而未结的活相反 —— 两个类型的列表拼起来会打乱顺序，
 *   所以那里必须按 t 重排。两处不同，理由不同，别顺手统一。
 */
export function readRecent(L, opts) {
  const o = opts || {};
  const now = o.now || Date.now();
  const limit = o.limit || RECENT_LIMIT;
  if (!L) {
    return { ok: false, code: 'NO_LEDGER', rows: [], total: 0, hint: noLedgerHint(o.tried) };
  }
  const rows = L.list({ limit }).map((r) => normalizeRow(r, now));
  let st = null;
  try { st = L.stats(); } catch { st = null; }
  return {
    ok: true,
    rows,
    total: rows.length,
    stats: st ? { total: st.total, byType: st.byType, first: st.first, last: st.last } : null,
    lead: st && st.lead ? { by: st.lead, norm: st.leadNorm } : null,
    types: TYPES,
    labels: LABEL,
    hint: rows.length ? null : '账本里还没有记录。',
  };
}

// ── ④ 几扇门 ────────────────────────────────────────────────

/**
 * 几扇门 —— 点一下就复制的路径 / 命令。
 *
 * ★★ 一条硬规矩（老版踩过，写在自己文件头）：**没配就是没配，不许拼一条看着像真的假路径。**
 *   老版原来写死了作者机器的 5 条绝对路径，换台机器「插件照样加载成功、界面也在，
 *   只是每一格是空的」—— 静默变空比报错难查得多。
 *   所以每一扇门要么 ready:true 且 cmd 是真能用的，要么 ready:false + why 说明缺哪一项。
 */
export function buildGates(ctx, ledgerInfo) {
  const cfg = (ctx && ctx.config) || {};
  const node = process.execPath || 'node';
  const root = (ctx && ctx.root) || process.cwd();
  const q = (s) => '"' + s + '"';

  const soul = cfg.soul && cfg.soul.root;
  const diary = cfg.diary && cfg.diary.dir;
  const dataDir = cfg.dataDir;
  const port = cfg.port || 7310;
  const ledgerFile = (ledgerInfo && ledgerInfo.file) || '';
  const ledgerOk = Boolean(ledgerFile && ledgerInfo && ledgerInfo.exists);

  const gates = [];

  gates.push({
    id: 'ledger', label: '账本原文', kind: 'path',
    hint: '只追加的那一本 —— 复制路径，用编辑器打开',
    ready: ledgerOk,
    why: ledgerOk ? null : '没找到账本文件（找过：' + ((ledgerInfo && ledgerInfo.tried) || []).join(' / ') + '）',
    cmd: ledgerFile,
    source: ledgerInfo ? ledgerInfo.source : null,
  });

  gates.push({
    id: 'soul', label: '书房根', kind: 'path',
    hint: '日记 / 宪章 / 墨都在这下面',
    ready: Boolean(soul), why: soul ? null : '未配置：config.soul.root',
    cmd: soul || '',
  });

  gates.push({
    id: 'diary', label: '日记目录', kind: 'path',
    hint: '一手层的另一个入口',
    ready: Boolean(diary), why: diary ? null : '未配置：config.diary.dir',
    cmd: diary || '',
  });

  gates.push({
    id: 'data', label: '会话数据', kind: 'path',
    hint: '每个会话一个目录：frames.jsonl（原文）+ index.jsonl（门牌）',
    ready: Boolean(dataDir), why: dataDir ? null : '未配置：config.dataDir',
    cmd: dataDir || '',
  });

  gates.push({
    id: 'selftest', label: '砚台自检', kind: 'cmd',
    hint: '30 项左右，重点查「四块都有值、值来源对」',
    ready: true, why: null,
    cmd: '& ' + q(node) + ' ' + q(path.join(root, 'tools', 'yantai-selftest.mjs')),
  });

  gates.push({
    id: 'serve', label: '起服务', kind: 'cmd',
    hint: 'PowerShell。端口来自 config.port（' + port + '）',
    ready: true, why: null,
    cmd: '$env:AGENT_SOUL_PORT=' + port + '; & ' + q(node) + ' ' + q(path.join(root, 'src', 'index.mjs')),
  });

  gates.push({
    id: 'page', label: '这一页', kind: 'url',
    hint: '路由由 server.mjs 接上之后可直达',
    ready: true, why: null,
    cmd: 'http://127.0.0.1:' + port + '/yantai',
  });

  return { ok: true, rows: gates, ready: gates.filter((g) => g.ready).length, total: gates.length };
}

// ── 汇总 ────────────────────────────────────────────────────

/**
 * 四块一次给全 —— 界面开局只要一个请求。
 *
 * ★ 每一块各自独立失败：读不到水位不许让账本也不显示。
 *   **任何一块都不许让「看一眼状态」这件事本身失败** —— 这是零号要求（和 context.mjs 同一条）。
 *   所以每块都包在自己的 try 里，失败的那块带 code + hint 回去，别的照常。
 */
export async function gather(ctx, opts) {
  const o = opts || {};
  const t0 = Date.now();
  const now = o.now || Date.now();
  const c = ctx || {};
  const cfg = c.config || {};

  const block = (name, f, fallback) => {
    try {
      const r = f();
      if (r && typeof r === 'object' && r.ok === undefined) r.ok = true;
      return r;
    } catch (e) {
      return { ok: false, code: 'THREW', block: name, hint: String((e && e.message) || e), ...(fallback || {}) };
    }
  };

  const ledgerInfo = pickLedger(cfg);
  const led = ledgerOf(c, ledgerInfo);

  const tried = (ledgerInfo && ledgerInfo.tried) || [];
  const water = block('water', () => readWater(c), {});
  const open = block('open', () => readOpen(led.L, { now, limit: o.openLimit, tried }), { rows: [] });
  const recent = block('recent', () => readRecent(led.L, { now, limit: o.recentLimit, tried }), { rows: [] });
  const gates = block('gates', () => buildGates({ ...c, root: o.root }, ledgerInfo), { rows: [] });

  return {
    at: new Date(now).toISOString(),
    tookMs: Date.now() - t0,
    motto: { text: MOTTO, src: MOTTO_SRC },
    ledger: {
      file: led.file,
      exists: Boolean(ledgerInfo && ledgerInfo.exists),
      source: (ledgerInfo && ledgerInfo.source) || null,
      fromCtx: led.fromCtx,          // true = 用的是宿主接进来的那个实例
      tried: (ledgerInfo && ledgerInfo.tried) || [],
    },
    water, open, recent, gates,
    paths: {
      soul: (cfg.soul && cfg.soul.root) || null,
      diary: (cfg.diary && cfg.diary.dir) || null,
      dataDir: cfg.dataDir || null,
      port: cfg.port || null,
    },
  };
}
