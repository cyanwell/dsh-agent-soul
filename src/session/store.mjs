// 会话存储 —— 写入即索引。
//
// 目录结构：
//   data/sessions/<sessionId>/
//       frames.jsonl     每行一帧（裸文本，不压缩）
//       index.jsonl      每行一条索引（seq / type / t / text）
//
// ★ 索引与写入在同一次调用里完成 —— 这是解耦后的核心约定：
//   索引不再依赖压缩，压缩变成纯可选的后处理。

import fs from 'node:fs';
import path from 'node:path';
import { FRAME, newSessionId, nowMs, sessionHeader, extractText } from './frame.mjs';

/**
 * 把一个查询切成检索单元。
 * ★ 为什么不只用整串：中文没有空格，一个问句很少逐字出现在历史里。
 *   「传输层那件事」必须能搜到「传输层拆分这件事」—— 所以要切。
 *   · 中文：连续的汉字按 2-gram 切（「传输层拆分」→ 传输/输层/层拆/拆分）
 *   · 英文数字：按词切（长度 ≥2 才留，避免 a / is 这种）
 */
export function tokenize(text) {
  const src = String(text || '').toLowerCase();
  const out = new Set();
  const runs = src.match(/[\u4e00-\u9fa5]+|[a-z0-9_]+/g) || [];
  for (const r of runs) {
    if (/^[\u4e00-\u9fa5]+$/.test(r)) {
      if (r.length === 1) { out.add(r); continue; }
      for (let i = 0; i + 2 <= r.length; i++) out.add(r.slice(i, i + 2));
    } else if (r.length >= 2) {
      out.add(r);
    }
  }
  return [...out];
}

/**
 * 只读文件第一行（最多读 4KB）。
 * ★ 不要用 readFileSync().split('\n')[0] —— 那是把整个文件读进内存。
 *   会话文件可以到 300MB+，一次 list 就废了。
 */
