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
      const f = path.join(this.root, name, 'frames.jsonl');
      if (!fs.existsSync(f)) continue;
      try {
        // ★ 只读头部 4KB —— 原来写的是 readFileSync(f) 然后取第一行，
        //   那是**读整个文件**。实测：1006 个会话 list 一次 6.3 秒，
        //   因为其中一个会话是 308MB。改成只读头 4KB 后掉到 130ms。
        const first = readFirstLine(f);
        if (!first) continue;
        const h = JSON.parse(first);
        if (h.type !== FRAME.SESSION) continue;
        const stat = fs.statSync(f);
        out.push({ id: h.id, cwd: h.cwd, persona: h.persona, createdAt: h.t, mtime: stat.mtimeMs, bytes: stat.size });
      } catch { /* 跳过坏目录 */ }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    this.listCache = out;
    this.listAt = now;
    return out;
  }

  /**
   * 建内存索引（懒建，第一次检索时触发）。
   * ★ 只读 index.jsonl，不碰 frames.jsonl —— 后者体积大得多。
   */
  buildIndex() {
    if (this.ixBuilt) return this.ix.size;
    this.ix.clear();

    const metas = this.list();
    const now = {};
    for (const m of metas) {
      const f = path.join(this.dir(m.id), 'index.jsonl');
      try { const st = fs.statSync(f); now[m.id] = st.size + ':' + st.mtimeMs; } catch { now[m.id] = '0:0'; }
    }

    // ① 试缓存
    let fp = null;
    try { fp = JSON.parse(fs.readFileSync(this.fpFile, 'utf8')); } catch {}
    if (fp && fs.existsSync(this.cacheFile)) {
      const t = Date.now();
      try {
        const buf = fs.readFileSync(this.cacheFile, 'utf8');
        let same = 0, diff = 0;
        for (const line of buf.split('\n')) {
          if (!line) continue;
          const p = line.split('\u0001');
          if (p.length < 5) continue;
          const sid = p[0];
          if (fp[sid] !== now[sid]) { diff++; continue; }   // 变过的会话，这行不可信
          let a = this.ix.get(sid);
          if (!a) { a = []; this.ix.set(sid, a); }
          const txt = p[4];
          a.push({ seq: Number(p[1]), t: Number(p[2]), type: p[3], text: txt, tl: txt.toLowerCase() });
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

  /** 读一个会话的 index.jsonl 进内存 */
  #readOne(id) {
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
    this.ix.set(id, rows);
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
      for (const r of rows) {
        parts.push([m.id, r.seq, r.t, r.type, String(r.text || '').replace(/[\n\r\u0001]/g, ' ')].join('\u0001'));
      }
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

  /** 存索引（外部在退出前调） */
  saveIndexCache() {
    if (!this.ixBuilt || !this.ixDirty) return 0;
    try { return this.#saveIndex(); } catch { return 0; }
  }

  /** 追加一帧到内存索引（写路径顺手调） */
  #ixPush(id, row) {
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
