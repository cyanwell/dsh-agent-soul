// DSH → agent-soul 增量同步
//
// ★ 这个文件是「C 方案」的 DSH 适配器：**只读 DSH 的日志文件，不进 DSH 进程**。
//   所以 DSH 怎么升级插件系统，都不影响它 —— 它只认 `session.v4.jsonl.zstd` 这个文件名和格式。
//   格式变了，改这一个文件就够了，不会连累 20 个组件。
//
// ★ 它加的是「增量」：记一个水位（每个会话同步到第几个 seq），下次只写新的。
//   原来 migrate-all.mjs 是「一次性全量」，跑完就停 —— 那正是「没有进货渠道」的原因。
//
// 用法：
//   node tools/soul-sync.mjs              # 同步一次
//   node tools/soul-sync.mjs --watch      # 常驻，每 5 秒扫一次
//   node tools/soul-sync.mjs --dry        # 只看会写多少，不写
//   node tools/soul-sync.mjs --since 2026-11-07   # 只同步这个时间之后有更新的会话

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { readDshSession, readDshSessionAsync, toFrames } from '../src/migrate/dsh.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const val = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const cfg = loadConfig();
// ★★ 2026-11-07 改成可注入 —— 这是「两条腿看见同一份数据」的关键。
//   原来这里无条件 new 一个 SessionStore：命令行跑没问题，
//   但**挂进主进程**时，主进程自己有 store（还带 index 缓存），
//   两边各写各的 → 主进程看不见我们刚写的帧。
//   所以：主进程调用时把自己的 store 传进来，CLI 用默认的。
let store = new SessionStore(cfg.dataDir);

/** 主进程注入自己的 store（CLI 不调用，用上面那个默认实例） */
export function useStore(s) { store = s; }
const SRC = val('src', 'D:/AI/dsh/home/sessions');
const STATE = path.join(cfg.dataDir, 'sync-state.json');
const DRY = flag('dry');
const WATCH = flag('watch');
const SINCE = val('since', null);

// ── 水位 ─────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { sessions: {}, at: null }; }
}
function saveState(s) {
  if (DRY) return;
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2), 'utf8');
}

// ── 找所有 DSH 会话文件 ───────────────────────────────
function findFiles(root, depth = 0, out = []) {
  if (depth > 4) return out;
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) findFiles(p, depth + 1, out);
    else if (e.name === 'session.v4.jsonl.zstd') {
      try { out.push({ p, id: path.basename(path.dirname(p)), mtime: fs.statSync(p).mtimeMs, size: fs.statSync(p).size }); } catch {}
    }
  }
  return out;
}

// ── 分片/取消（2026-11-10）────────────────────────────
//
// ★ 仿 SessionStore.ixBuildToken 的那套：**每让出一次就回头看一眼令牌**。
//   为什么要：异步轮次期间事件循环是活的 —— 恰恰在这段窗口里用户会关窗。
//   关闭流程能做的唯一一件事，就是让正在跑的这一轮「在下一次让出时收手」，
//   而不是等它把 40 个文件逐帧解完（39MB 单文件实测 3.3 秒）。
let syncToken = 0;
let syncRunning = null;

