// 句子级窗口切分 + 写入 —— 第二套向量层（v12）。
//
// ★ 设计依据（不是拍脑袋，是看真实文本形状定的）：
//   实测 echo_words：平均 3,895 字，最大 32,569 字。
//   真实文本里长段是**任务书 / 系统注入块**，不是自然语言段落 ——
//   按句末标点切，600 字能切出 5~12 句，句长 12~281 字不等。
//
// ★ 为什么窗口不是「句子」而是「句子 + 邻近合并」：
//   short 句子（"好的。" / "继续吧。"）单独成向量几乎没有语义，检索会噪声化。
//   所以按**目标字符数**滑动合并：凑够 TARGET 就切一刀，但不跨过超长单句。
//   ★ 参数据实测：BGE 的 maxInputChars=1000，但语义密度在 128~256 字就基本饱和；
//     窗口太小 → 噪声多；窗口太大 → 又退化成「整段平均」。取 192 作目标。
//
// ★ 注入块：默认跳过。实测 67,509/122,630 行是注入块，占 90.5% 字符 ——
//   给它们建窗口 = 烧 90% 算力产出几万份近乎相同的向量，还会淹没真实结果。

import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** 换行符。用常量而不是字面反斜杠 —— 见下面切句那一处的说明。 */
const NL = String.fromCharCode(10);

/**
 * 注入块前缀 —— **唯一真源**。
 *
 * ★★★ 2026-11-18：这份表原来被抄成两份（这里一份正则、echo-vectors.mjs 一份 SQL LIKE），
 *   而 SQL 那份抄漏了最后两个前缀，实测 expected 54,858 vs 55,121 差 263 条，
 *   后果是「向量跑完也永远报 ECHO_VECTOR_SOURCE_INCOMPLETE」—— 白跑几小时。
 *   **一份判据只能有一个真源，另一个必须从这里生成。**
 *
 * 前缀的语义是「行首匹配」，与 organs/compaction.mjs 的 stripInject 同源判据。
 */
export const INJECTED_PREFIXES = Object.freeze([
  '<system-reminder>',
  'Current runtime context.',
  'Instructions from:',
  'Image-gen workbench canvas:',
  '[MNEMON',
  '⛬ 压缩索引',
]);

const escapeRe = (s) => String(s).replace(/[.*+?^$()|[\]\\]/g, (m) => String.fromCharCode(92) + m);
const INJECTED = new RegExp('^(' + INJECTED_PREFIXES.map(escapeRe).join('|') + ')');

export function isInjectedText(text) {
  return INJECTED.test(String(text || '').trimStart());
}

/**
 * 与 isInjectedText() **等价**的 SQL 谓词（对结果取 NOT 即「真实文本」）。
 *
 * 用途：聚合计数（12 万行读进 JS 太慢），语义必须与上面那个函数一致。
 * ★ 两侧等价性由断言核对 —— 不要靠「我记得改了两边」。
 */
export function injectedSqlWhere(col = 'text') {
  const c = String(col);
  const trimmed = `LTRIM(${c}, char(9)||char(10)||char(13)||char(32))`;
  return INJECTED_PREFIXES
    .map((pfx) => `${trimmed} LIKE '${String(pfx).replace(/'/g, "''")}%'`)
    .join(' OR ');
}

/** 切句：保留标点，空句丢掉。 */
export function splitSentences(text) {
  const raw = String(text || '');
// ★ 用 NL 常量拼正则，不写字面反斜杠：上一版在模板字符串里多一层，
//   结果正则匹配的是「反斜杠或字母 n」，会把含 n 的文本静默切碎（语法检查看不出来）。
  const parts = raw.split(new RegExp('(?<=[。！？；' + NL + '])'));
  const out = [];
  let cursor = 0;
  for (const p of parts) {
    const len = p.length;
    if (!p) { cursor += len; continue; }
    if (p.trim()) out.push({ text: p, start: cursor, end: cursor + len });
    cursor += len;
  }
  return out;
}

/**
 * 把一段文本切成窗口。
 * @param {string} text
 * @param {{targetChars?:number, maxChars?:number}} opts
 *   targetChars：凑够这么多字就切一刀（默认 192）
 *   maxChars：单窗口硬上限（默认 512）；超长单句会被硬切，因为模型那边也会截断它
 * @returns {{index:number, start:number, end:number, text:string}[]}
 */
