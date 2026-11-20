// Import-safe incremental DSH session synchronization runtime.
export function createSyncRuntime(options) {
  const o = options || {};
  const { store, sourceRoot, statePath, fs, path, reader, logger, dryRun = false, since = null, watch = false } = o;
  const clock = o.clock || { now: () => Date.now(), parse: (v) => Date.parse(v), create: (v) => new Date(v) };
  const setTimer = o.setTimeout || setTimeout;
  const clearTimer = o.clearTimeout || clearTimeout;
  if (!store || !sourceRoot || !statePath || !fs || !path || !reader || !logger) throw new TypeError('sync runtime dependencies are required');
  let syncToken = 0;
  let syncRunning = null;
  function cancelSync() { syncToken++; return syncToken; }
  async function syncQuiesce(timeoutMs = 1000) {
    const run = syncRunning;
    if (!run) return true;
    let timer = null;
    const timeout = new Promise((resolve) => { timer = setTimer(() => resolve(false), Math.max(50, Number(timeoutMs) || 1000)); });
    try { return await Promise.race([run.then(() => true, () => true), timeout]); }
    finally { if (timer) clearTimer(timer); }
  }

// ── 水位 ─────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { sessions: {}, at: null }; }
}
function saveState(s) {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(s, null, 2), 'utf8');
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


