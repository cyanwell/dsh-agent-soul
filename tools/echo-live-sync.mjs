#!/usr/bin/env node
// tools/echo-live-sync.mjs —— 把「会话日志 → ECHO 派生索引」这条链一次跑完（阶段 3 的第 1 步）
//
// ★ 它做什么（三件事，顺序是硬的）：
//   ① 清单：把 <source-root> 下的会话日志列成 files.jsonl（{file, sid, ws}）
//   ② 构建：syncFromSessionTail 增量读尾部 → 三件套（words/summaries/manifest）落在 TEMP
//   ③ 入库：echo-index-import 事务性替换这一代（generation +1）
//
// ★ 为什么先做成 CLI 而不是直接塞进 core：
//    stage 3 的核心不是「写代码」，是**先让这条链在真数据上跑通并留下回执**。
//    塞进进程之前必须先看见：增量读了几字节、写了多少行、第几代、游标推到哪。
//    这些数只有跑过一次才有。没有回执的「实时索引」和没做是一样的。
//
// ★ 只读边界（一条都不放松）：
//   · 原始会话日志：只读，一个字节都不写
//   · 02-墨.jsonl：这条链**从不打开**（墨账本不入 SQLite，这是阶段 3 的硬约束）
//   · D:/AI/memory/hub/index/（老 ECHO 索引）：**不读也不写** —— 新链的源是会话日志本身
//   · 目标库：只通过 echo-index-import 的事务写（它自己带库层护栏与回滚）
//
// ★ 退出码：0 成功（含 ALREADY_CURRENT）/ 2 用法 / 3 拒绝 / 4 IO / 5 库
//
// 用法：
//   node tools/echo-live-sync.mjs --db <meta.sqlite> --source-root <sessions> [--manifest <files.jsonl>]
//                                 [--out-dir <dir>] [--namespace log|v4log] [--full-rebuild] [--json]
//   node tools/echo-live-sync.mjs --db <meta.sqlite> --list-sessions      # 只看会扫到哪些会话

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { syncFromSessionTail, SESSION_TAIL_VERSION } from './echo-source-build.mjs';
import { runImport } from './echo-index-import.mjs';
import { openDatabase, configureConnection } from '../src/db/engine.mjs';
import { echoSourceIdFor } from '../src/db/schema.mjs';

const SESSION_FILE_RE = /^session\.v[34]\.jsonl\.zstd$/;
const SKIP_DIR = new Set(['node_modules', '.git', '.cache']);

export class LiveSyncError extends Error {
  constructor(code, message, exitCode, detail) {
    super(message);
    this.name = 'LiveSyncError';
    this.code = code;
    this.exitCode = exitCode === undefined ? 3 : exitCode;
    this.detail = detail === undefined ? null : detail;
  }
}
const fail = (code, message, exitCode, detail) => { throw new LiveSyncError(code, message, exitCode, detail); };

function parseArgs(argv) {
  const out = { db: null, sourceRoot: null, manifest: null, outDir: null, namespace: 'log', fullRebuild: false, json: false, listSessions: false };
  const takesValue = { '--db': 'db', '--source-root': 'sourceRoot', '--manifest': 'manifest', '--out-dir': 'outDir', '--namespace': 'namespace' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = String(argv[i]);
    if (takesValue[a]) {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('--')) fail('E_USAGE', 'missing value for ' + a, 2);
      out[takesValue[a]] = String(v);
      i += 1;
    } else if (a === '--full-rebuild') out.fullRebuild = true;
    else if (a === '--json') out.json = true;
  /* ★ 2026-11-17：回执写文件。调用方（器官）读文件，不再解析 stdout ——
     回执随会话数变大（1,609 个文件约 200KB+），走管道会被截断/混入警告，
     导致「成功的同步被记成失败」。文件是确定性的。 */
  else if (a === '--receipt-file') out.receiptFile = argv[++i];
    else if (a === '--list-sessions') out.listSessions = true;
    else fail('E_USAGE', 'unknown argument: ' + a, 2);
  }
  if (!out.db) fail('E_USAGE', 'missing required --db', 2);
  if (!out.sourceRoot) fail('E_USAGE', 'missing required --source-root', 2);
  if (out.namespace !== 'log' && out.namespace !== 'v4log') fail('E_USAGE', '--namespace must be log|v4log', 2);
  return out;
}

