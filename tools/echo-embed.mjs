#!/usr/bin/env node
// Local BGE embedding adapter. It accepts caller-supplied text only and never reads a memory corpus.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const MODEL_ID = 'BAAI/bge-small-zh-v1.5';
const MODEL_REVISION = 'local-bundled-unpinned';
const TRANSFORMERS_VERSION = 'runtime-package-metadata';
const DIM = 512;
const QUERY_PREFIX = '为这个句子生成表示以用于检索相关文章：';
// ★★ 2026-11-17（爀曦：「向量层，包括向量模型也要嵌入程序，不然用户安装也是没有的」）：
//   模型随程序走，**不再指向某个开发仓库**。候选顺序（先到先用）：
//     ① 调用方显式给 modelDir / 环境变量 ECHO_BGE_MODEL_DIR（部署者可覆盖）
//     ② <程序根>/models/bge-small-zh —— 随程序分发的那份（相对路径，可移植）
//   旧默认 'D:/AI/dsh-tools/dsh-agent-soul/...' 是开发机死路径，一律不再作为默认值。
//
// ★★★ 2026-11-18 修：注释说「<程序根>/models」，实现却只往上走一层。
//   这个文件在 <根>/app/<版本>/tools/ 下，所以 '../models' 解析成
//   <根>/app/<版本>/models —— **差了一层**。而 make-dist 把模型装在 <根>/models。
//   症状是「文件明明在包里，一调就说没有」：
//     Error: ENOENT ... \app\1.0.65\models\bge-small-zh\onnx\model_quantized.onnx
//   这个错一直没暴露，是因为本机开发时模型在仓库根的 models/ 下，恰好被别的路径命中了。
//   现在按「由近到远」列全候选，并且**按 onnx 文件是否存在**来选，不靠猜层级：
//     ① 调用方 / 环境变量
//     ② <根>/app/<版本>/models   （跟版本走的放法，某些部署可能这么装）
//     ③ <根>/models              （当前发布包的放法：模型跨版本共享，不按版本复制一份）
const HERE = path.dirname(fileURLToPath(import.meta.url));   // …/app/<版本>/tools
function modelDirCandidates() {
  // 明写三层，比用 repeat 拼路径好读，也不会因为 '.' 的个数算错而静默跑到别处。
  return [
    path.resolve(HERE, '..', 'models', 'bge-small-zh'),          // ① <根>/app/<版本>/models（跟版本走）
    path.resolve(HERE, '..', '..', 'models', 'bge-small-zh'),    // ② <根>/app/models（中间层，历史可能）
    path.resolve(HERE, '..', '..', '..', 'models', 'bge-small-zh'), // ③ <根>/models ← 当前发布包就是这里
  ];
}
function pickModelDir() {
  const cands = modelDirCandidates();
  for (const d of cands) {
    try { if (fs.existsSync(path.join(d, 'onnx', 'model_quantized.onnx'))) return d; } catch { /* 换下一个 */ }
  }
  // 都不在就回最后一个（<根>/models），错误信息里会显示最可能的那个路径。
  return cands[cands.length - 1];
}
const DEFAULT_MODEL_DIR = pickModelDir();
/**
 * ★ 2026-11-20：把这个解析结果**导出**。
 *   起因：echo-vectorize-production.mjs 自己拼了一条 path.dirname(import.meta.url)/../models，
 *   在开发树里碰巧对了（D:/AI/agent-soul/tools/../models），可一旦跟着载荷部署到
 *   <根>/app/1.0.67/tools/../models —— 那一层**没有模型**（包把模型放在 <根>/models）。
 *   症状会是「开发能跑、装完说没有」。这里的三候选解析本来就是为此写的，让调用方共用同一份。
 */
export { DEFAULT_MODEL_DIR };

export function buildModelFingerprint({ modelDir, modelBytes, tokenizerBytes, configBytes, transformersVersion = TRANSFORMERS_VERSION }) {
  return Object.freeze({
    modelId: MODEL_ID,
    modelRevision: MODEL_REVISION,
    transformersVersion,
    modelSha256: sha256(modelBytes),
    tokenizerSha256: sha256(tokenizerBytes),
    configSha256: sha256(configBytes),
    dimension: DIM,
    dtype: 'q8',
    pooling: 'mean',
    normalized: true,
    queryPrefix: QUERY_PREFIX,
    documentPrefix: '',
    maxInputChars: 1000,
    truncation: 'slice-code-units-before-tokenization',
  });
}

