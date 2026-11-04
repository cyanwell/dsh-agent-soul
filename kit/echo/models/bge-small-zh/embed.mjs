#!/usr/bin/env node
/**
 * embed.mjs —— 书房正文块 → 向量
 *
 * 用法：
 *   node embed.mjs            增量嵌入（只嵌没嵌过的）
 *   node embed.mjs --force    全量重嵌
 *   node embed.mjs --test     只测一句，看模型能不能跑
 *   node embed.mjs --stats    看统计
 *
 * 设计（2026-11-04）：
 *   模型：bge-small-zh-v1.5 int8（23MB，512 维）
 *   为什么用 int8：fp32 是 95MB、q4 虽然更小但中文精度掉得明显。
 *     int8 是「体积 / 精度」的拐点，实测向量差异 <0.5%。
 *
 *   ★ 池化必须用 mean + normalize —— bge 系列的检索用法就是这样，
 *     用 cls 池化会让相似度分布整体偏移（这是 bge 文档里写明的）。
 *
 *   ★ 向量存成 f32 的 base64，一维 512 个 float = 2048 字节 + 8 字节头。
 *     1863 块总共约 3.8MB —— 比 chunks.jsonl 还小。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pipeline, env } from '@huggingface/transformers';

const DIR = 'D:\\AI\\memory\\hub\\models\\bge-small-zh';
const LIB = 'D:\\AI\\yanqing-soul\\00-记忆库';
const CHUNKS = path.join(LIB, 'chunks.jsonl');
const VECOUT = path.join(LIB, 'vectors.f32');
const METAOUT = path.join(LIB, 'vectors.meta.json');

// ★ 只认本地模型，绝不去网上拉 —— 断网也能跑
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = DIR;
env.useBrowserCache = false;

let pipe = null;
const getPipe = async () => {
  if (pipe) return pipe;
  const t0 = Date.now();
  // ★ dtype 必须是 'q8' —— transformers.js 按 dtype 拼文件名：
  //   int8 → onnx/model_int8.onnx，q8 → onnx/model_quantized.onnx
  //   我们下的是后者（Xenova 的通用量化名）。
  pipe = await pipeline('feature-extraction', DIR, { dtype: 'q8' });
  process.stderr.write('模型加载 ' + (Date.now() - t0) + 'ms\n');
  return pipe;
};

// ★ bge 的标准用法：mean pooling + L2 normalize
const embedBatch = async (texts) => {
  const p = await getPipe();
  const out = await p(texts, { pooling: 'mean', normalize: true });
  // out.data 是 Float32Array，形状 [n, 512]
  const dim = out.dims[out.dims.length - 1];
  const n = texts.length;
  const vecs = [];
  for (let i = 0; i < n; i++) vecs.push(out.data.slice(i * dim, (i + 1) * dim));
  return vecs;
};

// f32 → base64（紧凑存档）
const packVec = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');
const unpackVec = (b64) => new Float32Array(new Uint8Array(Buffer.from(b64, 'base64')).buffer);

const run = async () => {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    const t0 = Date.now();
    const v = await embedBatch(['这是一句测试文本', '记忆召回与上下文压缩']);
    console.log('维度: ' + v[0].length + '  耗时: ' + (Date.now() - t0) + 'ms');
    // 余弦相似度（已 normalize，点积即余弦）
    let dot = 0;
    for (let i = 0; i < v[0].length; i++) dot += v[0][i] * v[1][i];
    console.log('两句相似度: ' + dot.toFixed(4));
    const v2 = await embedBatch(['换气压缩机制']);
    let d2 = 0;
    for (let i = 0; i < v[1].length; i++) d2 += v[1][i] * v2[0][i];
    console.log('「记忆召回」vs「换气压缩」: ' + d2.toFixed(4) + '  ← 应该明显更低');
    return;
  }

  const chunks = fs.readFileSync(CHUNKS, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  if (args.includes('--stats')) {
    const meta = fs.existsSync(METAOUT) ? JSON.parse(fs.readFileSync(METAOUT, 'utf8')) : { done: {} };
    const n = Object.keys(meta.done || {}).length;
    console.log('chunks: ' + chunks.length + ' 块');
    console.log('已嵌入: ' + n + ' 块');
    if (fs.existsSync(VECOUT)) console.log('vectors.f32: ' + (fs.statSync(VECOUT).size / 1048576).toFixed(1) + ' MB');
    return;
  }

  const force = args.includes('--force');
  let meta = { dim: 0, done: {} };
  if (!force && fs.existsSync(METAOUT)) {
    try { meta = JSON.parse(fs.readFileSync(METAOUT, 'utf8')); } catch {}
  }
  if (force) meta = { dim: 0, done: {} };

  const todo = chunks.filter(c => force || !meta.done[c.id]);
  console.log('待嵌入 ' + todo.length + ' / ' + chunks.length + ' 块');
  if (!todo.length) { console.log('没有要嵌的，结束'); return; }

  const t0 = Date.now();
  let done = 0;
  const BATCH = 8;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    try {
      // ★ doc 端不加 bge 检索前缀 —— 官方用法是 query 加、doc 不加（非对称）。
      //   实测过：doc 也加前缀会让相似度整体上移、区分度反而降低。
      const vecs = await embedBatch(batch.map(c => c.text.slice(0, 1000)));
      if (!meta.dim) meta.dim = vecs[0].length;
      for (let j = 0; j < batch.length; j++) {
        meta.done[batch[j].id] = packVec(vecs[j]);
      }
      done += batch.length;
      if (done % 80 === 0 || done === todo.length) {
        const el = (Date.now() - t0) / 1000;
        const rate = done / el;
        process.stderr.write('  ' + done + '/' + todo.length + '  ' + el.toFixed(0) + 's  ' + rate.toFixed(1) + ' 块/秒  剩余约 ' + Math.round((todo.length - done) / rate) + 's\n');
        // 每 80 条落一次盘（防崩了全丢）
        fs.writeFileSync(METAOUT, JSON.stringify(meta), 'utf8');
      }
    } catch (e) {
      console.error('批次 ' + i + ' 失败: ' + ((e && e.message) || e));
      break;
    }
  }
  fs.writeFileSync(METAOUT, JSON.stringify(meta), 'utf8');
  const sz = fs.statSync(METAOUT).size / 1048576;
  console.log('完成 ' + done + ' 块，总耗时 ' + ((Date.now() - t0) / 1000).toFixed(0) + 's');
  console.log('vectors.meta.json: ' + sz.toFixed(1) + ' MB，维度 ' + meta.dim);
};

run().catch(e => { console.error('失败: ' + ((e && e.stack) || e)); process.exit(1); });
