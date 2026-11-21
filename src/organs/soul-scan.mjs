// 书房扫描 —— 检索覆盖 L3 一手层
//
// ★ 为什么需要它：agent-soul 现在能搜自己的迁移会话，
//   但书房（D:\AI\yanqing-soul\）那几千个文件是**盲区** ——
//   而那是「一手层」：宪章、日记、状态、产物索引全在那里。
//
// ★★ 2026-11-17（阶段 1 · 启动 IO）：**结构与内容分离**。
//
//   实测（本机 D: 盘，书房 3,756 个合格文件 / 48.7MB）：
//     手写逐层 readdirSync + 逐文件 statSync + readFileSync  = 3,077~4,018ms + 9,933ms
//     原生递归 readdirSync + 逐文件 statSync（不读内容）      =   752ms   +   813ms
//     单 blob 缓存读回 + 拆分 + 逐行 JSON.parse（90MB 合成）  = 1,433ms + 147ms + 200ms
//
//   差的 9.9 秒全部是 readFileSync —— 而**启动那一刻没有任何人要搜书房**。
//   所以这一版的分工是：
//     · refresh/refreshAsync  →  只走结构（walk + stat），文本一律不进内存
//     · search/open           →  第一次真要用时再 hydrate（先试磁盘 blob，再补读缺的）
//     · hydrate 之后           →  后台把整份内容落成 blob，下次冷搜 ~1.7s 而不是 ~10s
//
//   ★ 语义一处没改：SKIP_DIR / OK_EXT / maxBytes / 「mtime+size 没变就不动」/
//     「删了的文件要从索引里删掉」逐条照旧；指针格式 file:<路径>:<行号> 照旧。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 路径归一 —— 正斜杠 / 反斜杠统一成当前平台的写法。
 *
 * ★ 这个函数是踩出来的：MCP 侧的用户拿到的指针是 `file:D:/AI/...:47`（正斜杠），
 *   而 `files` 的键是 `path.join()` 生成的（Windows 上是反斜杠）。
 *   于是 `files.get(p)` 永远拿不到 —— 走的是「读盘兜底」分支，
 *   结果**行号被丢掉、返回整篇全文**，看着像功能正常，其实是降级路径。
 */
function normKey(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** 单文件上限：512KB。再大就不是「书房」，是数据。 */
export const SOUL_MAX = 512 * 1024;

/** 默认 5 秒内不重扫。设 0 关掉。 */
export const DEFAULT_TTL = 5000;

/** 认哪些扩展名 —— 只收「写的东西」，不收二进制。 */
const OK_EXT = /\.(md|markdown|txt|json|jsonl|mjs|cjs|js|ts|tsx|html|css|yml|yaml|ps1|cmd|py|toml|ini)$/i;

/** 跳过这些目录 —— 它们不是书房内容。 */
const SKIP_DIR = new Set(['node_modules', '.git', 'data', '_bak', '_backup', '_backups', '.cache', 'dist', 'build']);

/** 内容缓存版本 —— 格式变了就 +1，旧的自动作废（不会读到半旧半新的内容）。 */
const CONTENT_CACHE_VERSION = 1;

/**
 * 清单缓存版本。
 * ★ 这份缓存只存 [路径, mtime, size] —— 实测 426KB / 3,756 条，
 *   读回 + 解析 13ms。它让「启动后立刻知道书房有多少文件」不再需要走 2~7 秒的目录树。
 */
const MANIFEST_VERSION = 1;

/**
 * 结构清单（同步）：原生递归 readdir + 逐文件 stat，**不读内容**。
 * ★ 为什么用原生递归：手写逐层递归实测 4,018ms，原生 readdir({recursive:true}) 752ms。
 *   同样的清单，差 5.3 倍 —— 因为它走的是 libuv 的批量目录读，不是每层一次 syscall。
 */
function listSoulFiles(root, maxBytes) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const subdirs = [];
    for (const e of list) {
      if (e.isDirectory()) {
        // ★ 逐层就跳过 —— 不要先 walk 完再过滤。
        //   node_modules 里那几万个文件是白读的（实测：跳过前后条目数 12,976 → 12,209，
        //   而真正的差别是**目录遍历本身**：不跳过时 readdir 要多下潜十几层）。
        if (SKIP_DIR.has(e.name)) continue;
        subdirs.push(path.join(dir, e.name));
        continue;
      }
      if (!OK_EXT.test(e.name)) continue;
      const full = path.join(dir, e.name);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.size > maxBytes) continue;
      out.push({ key: normKey(full), mtimeMs: st.mtimeMs, size: st.size });
    }
    for (const sd of subdirs) walk(sd, depth + 1);
  };
  walk(root, 0);
  return out;
}