function readFirstLine(fp) {
  let fd;
  try {
    fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    if (n <= 0) return '';
    const s = buf.subarray(0, n).toString('utf8');
    const i = s.indexOf('\n');
    return i >= 0 ? s.slice(0, i) : s;
  } catch { return ''; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
}

/**
 * 让出事件循环一次，让排队中的 I/O（HTTP 请求 / 定时器）先跑完它们的回调。
 * ★ setImmediate 走 libuv 的 check 阶段：让出一次几十微秒；setTimeout(0) 在 Windows
 *   上有 ~1ms 的定时器粒度，几百次让出就是几百毫秒 —— 所以优先用前者。
 */
function yieldToLoop() {
  return new Promise((resolve) => {
    if (typeof setImmediate === 'function') setImmediate(resolve);
    else setTimeout(resolve, 0);
  });
}

export class SessionStore {
  constructor(dataDir) {
    this.root = path.join(dataDir, 'sessions');
    fs.mkdirSync(this.root, { recursive: true });
    this.cache = new Map();
    /** 会话缓存上限 —— ★ 不设上限会把堆撑爆：1006 个会话 × 158 帧实测超过 512MB */
    this.maxCache = 64;
    /** 文件句柄缓存 —— 键 'id:frames' / 'id:index'，值 { fd, used } */
    this.fds = new Map();
    this.maxFds = 128;
    /**
     * 内存检索索引 —— Map<sessionId, Array<{seq,t,type,text,tl}>>
     * ★ 为什么要有：不做的时候，一次 searchAll 要读 1006 个 index.jsonl、
     *   解析 16 万行 JSON，实测 11-20 秒。宿主等不起。
     * ★ 存两份：text 原文 + tl 小写。检索只碰 tl，返回用 text。
     */
    this.ix = new Map();
    this.ixBuilt = false;
    this.listCache = null;
    this.listAt = 0;
    /**
     * 索引缓存文件 —— 把 1007 个 index.jsonl 拼成一个大文件，启动读一次。
     * ★ 实测：逐目录读 1006 个文件 + 15 万次 JSON.parse = 6.9 秒；
     *   读一个 71MB 的分隔符文件 = 0.65 秒。差 10 倍。
     * ★ 用 \u0001 分隔而不是 JSON —— JSON.parse 15 万次是大头。
     * ★ 指纹文件 _index.fp 记每个会话 index.jsonl 的 size:mtime，
     *   启动比对，变了的会话重读（只重读那几个）。
     */
    this.cacheFile = path.join(dataDir, '_index.cache');
    this.fpFile = path.join(dataDir, '_index.fp');
    this.ixDirty = false;
    /**
     * 建库令牌 —— 分片建库（buildIndexAsync）每让出一次就回头看一眼它。
     * ★ 为什么需要：分片期间事件循环是活的，任何一次检索都可能走同步 buildIndex
     *   抢先把库建完。**后动手的那个赢**：先动手的分片版看见令牌变了就放弃自己的暂存，
     *   不重复干一遍（3 秒的活干两遍，正是这次要消灭的那种浪费）。
     */
    this.ixBuildToken = 0;
    /** 写索引计数器 —— 分片写缓存期间若它变了，说明有新帧进来，就不许把 dirty 清掉 */
    this.ixRev = 0;
    /** 正在跑的分片建库 Promise（或 null）—— 同时只允许一路 */
    this.ixBuilding = null;
    /** 每帧追加时，把这个会话标脏 */
    this.dirtySessions = new Set();
  }

  dir(id) { return path.join(this.root, id); }

  /** 新建会话（写帧 0） */
  /**
   * 建一个会话容器。
   * ★ id 可选：挂载模式下宿主要用**它自己的**会话 id 跟我们对应。
   *   不给就直接按时间戳造一个。
   *   给了但已经存在 → 返回已存在的那个（不覆盖）。
   */
  create(cwd, preset, opts) {
    const o = opts || {};
    const id = o.id ? String(o.id) : newSessionId();

    const existing = this.load(id);
    if (existing) return existing.header;

    const d = this.dir(id);
    fs.mkdirSync(d, { recursive: true });

    const header = sessionHeader(id, cwd, preset || null);
    fs.writeFileSync(path.join(d, 'frames.jsonl'), JSON.stringify(header) + '\n', 'utf8');
    fs.writeFileSync(path.join(d, 'index.jsonl'), '', 'utf8');

    this.cache.set(id, { header, frames: [header], nextSeq: 1, stamp: this.#stamp(id) });
    this.listCache = null;
    return header;
  }

  /** 列出现有会话（读每个目录的 frames.jsonl 第一行即可） */
  /**
   * 列出所有会话。
   * ★ 有缓存 —— 每次调用要 readdir + 对每个会话读 frames.jsonl 第一行 + stat，
   *   1006 个会话实测 7 秒。检索路径上每次调它，等于每次查询都重扫一遍磁盘。
   *   缓存 TTL 5 秒：刚建的会话 5 秒内可能看不到，但检索都是往回看，够用。
   */
  list(opts) {
    const now = Date.now();
    // ★ 5 秒 → 30 秒（2026-11-07）。理由：1006 个会话重读首行是 1.26 秒，
  //   而会话列表 30 秒才可能变一次。5 秒的 TTL 意味着「几乎每次访问都要重算」，
  //   那不是缓存，那是摆设。
  if (!(opts && opts.fresh) && this.listCache && now - this.listAt < 30000) return this.listCache;
    const out = [];
    for (const name of fs.readdirSync(this.root)) {
      const m = this.#metaOf(name);
      if (m) out.push(m);
    }
    out.sort((a, b) => b.mtime - a.mtime);
    this.listCache = out;
    this.listAt = now;
    return out;
  }

  /** 会话目录 → 一条 meta。不是会话目录 / 坏目录 → null。list 与 buildIndex* 共用一份判定。 */
  #metaOf(name) {
    const f = path.join(this.root, name, 'frames.jsonl');
    if (!fs.existsSync(f)) return null;
    try {
      // ★ 只读头部 4KB —— 原来写的是 readFileSync(f) 然后取第一行，
      //   那是**读整个文件**。实测：1006 个会话 list 一次 6.3 秒，
      //   因为其中一个会话是 308MB。改成只读头 4KB 后掉到 130ms。
      const first = readFirstLine(f);
      if (!first) return null;
      const h = JSON.parse(first);
      if (h.type !== FRAME.SESSION) return null;
      const stat = fs.statSync(f);
      return { id: h.id, cwd: h.cwd, persona: h.persona, createdAt: h.t, mtime: stat.mtimeMs, bytes: stat.size };
    } catch { return null; }
  }

  /** 每个会话 index.jsonl 的指纹 size:mtime。缺失记 '0:0'。 */
  #fpNow(metas) {
    const now = {};
    for (const m of metas) {
      try { const st = fs.statSync(path.join(this.dir(m.id), 'index.jsonl')); now[m.id] = st.size + ':' + st.mtimeMs; }
      catch { now[m.id] = '0:0'; }
    }
    return now;
  }

  /** 缓存文件的一行 → 字段。坏行 → null（当它不存在）。 */
  #splitCacheLine(line) {
    const p = line.split('\u0001');
    if (p.length < 5) return null;
    return { sid: p[0], seq: Number(p[1]), t: Number(p[2]), type: p[3], text: p[4] };
  }

  /**
   * 建内存索引（懒建，第一次检索时触发）。
   * ★ 只读 index.jsonl，不碰 frames.jsonl —— 后者体积大得多。
   * ★★ 这是**同步**版：整块跑完，跑的那几秒里事件循环是死的。
   *   启动期请用 buildIndexAsync —— 否则关窗请求（POST /api/shutdown）
   *   在这几秒里根本进不来，壳等不到就强杀，索引缓存跟着一起没写，
   *   下次启动又是全量重建。这条闭环就是「关了再开还是慢」的真身。
   */
  buildIndex() {
    if (this.ixBuilt) return this.ix.size;
    this.ixBuildToken++;      // ★ 抢跑：正在分片建库的那一路看见令牌变了会让步
    this.ix.clear();

    const metas = this.list();
    const now = this.#fpNow(metas);

    // ① 试缓存
    let fp = null;
    try { fp = JSON.parse(fs.readFileSync(this.fpFile, 'utf8')); } catch {}
    if (fp && fs.existsSync(this.cacheFile)) {
      const t = Date.now();
      try {
        const buf = fs.readFileSync(this.cacheFile, 'utf8');
        let same = 0;
        for (const line of buf.split('\n')) {
          if (!line) continue;
          const r = this.#splitCacheLine(line);
          if (!r) continue;
          if (fp[r.sid] !== now[r.sid]) continue;   // 变过的会话，这行不可信
          let a = this.ix.get(r.sid);
          if (!a) { a = []; this.ix.set(r.sid, a); }
          a.push({ seq: r.seq, t: r.t, type: r.type, text: r.text, tl: r.text.toLowerCase() });
          same++;
        }
        // 只重读变过 / 没出现过的会话
        // ★ 不要加 !this.ix.has(m.id)：空会话（0 帧）在缓存里本来就没有行，
        //   那会把 446 个空会话全判成「没出现过」而重读一遍。
        const need = metas.filter(m => fp[m.id] !== now[m.id]);
        for (const m of need) this.#readOne(m.id);
        // 缓存里没有的会话（空索引）也要建空数组，不然 searchAll 遍历不到
        for (const m of metas) if (!this.ix.has(m.id)) this.ix.set(m.id, []);
        this.ixBuilt = true;
        this.ixCacheMs = Date.now() - t;
        this.ixReused = same;
        this.ixReindexed = need.length;
        return this.ix.size;
      } catch { this.ix.clear(); }
    }

    // ② 全量建
    for (const m of metas) this.#readOne(m.id);
    this.ixBuilt = true;
    this.ixCacheMs = 0;
    this.ixReused = 0;
    this.ixReindexed = metas.length;
    // ★ 全量建完之后不立刻写缓存 —— 71MB 要 4 秒，会拖慢首次启动。
    //   标脏，等进程退出时 closeAll / saveIndexCache 再写。
    this.ixDirty = true;
    return this.ix.size;
  }

  /**
   * 分片版 buildIndex —— **同样的输入产出同样的索引**，只是在项与项之间让出事件循环。
   *
   * ★ 为什么必须有它（2026-11-10 实证）：
   *   data/shutdown.log 里有一行 {reason:"shell:timeout", graceful:false, httpDrained:false}。
   *   链子是这样的：首次启动 → 同步 buildIndex 读 84MB 缓存 / 扫 1000+ 会话，
   *   事件循环被占住 3–40 秒 → 用户这时候关窗口 → 壳 POST /api/shutdown，
   *   但 HTTP 处理不到 → 壳 10 秒超时 → TerminateProcess → closeAll() 与
   *   saveIndexCache() 都没执行 → 下次启动还是全量重建。
   *   **慢导致了关窗失败，关窗失败又导致了下次还慢。**
   *
   * ★ 只让出、不改语义：步骤顺序、指纹判定、行的构造方式与同步版逐条对应，
   *   「哪些会话重读」「哪些行采用」「末尾补空数组」一字不差。
   *
   * ★ 为什么用 setImmediate 而不是 setTimeout(0)：setImmediate 走 check 阶段，
   *   让出一次只花几十微秒；Windows 上 setTimeout(0) 有 ~1ms 的定时器粒度，
   *   几百次让出就是几百毫秒。
   *
   * @param {object} [opts]
   * @param {number} [opts.yieldMs=8] 攒够多少毫秒的活就让出一次
   * @returns {Promise<{size:number, aborted:boolean, yields:number, phases:object}>}
   */
  async buildIndexAsync(opts) {
    const o = opts || {};
    const yieldMs = Number(o.yieldMs) > 0 ? Number(o.yieldMs) : 8;
    if (this.ixBuilt) return { size: this.ix.size, aborted: false, yields: 0, phases: {} };
    if (this.ixBuilding) return this.ixBuilding;   // 同时只允许一路在分片建

    const run = (async () => {
      const token = ++this.ixBuildToken;
      const t0 = Date.now();
      const phases = {};
      let yields = 0;
      let last = Date.now();

      // 让出一次；返回 false 表示「该放弃了」（有同步建库抢先建完）
      const pace = async (phase) => {
        if (Date.now() - last < yieldMs) return true;
        phases[phase] = (phases[phase] || 0) + (Date.now() - last);
        await yieldToLoop();
        yields++;
        last = Date.now();
        return this.ixBuildToken === token && !this.ixBuilt;
      };
      const stop = (why) => ({ size: this.ix.size, aborted: true, yields, phases, why });

      // ★ 暂存 —— 中途有同步 buildIndex 抢跑时，它建它自己的 this.ix，
      //   我们这份没人看见过的半成品直接丢掉即可：谁也不会读到「半个索引」。
      const ix = new Map();

      // ① 会话清单（沿用 list() 的 30 秒缓存判定）
      let tp = Date.now();
      let metas;
      const cached = (!o.fresh && this.listCache && Date.now() - this.listAt < 30000) ? this.listCache : null;
      if (cached) metas = cached;
      else {
        metas = [];
        let seen = 0;
        for (const name of fs.readdirSync(this.root)) {
          const m = this.#metaOf(name);
          if (m) metas.push(m);
          if ((++seen & 31) === 0 && !(await pace('list'))) return stop('list');
        }
        metas.sort((a, b) => b.mtime - a.mtime);
        this.listCache = metas;
        this.listAt = Date.now();
      }
      phases.scan = Date.now() - tp;

      // ② 指纹
      tp = Date.now();
      const now = {};
      let i = 0;
      for (const m of metas) {
        try { const st = fs.statSync(path.join(this.dir(m.id), 'index.jsonl')); now[m.id] = st.size + ':' + st.mtimeMs; }
        catch { now[m.id] = '0:0'; }
        if ((++i & 31) === 0 && !(await pace('stat'))) return stop('stat');
      }
      phases.stat = Date.now() - tp;

      // ③ 试缓存
      tp = Date.now();
      let fp = null;
      try { fp = JSON.parse(fs.readFileSync(this.fpFile, 'utf8')); } catch {}
      if (fp && fs.existsSync(this.cacheFile)) {
        let buf = null;
        // ★ 读文件走异步 I/O：84MB 的同步读本身也是一次阻塞（页缓存冷的时候更久）
        try { buf = await fs.promises.readFile(this.cacheFile, 'utf8'); } catch { buf = null; }
        if (buf != null) {
          let pos = 0, same = 0, k = 0;
          const n = buf.length;
          while (pos < n) {
            const nl = buf.indexOf('\n', pos);
            const end = nl < 0 ? n : nl;
            const line = end > pos ? buf.slice(pos, end) : '';
            pos = nl < 0 ? n : nl + 1;
            if (!line) continue;
            const r = this.#splitCacheLine(line);
            if (r && fp[r.sid] === now[r.sid]) {
              let a = ix.get(r.sid);
              if (!a) { a = []; ix.set(r.sid, a); }
              a.push({ seq: r.seq, t: r.t, type: r.type, text: r.text, tl: r.text.toLowerCase() });
              same++;
            }
            if ((++k & 511) === 0 && !(await pace('cache'))) return stop('cache');
          }
          phases.cache = Date.now() - tp;

          // ④ 只重读变过 / 没出现过的会话
          tp = Date.now();
          const need = metas.filter(m => fp[m.id] !== now[m.id]);
          let rd = 0;
          for (const m of need) {
            const ok = await this.#readOneAsync(m.id, ix, pace);
            if (ok === false) return stop('reread');
            if ((++rd & 15) === 0 && !(await pace('reread'))) return stop('reread');
          }
          phases.reread = Date.now() - tp;

          for (const m of metas) if (!ix.has(m.id)) ix.set(m.id, []);
          if (this.ixBuildToken !== token) return stop('raced');   // 中途有人同步建完了
          this.ix = ix;
          this.ixBuilt = true;
          this.ixCacheMs = Date.now() - t0;
          this.ixReused = same;
          this.ixReindexed = need.length;
          return { size: this.ix.size, aborted: false, yields, phases };
        }
      }

      // ⑤ 全量建
      tp = Date.now();
      let fd = 0;
      for (const m of metas) {
        const ok = await this.#readOneAsync(m.id, ix, pace);
        if (ok === false) return stop('full');
        if ((++fd & 15) === 0 && !(await pace('full'))) return stop('full');
      }
      phases.full = Date.now() - tp;
      if (this.ixBuildToken !== token) return stop('raced');
      this.ix = ix;
      this.ixBuilt = true;
      this.ixCacheMs = 0;
      this.ixReused = 0;
      this.ixReindexed = metas.length;
      this.ixDirty = true;
      return { size: this.ix.size, aborted: false, yields, phases };
    })();

    this.ixBuilding = run;
    try { return await run; } finally { this.ixBuilding = null; }
  }

  /** 读一个会话的 index.jsonl 进内存（同步）。target 缺省 this.ix —— 分片版传暂存表。 */
  #readOne(id, target) {
    const rows = [];
    const f = path.join(this.dir(id), 'index.jsonl');
    try {
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          const txt = String(r.text || '');
          rows.push({ seq: r.seq, t: r.t, type: r.type, text: txt, tl: txt.toLowerCase() });
        } catch { /* skip */ }
      }
    } catch { /* 没有索引文件 */ }
    (target || this.ix).set(id, rows);
  }

  /** 分片版 #readOne：读文件走异步 I/O，解析按块让出。checkpoint 返回 false → 放弃。 */
  async #readOneAsync(id, target, checkpoint) {
    const f = path.join(this.dir(id), 'index.jsonl');
    const rows = [];
    let txt = null;
    try { txt = await fs.promises.readFile(f, 'utf8'); } catch { txt = null; }
    if (txt != null) {
      let pos = 0;
      const n = txt.length;
      let k = 0;
      while (pos < n) {
        const nl = txt.indexOf('\n', pos);
        const end = nl < 0 ? n : nl;
        const line = end > pos ? txt.slice(pos, end) : '';
        pos = nl < 0 ? n : nl + 1;
        if (!line) continue;
        try {
          const r = JSON.parse(line);
          const t = String(r.text || '');
          rows.push({ seq: r.seq, t: r.t, type: r.type, text: t, tl: t.toLowerCase() });
        } catch { /* skip */ }
        if ((++k & 255) === 0 && checkpoint) { if (!(await checkpoint('readOne'))) return false; }
      }
    }
    target.set(id, rows);
    return true;
  }

  /** 缓存文件里的一行 —— 同步版与分片版共用，保证两边字节一致 */
  #cacheLine(id, r) {
    return [id, r.seq, r.t, r.type, String(r.text || '').replace(/[\n\r\u0001]/g, ' ')].join('\u0001');
  }

  /** 落盘索引缓存（脏的时候才写） */
  #saveIndex() {
    const metas = this.list();
    const fp = {};
    const parts = [];
    for (const m of metas) {
      const f = path.join(this.dir(m.id), 'index.jsonl');
      try { const st = fs.statSync(f); fp[m.id] = st.size + ':' + st.mtimeMs; } catch { fp[m.id] = '0:0'; }
      const rows = this.ix.get(m.id) || [];
      for (const r of rows) parts.push(this.#cacheLine(m.id, r));
    }
    try {
      fs.writeFileSync(this.cacheFile, parts.join('\n'), 'utf8');
      fs.writeFileSync(this.fpFile, JSON.stringify(fp), 'utf8');
      this.ixDirty = false;
      return parts.length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * 分片版 saveIndexCache —— **产物与同步版逐字节一致**，只是不占住事件循环。
   *
   * ★ 为什么需要它：启动期 warmup 在「建完索引」之后要写一次缓存（这是下次启动快的
   *   唯一保证）。实测 320k 行 / 98MB，同步写要 2–4 秒 —— 用户正好在这几秒里关窗的话，
   *   POST /api/shutdown 又进不来。把「建库」修好只解决一半：写缓存是同一条路上的另一半。
   *
   * ★ 与同步版的差别只有两处：① 行是分批拼的；② 文件用异步 fd 分批写。
   *   行的格式、行的顺序、fp 的序列化方式全都一样。验收办法：两边对同一份数据各跑一遍，
   *   _index.cache 与 _index.fp 的 sha256 必须相同。
   *
   * @param {object} [opts]
   * @param {number} [opts.yieldMs=8] 攒够多少毫秒就让出一次
   * @param {number} [opts.chunkBytes=4194304] 每次写多少字节
   * @returns {Promise<number>} 写出的行数（0 = 没写）
   */
  async saveIndexCacheAsync(opts) {
    const o = opts || {};
    if (!this.ixBuilt || !this.ixDirty) return 0;
    const yieldMs = Number(o.yieldMs) > 0 ? Number(o.yieldMs) : 8;
    const chunkBytes = Number(o.chunkBytes) > 0 ? Number(o.chunkBytes) : 4194304;

    const revAtStart = this.ixRev || 0;
    let last = Date.now();
    const pace = async () => {
      if (Date.now() - last < yieldMs) return;
      await yieldToLoop();
      last = Date.now();
    };

    const metas = this.list();
    const fp = {};
    let fh = null;
    try {
      fh = await fs.promises.open(this.cacheFile, 'w');
      let buf = '';
      let first = true;
      let rowsOut = 0;
      for (const m of metas) {
        const f = path.join(this.dir(m.id), 'index.jsonl');
        try { const st = fs.statSync(f); fp[m.id] = st.size + ':' + st.mtimeMs; } catch { fp[m.id] = '0:0'; }
        const rows = this.ix.get(m.id) || [];
        for (const r of rows) {
          // ★ 不在结尾多写换行 —— 与同步版 parts.join('\n') 的字节完全一致
          buf += (first ? '' : '\n') + this.#cacheLine(m.id, r);
          first = false;
          rowsOut++;
          if (buf.length >= chunkBytes) { await fh.write(buf); buf = ''; await pace(); }
        }
      }
      if (buf.length) await fh.write(buf);
      await fh.close();
      fh = null;
      await fs.promises.writeFile(this.fpFile, JSON.stringify(fp), 'utf8');
      // ★ 写的过程中有新帧进来（写路径会 push 进内存索引）→ 保持脏，让退出时再写一次
      this.ixDirty = (this.ixRev || 0) !== revAtStart;
      return rowsOut;
    } catch (e) {
      try { if (fh) await fh.close(); } catch { /* ignore */ }
      return 0;
    }
  }

  /** 存索引（外部在退出前调） */
  saveIndexCache() {
    if (!this.ixBuilt || !this.ixDirty) return 0;
    try { return this.#saveIndex(); } catch { return 0; }
  }

  /** 追加一帧到内存索引（写路径顺手调） */
  #ixPush(id, row) {
    this.ixRev = (this.ixRev || 0) + 1; // 记账：分片写缓存时用它判「这期间有没有新帧」
    if (!this.ixBuilt) return;          // 还没建就不管，建的时候会读到
    const a = this.ix.get(id);
    const txt = String(row.text || '');
    if (!a) { this.ix.set(id, [{ seq: row.seq, t: row.t, type: row.type, text: txt, tl: txt.toLowerCase() }]); return; }
    a.push({ seq: row.seq, t: row.t, type: row.type, text: txt, tl: txt.toLowerCase() });
  }

  /**
   * 缓存淘汰 —— 超过上限就按「最久没被读过」丢掉。
   * ★ 为什么必须有：不加限制时，扫一遍 1006 个会话就把 15.9 万帧连原文塞满堆，
   *   Node 直接 OOM（实测 512MB heap limit 打爆）。
   *   宿主那边也一样 —— 一个 soul_recall 扫全库就会把进程搞死。
   */
  #evict() {
    if (this.cache.size <= this.maxCache) return;
    const order = [];
    for (const [k, v] of this.cache) order.push({ k, used: v.used || v.header.t || 0 });
    order.sort((a, b) => a.used - b.used);
    const drop = order.slice(0, this.cache.size - this.maxCache);
    for (const d of drop) {
      const h = this.fds.get(d.k + ':frames');
      if (h) { try { fs.closeSync(h.fd); } catch {} this.fds.delete(d.k + ':frames'); }
      const h2 = this.fds.get(d.k + ':index');
      if (h2) { try { fs.closeSync(h2.fd); } catch {} this.fds.delete(d.k + ':index'); }
      this.cache.delete(d.k);
    }
  }

  /** 文件指纹：size + mtime。★ 用来发现「别的进程写了这个会话」 */
  #stamp(id) {
    try {
      const st = fs.statSync(path.join(this.dir(id), 'frames.jsonl'));
      return st.size + ':' + st.mtimeMs;
    } catch { return null; }
  }

  /**
   * 读一个会话的全部帧（带缓存的）。
   * ★ 必须能发现外部变更 —— 挂载模式下宿主和 agent-soul 是两个进程，共写同一目录。
   *   每次 load 只做一次 stat，比「永不检测」只贵一点点，比「每次全读」便宜得多。
   */
  load(id) {
    const stamp = this.#stamp(id);
    if (stamp === null) return null;
    const cached = this.cache.get(id);
    if (cached && cached.stamp === stamp) { cached.used = Date.now(); return cached; }
    const f = path.join(this.dir(id), 'frames.jsonl');
    const frames = [];
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { frames.push(JSON.parse(line)); } catch { /* 坏行跳过，不中断 */ }
    }
    const header = frames[0] && frames[0].type === FRAME.SESSION ? frames[0] : null;
    const nextSeq = frames.length ? frames[frames.length - 1].seq + 1 : 1;
    const entry = { header, frames, nextSeq, stamp: this.#stamp(id) };
    this.cache.set(id, entry);
    this.#evict();
    return entry;
  }

  /** 追加一帧 + 立刻写索引（同一次调用） */
  append(id, type, payload) {
    // ★ 2026-11-07：list() 的 TTL 从 5 秒提到 30 秒（1006 个会话重读首行要 1.26 秒，
    //   5 秒等于「几乎每次都重算」）。但那是缓存的代价必须在这里付 ——
    //   **刚写进去的帧，list() 必须立刻看得见**，否则「写完立即搜」会命中 0。
    //   实测踩过：live-smoke 的「写入即索引」就是这条。
    this.listCache = null;

    const s = this.load(id);
    if (!s) throw new Error('会话不存在: ' + id);
    // ★ payload 里显式写了 undefined 的键要剔掉 ——
    //   否则 { ...payload } 会把 seq / t / type 抹成 undefined，
    //   然后 extractText 拿到 undefined 走 default，索引一条都不写，而且不报错。
    const clean = {};
    for (const [k, v] of Object.entries(payload || {})) {
      if (v !== undefined && k !== 'seq' && k !== 't' && k !== 'type') clean[k] = v;
    }
    const frame = { seq: s.nextSeq, t: nowMs(), type, ...clean };
    this.#appendFrame(id, frame);
    s.frames.push(frame);
    s.nextSeq++;
    s.stamp = this.#stamp(id);
    return frame;
  }

  /**
   * 拿一个写句柄（缓存复用）。
   * ★ 为什么不每次 appendFileSync：它内部是 open/write/close，
   *   实测 Windows 上 1.74ms/次，保持句柄只要 0.014ms —— 贵 124 倍。
   *   会话多了以后，建库时间会从「几分钟」掉回「几秒」。
   * ★ 为什么有上限：2188 个会话 × 2 个文件 = 4376 个 fd，
   *   虽然 Windows 默认够，但泄漏起来很难查。LRU 关掉最久没用的。
   */
  #wfd(id, kind) {
    const key = id + ':' + kind;
    const hit = this.fds.get(key);
    if (hit) { hit.used = Date.now(); return hit.fd; }

    const d = this.dir(id);
    fs.mkdirSync(d, { recursive: true });
    const fd = fs.openSync(path.join(d, kind === 'frames' ? 'frames.jsonl' : 'index.jsonl'), 'a');
    this.fds.set(key, { fd, used: Date.now() });

    if (this.fds.size > this.maxFds) {
      let oldestKey = null, oldest = Infinity;
      for (const [k, v] of this.fds) if (v.used < oldest) { oldest = v.used; oldestKey = k; }
      if (oldestKey && oldestKey !== key) {
        try { fs.closeSync(this.fds.get(oldestKey).fd); } catch {}
        this.fds.delete(oldestKey);
      }
    }
    return fd;
  }

  /** 关掉某个会话的写句柄（改 id / 删除前必须调） */
  closeSession(id) {
    for (const kind of ['frames', 'index']) {
      const k = id + ':' + kind;
      const h = this.fds.get(k);
      if (h) { try { fs.closeSync(h.fd); } catch {} this.fds.delete(k); }
    }
  }

  /** 关掉全部写句柄（进程退出前调） */
  closeAll() {
    try { this.saveIndexCache(); } catch {}
    for (const [, h] of this.fds) { try { fs.closeSync(h.fd); } catch {} }
    this.fds.clear();
  }

  #appendFrame(id, frame) {
    fs.writeSync(this.#wfd(id, 'frames'), JSON.stringify(frame) + '\n');

    // ★ 索引就在这一步产生 —— 同一次写入，不是事后扫描
    // ★ 截断到 500 字符：索引是「门牌」，不是原文。
    //   不截断时实测 15.9 万帧 → index.jsonl 658MB（比 frames 还大），
    //   因为 tool_result 每条几千字。截断后体积降一个量级，检索不受影响
    //   （检索只看命中，要看全文用 soul_frame 按 seq 取）。
    const full = extractText(frame);
    const text = full && full.length > 500 ? full.slice(0, 500) : full;
    if (text) {
      const row = { seq: frame.seq, t: frame.t, type: frame.type, text };
      fs.writeSync(this.#wfd(id, 'index'), JSON.stringify(row) + '\n');
      this.#ixPush(id, row);
      this.ixDirty = true;
    }
  }

  /** 取最近 n 帧（上下文组装用） */
  recent(id, n) {
    const s = this.load(id);
    if (!s) return [];
    return s.frames.slice(-Math.max(1, n));
  }

  /** 全文检索（扫索引，简单子串；后续可换倒排） */
  search(id, needle) {
    this.buildIndex();
    const terms = tokenize(needle);
    if (!terms.length) return [];

    const rows = this.ix.get(id) || [];
    const needleLower = String(needle).toLowerCase();
    const scored = [];
    for (const r of rows) {
      if (r.tl.includes(needleLower)) { scored.push({ r, score: 1 }); continue; }
      let hit = 0;
      for (const t of terms) if (r.tl.includes(t)) hit++;
      const score = hit / terms.length;
      if (score >= 0.34) scored.push({ r, score });
    }
    scored.sort((a, b) => b.score - a.score || a.r.seq - b.r.seq);
    return scored.map(x => ({ seq: x.r.seq, t: x.r.t, type: x.r.type, text: x.r.text, score: x.score }));
  }

  /**
   * 跨会话检索。
   *
   * ★★ 2026-11-07 修一个真 bug —— 「先到先得」：原来一旦收集满 limit 就 return，
   *    而遍历顺序是 Map 插入顺序（= 会话目录名顺序）。
   *    于是**排在前面的会话只要有一个字碰上，就占满名额**，
   *    后面那些真正相关的、或者**刚写进去的**帧永远轮不到显示。
   *    实测：1009 个会话时，刚 append 的一帧用 limit=3 搜不到自己 —— 而它就在索引里。
   *    ★ 这个形状最坏：**写入成功、检索也返回结果，只是返回的不是你要的那条。**
   *
   *    修法：全部收齐，按分数排序，再截断。
   *    代价是遍历全部会话 —— 但换掉的是「悄悄给错的答案」。
   */
  searchAll(needle, limit = 50) {
    this.buildIndex();
    const out = [];
    for (const sid of this.ix.keys()) {
      for (const hit of this.search(sid, needle)) {
        out.push({ sessionId: sid, ...hit });
      }
    }
    // ★ search() 已经按 (score desc, seq asc) 排过每个会话内部；
    //   跨会话要重新排 —— 否则会话边界的顺序会盖过相关度。
    out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.t - b.t);
    return out.slice(0, Math.max(1, limit));
  }
}