/** 让出事件循环一次（与 store.mjs 同一条判据：setImmediate 走 check 阶段） */
function yieldToLoop() {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/** 取消正在跑的异步轮次。同步版 round() 不受影响（CLI / 退出路径用的就是它）。 */
export function cancelSync(reason) { syncToken++; return syncToken; }

/**
 * 等正在跑的异步轮次收手 —— **带硬上限**，绝不允许变成「等长帧解析全部结束」。
 * 调用方（关闭流程）先 cancelSync()，再调它；正常情况下它几毫秒就返回，
 * 但如果取消正好落在一次大文件异步读里（读不可中断），最多等 timeoutMs 就走人。
 */
export async function syncQuiesce(timeoutMs = 1000) {
  const run = syncRunning;
  if (!run) return true;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(50, Number(timeoutMs) || 1000));
  });
  try {
    return await Promise.race([run.then(() => true, () => true), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 计时/让出的统一节拍器。
 * ★ maxBlockMs 记的是「两次让出之间」的最长间隔 —— 那才是「事件循环被占住多久」，
 *   平均值会把一次 20ms 的卡顿藏起来。
 */
function makePacer(yieldMs) {
  const st = { yieldMs, yields: 0, maxBlockMs: 0, last: Date.now() };
  st.pace = async () => {
    const gap = Date.now() - st.last;
    if (gap > st.maxBlockMs) st.maxBlockMs = gap;
    if (gap < st.yieldMs) return;
    await yieldToLoop();
    st.yields++;
    st.last = Date.now();
  };
  /**
   * 把「最后一次让出」的时间戳拨到此刻。
   * ★ 为什么需要：读文件那一段有自己的 pace（它让出过很多次），但它整个跑完要几秒。
   *   如果不在返回时拨一下，下一条 pace 会把「读文件的总时长」记成一次阻塞
   *   （实测把 3676ms 记到了账上，而真实最长间隔是 1776ms）。
   */
  st.touch = () => { st.last = Date.now(); };
  /** 把别人的读数合并进来（读文件那一段有自己的 pace） */
  st.absorb = (r) => {
    if (!r) return;
    if (Number(r.yields) > 0) st.yields += Number(r.yields);
    if (Number(r.maxBlockMs) > st.maxBlockMs) st.maxBlockMs = Number(r.maxBlockMs);
  };
  return st;
}

/**
 * 分片版 findFiles —— 同一条遍历，每约 200 个目录让出一次。
 * ★ 用显式栈而不是递归：递归里没法在中间 await 之后安全地继续（也能，但栈深 5 层 ×
 *   每层 200 个目录的写法更容易出错）。遍历顺序不影响结果：调用方会按 mtime 重排。
 * ★ 深度判据与同步版一致：depth 0–4 处理，depth 5 起不看。
 */
async function findFilesAsync(root, pacer, alive) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  let dirs = 0;
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) stack.push({ dir: p, depth: depth + 1 }); }
      else if (e.name === 'session.v4.jsonl.zstd') {
        try { const st = await fs.promises.stat(p); out.push({ p, id: path.basename(path.dirname(p)), mtime: st.mtimeMs, size: st.size }); } catch {}
      }
    }
    if ((++dirs % 200) === 0) {
      await pacer.pace();
      if (!alive()) return { out, aborted: true };
    }
  }
  return { out, aborted: false };
}

