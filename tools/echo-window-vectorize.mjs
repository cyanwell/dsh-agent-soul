#!/usr/bin/env node
// tools/echo-window-vectorize.mjs —— 句子级窗口向量（第二套）。
//
// ★ 护栏：写生产库要 --yes-production（记忆里那条「测量脚本必须先拒绝写生产路径」）。
// ★ 注入块默认跳过（实测占 90.5% 字符，建它们的窗口 = 烧算力造噪声）。
//   --include-injected 可显式收录。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openMetaStore } from '../src/db/index.mjs';
import { registerEchoVectorModel } from '../src/db/echo-vectors.mjs';
import { windowsOf, isInjectedText, putWindowVectors } from '../src/db/echo-windows.mjs';
import { createBgeEmbedder, buildModelFingerprint } from './echo-embed.mjs';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const args = process.argv.slice(2);
const getArg = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args[i + 1]; };
const DB = getArg('--db', 'D:/AI/agent-soul/data/meta.sqlite');
const isProd = path.resolve(DB) === path.resolve('D:/AI/agent-soul/data/meta.sqlite');
if (isProd && !args.includes('--yes-production')) { console.error('REFUSE: 写生产库必须显式传 --yes-production'); process.exit(3); }
const includeInjected = args.includes('--include-injected');
// ★ 2026-11-18：去重默认开。实测 211,640 个窗口里只有 130,441 个唯一文本（重复 38.37%），
//   ★ 这行原先写的是「211,643 / 47.58%」—— 那是按**修 bug 之前**的 windowsOf 算的：
//     旧实现会把纯空白切成窗口，多出 3 个假窗口；而 47.58% 是把
//     1-130441/211643 与另一个分母混算的结果。修完空白过滤后正确数是
//     211,640 个窗口、重复率 38.37%。写在这里免得以后又对不上。
//   而这些重复**不是**注入块漏网（那已被 isInjectedText 剔掉），是同一段话在多个会话里反复出现 ——
//   比如同一份 MEMORY.md 被每个会话的 system prompt 各带一遍。同一文本 → 同一向量，不必重算。
//   --no-dedup 只用于验证「去重前后向量是否一致」，正常跑不要关。
const dedup = !args.includes('--no-dedup');
const targetChars = Number(getArg('--target-chars', 192));
const maxChars = Number(getArg('--max-chars', 512));
// 调试用：只处理前 N 个词就停（0 = 跑全量）。先验逻辑再上全量。
const maxWords = Number(getArg('--max-words', 0)) || 0;
const doClear = !args.includes('--no-clear');
// ★ 2026-11-18：--resume = 从已完成的 MAX(word_ord) 续跑，不重扫前面的词。
//   原来只能从头扫（靠 upsert 覆盖），6,268 个已完成词白算一遍。
const resume = args.includes('--resume');

const modelDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'models', 'bge-small-zh');
const fp = buildModelFingerprint({
  modelDir,
  modelBytes: fs.readFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx')),
  tokenizerBytes: fs.readFileSync(path.join(modelDir, 'tokenizer.json')),
  configBytes: fs.readFileSync(path.join(modelDir, 'config.json')),
  transformersVersion: '4.3.2',
});
const spec = {
  modelId: fp.modelId, revision: fp.modelRevision, modelSha256: fp.modelSha256,
  tokenizerSpec: JSON.stringify({ sha256: fp.tokenizerSha256, configSha256: fp.configSha256 }),
  preprocessSpec: JSON.stringify({ queryPrefix: fp.queryPrefix, documentPrefix: fp.documentPrefix, maxInputChars: fp.maxInputChars, truncation: fp.truncation, granularity: 'sentence-window', targetChars, maxChars }),
  poolingSpec: JSON.stringify({ pooling: fp.pooling, dtype: fp.dtype }),
  normalize: fp.normalized, dimension: fp.dimension, maxSeqLength: fp.maxInputChars,
};

const store = openMetaStore({ path: DB, mode: 'readwrite' });
store.migrate();
const db = store.db;
const reg = registerEchoVectorModel(db, spec);
console.log('windowModelKey=' + reg.modelKey);

const srcRow = db.prepare('SELECT echo_source_id, words_count FROM echo_index_sources').get();
const sid = srcRow.echo_source_id;
const emb = await createBgeEmbedder({ expectedModelFingerprint: fp });
console.log('device=' + emb.device());

