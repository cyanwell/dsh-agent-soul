// src/skills/index.mjs —— 技能库（扫目录 + 按名加载）。
//
// ★ 为什么 v4 需要它：DSH 里「技能」是一个独立的能力位（preset 的 skill-filesystem + tool-skill 两行），
//   它不是工具 —— 工具决定「能调什么」，技能决定「遇到这类活该怎么做」。
//   清点时实测：v4 只有工具和器官，**没有任何东西去加载那 21 个技能**。
//   DSH 一撤，能力还在，方法丢了。
//
// ★ 三条判据（只在这里写一次）：
//   1. **一个技能 = 一个目录**。正文优先级 SKILL.md > README.md > 目录里第一个 .md。
//      实测发现文件名不统一（darwin-skill 只有 README.md，huashu-art-motion 是 CHANGELOG.md），
//      所以不能只认 SKILL.md，但**必须**有一个确定的优先序 —— 否则同一目录两次扫描可能选到不同文件。
//   2. **只读**。本模块不写、不改、不建目录。加载 = 把正文读进内存。
//   3. **frontmatter 是元信息的唯一来源**：--- 之间取 name / description / tags。
//      解析器是**手写的极小子集**（不做完整 YAML）—— 因为它只吃我们自己写的技能文件，
//      而引入一个 YAML 解析器只为读四行头，是把依赖换成风险。
//
// ★ 缓存用目录 mtime：技能文件几乎不变，但「刚写的技能立刻能读到」要成立。
//   TTL 5 秒（与 echo 的 SOUL_TTL 同量级）—— 检索类的东西都是往回看，5 秒可接受。

import fs from 'node:fs';
import path from 'node:path';

const TTL_MS = 5000;
const BODY_MAX = 400 * 1024;   // 单份技能正文上限（实测最大的 27KB，400KB 是给异常留的闸）

/** frontmatter：--- 之间取 name / description / tags；支持 description: | 的多行块。 */
export function parseFrontmatter(text) {
  const src = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src.trim(), hadFrontmatter: false };
  const meta = {};
  const lines = m[1].split(/\r?\n/);
  let key = null;
  let block = null;
  for (const line of lines) {
    if (block !== null) {
      // 多行块：缩进行继续累积，非缩进行收尾
      if (/^\s+\S/.test(line) || line.trim() === '') { block.push(line.trim()); continue; }
      meta[key] = block.filter(Boolean).join(' ').trim();
      block = null; key = null;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const k = kv[1];
    const v = kv[2].trim();
    if (v === '|' || v === '>' || v === '|-') { key = k; block = []; continue; }
    meta[k] = v;
  }
  if (block !== null && key) meta[key] = block.filter(Boolean).join(' ').trim();
  return { meta, body: src.slice(m[0].length).trim(), hadFrontmatter: true };
}

/** 一个目录里的正文文件：SKILL.md > README.md > 首个 .md（按名字排序，保证确定性）。 */
function pickBodyFile(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const md = names.filter((n) => /\.md$/i.test(n)).sort();
  if (!md.length) return null;
  for (const prefer of ['SKILL.md', 'SKILL.md', 'README.md']) {
    const hit = md.find((n) => n.toLowerCase() === prefer.toLowerCase());
    if (hit) return hit;
  }
  return md[0];
}

function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }

export class SkillLibrary {
  /** @param {{dirs?:string[], ttlMs?:number, log?:(m:string)=>void}} opts */
  constructor(opts = {}) {
    this.dirs = (opts.dirs || []).filter(Boolean);
    this.ttlMs = Number.isFinite(opts.ttlMs) && opts.ttlMs > 0 ? opts.ttlMs : TTL_MS;
    this.log = typeof opts.log === 'function' ? opts.log : () => {};
    this._at = 0;
    this._items = [];
    this._missing = [];
  }

  /** 重扫。返回 { items, missing }。 */
  scan() {
    const items = [];
    const missing = [];
    const seen = new Set();
    for (const root of this.dirs) {
      const st = statSafe(root);
      if (!st || !st.isDirectory()) { missing.push(root); continue; }
      let names = [];
      try { names = fs.readdirSync(root); } catch { missing.push(root); continue; }
      for (const name of names) {
        if (name.startsWith('.')) continue;
        const dir = path.join(root, name);
        const ds = statSafe(dir);
        if (!ds || !ds.isDirectory()) continue;
        if (seen.has(name)) continue;          // 同名技能：先出现的目录优先，后出现的不覆盖
        const file = pickBodyFile(dir);
        if (!file) { continue; }                 // 没有 .md 的目录不算技能
        const full = path.join(dir, file);
        const fs2 = statSafe(full);
        if (!fs2 || fs2.size > BODY_MAX) { continue; }
        let text = '';
        try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
        const { meta } = parseFrontmatter(text);
        seen.add(name);
        items.push({
          name: meta.name || name,
          dirName: name,
          description: meta.description || '',
          tags: meta.tags ? String(meta.tags).split(/[,\s]+/).filter(Boolean) : [],
          root,
          dir,
          file,
          bytes: fs2.size,
          mtimeMs: fs2.mtimeMs,
        });
      }
    }
    items.sort((a, b) => a.name.localeCompare(b.name));
    this._items = items;
    this._missing = missing;
    this._at = Date.now();
    return { items, missing };
  }

  _fresh() { return this._at > 0 && Date.now() - this._at < this.ttlMs; }

  /** 列出技能（元信息，不含正文）。 */
  list({ refresh = false } = {}) {
    if (refresh || !this._fresh()) this.scan();
    return this._items.slice();
  }

  /** 元信息 + 正文。找不到返回 null。 */
  get(name, { refresh = false } = {}) {
    const want = String(name || '').trim();
    if (!want) return null;
    if (refresh || !this._fresh()) this.scan();
    const hit = this._items.find((x) => x.name === want || x.dirName === want);
    if (!hit) return null;
    let text = '';
    try { text = fs.readFileSync(path.join(hit.dir, hit.file), 'utf8'); } catch { return null; }
    const { meta, body } = parseFrontmatter(text);
    return { ...hit, meta, body, chars: body.length };
  }

  /** 状态：给状态台/工具用。 */
  stats() {
    const items = this.list();
    return {
      roots: this.dirs.slice(),
      missingRoots: this._missing.slice(),
      count: items.length,
      bytes: items.reduce((n, x) => n + x.bytes, 0),
      scannedAt: this._at ? new Date(this._at).toISOString() : null,
    };
  }
}
