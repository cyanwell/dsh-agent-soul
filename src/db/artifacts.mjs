// src/db/artifacts.mjs —— P1c：产物元数据（v5）。register / list / get / verify + 只追加事件。
//
// 三条口径（只在这里写一次，调用点不许各写一套）：
//
//   1. **文件内容权威永远在原文件。** artifacts 只存 bytes 与 sha256，不复制正文。
//      「读产物」永远等于「去读那个文件」；这张表能重构、能对账，却不会变成第二份真相。
//
//   2. **定位只有一条**：source 根（sources.raw_path，认当前值）+ rel_path（正斜杠规范形式）。
//      路径安全有两道，缺一道都留口子：
//        运行时：relToSource() 归一 + realpath() 兜住符号链接/junction 逃逸 + 必须是普通文件；
//        库层：rel_path 的形状约束（禁绝对、禁反斜杠、禁 '.'/'..' 段、禁冒号）。
//      Windows 下比较 realpath 一律大小写不敏感（盘符与文件名都可能变大小写）。
//
//   3. **元数据可变、事件只追加**：artifact_events 上的 UPDATE / DELETE 由触发器 ABORT。
//      内容变化 → content-changed；标题/kind/生产者/metadata 变化 → metadata-updated；
//      状态变化 → status-changed。**同内容重放不新增事件**（只刷新 last_seen_at）。
//
// ★ artifact_id 由 (source_id, rel_path) 决定性派生（artifactIdFor），不是自增整数：
//   这样「整库按原路径重建」得到同一批 id，事件历史才对得上；自增 id 换一次库就全错位。
//
// ★ verifyArtifact 是**只读**的：不写库、不碰文件、不修状态。
//   它报的是「磁盘现在是什么样」，与 db.status（登记/更新时确认过的状态）分开回。
//   要让状态跟上磁盘，走 updateArtifact() —— 显式的写路径，不藏在读路径里。
//
// ★ 已知限制（写在这里，不是漏写）：
//   - 同一个文件若能从根内两条路径到达（真实目录 + 根内 junction），会产生两个 artifact
//     （rel_path 不同、内容相同）。表里没有 realpath 列，所以不去重；这是「一门牌一行」的取舍。
//   - sha256 是**文件字节**的 hash（不是解码后的文本），二进制产物与文本产物走同一条路。

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { fail, CODES } from './errors.mjs';
import { toPosix, relToSource, joinSourcePath } from './locator.mjs';
import { assertId, assertString } from './validate.mjs';

export const ARTIFACT_STATUSES = Object.freeze(['present', 'stale', 'missing']);
export const ARTIFACT_ACTIONS = Object.freeze(['registered', 'content-changed', 'status-changed', 'metadata-updated']);
export const ARTIFACT_TITLE_MAX = 512;
export const ARTIFACT_PRODUCER_MAX = 256;
export const ARTIFACT_METADATA_MAX = 8192;
export const ARTIFACT_PATH_MAX = 4096;
export const ARTIFACT_LIST_MAX = 500;

const KIND_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SHA_RE = /^[0-9a-f]{64}$/;

// ── 纯函数：id 派生、规范化、JSON 稳定化 ──────────────────────────────────

// 决定性 id：同一 (source_id, rel_path) 永远得到同一个 id。
export function artifactIdFor(sourceId, relPath) {
  const digest = createHash('sha256').update(String(sourceId) + '\n' + String(relPath), 'utf8').digest('hex');
  return 'art_' + digest.slice(0, 32);
}

function isWin() {
  return process.platform === 'win32';
}

function compareKey(value) {
  const s = toPosix(value).replace(/\/+$/, '');
  return isWin() ? s.toLowerCase() : s;
}

// targetReal 是否落在 rootReal 之内（含相等）。只做字符串边界判断，不碰磁盘。
export function isInsideRoot(rootReal, targetReal) {
  const root = compareKey(rootReal);
  const target = compareKey(targetReal);
  return target === root || target.indexOf(root + '/') === 0;
}

// 元数据的规范形态：键排序、undefined 丢弃、非 JSON 值转字符串。
// 目的只有一个 —— 让「同一份 metadata」逐字节相等，重放才能判定为 no-op。
function stableValue(value) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (t === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) continue;
      out[key] = stableValue(value[key]);
    }
    return out;
  }
  return String(value);
}

