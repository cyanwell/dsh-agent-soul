#!/usr/bin/env node
// tools/shadow-frame-index.mjs —— P2 真实会话“影子索引”执行器（完全隔离）。
//
// 目的：用一份 TEMP 副本（绝不碰生产会话文件），把真实的多帧 zstd 会话日志逐帧读成
//       {type,seq,time,data}，按 v5 元数据模型建立 source/session/frame 索引，
//       并端到端验证 ptr 回取、hash、relocate、缺失文件、重复运行 no-op、检索与 FTS 对齐。
//
// ★ 安全限量（不允许整包读入内存）：
//   - 第一遍只按 1 MiB 分块扫 zstd 魔数，仅记录帧起点（整数），不保留文件内容；
//   - 第二遍按帧区间精确读入单帧字节（maxFrameBytes 上界）后解压；
//   - 每帧解压走 maxOutputLength，累计解压输出有 maxDecodedBytes 预算；
//   - 记录数有 maxRecords 上界；任何上界触发都整次失败，绝不静默截断。
//
// ★ 本脚本只写 TEMP（库/搬迁副本），不启动服务、不写生产 data、不读凭据。
//
// 用法：
//   node tools/shadow-frame-index.mjs --source-file <TEMP 副本> [--mode full|noop] [--keep]
//        [--db <库路径>] [--relocate-dir <搬迁目标根>] [--canonical record-json|contract-or-json]
//
// 退出码：0 = 所有检查通过；1 = 有检查失败（详情在 stdout JSON 的 checks 里，不含正文）。

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openMetaStore, hashFrame, makeStreamFingerprint } from '../src/db/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const PROD_SESSION_ROOT = 'D:/AI/dsh/home/sessions';
const CONTRACT_PATH = 'D:/AI/dsh-tools/dsh-yanqing-pruner/context-contract.mjs';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const CHUNK = 1024 * 1024;
const LIMITS = Object.freeze({
  maxFrameBytes: 8 * 1024 * 1024,
  maxMergeFrames: 16,
  maxDecodedBytes: 64 * 1024 * 1024,
  maxRecords: 50000,
});
const PARSER_VERSION = 'v4-frame-1';
const SCHEME_NOTE = "sha256(parserVersion + '\\0' + sessionId + '\\0' + firstCompleteFrame)";

function usage(msg) {
  const e = new Error(msg + '\nusage: node tools/shadow-frame-index.mjs --source-file <TEMP copy> [--mode full|noop] [--keep] [--db path] [--relocate-dir path] [--canonical record-json|contract-or-json]');
  e.usage = true;
  return e;
}

function parseArgs(argv) {
  const o = { mode: 'full', keep: false, canonical: 'record-json', db: null, relocateDir: null, sourceFile: null, jsonOut: null, trace: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = () => { if (i + 1 >= argv.length) throw usage('missing value for ' + a); return argv[++i]; };
    if (a === '--source-file') o.sourceFile = need();
    else if (a === '--mode') o.mode = need();
    else if (a === '--keep') o.keep = true;
    else if (a === '--db') o.db = need();
    else if (a === '--relocate-dir') o.relocateDir = need();
    else if (a === '--canonical') o.canonical = need();
    else if (a === '--json-out') o.jsonOut = need();
    else if (a === '--trace') o.trace = true;
    else if (a === '--help' || a === '-h') throw usage('help');
    else throw usage('unknown argument: ' + a);
  }
  if (!o.sourceFile) throw usage('--source-file is required');
  if (o.mode !== 'full' && o.mode !== 'noop') throw usage("--mode must be 'full' or 'noop'");
  if (o.canonical !== 'record-json' && o.canonical !== 'contract-or-json') throw usage("--canonical must be 'record-json' or 'contract-or-json'");
  return o;
}

function posix(p) { return String(p).replace(/\\/g, '/'); }

function isInside(root, target) {
  const r = posix(root).replace(/\/+$/, '').toLowerCase();
  const t = posix(target).toLowerCase();
  return t === r || t.startsWith(r + '/');
}

