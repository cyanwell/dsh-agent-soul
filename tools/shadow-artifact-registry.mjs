#!/usr/bin/env node
// tools/shadow-artifact-registry.mjs —— P2：真实产物在**隔离库**里的影子登记 / 重放 / 校验。
//
// 它证明的是 P1c 那层（v5 artifacts）在**真实报告文件**上成立，而不是只在合成样本上成立：
//   登记 → 原样重放（unchanged，事件不增）→ 改一个副本（verify=stale，再登记=content-changed）
//   → 删一个副本（verify=missing，再登记被拒且不写半条）→ 第三个保持 present
//   → 关库重开（readonly）读数逐项一致 → 扫库文件确认**没有任何产物正文入库** → 清理。
//
// 铁律（与 meta-store-selftest.mjs 同一条）：
//   1. 只往 os.tmpdir() 里写。库、source root、副本全在 tempRoot 下，收尾统一删除。
//   2. **只读真实产物**：三份源文件只被 readFileSync / copyFileSync 读取，绝不写回；
//      收尾再核对一遍原文件 bytes/sha/mtime 未变。
//   3. 不启动服务、不读凭据、不碰 data/ 与生产库。
//
// 两处**显式取舍**（写在这里，不是漏写）：
//   - sources 没有公开的「只建 source 不建帧」入口（唯一入口 ingest 会同时写一行帧）。
//     本次要点是「库里有 0 帧、0 条正文」，所以这里直接按 schema 的 CHECK 约束插一行 source，
//     并把 frame_index 为空当成一条断言 —— 不是绕过设计，是为了让「零正文」可被证明。
//   - producerSession / producerTask 是**派活侧归属**（第九代会话派的本轮活），
//     不是从文件内容里读出来的事实；真实产物本身没有这两个字段。
//
// 跑法（必须用 DSH 自带 Node 24，node:sqlite 才在）：
//   & "C:\Users\pc\AppData\Local\Programs\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" tools/shadow-artifact-registry.mjs

import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import {
  openMetaStore, isMetaStoreError, CODES, SCHEMA_VERSION, artifactIdFor,
} from '../src/db/index.mjs';

const SRC_DIR = 'D:/AI/yanqing-soul/30-状态';
const FILES = [
  'v4-六层解耦与数据治理方案-20261109.md',
  'v4-P1a-定点独立验证-20261109.md',
  'v4-P1b-定点独立验证-20261109.md',
];
const PRODUCER_SESSION = 'session-7eff99a7-b1d5-4f86-b611-84c7347a4871';
const PRODUCER_TASK = 'v4-P2-真实产物影子登记';
const SOURCE_ID = 'shadow-temp';
const NAMESPACE = 'shadowtmp';
const APPEND_MARKER = '\n<!-- shadow-test: content changed 2026-11-09 -->\n';

const checks = [];
const facts = { files: [], events: [], startedAt: Date.now() };

function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (ok || detail === undefined ? '' : '  ' + JSON.stringify(detail)));
  return !!ok;
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function statOf(path) {
  const s = statSync(path);
  return { bytes: s.size, mtimeMs: s.mtimeMs };
}

const stores = [];
function openStore(options) {
  const s = openMetaStore(options);
  stores.push(s);
  return s;
}

function closeAll() {
  for (const s of stores.reverse()) {
    try { s.close(); } catch (_) { /* 已关 */ }
  }
  stores.length = 0;
}

const tempRoot = mkdtempSync(join(tmpdir(), 'shadow-artifact-registry-'));
const sourceRoot = join(tempRoot, 'source-root');
const dbPath = join(tempRoot, 'shadow.sqlite');

