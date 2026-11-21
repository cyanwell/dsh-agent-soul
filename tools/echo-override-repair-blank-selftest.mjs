#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// echo-override-repair-blank-selftest.mjs — 只用**合成夹具**，一个真实字节都不读
//
// 覆盖用例（按任务要求的那四种形状 + 每一条拒绝路径）：
//   ① 首行空行（且末行没有 LF）  ② 中间空行（有 LF）  ③ 没有空行（不该修）
//   ④ CRLF 空行                  ⑤ 空行 + 坏行（拒）  ⑥ 超过 5 个分片（拒）
//   ⑦ 另一侧被两行共享（拒）      ⑧ override-in 格式错（拒） ⑨ manifest digest 不符（拒）
//   ⑩ 分片没有主人（拒）          ⑪ 落点落在快照内（拒）    ⑫ override 里已有同一 (variant,sid)（拒）
//   ⑬ 快照一个字节都没变          ⑭ 同参数再跑一次是幂等的
// 退出码：0 全过 / 1 有失败
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runRepair, classifyJsonl, repairBytes } from './echo-override-repair-blank.mjs';
import { computeSnapshotDigest, FORMAT as SNAPSHOT_FORMAT } from './echo-index-freeze.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const LF = String.fromCharCode(10);
const CRLF = String.fromCharCode(13) + LF;
const OVERRIDE_FORMAT = 'echo-snapshot-import-override/1';
const SOURCE_ROOT = 'D:/synthetic/echo-source';

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks += 1;
  if (cond) console.log('ok   ' + name);
  else { failures += 1; console.log('FAIL ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}
function codeOf(fn) {
  try { fn(); return null; } catch (e) { return (e && e.code) ? String(e.code) : 'THREW:' + String(e && e.message).slice(0, 80); }
}
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-repair-selftest-'));

const wordRow = (sid, seq) => JSON.stringify({ t: seq, session: sid, ws: 'w', seq, turn: 1, log: null, kind: 'chat', len: 3, truncated: false, text: 'abc' });
const sumRow = (sid) => JSON.stringify({ id: 's' + sid, t: 1, session: sid, ws: 'w', log: null, srcSeqs: [1], shadowedTokens: 0, chars: 3, provider: 'p', model: 'm', status: 'ok', summary: 'sum', manifest: '{}' });
const countRows = (buf) => {
  const text = buf.toString('utf8');
  const body = text.endsWith(LF) ? text.slice(0, -1) : text;
  if (body === '') return 0;
  return body.split(LF).filter((l) => l.trim() !== '').length;
};

// sources: [{ sid, variant, wordText, sumText?, nWord?, nSum?, orphanShards?: [{name, text}] }]
function buildSnapshot(caseName, sources) {
  const dir = path.join(ROOT, caseName, 'snap');
  const shardDir = path.join(dir, 'shards');
  fs.mkdirSync(shardDir, { recursive: true });
  const records = [];
  const filesLines = [];
  for (const s of sources) {
    const wName = s.sid + '.word.jsonl';
    const sName = s.sid + '.sum.jsonl';
    const wBytes = Buffer.from(s.wordText, 'utf8');
    const sBytes = Buffer.from(s.sumText === undefined ? '' : s.sumText, 'utf8');
    fs.writeFileSync(path.join(shardDir, wName), wBytes);
    fs.writeFileSync(path.join(shardDir, sName), sBytes);
    records.push({ path: 'shards/' + wName, role: 'shard', sha256: sha256(wBytes), bytes: wBytes.length });
    records.push({ path: 'shards/' + sName, role: 'shard', sha256: sha256(sBytes), bytes: sBytes.length });
    filesLines.push(JSON.stringify({
      file: SOURCE_ROOT + '/log/' + s.sid + '/session.v' + (s.variant === 'v3' ? '3' : '4') + '.jsonl',
      key: 'k-' + s.sid, nextByte: 0, ws: 'w', sid: s.sid,
      nSum: s.nSum === undefined ? countRows(sBytes) : s.nSum,
      nWord: s.nWord === undefined ? countRows(wBytes) : s.nWord,
      sumOut: SOURCE_ROOT + '/shards/' + sName,
      wordOut: SOURCE_ROOT + '/shards/' + wName,
    }));
  }
  for (const o of (sources.orphans || [])) {
    const b = Buffer.from(o.text, 'utf8');
    fs.writeFileSync(path.join(shardDir, o.name), b);
    records.push({ path: 'shards/' + o.name, role: 'shard', sha256: sha256(b), bytes: b.length });
  }
  const filesBytes = Buffer.from(filesLines.join(LF) + LF, 'utf8');
  fs.writeFileSync(path.join(dir, 'files.jsonl'), filesBytes);
  records.push({ path: 'files.jsonl', role: 'files', sha256: sha256(filesBytes), bytes: filesBytes.length });
  const empty = Buffer.from('', 'utf8');
  fs.writeFileSync(path.join(dir, 'words.jsonl'), empty);
  records.push({ path: 'words.jsonl', role: 'words', sha256: sha256(empty), bytes: 0 });
  fs.writeFileSync(path.join(dir, 'summaries.jsonl'), empty);
  records.push({ path: 'summaries.jsonl', role: 'summaries', sha256: sha256(empty), bytes: 0 });
  const manifest = {
    format: SNAPSHOT_FORMAT, sourceRoot: SOURCE_ROOT, fileCount: records.length,
    totalBytes: records.reduce((a, r) => a + r.bytes, 0), files: records,
    snapshotDigest: computeSnapshotDigest(records),
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return { dir, manifest };
}
function writeOverrideIn(caseName, entries, format) {
  const p = path.join(ROOT, caseName, 'override-in.json');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ format: format || OVERRIDE_FORMAT, entries: entries || [] }), 'utf8');
  return p;
}
function outPaths(caseName) {
  const base = path.join(ROOT, caseName);
  const outDir = path.join(base, 'repaired');
  return { outDir, outOverride: path.join(base, 'rebuilt', 'override-2.json') };
}
// 每个用例都先把输出目录的父目录建好（工具要求 --out-override 的父目录已存在）
function prepOut(caseName) {
  const o = outPaths(caseName);
  fs.mkdirSync(path.dirname(o.outOverride), { recursive: true });
  return o;
}
function snapshotHashes(dir) {
  const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  const m = new Map();
  for (const r of man.files) m.set(r.path, sha256(fs.readFileSync(path.join(dir, r.path.split('/').join(path.sep)))));
  return m;
}

