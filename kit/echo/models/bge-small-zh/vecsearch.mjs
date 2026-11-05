#!/usr/bin/env node
/**
 * vecsearch.mjs —— 独立验证向量检索（不经过 echo-mcp）
 *
 * 用法：
 *   node vecsearch.mjs "怎么让记忆更牢"
 *   node vecsearch.mjs "上下文太长" --top 8
 *   node vecsearch.mjs --stats
 *
 * 为什么单独做一个：
 *   ① echo-mcp 是常驻服务，改一次要重启才生效 —— 调参时太慢
 *   ② 这里能直接打印分数、候选、命中理由，是「看检索发生了什么」的地方
 *   ③ 以后评分数据也靠它跑批量
 *
 * ★ bge 非对称检索：query 必须加前缀，doc 不加。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';

// ★ 不写死本机路径（2026-11-05）：
//   模型在子目录 onnx/ 下（onnx/model_quantized.onnx）→ DIR 从 import.meta.url 推。
//   记忆库是用户数据 → ECHO_MEMORY / echo.config.json，用到处才检查。
const DIR = path.dirname(fileURLToPath(import.meta.url));
const libRoot = () => {
  const m = process.env.ECHO_MEMORY || null;
  if (m) return m.endsWith('00-记忆库') ? m : path.join(m, '00-记忆库');
  throw new Error('[向量层] 没配置记忆库根。设 ECHO_MEMORY，或在 echo.config.json 里写 memory。');
};
const PREFIX = '为这个句子生成表示以用于检索相关文章：';

env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = DIR;
env.useBrowserCache = false;

const loadVecs = () => {
  const meta = JSON.parse(fs.readFileSync(path.join(libRoot(), 'vectors.meta.json'), 'utf8'));
  const chunks = new Map();
  for (const l of fs.readFileSync(path.join(libRoot(), 'chunks.jsonl'), 'utf8').split('\n')) {
    if (!l) continue;
    try { const c = JSON.parse(l); chunks.set(c.id, c); } catch {}
  }
  const ids = [], vecs = [];
  for (const [id, b64] of Object.entries(meta.done || {})) {
    const buf = Buffer.from(b64, 'base64');
    ids.push(id);
    vecs.push(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
  }
  return { ids, vecs, chunks, dim: meta.dim };
};

const run = async () => {
  const args = process.argv.slice(2);
  const data = loadVecs();

  if (args.includes('--stats')) {
    console.log('已嵌入 ' + data.ids.length + ' 块，维度 ' + data.dim);
    console.log('chunks 总数 ' + data.chunks.size);
    const missing = [...data.chunks.keys()].filter(id => !data.ids.includes(id)).length;
    console.log('未嵌入 ' + missing + ' 块');
    return;
  }

  const q = args.filter(a => !a.startsWith('--')).join(' ').trim();
  if (!q) { console.log('用法: node vecsearch.mjs "查询词" [--top N]'); return; }
  const topIdx = args.indexOf('--top');
  const top = topIdx >= 0 ? parseInt(args[topIdx + 1], 10) : 6;

  const t0 = Date.now();
  const pipe = await pipeline('feature-extraction', DIR, { dtype: 'q8' });
  const out = await pipe([PREFIX + q], { pooling: 'mean', normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const qv = out.data.slice(0, dim);

  const scored = [];
  for (let i = 0; i < data.vecs.length; i++) {
    const v = data.vecs[i];
    let dot = 0;
    for (let k = 0; k < dim; k++) dot += qv[k] * v[k];
    scored.push({ i, s: dot });
  }
  scored.sort((a, b) => b.s - a.s);

  console.log('查询: 「' + q + '」   (' + (Date.now() - t0) + 'ms, 扫 ' + data.vecs.length + ' 块)\n');
  for (const x of scored.slice(0, top)) {
    const c = data.chunks.get(data.ids[x.i]);
    console.log('  ' + x.s.toFixed(4) + '  ' + (c ? c.mem.slice(0, 62) : data.ids[x.i]));
    if (c) {
      const snippet = c.text.replace(/\s+/g, ' ').slice(0, 90);
      console.log('           ' + snippet);
    }
  }
};

run().catch(e => { console.error('失败: ' + ((e && e.stack) || e)); process.exit(1); });