// ── 同步一个会话 ──────────────────────────────────────
function syncOne(f, state) {
  // ★★ 2026-11-07 修的一个会毁数据的 bug：
  //   水位文件不存在时 seen=0，于是把「已经迁过的 1008 个会话」全当成新的 ——
  //   dry run 显示要写 16 万帧**重复**。而 append 不查重，写进去就是双份。
  //   修法：容器已经存在时，从它自己的帧里找出「DSH seq 的最大值」当初次水位。
  //   ★ 这一步只在**第一次**跑时算（之后 state 里有值）；算一次的代价是读一个容器的索引。
  let seen = state.sessions[f.id];
  if (seen === undefined) {
    const exist = store.load(f.id);
    if (exist && exist.frames.length) {
      let mx = 0;
      for (const fr of exist.frames) {
        if (fr.meta && typeof fr.meta.seq === 'number' && fr.meta.seq > mx) mx = fr.meta.seq;
      }
      seen = mx;
    } else {
      seen = 0;
    }
  }
  let rec;
  try { rec = readDshSession(f.p); } catch (e) { return { skip: '读不出：' + e.message }; }
  const header = rec.records.find(r => r.type === 'session');
  if (!header) return { skip: '没有 session 头' };

  const { frames } = toFrames(rec.records);
  // 只留 seq 比水位大的（toFrames 把 DSH 的 seq 塞进了 meta.seq）
  const fresh = frames.filter(x => !x.meta || !x.meta.seq || x.meta.seq > seen);
  if (!fresh.length) return { id: f.id, wrote: 0, total: frames.length, seen };

  if (!DRY) {
    const s = store.load(f.id);
    if (!s) store.create(header.cwd || null, header.agentPreset || null, { id: f.id });
  }

  // ★★ 2026-11-07 加的一道保险：**水位之外，再按容器里已有的 meta.seq 去重**。
  //
  //   为什么需要两道：水位（state.sessions）是「上一轮跑到哪」的记忆，
  //   而它是**存在磁盘上的一个 json** —— 它可能没写成功、可能被别的进程覆盖、
  //   可能主进程重启时读的是旧值。**水位一失效，append 就会把同一批帧重写一遍**（append 不查重）。
  //   实测已经发生过：本会话容器里 392 条 meta.seq 重复。
  //
  //   ★ 判据没有变：**容器里已经有这个 seq 的帧，就不再写**。
  //     水位只是加速用的，不是正确性的保证 —— 正确性该由「目标状态」决定，不该由「进度记录」决定。
  const already = new Set();
  try {
    const cur = store.load(f.id);
    if (cur && cur.frames) {
      for (const fr of cur.frames) {
        if (fr.meta && typeof fr.meta.seq === 'number') already.add(fr.meta.seq);
      }
    }
  } catch { /* 读不出来就退回只用水位 */ }
  const fresh2 = already.size ? fresh.filter((x) => !(x.meta && typeof x.meta.seq === 'number' && already.has(x.meta.seq))) : fresh;
  if (!fresh2.length) {
    if (!DRY) state.sessions[f.id] = Math.max(seen, ...frames.map((x) => (x.meta && x.meta.seq) || 0));
    return { id: f.id, wrote: 0, total: frames.length, seen, deduped: fresh.length };
  }

  let wrote = 0, maxSeq = seen;
  for (const x of fresh2) {
    const payload = {};
    for (const [k, v] of Object.entries(x)) {
      if (k === 'type' || k === 't' || v === undefined) continue;
      payload[k] = v;
    }
    if (!DRY) store.append(f.id, x.type, payload);
    wrote++;
    if (x.meta && x.meta.seq && x.meta.seq > maxSeq) maxSeq = x.meta.seq;
  }
  if (!DRY) state.sessions[f.id] = maxSeq;
  return { id: f.id, wrote, total: frames.length, seen, maxSeq };
}

/**
 * 分片版 syncOne —— 与 syncOne **逻辑逐条对应**，只是读文件与写帧之间会让出。
 * ★ 为什么另写一份而不是把 syncOne 改成异步：退出路径（process.on('exit')）
 *   和 CLI 同步跑时用得到同步版，而且同步版是「语义基准」——
 *   A/B 时拿它当对照，比拿一份注释当对照可靠。
 * ★ 水位（state.sessions）在每帧写成功后立刻推进：中途被取消时，
 *   已经落盘的帧不会被下一轮重写（重复写还会被容器 seq 去重兜住，两道都在）。
 */