const S = 'src-a';
const R1 = wordRow(S, 1);
const R2 = wordRow(S, 2);

// ① 首行空行 + 末行没有 LF
{
  const { dir } = buildSnapshot('c1', [{ sid: S, variant: 'v4', wordText: LF + R1 + LF + R2 }]);
  const before = snapshotHashes(dir);
  const o = prepOut('c1');
  const ovIn = writeOverrideIn('c1');
  const rep = runRepair({ snapshotDir: dir, overrideIn: ovIn, outDir: o.outDir, outOverride: o.outOverride });
  check('① repairedShards = 1', rep.repairedShards === 1, rep.repairedShards);
  const one = rep.repaired[0];
  check('① blank lines removed = 1', one.blankLinesRemoved === 1, one.blankLinesRemoved);
  check('① rows = 2', one.rows === 2, one.rows);
  check('① finalLf stays false', one.finalLf === false, one.finalLf);
  const written = fs.readFileSync(path.join(o.outDir, one.file));
  check('① every other byte identical', written.equals(Buffer.from(R1 + LF + R2, 'utf8')), written.toString('utf8').length);
  check('① repaired name = first 16 hex of original sha', one.file === 'repaired-' + one.originalSha256.slice(0, 16) + '.jsonl', one.file);
  const ov = JSON.parse(fs.readFileSync(o.outOverride, 'utf8'));
  check('① override entries 0 -> 1', rep.overrideInEntries === 0 && rep.overrideOutEntries === 1 && ov.entries.length === 1);
  const e = ov.entries[0];
  check('① entry field set exact', Object.keys(e).sort().join(',') === ['variant', 'sidSha256', 'wordFile', 'sumFile', 'wordSha256', 'sumSha256', 'wordRows', 'sumRows'].sort().join(','));
  check('① entry variant v4', e.variant === 'v4', e.variant);
  check('① entry sidSha256 = sha256(sid)', e.sidSha256 === sha256(Buffer.from(S, 'utf8')));
  check('① entry wordRows 2 / sumRows 0', e.wordRows === 2 && e.sumRows === 0, { w: e.wordRows, s: e.sumRows });
  check('① entry wordSha256 = repaired sha', e.wordSha256 === sha256(written));
  check('① entry sumSha256 = empty sha', e.sumSha256 === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', e.sumSha256);
  const after = snapshotHashes(dir);
  let same = before.size === after.size;
  for (const [k, v] of before) if (after.get(k) !== v) same = false;
  check('① snapshot bytes unchanged', same);
  // ⑭ 幂等：同参数再跑一次
  const rep2 = runRepair({ snapshotDir: dir, overrideIn: ovIn, outDir: o.outDir, outOverride: o.outOverride });
  check('⑭ second run idempotent (no new write)', rep2.repairedShards === 1 && rep2.repaired[0].existedIdentical === true && rep2.overrideOutWrote === false, { e: rep2.repaired[0].existedIdentical, o: rep2.overrideOutWrote });
}

// ② 中间空行 + 末行有 LF
{
  const { dir } = buildSnapshot('c2', [{ sid: S, variant: 'v3', wordText: R1 + LF + LF + R2 + LF }]);
  const o = prepOut('c2');
  const rep = runRepair({ snapshotDir: dir, overrideIn: writeOverrideIn('c2'), outDir: o.outDir, outOverride: o.outOverride });
  const one = rep.repaired[0];
  const written = fs.readFileSync(path.join(o.outDir, one.file));
  check('② blank middle line repaired', rep.repairedShards === 1 && one.blankLinesRemoved === 1, rep.repairedShards);
  check('② final LF kept', one.finalLf === true && written.equals(Buffer.from(R1 + LF + R2 + LF, 'utf8')));
  check('② variant v3', JSON.parse(fs.readFileSync(o.outOverride, 'utf8')).entries[0].variant === 'v3');
}

// ③ 没有空行：不该修、不该造条目
{
  const { dir } = buildSnapshot('c3', [{ sid: S, variant: 'v4', wordText: R1 + LF + R2 + LF }]);
  const o = prepOut('c3');
  const rep = runRepair({ snapshotDir: dir, overrideIn: writeOverrideIn('c3'), outDir: o.outDir, outOverride: o.outOverride });
  check('③ no blank line -> nothing repaired', rep.blankShardsFound === 0 && rep.repairedShards === 0, rep.blankShardsFound);
  check('③ override still 0 entries', rep.overrideOutEntries === 0 && JSON.parse(fs.readFileSync(o.outOverride, 'utf8')).entries.length === 0);
  check('③ shards were still scanned', rep.shardsScanned === 2, rep.shardsScanned);
}

// ④ CRLF 空行
{
  const { dir } = buildSnapshot('c4', [{ sid: S, variant: 'v4', wordText: R1 + CRLF + CRLF + R2 + CRLF }]);
  const o = prepOut('c4');
  const rep = runRepair({ snapshotDir: dir, overrideIn: writeOverrideIn('c4'), outDir: o.outDir, outOverride: o.outOverride });
  const one = rep.repaired[0];
  const written = fs.readFileSync(path.join(o.outDir, one.file));
  check('④ CRLF blank line repaired', rep.repairedShards === 1 && one.blankLinesRemoved === 1, one && one.blankLinesRemoved);
  check('④ CRLF line endings preserved byte for byte', written.equals(Buffer.from(R1 + CRLF + R2 + CRLF, 'utf8')), written.length);
}

// ⑤ 空行 + 坏行 -> 拒
{
  const { dir } = buildSnapshot('c5', [{ sid: S, variant: 'v4', wordText: R1 + LF + '{oops' + LF + LF + R2 + LF }]);
  const o = prepOut('c5');
  const code = codeOf(() => runRepair({ snapshotDir: dir, overrideIn: writeOverrideIn('c5'), outDir: o.outDir, outOverride: o.outOverride }));
  check('⑤ BLANK_SHARD_INVALID_JSON', code === 'BLANK_SHARD_INVALID_JSON', code);
  check('⑤ nothing written on refusal', !fs.existsSync(o.outOverride) && !fs.existsSync(o.outDir));
}

// ⑥ 超过 5 个分片 -> 拒
{
  const sources = [];
  for (let i = 0; i < 6; i += 1) sources.push({ sid: 'src-' + i, variant: 'v4', wordText: LF + wordRow('src-' + i, 1) + LF });
  const { dir } = buildSnapshot('c6', sources);
  const o = prepOut('c6');
  const code = codeOf(() => runRepair({ snapshotDir: dir, overrideIn: writeOverrideIn('c6'), outDir: o.outDir, outOverride: o.outOverride }));
  check('⑥ TOO_MANY_BLANK_SHARDS', code === 'TOO_MANY_BLANK_SHARDS', code);
}

// ⑦ 另一侧分片被两行共享 -> 拒
{
  const dir = path.join(ROOT, 'c7', 'snap');
  const shardDir = path.join(dir, 'shards');
  fs.mkdirSync(shardDir, { recursive: true });
  const aW = Buffer.from(LF + wordRow(S, 1) + LF + wordRow(S, 2), 'utf8');
  const bW = Buffer.from(wordRow('src-b', 1) + LF, 'utf8');
  const sharedSum = Buffer.from(sumRow(S) + LF, 'utf8');
  fs.writeFileSync(path.join(shardDir, S + '.word.jsonl'), aW);
  fs.writeFileSync(path.join(shardDir, 'src-b.word.jsonl'), bW);
  fs.writeFileSync(path.join(shardDir, 'shared.sum.jsonl'), sharedSum);
  const records = [
    { path: 'shards/' + S + '.word.jsonl', role: 'shard', sha256: sha256(aW), bytes: aW.length },
    { path: 'shards/src-b.word.jsonl', role: 'shard', sha256: sha256(bW), bytes: bW.length },
    { path: 'shards/shared.sum.jsonl', role: 'shard', sha256: sha256(sharedSum), bytes: sharedSum.length },
  ];
  const rowA = { file: SOURCE_ROOT + '/log/' + S + '/session.v4.jsonl', key: 'k-a', nextByte: 0, ws: 'w', sid: S, nSum: 1, nWord: 2, sumOut: SOURCE_ROOT + '/shards/shared.sum.jsonl', wordOut: SOURCE_ROOT + '/shards/' + S + '.word.jsonl' };
  const rowB = { file: SOURCE_ROOT + '/log/src-b/session.v3.jsonl', key: 'k-b', nextByte: 0, ws: 'w', sid: 'src-b', nSum: 1, nWord: 1, sumOut: SOURCE_ROOT + '/shards/shared.sum.jsonl', wordOut: SOURCE_ROOT + '/shards/src-b.word.jsonl' };
  const filesBytes = Buffer.from(JSON.stringify(rowA) + LF + JSON.stringify(rowB) + LF, 'utf8');
  fs.writeFileSync(path.join(dir, 'files.jsonl'), filesBytes);
  records.push({ path: 'files.jsonl', role: 'files', sha256: sha256(filesBytes), bytes: filesBytes.length });
  const empty = Buffer.from('', 'utf8');
  fs.writeFileSync(path.join(dir, 'words.jsonl'), empty);
  records.push({ path: 'words.jsonl', role: 'words', sha256: sha256(empty), bytes: 0 });
  fs.writeFileSync(path.join(dir, 'summaries.jsonl'), empty);
  records.push({ path: 'summaries.jsonl', role: 'summaries', sha256: sha256(empty), bytes: 0 });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ format: SNAPSHOT_FORMAT, sourceRoot: SOURCE_ROOT, fileCount: records.length, totalBytes: records.reduce((a, r) => a + r.bytes, 0), files: records, snapshotDigest: computeSnapshotDigest(records) }), 'utf8');
  const o = prepOut('c7');
  const code = codeOf(() => runRepair({ snapshotDir: dir, overrideIn: writeOverrideIn('c7'), outDir: o.outDir, outOverride: o.outOverride }));
  check('⑦ REPAIR_OTHER_SIDE_SHARED', code === 'REPAIR_OTHER_SIDE_SHARED', code);
}