export function canonicalJson(value) {
  if (value === undefined || value === null) return null;
  const text = JSON.stringify(stableValue(value));
  if (text.length > ARTIFACT_METADATA_MAX) {
    fail(CODES.INVALID_INPUT, 'artifact metadata is too large (' + text.length + ' chars, max ' + ARTIFACT_METADATA_MAX + '); the DB stores routing metadata, not file contents', { length: text.length, max: ARTIFACT_METADATA_MAX });
  }
  return text;
}

function parseJson(text) {
  if (text === null || text === undefined) return null;
  try { return JSON.parse(text); } catch (_) { return null; }
}

// ── 路径解析（运行时第一道） ─────────────────────────────────────────────
//
// 返回结果对象，不抛异常：register 拿到 !ok 就 fail(code)，verify 拿到 !ok 就报 missing。
// 这样「文件不在了」在读路径上不是一个异常，而是一个可展示的状态。

function hashFile(absPath) {
  const buf = readFileSync(absPath);
  return { bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

export function resolveArtifactPath(sourceRoot, inputPath) {
  if (typeof sourceRoot !== 'string' || sourceRoot.length === 0) {
    return { ok: false, code: CODES.INVALID_INPUT, reason: 'source-root-missing' };
  }
  if (typeof inputPath !== 'string' || inputPath.length === 0) {
    return { ok: false, code: CODES.INVALID_INPUT, reason: 'path-missing' };
  }
  // relToSource：反斜杠/'.'/'..'/重复分隔符统一在这里处理，与帧定位是同一份实现。
  const relPath = relToSource(sourceRoot, inputPath);
  if (relPath === null) {
    return { ok: false, code: CODES.PATH_OUTSIDE_SOURCE_ROOT, reason: 'outside-root', sourceRoot, inputPath };
  }
  if (relPath === '') {
    return { ok: false, code: CODES.ARTIFACT_NOT_A_FILE, reason: 'path-names-the-source-root', sourceRoot, inputPath };
  }

  const absPath = joinSourcePath(sourceRoot, relPath);
  let stat;
  try {
    stat = statSync(absPath);
  } catch (err) {
    return { ok: false, code: CODES.ARTIFACT_FILE_MISSING, reason: 'missing', relPath, absPath, errno: err && err.code ? err.code : null };
  }

  // realpath 兜住符号链接 / junction：解析后的真实位置必须还在根内。
  let realPath = null;
  try {
    realPath = realpathSync(absPath);
  } catch (err) {
    return { ok: false, code: CODES.ARTIFACT_FILE_MISSING, reason: 'unreadable', relPath, absPath, errno: err && err.code ? err.code : null };
  }
  let rootReal = null;
  try {
    rootReal = realpathSync(sourceRoot);
  } catch (_) {
    rootReal = sourceRoot;
  }
  if (!isInsideRoot(rootReal, realPath)) {
    return {
      ok: false,
      code: CODES.ARTIFACT_PATH_ESCAPE,
      reason: 'symlink-escape',
      relPath,
      absPath,
      realPath,
      rootReal,
      hint: 'the path resolves (via a symlink or junction) outside the source root; metadata authority cannot live outside the root it is registered under',
    };
  }
  if (!stat.isFile()) {
    return { ok: false, code: CODES.ARTIFACT_NOT_A_FILE, reason: 'not-a-regular-file', relPath, absPath, realPath };
  }

  let hashed;
  try {
    hashed = hashFile(realPath);
  } catch (err) {
    return { ok: false, code: CODES.ARTIFACT_FILE_MISSING, reason: 'unreadable', relPath, absPath, realPath, errno: err && err.code ? err.code : null };
  }
  return {
    ok: true,
    relPath,
    absPath,
    realPath,
    rootReal,
    isFile: true,
    bytes: hashed.bytes,
    sha256: hashed.sha256,
  };
}

// ── 行映射 ───────────────────────────────────────────────────────────────

export function mapArtifact(row) {
  if (!row) return null;
  return {
    artifactId: row.artifact_id,
    sourceId: row.source_id,
    relPath: row.rel_path,
    kind: row.kind,
    title: row.title,
    producerSession: row.producer_session,
    producerTask: row.producer_task,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    status: row.status,
    bytes: row.bytes,
    sha256: row.sha256,
    metadata: parseJson(row.metadata_json),
    metadataJson: row.metadata_json,
    lastSeenAt: row.last_seen_at,
  };
}

function mapEvent(row) {
  return {
    eventId: row.event_id,
    artifactId: row.artifact_id,
    action: row.action,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    bytes: row.bytes,
    sha256: row.sha256,
    detail: parseJson(row.detail_json),
    detailJson: row.detail_json,
    createdAt: row.created_at,
  };
}

// ── 引用解析：{artifactId} | {sourceId,relPath} | 'art_...' ───────────────

export function normalizeArtifactRef(ref) {
  if (typeof ref === 'string' && ref.length > 0) return { artifactId: ref };
  if (ref && typeof ref === 'object') {
    if (typeof ref.artifactId === 'string' && ref.artifactId.length > 0) return { artifactId: ref.artifactId };
    if (typeof ref.sourceId === 'string' && ref.sourceId.length > 0 && typeof ref.relPath === 'string' && ref.relPath.length > 0) {
      // 与登记时同一份归一（分隔符/'.'/'..'）：'a\b' 与 'a/b' 必须指向同一个产物。
      const norm = relToSource('', ref.relPath);
      return { artifactId: artifactIdFor(ref.sourceId, norm === null ? ref.relPath : norm) };
    }
  }
  fail(CODES.INVALID_INPUT, 'artifact reference must be { artifactId } or { sourceId, relPath }', { ref });
  return null;
}

function readRow(db, ref) {
  const r = normalizeArtifactRef(ref);
  return db.prepare('select * from artifacts where artifact_id = ?').get(r.artifactId);
}

export function getArtifact(db, ref) {
  return mapArtifact(readRow(db, ref));
}

// ── 登记（幂等） ─────────────────────────────────────────────────────────
//
// outcome 只有五种，调用方按它分支，不要靠猜：
//   inserted          新建一行 + registered 事件
//   content-changed   内容变了（bytes/sha256）→ 更新内容 + content-changed 事件
//   metadata-updated  内容没变、元数据变了 → metadata-updated 事件（可能同时恢复状态）
//   status-recovered  内容没变、DB 状态从 missing/stale 回到 present → status-changed 事件
//   unchanged         逐项相同 → 只刷新 last_seen_at，**不新增任何事件**

function normalizeRegisterRecord(record) {
  if (!record || typeof record !== 'object') fail(CODES.INVALID_INPUT, 'registerArtifact requires a record', { record });
  const sourceId = assertId(record.sourceId, 'artifact.sourceId');
  if (typeof record.path !== 'string' || record.path.length === 0) {
    fail(CODES.INVALID_INPUT, 'artifact.path is required (absolute, or relative to the source root)', { path: record.path });
  }
  assertString(record.path, 'artifact.path', { min: 1, max: ARTIFACT_PATH_MAX, trim: false });
  const kind = record.kind === undefined ? 'file' : assertString(record.kind, 'artifact.kind', { min: 1, max: 32 });
  if (!KIND_RE.test(kind)) {
    fail(CODES.INVALID_INPUT, "invalid artifact.kind: must match " + String(KIND_RE) + ' (lowercase token)', { kind });
  }
  const title = record.title === undefined || record.title === null ? null : assertString(record.title, 'artifact.title', { min: 1, max: ARTIFACT_TITLE_MAX, trim: false });
  const producerSession = record.producerSession === undefined || record.producerSession === null
    ? null : assertString(record.producerSession, 'artifact.producerSession', { min: 1, max: ARTIFACT_PRODUCER_MAX });
  const producerTask = record.producerTask === undefined || record.producerTask === null
    ? null : assertString(record.producerTask, 'artifact.producerTask', { min: 1, max: ARTIFACT_PRODUCER_MAX, trim: false });
  return { sourceId, path: record.path, kind, title, producerSession, producerTask, metadataJson: canonicalJson(record.metadata) };
}

function insertEvent(db, row) {
  const info = db.prepare([
    'insert into artifact_events (artifact_id, action, from_status, to_status, bytes, sha256, detail_json, created_at)',
    'values (?, ?, ?, ?, ?, ?, ?, ?)',
  ].join(' ')).run(
    row.artifactId, row.action, row.fromStatus === undefined ? null : row.fromStatus,
    row.toStatus, row.bytes, row.sha256,
    row.detailJson === undefined ? null : row.detailJson, row.createdAt,
  );
  return Number(info.lastInsertRowid);
}

export function registerArtifact(db, record, options) {
  const o = options || {};
  const now = o.now || new Date().toISOString();
  const input = normalizeRegisterRecord(record);

  const source = db.prepare('select source_id, raw_path from sources where source_id = ?').get(input.sourceId);
  if (!source) {
    fail(CODES.SOURCE_NOT_FOUND, 'no source ' + input.sourceId + ' to register an artifact under; register the source (ingest a frame or insert sources) first', { sourceId: input.sourceId });
  }

  // 读文件 + 算 hash 放在事务之外：大文件不该把写事务按在手里。
  const resolved = resolveArtifactPath(source.raw_path, input.path);
  if (!resolved.ok) {
    fail(resolved.code, 'cannot register artifact: ' + resolved.reason + ' (' + input.path + ')', {
      sourceId: input.sourceId,
      path: input.path,
      sourceRoot: source.raw_path,
      reason: resolved.reason,
      absPath: resolved.absPath === undefined ? null : resolved.absPath,
      realPath: resolved.realPath === undefined ? null : resolved.realPath,
    });
  }

  const artifactId = artifactIdFor(input.sourceId, resolved.relPath);

  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('select * from artifacts where artifact_id = ?').get(artifactId);
    const events = [];
    let outcome;

    if (!existing) {
      db.prepare([
        'insert into artifacts (artifact_id, source_id, rel_path, kind, title, producer_session, producer_task,',
        '  created_at, updated_at, status, bytes, sha256, metadata_json, last_seen_at)',
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ].join(' ')).run(
        artifactId, input.sourceId, resolved.relPath, input.kind, input.title, input.producerSession, input.producerTask,
        now, now, 'present', resolved.bytes, resolved.sha256, input.metadataJson, now,
      );
      const eventId = insertEvent(db, {
        artifactId, action: 'registered', fromStatus: null, toStatus: 'present',
        bytes: resolved.bytes, sha256: resolved.sha256,
        detailJson: JSON.stringify({ kind: input.kind, title: input.title, relPath: resolved.relPath, realPath: resolved.realPath }),
        createdAt: now,
      });
      events.push({ action: 'registered', eventId });
      outcome = 'inserted';
    } else {
      const contentChanged = existing.bytes !== resolved.bytes || existing.sha256 !== resolved.sha256;
      const metaChanged = existing.kind !== input.kind
        || existing.title !== input.title
        || existing.producer_session !== input.producerSession
        || existing.producer_task !== input.producerTask
        || existing.metadata_json !== input.metadataJson;

      if (contentChanged) {
        db.prepare([
          'update artifacts set kind = ?, title = ?, producer_session = ?, producer_task = ?, metadata_json = ?,',
          '  bytes = ?, sha256 = ?, status = ?, updated_at = ?, last_seen_at = ?',
          'where artifact_id = ?',
        ].join(' ')).run(
          input.kind, input.title, input.producerSession, input.producerTask, input.metadataJson,
          resolved.bytes, resolved.sha256, 'present', now, now, artifactId,
        );
        const eventId = insertEvent(db, {
          artifactId, action: 'content-changed', fromStatus: existing.status, toStatus: 'present',
          bytes: resolved.bytes, sha256: resolved.sha256,
          detailJson: JSON.stringify({
            before: { bytes: existing.bytes, sha256: existing.sha256, status: existing.status, metadata: parseJson(existing.metadata_json) },
            after: { bytes: resolved.bytes, sha256: resolved.sha256, metadata: parseJson(input.metadataJson) },
            metadataChanged: metaChanged,
            relPath: resolved.relPath,
          }),
          createdAt: now,
        });
        events.push({ action: 'content-changed', eventId });
        outcome = 'content-changed';
      } else {
        // 内容一致：绝不新增内容事件。
        const needStatus = existing.status !== 'present';
        const needMeta = metaChanged;
        if (needMeta) {
          db.prepare([
            'update artifacts set kind = ?, title = ?, producer_session = ?, producer_task = ?, metadata_json = ?,',
            '  status = ?, updated_at = ?, last_seen_at = ?',
            'where artifact_id = ?',
          ].join(' ')).run(
            input.kind, input.title, input.producerSession, input.producerTask, input.metadataJson,
            'present', now, now, artifactId,
          );
          const eventId = insertEvent(db, {
            artifactId, action: 'metadata-updated', fromStatus: existing.status, toStatus: 'present',
            bytes: existing.bytes, sha256: existing.sha256,
            detailJson: JSON.stringify({
              before: { kind: existing.kind, title: existing.title, producerSession: existing.producer_session, producerTask: existing.producer_task, metadata: parseJson(existing.metadata_json) },
              after: { kind: input.kind, title: input.title, producerSession: input.producerSession, producerTask: input.producerTask, metadata: parseJson(input.metadataJson) },
              statusRecovered: needStatus,
            }),
            createdAt: now,
          });
          events.push({ action: 'metadata-updated', eventId });
          outcome = 'metadata-updated';
        } else if (needStatus) {
          db.prepare('update artifacts set status = ?, updated_at = ?, last_seen_at = ? where artifact_id = ?')
            .run('present', now, now, artifactId);
          const eventId = insertEvent(db, {
            artifactId, action: 'status-changed', fromStatus: existing.status, toStatus: 'present',
            bytes: existing.bytes, sha256: existing.sha256,
            detailJson: JSON.stringify({ reason: 'register-artifact-reconfirmed', relPath: resolved.relPath }),
            createdAt: now,
          });
          events.push({ action: 'status-changed', eventId });
          outcome = 'status-recovered';
        } else {
          // 严格重放：只刷新 last_seen_at（「这一份现在还在」），不碰 updated_at、不写事件。
          db.prepare('update artifacts set last_seen_at = ? where artifact_id = ?').run(now, artifactId);
          outcome = 'unchanged';
        }
      }
    }

    const row = db.prepare('select * from artifacts where artifact_id = ?').get(artifactId);
    db.exec('COMMIT');
    return {
      outcome,
      eventsAppended: events.length,
      events,
      artifact: mapArtifact(row),
      relPath: resolved.relPath,
      path: resolved.absPath,
      realPath: resolved.realPath,
      bytes: resolved.bytes,
      sha256: resolved.sha256,
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 可能已回滚 */ }
    throw err;
  }
}

// ── 元数据 / 状态更新（唯一的状态写路径，必须留事件） ────────────────────
//
// patch 允许：title / kind / producerSession / producerTask / metadata / status。
// 「值没变」不算一次变更 —— 不写行、不写事件（幂等）。status 只能在三种状态里选。

export const ARTIFACT_UPDATE_KEYS = Object.freeze(['title', 'kind', 'producerSession', 'producerTask', 'metadata', 'status']);

export function updateArtifact(db, ref, patch, options) {
  const o = options || {};
  const now = o.now || new Date().toISOString();
  if (!patch || typeof patch !== 'object') fail(CODES.INVALID_INPUT, 'updateArtifact requires a patch object', { patch });
  for (const key of Object.keys(patch)) {
    if (ARTIFACT_UPDATE_KEYS.indexOf(key) === -1) {
      fail(CODES.INVALID_INPUT, 'updateArtifact does not accept ' + key + '; allowed: ' + ARTIFACT_UPDATE_KEYS.join(', '), { key, allowed: ARTIFACT_UPDATE_KEYS });
    }
  }
  const existing = readRow(db, ref);
  if (!existing) fail(CODES.ARTIFACT_NOT_FOUND, 'no artifact for ' + JSON.stringify(ref), { ref });

  const next = {
    kind: existing.kind,
    title: existing.title,
    producer_session: existing.producer_session,
    producer_task: existing.producer_task,
    metadata_json: existing.metadata_json,
    status: existing.status,
  };
  if (patch.kind !== undefined) {
    assertString(patch.kind, 'artifact.kind', { min: 1, max: 32 });
    if (!KIND_RE.test(patch.kind)) fail(CODES.INVALID_INPUT, 'invalid artifact.kind: must match ' + String(KIND_RE), { kind: patch.kind });
    next.kind = patch.kind;
  }
  if (patch.title !== undefined) {
    next.title = patch.title === null ? null : assertString(patch.title, 'artifact.title', { min: 1, max: ARTIFACT_TITLE_MAX, trim: false });
  }
  if (patch.producerSession !== undefined) {
    next.producer_session = patch.producerSession === null ? null : assertString(patch.producerSession, 'artifact.producerSession', { min: 1, max: ARTIFACT_PRODUCER_MAX });
  }
  if (patch.producerTask !== undefined) {
    next.producer_task = patch.producerTask === null ? null : assertString(patch.producerTask, 'artifact.producerTask', { min: 1, max: ARTIFACT_PRODUCER_MAX, trim: false });
  }
  if (patch.metadata !== undefined) {
    next.metadata_json = canonicalJson(patch.metadata);
  }
  if (patch.status !== undefined) {
    if (typeof patch.status !== 'string' || ARTIFACT_STATUSES.indexOf(patch.status) === -1) {
      fail(CODES.ARTIFACT_STATUS_INVALID, 'artifact status must be one of ' + ARTIFACT_STATUSES.join('|'), { status: patch.status });
    }
    next.status = patch.status;
  }

  const changedFields = [];
  if (next.kind !== existing.kind) changedFields.push('kind');
  if (next.title !== existing.title) changedFields.push('title');
  if (next.producer_session !== existing.producer_session) changedFields.push('producerSession');
  if (next.producer_task !== existing.producer_task) changedFields.push('producerTask');
  if (next.metadata_json !== existing.metadata_json) changedFields.push('metadata');
  const statusChanged = next.status !== existing.status;

  if (changedFields.length === 0 && !statusChanged) {
    return { outcome: 'unchanged', eventsAppended: 0, events: [], artifact: mapArtifact(existing), changedFields: [] };
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare([
      'update artifacts set kind = ?, title = ?, producer_session = ?, producer_task = ?,',
      '  metadata_json = ?, status = ?, updated_at = ?',
      'where artifact_id = ?',
    ].join(' ')).run(
      next.kind, next.title, next.producer_session, next.producer_task,
      next.metadata_json, next.status, now, existing.artifact_id,
    );
    const events = [];
    if (changedFields.length > 0) {
      const eventId = insertEvent(db, {
        artifactId: existing.artifact_id, action: 'metadata-updated',
        fromStatus: existing.status, toStatus: next.status,
        bytes: existing.bytes, sha256: existing.sha256,
        detailJson: JSON.stringify({
          changed: changedFields,
          before: { kind: existing.kind, title: existing.title, producerSession: existing.producer_session, producerTask: existing.producer_task, metadata: parseJson(existing.metadata_json) },
          after: { kind: next.kind, title: next.title, producerSession: next.producer_session, producerTask: next.producer_task, metadata: parseJson(next.metadata_json) },
        }),
        createdAt: now,
      });
      events.push({ action: 'metadata-updated', eventId });
    }
    if (statusChanged) {
      const eventId = insertEvent(db, {
        artifactId: existing.artifact_id, action: 'status-changed',
        fromStatus: existing.status, toStatus: next.status,
        bytes: existing.bytes, sha256: existing.sha256,
        detailJson: JSON.stringify({ reason: 'explicit-update', changed: changedFields }),
        createdAt: now,
      });
      events.push({ action: 'status-changed', eventId });
    }
    const row = db.prepare('select * from artifacts where artifact_id = ?').get(existing.artifact_id);
    db.exec('COMMIT');
    return { outcome: changedFields.length > 0 ? 'metadata-updated' : 'status-changed', eventsAppended: events.length, events, artifact: mapArtifact(row), changedFields };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 可能已回滚 */ }
    throw err;
  }
}

