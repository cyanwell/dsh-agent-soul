// query.mjs —— 门：一扇门搜记忆，只回【指针 + 逐字片段】，不做转述
//
// ★ 从 dsh-agent-soul/plugins/tools/gateway/query.mjs 搬来（原版是 CLI + 一份预建 index.json）。
//   改了形态，没改判据：
//     · CLI（node query.mjs <词> / open <指针>）→ 现在是一个类，宿主自己调。
//     · 预建索引 → 实时读账本（只追加，带 size+mtime 缓存）。
//       **为什么去掉索引**：新软件里会话存储自己就有内存索引；账本只有几 MB。
//       多一份索引文件就多一份会和事实错位的东西 —— 索引陈旧 = 悄悄给错的答案。
//     · 指针口径换了，理由写在下面那段。
//
// ★★ 原版两条纪律原样保留：
//   ① **只回指针 + 逐字片段，不做转述** —— 转述是二手污染的来源。
//      摘要说「他当时不同意」，原文说「这个方向先放一放」，差的不是措辞，是事实。
//   ② **拿不到精确地址时写「未知」并给检索入口，绝不猜** ——
//      错的地址比没有更坏：它会返回错误内容，而且在形式上与正确结果无法区分。
//
// ★ 指针（这一版最需要说清的地方）：
//   · 账本    `墨:<文件行号>` —— 用**行号**不用时间。
//            只追加账本里行号是稳定的；而同一秒能写进多条（批量写入实测有），
//            时间撞了就不唯一，不唯一的门牌等于猜。原版 index.mjs 选 `ledger:<i>` 正是同一判据。
//   · 会话帧  `log:<sessionId>#seq=<n>` —— 与项目里压缩摘要的门牌同构。
//   · 书房    `file:<路径>:<行号>` —— 沿用 SoulIndex 自己的口径。
//   ★ 三种都以「能回到原文」为唯一判据，不为了好看改形状。
//
// ★ 没做到的（写清，免得后人以为是 bug）：
//   原版把账本的 ref（出处）拼进可搜文本，于是搜出处路径也能命中 ——
//   代价是片段里会混进「（出处：…）」这种不是原文的字。
//   这一版让片段永远是原文的连续子串，所以 **ref / feel 不参与匹配**，只随行返回。
//   要按出处路径找东西，走书房检索，别指望这扇门。
//
// ★★ log: 门牌怎么解析（2026-11-11 修——原来只按容器 seq 查，会取错原文）
//   log:<sid>#seq=n 的 n 有**两个可能的主人**：
//     · 宿主原帧号 —— DSH 的 seq，同步进来时落在 frames[i].meta.seq（toFrames 原样带的）
//     · 容器帧号   —— 本软件自己 append 时分配的 frames[i].seq（1,2,3…）
//   两个都在同一个会话里递增，**同一个 n 通常指向两帧不同内容**。
//   而 cleanup 回执 / 压缩门牌给的是**宿主 seq**（pruner 按宿主帧号裁剪），
//   所以先精确匹配 meta.seq；只有没有 meta 匹配时才回退容器 seq（旧内部帧兼容）。
//   ★ 多个宿主帧命中但内容不同 → **报歧义并列候选，绝不静默任选**。
//     这与本文件开头的判据同一条：「错的地址比没有更坏」。
//   ★ 返回里一定带 matchedBy / containerSeq / hostSeq —— 取到的是哪一路，必须能核对。
//
// ★ 依赖：只用 node: 与 ../session/frame.mjs 的纯文本提取。
//   不 import 任何器官实例 —— 这样它能被单测，也能被别的宿主复用。

import fs from 'node:fs';
import { extractText } from '../session/frame.mjs';

/** 片段：命中位置之前留 40 字、总长 130 —— 与老版同值（改了就换了判据，不改）。 */
export const FRAG_LEAD = 40;
export const FRAG_LEN = 130;
export const DEFAULT_LIMIT = 8;

/** 账本行里「正文」取哪个字段：新版写 text，老仓写「概要」。 */
function bodyOf(row) {
  const a = row && row.text;
  if (a != null && String(a).length) return String(a);
  const b = row && row['概要'];
  return b == null ? '' : String(b);
}

/** 本地 ISO（带偏移）。不依赖 Intl —— 与 organs/ledger.mjs 同一判据，故意复制一份：tools 层不 import 器官。 */
function localIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    sign + p(Math.floor(Math.abs(off) / 60)) + ':' + p(Math.abs(off) % 60);
}