/**
 * 列会话日志。★ 只 stat 不读内容 —— 这一步的成本必须与「文件大小」无关，
 * 否则加一个会话就把同步变成一次全量读。
 */
export function listSessionFiles(sourceRoot) {
  const abs = path.resolve(sourceRoot);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    fail('E_SOURCE_ROOT', 'source root is not an existing directory: ' + abs, 4);
  }
  const files = [];
  const stack = [abs];
  while (stack.length) {
    const dir = stack.pop();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const en of ents) {
      if (en.isDirectory()) {
        if (SKIP_DIR.has(en.name)) continue;
        stack.push(path.join(dir, en.name));
        continue;
      }
      if (!SESSION_FILE_RE.test(en.name)) continue;
      const file = path.join(dir, en.name);
      const sid = path.basename(path.dirname(file));
      const ver = Number((en.name.match(/\.v([34])\./) || [])[1] || 0);
      files.push({ file, sid, ver });
    }
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return files;
}

/**
 * 同一个 sid 出现多个版本文件时的显式择优。
 *
 * ★★ 为什么会遇到这种事（实测 2026-11-17，本机 1,614 个会话里有 6 个）：
 *   DSH 从 v3 迁到 v4 时，老会话目录里同时留下了 session.v3.jsonl.zstd 与
 *   session.v4.jsonl.zstd。builder 的契约是「源→会话映射必须钉死，歧义就拒」——
 *   那条契约是对的（它防的是静默丢数据），但它把这种**有明确答案**的情形也一起拒了。
 *
 * ★ 判据为什么是「版本号」而不是「体积」或「mtime」：
 *   实测那 6 个里有 3 个 v4 **比 v3 更小**（78K vs 94K、350B vs 409B、1.89K vs 2.1K）——
 *   按体积选会选错。而版本号是文件名的直接事实，不需要推断。
 *   本机这 6 个的 mtime 恰好也是 v4 更新，但 mtime 会随备份/复制漂移，
 *   只有版本号是结构性的。
 *
 * ★ 这不是「猜」：被丢掉的那个文件会原样写进回执（superseded），
 *   谁被丢、为什么丢，事后都能查。
 *
 * @returns {{files: Array, superseded: Array, ambiguous: Array}}
 */
export function resolveSessionVersions(list) {
  const bySid = new Map();
  for (const f of list) {
    if (!bySid.has(f.sid)) bySid.set(f.sid, []);
    bySid.get(f.sid).push(f);
  }
  const files = [];
  const superseded = [];
  const ambiguous = [];
  for (const [sid, group] of bySid) {
    if (group.length === 1) { files.push(group[0]); continue; }
    const maxVer = Math.max(...group.map((f) => f.ver || 0));
    const top = group.filter((f) => (f.ver || 0) === maxVer);
    if (top.length > 1) {
      // 同版本多个文件 —— 这一条仍然拒绝：没有任何结构性判据能分出谁是真的。
      ambiguous.push({ sid, files: top.map((f) => f.file) });
      continue;
    }
    files.push(top[0]);
    for (const f of group) {
      if (f !== top[0]) superseded.push({ sid, dropped: f.file, kept: top[0].file, droppedVer: f.ver, keptVer: top[0].ver });
    }
  }
  files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files, superseded, ambiguous };
}