// ── 校验（只读） ─────────────────────────────────────────────────────────
//
// state 是**磁盘的真话**：present / stale / missing。
// db.status 是**上一次确认过的状态**。两者不一致本身就是信号，不做自动修复。
export function verifyArtifact(db, ref) {
  const row = readRow(db, ref);
  if (!row) fail(CODES.ARTIFACT_NOT_FOUND, 'no artifact for ' + JSON.stringify(ref), { ref });
  const artifact = mapArtifact(row);
  const source = db.prepare('select raw_path from sources where source_id = ?').get(row.source_id);
  const sourceRoot = source ? source.raw_path : null;
  const base = {
    artifactId: artifact.artifactId,
    sourceId: artifact.sourceId,
    relPath: artifact.relPath,
    sourceRoot,
    db: {
      status: artifact.status,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      createdAt: artifact.createdAt,
      updatedAt: artifact.updatedAt,
      lastSeenAt: artifact.lastSeenAt,
    },
  };

  if (sourceRoot === null) {
    return Object.assign(base, {
      state: 'missing',
      path: null,
      checks: { pathSafe: false, exists: false, isFile: false, bytesMatch: false, sha256Match: false },
      disk: null,
      needsReregister: true,
      reason: 'source-not-found',
    });
  }

  const resolved = resolveArtifactPath(sourceRoot, artifact.relPath);
  if (!resolved.ok) {
    const state = 'missing';
    const pathSafe = resolved.code !== CODES.ARTIFACT_PATH_ESCAPE && resolved.code !== CODES.PATH_OUTSIDE_SOURCE_ROOT;
    return Object.assign(base, {
      state,
      path: resolved.absPath === undefined ? null : resolved.absPath,
      realPath: resolved.realPath === undefined ? null : resolved.realPath,
      checks: { pathSafe, exists: false, isFile: false, bytesMatch: false, sha256Match: false },
      disk: null,
      needsReregister: true,
      reason: resolved.reason,
      code: resolved.code,
    });
  }

  const bytesMatch = resolved.bytes === artifact.bytes;
  const sha256Match = resolved.sha256 === artifact.sha256;
  const state = sha256Match && bytesMatch ? 'present' : 'stale';
  return Object.assign(base, {
    state,
    path: resolved.absPath,
    realPath: resolved.realPath,
    checks: { pathSafe: true, exists: true, isFile: true, bytesMatch, sha256Match },
    disk: { bytes: resolved.bytes, sha256: resolved.sha256 },
    needsReregister: state !== 'present',
    reason: state === 'present' ? null : (sha256Match ? 'byte-count-differs' : 'content-differs'),
  });
}