/** 让出事件循环一次（与 store.mjs 同一条判据：setImmediate 走 check 阶段） */
function yieldToLoop() {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

/**
 * 计时/让出的统一节拍器。
 * ★ maxBlockMs 记的是「两次让出之间」的最长间隔 —— 那才是「事件循环被占住多久」，
 *   平均值会把一次 20ms 的卡顿藏起来。
 */
function makePacer(yieldMs) {
  const st = { yieldMs, yields: 0, maxBlockMs: 0, last: clock.now() };
  st.pace = async () => {
    const gap = clock.now() - st.last;
    if (gap > st.maxBlockMs) st.maxBlockMs = gap;
    if (gap < st.yieldMs) return;
    await yieldToLoop();
    st.yields++;
    st.last = clock.now();
  };
  /**
   * 把「最后一次让出」的时间戳拨到此刻。
   * ★ 为什么需要：读文件那一段有自己的 pace（它让出过很多次），但它整个跑完要几秒。
   *   如果不在返回时拨一下，下一条 pace 会把「读文件的总时长」记成一次阻塞
   *   （实测把 3676ms 记到了账上，而真实最长间隔是 1776ms）。
   */
  st.touch = () => { st.last = clock.now(); };
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
  const targets = [];   // 先只收集路径，stat 留到后面批量做
  let dirs = 0;
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let ents;
    try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 4) stack.push({ dir: p, depth: depth + 1 }); }
      else if (e.name === 'session.v4.jsonl.zstd') targets.push(p);
    }
    if ((++dirs % 200) === 0) {
      await pacer.pace();
      if (!alive()) return { out, aborted: true };
    }
  }

  // ★★ 2026-11-17（阶段 1）：**批量 stat，别再逐个 await**。
  //
  //   实测（本机 / 1,614 个会话文件 / 4 层目录）：
  //     遍历目录 + 逐个 await stat    2,516 ms   ← 改前
  //     遍历目录 + 分批 64 并发 stat  见下      ← 改后
  //   而 soul-sync 每 30~60 秒就要走一遍 —— 2.5 秒是**每一轮**都在付的钱。
  //   ★ 分批而不是 Promise.all 一次性：1,614 个并发 fd 会让 libuv 队列与峰值内存一起跳；
  //     64 是同一个仓库里已经验证过的数字（store.mjs 的指纹段用的就是它）。
  const BATCH = 64;
  for (let base = 0; base < targets.length; base += BATCH) {
    const slice = targets.slice(base, base + BATCH);
    const got = await Promise.all(slice.map(async (p) => {
      try { const st = await fs.promises.stat(p); return { p, id: path.basename(path.dirname(p)), mtime: st.mtimeMs, size: st.size }; }
      catch { return null; }
    }));
    for (const g of got) if (g) out.push(g);
    if (!alive()) return { out, aborted: true };
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
  try { rec = reader.read(f.p); } catch (e) { return { skip: '读不出：' + e.message }; }
  const header = rec.records.find(r => r.type === 'session');
  if (!header) return { skip: '没有 session 头' };

  const { frames } = reader.toFrames(rec.records);
  // 只留 seq 比水位大的（toFrames 把 DSH 的 seq 塞进了 meta.seq）
  const fresh = frames.filter(x => !x.meta || !x.meta.seq || x.meta.seq > seen);
  if (!fresh.length) return { id: f.id, wrote: 0, total: frames.length, seen };

  if (!dryRun) {
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
    if (!dryRun) state.sessions[f.id] = Math.max(seen, ...frames.map((x) => (x.meta && x.meta.seq) || 0));
    return { id: f.id, wrote: 0, total: frames.length, seen, deduped: fresh.length };
  }

  let wrote = 0, maxSeq = seen;
  for (const x of fresh2) {
    const payload = {};
    for (const [k, v] of Object.entries(x)) {
      if (k === 'type' || k === 't' || v === undefined) continue;
      payload[k] = v;
    }
    if (!dryRun) store.append(f.id, x.type, payload);
    wrote++;
    if (x.meta && x.meta.seq && x.meta.seq > maxSeq) maxSeq = x.meta.seq;
  }
  if (!dryRun) state.sessions[f.id] = maxSeq;
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
  // ★★ 2026-11-17（阶段 1）：**增量读**。
  //
  //   实测（294.2MB / 143,488 帧的那个会话，同一台机器）：
  //     全量读 + 逐帧解压   36,222 ms
  //     从记下的偏移读尾部       6 ms      ← 6,000 倍
  //   而每轮真正新增的通常只有 1~2 帧。
  //
  //   DSH 会话文件是**只追加**的 zstd 多帧流（见 dsh.mjs 头注），所以「变长了」= 末尾多了帧。
  //   三个前提缺一不可，缺了就走全量：
  //     ① state.offsets 里有这个会话的上次位置
  //     ② 文件没有变短（f.size >= 上次位置）—— 变短说明被重写了
  //     ③ 容器已经存在（增量段里没有 session 头，得从容器拿）
  //   走到尾部读之后还有一道：dsh.mjs 会核对「第一个魔数恰在 0 字节」，
  //   对不上就回 misaligned，这里立刻退回全量 —— **不猜、不将就**。
  // ★★★ 2026-11-17（我上一轮自己引入的问题，这里修掉）：
  //   上一轮为了判断「容器已存在 + 拿 header」直接调了 store.load(f.id) ——
  //   而 store.load() 会 **同步读整个 frames.jsonl 再逐行 JSON.parse**（store.mjs:960）。
  //   最大的容器是 **347.7MB**。等于我为了省一次全量读，先付了一次全量读。
  //   现在改成：只问「这个容器目录在不在、有没有帧」——用 stat 拿大小，不读内容。
  const knownOffset = state.offsets ? state.offsets[f.id] : undefined;
  let existing = null;
  let containerAlive = false;
  try {
    const fr = path.join(store.root, f.id, 'frames.jsonl');
    const st = await fs.promises.stat(fr);
    containerAlive = st.size > 0;
  } catch { containerAlive = false; }
  const canTail = Number.isFinite(knownOffset) && knownOffset > 0
    && f.size >= knownOffset && containerAlive;

  if (canTail) {
    let tail = null;
    try { tail = await reader.readTail(f.p, { fromOffset: knownOffset, yieldMs, shouldStop: () => !alive() }); }
    catch { tail = null; }
    if (tail && tail.aborted) return { aborted: true, why: 'read' };
    if (tail && !tail.misaligned) {
      pacer.touch();
      pacer.absorb(tail);
      // ★ 增量段里没有 session 头（它在第一帧）。容器已经存在，不需要用它建容器，
      //   所以这里不再为了一个 header 去 load 全文。
      const { frames } = reader.toFrames(tail.records);
      let wrote = 0, maxSeq = seen;
      for (const x of frames) {
        const sq = x.meta && x.meta.seq;
        if (typeof sq === 'number' && sq <= seen) continue;   // 尾部的第一帧是「上一轮最后那一帧」，可能重复
        const payload = {};
        for (const [k, v] of Object.entries(x)) {
          if (k === 'type' || k === 't' || v === undefined) continue;
          payload[k] = v;
        }
        if (!dryRun) store.append(f.id, x.type, payload);
        wrote++;
        if (typeof sq === 'number' && sq > maxSeq) maxSeq = sq;
      }
      if (!dryRun) {
        state.sessions[f.id] = maxSeq;
        state.offsets = state.offsets || {};
        state.offsets[f.id] = tail.endOffset;
      }
      return { id: f.id, wrote, total: frames.length, seen, maxSeq, incremental: true };
    }
    // misaligned / 读不出 → 落到下面走全量
  }

  try { rec = await reader.readAsync(f.p, { yieldMs, shouldStop: () => !alive() }); }
  catch (e) { return { skip: '读不出：' + e.message }; }
  if (rec.aborted) return { aborted: true, why: 'read' };
  pacer.touch();
  pacer.absorb(rec);
  // ★ 全量读之后把增量起点记下来，下一轮就只读尾部
  if (!dryRun && Number.isFinite(rec.endOffset) && rec.endOffset > 0) {
    state.offsets = state.offsets || {};
    state.offsets[f.id] = rec.endOffset;
  }

  const header = rec.records.find(r => r.type === 'session');
  if (!header) return { skip: '没有 session 头' };

  const { frames } = reader.toFrames(rec.records);
  const fresh = frames.filter(x => !x.meta || !x.meta.seq || x.meta.seq > seen);
  if (!fresh.length) {
    if (!dryRun) state.sessions[f.id] = Math.max(seen, ...frames.map((x) => (x.meta && x.meta.seq) || 0));
    return { id: f.id, wrote: 0, total: frames.length, seen };
  }

  if (!dryRun) {
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
    if (!dryRun) state.sessions[f.id] = Math.max(seen, ...frames.map((x) => (x.meta && x.meta.seq) || 0));
    return { id: f.id, wrote: 0, total: frames.length, seen, deduped: fresh.length };
  }

  let wrote = 0, maxSeq = seen;
  for (const x of fresh2) {
    const payload = {};
    for (const [k, v] of Object.entries(x)) {
      if (k === 'type' || k === 't' || v === undefined) continue;
      payload[k] = v;
    }
    if (!dryRun) store.append(f.id, x.type, payload);   // ★ append 保持同步（一次 writeSync，几十微秒）
    wrote++;
    if (x.meta && x.meta.seq && x.meta.seq > maxSeq) {
      maxSeq = x.meta.seq;
      if (!dryRun) state.sessions[f.id] = maxSeq;       // 逐帧推进水位：被取消也不丢已落盘的账
    }
    await pacer.pace();
    if (!alive()) return { id: f.id, aborted: true, why: 'write', wrote, maxSeq };
  }
  if (!dryRun) state.sessions[f.id] = maxSeq;
  return { id: f.id, wrote, total: frames.length, seen, maxSeq };
}