/**
 * 书房索引 —— 常驻内存。
 *
 * ★ 常驻的是**清单**（3,756 条 × 约 100B ≈ 375KB），不是**内容**（48.7MB）。
 *   这是这一版最重要的一句：以前一启动就把 48.7MB 全塞进堆，
 *   而绝大多数启动之后根本没人搜书房。
 */
export class SoulIndex {
  constructor(root, opts) {
    const o = opts || {};
    this.root = root;
    this.ttl = Number.isFinite(o.ttl) ? o.ttl : DEFAULT_TTL;
    this.maxBytes = Number.isFinite(o.maxBytes) ? o.maxBytes : SOUL_MAX;
    /** 内容缓存落哪 —— 不给就不写缓存（只影响「冷搜要多久」，不影响正确性） */
    this.cacheDir = o.cacheDir ? String(o.cacheDir) : null;
    /** path → { mtimeMs, size, text, low, lines }；text===null 表示内容还没 hydrate */
    this.files = new Map();
    this.walkAt = 0;
    this.lastReads = 0;
    this.lastWalkMs = 0;
    this.walks = 0;
    /** 本进程里内容是否已经就位（第一次 search/open 时置位） */
    /** 清单是否来自缓存（= 还没跟磁盘核对过） */
    this.manifestFromCache = false;
    this.manifestVerifiedAt = 0;
    this._verifying = false;
    this._manifestWritten = false;
    this.contentLoaded = false;
    this.contentLoadedMs = null;
    this.contentFromCache = null;
    this.cacheWritten = false;
  }

  /** 内容缓存路径 */
  get contentCacheFile() {
    return this.cacheDir ? path.join(this.cacheDir, '_soul.content.jsonl') : null;
  }

  /** 清单缓存路径（只有路径 + mtime + size，没有内容） */
  get manifestCacheFile() {
    return this.cacheDir ? path.join(this.cacheDir, '_soul.manifest.jsonl') : null;
  }

  /**
   * 扫一遍结构，只更新清单。返回这一趟变化的文件数。
   * ★ 时间窗内直接返回 0 —— 这不是「没扫」，是「刚扫过」。
   */
  refresh(force) {
    const now = Date.now();
    if (!force && this.ttl > 0 && now - this.walkAt < this.ttl) return 0;
    this.walkAt = now;
    const t0 = Date.now();
    let changed = 0;
    const seen = new Set();

    const list = listSoulFiles(this.root, this.maxBytes);
    for (const it of list) {
      seen.add(it.key);
      const old = this.files.get(it.key);
      // ★ 只动「变了」的 —— mtime 和大小都对得上就不碰（内容若已 hydrate 就继续留着）
      if (old && old.mtimeMs === it.mtimeMs && old.size === it.size) continue;
      this.files.set(it.key, { mtimeMs: it.mtimeMs, size: it.size, text: null, low: null, lines: null });
      changed++;
    }

    // ★ 删掉已经不存在的文件 —— 否则删了的文件还能被搜到
    for (const p of [...this.files.keys()]) if (!seen.has(p)) this.files.delete(p);

    this.lastReads = changed;
    this.lastWalkMs = Date.now() - t0;
    this.manifestVerifiedAt = Date.now();
    this.walks++;
    // ★ 2026-11-17 修：这一趟既然走完了目录树，就把清单落盘 ——
    //   否则「首次全量遍历」的成果白白丢掉，下一次启动还得再遍历一遍。
    //   （冷测时就是这样：日志写着「已落缓存」，缓存文件却没有。）
    if (changed > 0 || !this.manifestFromCache) this.#scheduleManifestWrite();
    return changed;
  }