// ⑧ override-in 格式错 -> 拒
{
  const { dir } = buildSnapshot('c8', [{ sid: S, variant: 'v4', wordText: LF + R1 + LF + R2 }]);
  const o = prepOut('c8');
  const code = codeOf(() => runRepair({ snapshotDir: dir, overrideIn: writeOverrideIn('c8', [], 'wrong/9'), outDir: o.outDir, outOverride: o.outOverride }));
  check('⑧ OVERRIDE_IN_INVALID', code === 'OVERRIDE_IN_INVALID', code);
}

// ⑨ manifest digest 不符 -> 拒
{
  const { dir, manifest } = buildSnapshot('c9', [{ sid: S, variant: 'v4', wordText: LF + R1 + LF + R2 }]);
  manifest.snapshotDigest = sha256(Buffer.from('tampered', 'utf8'));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  const o = prepOut('c9');
  const code = codeOf(() => runRepair({ snapshotDir: dir, overrideIn: writeOverrideIn('c9'), outDir: o.outDir, outOverride: o.outOverride }));
  check('⑨ SNAPSHOT_DIGEST_MISMATCH', code === 'SNAPSHOT_DIGEST_MISMATCH', code);
}

// ⑩ 分片没有主人 -> 拒
{
  const b = buildSnapshot('c10', [{ sid: S, variant: 'v4', wordText: LF + R1 + LF + R2 }]);
  const orphan = Buffer.from(LF + wordRow('src-x', 1) + LF, 'utf8');
  fs.writeFileSync(path.join(b.dir, 'shards', 'orphan.word.jsonl'), orphan);
  const man = JSON.parse(fs.readFileSync(path.join(b.dir, 'manifest.json'), 'utf8'));
  man.files.push({ path: 'shards/orphan.word.jsonl', role: 'shard', sha256: sha256(orphan), bytes: orphan.length });
  man.fileCount = man.files.length;
  man.totalBytes = man.files.reduce((a, r) => a + r.bytes, 0);
  man.snapshotDigest = computeSnapshotDigest(man.files);
  fs.writeFileSync(path.join(b.dir, 'manifest.json'), JSON.stringify(man), 'utf8');
  const o = prepOut('c10');
  const code = codeOf(() => runRepair({ snapshotDir: b.dir, overrideIn: writeOverrideIn('c10'), outDir: o.outDir, outOverride: o.outOverride }));
  check('⑩ REPAIR_OWNER_MISSING', code === 'REPAIR_OWNER_MISSING', code);
}