/** 写一份 files.jsonl（第 ② 步的输入）。★ 每次都写全量清单：缺一个文件 = 它的派生行会被当成「新会话」重读。 */
export function writeManifest(files, targetPath) {
  const lines = files.map((f) => JSON.stringify({ file: f.file.replace(/\\/g, '/'), sid: f.sid, ws: f.ws === undefined ? null : f.ws }));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, lines.join('\n') + '\n', 'utf8');
  const bytes = fs.readFileSync(targetPath);
  return { path: targetPath, bytes: bytes.length, rows: files.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * 预检：目标库里这一源的上次游标 vs 磁盘现状。
 *
 * ★ 为什么要这一步 —— 它把「什么都没变」的一轮从「重建整代 + 整代替换」压成
 *   「N 次 stat + 一次只读查询」。soul-sync 每轮都会调这里，而绝大多数轮次
 *   一个新帧都没有；没有这一步，空转一轮也要重写全部 words（2.6 万行起）。
 *
 * ★ 判据只有一条：每个文件的 mtime:size 都等于上次记下的 key。少了文件、
 *   多了文件、大小变了、mtime 变了 —— 一律算变了，走完整链（宁可贵，不可漏）。
 */
export function peekPriorTail(dbPath, sourcePath) {
  if (!fs.existsSync(dbPath)) return { exists: false, reason: 'db-missing' };
  let db;
  try { db = openDatabase(dbPath, { readOnly: true }); } catch { return { exists: false, reason: 'db-unreadable' }; }
  try {
    configureConnection(db, { readOnly: true });
    const id = echoSourceIdFor(String(sourcePath).replace(/\\/g, '/'), 'echo-index/1');
    const row = db.prepare('SELECT generation, state, cursor_json FROM echo_index_sources WHERE echo_source_id = ?').get(id);
    if (!row) return { exists: false, reason: 'no-source-row', echoSourceId: id };
    let cursor; try { cursor = JSON.parse(row.cursor_json); } catch { return { exists: false, reason: 'cursor-unreadable' }; }
    const tail = cursor && cursor.tail;
    if (!tail || tail.version !== SESSION_TAIL_VERSION || !tail.files) return { exists: false, reason: 'cursor-not-tail' };
    return { exists: true, echoSourceId: id, generation: Number(row.generation), state: row.state, files: tail.files };
  } finally { try { db.close(); } catch {} }
}

/** 磁盘现状与上次游标逐文件比对。返回 { unchanged, files, changed } */
export function compareToPrior(prior, files) {
  if (!prior.exists) return { unchanged: false, reason: prior.reason, files: files.length };
  const prev = prior.files;
  const prevKeys = Object.keys(prev);
  if (prevKeys.length !== files.length) return { unchanged: false, reason: 'file-count-changed', prev: prevKeys.length, now: files.length };
  let changed = 0;
  for (const f of files) {
    const p = prev[f.file.replace(/\\/g, '/')] || prev[f.file] || prev[path.resolve(f.file)] || prev[String(f.file).replace(/\\/g, '/')];
    if (!p) return { unchanged: false, reason: 'file-not-in-cursor', file: path.basename(path.dirname(f.file)) };
    let st; try { st = fs.statSync(f.file); } catch { return { unchanged: false, reason: 'stat-failed' }; }
    if (st.mtimeMs + ':' + st.size !== p.key) changed += 1;
  }
  return { unchanged: changed === 0, changed, files: files.length };
}

function readManifestRows(manifestPath) {
  const bytes = fs.readFileSync(manifestPath);
  const text = bytes.toString('utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let r; try { r = JSON.parse(line); } catch { fail('E_MANIFEST_JSON', 'manifest line is not JSON', 4); }
    if (typeof r.file !== 'string' || !r.file) fail('E_MANIFEST_ROW', 'manifest row has no file', 4);
    if (typeof r.sid !== 'string' || !r.sid) fail('E_MANIFEST_ROW', 'manifest row has no sid', 4);
    rows.push(r);
  }
  if (!rows.length) fail('E_MANIFEST_EMPTY', 'manifest declares no files', 4);
  return { rows, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

/**
 * 跑一次完整链。返回回执（不含正文、不含路径原文以外的隐私）。
 * ★ 每个阶段失败都带阶段名 —— 「哪一步」比「失败」有用得多。
 */
export function runLiveSync(options) {
  const o = options || {};
  const startedAt = Date.now();
  let stage = 'args';
  const t0 = Date.now();
  const marks = {};
  try {
    if (!o.db) fail('E_USAGE', 'db is required', 2);
    if (!o.sourceRoot) fail('E_USAGE', 'sourceRoot is required', 2);
    const dbPath = path.resolve(o.db);
    const sourceRoot = path.resolve(o.sourceRoot);
    const namespace = o.namespace === undefined ? 'log' : String(o.namespace);
    if (namespace !== 'log' && namespace !== 'v4log') fail('E_USAGE', 'namespace must be log|v4log', 2);
    if (!fs.existsSync(dbPath)) fail('E_DB_MISSING', 'target database does not exist (this tool never creates one): ' + dbPath, 5);

    stage = 'manifest';
    let manifestPath = o.manifest ? path.resolve(o.manifest) : null;
    let manifestInfo;
    // ★★ 预检：内容没变就**不重建整代**。
    //   判据只看磁盘事实（每个文件的 mtime:size），不看时间、不看心情。
    const sourcePathPosix = String(sourceRoot).replace(/\\/g, '/');
    const prior = peekPriorTail(dbPath, sourcePathPosix);
    const raw = listSessionFiles(sourceRoot);
    if (!raw.length) fail('E_NO_SESSIONS', 'no session.v[34].jsonl.zstd under ' + sourceRoot, 4);
    const resolved = resolveSessionVersions(raw);
    if (resolved.ambiguous.length) {
      fail('E_AMBIGUOUS_SESSION', resolved.ambiguous.length + ' 个会话有同版本多文件，没有任何结构性判据能分出谁是真的：'
        + resolved.ambiguous.slice(0, 5).map((x) => x.sid).join(', '), 3, { ambiguous: resolved.ambiguous.slice(0, 20) });
    }
    const diskFiles = resolved.files;
    // ★ 两条路的 superseded 都要带上：走了外部清单时，resolved（磁盘侧）与
    //   manifestInfo.resolved（清单侧）可能各有一批。合并去重，不丢任何一条。
    const supersededAll = [];
    {
      const seen = new Set();
      const fromManifest = (manifestInfo && manifestInfo.resolved && manifestInfo.resolved.superseded) || [];
      for (const s of [].concat(resolved.superseded || [], fromManifest)) {
        const k = s.dropped;
        if (seen.has(k)) continue;
        seen.add(k); supersededAll.push(s);
      }
    }
    // ★★ 2026-11-17（bug 修复）：**显式全量重建必须绕过预检**。
    //   预检是给「定时轮次」用的省事开关；而 --full-rebuild 是人明确要求「从头再来一代」。
    //   不绕过它的后果，我在验证时直接撞到了：请求重建 → 预检说「没变」→ 返回 UNCHANGED
    //   → counts 为 null → 调用方以为重建成功。**一个把命令吃掉还报成功的开关，比没有还坏。**
    const cmp = o.fullRebuild === true ? { unchanged: false, reason: 'full-rebuild-requested' } : compareToPrior(prior, diskFiles);
    if (cmp.unchanged) {
      marks.totalMs = Date.now() - startedAt;
      return {
        ok: true, code: 'UNCHANGED', wrote: false, generation: prior.generation,
        attemptId: null, attempt: null, commitId: null, commit: null,
        authority: prior.echoSourceId && prior.state === 'committed' ? { sourceId: prior.echoSourceId, generation: prior.generation, state: 'committed' } : null,
        sourcePath: sourcePathPosix, namespace,
        counts: null, tail: { bytesRead: 0, skippedUnchanged: diskFiles.length, appended: 0, fullyRead: 0, words: 0, summaries: 0 },
        manifest: { rows: diskFiles.length, bytes: 0, sha256: null },
        superseded: supersededAll,
        db: { path: dbPath, schemaVersion: null, codeSchemaVersion: null },
        marks, version: SESSION_TAIL_VERSION,
      };
    }
    if (manifestPath) {
      // ★ 外部清单也要过一遍择优：同一份数据，两条路必须同一个结论。
      //   原来这里直接拿清单去构建 —— 于是本机 6 个 v3/v4 双文件会话把整批拒了，
      //   而同样的数据走「自动列清单」那条路是能过的。**两条路不同结论 = 最难查的那类 bug。**
      const rawRows = readManifestRows(manifestPath);
      const withVer = rawRows.rows.map((r) => ({ file: r.file, sid: r.sid, ws: r.ws, ver: Number((path.basename(r.file).match(/\.v([34])\./) || [])[1] || 0) }));
      const pick = resolveSessionVersions(withVer);
      if (pick.ambiguous.length) {
        fail('E_AMBIGUOUS_SESSION', pick.ambiguous.length + ' 个会话有同版本多文件：' + pick.ambiguous.slice(0, 5).map((x) => x.sid).join(', '), 3, { ambiguous: pick.ambiguous.slice(0, 20) });
      }
      const kept = new Set(pick.files.map((f) => f.file));
      const pruned = rawRows.rows.filter((r) => kept.has(r.file));
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-live-manifest-'));
      manifestPath = path.join(tmpRoot, 'files.jsonl');
      manifestInfo = writeManifest(pruned, manifestPath);
      manifestInfo.path = manifestPath;
      manifestInfo.tempRoot = tmpRoot;
      manifestInfo.resolved = pick;
    } else {
      // ★★★ 2026-11-17（真 bug，器官第一轮就撞上）：这里原来**又列了一次文件**
      //   并把**未去重**的原始列表写进清单 —— 于是同一个 sid 的 session.v3 与 v4
      //   同时出现在清单里，构建器报「declared by two files」整批拒掉。
      //   而同一个根走外部清单那条路（上方 279-296）是会去重的。
      //   ★ 判据：`diskFiles` 已经在本函数开头解析过（含 v3/v4 择优 + 歧义拒绝），
      //     这里就该用它 —— 两条路必须同一个结论。
      if (!diskFiles.length) fail('E_NO_SESSIONS', 'no session.v[34].jsonl.zstd under ' + sourceRoot, 4);
      const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-live-manifest-'));
      manifestPath = path.join(tmpRoot, 'files.jsonl');
      manifestInfo = writeManifest(diskFiles, manifestPath);
      manifestInfo.path = manifestPath;
      manifestInfo.tempRoot = tmpRoot;
    }
    marks.manifestMs = Date.now() - t0;
    const tBuild = Date.now();

    stage = 'build';
    const outDir = o.outDir ? path.resolve(o.outDir) : fs.mkdtempSync(path.join(os.tmpdir(), 'echo-live-out-'));
    const built = syncFromSessionTail({
      sourceRoot,
      manifestPath,
      outDir,
      dbPath,
      builtAt: new Date().toISOString(),
      namespace,
      fullRebuild: o.fullRebuild === true,
      allowExternalSourceRoot: true,
      allowExternalDb: true,
      // ★ 有上一代且不是显式全量重建 → 只产出 delta，不读回、不重写整代。
      //   实测（38k 词 / 862MB 库）：这一步从 6,301 ms 降到接近 0 —— 因为它原本
      //   只是为了「重写一份 append 模式根本不用的整代文件」而去读 38k 行。
      deltaOnly: prior.exists && !o.fullRebuild,
    });
    marks.buildMs = Date.now() - tBuild;
    const tImport = Date.now();

    stage = 'import';
    const manifestSha = createHash('sha256').update(fs.readFileSync(built.manifestPath)).digest('hex');
    // ★★ 有上一代且不是显式全量重建 → 走 append（只写 delta）。
    //   实测：61k 词的库上，整代替换 441,188 ms；纯追加 31 行 73 ms。
    //   首代（prior 不存在）或 fullRebuild 仍然走全量 —— 那时代替根本没东西可追加。
    const useAppend = prior.exists && !o.fullRebuild;
    const importArgs = [
      '--manifest', built.manifestPath,
      '--sha256', manifestSha,
      '--generation', String(built.manifest.generation),
      '--db', dbPath,
      '--json',
    ];
    if (useAppend) {
      importArgs.push('--append', '--delta-words', built.deltaWordsPath, '--delta-summaries', built.deltaSummariesPath);
    }
    const receipt = runImport(importArgs);
    marks.importMs = Date.now() - tImport;
    marks.totalMs = Date.now() - startedAt;

    if (manifestInfo.tempRoot) { try { fs.rmSync(manifestInfo.tempRoot, { recursive: true, force: true }); } catch {} }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}

    return {
      ok: true,
      code: receipt.code,
      wrote: receipt.wrote,
      generation: receipt.generation,
      attemptId: receipt.attemptId,
      attempt: receipt.attempt,
      commitId: receipt.commitId,
      commit: receipt.commit,
      authority: receipt.authority,
      sourcePath: built.manifest.sourcePath,
      namespace,
      counts: receipt.counts,
      mode: useAppend ? 'append' : 'full',
      delta: built.delta,
      tail: built.tail,
      manifest: { rows: manifestInfo.rows, bytes: manifestInfo.bytes, sha256: manifestInfo.sha256 },
      superseded: supersededAll,
      db: receipt.db,
      marks,
      version: SESSION_TAIL_VERSION,
    };
  } catch (err) {
    const wrapped = err instanceof LiveSyncError ? err : new LiveSyncError('E_UNEXPECTED', String(err && err.message || err), 5);
    wrapped.detail = Object.assign({}, wrapped.detail, { stage, attemptId: err && err.attemptId || (err && err.detail && err.detail.attemptId) || null });
    throw wrapped;
  }
}

function main() {
  const argv = process.argv.slice(2);
  let receipt = null;
  let exitCode = 0;
  // ★ o 必须在 try 外声明：catch 里要用它写回执文件。
  let o = null;
  try {
    o = parseArgs(argv);
    if (o.listSessions) {
      const files = listSessionFiles(o.sourceRoot);
      const out = { ok: true, sourceRoot: path.resolve(o.sourceRoot), sessions: files.length, sample: files.slice(0, 10).map((f) => ({ sid: f.sid, bytes: (() => { try { return fs.statSync(f.file).size; } catch { return null; } })() })) };
      process.stdout.write(JSON.stringify(out) + '\n');
      return;
    }
    receipt = runLiveSync({ db: o.db, sourceRoot: o.sourceRoot, namespace: o.namespace, manifest: o.manifest, outDir: o.outDir, fullRebuild: o.fullRebuild });
    if (o.receiptFile) { try { fs.writeFileSync(o.receiptFile, JSON.stringify(receipt), 'utf8'); } catch (err) { /* 写不了就让调用方按 stdout 兜底 */ } }
    if (o.json) process.stdout.write(JSON.stringify(receipt) + '\n');
    else {
      const t = receipt.tail || {};
      process.stdout.write('ECHO live sync · ' + receipt.code + '\n');
      process.stdout.write('  代次     ' + receipt.generation + ' · 源 ' + receipt.sourcePath + ' · ' + receipt.namespace + '\n');
      process.stdout.write('  会话     ' + (receipt.manifest.rows) + ' 个（清单 ' + receipt.manifest.bytes + ' B）'
        + (receipt.superseded && receipt.superseded.length ? ' · 跳过旧版 ' + receipt.superseded.length + ' 个文件' : '') + '\n');
      process.stdout.write('  读字节   ' + (t.bytesRead === undefined ? '?' : t.bytesRead) + ' · 新词 ' + (t.words === undefined ? '?' : t.words) + ' · 新摘要 ' + (t.summaries === undefined ? '?' : t.summaries) + '\n');
      process.stdout.write('  未变 ' + (t.skippedUnchanged === undefined ? '?' : t.skippedUnchanged) + ' · 追加 ' + (t.appended === undefined ? '?' : t.appended) + ' · 全读 ' + (t.fullyRead === undefined ? '?' : t.fullyRead) + '\n');
      process.stdout.write('  耗时     清单 ' + receipt.marks.manifestMs + 'ms · 构建 ' + receipt.marks.buildMs + 'ms · 入库 ' + receipt.marks.importMs + 'ms · 合计 ' + receipt.marks.totalMs + 'ms\n');
    }
    if (receipt.code !== 'IMPORTED' && receipt.code !== 'ALREADY_CURRENT') exitCode = 0;
  } catch (err) {
    const payload = { ok: false, code: err && err.code || 'E_UNKNOWN', message: String(err && err.message || err).slice(0, 400), stage: err && err.detail && err.detail.stage || null, attemptId: err && err.detail && err.detail.attemptId || err && err.attemptId || null, commit: null, commitId: null, authority: null };
    if (o && o.receiptFile) { try { fs.writeFileSync(o.receiptFile, JSON.stringify(payload), 'utf8'); } catch { /* ignore */ } }
    process.stderr.write(JSON.stringify(payload) + '\n');
    exitCode = err && err.exitCode ? err.exitCode : 5;
  }
  process.exitCode = exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

export { parseArgs };
