// echo-override-convert-selftest.mjs — 三个合成夹具，专打转换器的三个判断点。
//   ① 对得上：六候选 sid × 两个变体 = 12 条，全部核实通过 → 产出 producer 形状
//      用法：node echo-override-convert-selftest.mjs
//   输出：只回用例名、码与计数 —— 不打印 sid，也不打印路径。
//   退出码：0 全过 / 1 有用例没过
import fs from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  convert, OVERRIDE_FORMAT, PRODUCER_ENTRY_FIELDS, SID_CANDIDATES, sidHash16Of,
} from './echo-override-convert.mjs';

const results = [];
const record = (name, ok, detail) => results.push({ name, ok, detail: detail || null });

function mkTmp(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'echo-ov-conv-' + tag + '-'));
}

// 12 条 = 六个 sid × 两个变体；每个 word 分片 1 行，sum 分片 0 行。
function buildFixture(dir, mutate) {
  const entries = [];
  for (const variant of ['v3', 'v4']) {
    for (const sid of SID_CANDIDATES) {
      const h16 = sidHash16Of(sid);
      const wordName = variant + '-' + h16 + '.word.jsonl';
      const sumName = variant + '-' + h16 + '.sum.jsonl';
      const wordBytes = Buffer.from('{"i":0}\n', 'utf8');
      fs.writeFileSync(path.join(dir, wordName), wordBytes);
      fs.writeFileSync(path.join(dir, sumName), Buffer.alloc(0));
      entries.push({
        variant,
        sidHash: h16,
        wordFile: wordName,
        wordBytes: wordBytes.length,
        wordRows: 1,
        wordSha256: sha(wordBytes),
        sumFile: sumName,
        sumBytes: 0,
        sumRows: 0,
        sumSha256: sha(Buffer.alloc(0)),
      });
    }
  }
  const manifest = { generatedAt: 'synthetic', note: 'selftest fixture', entries };
  if (mutate) mutate({ dir, manifest, entries });
  const manifestPath = path.join(dir, 'rebuilt-override.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { dir, manifestPath, entries, outPath: path.join(dir, 'producer-override.json') };
}

function sha(b) {
  // 与转换器同一算法；不在夹具里另写一套哈希。
  return createHash('sha256').update(b).digest('hex');
}

const codeOf = (fn) => {
  try { fn(); return null; } catch (err) { return err && err.code ? err.code : 'NO_CODE'; }
};

// ── 用例 1：完全对得上 ──────────────────────────────────────────────────────
{
  const f = buildFixture(mkTmp('ok'));
  let r = null;
  const code = codeOf(() => { r = convert(f.manifestPath, f.outPath); });
  if (code !== null) {
    record('matching-entry', false, code);
  } else {
    const written = fs.readFileSync(f.outPath);
    const parsed = JSON.parse(written.toString('utf8'));
    const shapes = parsed.entries.every((e) => Object.keys(e).sort().join(',') === PRODUCER_ENTRY_FIELDS.slice().sort().join(','));
    const relResolve = parsed.entries.every((e) => fs.existsSync(path.resolve(f.dir, e.wordFile)) && fs.existsSync(path.resolve(f.dir, e.sumFile)));
    const ok = r.ok === true
      && parsed.format === OVERRIDE_FORMAT
      && r.entryCount === 12
      && r.sessionCount === 6
      && r.variantCounts.v3 === 6
      && r.variantCounts.v4 === 6
      && r.totalWordRows === 12
      && r.totalSumRows === 0
      && shapes
      && relResolve
      && r.outBytes === written.length;
    record('matching-entry', ok, ok ? null : { entryCount: r.entryCount, sessionCount: r.sessionCount, shapes, relResolve });
  }
  fs.rmSync(f.dir, { recursive: true, force: true });
}

// ── 用例 2：manifest 里有一个 sidHash 谁也匹配不上 ─────────────────────────
{
  const f = buildFixture(mkTmp('unmatched'), ({ entries }) => {
    entries[0].sidHash = '0000000000000000';
  });
  const code = codeOf(() => convert(f.manifestPath, f.outPath));
  const emitted = fs.existsSync(f.outPath);
  record('unmatched-sid-hash', code === 'SID_HASH_UNMATCHED' && emitted === false, { code, emitted });
  fs.rmSync(f.dir, { recursive: true, force: true });
}

// ── 用例 3：分片字节变了（同长度，只有 sha 变），声明值没跟着改 ─────────────
{
  const f = buildFixture(mkTmp('sha'), ({ dir, entries }) => {
    const target = path.join(dir, entries[0].wordFile);
    fs.writeFileSync(target, Buffer.from('{"i":1}\n', 'utf8')); // 同长度，只有内容变
  });
  const code = codeOf(() => convert(f.manifestPath, f.outPath));
  const emitted = fs.existsSync(f.outPath);
  record('shard-hash-changed', code === 'SHARD_SHA_MISMATCH' && emitted === false, { code, emitted });
  fs.rmSync(f.dir, { recursive: true, force: true });
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
const failed = results.filter((x) => x.ok === false);
for (const r of results) {
  process.stdout.write(JSON.stringify({ case: r.name, ok: r.ok, detail: r.detail }) + '\n');
}
process.stdout.write(JSON.stringify({ cases: results.length, passed: results.length - failed.length, failed: failed.length }) + '\n');
process.exitCode = failed.length === 0 ? 0 : 1;
