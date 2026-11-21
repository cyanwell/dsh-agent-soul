#!/usr/bin/env node
// TEMP-only tests for caller-text BGE adapter. No corpus, index, DB or vector files are opened.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildModelFingerprint, createBgeEmbedder } from './echo-embed.mjs';
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-embed-selftest-'));
const MODEL = path.join(ROOT, 'model');
const mkdir = (p) => fs.mkdirSync(p, { recursive: true });
const write = (p, b) => { mkdir(path.dirname(p)); fs.writeFileSync(p, b); };
const sha = (b) => createHash('sha256').update(b).digest('hex');
const assertions = [];
const check = async (name, fn) => { await fn(); assertions.push(name); console.log('PASS ' + name); };
try {
  const weights = Buffer.from('synthetic-q8-weight');
  const tokenizer = Buffer.from('{"synthetic":"tokenizer"}');
  const config = Buffer.from('{"hidden_size":512}');
  write(path.join(MODEL, 'onnx', 'model_quantized.onnx'), weights);
  write(path.join(MODEL, 'tokenizer.json'), tokenizer);
  write(path.join(MODEL, 'config.json'), config);
  const fingerprint = buildModelFingerprint({ modelDir: MODEL, modelBytes: weights, tokenizerBytes: tokenizer, configBytes: config, transformersVersion: '4.3.2' });
  const second = buildModelFingerprint({ modelDir: path.join(ROOT, 'elsewhere'), modelBytes: weights, tokenizerBytes: tokenizer, configBytes: config, transformersVersion: '4.3.2' });
  await check('fingerprint binds model/tokenizer/config bytes, not absolute host path', () => {
    assert.equal(fingerprint.modelSha256, sha(weights));
    assert.equal(fingerprint.tokenizerSha256, sha(tokenizer));
    assert.equal(fingerprint.configSha256, sha(config));
    assert.equal(JSON.stringify(fingerprint), JSON.stringify(second));
    assert.equal(fingerprint.dimension, 512);
    assert.equal(fingerprint.pooling, 'mean');
    assert.equal(fingerprint.normalized, true);
    assert.equal(fingerprint.dtype, 'q8');
  });
  let seen = null;
  const fakePipeline = async ({ modelDir, dtype, fingerprint: actual }) => {
    assert.equal(modelDir, MODEL);
    assert.equal(dtype, 'q8');
    assert.deepEqual(actual, fingerprint);
    return async (texts, opts) => {
      seen = { texts, opts };
      const data = new Float32Array(texts.length * 512);
      for (let i = 0; i < texts.length; i += 1) data[i * 512] = 1;
      return { dims: [texts.length, 512], data };
    };
  };
  const embedder = await createBgeEmbedder({ modelDir: MODEL, expectedModelFingerprint: fingerprint, pipelineFactory: fakePipeline, transformersVersion: '4.3.2' });
  const q = await embedder.embedQueries(['语义召回测试']);
  await check('queries use the pinned retrieval prefix, mean pooling and L2-normalized 512 vector', () => {
    assert.equal(seen.texts[0], fingerprint.queryPrefix + '语义召回测试');
    assert.deepEqual(seen.opts, { pooling: 'mean', normalize: true });
    assert.equal(q[0].vector.length, 512);
    assert.equal(q[0].vector[0], 1);
    assert.equal(q[0].kind, 'query');
    assert.equal(q[0].inputSha256, sha(Buffer.from(seen.texts[0], 'utf8')));
    assert.equal(q[0].modelFingerprint.modelSha256, fingerprint.modelSha256);
  });
  const d = await embedder.embedDocuments(['原文记录']);
  await check('documents receive no query prefix and output contains no source text', () => {
    assert.equal(seen.texts[0], '原文记录');
    assert.equal(d[0].kind, 'document');
    assert.equal(Object.hasOwn(d[0], 'text'), false);
  });
  await check('stale model hash fails before loading the inference pipeline', async () => {
    const bad = { ...fingerprint, modelSha256: '0'.repeat(64) };
    await assert.rejects(() => createBgeEmbedder({ modelDir: MODEL, expectedModelFingerprint: bad, pipelineFactory: fakePipeline, transformersVersion: '4.3.2' }), /MODEL_FINGERPRINT_MISMATCH:modelSha256/);
  });
  await check('empty, blank and non-string inputs are rejected', async () => {
    await assert.rejects(() => embedder.embedQueries([]), /texts must be/);
    await assert.rejects(() => embedder.embedDocuments(['  ']), /texts must be/);
    await assert.rejects(() => embedder.embedQueries([42]), /texts must be/);
  });
  await check('non-finite and wrong-sized model outputs are rejected', async () => {
    const nanEmbedder = await createBgeEmbedder({ modelDir: MODEL, expectedModelFingerprint: fingerprint, transformersVersion: '4.3.2', pipelineFactory: async () => async (xs) => { const data = new Float32Array(xs.length * 512); data[4] = NaN; return { dims: [xs.length, 512], data }; } });
    await assert.rejects(() => nanEmbedder.embedQueries(['test']), /EMBED_NONFINITE/);
    const shortEmbedder = await createBgeEmbedder({ modelDir: MODEL, expectedModelFingerprint: fingerprint, transformersVersion: '4.3.2', pipelineFactory: async () => async (xs) => ({ dims: [xs.length, 511], data: new Float32Array(xs.length * 511) }) });
    await assert.rejects(() => shortEmbedder.embedQueries(['test']), /EMBED_DIMENSION_MISMATCH/);
  });
  const actual = process.env.ECHO_BGE_SMOKE === '1';
  if (actual) {
    const modelDir = process.env.ECHO_BGE_MODEL_DIR;
    const pkg = process.env.ECHO_TRANSFORMERS_DIR;
    if (!modelDir || !pkg) throw new Error('ECHO_BGE_SMOKE requires explicit ECHO_BGE_MODEL_DIR and ECHO_TRANSFORMERS_DIR');
    const { createRequire } = await import('node:module');
    const require = createRequire(path.join(pkg, 'package.json'));
    const transformersEntry = require.resolve('@huggingface/transformers');
    const transformersVersion = '4.3.2';
    const expectedModelFingerprint = {
      modelId: 'BAAI/bge-small-zh-v1.5', modelRevision: 'local-bundled-unpinned', transformersVersion,
      modelSha256: '15b717c382bcb518ba457b93ea6850ede7f4f1cd8937454aa06972366cd19bcc',
      tokenizerSha256: '48cea5d44424912a6fd1ea647bf4fe50b55ab8b1e5879c3275f80e339e8fae26',
      configSha256: 'd4193ead3a810fd694fa8a31d7fc72fbaebc0668b603e398734bf2f6538ff42f',
      dimension: 512, dtype: 'q8', pooling: 'mean', normalized: true,
      queryPrefix: '为这个句子生成表示以用于检索相关文章：', documentPrefix: '',
      maxInputChars: 1000, truncation: 'slice-code-units-before-tokenization',
    };
    const real = await createBgeEmbedder({ modelDir, expectedModelFingerprint, transformersEntry });
    const result = await real.embedQueries(['轻量模型语义召回烟雾测试']);
    assert.equal(result[0].vector.length, 512);
    console.log('PASS real BGE local inference dimension=512 inputSha256=' + result[0].inputSha256);
  }
  console.log(assertions.length + ' adapter checks passed');
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true });
  assert.equal(fs.existsSync(ROOT), false, 'TEMP test root removed');
}