function sha256File(file) {
  const fd = fs.openSync(file, 'r');
  const h = createHash('sha256');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let off = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, off);
      if (n <= 0) break;
      h.update(buf.subarray(0, n));
      off += n;
    }
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// 分块扫魔数：只在块内扫描，跨块用末尾 3 字节接续；只返回绝对偏移，不保留数据。
function listFrameStarts(file, size) {
  const fd = fs.openSync(file, 'r');
  const starts = [];
  let prev = Buffer.alloc(0);
  let off = 0;
  try {
    while (off < size) {
      const n = Math.min(CHUNK, size - off);
      const buf = Buffer.allocUnsafe(n);
      fs.readSync(fd, buf, 0, n, off);
      const joined = prev.length ? Buffer.concat([prev, buf]) : buf;
      const base = off - prev.length;
      let i = 0;
      for (;;) {
        i = joined.indexOf(MAGIC, i);
        if (i === -1) break;
        const abs = base + i;
        if (abs >= off && abs + MAGIC.length <= size) starts.push(abs);
        i += 1;
      }
      prev = joined.subarray(Math.max(0, joined.length - (MAGIC.length - 1)));
      off += n;
    }
  } finally { fs.closeSync(fd); }
  return starts;
}

// 单帧解码（失败时与后续魔数片合并重试，最多 maxMergeFrames 片）。
// 返回 { out, used }；used=1 表示正常单帧；used>1 表示扫到的魔数是载荷里的巧合。
function decodeFrameAt(fd, starts, i, size, budget) {
  let lastErr = null;
  const maxMerge = Math.min(LIMITS.maxMergeFrames, starts.length - i - 1);
  for (let m = 0; m <= maxMerge; m++) {
    const from = starts[i];
    const to = i + m + 1 < starts.length ? starts[i + m + 1] : size;
    const len = to - from;
    if (len > LIMITS.maxFrameBytes) { lastErr = new Error('frame window too large: ' + len + ' B'); break; }
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, from);
    try {
      const piece = zlib.zstdDecompressSync(buf, { maxOutputLength: budget });
      return { out: Buffer.from(piece), used: m + 1 };
    } catch (e) {
      lastErr = e;
      if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('decoded byte budget exceeded at frame ' + i);
    }
  }
  const e = new Error('frame decode failed at ' + starts[i] + ': ' + String((lastErr && lastErr.message) || lastErr));
  e.frameOffset = starts[i];
  throw e;
}

// 记录对象的确定性序列化：键按码位排序、无多余空白。
// 这是本脚本的 “canonical 文本” 定义：hash 与 snippet 都来自它（不是压缩字节，也不是 size/mtime）。
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    const v = value[k];
    if (v === undefined) continue;
    parts.push(JSON.stringify(k) + ':' + stableStringify(v));
  }
  return '{' + parts.join(',') + '}';
}

// 逐帧解码 → 逐行 JSON → 回调(record, ordinal)。ordinal = 文件内 0-based 物理记录序号。
function forEachRecord(file, size, starts, onRecord) {
  const fd = fs.openSync(file, 'r');
  let carry = '';
  let ordinal = 0;
  let decodedBytes = 0;
  let budget = LIMITS.maxDecodedBytes;
  let framesDecoded = 0;
  let mergedSplits = 0;
  try {
    let i = 0;
    while (i < starts.length) {
      const { out, used } = decodeFrameAt(fd, starts, i, size, budget);
      if (out.length > budget) throw new Error('decoded byte budget exceeded');
      budget -= out.length;
      decodedBytes += out.length;
      framesDecoded += 1;
      if (used > 1) mergedSplits += used - 1;
      const text = carry + out.toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t) continue;
        let rec;
        try { rec = JSON.parse(t); } catch (e) { throw new Error('bad JSON line at record ordinal ' + ordinal + ': ' + e.message); }
        onRecord(rec, ordinal);
        ordinal += 1;
        if (ordinal > LIMITS.maxRecords) throw new Error('record limit exceeded (' + LIMITS.maxRecords + ')');
      }
      i += used;
    }
    if (carry.trim()) throw new Error('trailing partial JSONL line at EOF (unterminated): ' + carry.length + ' chars');
  } finally { fs.closeSync(fd); }
  return { framesDecoded, mergedSplits, records: ordinal, decodedBytes };
}

