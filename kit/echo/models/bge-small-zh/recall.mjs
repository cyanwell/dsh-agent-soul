#!/usr/bin/env node
/**
 * recall.mjs —— 给一段「当前上下文」，算它和哪些记忆相关
 *
 * 用法：
 *   node recall.mjs "砚青在跟我说记忆的事"            # 直接给文本
 *   node recall.mjs --top 5 "..."                    # 条数
 *   echo "..." | node recall.mjs --stdin             # 从管道读
 *   node recall.mjs --hook                           # 给 DSH 用：读 stdin，只输出注入块
 *
 * ★ 这东西解决的是什么：
 *   现在 echo_search 是「我问 → 它答」。而这个文件回答的是另一个问题：
 *   「我刚说的这段话，和库里哪几块东西有关系？」
 *   那个问题的答案，就是「推送」的原料 —— 缺的只是「什么时候自动跑它」。
 *
 * ★ 为什么单独一个文件而不是塞进 echo-mcp：
 *   ① 它是「离线判断」，不该影响常驻服务的响应时间
 *   ② 以后接 prompt 装配时，装配方要的是一个能 spawn 的子进程，
 *      而不是一个已经被别的东西占着的 MCP 连接
 *   ③ 调参时要能直接改、直接跑、直接看分数
 *
 * ★★★ 它【不推送】（2026-11-04 爀曦定的口径，我原来做偏了）：
 *   它的职责是「把高相关的条目连门牌一起列出来」，
 *   由拿门牌的人决定要不要取原文。
 *   **不做记忆加工、不做记忆提炼、不往上下文里塞东西。**
 *   截图口径：它只回答「哪几条可能相关」，不回答「那几条讲了什么」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';

// ★ 不写死本机路径（2026-11-05）：
//   模型就在这个目录里（model_quantized.onnx 与本文件同级）→ 从 import.meta.url 推。
//   记忆库是用户数据 → ECHO_MEMORY / echo.config.json，用到处才检查。
const DIR = path.dirname(fileURLToPath(import.meta.url));
const libRoot = () => {
  const m = process.env.ECHO_MEMORY || null;
  if (m) return m.endsWith('00-记忆库') ? m : path.join(m, '00-记忆库');
  throw new Error('[向量层] 没配置记忆库根。设 ECHO_MEMORY，或在 echo.config.json 里写 memory。');
};
const PREFIX = '为这个句子生成表示以用于检索相关文章：';

// ★ 推送阈值比搜索阈值高 —— 搜索是「我要」，推送是「你没要」
//   搜索 0.55 就够（至少比没有强），推送要 0.65（错了会污染上下文）。
//
//   ★ 0.62 → 0.65 是实测改的：0.62 下「今天天气怎么样」能命中 4 篇日记（0.577）。
//     而那 4 篇讲的是灵魂、记忆、克制 —— 和天气毫无关系。
//     **噪声进来的代价比漏掉高**：漏掉只是这次没想起来，噪声是错误信息进上下文。
const SEARCH_TH = 0.55;
// （原 PUSH_TH 0.65 已删 —— 不推送了，没有推送阈值这回事）

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = DIR;
env.useBrowserCache = false;

const loadIdx = () => {
  const meta = JSON.parse(fs.readFileSync(path.join(libRoot(), 'vectors.meta.json'), 'utf8'));
  const chunks = new Map();
  for (const l of fs.readFileSync(path.join(libRoot(), 'chunks.jsonl'), 'utf8').split('\n')) {
    if (!l) continue;
    try { const c = JSON.parse(l); chunks.set(c.id, c); } catch {}
  }
  const ids = [], vecs = [];
  for (const [id, b64] of Object.entries(meta.done || {})) {
    const buf = Buffer.from(b64, 'base64');
    if (!chunks.has(id)) continue;   // ★ 向量有、chunk 没了 → 跳过（prune 事后补）
    ids.push(id);
    vecs.push(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  }
  return { ids, vecs, chunks, dim: meta.dim };
};

const readStdin = () => new Promise((res) => {
  let s = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => s += d);
  process.stdin.on('end', () => res(s));
});

const run = async () => {
  const args = process.argv.slice(2);
  const topIdx = args.indexOf('--top');
  const top = topIdx >= 0 ? parseInt(args[topIdx + 1], 10) : 4;

  let text = args.filter((a, i) => !a.startsWith('--') && !(topIdx >= 0 && i === topIdx + 1)).join(' ').trim();
  if (args.includes('--stdin')) text = (await readStdin()).trim();

  if (!text || text.length < 4) {
    console.log('用法: node recall.mjs "一段话"  或  echo "..." | node recall.mjs --stdin');
    return;
  }

  // ★ 只取尾部 —— 当前意图通常在最近说的话里，早期铺垫无关
  const query = text.length > 500 ? text.slice(-500) : text;

  const idx = loadIdx();
  if (!idx.vecs.length) {
    console.log('没有向量数据，先跑 embed.mjs');
    return;
  }

  const t0 = Date.now();
  const pipe = await pipeline('feature-extraction', DIR, { dtype: 'q8' });
  const out = await pipe([PREFIX + query], { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const qv = out.data.slice(0, dim);

  const scored = [];
  for (let i = 0; i < idx.vecs.length; i++) {
    const v = idx.vecs[i];
    let dot = 0;
    for (let k = 0; k < dim; k++) dot += qv[k] * v[k];
    scored.push({ i, s: dot });
  }
  scored.sort((a, b) => b.s - a.s);

  const th = SEARCH_TH;
  const hits = [];
  const seenDoc = new Set();   // ★ 同一篇文档只取最相关的那一块
  for (const x of scored) {
    if (x.s < th) break;
    if (hits.length >= top) break;
    const c = idx.chunks.get(idx.ids[x.i]);
    if (!c) continue;
    // ★ 为什么要去重：一篇日记切成好几块，同篇的不同块会一起挤进 top。
    //   实测「今天天气」最坏的情况是 4 条里 2 条来自同一篇 ——
    //   对使用者来说那不是「4 个线索」，是「2 个线索假装成 4 个」。
    const docKey = c.mem;
    if (seenDoc.has(docKey)) continue;
    seenDoc.add(docKey);
    hits.push({ c, s: x.s });
  }

  console.log('上下文: 「' + query.slice(-80).replace(/\n/g, ' ') + '」');
  console.log('耗时: ' + (Date.now() - t0) + 'ms   扫描 ' + idx.vecs.length + ' 块   阈值 ' + th + '\n');
  if (!hits.length) { console.log('（没有超过阈值的 —— 这段话说的是新事，库里没有对应的）'); return; }
  for (const h of hits) {
    console.log('  ' + h.s.toFixed(3) + '  ' + h.c.mem);
    console.log('           ' + h.c.text.replace(/\s+/g, ' ').slice(0, 110));
  }
};

run().catch(e => { console.error('失败: ' + ((e && e.stack) || e)); process.exit(1); });