// ── 列举 / 事件 ──────────────────────────────────────────────────────────

function clampLimit(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const n = Math.floor(value);
  if (n < 1) return 1;
  return n > ARTIFACT_LIST_MAX ? ARTIFACT_LIST_MAX : n;
}

export function listArtifacts(db, filter) {
  const f = filter || {};
  const limit = clampLimit(f.limit, 100);
  const offset = typeof f.offset === 'number' && f.offset > 0 ? Math.floor(f.offset) : 0;
  const sourceId = f.sourceId === undefined || f.sourceId === null ? null : String(f.sourceId);
  const kind = f.kind === undefined || f.kind === null ? null : String(f.kind);
  const status = f.status === undefined || f.status === null ? null : String(f.status);
  if (status !== null && ARTIFACT_STATUSES.indexOf(status) === -1) {
    fail(CODES.ARTIFACT_STATUS_INVALID, 'artifact status filter must be one of ' + ARTIFACT_STATUSES.join('|'), { status });
  }
  const prefix = f.prefix === undefined || f.prefix === null ? null : String(f.prefix);
  if (prefix !== null && prefix.indexOf('\\') !== -1) {
    fail(CODES.INVALID_INPUT, 'prefix must use forward slashes (rel paths are stored posix-normalized)', { prefix });
  }

  const where = [
    '(? is null or source_id = ?)',
    '(? is null or kind = ?)',
    '(? is null or status = ?)',
    "(? is null or substr(rel_path, 1, length(?)) = ?)",
  ].join(' and ');
  const args = [
    sourceId, sourceId,
    kind, kind,
    status, status,
    prefix, prefix, prefix,
  ];

  const total = db.prepare('select count(*) as n from artifacts where ' + where).get(...args).n;
  const rows = db.prepare('select * from artifacts where ' + where + ' order by source_id asc, rel_path asc limit ? offset ?')
    .all(...args, limit, offset);
  return { items: rows.map(mapArtifact), total, limit, offset };
}

export function listArtifactEvents(db, ref, options) {
  const o = options || {};
  const row = readRow(db, ref);
  if (!row) fail(CODES.ARTIFACT_NOT_FOUND, 'no artifact for ' + JSON.stringify(ref), { ref });
  const limit = clampLimit(o.limit, 100);
  const offset = typeof o.offset === 'number' && o.offset > 0 ? Math.floor(o.offset) : 0;
  const total = db.prepare('select count(*) as n from artifact_events where artifact_id = ?').get(row.artifact_id).n;
  const rows = db.prepare('select * from artifact_events where artifact_id = ? order by event_id asc limit ? offset ?')
    .all(row.artifact_id, limit, offset);
  return { artifactId: row.artifact_id, items: rows.map(mapEvent), total, limit, offset };
}

export function countArtifacts(db) {
  return {
    artifacts: db.prepare('select count(*) as n from artifacts').get().n,
    events: db.prepare('select count(*) as n from artifact_events').get().n,
    byStatus: db.prepare('select status, count(*) as n from artifacts group by status order by status').all(),
  };
}

// 便于断言 sha256 形状（测试与调用方共用一份判据）。
export function isArtifactSha256(value) {
  return typeof value === 'string' && SHA_RE.test(value);
}
