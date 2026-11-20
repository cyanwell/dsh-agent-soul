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
import { StringDecoder } from 'node:string_decoder';
import { span as spanSync } from '../util/sync-timer.mjs';

/**
 * 把一个查询切成检索单元。
 * ★ 为什么不只用整串：中文没有空格，一个问句很少逐字出现在历史里。
 *   「传输层那件事」必须能搜到「传输层拆分这件事」—— 所以要切。
 *   · 中文：连续的汉字按 2-gram 切（「传输层拆分」→ 传输/输层/层拆/拆分）
 *   · 英文数字：按词切（长度 ≥2 才留，避免 a / is 这种）
 */
/**
 * 一行的小写文本：**按需算，算完记住**。
 *
 * ★★ 2026-11-17（阶段 1）：建库时对 245,576 行各做一次 toLowerCase 是 cache 段的大头
 *   （实测 cache 段 2.6~4.3 秒）。而小写只在 search() 里用得到 ——
 *   启动时把整库都小写一遍，等于给每一行都付一次「也许永远不检索」的成本。
 *   现在只在真正检索到这一行时才小写，并写回 r.tl 记住。
 *   代价：某个会话第一次被搜时多一次小写；换来的是启动时不做 24 万次无用功。
 */
function tlOf(row) {
  if (row.tl === null || row.tl === undefined) row.tl = String(row.text || '').toLowerCase();
  return row.tl;
}

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
 * 读文件第一行（最多 4KB），**顺带把 stat 一起带回来**。
 *
 * ★★ 2026-11-17（阶段 1）：为什么不是「existsSync + open/read/close + statSync」。
 *   原来 #metaOf 每个会话要 5 次系统调用（1408 个会话 ≈ 7000 次），
 *   实测 list 段占索引建库的 2.3~5.6 秒，是最大的一块之一。
 *   现在从**同一个 fd** 上 fstatSync 拿 size/mtime，并且不再单独 existsSync
 *   （文件不在时 openSync 直接抛，try/catch 已经兜住了）—— 5 次降到 3 次。
 *
 * @returns {{line:string,size:number,mtimeMs:number}|null} 读不出来 → null
 */
