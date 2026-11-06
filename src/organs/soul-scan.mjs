// 书房扫描 —— 检索覆盖 L3 一手层
//
// ★ 为什么需要它：agent-soul 现在能搜自己的 985 个迁移会话，
//   但书房（D:\AI\yanqing-soul\）那 3,568 个文件是**盲区** ——
//   而那是「一手层」：宪章、日记、状态、产物索引全在那里。
//
// ★ 从老 echo 搬过来的四个设计：
//   ① 【只读「变了」的文件】stat 仍是逐个（目录 mtime 发现不了内容改），
//      但内容和 mtime+size 一比就知道要不要重读。
//   ② 【5 秒时间窗】书房 3,568 文件全量 walk+stat 实测 737ms。
//      「soul=auto」的触发条件是「索引命中 < 5」，所以凡是冷门词都会吃这 737ms。
//      书房是「我自己在写」的地方、不会频繁变 —— 5 秒内不重扫。
//      代价：刚写的文件 5 秒内搜不到（可接受，检索基本都是往回看）。
//   ③ 【lines 懒解析】每次重建行数组是那 700ms 的大头，所以缓存进 f.lines。
//   ④ 【512KB 上限】超大的文件不读（日志、打包产物）。

import fs from 'node:fs';
import path from 'node:path';

/**
 * 路径归一 —— 正斜杠 / 反斜杠统一成当前平台的写法。
 *
 * ★ 这个函数是踩出来的：MCP 侧的用户拿到的指针是 `file:D:/AI/...:47`（正斜杠），
 *   而 `files` 的键是 `path.join()` 生成的（Windows 上是反斜杠）。
 *   于是 `files.get(p)` 永远拿不到 —— 走的是「读盘兜底」分支，
 *   结果**行号被丢掉、返回整篇全文**，看着像功能正常，其实是降级路径。
 *   这跟压缩那边「错的门牌比没有更坏」是同一类：**看着对，其实没生效。**
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

/**
 * 书房索引 —— 常驻内存，只重读变了的文件。
 *
 * ★ 为什么常驻：这门是要被反复开的。每次重新 walk 3,568 个文件，
 *   一次检索就是 737ms 起 —— 那不是「慢一点」，那是**不用它**。
 */
export class SoulIndex {
  constructor(root, opts) {
    const o = opts || {};
    this.root = root;
    this.ttl = Number.isFinite(o.ttl) ? o.ttl : DEFAULT_TTL;
    this.maxBytes = Number.isFinite(o.maxBytes) ? o.maxBytes : SOUL_MAX;
    /** path → { mtimeMs, size, text, low, lines } */
    this.files = new Map();
    this.walkAt = 0;
    this.lastReads = 0;
    this.lastWalkMs = 0;
    this.walks = 0;
  }

  /**
   * 扫一遍，只读变了的。返回这次读了几份。
   * ★ 时间窗内直接返回 0 —— 这不是「没扫」，是「刚扫过」。
   */
  refresh(force) {
    const now = Date.now();
    if (!force && this.ttl > 0 && now - this.walkAt < this.ttl) return 0;
    this.walkAt = now;
    const t0 = Date.now();
    let reads = 0;
    const seen = new Set();

    const walk = (dir, depth) => {
      if (depth > 8) return;
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIR.has(e.name)) continue;
          walk(p, depth + 1);
          continue;
        }
        if (!OK_EXT.test(e.name)) continue;
        seen.add(normKey(p));
        let st; try { st = fs.statSync(p); } catch { continue; }
        if (st.size > this.maxBytes) continue;

        const old = this.files.get(normKey(p));
        // ★ 只读「变了」的 —— mtime 和大小都对得上就跳过
        if (old && old.mtimeMs === st.mtimeMs && old.size === st.size) continue;

        let txt; try { txt = fs.readFileSync(p, 'utf8'); } catch { continue; }
        this.files.set(normKey(p), { mtimeMs: st.mtimeMs, size: st.size, text: txt, low: null, lines: null });
        reads++;
      }
    };

    try { walk(this.root, 0); } catch { /* 单个目录读不了不影响整体 */ }

    // ★ 删掉已经不存在的文件 —— 否则删了的文件还能被搜到
    for (const p of [...this.files.keys()]) if (!seen.has(p)) this.files.delete(p);

    this.lastReads = reads;
    this.lastWalkMs = Date.now() - t0;
    this.walks++;
    return reads;
  }

  /** 文件数 */
  get size() { return this.files.size; }

  /**
   * 检索：逐行匹配。
   *
   * ★ 先走小写版粗筛（includes），命中才往下 —— 老版实测粗筛一次约 3ms。
   * ★ 指针格式 `file:<路径>:<行号>`，和门命令那一套同构。
   */
  search(terms, opts) {
    const o = opts || {};
    const limit = Number.isFinite(o.limit) ? o.limit : 20;
    const ts = (Array.isArray(terms) ? terms : [terms]).map(t => String(t || '').toLowerCase()).filter(Boolean);
    if (!ts.length) return { hits: [], scanned: 0, ms: 0 };

    const t0 = Date.now();
    const hits = [];
    let scanned = 0;

    for (const [p, f] of this.files) {
      if (hits.length >= limit) break;
      if (!f.low) f.low = f.text.toLowerCase();
      // 粗筛：所有词都得在这份文件里（AND）
      let all = true;
      for (const t of ts) if (!f.low.includes(t)) { all = false; break; }
      if (!all) continue;

      const lines = f.lines || (f.lines = f.text.split('\n'));
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
          rel: p.slice(this.root.length).replace(/^[\\/]/, ''),
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
    const f = this.files.get(p);
    if (!f) {
      // 不在索引里（可能是新文件）—— 直接读盘
      try { return { path: p, text: fs.readFileSync(p, 'utf8'), line: null }; } catch { return null; }
    }
    if (!line) return { path: p, text: f.text, line: null };

    // ★ 带行号：给上下文（前后各 3 行）—— 只给那一行，等于没给
    const lines = f.lines || (f.lines = f.text.split('\n'));
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
    };
  }
}