async function syncOneAsync(f, state, ctx) {
  const { alive, pacer, yieldMs } = ctx;
  let seen = state.sessions[f.id];
  if (seen === undefined) {
    const exist = store.load(f.id);
    if (exist && exist.frames.length) {
      let mx = 0;
      for (const fr of exist.frames) {
        if (fr.meta && typeof fr.meta.seq === 'number' && fr.meta.seq > mx) mx = fr.meta.seq;
      }
      seen = mx;
    } else {
      seen = 0;
    }
  }

  let rec;
  // ★ 语义要对齐：alive() 返回 true=继续，而 dsh.mjs 的 shouldStop 是 true=收手。
  //   第一次集成时把 alive 直接传进去 —— 结果「活着」被判成「该停」，第一次让出就中止。
  //   A/B 的 why='one:read' 就是它抓出来的（不是读失败，是判定反了）。
  try { rec = await readDshSessionAsync(f.p, { yieldMs, shouldStop: () => !alive() }); }
  catch (e) { return { skip: '读不出：' + e.message }; }
  if (rec.aborted) return { aborted: true, why: 'read' };
  pacer.touch();
  pacer.absorb(rec);

  const header = rec.records.find(r => r.type === 'session');
  if (!header) return { skip: '没有 session 头' };

  const { frames } = toFrames(rec.records);
  const fresh = frames.filter(x => !x.meta || !x.meta.seq || x.meta.seq > seen);
  if (!fresh.length) {
    if (!DRY) state.sessions[f.id] = Math.max(seen, ...frames.map((x) => (x.meta && x.meta.seq) || 0));
    return { id: f.id, wrote: 0, total: frames.length, seen };
  }

  if (!DRY) {
    const s = store.load(f.id);
    if (!s) store.create(header.cwd || null, header.agentPreset || null, { id: f.id });
  }

  const already = new Set();
  try {
    const cur = store.load(f.id);
    if (cur && cur.frames) {
      for (const fr of cur.frames) {
        if (fr.meta && typeof fr.meta.seq === 'number') already.add(fr.meta.seq);
      }
    }
  } catch { /* 读不出来就退回只用水位 */ }
  const fresh2 = already.size ? fresh.filter((x) => !(x.meta && typeof x.meta.seq === 'number' && already.has(x.meta.seq))) : fresh;
  if (!fresh2.length) {
    if (!DRY) state.sessions[f.id] = Math.max(seen, ...frames.map((x) => (x.meta && x.meta.seq) || 0));
    return { id: f.id, wrote: 0, total: frames.length, seen, deduped: fresh.length };
  }

  let wrote = 0, maxSeq = seen;
  for (const x of fresh2) {
    const payload = {};
    for (const [k, v] of Object.entries(x)) {
      if (k === 'type' || k === 't' || v === undefined) continue;
      payload[k] = v;
    }
    if (!DRY) store.append(f.id, x.type, payload);   // ★ append 保持同步（一次 writeSync，几十微秒）
    wrote++;
    if (x.meta && x.meta.seq && x.meta.seq > maxSeq) {
      maxSeq = x.meta.seq;
      if (!DRY) state.sessions[f.id] = maxSeq;       // 逐帧推进水位：被取消也不丢已落盘的账
    }
    await pacer.pace();
    if (!alive()) return { id: f.id, aborted: true, why: 'write', wrote, maxSeq };
  }
  if (!DRY) state.sessions[f.id] = maxSeq;
  return { id: f.id, wrote, total: frames.length, seen, maxSeq };
}