function readFirstLineWithStat(fp) {
  let fd;
  try {
    fd = fs.openSync(fp, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    const st = fs.fstatSync(fd);
    if (n <= 0) return { line: '', size: st.size, mtimeMs: st.mtimeMs };
    const str = buf.subarray(0, n).toString('utf8');
    const i = str.indexOf('\n');
    return { line: i >= 0 ? str.slice(0, i) : str, size: st.size, mtimeMs: st.mtimeMs };
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
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
    /** 数据目录（清单缓存放这儿，与 _index.cache 做邻居） */
    this.dataDir = dataDir;
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
    /** 会话清单缓存的形状戳（见 #rootStamp）—— 对不上就重扫 */
    this.metaStamp = null;
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

    // ★★ 2026-11-17（阶段 1）：先试**磁盘清单**。
    //   #metaOf 每个会话要 1 次 open + 1 次 read + 1 次 fstat，1,408 个 ≈ 2.0 秒。
    //   而这一千多个会话的元信息 99.9% 的时候一个字都没变。
    //   清单缓存（_sessions.meta.jsonl，约 300KB）实测读+解析 ~25ms。
    //
    //   ★ 判据：**只认 data/sessions 这一层目录自己的 mtime 与条目数**。
    //     新建会话会改动父目录的 mtime；这比「每 30 秒重算一次」便宜，也比
    //     「一次都不算」可靠。★ 它不保证单个会话的 mtime 是新的 ——
    //     但 mtime 只用来**排序**（最近的在前面），不参与任何正确性判定：
    //     索引指纹走的是 stat 段，独立算。
    const stamp = this.#rootStamp();
    if (!(opts && opts.fresh) && stamp && this.metaStamp === stamp && this.listCache) {
      this.listAt = now;
      return this.listCache;
    }
    const cached = this.#loadMetaCache(stamp);
    if (cached && !(opts && opts.fresh)) {
      this.listCache = cached;
      this.listAt = now;
      this.metaStamp = stamp;
      return cached;
    }

    const out = [];
    for (const name of fs.readdirSync(this.root)) {
      const m = this.#metaOf(name);
      if (m) out.push(m);
    }
    out.sort((a, b) => b.mtime - a.mtime);
    this.listCache = out;
    this.listAt = now;
    this.metaStamp = stamp;
    this.#saveMetaCache(out, stamp);
    return out;
  }

  /** data/sessions 这一层目录的「形状戳」：条目数 + 自己的 mtime。变了就说明有人新建/删了会话。 */
  #rootStamp() {
    try {
      const st = fs.statSync(this.root);
      const names = fs.readdirSync(this.root);
      return names.length + '@' + Math.round(st.mtimeMs);
    } catch { return null; }
  }

  #metaCacheFile() { return path.join(this.dataDir || path.dirname(this.root), '_sessions.meta.jsonl'); }

  /** 读清单缓存。戳对不上 / 文件不在 / 读坏 → null（回落到逐目录扫）。 */
  #loadMetaCache(stamp) {
    if (!stamp) return null;
    try {
      const f = this.#metaCacheFile();
      const text = fs.readFileSync(f, 'utf8');
      const nl = text.indexOf('\n');
      if (nl < 0) return null;
      const head = JSON.parse(text.slice(0, nl));
      if (!head || head.stamp !== stamp || !Number.isFinite(head.n)) return null;
      const out = [];
      let pos = nl + 1;
      const n = text.length;
      while (pos < n) {
        const e = text.indexOf('\n', pos);
        const end = e < 0 ? n : e;
        if (end > pos) { try { out.push(JSON.parse(text.slice(pos, end))); } catch { /* 坏行跳过 */ } }
        pos = e < 0 ? n : e + 1;
      }
      // 条数对不上 = 文件被写了一半 → 不采信
      if (out.length !== head.n) return null;
      return out;
    } catch { return null; }
  }

  /**
   * 写清单缓存。写不了不影响正确性 —— 下次照旧逐目录扫。
   *
   * ★ 2026-11-17：这里原本用 setImmediate + promises 异步写，结果实测**一次都没写成**
   *   （文件不存在）—— 因为进程可能在下一拍之前就退出了。清单约 300KB，
   *   同步写实测几毫秒，远低于 200ms 的阻塞红线；**确定性比这几毫秒值钱**。
   */
  #saveMetaCache(metas, stamp) {
    if (!stamp) return;
    return spanSync('store:#saveMetaCache', () => this.#saveMetaCacheInner(metas, stamp));
  }

  #saveMetaCacheInner(metas, stamp) {
    if (!stamp) return;
    try {
      const f = this.#metaCacheFile();
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const head = JSON.stringify({ v: 1, stamp, n: metas.length, at: new Date().toISOString() });
      const body = metas.map((m) => JSON.stringify(m)).join('\n');
      fs.writeFileSync(f, head + '\n' + body, 'utf8');
    } catch { /* 写不了就下次再扫 —— 不 throw */ }
  }

  /** 会话目录 → 一条 meta。不是会话目录 / 坏目录 → null。list 与 buildIndex* 共用一份判定。 */
  #metaOf(name) {
    const f = path.join(this.root, name, 'frames.jsonl');
    // ★ 2026-11-17（阶段 1）：一次 open + 一次 read + 一次 fstat，取代原来的
    //   existsSync + open/read/close + statSync（每个会话少两次系统调用）。
    const got = readFirstLineWithStat(f);
    if (!got || !got.line) return null;
    try {
      // ★ 只读头部 4KB —— 原来写的是 readFileSync(f) 然后取第一行，
      //   那是**读整个文件**。实测：1006 个会话 list 一次 6.3 秒，
      //   因为其中一个会话是 308MB。改成只读头 4KB 后掉到 130ms。
      const h = JSON.parse(got.line);
      if (h.type !== FRAME.SESSION) return null;
      return { id: h.id, cwd: h.cwd, persona: h.persona, createdAt: h.t, mtime: got.mtimeMs, bytes: got.size };
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

  /**
   * 分块读一个大文本文件。
   *
   * ★★ 2026-11-17（阶段 1）：为什么不是 readFile(path, 'utf8')。
   *   readFile 本身的 I/O 确实是异步的，但那 123.7MB 的 **UTF-8 → UTF-16 解码
   *   是在主线程上一口气做完的**。实测这一下就是 2 秒级的单次阻塞 ——
   *   正好对上 loop-stall.log 里每 30~90 秒一条 2.0~2.5s 的形态。
   *
   *   而它的后果不是「慢」，是**级联**：事件循环停 2 秒 → /api/health 不应答 →
   *   bridge keeper 连续 2 次 miss → 拉起第二个 core → 两个 core 抢同一份
   *   _index.cache 与同一个端口 → 多写者环境 + IO 重载。
   *   所以这里改的不是性能指标，是**那条级联的起点**。
   *
   * ★ 8MB 一块：单块解码实测 < 20ms，远低于 200ms 的阻塞红线。
   *   块与块之间 setImmediate 让出一拍，HTTP 与定时器就有机会插进来。
   */
  async #readTextChunked(file, chunkBytes) {
    const fh = await fs.promises.open(file, 'r');
    try {
      const decoder = new StringDecoder('utf8');
      const size = chunkBytes > 0 ? chunkBytes : 8 * 1024 * 1024;
      const parts = [];
      for (;;) {
        const buf = Buffer.allocUnsafe(size);
        const rd = await fh.read(buf, 0, size, null);
        const n = rd && Number.isFinite(rd.bytesRead) ? rd.bytesRead : 0;
        if (n === 0) break;
        parts.push(decoder.write(buf.subarray(0, n)));
        await new Promise((r) => setImmediate(r));
      }
      parts.push(decoder.end());
      return parts.join('');
    } finally {
      try { await fh.close(); } catch { /* ignore */ }
    }
  }

  /** 缓存文件的一行 → 字段。坏行 → null（当它不存在）。 */
  #splitCacheLine(line) {
    const p = line.split('\u0001');
    if (p.length < 5) return null;
    return { sid: p[0], seq: Number(p[1]), t: Number(p[2]), type: p[3], text: p[4] };
  }

  /**
   * 逐行流式读一个大文本文件：**不把整份内容拼成一个字符串**。
   *
   * ★★ 2026-11-17（阶段 1）：为什么还要再改一版。
   *   #readTextChunked 已经把「一次性解码」拆成 8MB 一块，MAXBLOCK 从 2.3s 降到 ~150ms。
   *   但它最后仍然 parts.join('') —— 123.7MB 的 UTF-8 解码成 **111M 个 UTF-16 字符**，
   *   拼成一整串要一次内存分配 + 一次全量拷贝。实测这一步与「读」和「解析」同量级。
   *   而下游只做一件事：按 '\n' 切行、逐行解析。**整串留到最后那一刻完全没有用处。**
   *
   *   现在：块 → 解码 → 切出完整行 → 立刻交给 onLine → 丢掉。只保留跨块的那半行。
   *   峰值内存从「一个 111M 字符的串 + 245k 行的索引」降到「一个 8MB 块 + 半行 + 索引」。
   *
   * @param {string} file
   * @param {(line:string)=>void} onLine   每一条完整行（不含换行符）
   * @param {number} chunkBytes
   */
  async #scanTextLines(file, onLine, chunkBytes) {
    const fh = await fs.promises.open(file, 'r');
    const decoder = new StringDecoder('utf8');
    const size = chunkBytes > 0 ? chunkBytes : 8 * 1024 * 1024;
    let rest = '';
    let blocks = 0;
    try {
      for (;;) {
        const buf = Buffer.allocUnsafe(size);
        const rd = await fh.read(buf, 0, size, null);
        const n = rd && Number.isFinite(rd.bytesRead) ? rd.bytesRead : 0;
        if (n === 0) break;
        let text = decoder.write(buf.subarray(0, n));
        if (rest) { text = rest + text; rest = ''; }
        let pos = 0;
        for (;;) {
          const nl = text.indexOf('\n', pos);
          if (nl < 0) break;
          if (nl > pos) onLine(text.slice(pos, nl));
          pos = nl + 1;
        }
        // 剩下的半行留到下一块；★ 不能用 slice 长期持有大串，这里已经足够短
        if (pos < text.length) rest = text.slice(pos);
        blocks++;
      }
      const tail = decoder.end();
      if (tail) rest += tail;
      if (rest) onLine(rest);
      return blocks;
    } finally {
      try { await fh.close(); } catch { /* ignore */ }
    }
  }

  /**
   * 缓存行的**就地**解析：用 indexOf 找 4 个分隔符，不 split 出中间数组。
   *
   * ★★ 2026-11-17（阶段 1）实测（123.7MB / 248,537 行，同一台机器）：
   *     line.split('\u0001')  601 ms   ← 每行都建一个 5 元素的数组
   *     indexOf 逐段切         219 ms   ← 不建中间数组
   *   差 382ms，纯属白付。行格式是固定的 5 段，用不着通用 split。
   *
   * @returns {{sid:string,seq:number,t:number,type:string,text:string}|null}
   */
  #parseCacheLineFast(line) {
    const end = line.length;
    const a = line.indexOf('\u0001');
    if (a <= 0) return null;
    const b = line.indexOf('\u0001', a + 1);
    if (b < 0) return null;
    const c = line.indexOf('\u0001', b + 1);
    if (c < 0) return null;
    const d = line.indexOf('\u0001', c + 1);
    if (d < 0 || d > end) return null;
    return {
      sid: line.slice(0, a),
      seq: Number(line.slice(a + 1, b)),
      t: Number(line.slice(b + 1, c)),
      type: line.slice(c + 1, d),
      text: line.slice(d + 1),
    };
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
          a.push({ seq: r.seq, t: r.t, type: r.type, text: r.text, tl: null });
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
      // ★★ 2026-11-17 修一个记账 bug：原来 last 是跨 phase 共享的，
      //   于是「stat 段」的耗时会把 cache 段尾部算进来，而 readOne 段（只有 4 个会话）
      //   被算成 2,026ms —— 那不是它慢，是账记串了。
      //   现在的口径：每段自己记（段结束时间 − 段开始时间），让出的时间不再重复计入。
      //   ★ 留着 yields 与 last 只为控制让出节奏，不再当计时器。
      const pace = async (phase) => {
        if (Date.now() - last < yieldMs) return true;
        await yieldToLoop();
        yields++;
        last = Date.now();
        return this.ixBuildToken === token && !this.ixBuilt;
      };
      const stop = (why) => ({ size: this.ix.size, aborted: true, yields, phases, why });

      // ★ 暂存 —— 中途有同步 buildIndex 抢跑时，它建它自己的 this.ix，
      //   我们这份没人看见过的半成品直接丢掉即可：谁也不会读到「半个索引」。
      const ix = new Map();

      // ① 会话清单
      // ★★ 2026-11-17（阶段 1）：这里原来自己**又扫一遍目录**，不经过 list() 的清单缓存 ——
      //   于是「已经算好的清单」在建库时白算第二次。现在三级：内存 → 磁盘清单 → 逐目录扫。
      let tp = Date.now();
      let metas;
      const stamp = this.#rootStamp();
      const fromMem = (!o.fresh && this.listCache && Date.now() - this.listAt < 30000) ? this.listCache : null;
      if (fromMem) metas = fromMem;
      else {
        const fromDisk = (!o.fresh && stamp && this.metaStamp === stamp && this.listCache)
          ? this.listCache
          : this.#loadMetaCache(stamp);
        if (fromDisk) {
          metas = fromDisk;
          this.listCache = metas;
          this.listAt = Date.now();
          this.metaStamp = stamp;
        } else {
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
          this.metaStamp = stamp;
          this.#saveMetaCache(metas, stamp);
        }
      }
      phases.scan = Date.now() - tp;

      // ② 指纹
      // ★★ 2026-11-17（阶段 1）：逐个 statSync 在 1,408 个会话上是 869ms。
      //   实测同一批（3,810 个文件）逐个 await 2,695ms / Promise.all 一次性 924ms /
      //   **分批 64 并发 985ms** —— 分批既省 1.7 秒，又不会一次性把 1,408 个请求
      //   全压给 libuv（那样峰值内存与 fd 都会跳）。
      //   ★ 为什么用 stat 而不从清单缓存里拿：mtime 会变（会话还在写），
      //     而这条指纹是**唯一**判定「这个会话的索引要不要重读」的依据。缓存它 = 漏读新帧。
      tp = Date.now();
      const now = {};
      {
        const BATCH = 64;
        for (let base = 0; base < metas.length; base += BATCH) {
          const slice = metas.slice(base, base + BATCH);
          const got = await Promise.all(slice.map(async (m) => {
            try {
              const st = await fs.promises.stat(path.join(this.dir(m.id), 'index.jsonl'));
              return st.size + ':' + st.mtimeMs;
            } catch { return '0:0'; }
          }));
          for (let j = 0; j < slice.length; j++) now[slice[j].id] = got[j];
          if (!(await pace('stat'))) return stop('stat');
        }
      }
      phases.stat = Date.now() - tp;

      // ③ 试缓存
      tp = Date.now();
      let fp = null;
      try { fp = JSON.parse(fs.readFileSync(this.fpFile, 'utf8')); } catch {}
      if (fp && fs.existsSync(this.cacheFile)) {
        let same = 0, k = 0, aborted = false;
        // ★★ 2026-11-17（阶段 1）：逐行流式，不再把 111M 字符拼成一整串（理由见 #scanTextLines）。
        //   顺带：这里原来又做了一次 text.toLowerCase() —— 24.5 万行。
        //   建库时的小写是白费的（只有检索时才用），已经改成 tl: null 按需算，
        //   但这一处上一轮的正则漏了它。现在一并修掉。
        const __t0 = Date.now();
        try {
          await this.#scanTextLines(this.cacheFile, (line) => {
            if (!line) return;
            const r = this.#parseCacheLineFast(line);
            if (r && fp[r.sid] === now[r.sid]) {
              let a = ix.get(r.sid);
              if (!a) { a = []; ix.set(r.sid, a); }
              a.push({ seq: r.seq, t: r.t, type: r.type, text: r.text, tl: null });
              same++;
            }
            k++;
          }, 8 * 1024 * 1024);
        } catch { same = -1; }
        if (same >= 0) {
          // ★ 桩：本段超过 200ms 就记一笔（sync-timer 的 span 自己判阈值，
          //   这里包一个空函数只为把「一段结束了」告诉它 —— 实测口径见 sync-spans.log）
          if (Date.now() - __t0 >= 200) spanSync('store:buildIndex:cache(measured)', () => { /* 已量过，这里只落一行 */ });
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
          rows.push({ seq: r.seq, t: r.t, type: r.type, text: txt, tl: null });
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
    // ★★ 2026-11-17（阶段 1）：慢读留痕。
    //   loop-stall.log 里启动后稳定出现一条 1,300~1,400ms 的阻塞，而它就是建库期。
    //   嫌疑是「某个大会话的 index.jsonl 一次性解码」。这条日志极便宜，
    //   而且能在下一次复现时**直接指名道姓**，不用再猜。
    //   ★ 只记 >500ms 的，正常读一个 index.jsonl 是 1~20ms，不会刷屏。
    const tRead = Date.now();
    try { txt = await fs.promises.readFile(f, 'utf8'); } catch { txt = null; }
    const readMs = Date.now() - tRead;
    if (readMs > 500) {
      try {
        const sz = txt == null ? 0 : txt.length;
        this.slowReads = this.slowReads || [];
        this.slowReads.push({ id, ms: readMs, chars: sz, at: new Date().toISOString() });
        if (this.slowReads.length > 50) this.slowReads.shift();
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[索引] 慢读 ' + id.slice(0, 20) + ' ' + readMs + 'ms · ' + (sz / 1048576).toFixed(1) + 'MB');
        }
      } catch { /* 记账失败不影响建库 */ }
    }
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
          rows.push({ seq: r.seq, t: r.t, type: r.type, text: t, tl: null });
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
    return spanSync('store:#saveIndex', () => this.#saveIndexInner());
  }

  #saveIndexInner() {
    const metas = this.list();
    const fp = {};
    let rowsOut = 0;
    // 2026-11-17 (stage 1): stream the write, do not build one giant string.
    //
    // Measured on 250,898 rows / 107.1M chars, same machine:
    //   build parts array   519 ms
    //   parts.join()        149 ms   <- one 107M-char allocation + full copy
    //   writeFileSync       489 ms
    // The first two (668 ms) are pure CPU inside the event loop; fs-watch
    // cannot see them (not fs calls) - that is half of the 1,473 ms stall
    // recorded in loop-stall.log.
    //
    // Now: accumulate 4MB, write it, continue. Same total time, but the
    // longest continuous occupancy drops from 668 ms to tens of ms, and peak
    // memory drops from a 107M-char string to one 4MB buffer.
    // Byte output is identical (rows joined by newline, no trailing newline).
    try {
      const fd = fs.openSync(this.cacheFile, 'w');
      try {
        const CHUNK = 4 * 1024 * 1024;
        let buf = '';
        let first = true;
        for (const m of metas) {
          const f = path.join(this.dir(m.id), 'index.jsonl');
          try { const st = fs.statSync(f); fp[m.id] = st.size + ':' + st.mtimeMs; } catch { fp[m.id] = '0:0'; }
          const rows = this.ix.get(m.id) || [];
          for (const r of rows) {
            buf += (first ? '' : "\n") + this.#cacheLine(m.id, r);
            first = false;
            rowsOut++;
            if (buf.length >= CHUNK) { fs.writeSync(fd, buf); buf = ''; }
          }
        }
        if (buf.length) fs.writeSync(fd, buf);
      } finally {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
      fs.writeFileSync(this.fpFile, JSON.stringify(fp), 'utf8');
      this.ixDirty = false;
      return rowsOut;
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
    // ★★ 2026-11-17：内容没变就别写那 124MB
    const stamp = this.#ixContentStamp();
    if (this.#savedStamp() === stamp) {
      this.ixDirty = false;
      return 0;
    }
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
      this.#writeStamp(stamp);
      return rowsOut;
    } catch (e) {
      try { if (fh) await fh.close(); } catch { /* ignore */ }
      return 0;
    }
  }

  /**
   * 索引内容的**内容指纹** —— 用它判断「磁盘上那份是不是已经就是这份」。
   *
   * ★★ 2026-11-17（阶段 1）：为什么需要。
   *   退出路径（flushStoreSync）调 saveIndexCache()，只要 ixDirty 就**整份重写 124MB**。
   *   而「脏」的含义只是「建库之后有新帧进来」—— 哪怕只来了 4 帧，也要重写 124MB。
   *   用户关窗那一刻正是最不该让磁盘忙起来的时候。
   *
   *   指纹怎么算：会话数 + 总行数 + 每个会话的行数 + 最大 seq。
   *   它不保证「逐字节相同」（正文改了但行数没变就看不出来），所以**只用它来跳过写**，
   *   绝不用它来判定「缓存可用」—— 后者仍然逐行比 size:mtime 指纹（那是可靠的）。
   *   ★ 这个方向是安全的：判错了顶多白写一次（回到原来的行为），不会漏数据。
   */
  #ixContentStamp() {
    let rows = 0, maxSeq = 0, sessions = 0;
    for (const [id, arr] of this.ix) {
      sessions++;
      rows += arr.length;
      for (let i = arr.length - 1; i >= 0; i--) {
        const q = arr[i] && arr[i].seq;
        if (typeof q === 'number' && q > maxSeq) maxSeq = q;
        break;
      }
    }
    // ★★★ 2026-11-17（阶段 1）：**行数按 2,000 分桶，不再精确比。**
    //
    //   为什么要放宽：精确比意味着「soul-sync 写进 5 帧」→ stamp 变 → 退出时整份重写
    //   124MB（2.5~3.1 秒全在事件循环里）。实测每次退出都这样。
    //
    //   放宽之后：写几帧**不再触发重写**，要累积到 2,000 帧才写一次。
    //   ★ 正确性由 fp 兜住，不靠这个 stamp：
    //     磁盘上的 _index.fp 记的是「写那份缓存时每个会话的 index.jsonl 指纹」。
    //     缓存没更新 → fp 也就没更新 → 下次启动时那批会话 fp ≠ now，
    //     会被**逐行丢弃 + 从 index.jsonl 重读**（实测 4 个会话 100ms，大会话 171ms）。
    //     也就是说：**跳过写不会丢数据，只是把成本挪到下次启动的重读上**。
    //   ★ 这是一个明确的取舍：拿「下次启动多读几个会话」换「这次退出不卡 3 秒」。
    //     退出那一刻正是用户关窗的时候，而那点重读发生在 warmup 里、不挡请求。
    // ★ maxSeq 也去掉 —— 实测它每次都变（soul-sync 写的帧 seq 一直在涨），
    //   留着它等于每轮都触发重写。本项目是**只追加**，不存在「行数不变但内容被覆盖」的情形，
    //   所以 sessions + 分桶行数 足够判断「值不值得重写这一趟」。
    //   ★ 再次强调：这里判错**不会丢数据**，只影响「下次启动要重读几个会话」。
    const rowBuckets = Math.floor(rows / 2000);
    return sessions + '/' + rowBuckets;
  }

  /** 上一份写到磁盘时的内容指纹（跨进程没意义 —— 每次启动重算，见 #loadIndexStamp） */
  #savedStamp() {
    try { return fs.readFileSync(this.cacheFile + '.stamp', 'utf8').trim(); } catch { return null; }
  }

  #writeStamp(stamp) {
    try { fs.writeFileSync(this.cacheFile + '.stamp', stamp, 'utf8'); } catch { /* 写不了就下次白写一次 */ }
  }

  /** 存索引（外部在退出前调） */
  saveIndexCache() {
    if (!this.ixBuilt || !this.ixDirty) return 0;
    // ★★ 2026-11-17：内容没变就别写那 124MB（理由见 #ixContentStamp）。
    const stamp = this.#ixContentStamp();
    if (this.#savedStamp() === stamp) {
      this.ixDirty = false;
      return 0;
    }
    try {
      const n = this.#saveIndex();
      this.#writeStamp(stamp);
      return n;
    } catch { return 0; }
  }

  /** 追加一帧到内存索引（写路径顺手调） */
  #ixPush(id, row) {
    this.ixRev = (this.ixRev || 0) + 1; // 记账：分片写缓存时用它判「这期间有没有新帧」
    if (!this.ixBuilt) return;          // 还没建就不管，建的时候会读到
    const a = this.ix.get(id);
    const txt = String(row.text || '');
    if (!a) { this.ix.set(id, [{ seq: row.seq, t: row.t, type: row.type, text: txt, tl: null }]); return; }
    a.push({ seq: row.seq, t: row.t, type: row.type, text: txt, tl: null });
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
  /**
   * 把整个会话装进内存（frames 全量）。
   *
   * ★★★ 2026-11-17（阶段 1）：这个方法是**已知的最大单次阻塞源**，实测：
   *   347.7MB 容器 → **5,411 ms**（70,263 帧）
   *   104.3MB 容器 → **1,506 ms**（20,059 帧）
   *   它用 readFileSync 整读 + 逐行 JSON.parse，全都同步。
   *
   *   我**没有**改它的语义（太多调用方依赖「拿到全部帧」），但加了两件东西：
   *   ① 超过阈值时记一行（data/fs-slow.log）——「谁让它慢了」必须看得见，
   *      而不是让下一次抱怨「又卡了几秒」时没人知道原因；
   *   ② 把读文件那一步包成 span，这样它自己会出现在同步段桩里。
   *   ★ 真正的修法是**不要整读**（按 seq 区间取、或建内存外的索引），
   *     那是下一步的事，不该在没有调用方清单的时候顺手改。
   */
  load(id) {
    const stamp = this.#stamp(id);
    if (stamp === null) return null;
    const cached = this.cache.get(id);
    if (cached && cached.stamp === stamp) { cached.used = Date.now(); return cached; }
    const f = path.join(this.dir(id), 'frames.jsonl');
    const frames = [];
    const __t0 = Date.now();
    let __size = 0;
    try { __size = fs.statSync(f).size; } catch { /* 读不到就让下面的 readFileSync 抛 */ }
    if (__size >= 32 * 1048576) {
      try {
        let __stack = '';
        try { __stack = String(new Error().stack || '').split('\n').slice(2, 5).map((l) => l.trim().replace(/^at\s+/, '').replace(/^.*agent-soul[\\/]/, '')).join(' <- '); } catch { /* ignore */ }
        fs.appendFileSync(path.join(path.dirname(this.root), 'fs-slow.log'), JSON.stringify({
          at: new Date().toISOString(), fn: 'store.load', path: id.slice(0, 40),
          sizeMB: Math.round(__size / 1048576), pid: process.pid, stack: __stack.slice(0, 320),
        }) + '\n', 'utf8');
      } catch { /* 记不进去不影响 */ }
    }
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

  /**
   * 只读文件**尾部**，从最后一条完整行里取 seq，返回 nextSeq。
   *
   * ★★ 2026-11-17（阶段 1）：append 只需要「下一帧的编号」，而原来为了这个把整个
   *   frames.jsonl 读进内存（347.7MB → 5~7 秒）。尾部 64KB 足够拿到最后一行；
   *   找不到完整行就往回扩（最多试 3 次），再不行才退回整读 —— **fail-safe，不瞎猜**。
   */
  #tailNextSeq(id, size) {
    const f = path.join(this.dir(id), 'frames.jsonl');
    let win = 64 * 1024;
    for (let attempt = 0; attempt < 3; attempt++) {
      const start = Math.max(0, size - win);
      const len = size - start;
      if (len <= 0) return 1;
      let buf = null;
      try {
        const fd = fs.openSync(f, 'r');
        try {
          buf = Buffer.allocUnsafe(len);
          fs.readSync(fd, buf, 0, len, start);
        } finally { try { fs.closeSync(fd); } catch { /* ignore */ } }
      } catch { buf = null; }
      if (!buf) break;
      let txt = buf.toString('utf8');
      // 起点不在行首时，第一行可能是半截 —— 丢掉它（除非我们从头读的）
      if (start > 0) {
        const nl = txt.indexOf('\n');
        txt = nl >= 0 ? txt.slice(nl + 1) : '';
      }
      const lines = txt.split('\n').filter((x) => x.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const o = JSON.parse(lines[i]);
          if (o && typeof o.seq === 'number') return o.seq + 1;
        } catch { /* 坏行跳过，继续往前找 */ }
      }
      win *= 8;   // 尾部没找到完整行 → 往回扩
    }
    // 兜底：整读（与旧行为一致，只是这一次会很慢）
    const e = this.load(id);
    return e ? e.nextSeq : 1;
  }

  /** 追加一帧 + 立刻写索引（同一次调用） */
  append(id, type, payload) {
    // ★ 2026-11-07：list() 的 TTL 从 5 秒提到 30 秒（1006 个会话重读首行要 1.26 秒，
    //   5 秒等于「几乎每次都重算」）。但那是缓存的代价必须在这里付 ——
    //   **刚写进去的帧，list() 必须立刻看得见**，否则「写完立即搜」会命中 0。
    //   实测踩过：live-smoke 的「写入即索引」就是这条。
    this.listCache = null;

    // ★ payload 里显式写了 undefined 的键要剔掉 ——
    //   否则 { ...payload } 会把 seq / t / type 抹成 undefined，
    //   然后 extractText 拿到 undefined 走 default，索引一条都不写，而且不报错。
    const clean = {};
    for (const [k, v] of Object.entries(payload || {})) {
      if (v !== undefined && k !== 'seq' && k !== 't' && k !== 'type') clean[k] = v;
    }

    // ★★★ 2026-11-17（阶段 1）：**大容器轻量追加**。
    //
    //   原来这里一律 this.load(id) —— 而 load 是「同步整读整个 frames.jsonl」。
    //   对 347.7MB 的容器，一次 append 就是 **5~7 秒**，而 append 是 soul-sync 每轮
    //   都在走的路径。实测调用栈（fs-watch 抓的）：
    //     readFileSync ...frames.jsonl ← store.mjs:988(load) ← store.mjs:1008(append) ← soul-sync.mjs:336
    //
    //   追加一帧真正只需要两样东西：**下一帧的 seq** 和 **一个可写的 fd**。
    //   两样都不需要把整个文件读进内存 —— seq 从**文件尾部最后一行**就能拿到。
    //
    //   ★ 判据：缓存未命中 && 文件 ≥ APPEND_TAIL_MIN_BYTES 才走轻量路径。
    //     缓存命中时照旧走原来的路（内存里已经有 frames，push 进去是对的）。
    //     小文件走原来的路（整读本来就快，而且保持「内存里有一份」的语义）。
    //   ★ 代价：轻量路径**不把 frames 装进内存**。这是有意的 ——
    //     装进去正是那 5~7 秒的来源。下次真要读全量（比如导出）时 load() 会照常整读。
    const APPEND_TAIL_MIN_BYTES = 32 * 1048576;
    const cachedEntry = this.cache.get(id);
    const sz = (() => { try { return fs.statSync(path.join(this.dir(id), 'frames.jsonl')).size; } catch { return -1; } })();
    if (sz < 0) throw new Error('会话不存在: ' + id);

    const useTailSeq = !cachedEntry && sz >= APPEND_TAIL_MIN_BYTES;
    let seq;
    if (useTailSeq) {
      seq = this.#tailNextSeq(id, sz);
    } else {
      const e = this.load(id);
      if (!e) throw new Error('会话不存在: ' + id);
      seq = e.nextSeq;
    }

    const frame = { seq, t: nowMs(), type, ...clean };
    this.#appendFrame(id, frame);
    if (!useTailSeq) {
      const e = this.cache.get(id);
      if (e) { e.frames.push(frame); e.nextSeq = seq + 1; e.stamp = this.#stamp(id); }
    }

    // ★★★ 2026-11-18 04:10 修「写入即索引」在检索层不成立。
    //
    //   症状（自检实测）：tools-selftest 里 append 两帧、紧接着 search('门牌')
    //   只命中账本层，**会话层 0 命中**，于是两条断言一起红：
    //     ✗ 会话层命中（真 SessionStore）　✗ 指针是 log:<会话>#seq=<n>
    //   根因不是索引没建，是**建了但里面没有这一帧**：
    //     · append 只更新 this.cache（帧数据）和 this.ixDirty = true（让缓存失效）
    //     · 而 search() 读的是 this.ix（检索索引），它要等下一次 buildIndex 才包含新帧
    //   于是「写完立刻搜」必然落空 —— 而这正是 append 顶上那段注释承诺过的事：
    //     「**刚写进去的帧，list() 必须立刻看得见**」。那条只兑现了 list()，没兑现 search()。
    //
    //   修法：索引已建时，直接把这一帧追加进 this.ix[id]（与 #readOne 里 push 的形状一致）。
    //     ★ 只在 ixBuilt 为真时做 —— 索引还没建的时候往里塞，会被随后的全量建索引覆盖/打乱。
    //     ★ tl 置 null：与 #readOne 同形，search 里 tlOf(r) 会按需惰性算。
    if (this.ixBuilt) {
      let rows = this.ix.get(id);
      if (!rows) { rows = []; this.ix.set(id, rows); }
      // ★ extractText 的签名是 **单个 frame 对象**（frame.mjs:6），不是 (type, payload) ——
      //   写成两参不会报错，只会让 type 被当成 frame 而恒走 default 分支返回 ''，
      //   于是索引里一条都不写、而且不报警。这正是本文件 1099 行注释警告过的那个形状。
      const text = extractText(frame);
      if (text) rows.push({ seq, t: frame.t, type, text, tl: null });
      this.ixDirty = true;
    }
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

  /**
   * 确保索引可用；**没建就踢一次后台构建，本次不等**。
   *
   * ★★★ 2026-11-17（阶段 2）：原来 search() 直接 this.buildIndex()（同步）。
   *   在缓存 124.8MB 的本机上，那一次是 **1,629 ms 的同步整读**，
   *   而它被 /api/status 的「最近命中」展示路径间接调用 —— 面板刷一下就卡 1.6 秒。
   *   实测调用栈（fs-watch）：readFileSync _index.cache ← store.mjs:469(buildIndex)
   *     ← store.mjs:1170(search) ← server.mjs:1166。
   *
   *   现在的口径：**没建就回空 + 后台建**。第一次检索可能空一次，但请求不再卡秒级。
   *   ★ 这是有代价的取舍，写在这里不藏：**首次命中可能为空**。
   *     缓解：warmup 在 listen 之后立刻建（正常路径下早就建好了，几乎撞不上）。
   *     对「展示最近命中」这类用途，空一次远好过卡 1.6 秒。
   */
  #ensureIndexAsync() {
    if (this.ixBuilt) return true;
    try {
      // ★★★ 2026-11-18 04:12：**小库同步建，大库才异步**。
      //
      //   原来的行为：一律异步（buildIndexAsync 起个后台任务，本次调用立刻 return false
      //   → search 返回 []）。那条注释自己也承认代价是「首次命中可能为空」。
      //   但对**自检 / 新会话 / 小库**来说，这个代价是荒谬的：
      //   tools-selftest 里刚 append 两帧、紧接着 search，永远 0 命中 ——
      //   「写入即索引」这条承诺在检索层根本没兑现（list() 兑现了，search() 没有）。
      //
      //   判据：会话数 < SMALL_LIB_SESSIONS 就同步建。
      //   实测口径（store.mjs 顶部注释与 STATUS.md 都记着）：1000+ 会话时同步建要 1.6 秒，
      //   那正是当初改异步的理由，所以大库（生产 1409 个）仍然走异步、不退回老问题。
      //   ★ 同步建走的是 buildIndex 的**缓存快路径**，小库通常几毫秒；
      //     只有缓存缺失才会真扫，而那已经是冷启动的既有成本。
      const SMALL_LIB_SESSIONS = 64;
      let sessionCount = 0;
      try { sessionCount = this.list().length; } catch { sessionCount = 0; }
      if (sessionCount < SMALL_LIB_SESSIONS || typeof this.buildIndexAsync !== 'function') {
        this.buildIndex();
        return this.ixBuilt;
      }
      this.buildIndexAsync({ yieldMs: 8 }).catch(() => { /* 建不起来就下次再说 */ });
    } catch { /* ignore */ }
    return false;
  }

  /** 全文检索（扫索引，简单子串；后续可换倒排） */
  search(id, needle) {
    if (!this.#ensureIndexAsync()) return [];
    const terms = tokenize(needle);
    if (!terms.length) return [];

    const rows = this.ix.get(id) || [];
    const needleLower = String(needle).toLowerCase();
    const scored = [];
    for (const r of rows) {
      const tl = tlOf(r);
      if (tl.includes(needleLower)) { scored.push({ r, score: 1 }); continue; }
      let hit = 0;
      for (const t of terms) if (tl.includes(t)) hit++;
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
    if (!this.#ensureIndexAsync()) return [];
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