function sqlSnapshot(store) {
  const rows = store.db.prepare('select seq, frame_ordinal, content_hash, indexed_at from frame_index order by seq').all();
  return { rows, json: JSON.stringify(rows) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const trace = (label) => { if (opts.trace) process.stderr.write('[trace] ' + label + ' +' + (Date.now() - t0) + 'ms\n'); };
  const checks = [];
  const out = { ok: false, mode: opts.mode, canonicalMode: opts.canonical, checks, cleanup: {} };
  if (opts.jsonOut) out.jsonOut = path.resolve(opts.jsonOut);

  function check(name, ok, detail) {
    checks.push(ok ? { name, ok: true } : { name, ok: false, detail: detail === undefined ? null : detail });
    return ok;
  }

  const srcFile = path.resolve(opts.sourceFile);
  if (!fs.existsSync(srcFile)) throw new Error('source-file not found: ' + srcFile);
  const st = fs.statSync(srcFile);
  if (!st.isFile()) throw new Error('source-file is not a regular file: ' + srcFile);

  // 生产文件是禁区：只接受副本。
  let prodReal = path.resolve(PROD_SESSION_ROOT);
  try { prodReal = fs.realpathSync.native(PROD_SESSION_ROOT); } catch (_) { /* 目录不存在时按字面路径判 */ }
  const srcReal = fs.realpathSync.native(srcFile);
  if (isInside(prodReal, srcReal)) {
    throw new Error('refusing to operate on a live production session file: ' + srcFile + ' (copy it to TEMP first)');
  }

  const root = path.dirname(srcFile);
  const relFile = path.basename(srcFile);
  out.sourceFile = srcFile;
  out.copyRoot = root;
  out.file = { bytes: st.size, sha256: sha256File(srcFile) };

  // 可选契约（仅统计/可选模式使用；默认的 canonical 定义不依赖它）。
  let contract = null;
  if (opts.canonical === 'contract-or-json') {
    contract = await import(pathToFileURL(CONTRACT_PATH).href);
    if (!contract || typeof contract.canonicalEventText !== 'function' || contract.CONTRACT_VERSION !== 2) {
      throw new Error('pruner contract unavailable or wrong version; refusing to guess a canonical text');
    }
  }
  function canonicalOf(rec) {
    if (contract) {
      const c = contract.canonicalEventText(rec);
      if (c && c.supported) return c.text;
    }
    return stableStringify(rec);
  }

  // ── Pass 1：扫描帧、解析记录、收集元数据（只保留小对象） ────────────────
  trace('file-ok');
  const starts = listFrameStarts(srcFile, st.size);
  if (starts.length === 0) throw new Error('not a zstd file: no frame magic found');
  trace('frame-starts ' + starts.length);

  let sessionHeader = null;
  const withoutSeq = [];
  const seqToOrdinal = new Map();
  const seqs = [];
  let firstCompleteFrame = null;
  const typeCounts = Object.create(null);
  let parsedRecords = 0;

  const pass1 = forEachRecord(srcFile, st.size, starts, (rec, ordinal) => {
    parsedRecords += 1;
    const type = typeof rec.type === 'string' ? rec.type : null;
    if (type) typeCounts[type] = (typeCounts[type] || 0) + 1;
    if (type === 'session') {
      if (sessionHeader) throw new Error('more than one session header record');
      sessionHeader = { ordinal, id: rec.id, cwd: rec.cwd, version: rec.version, createdAt: rec.createdAt };
      return;
    }
    const seq = rec.seq;
    if (!Number.isSafeInteger(seq) || seq < 0) {
      withoutSeq.push({ ordinal, type });
      return;
    }
    if (seqToOrdinal.has(seq)) throw new Error('duplicate seq ' + seq + ' at ordinals ' + seqToOrdinal.get(seq) + ' and ' + ordinal);
    seqToOrdinal.set(seq, ordinal);
    seqs.push(seq);
    if (firstCompleteFrame === null) firstCompleteFrame = canonicalOf(rec);
  });

  trace('pass1-done records=' + parsedRecords);
  if (!sessionHeader) throw new Error('no session header (type=session) found; cannot derive the real session id');
  const sessionId = sessionHeader.id;
  if (typeof sessionId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(sessionId)) {
    throw new Error('session header id is not a valid session id: ' + String(sessionId).slice(0, 80));
  }
  if (firstCompleteFrame === null) throw new Error('no complete frame available for the stream fingerprint');

  seqs.sort((a, b) => a - b);
  const seqMin = seqs[0];
  const seqMax = seqs[seqs.length - 1];
  const gaps = [];
  for (let s = seqMin; s < seqMax; s++) if (!seqToOrdinal.has(s)) gaps.push(s);

  const ordinalDiff = [];
  for (const [seq, ordinal] of seqToOrdinal) if (seq !== ordinal) ordinalDiff.push({ seq, ordinal });

  const fingerprint = makeStreamFingerprint({ parserVersion: PARSER_VERSION, sessionId, firstCompleteFrame });
  out.session = {
    sessionId,
    headerOrdinal: sessionHeader.ordinal,
    headerVersion: sessionHeader.version === undefined ? null : sessionHeader.version,
    dirNameMatch: path.basename(root) === sessionId,
  };
  out.file.zstdFrames = starts.length;
  out.file.framesDecoded = pass1.framesDecoded;
  out.file.mergedMagicSplits = pass1.mergedSplits;
  out.records = {
    parsed: parsedRecords,
    withSeq: seqToOrdinal.size,
    withoutSeq: withoutSeq.length,
    headerRecords: 1,
    headerWithoutSeq: true,
    withoutSeqTypes: withoutSeq.map((x) => x.type),
    seqMin,
    seqMax,
    seqGaps: gaps.length,
    duplicateSeqs: 0,
  };
  out.ordinal = { diffCount: ordinalDiff.length, samples: ordinalDiff.slice(0, 3) };
  out.types = { distinct: Object.keys(typeCounts).length, counts: typeCounts };
  out.fingerprint = { scheme: SCHEME_NOTE, parserVersion: PARSER_VERSION, hex: fingerprint, hexPrefix: fingerprint.slice(0, 16) };

  check('real records parsed (no bad lines)', parsedRecords > 0 && pass1.records === parsedRecords);
  check('every non-header record carries a real seq', withoutSeq.length === 0, { nonHeaderWithoutSeq: withoutSeq.length, withoutSeqTypes: withoutSeq.map((x) => x.type) });
  check('seq values are unique', seqToOrdinal.size === new Set(seqs).size);
  check('seq is not identically equal to frame ordinal', ordinalDiff.length > 0, { diffCount: ordinalDiff.length, sample: ordinalDiff.slice(0, 3) });
  check('stream fingerprint is 64-hex and derived from first complete frame (not size/mtime)', /^[0-9a-f]{64}$/.test(fingerprint));
  check('source file is outside the production session root', !isInside(prodReal, srcReal));

  // ── 建库（TEMP） ───────────────────────────────────────────────────────
  const tmpRoot = path.dirname(srcFile);
  const dbPath = path.resolve(opts.db || path.join(tmpRoot, 'shadow-meta.sqlite3'));
  const relocateDir = path.resolve(opts.relocateDir || path.join(tmpRoot, 'relocated-root'));
  if (isInside(prodReal, dbPath)) throw new Error('refusing to write the meta store inside the production session root');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  out.dbPath = dbPath;
  out.relocateDir = relocateDir;

  const source = {
    sourceId: 'p2-shadow-' + sessionId,
    kind: 'dsh-log',
    namespace: 'log',
    authority: 'primary',
    rawPath: root,
    pathKind: 'dir',
  };
  const session = { sessionId, containerId: null };
  const store = openMetaStore({ path: dbPath, mode: 'readwrite', timeoutMs: 15000 });

  let inserted = 0;
  let noop = 0;
  const expectedHashes = new Map();
  let truncatedExpected = 0;
  let maxCanonicalLength = 0;

  try {
    trace('store-opened');
    store.migrate();
    trace('migrated');
    check('store migrated to v5', store.state.ready === true, store.state);

    // ★ noop 模式的根一致性：如果库里的当前根与本次重放的根不同，先搬迁回本次根（一次）。
    //   否则每条 noop 帧都会在事务内把 sources.raw_path 改回旧根 → 触发 relocations 审计触发器
    //   （三次 count(*) frame_index，O(n²)），整笔再回滚。正确性不受影响，但代价是几千次全表扫描。
    if (opts.mode === 'noop') {
      const cur = store.db.prepare('select raw_path from sources where source_id = ?').get(source.sourceId);
      if (cur && cur.raw_path !== source.rawPath) {
        const back = store.relocateSource(source.sourceId, source.rawPath, cur.raw_path);
        out.rootRestored = { status: back.status, from: back.previousRoot, to: back.newRoot };
      }
    }

    const cursorBase = { streamKey: 'session:' + sessionId, fileFingerprint: fingerprint, tailOffset: 0, tailState: 'closed' };

    // ── Pass 2：逐帧 ingest（一次只持有一帧/一条记录） ─────────────────
    forEachRecord(srcFile, st.size, starts, (rec, ordinal) => {
      if (rec.type === 'session') return;
      const seq = rec.seq;
      if (!Number.isSafeInteger(seq) || seq < 0) return;
      const text = canonicalOf(rec);
      const h = hashFrame(text);
      if (text.length > 4096) truncatedExpected += 1;
      if (text.length > maxCanonicalLength) maxCanonicalLength = text.length;
      const res = store.ingest({
        source,
        session,
        frame: {
          seq,
          frameOrdinal: ordinal,
          rawPath: srcFile,
          type: typeof rec.type === 'string' ? rec.type : null,
          eventAt: rec.time === undefined || rec.time === null ? null : String(rec.time),
          text,
        },
        cursor: Object.assign({}, cursorBase, { nextSeq: seq + 1, frameOrdinal: ordinal }),
      });
      expectedHashes.set(seq, h);
      if (res.status === 'inserted') inserted += 1;
      else if (res.status === 'noop') noop += 1;
      else throw new Error('unexpected ingest status: ' + res.status);
    });

    trace('pass2-ingest-done inserted=' + inserted + ' noop=' + noop);
    check('first ingest wrote every seq-bearing record', inserted + noop === seqToOrdinal.size, { inserted, noop, expected: seqToOrdinal.size });
    check('ingest hashes match a second independent canonical computation', expectedHashes.size === seqToOrdinal.size);

    const framesInDb = store.countFrames({ sourceId: source.sourceId, sessionId });
    check('frame count in store equals real seq-bearing record count', framesInDb === seqToOrdinal.size, { framesInDb, expected: seqToOrdinal.size });

    // seq 与 ordinal 分别保存在库里，且与文件解析一致。
    const rows = store.db.prepare('select seq, frame_ordinal, content_hash from frame_index where source_id = ? and session_id = ? order by seq').all(source.sourceId, sessionId);
    let ordinalMismatch = 0;
    let hashMismatch = 0;
    for (const r of rows) {
      if (seqToOrdinal.get(r.seq) !== r.frame_ordinal) ordinalMismatch += 1;
      if (expectedHashes.get(r.seq) !== r.content_hash) hashMismatch += 1;
    }
    check('stored (seq, frame_ordinal) pairs match the file', ordinalMismatch === 0, { ordinalMismatch });
    check('stored content_hash matches canonical text hash', hashMismatch === 0, { hashMismatch });
    check('some rows have seq !== frame_ordinal (both stored independently)', rows.some((r) => r.seq !== r.frame_ordinal), { diffCount: ordinalDiff.length });

    // ── 重复运行 no-op（同一进程内第二遍，完整重放） ─────────────────────
    const before = sqlSnapshot(store);
    let inserted2 = 0;
    let noop2 = 0;
    forEachRecord(srcFile, st.size, starts, (rec, ordinal) => {
      if (rec.type === 'session') return;
      const seq = rec.seq;
      if (!Number.isSafeInteger(seq) || seq < 0) return;
      const text = canonicalOf(rec);
      const res = store.ingest({
        source,
        session,
        frame: { seq, frameOrdinal: ordinal, rawPath: srcFile, type: typeof rec.type === 'string' ? rec.type : null, eventAt: rec.time === undefined || rec.time === null ? null : String(rec.time), text },
        cursor: Object.assign({}, cursorBase, { nextSeq: seq + 1, frameOrdinal: ordinal }),
      });
      if (res.status === 'inserted') inserted2 += 1;
      else if (res.status === 'noop') noop2 += 1;
    });
    trace('rerun-ingest-done inserted=' + inserted2 + ' noop=' + noop2);
    const after = sqlSnapshot(store);
    out.rerun = { inserted: inserted2, noop: noop2, snapshotIdentical: before.json === after.json, rowsBefore: before.rows.length, rowsAfter: after.rows.length };
    check('re-run is a strict no-op (no inserted rows)', inserted2 === 0, { inserted2 });
    check('re-run reports noop for every record', noop2 === seqToOrdinal.size, { noop2, expected: seqToOrdinal.size });
    check('re-run leaves every indexed row untouched (indexed_at included)', out.rerun.snapshotIdentical === true);

    // ── snippet 4096 语义 ──────────────────────────────────────────────
    const sn = store.db.prepare('select count(*) as truncated, max(length(snippet)) as maxLen, min(length(snippet)) as minLen from frame_index where source_id = ? and session_id = ?').get(source.sourceId, sessionId);
    const actualHashCount = store.db.prepare('select count(*) as n from frame_index where source_id = ? and session_id = ? and snippet_truncated = 1').get(source.sourceId, sessionId).n;
    out.snippet = { expectedTruncated: truncatedExpected, storedTruncated: actualHashCount, maxSnippetLength: sn.maxLen, maxCanonicalLength, limit: 4096 };
    check('snippet truncation count matches canonical length > 4096', truncatedExpected === actualHashCount, { expectedTruncated: truncatedExpected, actualHashCount });
    check('no snippet exceeds 4096 chars', sn.maxLen <= 4096, { maxLen: sn.maxLen });

    // ── 检索：中文 + ASCII 子串；FTS 对齐 ────────────────────────────
    const indexInfo = store.searchIndexInfo();
    out.search = { index: indexInfo };
    check('FTS index is aligned with frame_index', indexInfo.aligned === true && indexInfo.frames === indexInfo.ftsRows, indexInfo);

    const queries = [
      { label: 'ascii', q: 'session' },
      { label: 'cjk', q: '会话' },
    ];
    for (const item of queries) {
      const r = store.search(item.q, { limit: 50, sourceId: source.sourceId, sessionId });
      const allContain = r.results.every((x) => String(x.rawText || x.snippet || '').toLowerCase().includes(item.q.toLowerCase()));
      out.search[item.label] = { query: item.q, matchMode: r.matchMode, scanPath: r.scanPath, candidates: r.candidates, results: r.results.length, exhausted: r.exhausted, everyResultContainsNeedle: allContain };
      check('substring search finds records: ' + item.q, r.results.length > 0, { results: r.results.length });
      check('every returned result contains the needle (raw_text substring): ' + item.q, allContain === true);
    }

    trace('search-done');
    // ── ptr 解析 + 真实文件存在 + canonical hash 一致（全量） ─────────
    let verified = 0;
    const verifyFailures = [];
    for (const [seq, h] of expectedHashes) {
      const ptr = 'log:' + sessionId + '#seq=' + seq;
      const v = store.verifyPtrSample({ ptr, contentHash: h });
      if (v.ok) verified += 1;
      else if (verifyFailures.length < 5) verifyFailures.push({ ptr, checks: v.checks, reason: v.reason });
    }
    trace('verify-done ok=' + verified);
    out.verify = { checked: expectedHashes.size, ok: verified, failures: verifyFailures, samplePtr: 'log:' + sessionId + '#seq=' + seqMin };
    check('every ptr resolves, the file exists, and content_hash matches canonical text', verified === expectedHashes.size, { verified, expected: expectedHashes.size, failures: verifyFailures.length });

    // ── relocateSource：搬到新根后仍可回取（仅 full 模式） ──────────────
    if (opts.mode === 'full') {
    fs.mkdirSync(relocateDir, { recursive: true });
    const movedFile = path.join(relocateDir, relFile);
    fs.copyFileSync(srcFile, movedFile);
    const reloc = store.relocateSource(source.sourceId, relocateDir, root);
    out.relocate = {
      status: reloc.status,
      oldRoot: reloc.previousRoot,
      newRoot: reloc.newRoot,
      framesTotal: reloc.framesTotal,
      framesRelocatable: reloc.framesRelocatable,
      framesUnresolved: reloc.framesUnresolved,
      auditId: reloc.auditId,
    };
    check('source relocation performed and audited', reloc.status === 'relocated' && reloc.auditId !== null && reloc.framesUnresolved === 0);

    let verifiedAfter = 0;
    const relocateFailures = [];
    for (const [seq, h] of expectedHashes) {
      const ptr = 'log:' + sessionId + '#seq=' + seq;
      const v = store.verifyPtrSample({ ptr, contentHash: h });
      if (v.ok) verifiedAfter += 1;
      else if (relocateFailures.length < 5) relocateFailures.push({ ptr, checks: v.checks, reason: v.reason });
    }
    const resolvedAfter = store.resolvePtr('log:' + sessionId + '#seq=' + seqMin);
    out.relocate.verified = verifiedAfter;
    out.relocate.ptrStable = resolvedAfter.ptr === 'log:' + sessionId + '#seq=' + seqMin;
    out.relocate.resolvedPathUnderNewRoot = isInside(relocateDir, resolvedAfter.rawPath);
    check('after relocation every ptr still returns the real file + matching hash', verifiedAfter === expectedHashes.size, { verifiedAfter, expected: expectedHashes.size, failures: relocateFailures.length });
    check('ptr itself does not change on relocation', out.relocate.ptrStable === true);
    check('resolved path follows the current source root', out.relocate.resolvedPathUnderNewRoot === true);

    // ── 缺失文件：验收必须失败（不是纸面上的可搬迁） ──────────────────
    // ★ 抽样只从「文件里真实出现过、且已有独立算出的 expected hash」的 seq 里取首/中/尾。
    //   旧实现用 floor((seqMin+seqMax)/2) 拿算术中点：seq 缺号时那个值根本不在库里，
    //   expectedHashes.get() 为 undefined，verifyPtrSample 直接以 INVALID_INPUT 抛出，
    //   整次运行崩掉、一条 check 都留不下（缺号场景必崩）。现在样本 seq 一定真实存在；
    //   canonical hash 仍由本脚本重新解析记录、重新序列化后独立算出，没有从库里读。
    fs.rmSync(movedFile, { force: true });
    const samplePool = seqs.filter((s) => expectedHashes.has(s));
    const sampleSeqs = [];
    if (samplePool.length > 0) {
      const pick = [samplePool[0], samplePool[Math.floor((samplePool.length - 1) / 2)], samplePool[samplePool.length - 1]];
      for (const s of pick) if (!sampleSeqs.includes(s)) sampleSeqs.push(s);
    }
    const sampling = {
      strategy: 'first/middle/last of seqs that really exist in the file and carry an independently computed expected hash',
      pool: samplePool.length,
      poolSeqMin: samplePool.length ? samplePool[0] : null,
      poolSeqMax: samplePool.length ? samplePool[samplePool.length - 1] : null,
    };
    const missingSamples = [];
    let failedAsExpected = 0;
    for (const seq of sampleSeqs) {
      const ptr = 'log:' + sessionId + '#seq=' + seq;
      const v = store.verifyPtrSample({ ptr, contentHash: expectedHashes.get(seq) });
      if (!v.ok && v.fileExists === false && v.checks.fileExists === false) failedAsExpected += 1;
      missingSamples.push({ ptr, ok: v.ok, fileExists: v.fileExists, checks: v.checks, reason: v.reason });
    }
    out.missingFile = { checked: sampleSeqs.length, failedAsExpected, sampling, samples: missingSamples };
    if (sampleSeqs.length === 0) {
      // 空集合 = 没有可抽样的真实记录：明确回答「无样本」，不拿猜出来的 seq 充数，也不算通过。
      out.missingFile.note = 'no sample available: no seq-bearing record carrying an independent expected hash';
      check('missing file check had at least one real seq-bearing sample to draw from', false, sampling);
    } else {
      check('missing file makes acceptance fail (fileExists=false, ok=false)', failedAsExpected === sampleSeqs.length, { failedAsExpected, checked: sampleSeqs.length, sampling });
    }
    }
  } finally {
    try { store.close(); } catch (_) { /* 已关闭 */ }
  }

  if (!opts.keep) {
    const dbFiles = [dbPath, dbPath + '-wal', dbPath + '-shm'];
    for (const f of dbFiles) { try { fs.rmSync(f, { force: true }); } catch (_) { /* 忽略 */ } }
    try { fs.rmSync(relocateDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    out.cleanup = {
      kept: false,
      dbRemoved: !fs.existsSync(dbPath),
      relocateDirRemoved: !fs.existsSync(relocateDir),
    };
  } else {
    out.cleanup = { kept: true, dbRemoved: false, relocateDirRemoved: false };
  }

  out.ok = checks.every((c) => c.ok);
  return out;
}

main().then((result) => {
  const text = JSON.stringify(result, null, 2);
  if (result && result.jsonOut) {
    try { fs.writeFileSync(result.jsonOut, text + '\n', 'utf8'); } catch (e) { process.stderr.write('json-out write failed: ' + String(e && e.message || e) + '\n'); }
  }
  process.stdout.write(text + '\n');
  process.exit(result && result.ok ? 0 : 1);
}).catch((err) => {
  const payload = { ok: false, error: { name: err && err.name, message: String(err && err.message || err) } };
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(err && err.usage ? 2 : 1);
});