// ── 一轮 ─────────────────────────────────────────────
/** 跑一轮同步。返回 { scanned, wrote, touched, notes } —— 主进程定时器调它 */
export function round() {
  const state = loadState();
  let files = findFiles(SRC);
  if (SINCE) {
    const t = new Date(SINCE).getTime();
    files = files.filter(f => f.mtime >= t);
  }

  // ★★ 2026-11-07 加的增量过滤 —— 这条是「同步能不能常驻」的生死线。
  //
  //   事故：挂进主进程后，每 30 秒扫全部 1017 个会话（943MB，逐个 zstd 解压），
  //   **同步的 readFileSync 把事件循环堵死** → HTTP 请求 25 秒拿不到响应。
  //   实测有人（polish-dev）curl 两次数十秒都是 http=000。
  //
  //   ★ 判据：**只有上次同步之后改过的会话才可能变**。
  //     mtime 是文件系统的直接事实，比「水位 + 读完才知道有没有新帧」便宜一个数量级。
  //     早退在这一步，不早退在解压之后 —— 差的是 1017 次解压 vs 几次 stat。
  //
  //   宽限 2 分钟：文件可能正在被写（DSH 每轮 append），mtime 会动；
  //   给一点余量，免得正好卡在写入中间读到半截。
  let sinceMs = 0;
  if (state.at) {
    const t = Date.parse(state.at);
    if (!Number.isNaN(t)) sinceMs = t - 120000;
  }
  const total0 = files.length;
  if (sinceMs > 0) files = files.filter((f) => f.mtime >= sinceMs);
  const skippedByMtime = total0 - files.length;
  files.sort((a, b) => b.mtime - a.mtime);

  // ★★ 2026-11-07 加的限流 —— 这是 polish-dev 实测抓出来的第二半 bug。
  //
  //   现象：**没有水位文件时 sinceMs = 0 → 全扫 1017 个会话**（943MB，逐个 zstd 解压），
  //   主进程的事件循环被堵死，/api/config 25 秒拿不到响应。
  //   ★ 每次重启都会重演一次（新实例如果换了数据目录，水位就是空的）。
  //
  //   ★ 为什么不用「只看最近 24 小时」兜底：那会把更早的会话**永远漏掉** ——
  //     漏掉的数据不会自己回来，而卡 25 秒只是慢。**慢可以忍，丢不行。**
  //
  //   ★ 所以用**限流**：每轮最多处理 N 个，剩下的下轮继续。
  //     因为上面已经按 mtime 倒序排过，所以**最新的先同步** —— 用户立刻能用上，
  //     历史慢慢补（1017 个 ÷ 每轮 40 个 × 30 秒 ≈ 13 分钟补完）。
  const MAX_PER_ROUND = (typeof state.batch === 'number' && state.batch > 0) ? state.batch : 40;
  const pending = files.length;
  if (files.length > MAX_PER_ROUND) files = files.slice(0, MAX_PER_ROUND);

  let totalWrote = 0, touched = 0, skipped = 0;
  const notes = [];
  for (const f of files) {
    const r = syncOne(f, state);
    if (r.skip) { skipped++; continue; }
    if (r.wrote > 0) { totalWrote += r.wrote; touched++; notes.push('  + ' + r.id.slice(0, 28) + '  ' + r.wrote + ' 帧（累计 ' + r.maxSeq + '）'); }
  }
  state.at = new Date().toISOString();
  saveState(state);

  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  if (totalWrote > 0 || !WATCH) {
    console.log('[' + stamp + '] 扫 ' + files.length + ' 个会话' + (pending > MAX_PER_ROUND ? '（还剩 ' + (pending - MAX_PER_ROUND) + ' 个排队）' : '') + '（跳过 ' + skippedByMtime + ' 个没变的）→ 写了 ' + totalWrote + ' 帧进 ' + touched + ' 个容器' + (skipped ? '（' + skipped + ' 个读不出）' : ''));
    for (const n of notes.slice(0, 12)) console.log(n);
  }
  return { files: files.length, wrote: totalWrote, touched, skipped };
}

/**
 * 分片版一轮 —— 主服务（src/index.mjs）用这条。
 *
 * ★ 与 round() 的差别只有「什么时候让出」和「能不能收手」：
 *   找文件每约 200 个目录让出；每个会话读文件时逐帧让出；
 *   写帧循环每攒够 yieldMs 让出。**判定（水位 / 去重 / 限流 / 过滤）一处没动。**
 *
 * ★ 取消（关闭）：syncToken 一变，或 shouldStop() 返回 true，就在下一次让出时收手：
 *   立刻 saveState（同步写）后返回 {aborted:true}，**绝不写下一批**。
 *   ★ 中止时**不更新 state.at**：那个水位是用来做 mtime 增量过滤的，
 *     推它会让还没轮到的旧文件永久落在窗口外。已写会话的水位照常保留。
 *
 * @param {object} [opts]
 * @param {number} [opts.yieldMs=8] 攒够多少毫秒让出一次
 * @param {function} [opts.shouldStop] 额外取消源（主进程传 () => shuttingDown）
 */