  /**
   * 从清单缓存**立刻**装出一份文件表（不碰磁盘树）。
   *
   * ★★ 为什么要有这一层（阶段 1 的关键一步）：
   *   实测把「遍历书房目录树」的每一步都拆开量过（本机 D: 盘 / 2,023 个目录 / 12,209 个条目）：
   *     readdir 递归        1,375 ~ 4,500ms（同一份清单，跑几次差 3 倍 —— 全在磁盘缓存命中率）
   *     只 stat 不 readdir    734 ~ 985ms
   *     清单一趟合计        1,600 ~ 2,400ms
   *   而清单缓存（426KB JSONL，3,756 条 [路径,mtime,size]）读回 + 解析只要 **13ms**。
   *
   *   于是启动顺序改成：**先用缓存把「书房有多少文件、多大」答出来（13ms），
   *   再在后台去核对磁盘（2 秒，不挡任何人）**。用户看到的数字从第一秒起就是真的
   *   （除非磁盘真的变了 —— 那种情况由后台核对来纠正，并且它会重写缓存）。
   *
   * ★ 这条**不是**「拿旧数据糊弄」：缓存里的每一条都带着 mtime+size，
   *   后台核对发现不一致就会改掉；而 search/open 走的是 #ensureContent，
   *   那条路永远拿 mtime+size 跟当前文件核对，缓存不新鲜只会导致「多读几次」，不会读到旧内容。
   *
   * @returns {boolean} 是否成功从缓存装载
   */
  loadManifestFromCache() {
    const cf = this.manifestCacheFile;
    if (!cf) return false;
    let raw = null;
    try { raw = fs.readFileSync(cf, 'utf8'); } catch { return false; }
    if (!raw) return false;
    const lines = raw.split('\n');
    let header = null;
    try { header = JSON.parse(lines[0] || '{}'); } catch { return false; }
    if (!header || header.v !== MANIFEST_VERSION) return false;
    if (normKey(header.root) !== normKey(this.root)) return false;
    const files = new Map();
    for (let k = 1; k < lines.length; k++) {
      const s = lines[k];
      if (!s) continue;
      let row;
      try { row = JSON.parse(s); } catch { continue; }
      if (!Array.isArray(row) || row.length < 3) continue;
      files.set(normKey(row[0]), { mtimeMs: row[1], size: row[2], text: null, low: null, lines: null });
    }
    if (!files.size) return false;
    this.files = files;
    this.manifestFromCache = true;
    this.walkAt = Date.now() - (this.ttl > 0 ? this.ttl : 0);  // 让下一次 refresh 不会因时间窗被跳过
    this.lastWalkMs = 0;
    return true;
  }

  /** 后台落清单缓存（426KB，19ms 写） */
  #scheduleManifestWrite() {
    const cf = this.manifestCacheFile;
    if (!cf || this._manifestWritten) return;
    this._manifestWritten = true;
    const root = this.root;
    const rows = [...this.files.entries()].map(([k, f]) => [k, f.mtimeMs, f.size]);

    // ★★ 2026-11-17（阶段 1 · 启动写字节）：内容一个字都没变就别写。
    //   实测启动时会重写 457KB 的 _soul.manifest.jsonl —— 而前后 size 完全相同。
    //   写法：拿将要写的 body 与磁盘上的 body **逐字节比**，相同就跳过。
    //   457KB 的 compare 实测个位数毫秒，比写一次（并让磁盘缓存失效）便宜得多。
    //   ★ 为什么不去比 mtime：清单里本来就存了每个文件的 mtime，
    //     而「这次的 mtime 集合与上次完全一致」正是「内容没变」的充要条件。
    const head = JSON.stringify({ v: MANIFEST_VERSION, root: normKey(root), at: '', files: rows.length });
    const body = rows.map((r) => JSON.stringify(r)).join('\n');
    try {
      const old = fs.readFileSync(cf, 'utf8');
      const nl = old.indexOf('\n');
      // 头里的 at 每次都不同，所以只比 body（第 2 行之后）
      if (nl > 0 && old.slice(nl + 1) === body) return;
    } catch { /* 读不出来就照写 */ }