/** 词归一：数组原样（每个元素一个词），字符串按空白切。多词 = AND。去重、小写。 */
function asTerms(terms) {
  const list = Array.isArray(terms) ? terms : String(terms == null ? '' : terms).split(/\s+/);
  const out = [];
  for (const t of list) {
    const s = String(t == null ? '' : t).trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function countOf(hay, needle) {
  let n = 0;
  let at = hay.indexOf(needle);
  while (at >= 0) { n++; at = hay.indexOf(needle, at + needle.length); }
  return n;
}

/**
 * 从命中位置截一段出来。
 * ★ 换行压成空格（为了单行显示）—— 除此之外一字未改。
 *   这是「逐字片段」这句话里唯一一处允许的变形，老版也这么做，写明不藏着。
 * ★ 首尾 trim 会吃掉边界空白 —— 同一个道理，边界空白不属于内容。
 */
function clipAt(text, at) {
  const s = Math.max(0, at - FRAG_LEAD);
  const body = text.slice(s, s + FRAG_LEN).replace(/\n/g, ' ').trim();
  return (s > 0 ? '…' : '') + body + (s + FRAG_LEN < text.length ? '…' : '');
}

/**
 * 帧的**完整原文**。
 * ★ 不用 index.jsonl 里那条 —— 它在写入时被截到 500 字（索引是门牌，不是原文）。
 *   frames.jsonl 里的帧是完整的一手内容；这里只按帧类型拼正文，**不截断**。
 *   tool_call / tool_result / error 的正文不在 text 字段里，取它们自己的字段；
 *   字段缺失才退回 extractText（老帧可能就是只有 text 的形状）。
 */
export function frameFullText(fr) {
  if (!fr || typeof fr !== 'object') return '';
  const t = String(fr.type || '');
  const own = fr.text == null ? '' : String(fr.text);
  if (t === 'tool_call') {
    const a = jsonText(fr.args);
    const head = '[工具] ' + String(fr.name || '');
    return a ? (head + ' ' + a).trim() : (own || head.trim());
  }
  if (t === 'tool_result') {
    const c = fr.content == null ? '' : String(fr.content);
    return c ? ('[结果] ' + c) : own;
  }
  if (t === 'error') {
    return fr.message == null ? own : ('[错误] ' + String(fr.message));
  }
  return own || (typeof extractText === 'function' ? extractText(fr) : '');
}

/** JSON 化，但**不截断**（extractText 里的 safeJson 会截到 500 —— 原文路径不能用它）。 */
function jsonText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

/** 帧自带的宿主原帧号（DSH seq）。没有 / 不是非负整数 → null。 */
function hostSeqOf(fr) {
  if (!fr || !fr.meta || typeof fr.meta !== 'object') return null;
  const v = fr.meta.seq;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/** 两帧「是不是同一帧」的判据：类型 + 完整原文。时间不参与 —— 重复回放的 t 不同。 */
function frameIdentity(fr) {
  return String(fr.type || '') + '\u0001' + frameFullText(fr);
}

/** 候选摘要（歧义时报出来，不返回正文 —— 正文只给唯一确定的那一帧）。 */
function summarizeFrame(fr) {
  return {
    containerSeq: fr.seq,
    hostSeq: hostSeqOf(fr),
    type: fr.type || '',
    when: fr.t ? localIso(new Date(fr.t)) : '',
    snippet: frameFullText(fr).slice(0, 80).replace(/\n/g, ' '),
  };
}

function hostSeqRange(frames) {
  let min = null, max = null, n = 0;
  for (const f of frames) {
    const s = hostSeqOf(f);
    if (s === null) continue;
    n++;
    if (min === null || s < min) min = s;
    if (max === null || s > max) max = s;
  }
  return n ? { min, max, frames: n } : null;
}

/**
 * log 门牌的解析核心 —— 纯函数，单独可测。
 *
 * @param {object[]} frames 会话的全部帧（含帧 0）
 * @param {number} seq 门牌里的 n
 * @returns {{ok:true,frame:object,matchedBy:'host-meta'|'container-seq',hostMatches:number,
 *            containerCandidates?:object[],containerSeqs?:number[]} |
 *           {ok:false,code:'AMBIGUOUS_LOG_PTR',hostMatches:number,candidates:object[]} |
 *           {ok:false,code:'NO_SUCH_FRAME',hostMatches:0,hostSeqRange:object|null}}
 */
export function resolveLogFrame(frames, seq) {
  const list = Array.isArray(frames)
    ? frames.filter((f) => f && typeof f === 'object' && Number.isFinite(Number(f.seq)))
    : [];

  // ① 宿主原帧优先：meta.seq === n
  const host = list.filter((f) => hostSeqOf(f) === seq);
  if (host.length === 1) {
    return { ok: true, frame: host[0], matchedBy: 'host-meta', hostMatches: 1 };
  }
  if (host.length > 1) {
    const same = new Set(host.map(frameIdentity));
    if (same.size === 1) {
      // 同一帧被重复回放（实测有过 392 条重复 meta.seq）—— 内容一致，取哪条都是同一段原文。
      return {
        ok: true, frame: host[0], matchedBy: 'host-meta', hostMatches: host.length,
        containerSeqs: host.map((f) => f.seq),
      };
    }
    return {
      ok: false, code: 'AMBIGUOUS_LOG_PTR', hostMatches: host.length,
      candidates: host.map(summarizeFrame),
    };
  }

  // ② 没有宿主匹配 → 回退容器 seq（旧内部帧 / 本软件自己 append 的帧）
  const bySeq = list.filter((f) => Number(f.seq) === seq);
  if (bySeq.length === 1) {
    return { ok: true, frame: bySeq[0], matchedBy: 'container-seq', hostMatches: 0 };
  }
  if (bySeq.length > 1) {
    const same = new Set(bySeq.map(frameIdentity));
    if (same.size === 1) {
      return { ok: true, frame: bySeq[0], matchedBy: 'container-seq', hostMatches: 0, containerSeqs: bySeq.map((f) => f.seq) };
    }
    return {
      ok: false, code: 'AMBIGUOUS_LOG_PTR', hostMatches: 0,
      candidates: bySeq.map(summarizeFrame),
    };
  }
  return { ok: false, code: 'NO_SUCH_FRAME', hostMatches: 0, hostSeqRange: hostSeqRange(list) };
}

export class Query {
  /**
   * @param {object|null} store  会话存储（SessionStore 或同形：searchAll / load）
   * @param {string|{file:string}|null} ledger 账本 —— 文件路径，或带 .file 的 LedgerBase
   * @param {{ soul?: {search:Function, open?:Function}, limit?: number }} opts
   *   ★ soul 可选：SoulIndex 实例。不传时书房层是盲区，coverage() 会说出来 ——
   *     宁可报「看不见」，也不假装搜过了。
   */
  constructor(store, ledger, opts = {}) {
    this.store = store || null;
    this.ledgerSource = ledger || null;
    this.soul = opts.soul || null;
    this.limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : DEFAULT_LIMIT;
    this.cache = null;   // { file, key, rows } —— 账本读缓存
  }

  /**
   * 账本源 → 文件路径。
   * ★ **不接受数组**：数组没有稳定行号，指针就只能编 —— 那正是「错的门牌」。
   *   宁可报不支持，也不给一个回不去的地址。
   */
  #ledgerFile() {
    const src = this.ledgerSource;
    if (!src) return { file: null, why: '没有接账本（构造第二个参数为空）' };
    if (typeof src === 'string') return { file: src };
    if (typeof src.file === 'string' && src.file) return { file: src.file };
    return {
      file: null,
      why: '账本源不支持：要「文件路径」或带 .file 的 LedgerBase。'
        + '不接受数组 —— 数组没有稳定行号，指针就只能猜，而错的门牌比没有更坏。',
    };
  }

  /** 读账本（只追加，按 size+mtime 缓存）。返回 [{row, line}]，line 是**文件行号**。 */
  #rows(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const key = st.size + ':' + st.mtimeMs;
    if (this.cache && this.cache.file === file && this.cache.key === key) return this.cache.rows;
    const rows = [];
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i].trim();
      if (!s) continue;
      try {
        const o = JSON.parse(s);
        if (o && o.type) rows.push({ row: o, line: i + 1 });
      } catch { /* 半行 / 坏行跳过，不因为一行坏了就读不出别的 */ }
    }
    this.cache = { file, key, rows };
    return rows;
  }

  /** 这一版能看见哪几层。★ 搜不到之前先看它 —— 「没接上」和「没有」是两件事。 */
  coverage() {
    const lf = this.#ledgerFile();
    let ledger = false;
    let ledgerRows = 0;
    let ledgerError = lf.why || null;
    if (lf.file) {
      const rows = this.#rows(lf.file);
      if (rows) { ledger = true; ledgerRows = rows.length; }
      else ledgerError = '账本文件读不到：' + lf.file;
    }
    return {
      ledger,
      log: Boolean(this.store && typeof this.store.searchAll === 'function'),
      soul: Boolean(this.soul && typeof this.soul.search === 'function'),
      ledgerFile: lf.file,
      ledgerRows,
      ledgerError,
      soulNote: this.soul ? null : '没有接书房索引（opts.soul）—— L3 是盲区，不是「书房里没有」',
    };
  }

  /**
   * 搜。返回命中：[{ layer, ptr, when, type, snippet, score }]。
   * ★ 片段永远是原文的连续子串（只把换行压成空格）—— 这是这扇门存在的理由。
   */
  search(terms, opts = {}) {
    const ts = asTerms(terms);
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? opts.limit : this.limit;
    const connected = this.coverage();

    if (!ts.length) {
      return {
        ok: false, code: 'NO_TERMS', terms: [], hits: [], total: 0, scanned: {}, connected,
        hint: '给一个词。中文不用空格；多个词是 AND（都出现才算命中）。',
      };
    }
    if (!connected.ledger && !connected.log && !connected.soul) {
      return {
        ok: false, code: 'NO_SOURCE', terms: ts, hits: [], total: 0, scanned: {}, connected,
        hint: '一个数据源都没接上 —— 这不是「没搜到」，是这扇门现在看不见任何东西。'
          + '接账本：new Query(store, "<账本路径>")；接会话：传 store；接书房：opts.soul。',
      };
    }

    const hits = [];
    const scanned = { ledger: 0, log: 0, soul: 0 };

    // ① 账本 —— 每条都是可裁决的一手记录
    if (connected.ledger) {
      const rows = this.#rows(connected.ledgerFile) || [];
      for (const { row, line } of rows) {
        const text = bodyOf(row);
        if (!text) continue;
        const low = text.toLowerCase();
        let n = 0;
        let firstAt = -1;
        let all = true;
        for (const t of ts) {
          const c = countOf(low, t);
          if (!c) { all = false; break; }
          n += c;
          if (firstAt < 0) firstAt = low.indexOf(t);
        }
        if (!all) continue;
        scanned.ledger++;
        hits.push({
          layer: 'ledger', label: '一手·账本',
          ptr: '墨:' + line,
          when: row.t || '', type: row.type || '',
          snippet: clipAt(text, firstAt < 0 ? 0 : firstAt),
          score: n,
          ref: row.ref || null,
          feel: row.feel || null,
        });
      }
    }

    // ② 会话帧 —— 召回交给 store（它自己有权重与阈值），这里只做二次过滤。
    //    ★ 局限：召回只用一个词（最长的那个），其余词在内存里过滤。
    //      所以「第一个词没被 store 召回、其余词却命中」的那条会漏。
    //      宁可写清这个局限，也不在这里自己扫 15 万帧（那是 store 的活，重复实现会两边漂）。
    if (connected.log) {
      const primary = [...ts].sort((a, b) => b.length - a.length)[0];
      let raw = [];
      try { raw = this.store.searchAll(primary, Math.max(limit * 20, 200)) || []; }
      catch { raw = []; }
      for (const h of raw) {
        const text = String(h.text || '');
        const low = text.toLowerCase();
        let all = true;
        for (const t of ts) if (!low.includes(t)) { all = false; break; }
        if (!all) continue;
        scanned.log++;
        const at = low.indexOf(ts[0]);
        hits.push({
          layer: 'log', label: '一手·会话',
          ptr: 'log:' + h.sessionId + '#seq=' + h.seq,
          when: h.t ? localIso(new Date(h.t)) : '',
          type: h.type || '',
          snippet: clipAt(text, at < 0 ? 0 : at),
          score: ts.reduce((s, t) => s + countOf(low, t), 0),
        });
      }
    }

    // ③ 书房 —— SoulIndex 自己做 AND 与行号指针，这里只转发，不重算
    if (connected.soul) {
      let r = null;
      try { r = this.soul.search(ts, { limit }); } catch { r = null; }
      for (const h of (r && r.hits) || []) {
        scanned.soul++;
        hits.push({
          layer: 'soul', label: '一手·书房',
          ptr: h.ptr, when: '', type: '',
          snippet: h.snippet || '',
          score: 1,
        });
      }
    }

    // ★★ 2026-11-07 修的一个真错：原来直接把三层的 score 放一起排。
    //   但三层的 score **不是一个尺子** ——
    //     账本：命中次数（通常 1~3）
    //     会话：词频累加（常常几十，因为一段日志里同一个词出现很多次）
    //     书房：常数 1（SoulIndex 自己做 AND，不吐词频）
    //   于是「书房永远垫底」—— 不是因为它不相关，是因为它的分数**天生就小**。
    //   这和今晚那个人格占比 bug 一模一样：**不同口径的数不能直接比。**
    //
    //   修法：不要跨层比分数。改成**按层配额**：
    //   每层先各拿一个位置（有的话），剩下的按层内 score 轮转补齐。
    //   ★ 为什么是「各拿一个」而不是「按比例分」：三层的量天然不均（会话几百条、账本几条），
    //     按比例分的话账本和书房永远分不到 —— 那正是原来的病。
    const rank = { ledger: 0, log: 1, soul: 2 };
    const byLayer = { ledger: [], log: [], soul: [] };
    for (const h of hits) (byLayer[h.layer] || (byLayer[h.layer] = [])).push(h);
    for (const k of Object.keys(byLayer)) byLayer[k].sort((a, b) => b.score - a.score);

    const page = [];
    const used = { ledger: 0, log: 0, soul: 0 };
    // ① 先每家一个（顺序：账本 → 会话 → 书房，但只要有就都先给一个）
    for (const k of ['ledger', 'log', 'soul']) {
      if (page.length < limit && byLayer[k] && byLayer[k].length) {
        page.push(byLayer[k][0]); used[k] = 1;
      }
    }
    // ② 剩下的按层内 score 轮转补齐（每轮一层取一个，谁有谁上）
    let more = true;
    while (page.length < limit && more) {
      more = false;
      for (const k of ['ledger', 'log', 'soul']) {
        if (page.length >= limit) break;
        const arr = byLayer[k] || [];
        if (used[k] < arr.length) { page.push(arr[used[k]]); used[k]++; more = true; }
      }
    }
    const total = hits.length;
    return {
      ok: true, terms: ts, hits: page, total, truncated: total > page.length,
      scanned, connected,
      hint: page.length
        ? '要原文：query.open(ptr)。片段是逐字截的（只把换行压成空格）。'
        : '没搜到。先看 connected —— 某层没接上时，搜不到不代表「那里没有」。',
    };
  }

  /** 指针 → 原文。★ 不猜：找不到就说找不到，并给重搜入口。 */
  open(rawPtr) {
    const ptr = String(rawPtr == null ? '' : rawPtr).trim();
    if (!ptr) {
      return { ok: false, code: 'NO_PTR', hint: '给一个指针，形如 墨:41 / log:<会话>#seq=3 / file:<路径>:12' };
    }

    let m = ptr.match(/^墨:(\d+)$/);
    if (m) {
      const lf = this.#ledgerFile();
      if (!lf.file) return { ok: false, code: 'NO_LEDGER', hint: lf.why || '没有接账本' };
      const rows = this.#rows(lf.file);
      if (!rows) return { ok: false, code: 'NO_LEDGER_FILE', hint: '账本文件读不到：' + lf.file };
      const hit = rows.find((x) => x.line === Number(m[1]));
      if (!hit) {
        return {
          ok: false, code: 'NO_SUCH_LINE',
          hint: '账本第 ' + m[1] + ' 行不是一条记录（或账本变短了）。重搜一次拿新指针 —— 这一版不猜。',
        };
      }
      return {
        ok: true, ptr, kind: 'ledger',
        when: hit.row.t || '', type: hit.row.type || '', by: hit.row.by || null,
        text: bodyOf(hit.row), ref: hit.row.ref || null, feel: hit.row.feel || null,
      };
    }

    m = ptr.match(/^log:(.+?)#seq=(\d+)$/);
    if (m) {
      if (!this.store) return { ok: false, code: 'NO_STORE', hint: '没有接会话存储（store）' };
      const sid = m[1];
      const seq = Number(m[2]);
      let entry = null;
      try { entry = this.store.load(sid); } catch { entry = null; }
      const frames = entry && Array.isArray(entry.frames) ? entry.frames : [];
      const r = resolveLogFrame(frames, seq);

      if (!r.ok && r.code === 'AMBIGUOUS_LOG_PTR') {
        // ★ 多个宿主帧同号且内容不同 → 取哪个都会取错。列候选，不返回正文。
        return {
          ok: false, code: 'AMBIGUOUS_LOG_PTR', ptr, sessionId: sid, seq,
          hostMatches: r.hostMatches, candidates: r.candidates,
          hint: '宿主 seq=' + seq + ' 在会话 ' + sid + ' 下匹配到 ' + r.hostMatches +
            ' 帧内容不同的记录 —— 取哪一个都可能取错，所以不替你选。' +
            '按 candidates[].containerSeq 用 soul_frame {session:"' + sid + '", seq:<containerSeq>} 精确取。',
        };
      }
      if (!r.ok) {
        return {
          ok: false, code: 'NO_SUCH_FRAME',
          hint: '会话 ' + sid + ' 里没有 seq=' + seq + '：宿主 meta.seq 与容器 seq 都查过了。会话可能被删了，或 id 不对。',
          ...(entry ? { frames: frames.length, hostSeqRange: r.hostSeqRange || null } : {}),
        };
      }

      const fr = r.frame;
      return {
        ok: true, ptr, kind: 'log', sessionId: sid,
        seq,                          // 指针里的 n（旧字段，保持兼容）
        matchedBy: r.matchedBy,        // 'host-meta' | 'container-seq' —— 取到的是哪一路，必须能核对
        containerSeq: fr.seq,
        hostSeq: hostSeqOf(fr),
        hostMatches: r.hostMatches,
        ...(Array.isArray(r.containerSeqs) && r.containerSeqs.length > 1 ? { containerSeqs: r.containerSeqs } : {}),
        when: fr.t ? localIso(new Date(fr.t)) : '', type: fr.type || '',
        text: frameFullText(fr),      // 完整原文，不用索引里那条 500 字截断
        frame: fr,
      };
    }

    if (/^file:/.test(ptr)) {
      if (!this.soul || typeof this.soul.open !== 'function') {
        return { ok: false, code: 'NO_SOUL', hint: '没有接书房索引 —— 这是书房层的指针，打不开' };
      }
      const r = this.soul.open(ptr);
      if (!r) return { ok: false, code: 'NO_SUCH_FILE', hint: '书房里没有这个文件（可能已删除、或不在索引范围）' };
      return { ok: true, ptr, kind: 'file', path: r.path, line: r.line, text: r.text };
    }

    return {
      ok: false, code: 'BAD_PTR',
      hint: '认不出这个指针：' + ptr + '。形如 墨:41 / log:<会话>#seq=3 / file:<路径>:12',
    };
  }

  /**
   * 现在是什么时候 / 有没有欠着的活。
   * ★ 老版这里还报「索引建自 X」。新版没有索引可报 —— 报「多久读一次账本」没有意义，
   *   缓存是 size+mtime 驱动的：账本没变就不重读。
   */
  now() {
    const lf = this.#ledgerFile();
    const out = { at: localIso(), epochMs: Date.now(), ledger: null, log: null, hint: null };
    if (!lf.file) {
      out.hint = lf.why || '没有接账本';
    } else {
      const rows = this.#rows(lf.file);
      if (!rows) {
        out.hint = '账本文件读不到：' + lf.file;
      } else {
        const led = rows.map((x) => x.row);
        const open = led.filter((r) => r.type === 'promise' || r.type === 'shelved');
        const last = rows.length ? rows[rows.length - 1] : null;
        out.ledger = {
          total: led.length,
          open: open.length,
          last: last ? {
            ptr: '墨:' + last.line, when: last.row.t || '', type: last.row.type || '',
            text: bodyOf(last.row).slice(0, 70),
          } : null,
          openRecent: open.slice(-3).map((r) => ({
            when: r.t || '', type: r.type || '', text: bodyOf(r).slice(0, 66),
          })),
        };
      }
    }
    if (this.store && typeof this.store.list === 'function') {
      try { out.log = { sessions: this.store.list().length }; }
      catch { out.log = { sessions: null }; }
    }
    return out;
  }
}
