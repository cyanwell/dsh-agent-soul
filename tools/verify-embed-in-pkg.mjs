// 验证：装完之后语义检索真的能用（不是「文件在」而是「embedding 出得来」）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const SETUP = 'D:/AI/agent-soul/dist/AgentSoul-Setup-1.0.65.exe';
const TARGET = path.join(os.tmpdir(), 'as-embed-verify-' + Date.now());
const run = (exe, args, o) => spawnSync(exe, args, { encoding: 'utf8', timeout: (o && o.timeout) || 300000, stdio: ['ignore', 'pipe', 'pipe'], cwd: (o && o.cwd) });

console.log('目标 = ' + TARGET);
try {
  console.log('=== 1. 静默安装 ===');
  const t0 = Date.now();
  const inst = run(SETUP, ['/S', '/D=' + TARGET]);
  console.log('  exit=' + inst.status + '  耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒');
  for (const l of (inst.out || '').split(/\r?\n/).filter(Boolean)) console.log('    ' + l);
  if (inst.stderr && inst.stderr.trim()) console.log('    [err] ' + inst.stderr.trim().slice(0, 300));

  console.log('');
  console.log('=== 2. 模型文件是否到位 ===');
  const need = [
    'models/bge-small-zh/onnx/model_quantized.onnx',
    'models/bge-small-zh/tokenizer.json',
    'models/bge-small-zh/config.json',
    'models/bge-small-zh/package.json',
    'models/bge-small-zh/node_modules/@huggingface/transformers/package.json',
    'models/bge-small-zh/node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node',
  ];
  let allThere = true;
  for (const f of need) {
    const p = path.join(TARGET, f);
    const ok = fs.existsSync(p);
    if (!ok) allThere = false;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + f + (ok ? '  ' + fs.statSync(p).size + ' B' : ''));
  }

  console.log('');
  console.log('=== 3. 真的跑一次 embedding（用安装后的 node + 安装后的模型目录）===');
  const nodeExe = path.join(TARGET, 'runtime', 'node.exe');
  const embedScript = path.join(TARGET, 'app', '1.0.65', 'tools', 'echo-embed.mjs');
  console.log('  node  = ' + nodeExe + '  exists=' + fs.existsSync(nodeExe));
  console.log('  embed = ' + embedScript + '  exists=' + fs.existsSync(embedScript));

  const probe = path.join(TARGET, '_probe_embed.mjs');
  fs.writeFileSync(probe, [
    "import path from 'node:path';",
    "// ★ 走**真实调用路径**：mcp-tools 里的 SEMANTIC_MODEL_FINGERPRINT 是硬编码 14 字段，",
    "//   自己手搓 buildModelFingerprint 会差 transformersVersion（第一版就撞在这里）。",
    "//   所以直接量「适配器能不能加载模型并出向量」，不看指纹内部。",
    "const { createBgeEmbedder } = await import('./app/1.0.65/tools/echo-embed.mjs');",
    "const modelDir = path.resolve('models/bge-small-zh');",
    "const FP = Object.freeze({",
    "  modelId: 'BAAI/bge-small-zh-v1.5', modelRevision: 'local-bundled-unpinned',",
    "  transformersVersion: '4.3.2', dimension: 512, dtype: 'q8', pooling: 'mean', normalized: true,",
    "  queryPrefix: '为这个句子生成表示以用于检索相关文章：', documentPrefix: '',",
    "  maxInputChars: 1000, truncation: 'slice-code-units-before-tokenization',",
    "});",
    "import fs2 from 'node:fs';",
    "import { createHash } from 'node:crypto';",
    "const sha = (b) => createHash('sha256').update(b).digest('hex');",
    "const fp = Object.assign({}, FP, {",
    "  modelSha256: sha(fs2.readFileSync(path.join(modelDir, 'onnx', 'model_quantized.onnx'))),",
    "  tokenizerSha256: sha(fs2.readFileSync(path.join(modelDir, 'tokenizer.json'))),",
    "  configSha256: sha(fs2.readFileSync(path.join(modelDir, 'config.json'))),",
    "});",
    "const t = Date.now();",
    "const emb = await createBgeEmbedder({ modelDir, expectedModelFingerprint: fp });",
    "console.log('device=' + emb.device());",
    "const out = await emb.embedQueries(['向量检索是怎么实现的']);",
    "const v = out[0].vector;",
    "let n = 0; for (const x of v) n += x * x;",
    "console.log('dim=' + v.length + '  norm=' + Math.sqrt(n).toFixed(6) + '  ms=' + (Date.now()-t));",
    "console.log('前3分量: ' + [v[0],v[1],v[2]].map(x=>Number(x).toFixed(6)).join(', '));",
    "// 再取一条不同文本，确认它真的在算（不是返回常量）",
    "const out2 = await emb.embedQueries(['完全不同的另一句话']);",
    "const w = out2[0].vector;",
    "let dot = 0; for (let i = 0; i < v.length; i++) dot += v[i] * w[i];",
    "console.log('两条不同文本的余弦=' + dot.toFixed(6) + '（应明显小于 1）');",
  ].join('\n'), 'utf8');

  const emb = run(nodeExe, [probe], { cwd: TARGET, timeout: 300000 });
  console.log('  exit=' + emb.status);
  for (const l of (emb.out || '').split(/\r?\n/).filter(Boolean)) console.log('    ' + l);
  if (emb.stderr && emb.stderr.trim()) console.log('    [err] ' + emb.stderr.trim().split(/\r?\n/).slice(0, 10).join('\n    '));
  fs.rmSync(probe, { force: true });

  console.log('');
  console.log('=== 判定 ===');
  const ok = allThere && emb.status === 0 && /dim=512/.test(emb.out || '');
  console.log('  ' + (ok ? 'PASS 装完之后语义检索可用（模型在 + embedding 出得来）' : 'FAIL 见上'));
} finally {
  try { execFileSync('taskkill', ['/IM', 'AgentSoul.exe', '/F'], { stdio: 'ignore' }); } catch { }
  await new Promise((r) => setTimeout(r, 500));
  try { fs.rmSync(TARGET, { recursive: true, force: true }); } catch { }
  console.log('清理: ' + !fs.existsSync(TARGET));
}