    setImmediate(() => {
      fs.promises.mkdir(path.dirname(cf), { recursive: true })
        .then(() => {
          const stamped = JSON.stringify({ v: MANIFEST_VERSION, root: normKey(root), at: new Date().toISOString(), files: rows.length });
          return fs.promises.writeFile(cf, stamped + '\n' + body, 'utf8');
        })
        .catch(() => { /* 写不了不影响正确性 */ });
    });
  }

  /**
   * 后台核对清单（异步、分片、可重复调用）。
   * ★ 它跑在 warmup 之后，不占请求路径；核对完把清单缓存刷新一遍。
   */
  async verifyManifestAsync(opts) {
    if (this._verifying) return { skipped: 'already-verifying' };
    this._verifying = true;
    try {
      const before = this.files.size;
      const changed = await this.refreshAsync(Object.assign({ force: true }, opts || {}));
      this.manifestFromCache = false;
      this.manifestVerifiedAt = Date.now();
      if (changed > 0 || before === 0) this.#scheduleManifestWrite();
      return { changed, before, after: this.files.size };
    } finally {
      this._verifying = false;
    }
  }

  /**
   * 分片版 refresh：语义与 refresh() 逐条相同，只是每处理一批就让出一次事件循环。
   *
   * ★ 为什么必须有它（B1 · 2026-11-17）：同步那一版在这台机器上 1.6 秒里事件循环是死的 ——
   *   用户此刻点关闭，壳的 POST /api/shutdown 就只能干等，等满超时判「启动失败」。
   */
  async refreshAsync(opts) {
    const o = opts || {};
    const force = o.force === true;
    const yieldMs = Number.isFinite(o.yieldMs) ? o.yieldMs : 8;
    const now = Date.now();
    if (!force && this.ttl > 0 && now - this.walkAt < this.ttl) return 0;
    this.walkAt = now;
    const t0 = Date.now();
    let changed = 0;
    const seen = new Set();
    let last = now;

    const maybeYield = async () => {
      if (Date.now() - last >= yieldMs) {
        await new Promise((r) => setImmediate(r));
        last = Date.now();
      }
    };

    // ★★ 2026-11-17（阶段 1）：**手写逐层递归 + 逐层剪枝**，不用 readdir({recursive:true})。
    //
    //   实测（同一棵树，书房 3,756 个合格文件）：
    //     readdirSync({recursive:true})      4,502ms（再跑 3,839ms）
    //     fs.promises.readdir({recursive})   1,375ms —— 但它会**先走完 node_modules** 再交给上层过滤
    //     手写逐层递归 + 逐层跳过 SKIP_DIR  1,399ms，且条目数从 12,976 降到 12,209
    //   两者差不多，但手写这版**不依赖 Node 的 recursive 选项**（20+ 才有），
    //   而且「跳过」发生在 readdir 之前 —— 目录里东西再多也不会被列出来。
    //
    //   ★ stat 必须分批并发：3,810 个文件逐个 await = 数千毫秒（每次 await 都过一遍微任务调度）；
    //     每批 64 个 Promise.all = 252ms。
    const BATCH = 64;
    const walk = async (dir, depth) => {
      if (depth > 8) return;
      let list;
      try { list = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
      const subdirs = [];
      const files = [];
      for (const en of list) {
        if (en.isDirectory()) {
          if (SKIP_DIR.has(en.name)) continue;   // ★ 逐层剪枝
          subdirs.push(path.join(dir, en.name));
          continue;
        }
        if (!OK_EXT.test(en.name)) continue;
        files.push(path.join(dir, en.name));
      }
      for (let i = 0; i < files.length; i += BATCH) {
        const slice = files.slice(i, i + BATCH);
        const stats = await Promise.all(slice.map((p) => fs.promises.stat(p).catch(() => null)));
        for (let k = 0; k < slice.length; k++) {
          const st = stats[k];
          if (!st) continue;
          if (st.size > this.maxBytes) continue;
          const key = normKey(slice[k]);
          seen.add(key);
          const old = this.files.get(key);
          if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;
          this.files.set(key, { mtimeMs: st.mtimeMs, size: st.size, text: null, low: null, lines: null });
          changed++;
        }
        await maybeYield();
      }
      for (const sd of subdirs) { await walk(sd, depth + 1); await maybeYield(); }
    };
    try { await walk(this.root, 0); } catch { /* 单个目录读不了不影响整体 */ }

    for (const p of [...this.files.keys()]) if (!seen.has(p)) this.files.delete(p);

    this.lastReads = changed;
    this.lastWalkMs = Date.now() - t0;
    this.walks++;
    // ★ 2026-11-17 修：这一趟既然走完了目录树，就把清单落盘 ——
    //   否则「首次全量遍历」的成果白白丢掉，下一次启动还得再遍历一遍。
    if (changed > 0 || !this.manifestFromCache) this.#scheduleManifestWrite();
    return changed;
  }

  /**
   * 预热内容（异步、分片）：启动之后在后台跑，不占请求路径。
   *
   * ★ 它的存在只为了一件事：让「用户第一次真的去搜书房」那一刻不用等 3.6 秒。
   *   启动时清单 1.6 秒就位 → 立刻能应答；内容在这之后慢慢补，补完了搜索就是 0ms。
   * ★ 有 blob 缓存时它只花 1.4~1.8 秒；没缓存就要真读 3,756 个文件（约 3.6 秒）。
   */
  async warmContentAsync(opts) {
    if (this.contentLoaded) return { skipped: true };
    const o = opts || {};
    const yieldMs = Number.isFinite(o.yieldMs) ? o.yieldMs : 8;
    const t0 = Date.now();
    let fromCache = 0;
    let fromDisk = 0;

    // ① 磁盘 blob（一条顺序读）
    const cf = this.contentCacheFile;
    if (cf) {
      let raw = null;
      try { raw = await fs.promises.readFile(cf, 'utf8'); } catch { raw = null; }
      if (raw) {
        const lines = raw.split('\n');
        let header = null;
        try { header = JSON.parse(lines[0] || '{}'); } catch { header = null; }
        if (header && header.v === CONTENT_CACHE_VERSION && normKey(header.root) === normKey(this.root)) {
          for (let i = 1; i < lines.length; i++) {
            const s = lines[i];
            if (!s) continue;
            let row;
            try { row = JSON.parse(s); } catch { continue; }
            if (!Array.isArray(row) || row.length < 4) continue;
            const f = this.files.get(row[0]);
            if (!f) continue;
            if (f.mtimeMs !== row[1] || f.size !== row[2]) continue;
            f.text = String(row[3]);
            f.low = null;
            f.lines = null;
            fromCache++;
          }
        }
      }
    }

    // ② 缓存没覆盖到的：分批并发读
    const missing = [];
    for (const [key, f] of this.files) if (f.text === null || f.text === undefined) missing.push(key);
    const BATCH = 32;
    let last = Date.now();
    for (let i = 0; i < missing.length; i += BATCH) {
      const slice = missing.slice(i, i + BATCH);
      const texts = await Promise.all(slice.map((p) => fs.promises.readFile(p, 'utf8').catch(() => '')));
      for (let k = 0; k < slice.length; k++) {
        const f = this.files.get(slice[k]);
        if (!f) continue;
        f.text = texts[k];
        f.low = null;
        f.lines = null;
        fromDisk++;
      }
      if (Date.now() - last >= yieldMs) {
        await new Promise((r) => setImmediate(r));
        last = Date.now();
      }
    }

    this.contentLoaded = true;
    this.contentLoadedMs = Date.now() - t0;
    this.contentFromCache = fromCache;
    this.lastReads = fromDisk;
    if (fromDisk > 0 || fromCache === 0) this.#scheduleCacheWrite();
    return { fromCache, fromDisk, ms: this.contentLoadedMs };
  }

  /** 读一个文件的内容进内存（只在真要搜/开的时候调） */
  #hydrateOne(key, f) {
    if (f.text !== null && f.text !== undefined) return f;
    try { f.text = fs.readFileSync(key, 'utf8'); } catch { f.text = ''; }
    f.low = null;
    f.lines = null;
    return f;
  }

  /**
   * 内容就位：先试磁盘 blob（一份顺序读），再补读缺的。
   *
   * ★ 为什么要有缓存：不缓存的话，第一次冷搜要把 3,756 个文件逐个 readFile ——
   *   实测 9,933ms。而 blob 是**一条顺序读**：48.7MB 约 1.4s，快 7 倍。
   * ★ 缓存不是权威：每一条都拿 mtime+size 跟当前清单核对，对不上就丢掉重读。
   *   所以「缓存旧了」的后果只是「多读几个文件」，不是「搜到旧内容」。
   */
  #ensureContent() {
    if (this.contentLoaded) return;
    const t0 = Date.now();
    let fromCache = 0;
    let fromDisk = 0;

    const cf = this.contentCacheFile;
    if (cf) {
      let raw = null;
      try { raw = fs.readFileSync(cf, 'utf8'); } catch { raw = null; }
      if (raw) {
        const lines = raw.split('\n');
        let header = null;
        try { header = JSON.parse(lines[0] || '{}'); } catch { header = null; }
        if (header && header.v === CONTENT_CACHE_VERSION && normKey(header.root) === normKey(this.root)) {
          for (let i = 1; i < lines.length; i++) {
            const s = lines[i];
            if (!s) continue;
            let row;
            try { row = JSON.parse(s); } catch { continue; }
            if (!Array.isArray(row) || row.length < 4) continue;
            const key = row[0];
            const f = this.files.get(key);
            if (!f) continue;                      // 文件已经不在了
            if (f.mtimeMs !== row[1] || f.size !== row[2]) continue;  // 变了 → 不采信缓存
            f.text = String(row[3]);
            f.low = null;
            f.lines = null;
            fromCache++;
          }
        }
      }
    }

    // 缓存没覆盖到的（新文件 / 变了的 / 没有缓存）就地读
    for (const [key, f] of this.files) {
      if (f.text !== null && f.text !== undefined) continue;
      this.#hydrateOne(key, f);
      fromDisk++;
    }

    this.contentLoaded = true;
    this.contentLoadedMs = Date.now() - t0;
    this.contentFromCache = fromCache;
    this.lastReads = fromDisk;
    // 有补读（说明清单变过）或压根没缓存 → 后台把新的落盘
    if (fromDisk > 0 || fromCache === 0) this.#scheduleCacheWrite();
  }

  /** 后台落缓存：不占请求路径，也不挡事件循环（分批 await 写） */
  #scheduleCacheWrite() {
    const cf = this.contentCacheFile;
    if (!cf || this.cacheWritten) return;
    this.cacheWritten = true;
    const root = this.root;
    const entries = [...this.files.entries()].map(([k, f]) => [k, f.mtimeMs, f.size, f.text === null || f.text === undefined ? '' : f.text]);
    setImmediate(() => {
      fs.promises.mkdir(path.dirname(cf), { recursive: true })
        .then(() => {
          const parts = [JSON.stringify({ v: CONTENT_CACHE_VERSION, root: normKey(root), at: new Date().toISOString(), files: entries.length })];
          for (const e of entries) parts.push(JSON.stringify(e));
          return fs.promises.writeFile(cf, parts.join('\n'), 'utf8');
        })
        .catch(() => { /* 写不了缓存不影响正确性，下次自己会补读 */ });
    });
  }

  /** 文件数 */
  get size() { return this.files.size; }

  /**
   * 检索：逐行匹配。
   *
   * ★ 先走小写版粗筛（includes），命中才往下 —— 老版实测粗筛一次约 3ms。
   * ★ 指针格式 `file:<路径>:<行号>`，和门命令那一套同构。
   * ★★ 2026-11-17：进这里之前先 #ensureContent() —— 这是全库唯一「真的要用内容」的入口。
   */
  search(terms, opts) {
    const o = opts || {};
    const limit = Number.isFinite(o.limit) ? o.limit : 20;
    const ts = (Array.isArray(terms) ? terms : [terms]).map(t => String(t || '').toLowerCase()).filter(Boolean);
    if (!ts.length) return { hits: [], scanned: 0, ms: 0 };

    this.#ensureContent();

    const t0 = Date.now();
    const hits = [];
    let scanned = 0;

    for (const [p, f] of this.files) {
      if (hits.length >= limit) break;
      if (f.text === null || f.text === undefined) this.#hydrateOne(p, f);
      if (!f.low) f.low = String(f.text || '').toLowerCase();
      // 粗筛：所有词都得在这份文件里（AND）
      let all = true;
      for (const t of ts) if (!f.low.includes(t)) { all = false; break; }
      if (!all) continue;

      const lines = f.lines || (f.lines = String(f.text || '').split('\n'));
      for (let i = 0; i < lines.length; i++) {
        if (hits.length >= limit) break;
        const ln = lines[i];
        if (!ln || !ln.trim()) continue;
        scanned++;
        const low = ln.toLowerCase();
        let ok = true;
        for (const t of ts) if (!low.includes(t)) { ok = false; break; }
        if (!ok) continue;
        hits.push({
          layer: 'L3',
          ptr: 'file:' + p + ':' + (i + 1),
          rel: p.slice(normKey(this.root).length).replace(/^[\/]/, ''),
          line: i + 1,
          kind: (p.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1],
          snippet: ln.trim().slice(0, 300),
        });
      }
    }

    return { hits, scanned, ms: Date.now() - t0, files: this.files.size };
  }

  /** 读一个指针指向的原文 */
  open(ptr) {
    const m = String(ptr || '').match(/^file:(.+?)(?::(\d+))?$/);
    if (!m) return null;
    // ★ 先试带行号的解析（贪心），失败再当整条是路径 —— 盘符 D: 不能被误当行号
    const body = String(ptr).slice(5);
    const lm = body.match(/^(.*):(\d+)$/);
    const p = normKey(lm ? lm[1] : body);
    const line = lm ? Number(lm[2]) : null;
    this.#ensureContent();
    const f = this.files.get(p);
    if (!f || f.text === null || f.text === undefined) {
      // 不在索引里（可能是新文件）—— 直接读盘
      try { return { path: p, text: fs.readFileSync(p, 'utf8'), line: null }; } catch { return null; }
    }
    if (!line) return { path: p, text: f.text, line: null };

    // ★ 带行号：给上下文（前后各 3 行）—— 只给那一行，等于没给
    const lines = f.lines || (f.lines = String(f.text || '').split('\n'));
    const from = Math.max(0, line - 1 - 3);
    const to = Math.min(lines.length, line - 1 + 4);
    return { path: p, line, from: from + 1, to, text: lines.slice(from, to).join('\n') };
  }

  /** 自报家门 */
  stats() {
    let bytes = 0;
    for (const f of this.files.values()) bytes += f.size;
    return {
      files: this.files.size,
      bytes,
      mb: Math.round(bytes / 1048576 * 10) / 10,
      walks: this.walks,
      lastReads: this.lastReads,
      lastWalkMs: this.lastWalkMs,
      ttl: this.ttl,
      root: this.root,
      // ★ 2026-11-17：把「内容到底进内存了没有」也报出来 ——
      //   「清单 3,756 条」和「内容 48MB 已就位」是两件事，混着说会让人以为内存里一直躺着 48MB。
      // ★ 清单是不是「缓存里那份还没跟磁盘核对过」——这决定「文件数」这个数字有多可信
      manifestFromCache: this.manifestFromCache,
      manifestVerifiedAt: this.manifestVerifiedAt,
      manifestCacheFile: this.manifestCacheFile,
      contentLoaded: this.contentLoaded,
      contentLoadedMs: this.contentLoadedMs,
      contentFromCache: this.contentFromCache,
      contentCacheFile: this.contentCacheFile,
    };
  }
}