const WINDOW_MODEL_KEY = reg.modelKey;
// 文本 sha256 → 向量。命中就复用，跳过 embed。
// ★ 存的是 Float32Array 本体，不是 blob —— putWindowVectors 内部才做序列化。
//   130441 个 × 512 × 4B ≈ 267 MB 常驻；本机内存够。
const vecCache = dedup ? new Map() : null;
const have = db.prepare('SELECT COUNT(*) AS n FROM echo_word_windows WHERE echo_source_id=? AND model_key=?').get(sid, WINDOW_MODEL_KEY).n;
console.log('existingWindows=' + have);
// ★ 开跑前清空本 (source, model) 的旧窗口 —— 重跑就是要完整重建。
//   原来靠「第一批 mode:'replace'」来清，但若第一批词恰好全是被跳过的注入块，旧数据就永远不清。
// ★★ 2026-11-18 03:22 修：--resume 与 --clear 互相拆台。
//   原来的顺序是「先 DELETE 全部，再读 MAX(word_ord) 当游标」——
//   删完必然读到 -1，于是 resume 等于摆设，每次都从第一个词重算。
//   实测代价：已经跑完的 20,590 条窗口被清掉重来（GPU 上约 15 分钟，CPU 上是几小时）。
//   改法：resume 时**不清**，让 MAX(word_ord) 真的成为断点；只有明确要重建才清。
if (resume && have > 0) {
  console.log('resume mode: keep ' + have + ' existing windows, do NOT clear');
} else if (doClear && have > 0) {
  db.prepare('DELETE FROM echo_word_windows WHERE echo_source_id=? AND model_key=?').run(sid, WINDOW_MODEL_KEY);
  console.log('cleared ' + have + ' stale windows');
}

let done = 0, skippedInjected = 0, windowsWritten = 0, embedCalls = 0, cacheHits = 0;
const t0 = Date.now();
const CHUNK = 24;   // 每批窗口数（窗口是短文本，CPU 实测 2.4ms/条）
const WORDSCAN = 200;
let cursor = -1;
if (resume) {
  const m = db.prepare('SELECT COALESCE(MAX(word_ord), -1) AS v FROM echo_word_windows WHERE echo_source_id=? AND model_key=?').get(sid, WINDOW_MODEL_KEY).v;
  if (Number(m) >= 0) { cursor = Number(m); console.log('resume from word_ord > ' + cursor); }
}
for (;;) {
  if (maxWords && done >= maxWords) break;
  const words = db.prepare('SELECT word_ord, content_hash, text FROM echo_words WHERE echo_source_id=? AND word_ord > ? ORDER BY word_ord LIMIT ?').all(sid, cursor, maxWords ? Math.min(WORDSCAN, maxWords - done) : WORDSCAN);
  if (!words.length) break;
  const pending = [];
  for (const w of words) {
    if (!includeInjected && isInjectedText(w.text)) { skippedInjected += 1; continue; }
    const wins = windowsOf(w.text, { targetChars, maxChars });
    // ★ 防御：上游理论上已经丢掉空白窗口，这里再兜一层 —— 一个空字符串就能整批炸掉，
    //   而那时已经跑了几千个词（实测跑到 words=16000 才撞上）。
    for (const win of wins) { if (!String(win.text).trim()) continue; pending.push({ wordOrd: w.word_ord, contentHash: w.content_hash, win, textSha: sha256(win.text) }); }
  }
  for (let i = 0; i < pending.length; i += CHUNK) {
    const batch = pending.slice(i, i + CHUNK);
    // ★ 去重的落点：同一段文本在 N 个位置出现，embedding 只算一次。
    //   位置（wordOrd/windowOrd/char 区间）每个仍各存一份 —— 检索要能回到每一处原文。
    const miss = vecCache ? batch.filter((b) => !vecCache.has(b.textSha)) : batch;
    if (vecCache) cacheHits += batch.length - miss.length;
    if (miss.length) {
      const vecs = await emb.embedDocuments(miss.map((b) => b.win.text));
      embedCalls += miss.length;
      if (vecCache) miss.forEach((b, k) => vecCache.set(b.textSha, vecs[k].vector));
      else miss.forEach((b, k) => { b.vec = vecs[k].vector; });
    }
    const rows = batch.map((b) => ({ wordOrd: b.wordOrd, windowOrd: b.win.index, charStart: b.win.start, charEnd: b.win.end, text: b.win.text, sourceContentHash: b.contentHash, vector: vecCache ? vecCache.get(b.textSha) : b.vec }));
    // 先按 (source, model) 清空一次，之后按词 upsert（避免每个词都全量删）
    putWindowVectors(db, sid, WINDOW_MODEL_KEY, fp.dimension, rows, { mode: 'upsert' });
    windowsWritten += rows.length;
  }
  done += words.length;
  cursor = words[words.length - 1].word_ord;
  if (done % 2000 === 0 || done === words.length) {
    const el = (Date.now() - t0) / 1000;
    console.log('  words=' + done + '  windows=' + windowsWritten + '  skippedInjected=' + skippedInjected + '  ' + el.toFixed(0) + 's');
  }
}
const total = db.prepare('SELECT COUNT(*) AS n FROM echo_word_windows WHERE echo_source_id=? AND model_key=?').get(sid, WINDOW_MODEL_KEY).n;
console.log(JSON.stringify({ ms: Date.now() - t0, wordsScanned: done, skippedInjected, windowsWritten, inDb: total, includeInjected, dedup, embedCalls, cacheHits, uniqueCached: vecCache ? vecCache.size : null }));
store.close();