export function windowsOf(text, opts = {}) {
  const target = Math.max(32, Number(opts.targetChars) || 192);
  const maxChars = Math.max(target, Number(opts.maxChars) || 512);
  const raw = String(text || '');
  const out = [];
  let buf = null;
  const flush = () => { if (buf) { out.push({ index: out.length, start: buf.start, end: buf.end, text: buf.text }); buf = null; } };

  for (const s of splitSentences(raw)) {
    // 超长单句：先 flush 缓冲区，再硬切成若干块（每块 maxChars）
    if (s.text.length > maxChars) {
      flush();
      for (let i = 0; i < s.text.length; i += maxChars) {
        const piece = s.text.slice(i, i + maxChars);
        // ★★ 2026-11-18 03:26 修：硬切出来的块可能**整块是空白**。
        //   症状：向量化跑到一半 TypeError「texts must be a non-empty array of non-blank strings」
        //   —— embed 的断言是对的，错在上游把空白当窗口切出来了。
        //   成因：splitSentences 只保证「整句 trim 后非空」，而一句 512 字以上的文本
        //   前半可能是纯缩进/换行，硬切的第一块就全是空白。
        //   ★ 空白窗口没有任何检索价值，也从不可能被查询命中，源头丢掉。
        if (!piece.trim()) continue;
        out.push({ index: out.length, start: s.start + i, end: s.start + i + piece.length, text: piece });
      }
      continue;
    }
    if (!buf) buf = { text: s.text, start: s.start, end: s.end };
    else { buf.text += s.text; buf.end = s.end; }
    if (buf.text.length >= target) flush();
  }
  flush();
  return out;
}

/**
 * 把窗口向量写进库。
 * ★ 陈旧检测与 echo_word_vectors 同一口径：source_content_hash 必须等于当前 word 的 content_hash。
 */
export function putWindowVectors(db, echoSourceId, modelKey, dimension, rows, options = {}) {
  if (!Array.isArray(rows)) throw new TypeError('rows must be an array');
  const mode = options.mode === 'upsert' ? 'upsert' : 'replace';
  db.exec('BEGIN IMMEDIATE');
  try {
    if (mode === 'replace') {
      db.prepare('DELETE FROM echo_word_windows WHERE echo_source_id=? AND model_key=?').run(echoSourceId, modelKey);
    }
    const selWord = db.prepare('SELECT content_hash FROM echo_words WHERE echo_source_id=? AND word_ord=?');
    const ins = db.prepare([
      'INSERT INTO echo_word_windows (echo_source_id, word_ord, window_ord, model_key, char_start, char_end,',
      '  window_text_sha256, source_content_hash, vector_dimension, vector_blob, vector_sha256, created_at)',
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      'ON CONFLICT(echo_source_id, word_ord, window_ord, model_key) DO UPDATE SET',
      '  char_start=excluded.char_start, char_end=excluded.char_end, window_text_sha256=excluded.window_text_sha256,',
      '  source_content_hash=excluded.source_content_hash, vector_dimension=excluded.vector_dimension,',
      '  vector_blob=excluded.vector_blob, vector_sha256=excluded.vector_sha256, created_at=excluded.created_at',
    ].join(' '));
    const now = new Date().toISOString();
    let written = 0;
    for (const r of rows) {
      const w = selWord.get(echoSourceId, r.wordOrd);
      if (!w) throw Object.assign(new Error('window vector has no matching ECHO word'), { code: 'ECHO_WINDOW_WORD_NOT_FOUND', wordOrd: r.wordOrd });
      if (w.content_hash !== r.sourceContentHash) {
        throw Object.assign(new Error('source word changed before window vector commit'), { code: 'ECHO_WINDOW_STALE', wordOrd: r.wordOrd });
      }
      const vals = r.vector;
      const dim = Number(dimension);
      if (!vals || vals.length !== dim) throw new TypeError('vector dimension mismatch');
      const blob = Buffer.allocUnsafe(dim * 4);
      for (let i = 0; i < dim; i += 1) {
        const n = Number(vals[i]);
        if (!Number.isFinite(n)) throw new TypeError('vector value not finite');
        blob.writeFloatLE(n, i * 4);
      }
      ins.run(echoSourceId, r.wordOrd, r.windowOrd, modelKey, r.charStart, r.charEnd,
        sha256(r.text), r.sourceContentHash, dim, blob, sha256(blob), now);
      written += 1;
    }
    if (typeof options.finish === 'function') options.finish();
    db.exec('COMMIT');
    return { written, mode };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 已回滚 */ }
    throw err;
  }
}

/** 读一个源的窗口向量（检索用）。返回 blob + 元数据，不返回原文本（那条要走账本）。 */
export function listWindowVectors(db, echoSourceId, modelKey, limit = 0) {
  const sql = [
    'SELECT word_ord, window_ord, char_start, char_end, vector_dimension, vector_blob',
    'FROM echo_word_windows WHERE echo_source_id=? AND model_key=?',
    'ORDER BY word_ord, window_ord',
  ].join(' ');
  const rows = db.prepare(sql).all(echoSourceId, modelKey);
  return limit > 0 ? rows.slice(0, limit) : rows;
}