// ⑪ 落点落在快照内 -> 拒
{
  const { dir } = buildSnapshot('c11', [{ sid: S, variant: 'v4', wordText: LF + R1 + LF + R2 }]);
  prepOut('c11');
  const code = codeOf(() => runRepair({ snapshotDir: dir, overrideIn: writeOverrideIn('c11'), outDir: path.join(dir, 'inside'), outOverride: outPaths('c11').outOverride }));
  check('⑪ OUT_INSIDE_SNAPSHOT', code === 'OUT_INSIDE_SNAPSHOT', code);
}

// ⑫ override 里已有同一 (variant, sid hash) -> 拒
{
  const { dir } = buildSnapshot('c12', [{ sid: S, variant: 'v4', wordText: LF + R1 + LF + R2 }]);
  const o = prepOut('c12');
  const pre = [{ variant: 'v4', sidSha256: sha256(Buffer.from(S, 'utf8')), wordFile: 'x', sumFile: 'y', wordSha256: sha256(Buffer.from('a')), sumSha256: sha256(Buffer.from('b')), wordRows: 0, sumRows: 0 }];
  const code = codeOf(() => runRepair({ snapshotDir: dir, overrideIn: writeOverrideIn('c12', pre), outDir: o.outDir, outOverride: o.outOverride }));
  check('⑫ OVERRIDE_DUPLICATE_ENTRY', code === 'OVERRIDE_DUPLICATE_ENTRY', code);
}

// 纯函数：classifyJsonl + repairBytes 的四种形状
{
  const kind = (text) => {
    const b = Buffer.from(text, 'utf8');
    const cls = classifyJsonl(b);
    return { blanks: cls.blankLines.length, invalid: cls.invalidLines.length, valid: cls.valid, out: repairBytes(cls).toString('utf8') };
  };
  const first = kind(LF + R1 + LF + R2);
  check('fn blank-first shape', first.blanks === 1 && first.invalid === 0 && first.valid === 2 && first.out === R1 + LF + R2, first);
  const mid = kind(R1 + LF + LF + R2 + LF);
  check('fn blank-middle shape', mid.blanks === 1 && mid.valid === 2 && mid.out === R1 + LF + R2 + LF, mid);
  const none = kind(R1 + LF + R2 + LF);
  check('fn no-blank shape', none.blanks === 0 && none.out === R1 + LF + R2 + LF, none);
  const crlf = kind(R1 + CRLF + CRLF + R2 + CRLF);
  check('fn CRLF shape', crlf.blanks === 1 && crlf.out === R1 + CRLF + R2 + CRLF, crlf);
}

console.log('');
console.log('checks=' + checks + ' failures=' + failures);
process.exitCode = failures === 0 ? 0 : 1;
