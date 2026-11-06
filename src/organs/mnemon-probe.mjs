// mnemon-probe.mjs —— 热记忆投影探针
//
// ★ 从 dsh-agent-soul/plugins/mnemon-probe/index.js 搬来（105 行，原版是宿主插件）。
//   原版挂在 `system-prompt/assemble` 钩子上，每轮把读数拼进 system prompt。
//   新软件没有那个钩子，所以它变成**纯测量器**：measure() 给数据，render() 给一段文本，
//   挂不挂、挂在哪儿，由调用方决定（见 upsert 的注释）。
//
// ★ 为什么需要它：「投影省略」是静默的。MEMORY.md 有 10KB 预算，满了以后
//   **条目仍留在磁盘上，但不再进入上下文** —— 丢的从来不是内容，是「内容存在过」这条线索。
//   实测过一次：标称 13 条 8,990 B，实际只进来 5 条。
//
// ★★ 它**做不到**的那一半（原样保留，说清，免得后人以为是 bug）：
//   「Mnemon 实际注入了几条」拿不到。原版实测扫过 assembly 的 **26 个 sections + 3 个 contexts**，
//   里面**没有** `<runtime-memory-file>` —— 热记忆不走 system prompt，它是**每轮作为消息注入**的。
//   所以这一列只能由模型自己数（比对注解里的 entries="N" 与正文实际条数）。
//   ★ 换成正则去扫会话消息可以做，但那要 agent/session 服务、代价大得多，暂不做。
//   这一版把这件事写成返回值的 `injected: null` + `injectedNote`，
//   **不拿一个假的 0 或推算值去填它。**
//
// ★ 热记忆路径做成可配（原版踩过路径找错的坑）：
//   优先级 arg（config.mnemon.runtimeDir）> 环境变量 MNEMON_RUNTIME（老版口径，兼容）> 默认 ~/.mnemon/runtime。
//   ★ 而且 dirSource 会一起返回 —— 「读的是哪个目录」必须能看见，路径找错正是这么发生的。
//
// ★ 一处**故意改掉**的判据（不是搬漏）：
//   原版把「读盘失败」也标成 hot（⚠接近上限）。对宿主插件来说那是对的 —— 文件本该在，
//   读不到就是出事了，得喊。新软件里这个目录默认可能根本不存在（用户没装 mnemon），
//   于是「没有热记忆」会被喊成「快满了」。这一版把两者分开：
//   **读不到 → ok:false + code（MISSING / NO_FILES / UNREADABLE），hot 保持 false。**
//   这和日记那条「空列表 ≠ 读不到」是同一个判据。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 两个热记忆文件与各自的字节预算 —— 与 Mnemon 的默认值一致，改动要跟着它走。 */
export const MNEMON_FILES = [
  { key: 'MEMORY.md', short: 'MEMORY', cap: 10240 },
  { key: 'USER.md', short: 'USER', cap: 4096 },
];

export const DEFAULT_RUNTIME_DIR = path.join(os.homedir(), '.mnemon', 'runtime');

/** 80 / 90 两档 —— 与老版同值。 */
export const HOT_PCT = 80;
export const FULL_PCT = 90;

const INJECTED_NOTE = '「Mnemon 实际注入了几条」探针拿不到 —— 热记忆不走 system prompt，它是每轮作为消息注入的。'
  + '要这一列只能自己数：比对条目注解里的 entries="N" 与正文实际条数。';

/**
 * 「几条」= 用 § 分隔符数非空段。
 * ★ 这是唯一能离线拿到的「条数」口径；它数的是**磁盘上的段**，不是注入数。
 *   两者会不一样（投影省略），所以两个概念不许混用一个字段名。
 */
export function countEntries(raw) {
  const body = String(raw === undefined || raw === null ? '' : raw);
  if (body.trim().length === 0) return 0;
  return body.split(/\n\s*§\s*\n/).filter((s) => s.trim().length > 0).length;
}

export class MnemonProbe {
  /**
   * @param {string|null} dir 热记忆目录。建议传 cfg.mnemon?.runtimeDir ——
   *   但 config.mjs 目前的 DEFAULTS 里还没有 mnemon 段（不在本次写域），
   *   所以调用方传 undefined 时会回落到环境变量 / 默认路径，并在 measure().dirSource 里标明。
   * @param {{ files?: Array<{key:string,short:string,cap:number}> }} opts
   */
  constructor(dir, opts = {}) {
    const given = typeof dir === 'string' && dir.trim() ? dir.trim() : '';
    const env = String(process.env.MNEMON_RUNTIME || '').trim();
    this.dir = given || env || DEFAULT_RUNTIME_DIR;
    this.dirSource = given ? 'config' : (env ? 'env' : 'default');
    this.files = Array.isArray(opts.files) && opts.files.length ? opts.files : MNEMON_FILES;
    this.budget = this.files.reduce((s, f) => s + f.cap, 0);
  }