export async function roundAsync(opts) {
  const o = opts || {};
  const yieldMs = Number(o.yieldMs) > 0 ? Number(o.yieldMs) : 8;
  const shouldStop = typeof o.shouldStop === 'function' ? o.shouldStop : null;

  // ★ 防重入：同时只允许一路。第二路立刻拿 {busy:true} 回去，**不排队** ——
  //   排队的那个会在关闭时变成「又一个在等长任务结束的人」。
  if (syncRunning) return { busy: true, files: 0, wrote: 0, touched: 0, skipped: 0 };

  const run = (async () => {
    const token = ++syncToken;
    const pacer = makePacer(yieldMs);
    const alive = () => syncToken === token && !(shouldStop && shouldStop());
    const state = loadState();

    let files = [];
    const found = await findFilesAsync(SRC, pacer, alive);
    files = found.out;
    const done = (aborted, reason, extra) => {
      if (aborted) { try { saveState(state); } catch {} }   // ★ 同步写，返回前落盘
      return { aborted, why: reason, files: files.length, yields: pacer.yields, maxBlockMs: pacer.maxBlockMs, ...(extra || {}) };
    };
    if (found.aborted) return done(true, 'find', { wrote: 0, touched: 0, skipped: 0 });

    if (SINCE) {
      const t = new Date(SINCE).getTime();
      files = files.filter(f => f.mtime >= t);
    }

    let sinceMs = 0;
    if (state.at) {
      const t = Date.parse(state.at);
      if (!Number.isNaN(t)) sinceMs = t - 120000;
    }
    const total0 = files.length;
    if (sinceMs > 0) files = files.filter((f) => f.mtime >= sinceMs);
    const skippedByMtime = total0 - files.length;
    files.sort((a, b) => b.mtime - a.mtime);

    const MAX_PER_ROUND = (typeof state.batch === 'number' && state.batch > 0) ? state.batch : 40;
    const pending = files.length;
    if (files.length > MAX_PER_ROUND) files = files.slice(0, MAX_PER_ROUND);

    let totalWrote = 0, touched = 0, skipped = 0;
    const notes = [];
    for (const f of files) {
      if (!alive()) return done(true, 'loop', { wrote: totalWrote, touched, skipped });
      const r = await syncOneAsync(f, state, { alive, pacer, yieldMs });
      if (r.aborted) return done(true, 'one:' + (r.why || '?'), { wrote: totalWrote, touched, skipped });
      if (r.skip) { skipped++; continue; }
      if (r.wrote > 0) { totalWrote += r.wrote; touched++; notes.push('  + ' + r.id.slice(0, 28) + '  ' + r.wrote + ' 帧（累计 ' + r.maxSeq + '）'); }
    }
    state.at = new Date().toISOString();
    saveState(state);

    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    if (totalWrote > 0 || !WATCH) {
      console.log('[' + stamp + '] 扫 ' + files.length + ' 个会话' + (pending > MAX_PER_ROUND ? '（还剩 ' + (pending - MAX_PER_ROUND) + ' 个排队）' : '') + '（跳过 ' + skippedByMtime + ' 个没变的）→ 写了 ' + totalWrote + ' 帧进 ' + touched + ' 个容器' + (skipped ? '（' + skipped + ' 个读不出）' : '') + ' · 让出 ' + pacer.yields + ' 次 / 最长阻塞 ' + pacer.maxBlockMs + 'ms');
      for (const n of notes.slice(0, 12)) console.log(n);
    }
    return { files: files.length, wrote: totalWrote, touched, skipped, aborted: false, yields: pacer.yields, maxBlockMs: pacer.maxBlockMs };
  })();

  syncRunning = run;
  try { return await run; } finally { syncRunning = null; }
}

// ★★ 2026-11-07：这段必须包在「是不是被当作主程序执行」里。
//
//   原因：它是**顶层代码**。被 `import` 时也会跑 —— 而 index.mjs（v4 主进程）现在要 import 它。
//   不包的后果：每次主进程启动都会**跑一次全量扫描 1016 个会话**，启动慢十几秒，
//   而且 WATCH 会读到主进程的 argv（false），于是走 else 分支再跑一次。
//   ★ 这是「看着对，其实没生效」的反面 —— 看着没问题，其实每次 import 都在偷偷干活。
const isMain = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')); }
  catch { return false; }
})();

if (isMain) {
  if (WATCH) {
    console.log('同步器常驻：每 5 秒扫一次 ' + SRC);
    console.log('水位文件：' + STATE);
    round();
    setInterval(() => { try { round(); } catch (e) { console.error('  出错：' + e.message); } }, 5000);
  } else {
    const r = round();
    if (DRY) console.log('（--dry：没有真的写）');
    console.log('水位文件：' + STATE);
  }
}