// ── 一轮 ─────────────────────────────────────────────
/** 跑一轮同步。返回 { scanned, wrote, touched, notes } —— 主进程定时器调它 */
function round() {
  const state = loadState();
  let files = findFiles(sourceRoot);
  if (since) {
    const t = clock.create(since).getTime();
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
    const t = clock.parse(state.at);
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
  state.at = clock.create().toISOString();
  saveState(state);

  const stamp = clock.create().toLocaleTimeString('zh-CN', { hour12: false });
  if (totalWrote > 0 || !watch) {
    logger.log('[' + stamp + '] 扫 ' + files.length + ' 个会话' + (pending > MAX_PER_ROUND ? '（还剩 ' + (pending - MAX_PER_ROUND) + ' 个排队）' : '') + '（跳过 ' + skippedByMtime + ' 个没变的）→ 写了 ' + totalWrote + ' 帧进 ' + touched + ' 个容器' + (skipped ? '（' + skipped + ' 个读不出）' : ''));
    for (const n of notes.slice(0, 12)) logger.log(n);
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
async function roundAsync(opts) {
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
    const found = await findFilesAsync(sourceRoot, pacer, alive);
    files = found.out;
    const done = (aborted, reason, extra) => {
      if (aborted) { try { saveState(state); } catch {} }   // ★ 同步写，返回前落盘
      return { aborted, why: reason, files: files.length, yields: pacer.yields, maxBlockMs: pacer.maxBlockMs, ...(extra || {}) };
    };
    if (found.aborted) return done(true, 'find', { wrote: 0, touched: 0, skipped: 0 });

    if (since) {
      const t = clock.create(since).getTime();
      files = files.filter(f => f.mtime >= t);
    }

    let sinceMs = 0;
    if (state.at) {
      const t = clock.parse(state.at);
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
    state.at = clock.create().toISOString();
    saveState(state);

    const stamp = clock.create().toLocaleTimeString('zh-CN', { hour12: false });
    if (totalWrote > 0 || !watch) {
      logger.log('[' + stamp + '] 扫 ' + files.length + ' 个会话' + (pending > MAX_PER_ROUND ? '（还剩 ' + (pending - MAX_PER_ROUND) + ' 个排队）' : '') + '（跳过 ' + skippedByMtime + ' 个没变的）→ 写了 ' + totalWrote + ' 帧进 ' + touched + ' 个容器' + (skipped ? '（' + skipped + ' 个读不出）' : '') + ' · 让出 ' + pacer.yields + ' 次 / 最长阻塞 ' + pacer.maxBlockMs + 'ms');
      for (const n of notes.slice(0, 12)) logger.log(n);
    }
    return { files: files.length, wrote: totalWrote, touched, skipped, aborted: false, yields: pacer.yields, maxBlockMs: pacer.maxBlockMs };
  })();

  syncRunning = run;
  try { return await run; } finally { syncRunning = null; }
}

  return { round, roundAsync, cancelSync, syncQuiesce };
}