  /**
   * 量一次磁盘。
   * 返回顶层是**聚合**读数（{entries, bytes, budget, pct}），每个文件一列在 files 里。
   * ★ 两个口径都给：只给聚合会看不出「是 MEMORY 满还是 USER 满」，而处置方式不一样。
   */
  measure() {
    const files = {};
    let readAny = false;
    let totalEntries = 0;
    let totalBytes = 0;
    let hot = false;

    for (const f of this.files) {
      const full = path.join(this.dir, f.key);
      const rec = {
        key: f.key, short: f.short, path: full, cap: f.cap,
        ok: false, exists: false, entries: 0, bytes: 0, pct: 0, tag: '未读到',
      };
      try {
        const text = fs.readFileSync(full, 'utf8');
        rec.exists = true;
        rec.ok = true;
        rec.entries = countEntries(text);
        rec.bytes = Buffer.byteLength(text, 'utf8');
        rec.pct = Math.round((rec.bytes / f.cap) * 100);
        rec.tag = rec.pct >= FULL_PCT ? '★已到上限' : rec.pct >= HOT_PCT ? '⚠接近上限' : '宽裕';
        readAny = true;
        totalEntries += rec.entries;
        totalBytes += rec.bytes;
        if (rec.pct >= HOT_PCT) hot = true;
      } catch (e) {
        // ★ 再 stat 一次，把「没有这个文件」和「有但读不了」分开 —— 两者处置不同
        try { rec.exists = fs.statSync(full).isFile(); } catch { rec.exists = false; }
        rec.code = rec.exists ? 'UNREADABLE' : 'ENOENT';
        rec.error = String((e && e.message) || e).slice(0, 120);
      }
      files[f.key] = rec;
    }

    let dirExists = false;
    try { dirExists = fs.statSync(this.dir).isDirectory(); } catch { dirExists = false; }

    const code = readAny ? (hot ? 'HOT' : 'OK')
      : (dirExists ? 'NO_FILES' : 'MISSING');

    return {
      ok: readAny,
      code,
      dir: this.dir,
      dirSource: this.dirSource,
      // 聚合读数 —— 任务要的 {entries, bytes, budget, pct} 形状
      entries: totalEntries,
      bytes: totalBytes,
      budget: this.budget,
      pct: Math.round((totalBytes / this.budget) * 100),
      hot,
      files,
      // ★ 做不到的那一半，原样留着
      injected: null,
      injectedNote: INJECTED_NOTE,
      measuredAt: Date.now(),
      hint: this.#hint(code, hot),
    };
  }

  #hint(code, hot) {
    if (code === 'MISSING') {
      return '热记忆目录不存在：' + this.dir + '（来源 ' + this.dirSource + '）。'
        + '这是「没有热记忆」，不是「快满了」。真要用，设 config.mnemon.runtimeDir 指向 Mnemon 的 runtime 目录'
        + '（默认 ' + DEFAULT_RUNTIME_DIR + '）。';
    }
    if (code === 'NO_FILES') {
      return '目录在，但里面没有 MEMORY.md / USER.md：' + this.dir + '。同样不报警 —— 这不是满。';
    }
    if (code === 'UNREADABLE') {
      return '文件在，但读不了（权限 / 编码）：' + this.dir + '。先修读取，读数才可信。';
    }
    if (hot) {
      return '★ 接近/到达上限 —— 想加新条目前先精简（优先砍「孤立、且能指向别的文件」的描述）。'
        + '跑 <你的记忆工具目录>/mem-doctor.py 看全貌。';
    }
    return '磁盘没问题。';
  }

  /** 一段可直接挂进提示的文本。★ 无读数时说「读不到」，不冒充「宽裕」。 */
  render(measured) {
    const m = measured || this.measure();
    const parts = [];
    for (const f of this.files) {
      const d = m.files[f.key];
      const short = d.short;
      if (!d || !d.ok) {
        parts.push(short + ' 读不到(' + (d && d.code ? d.code : '?') + ')');
        continue;
      }
      parts.push(short + ' ' + d.entries + '条/' + (d.bytes / 1024).toFixed(1) + 'KB(' + d.pct + '%) ' + d.tag);
    }
    const head = '[MNEMON 探针] ' + parts.join('　｜　');
    return [
      head,
      '  ' + m.hint,
      '  注：' + m.injectedNote,
      '  目录：' + m.dir + '（来源 ' + m.dirSource + '）',
    ].join('\n');
  }
}

/**
 * 幂等追加：把这一轮那一段放进 contexts 里，同名只留一份。
 *
 * ★ 这是原版 2026-10-30 那个 bug 的修法，原样搬过来（GitHub #22「探针逐字重复」）：
 *   只要宿主在同一轮里走到这个钩子两次，就会追加两份 —— 实测确实会走到两次
 *   （system prompt 的装配不只有一个阶段）。于是每轮白白多花约 300 token，
 *   而且一模一样的两块连着出现，看起来像坏了，实际是重复注入。
 *
 * ★ 为什么用幂等而不是「只走第一次」：后者要引入状态，而状态会和热重载打架；
 *   幂等是**无状态的**，重排、重入、多阶段都不影响结果。
 */
export function upsertProbeContext(contexts, text, name = 'mnemon-projection-probe') {
  const list = Array.isArray(contexts) ? contexts : [];
  return list.filter((c) => !(c && c.name === name)).concat([{ name, text }]);
}
