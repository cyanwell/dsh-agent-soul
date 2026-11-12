// src/db/store.mjs —— 元数据库的门面。外部只跟这个对象打交道。
//
// 生命周期：openMetaStore({ path, mode }) → store.migrate() → store.ingest(...) → store.close()
// 只读模式（mode: 'readonly'）永远不迁移；库没迁移就抛 MIGRATION_REQUIRED；
// 库比代码新（v99）时读和写都抛 SCHEMA_TOO_NEW —— 不降级、也不引导人去迁移。

import { openDatabase, configureConnection, engineInfo, assertEngine } from './engine.mjs';
import { readSchemaState, migrate as runMigrations } from './migrate.mjs';
import { ingestRecord, hashFrame } from './ingest.mjs';
import { parsePtr, makePtr, DSH_NAMESPACE, V4_NAMESPACE } from './ptr.mjs';
import { resolveFramePath } from './locator.mjs';
import { SCHEMA_VERSION, MIGRATIONS, rebuildFrameFts } from './schema.mjs';
import { searchFrames, buildQueryPlan, searchIndexInfoFor, SEARCH_MODES } from './search.mjs';
import {
  registerArtifact as doRegisterArtifact,
  getArtifact as doGetArtifact,
  listArtifacts as doListArtifacts,
  verifyArtifact as doVerifyArtifact,
  updateArtifact as doUpdateArtifact,
  listArtifactEvents as doListArtifactEvents,
  countArtifacts as doCountArtifacts,
  ARTIFACT_STATUSES,
  ARTIFACT_ACTIONS,
} from './artifacts.mjs';
import { relocateSource as doRelocateSource, listSourceRelocations as doListRelocations } from './relocate.mjs';
import { verifyPtrSample as verifySample } from './accept.mjs';
import { isStreamFingerprint } from './validate.mjs';
import { fail, CODES, translateSqliteError } from './errors.mjs';

function mapFrame(row) {
  // rawPath 在这里是「入库时的原始证据」；可回取的当前路径只在 resolvePtr 里算。
  return {
    sourceId: row.source_id,
    sessionId: row.session_id,
    seq: row.seq,
    rawPath: row.raw_path,
    rawRelPath: row.raw_rel_path === undefined ? null : row.raw_rel_path,
    frameOrdinal: row.frame_ordinal,
    authority: row.authority,
    ptr: row.ptr,
    snippet: row.snippet,
    snippetTruncated: row.snippet_truncated === 1 || row.snippet_truncated === true,
    contentHash: row.content_hash,
    type: row.type === undefined ? null : row.type,
    eventAt: row.event_at === undefined ? null : row.event_at,
    indexedAt: row.indexed_at,
  };
}

// fingerprintKind 是「读兼容」的显式标记（P1b 前置 2）：
//   'hex64'     本版本写进去的流身份（makeStreamFingerprint 的输出）
//   'legacy'    历史库里的自由字符串（'file-A' 之类）—— 只读兼容，新写不接受
//   'none'      NULL（从未记录过文件身份）
// 调用方拿它决定「这一行还要不要 reset 一次」，而不是自己去猜字符串形状。
function mapCursor(row) {
  const fp = row.file_fingerprint;
  return {
    sourceId: row.source_id,
    streamKey: row.stream_key,
    sessionId: row.session_id,
    nextSeq: row.next_seq,
    frameOrdinal: row.frame_ordinal,
    tailOffset: row.tail_offset,
    fileFingerprint: fp,
    fingerprintKind: fp === null || fp === undefined ? 'none' : (isStreamFingerprint(fp) ? 'hex64' : 'legacy'),
    tailState: row.tail_state,
    updatedAt: row.updated_at,
  };
}

function tooNewMessage(current) {
  return 'database schema v' + current + ' is newer than code v' + SCHEMA_VERSION + '; refusing to read or write (no silent downgrade)';
}