function assertFingerprint(actual, expected) {
  if (!expected || typeof expected !== 'object') throw new TypeError('expectedModelFingerprint is required');
  for (const key of ['modelId','modelRevision','transformersVersion','modelSha256','tokenizerSha256','configSha256','dimension','dtype','pooling','normalized','queryPrefix','documentPrefix','maxInputChars','truncation']) {
    if (actual[key] !== expected[key]) throw new Error('MODEL_FINGERPRINT_MISMATCH:' + key);
  }
}

export async function createBgeEmbedder(options = {}) {
  const modelDir = path.resolve(options.modelDir || process.env.ECHO_BGE_MODEL_DIR || DEFAULT_MODEL_DIR);
  const expected = options.expectedModelFingerprint;
  const modelPath = path.join(modelDir, 'onnx', 'model_quantized.onnx');
  const tokenizerPath = path.join(modelDir, 'tokenizer.json');
  const configPath = path.join(modelDir, 'config.json');
  const fileReader = options.readModelFile || ((p) => fs.readFileSync(p));
  const [modelBytes, tokenizerBytes, configBytes] = [modelPath, tokenizerPath, configPath].map((p) => fileReader(p));
  const { createRequire } = await import('node:module');
  const require = createRequire(path.join(modelDir, 'package.json'));
  let transformersVersion = options.transformersVersion || null;
  if (options.pipelineFactory && transformersVersion) {
    // Deterministic tests inject a fake runtime and an explicit version.
  } else {
    const transformersEntry = options.transformersEntry || require.resolve('@huggingface/transformers');
    let packageDir = path.dirname(transformersEntry);
    while (path.basename(packageDir) !== 'transformers') { const parent = path.dirname(packageDir); if (parent === packageDir) throw new Error('TRANSFORMERS_PACKAGE_ROOT_NOT_FOUND'); packageDir = parent; }
    transformersVersion = JSON.parse(fileReader(path.join(packageDir, 'package.json')).toString('utf8')).version;
  }
  const actual = buildModelFingerprint({ modelDir, modelBytes, tokenizerBytes, configBytes, transformersVersion });
  assertFingerprint(actual, expected);

  // ★★★ 2026-11-18 03:00 重测并改默认（爀曦：「向量模型完完全全可以跑在GPU上呀」）：
  //   device 决定用哪个执行后端。判据：**默认 GPU，起不来才退回 CPU**。
  //   · 'dml'  = DirectML（Windows 上任意 DX12 显卡，本机 RTX 2070 Max-Q）
  //   · 'cuda' = 需要 CUDA 版 onnxruntime（本机装的是普通版，不走这条）
  //   · 'cpu'  = 兜底（无显卡 / 驱动异常 / 显式指定）
  //
  //   ── 测法（要复现就照这个抄，别只看结论）─────────────────────────
  //   24 条真实长文本（从 echo_words 取 length(text)>=900，各截到 1000 字），
  //   dtype q8，pooling mean，normalize true，batch=8，先跑一批预热不计时，
  //   生产向量化任务全部停掉，同一台机器前后紧挨着测。
  //   探针脚本：D:/AI/agent-soul/_bench_embed.mjs（一次性，不入包）
  //
  //   ┌────────┬────────┬────────┬──────┐
  //   │ device │ ms/条  │ 条/秒  │ 相对 │
  //   ├────────┼────────┼────────┼──────┤
  //   │ cpu    │ 339.3  │  2.95  │  1×  │
  //   │ dml    │  53.0  │ 18.87  │ 6.4× │
  //   └────────┴────────┴────────┴──────┘
  //   **结论：这台机器上 GPU 快 6.4 倍。**
  //
  //   ★★★ 这里原本写着「CPU 更快，GPU 全面落后」，还附了一张 256 条 /
  //   117.8ms 的表 —— 那是**错的**（合 0.46ms/条，比这台机器物理上能做到的
  //   快了两个数量级；来源不明，多半是把短文本或缓存命中当成长文本记的）。
  //   我照它把默认值定成了 cpu，于是拿 3% 的算力去跑 26.6 万条向量。
  //   **教训不是「我算错了」，是「实测」两个字本身不构成证据** —— 要看测法：
  //   条数、文本长度、batch、有没有预热、有没有别的任务在抢 CPU，
  //   缺一样，数字就不可比。
  //
  //   ── 设备差异会不会污染向量？实测（同 8 条文本，cpu / dml 各算一次）──
  //     余弦 0.99938 ~ 0.99955，最大分量差 5.45e-3。
  //   ⇒ 这是浮点累积顺序的噪声，**不是语义差异**，不改变检索排序。
  //   ⇒ 所以 device **不写进 model_key / preprocessSpec**：读写两侧不必锁死同一块
  //     显卡，换台机器或换块卡仍然读同一批向量。真正决定向量身份的是
  //     模型 + tokenizer + 预处理 + 池化 + 归一化 —— 那些已经在 spec 里锁死了。
  //   ⇒ 反过来的边界也要说清：哪天换成 fp32、换模型或改预处理，
  //     modelSha256 / preprocessSpec 会变，**那才是必须重新向量化的分界**。
    const wantDevice = options.device || process.env.ECHO_EMBED_DEVICE || 'dml';
  let deviceNote = '';
  const makePipeline = options.pipelineFactory || (async () => {
    const { pipeline, env } = require('@huggingface/transformers');
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = modelDir;
    env.useBrowserCache = false;
    const build = (dev) => pipeline('feature-extraction', modelDir, { dtype: 'q8', device: dev });
    if (wantDevice === 'cpu') { deviceNote = 'cpu(显式指定)'; return build('cpu'); }
    try {
      const pipe = await build(wantDevice);
      deviceNote = wantDevice;
      return pipe;
    } catch (err) {
      // ★ 退回 CPU 必须是**响亮的**：静默退回 = 用户以为在用显卡，实际在跑 CPU。
      deviceNote = 'cpu(回退：' + wantDevice + ' 起不来 —— ' + String((err && err.message) || err).slice(0, 120) + ')';
      return build('cpu');
    }
  });
  const pipe = await makePipeline({ modelDir, dtype: 'q8', fingerprint: actual });
  // 后端如实上报（调用方可据此判断「到底有没有在用显卡」）。

  async function embed(texts, kind) {
    if (!Array.isArray(texts) || texts.length === 0 || texts.some((x) => typeof x !== 'string' || !x.trim())) throw new TypeError('texts must be a non-empty array of non-blank strings');
    if (kind !== 'query' && kind !== 'document') throw new TypeError("kind must be 'query' or 'document'");
    const prepared = texts.map((text) => {
      const cut = text.length > actual.maxInputChars ? text.slice(0, actual.maxInputChars) : text;
      return kind === 'query' ? QUERY_PREFIX + cut : cut;
    });
    const out = await pipe(prepared, { pooling: 'mean', normalize: true });
    const dim = out.dims[out.dims.length - 1];
    if (dim !== DIM || out.data.length !== texts.length * DIM) throw new Error('EMBED_DIMENSION_MISMATCH');
    const vectors = [];
    for (let i = 0; i < texts.length; i += 1) {
      const vector = Float32Array.from(out.data.slice(i * DIM, (i + 1) * DIM));
      let normSq = 0;
      for (const v of vector) { if (!Number.isFinite(v)) throw new Error('EMBED_NONFINITE'); normSq += v * v; }
      if (Math.abs(Math.sqrt(normSq) - 1) > 0.02) throw new Error('EMBED_NOT_NORMALIZED');
      vectors.push(vector);
    }
    return vectors.map((vector, i) => ({ vector, kind, modelFingerprint: actual, inputSha256: sha256(Buffer.from(prepared[i], 'utf8')) }));
  }
  // ★ device 上报：调用方（向量化脚本 / MCP 工具）据此判断「到底在不在用显卡」。
  //   不报的话，GPU 悄悄回退到 CPU 也会显示一切正常 —— 那是假绿。
  return Object.freeze({
    fingerprint: actual,
    device: () => deviceNote || wantDevice,
    embedQueries: (texts) => embed(texts, 'query'),
    embedDocuments: (texts) => embed(texts, 'document'),
  });
}

async function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
  const kind = get('--kind');
  const modelDir = get('--model-dir') || process.env.ECHO_BGE_MODEL_DIR || DEFAULT_MODEL_DIR;
  const expectedPath = get('--expected-fingerprint');
  if (!['query','document'].includes(kind) || !expectedPath) throw new Error('usage: echo JSON_ARRAY | node echo-embed.mjs --kind query|document --model-dir DIR --expected-fingerprint FILE');
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const texts = JSON.parse(input);
  const embedder = await createBgeEmbedder({ modelDir, expectedModelFingerprint: expected });
  const results = kind === 'query' ? await embedder.embedQueries(texts) : await embedder.embedDocuments(texts);
  process.stdout.write(JSON.stringify({ fingerprint: embedder.fingerprint, results: results.map((x) => ({ vector: Array.from(x.vector), kind: x.kind, inputSha256: x.inputSha256 })) }) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { process.stderr.write(String(error && error.stack || error) + '\n'); process.exitCode = 1; });
}