function main() {
  check('T1 schema: code is v5 (artifacts/artifact_events)', SCHEMA_VERSION === 5, { SCHEMA_VERSION });

  // ── 复制三份真实产物到 TEMP 同一 source root（只操作副本） ──────────────
  mkdirSync(sourceRoot, { recursive: true });
  const originals = [];
  for (const name of FILES) {
    const origin = join(SRC_DIR, name);
    if (!existsSync(origin)) throw new Error('missing real artifact: ' + origin);
    const beforeBuf = readFileSync(origin);
    const before = { bytes: beforeBuf.length, sha256: sha256(beforeBuf), ...statOf(origin) };
    const copyPath = join(sourceRoot, name);
    copyFileSync(origin, copyPath);
    const copyBuf = readFileSync(copyPath);
    const copyHash = { bytes: copyBuf.length, sha256: sha256(copyBuf) };
    check('T2 copy byte-identical: ' + name,
      before.bytes === copyHash.bytes && before.sha256 === copyHash.sha256,
      { origin: { bytes: before.bytes, sha256: before.sha256 }, copy: copyHash });
    originals.push({ name, origin, copyPath, before, text: copyBuf.toString('utf8') });
    facts.files.push({
      name,
      origin: origin,
      copyPath,
      bytes: before.bytes,
      sha256: before.sha256,
    });
  }

  // ── 开 TEMP 库 + 建 source ─────────────────────────────────────────────
  const store = openStore({ path: dbPath, mode: 'readwrite' });
  const migrated = store.migrate();
  check('T3 temp db migrated to v5', store.state.ready === true && store.state.current === 5,
    { current: store.state.current, applied: migrated.applied.map((m) => m.version) });

  const nowIso = new Date().toISOString();
  store.db.prepare([
    'insert into sources (source_id, kind, namespace, authority, raw_path, path_kind, created_at, updated_at)',
    'values (?, ?, ?, ?, ?, ?, ?, ?)',
  ].join(' ')).run(SOURCE_ID, 'v4-mirror', NAMESPACE, 'mirror', sourceRoot, 'dir', nowIso, nowIso);

  const zeroFrames = store.countFrames();
  check('T4 library holds zero frames/sessions (metadata-only source)', zeroFrames === 0, { frames: zeroFrames });

  // ── 登记三份（kind/title/producer/created/updated/status/bytes/sha256/metadata） ──
  const records = originals.map((f) => {
    const h1 = (f.text.match(/^#\s+(.+)$/m) || [])[1];
    return {
      sourceId: SOURCE_ID,
      path: f.name,
      kind: 'report',
      title: (h1 || f.name).slice(0, 200),
      producerSession: PRODUCER_SESSION,
      producerTask: PRODUCER_TASK,
      metadata: {
        stage: 'P2-shadow',
        docBatch: 'v4-20261109',
        originPath: f.origin,
        originBytes: f.before.bytes,
        originSha256: f.before.sha256,
      },
    };
  });

  const firstPass = [];
  for (let i = 0; i < originals.length; i += 1) {
    const f = originals[i];
    const res = store.registerArtifact(records[i]);
    firstPass.push(res);
    const ev = store.listArtifactEvents({ artifactId: res.artifact.artifactId });
    check('T5a registered ' + f.name,
      res.outcome === 'inserted' && ev.total === 1 && ev.items[0].action === 'registered'
        && res.artifact.status === 'present'
        && res.artifact.bytes === f.before.bytes && res.artifact.sha256 === f.before.sha256,
      { outcome: res.outcome, events: ev.total, action: ev.items[0] && ev.items[0].action, bytes: res.artifact.bytes });
    facts.files[i].artifactId = res.artifact.artifactId;
    facts.files[i].relPath = res.artifact.relPath;
    facts.files[i].title = res.artifact.title;
    facts.files[i].createdAt = res.artifact.createdAt;
    facts.files[i].updatedAt = res.artifact.updatedAt;
    facts.files[i].lastSeenAt = res.artifact.lastSeenAt;
    facts.events.push({ file: f.name, pass: 'register', outcome: res.outcome, eventsAppended: res.eventsAppended });
  }
  check('T5b counts after first pass: 3 artifacts / 3 events',
    store.countArtifacts().artifacts === 3 && store.countArtifacts().events === 3,
    store.countArtifacts());

  // ── 重放：必须 unchanged 且事件不增 ────────────────────────────────────
  const beforeReplay = store.countArtifacts();
  const replay = [];
  for (let i = 0; i < records.length; i += 1) {
    const res = store.registerArtifact(records[i]);
    replay.push(res);
    const after = store.getArtifact({ artifactId: firstPass[i].artifact.artifactId });
    check('T6a replay unchanged: ' + originals[i].name,
      res.outcome === 'unchanged' && res.eventsAppended === 0
        && after.createdAt === firstPass[i].artifact.createdAt
        && after.updatedAt === firstPass[i].artifact.updatedAt
        && after.lastSeenAt >= firstPass[i].artifact.lastSeenAt,
      { outcome: res.outcome, eventsAppended: res.eventsAppended,
        createdStable: after.createdAt === firstPass[i].artifact.createdAt,
        updatedStable: after.updatedAt === firstPass[i].artifact.updatedAt });
    facts.files[i].lastSeenAfterReplay = after.lastSeenAt;
    facts.events.push({ file: originals[i].name, pass: 'replay', outcome: res.outcome, eventsAppended: res.eventsAppended });
  }
  check('T6b replay appended nothing (events still 3)', store.countArtifacts().events === beforeReplay.events,
    { before: beforeReplay.events, after: store.countArtifacts().events });

  // ── 改一个副本：verify=stale，再登记=content-changed ───────────────────
  const A = originals[0];
  appendFileSync(A.copyPath, APPEND_MARKER, 'utf8');
  const changedBuf = readFileSync(A.copyPath);
  const changed = { bytes: changedBuf.length, sha256: sha256(changedBuf) };
  const staleReport = store.verifyArtifact({ artifactId: firstPass[0].artifact.artifactId });
  check('T7a modified copy verifies stale (db untouched, still present)',
    staleReport.state === 'stale' && staleReport.checks.sha256Match === false
      && staleReport.db.status === 'present' && staleReport.needsReregister === true
      && store.countArtifacts().events === 3,
    { state: staleReport.state, checks: staleReport.checks, dbStatus: staleReport.db.status,
      reason: staleReport.reason, events: store.countArtifacts().events });

  const reRegisterA = store.registerArtifact(records[0]);
  const aEvents = store.listArtifactEvents({ artifactId: firstPass[0].artifact.artifactId });
  const lastA = aEvents.items[aEvents.items.length - 1];
  check('T8a re-register after change -> content-changed',
    reRegisterA.outcome === 'content-changed' && reRegisterA.eventsAppended === 1
      && aEvents.total === 2 && lastA.action === 'content-changed'
      && lastA.fromStatus === 'present' && lastA.toStatus === 'present'
      && lastA.bytes === changed.bytes && lastA.sha256 === changed.sha256
      && lastA.detail.before.sha256 === A.before.sha256 && lastA.detail.before.bytes === A.before.bytes,
    { outcome: reRegisterA.outcome, events: aEvents.total, action: lastA.action,
      beforeSha: lastA.detail && lastA.detail.before && lastA.detail.before.sha256 });
  const afterChangeVerify = store.verifyArtifact({ artifactId: firstPass[0].artifact.artifactId });
  check('T8b verify present again with the new hash',
    afterChangeVerify.state === 'present' && afterChangeVerify.disk.sha256 === changed.sha256,
    { state: afterChangeVerify.state, diskSha: afterChangeVerify.disk && afterChangeVerify.disk.sha256 });
  facts.files[0].changed = { bytes: changed.bytes, sha256: changed.sha256,
    eventId: lastA.eventId, action: lastA.action };
  facts.events.push({ file: A.name, pass: 'modify->register', outcome: reRegisterA.outcome, eventsAppended: 1 });

  // ── 删另一个副本：verify=missing；再登记被拒且不写半条 ─────────────────
  const B = originals[1];
  unlinkSync(B.copyPath);
  const missingReport = store.verifyArtifact({ artifactId: firstPass[1].artifact.artifactId });
  check('T9a deleted copy verifies missing (db keeps last confirmed status)',
    missingReport.state === 'missing' && missingReport.checks.exists === false
      && missingReport.db.status === 'present' && missingReport.needsReregister === true,
    { state: missingReport.state, checks: missingReport.checks, dbStatus: missingReport.db.status,
      reason: missingReport.reason });
  facts.files[1].deleted = { state: missingReport.state, dbStatus: missingReport.db.status,
    reason: missingReport.reason };

  let missingCode = null;
  try {
    store.registerArtifact(records[1]);
  } catch (err) {
    missingCode = isMetaStoreError(err) ? err.code : ('non-meta: ' + err.message);
  }
  const bEvents = store.listArtifactEvents({ artifactId: firstPass[1].artifact.artifactId });
  check('T9b registering a deleted copy fails ARTIFACT_FILE_MISSING, writes nothing',
    missingCode === CODES.ARTIFACT_FILE_MISSING && bEvents.total === 1
      && store.countArtifacts().artifacts === 3 && store.countArtifacts().events === 4,
    { code: missingCode, eventsForB: bEvents.total, counts: store.countArtifacts() });
  facts.files[1].deleteRegisterCode = missingCode;
  facts.events.push({ file: B.name, pass: 'delete->register', outcome: 'rejected', code: missingCode });

  // ── 第三份保持 present ────────────────────────────────────────────────
  const C = originals[2];
  const cVerify = store.verifyArtifact({ artifactId: firstPass[2].artifact.artifactId });
  check('T10 third copy stays present with the original hash',
    cVerify.state === 'present' && cVerify.disk.sha256 === C.before.sha256 && cVerify.checks.bytesMatch === true,
    { state: cVerify.state, diskSha: cVerify.disk && cVerify.disk.sha256 });

  // ── 两条 metadata-updated 的 detail 形状（与 P1c 文档 §3 的措辞对齐） ────
  const regMeta = store.registerArtifact(Object.assign({}, records[2], { title: records[2].title + '（影子登记）' }));
  const cEvents = store.listArtifactEvents({ artifactId: firstPass[2].artifact.artifactId });
  const regMetaEvent = cEvents.items[cEvents.items.length - 1];
  check('T11a register-path metadata-updated detail = [before, after, statusRecovered]',
    regMeta.outcome === 'metadata-updated' && regMeta.eventsAppended === 1
      && JSON.stringify(Object.keys(regMetaEvent.detail).sort()) === JSON.stringify(['after', 'before', 'statusRecovered'])
      && regMetaEvent.detail.statusRecovered === false,
    { outcome: regMeta.outcome, keys: Object.keys(regMetaEvent.detail).sort(),
      statusRecovered: regMetaEvent.detail.statusRecovered });
  facts.events.push({ file: C.name, pass: 'register(title changed)', outcome: regMeta.outcome, eventsAppended: 1 });

  const updMeta = store.updateArtifact({ artifactId: firstPass[2].artifact.artifactId }, {
    metadata: { stage: 'P2-shadow', docBatch: 'v4-20261109', originPath: C.origin,
      originBytes: C.before.bytes, originSha256: C.before.sha256, note: 'updateArtifact path' },
  });
  const updEvents = store.listArtifactEvents({ artifactId: firstPass[2].artifact.artifactId });
  const updEvent = updEvents.items[updEvents.items.length - 1];
  check('T11b updateArtifact-path metadata-updated detail = [changed, before, after]',
    updMeta.outcome === 'metadata-updated'
      && JSON.stringify(Object.keys(updEvent.detail).sort()) === JSON.stringify(['after', 'before', 'changed'])
      && Array.isArray(updEvent.detail.changed) && updEvent.detail.changed.indexOf('metadata') !== -1,
    { outcome: updMeta.outcome, keys: Object.keys(updEvent.detail).sort(), changed: updEvent.detail.changed });
  facts.events.push({ file: C.name, pass: 'updateArtifact(metadata)', outcome: updMeta.outcome,
    eventsAppended: updMeta.eventsAppended });

  // ── 事件只追加：直改事件行必须被触发器 ABORT ──────────────────────────
  let eventWriteBlocked = false;
  try {
    store.db.prepare('update artifact_events set action = action where event_id = ?').run(regMetaEvent.eventId);
  } catch (_) {
    eventWriteBlocked = true;
  }
  check('T12 artifact_events is append-only (UPDATE aborted by trigger)',
    eventWriteBlocked === true, { blocked: eventWriteBlocked });

  const finalCounts = store.countArtifacts();
  const finalList = store.listArtifacts({ sourceId: SOURCE_ID });
  check('T13 final in-library state: 3 artifacts / 6 events, all rows listed',
    finalCounts.artifacts === 3 && finalCounts.events === 6 && finalList.total === 3, finalCounts);

  const snapshot = {
    counts: finalCounts,
    rows: finalList.items.map((a) => ({
      artifactId: a.artifactId, relPath: a.relPath, kind: a.kind, title: a.title,
      producerSession: a.producerSession, producerTask: a.producerTask,
      status: a.status, bytes: a.bytes, sha256: a.sha256, metadata: a.metadata,
    })),
    events: finalList.items.map((a) => store.listArtifactEvents({ artifactId: a.artifactId }).items.map((e) => ({
      eventId: e.eventId, action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus,
      bytes: e.bytes, sha256: e.sha256, createdAt: e.createdAt,
    }))),
  };

  closeAll();
  check('T14 write store closed', store.closed === true, { closed: store.closed });

  // ── 关库重开（readonly）：读数逐项一致 ────────────────────────────────
  const ro = openStore({ path: dbPath, mode: 'readonly' });
  const roCounts = ro.countArtifacts();
  const roList = ro.listArtifacts({ sourceId: SOURCE_ID });
  const roEvents = roList.items.map((a) => ro.listArtifactEvents({ artifactId: a.artifactId }).items.map((e) => ({
    eventId: e.eventId, action: e.action, fromStatus: e.fromStatus, toStatus: e.toStatus,
    bytes: e.bytes, sha256: e.sha256, createdAt: e.createdAt,
  })));
  const roSnapshot = {
    counts: roCounts,
    rows: roList.items.map((a) => ({
      artifactId: a.artifactId, relPath: a.relPath, kind: a.kind, title: a.title,
      producerSession: a.producerSession, producerTask: a.producerTask,
      status: a.status, bytes: a.bytes, sha256: a.sha256, metadata: a.metadata,
    })),
    events: roEvents,
  };
  check('T15 reopen (readonly) reproduces the same library state',
    JSON.stringify(roSnapshot) === JSON.stringify(snapshot)
      && roCounts.artifacts === 3 && roCounts.events === 6,
    { counts: roCounts });
  check('T16 readonly store refuses to migrate and stays unmodified',
    ro.state.ready === true && ro.mode === 'readonly', { mode: ro.mode, ready: ro.state.ready });
  closeAll();
  facts.reopened = { counts: roCounts, identical: JSON.stringify(roSnapshot) === JSON.stringify(snapshot) };

  // ── 正文不入库：扫库文件字节 + 表结构 ─────────────────────────────────
  const dbBytes = readFileSync(dbPath);
  const walPath = dbPath + '-wal';
  const walBytes = existsSync(walPath) ? readFileSync(walPath) : Buffer.alloc(0);
  const haystack = Buffer.concat([dbBytes, walBytes]).toString('utf8');
  const slices = [];
  for (const f of originals) {
    const text = f.text;
    for (const ratio of [0.1, 0.5, 0.9]) {
      const start = Math.max(0, Math.floor(text.length * ratio));
      const slice = text.slice(start, start + 60).replace(/\s+/g, ' ').trim();
      if (slice.length >= 20) slices.push({ file: f.name, slice });
    }
  }
  const leaked = slices.filter((s) => haystack.indexOf(s.slice) !== -1);
  check('T17 no artifact body text in the db file (' + slices.length + ' probes)',
    leaked.length === 0, { leaked, dbBytes: dbBytes.length, walBytes: walBytes.length });

  const ro2 = openStore({ path: dbPath, mode: 'readonly' });
  const artifactCols = ro2.db.prepare('pragma table_info(artifacts)').all().map((c) => c.name);
  const eventCols = ro2.db.prepare('pragma table_info(artifact_events)').all().map((c) => c.name);
  const bodyish = artifactCols.concat(eventCols).filter((c) => /content|body|text|raw/.test(c));
  check('T18 artifacts/artifact_events have no body-carrying column',
    bodyish.length === 0, { artifactCols, eventCols, bodyish });
  closeAll();
  facts.db = { path: dbPath, bytes: dbBytes.length, walBytes: walBytes.length, artifactCols, probes: slices.length };

  // ── 原文件未被改动 ────────────────────────────────────────────────────
  for (const f of originals) {
    const buf = readFileSync(f.origin);
    const after = { bytes: buf.length, sha256: sha256(buf), ...statOf(f.origin) };
    check('T19 original untouched: ' + f.name,
      after.bytes === f.before.bytes && after.sha256 === f.before.sha256 && after.mtimeMs === f.before.mtimeMs,
      { before: { bytes: f.before.bytes, mtimeMs: f.before.mtimeMs },
        after: { bytes: after.bytes, mtimeMs: after.mtimeMs } });
  }
}

let fatal = null;
try {
  main();
} catch (err) {
  fatal = err;
  console.log('FAIL  harness threw: ' + (err && err.stack ? err.stack : String(err)));
} finally {
  closeAll();
}

// ── 清理：删掉整个 tempRoot，并确认真的删干净 ──────────────────────────
let cleaned = false;
try {
  rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  cleaned = !existsSync(tempRoot);
} catch (err) {
  cleaned = false;
  console.log('cleanup error: ' + String(err && err.message ? err.message : err));
}
check('T20 temp workspace removed (db + copies + source root)', cleaned, { tempRoot, cleaned });

const failed = checks.filter((c) => !c.ok);
const summary = {
  ok: failed.length === 0 && !fatal,
  checks: { total: checks.length, failed: failed.map((c) => c.name) },
  files: facts.files,
  events: facts.events,
  db: facts.db,
  reopened: facts.reopened,
  cleanup: { tempRoot, removed: cleaned },
  elapsedMs: Date.now() - facts.startedAt,
};
console.log('\n=== SHADOW-ARTIFACT-REGISTRY SUMMARY ===');
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.ok ? 0 : 1;