export function openMetaStore(options) {
  const o = options || {};
  const filePath = o.path;
  if (typeof filePath !== 'string' || filePath.length === 0) {
    fail(CODES.INVALID_INPUT, 'openMetaStore requires { path }', { path: filePath });
  }
  const mode = o.mode === undefined ? 'readwrite' : o.mode;
  if (mode !== 'readwrite' && mode !== 'readonly') {
    fail(CODES.INVALID_INPUT, "mode must be 'readwrite' or 'readonly'", { mode });
  }
  const readOnly = mode === 'readonly';
  const timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : 5000;
  const isMemory = filePath === ':memory:';
  const migrations = o.migrations || MIGRATIONS;

  const db = openDatabase(filePath, { readOnly });
  const pragmas = configureConnection(db, { readOnly, timeoutMs, memory: isMemory });
  const engine = engineInfo();

  let state = readSchemaState(db);

  if (!readOnly && o.migrateOnOpen === true && !state.ready && !state.tooNew) {
    try {
      runMigrations(db, { migrations, targetVersion: SCHEMA_VERSION });
    } catch (err) {
      throw translateSqliteError(err);
    }
    state = readSchemaState(db);
  }

  let closed = false;

  // info() 是排障入口，不该因为「还没迁移」而整体炸掉：算不出来就给 null（明确表示「不知道」）。
  function safeIndexInfo() {
    try {
      if (!state.ready) return null;
      return searchIndexInfoFor(db);
    } catch (_) {
      return null;
    }
  }

  const store = {
    path: filePath,
    mode,
    readOnly,
    db,
    pragmas,
    engine,
    migrations,
    get state() { return state; },
    get closed() { return closed; },

    refreshState() {
      state = readSchemaState(db);
      return state;
    },

    assertOpen() {
      if (closed) fail(CODES.STORE_CLOSED, 'store is closed', { path: filePath });
    },

    ensureReady() {
      store.assertOpen();
      if (state.ready) return;
      if (state.tooNew) {
        fail(CODES.SCHEMA_TOO_NEW, tooNewMessage(state.current), { current: state.current, expected: SCHEMA_VERSION, mode, tooNew: true });
      }
      if (state.historyBroken) {
        // O1：迁移史缺行时，库不是「ready」；读和写都必须报同一个明确错误。
        fail(CODES.MIGRATION_HISTORY_BROKEN, 'schema_migrations history is broken (applied: [' + state.applied.map(function (r) { return r.version; }).join(', ') + '], expected contiguous 1..' + SCHEMA_VERSION + '); refusing to read or write', {
          current: state.current,
          expected: SCHEMA_VERSION,
          applied: state.applied.map(function (r) { return r.version; }),
          missing: state.history ? state.history.missing : null,
          mode,
        });
      }
      fail(
        CODES.MIGRATION_REQUIRED,
        readOnly
          ? 'readonly store is not migrated (schema v' + state.current + ', expected v' + SCHEMA_VERSION + '); readonly connections never migrate'
          : 'store is not migrated (schema v' + state.current + ', expected v' + SCHEMA_VERSION + '); call store.migrate() explicitly',
        { current: state.current, expected: SCHEMA_VERSION, mode, tooNew: false },
      );
    },

    migrate(migrateOptions) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot migrate', { path: filePath });
      let result;
      try {
        result = runMigrations(db, Object.assign({ migrations, targetVersion: SCHEMA_VERSION }, migrateOptions || {}));
      } catch (err) {
        throw translateSqliteError(err);
      }
      state = readSchemaState(db);
      return result;
    },

    ingest(record) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot ingest', { path: filePath });
      store.ensureReady();
      try {
        return ingestRecord(db, record, { now: new Date().toISOString() });
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    resolvePtr(ptr) {
      store.assertOpen();
      store.ensureReady();
      const parsed = parsePtr(ptr);
      const source = db.prepare('select * from sources where namespace = ?').get(parsed.namespace);
      if (!source) {
        fail(CODES.PTR_UNKNOWN_NAMESPACE, 'no source owns namespace ' + parsed.namespace, { ptr, namespace: parsed.namespace });
      }
      const row = db.prepare(
        'select * from frame_index where source_id = ? and session_id = ? and seq = ?',
      ).get(source.source_id, parsed.sessionId, parsed.seq);
      if (!row) {
        fail(CODES.PTR_NOT_FOUND, 'no frame indexed for ' + ptr, { ptr, sourceId: source.source_id });
      }
      // ★ 定位认「现在」：当前 sources.raw_path + 相对路径 + frame_ordinal。
      //   raw_path（帧级）只作为原始证据回传，改名/搬目录后不会再把门牌钉在旧路径上。
      const resolved = resolveFramePath(source.raw_path, row.raw_rel_path, row.raw_path);
      return Object.assign({}, mapFrame(row), {
        namespace: parsed.namespace,
        sourceKind: source.kind,
        sourceRawPath: source.raw_path,
        rawPath: resolved.rawPath,
        rawPathAtIngest: row.raw_path,
        rawPathDrift: resolved.rawPathDrift,
        relocatable: resolved.relocatable,
        relocation: resolved.relocation,
      });
    },

    getCursor(sourceId, streamKey) {
      store.assertOpen();
      store.ensureReady();
      const row = db.prepare('select * from sync_cursors where source_id = ? and stream_key = ?').get(sourceId, streamKey);
      return row ? mapCursor(row) : null;
    },

    // ── P1b：检索 ────────────────────────────────────────────────────────
    // 语义：最终判定永远是「raw_text 的整串子串」，FTS 只是候选预筛。
    // 返回里带 candidates（预筛命中数）与 results（核实后的），两者之差就是被假阳性拦掉的量。
    search(query, options) {
      store.assertOpen();
      store.ensureReady();
      try {
        return searchFrames(db, query, options);
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    explainSearch(query) {
      store.assertOpen();
      return buildQueryPlan(query);
    },

    // FTS 行数与帧行数：两表必须逐行对齐，否则「写得进去 / 查不出来」。
    // ★ P1c：这个探针的实现搬进了 search.mjs（searchIndexInfoFor），因为 search 的闸也用它 ——
    //   「什么算对齐」只能有一条定义，两处各写一套迟早对不上。
    // ★ 它同时是查询前置：search() 在对齐失败时报 SEARCH_INDEX_STALE，不返回不完整结果。
    searchIndexInfo() {
      store.assertOpen();
      store.ensureReady();
      return searchIndexInfoFor(db);
    },

    // 修复面：把 FTS 表按 frame_index 重建一遍（重复执行不叠行）。
    rebuildSearchIndex() {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot rebuild the search index', { path: filePath });
      store.ensureReady();
      db.exec('BEGIN IMMEDIATE');
      try {
        const result = rebuildFrameFts(db);
        db.exec('COMMIT');
        return result;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch (_) { /* 可能已回滚 */ }
        throw translateSqliteError(err);
      }
    },

    // ── P1b：来源搬迁（独立动作，不依赖新帧） ─────────────────────────────
    relocateSource(sourceId, newRoot, expectedOldRoot) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot relocate a source', { path: filePath });
      store.ensureReady();
      try {
        return doRelocateSource(db, { sourceId, newRoot, expectedOldRoot });
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    listSourceRelocations(sourceId, options) {
      store.assertOpen();
      store.ensureReady();
      return doListRelocations(db, sourceId, options);
    },

    // ── P1b：P6 验收抽样（只读） ─────────────────────────────────────────
    verifyPtrSample(sample) {
      store.assertOpen();
      store.ensureReady();
      return verifySample(store, sample);
    },

    // ── P1c：产物元数据（v5） ─────────────────────────────────────────────
    // 读 = get/list/verify/events；写 = register/update。
    // verify 是纯只读（不写库、不碰文件）：它报磁盘的真话，状态要不要跟着走由调用方决定。

    registerArtifact(record, artifactOptions) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot register artifacts', { path: filePath });
      store.ensureReady();
      try {
        return doRegisterArtifact(db, record, artifactOptions || {});
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    updateArtifact(ref, patch, artifactOptions) {
      store.assertOpen();
      if (readOnly) fail(CODES.READONLY, 'readonly store cannot update artifacts', { path: filePath });
      store.ensureReady();
      try {
        return doUpdateArtifact(db, ref, patch, artifactOptions || {});
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    getArtifact(ref) {
      store.assertOpen();
      store.ensureReady();
      return doGetArtifact(db, ref);
    },

    listArtifacts(filter) {
      store.assertOpen();
      store.ensureReady();
      try {
        return doListArtifacts(db, filter);
      } catch (err) {
        throw translateSqliteError(err);
      }
    },

    verifyArtifact(ref) {
      store.assertOpen();
      store.ensureReady();
      return doVerifyArtifact(db, ref);
    },

    listArtifactEvents(ref, eventOptions) {
      store.assertOpen();
      store.ensureReady();
      return doListArtifactEvents(db, ref, eventOptions || {});
    },

    countArtifacts() {
      store.assertOpen();
      store.ensureReady();
      return doCountArtifacts(db);
    },

    listFrames(filter) {
      store.assertOpen();
      store.ensureReady();
      const f = filter || {};
      const limit = typeof f.limit === 'number' ? Math.max(1, Math.min(1000, Math.floor(f.limit))) : 50;
      const rows = db.prepare([
        'select * from frame_index',
        'where (? is null or source_id = ?) and (? is null or session_id = ?)',
        'order by seq asc limit ?',
      ].join(' ')).all(
        f.sourceId === undefined ? null : f.sourceId, f.sourceId === undefined ? null : f.sourceId,
        f.sessionId === undefined ? null : f.sessionId, f.sessionId === undefined ? null : f.sessionId,
        limit,
      );
      return rows.map(mapFrame);
    },

    countFrames(filter) {
      store.assertOpen();
      store.ensureReady();
      const f = filter || {};
      const row = db.prepare([
        'select count(*) as n from frame_index',
        'where (? is null or source_id = ?) and (? is null or session_id = ?)',
      ].join(' ')).get(
        f.sourceId === undefined ? null : f.sourceId, f.sourceId === undefined ? null : f.sourceId,
        f.sessionId === undefined ? null : f.sessionId, f.sessionId === undefined ? null : f.sessionId,
      );
      return row.n;
    },

    getSession(sourceId, sessionId) {
      store.assertOpen();
      store.ensureReady();
      const row = db.prepare('select * from sessions where source_id = ? and session_id = ?').get(sourceId, sessionId);
      if (!row) return null;
      return {
        sourceId: row.source_id,
        sessionId: row.session_id,
        containerId: row.container_id,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
      };
    },

    info() {
      store.assertOpen();
      return {
        path: filePath,
        mode,
        pragmas,
        engine,
        schema: { current: state.current, expected: SCHEMA_VERSION, ready: state.ready, tooNew: state.tooNew, historyBroken: state.historyBroken, applied: state.applied },
        search: { table: 'frame_fts', modes: SEARCH_MODES, indexedFrom: 'frame_index.snippet', aligned: safeIndexInfo() },
        artifacts: { table: 'artifacts', events: 'artifact_events', statuses: ARTIFACT_STATUSES, actions: ARTIFACT_ACTIONS },
        assertEngine: assertEngine(),
      };
    },

    close() {
      if (closed) return false;
      closed = true;
      db.close();
      return true;
    },
  };

  return store;
}

export { parsePtr, makePtr, hashFrame, DSH_NAMESPACE, V4_NAMESPACE, SCHEMA_VERSION, searchFrames };
