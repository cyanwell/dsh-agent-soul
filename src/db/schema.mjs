// src/db/schema.mjs —— P1a 的 schema 与迁移清单。
//
// 范围只做 P1a：schema_migrations / sources / sessions / frame_index / sync_cursors。
// 明确不做：FTS、artifacts、events / commands / receipts。
//
// ★ 迁移一旦发布，sql 文本就是只读历史：改它等于让已经写过库的机器 checksum 对不上，
//   migrate() 会直接报 MIGRATION_CHECKSUM_MISMATCH。要改结构只能追加新版本。
//   v1 的 SQL 因此一字未动；v2 只做「加列 + 回填 + 库层约束」。
//
// ★★ O3（v4-P1a 二次验证）：这里有**两个**不同的口径，报告与排障时别混称 ——
//   checksum(sql)         = sha256(sql 文本)，只是 v1 SQL 本身的指纹；
//   migrationDigest(m)    = sha256(version + '\n' + name + '\n' + sql)，才是 schema_migrations.checksum
//                           实际入库的值。拿 checksum(sql) 去对库必然对不上，不代表迁移被改过。
//
// ★★ v3（D1）：不改表结构，只用运行时同一个 relToSource() 重算所有行的 raw_rel_path。
//   v2 的回填是纯 SQL 前缀判断，只认 '/'；Windows 反斜杠路径的老行当时得到 NULL。
//   旧迁移 SQL 是只读历史，不能改写，所以向前新增 v3 做数据归一。

import { createHash } from 'node:crypto';
import { MIGRATION_011_SQL } from './migration-011.mjs';
import { MIGRATION_012_SQL } from './migration-012.mjs';
import { MIGRATION_013_SQL, backfillEchoContentClass } from './migration-013.mjs';
import { relToSource } from './locator.mjs';
import { ftsRowFor } from './search.mjs';

// v5（P1c）：产物元数据。只新增两张表 + 两个「事件只追加」触发器，
// 不碰 artifacts 之外的任何一张表，也不改 v1–v4 的 SQL 文本（digest 逐位不变，见 T54）。
// v6 (P2): SQLite-native append-only ledger; v1-v5 SQL/checksums remain immutable.
// v12（2026-11-18）：句子级窗口向量 —— 第二套向量层，与 v10 的长文本向量并存。
// v13：ECHO word dialogue/injection/other 分类；仅新增列与回填，不改历史导入文本。
export const SCHEMA_VERSION = 13;

export const BOOTSTRAP_SQL = [
  'CREATE TABLE IF NOT EXISTS schema_migrations (',
  '  version        INTEGER PRIMARY KEY,',
  '  name           TEXT NOT NULL,',
  '  checksum       TEXT NOT NULL,',
  '  applied_at     TEXT NOT NULL,',
  '  node_version   TEXT NOT NULL,',
  '  sqlite_version TEXT NOT NULL',
  ');',
].join('\n');

const MIGRATION_001_SQL = [
  '-- sources：一个可同步的数据来源（DSH 原文 / V4 镜像 / 以后的别的东西）。',
  '-- namespace 全局唯一 —— 它是 ptr 的第一段，也是"不许跨 source 做 seq 等价"的实现手段。',
  'CREATE TABLE sources (',
  '  source_id  TEXT PRIMARY KEY,',
  '  kind       TEXT NOT NULL,',
  '  namespace  TEXT NOT NULL UNIQUE,',
  '  authority  TEXT NOT NULL,',
  '  raw_path   TEXT NOT NULL,',
  '  path_kind  TEXT NOT NULL DEFAULT \'file\',',
  '  created_at TEXT NOT NULL,',
  '  updated_at TEXT NOT NULL,',
  '  meta_json  TEXT,',
  '  CHECK (length(source_id) > 0),',
  '  CHECK (length(namespace) > 0),',
  '  CHECK (kind IN (\'dsh-log\', \'v4-mirror\')),',
  '  CHECK (authority IN (\'primary\', \'mirror\')),',
  '  CHECK (path_kind IN (\'file\', \'dir\'))',
  ');',
  '',
  '-- sessions：source 内的会话容器。PK 是 (source_id, session_id) ——',
  '-- 同一个 session 在两个 source 里是两行，这是设计，不是重复。',
  'CREATE TABLE sessions (',
  '  source_id     TEXT NOT NULL,',
  '  session_id    TEXT NOT NULL,',
  '  container_id  TEXT,',
  '  first_seen_at TEXT NOT NULL,',
  '  last_seen_at  TEXT NOT NULL,',
  '  meta_json     TEXT,',
  '  PRIMARY KEY (source_id, session_id),',
  '  FOREIGN KEY (source_id) REFERENCES sources(source_id) ON DELETE CASCADE',
  ');',
  '',
  '-- frame_index：帧级索引。ptr 唯一；同 source 同 session 同 seq 只能有一行。',
  '-- raw_path + frame_ordinal 是可迁移的定位信息：换机器、换盘符后按序重读即可。',
  'CREATE TABLE frame_index (',
  '  source_id     TEXT NOT NULL,',
  '  session_id    TEXT NOT NULL,',
  '  seq           INTEGER NOT NULL,',
  '  raw_path      TEXT NOT NULL,',
  '  frame_ordinal INTEGER NOT NULL,',
  '  authority     TEXT NOT NULL,',
  '  ptr           TEXT NOT NULL UNIQUE,',
  '  snippet       TEXT NOT NULL,',
  '  content_hash  TEXT NOT NULL,',
  '  indexed_at    TEXT NOT NULL,',
  '  PRIMARY KEY (source_id, session_id, seq),',
  '  FOREIGN KEY (source_id, session_id) REFERENCES sessions(source_id, session_id) ON DELETE CASCADE,',
  '  CHECK (seq >= 0),',
  '  CHECK (frame_ordinal >= 0),',
  '  CHECK (authority IN (\'primary\', \'mirror\')),',
  '  CHECK (length(content_hash) = 64)',
  ');',
  '',
  'CREATE INDEX idx_frame_index_session ON frame_index (session_id, seq);',
  '',
  'CREATE INDEX idx_frame_index_hash ON frame_index (source_id, session_id, content_hash);',
  '',
  '-- sync_cursors：轮询续读点。frame_ordinal 是"最后一个已提交帧的序号"（空游标为 NULL），',
  '-- tail_offset 是文件里最后一个完整帧之后的字节偏移 —— 尾部半帧不推进它，只把 tail_state 标成 open。',
  'CREATE TABLE sync_cursors (',
  '  source_id        TEXT NOT NULL,',
  '  stream_key       TEXT NOT NULL,',
  '  session_id       TEXT,',
  '  next_seq         INTEGER NOT NULL DEFAULT 0,',
  '  frame_ordinal    INTEGER,',
  '  tail_offset      INTEGER NOT NULL DEFAULT 0,',
  '  file_fingerprint TEXT,',
  '  tail_state       TEXT NOT NULL DEFAULT \'closed\',',
  '  updated_at       TEXT NOT NULL,',
  '  PRIMARY KEY (source_id, stream_key),',
  '  FOREIGN KEY (source_id) REFERENCES sources(source_id) ON DELETE CASCADE,',
  '  CHECK (next_seq >= 0),',
  '  CHECK (frame_ordinal IS NULL OR frame_ordinal >= 0),',
  '  CHECK (tail_offset >= 0),',
  '  CHECK (tail_state IN (\'closed\', \'open\'))',
  ');',
].join('\n');

const MIGRATION_002_SQL = [
  '-- v2 补三件事（对应独立验证 C1 / C2 / C4 / C5）：',
  '--   1. 帧定位改成「当前 source 根 + 相对路径」：raw_rel_path 是定位，raw_path 降为原始证据。',
  '--   2. snippet 统一 4096 上限 + 显式 snippet_truncated（截断，不拒帧）。',
  '--   3. 补方案表里的 type / event_at；并用触发器把「log 命名空间只归 dsh-log/primary」',
  '--      从 JS 层推进到库层（任何直插、迁移脚本、手工修库都绕不过去）。',
  'ALTER TABLE frame_index ADD COLUMN raw_rel_path TEXT;',
  'ALTER TABLE frame_index ADD COLUMN type TEXT;',
  'ALTER TABLE frame_index ADD COLUMN event_at TEXT;',
  'ALTER TABLE frame_index ADD COLUMN snippet_truncated INTEGER NOT NULL DEFAULT 0;',
  '',
  '-- 老 v1 行回填相对路径：等于 source 根 → 空串；在其下 → 去前缀；',
  '-- 本身是相对路径 → 原样（约定为相对 source 根）；绝对但不在根下 → NULL（不可搬迁，读时退回证据）。',
  'UPDATE frame_index SET raw_rel_path = (',
  '  SELECT CASE',
  '    WHEN frame_index.raw_path = s.raw_path THEN \'\'',
  '    WHEN instr(frame_index.raw_path, s.raw_path || \'/\') = 1',
  '      THEN substr(frame_index.raw_path, length(s.raw_path) + 2)',
  '    WHEN instr(frame_index.raw_path, \':\') = 0 AND substr(frame_index.raw_path, 1, 1) <> \'/\'',
  '      THEN frame_index.raw_path',
  '    ELSE NULL',
  '  END',
  '  FROM sources s WHERE s.source_id = frame_index.source_id',
  ');',
  '',
  '-- 库层护栏 1：namespace = log 只能是 kind = dsh-log 且 authority = primary；',
  '-- 反过来，只有 log 能用 primary。V4 镜像（v4-mirror/mirror）不能占用或冒充 log。',
  'CREATE TRIGGER trg_sources_log_namespace_insert',
  'BEFORE INSERT ON sources',
  'WHEN (NEW.namespace = \'log\' AND (NEW.kind <> \'dsh-log\' OR NEW.authority <> \'primary\'))',
  '  OR (NEW.namespace <> \'log\' AND NEW.authority = \'primary\')',
  'BEGIN SELECT RAISE(ABORT, \'META_LOG_NAMESPACE_RESERVED\'); END;',
  '',
  'CREATE TRIGGER trg_sources_log_namespace_update',
  'BEFORE UPDATE OF namespace, kind, authority ON sources',
  'WHEN (NEW.namespace = \'log\' AND (NEW.kind <> \'dsh-log\' OR NEW.authority <> \'primary\'))',
  '  OR (NEW.namespace <> \'log\' AND NEW.authority = \'primary\')',
  'BEGIN SELECT RAISE(ABORT, \'META_LOG_NAMESPACE_RESERVED\'); END;',
  '',
  '-- 库层护栏 2：帧的 authority 必须与它所属 source 的 authority 一致（跨列约束，CHECK 表达不了）。',
  'CREATE TRIGGER trg_frame_authority_insert',
  'BEFORE INSERT ON frame_index',
  'WHEN NEW.authority IS NOT (SELECT authority FROM sources WHERE source_id = NEW.source_id)',
  'BEGIN SELECT RAISE(ABORT, \'META_FRAME_AUTHORITY_MISMATCH\'); END;',
  '',
  'CREATE TRIGGER trg_frame_authority_update',
  'BEFORE UPDATE OF source_id, authority ON frame_index',
  'WHEN NEW.authority IS NOT (SELECT authority FROM sources WHERE source_id = NEW.source_id)',
  'BEGIN SELECT RAISE(ABORT, \'META_FRAME_AUTHORITY_MISMATCH\'); END;',
].join('\n');

// v3 的 SQL 本身没有结构变更 —— 真正的工作在 after(db) 里，用运行时同一个归一函数重算。
const MIGRATION_003_SQL = [
  '-- v3（v4-P1a 二次验证 D1）：只做数据归一，不改表结构。',
  '--   v2 的 raw_rel_path 回填是纯 SQL 前缀判断，只认 \'/\'；Windows 反斜杠路径的老行得到 NULL。',
  '--   旧迁移 SQL 是只读历史，不能改写，所以向前修复：migrate() 在记录本版本之前',
  '--   调用 after(db)，用 locator.relToSource()（与 ingest 同一份实现）重算每一行的 raw_rel_path。',
  '--   根外帧按约定得到 NULL（不可搬迁），由 resolvePtr 报 relocatable:false + rawPathDrift:true。',
  '--   SQL 里保留一句无副作用的 SELECT，是为了让本文件仍然是一段可执行的迁移文本。',
  'SELECT 1;',
].join('\n');

// 迁移回填（D1）：逐行调用运行时归一函数，绝不在这里再写一套前缀判断。
export function backfillFrameRelPaths(db) {
  const rows = db.prepare([
    'select f.source_id, f.session_id, f.seq, f.raw_path, s.raw_path as source_raw_path',
    'from frame_index f join sources s on s.source_id = f.source_id',
    'order by f.source_id, f.session_id, f.seq',
  ].join(' ')).all();
  const update = db.prepare('update frame_index set raw_rel_path = ? where source_id = ? and session_id = ? and seq = ?');
  let updated = 0;
  let unrelocatable = 0;
  let normalized = 0;
  for (const row of rows) {
    const before = db.prepare('select raw_rel_path from frame_index where source_id = ? and session_id = ? and seq = ?')
      .get(row.source_id, row.session_id, row.seq).raw_rel_path;
    const rel = relToSource(row.source_raw_path, row.raw_path);
    if (rel === null) unrelocatable += 1;
    if (rel !== before) normalized += 1;
    update.run(rel, row.source_id, row.session_id, row.seq);
    updated += 1;
  }
  return { scanned: rows.length, updated, normalized, unrelocatable };
}

// ── v4（P1b）：检索面 + 来源搬迁审计 ───────────────────────────────────────
//
// 三件事，都在一次前向迁移里完成（不改 v1/v2/v3 的 SQL 文本）：
//   1. frame_fts：bigram FTS 表。rowid 与 frame_index.rowid 一一对应，
//      search_text 参与 MATCH（CJK 重叠二字 bigram + 小写整词），raw_text 是原文影子列，
//      **不参与 MATCH**，只供最终子串核实、高亮与片段回取。
//      tokenizer 固定 unicode61 remove_diacritics 0：它不做中文分词，正是我们要的 ——
//      中文由 search_text 里的 bigram 承担，ASCII 由它自己的词边界承担。
//   2. source_relocations：来源搬迁审计。任何对 sources.raw_path 的改动都留一行
//      （库层触发器），所以「搬了目录但没新帧」这件事本身可审计、不需要靠重放 no-op。
//   3. 回填：所有既有帧（v1/v2/v3 写进来的）在迁移时补上 FTS 行，rowid 与 frame 对齐。
//
// ★ 为什么 raw_text 存在表里而不是挂 content='frame_index'：
//   frame_index 没有 search_text 列，external-content FTS 会要求列名对得上；
//   而且 external content 的索引一旦与内容表漂移就没有信号。这里宁可多存一份 snippet 影子
//   （上限 4096，与 SNIPPET_MAX 同一口径），让「写得进去 / 查不出来」不可能静默发生。

const MIGRATION_004_SQL = [
  '-- v4（P1b）：检索面。',
  '--   frame_fts.rowid = frame_index.rowid；search_text 参与 MATCH，raw_text 只做原文核实。',
  'CREATE VIRTUAL TABLE frame_fts USING fts5(',
  '  search_text,',
  '  raw_text,',
  '  ptr UNINDEXED,',
  '  source_id UNINDEXED,',
  '  session_id UNINDEXED,',
  '  seq UNINDEXED,',
  "  tokenize='unicode61 remove_diacritics 0'",
  ');',
  '',
  '-- 来源搬迁审计：旧根 / 新根 / 那一刻有多少帧可搬迁、多少不可搬迁。',
  'CREATE TABLE source_relocations (',
  '  relocation_id    INTEGER PRIMARY KEY,',
  '  source_id        TEXT NOT NULL,',
  '  old_root         TEXT NOT NULL,',
  '  new_root         TEXT NOT NULL,',
  '  frames_total     INTEGER NOT NULL,',
  '  frames_relocatable INTEGER NOT NULL,',
  '  frames_unresolved  INTEGER NOT NULL,',
  '  at               TEXT NOT NULL,',
  '  FOREIGN KEY (source_id) REFERENCES sources(source_id) ON DELETE CASCADE,',
  '  CHECK (length(source_id) > 0),',
  '  CHECK (old_root <> new_root),',
  '  CHECK (frames_total >= 0 AND frames_relocatable >= 0 AND frames_unresolved >= 0)',
  ');',
  '',
  'CREATE INDEX idx_source_relocations_source ON source_relocations (source_id, at);',
  '',
  '-- 库层审计：不经过 relocateSource() 的手工 UPDATE 也会留痕。',
  '-- 「不可搬迁」的帧（raw_rel_path IS NULL）在搬家后依然钉在旧路径上，所以两个计数要分开。',
  'CREATE TRIGGER trg_sources_relocation_audit',
  'AFTER UPDATE OF raw_path ON sources',
  'WHEN NEW.raw_path IS NOT OLD.raw_path',
  'BEGIN',
  '  INSERT INTO source_relocations (source_id, old_root, new_root, frames_total, frames_relocatable, frames_unresolved, at)',
  '  SELECT NEW.source_id, OLD.raw_path, NEW.raw_path,',
  '    (SELECT count(*) FROM frame_index WHERE source_id = NEW.source_id),',
  '    (SELECT count(*) FROM frame_index WHERE source_id = NEW.source_id AND raw_rel_path IS NOT NULL),',
  '    (SELECT count(*) FROM frame_index WHERE source_id = NEW.source_id AND raw_rel_path IS NULL),',
  "    strftime('%Y-%m-%dT%H:%M:%fZ', 'now');",
  'END;',
].join('\n');

// ── v5（P1c）：产物元数据 + 只追加的产物事件 ─────────────────────────────
//
// 三条硬口径（写在这里，调用点不许各写一套）：
//   1. **文件内容权威永远在原文件**。artifacts 只存 bytes 与 sha256，不复制正文；
//      要正文就去读文件。所以这张表能重建、能对账，却不会变成第二份真相。
//   2. **定位只有一条**：source 根（sources.raw_path）+ rel_path（正斜杠规范形式）。
//      rel_path 的形态是库层约束（禁绝对、禁反斜杠、禁 '.'/'..' 段），
//      运行时还有 realpath 兜住符号链接/junction 逃逸 —— 两道都在，缺一道就留口子。
//   3. **元数据可变、事件只追加**：artifact_events 上的 UPDATE / DELETE 由触发器
//      RAISE(ABORT)。所以「改过一次」这件事本身不可抹除，只能再追加一行。
//
// ★ 为什么 artifact_events.artifact_id 只是普通外键（无 ON DELETE CASCADE）：
//   级联删除会要求「删事件」，而 DELETE 已被下面的触发器封死 —— 两者不能同时成立。
//   取舍是：宁可让「删产物行」这件事被外键挡住，也不让历史被一次级联悄悄抹掉。
//   v5 不提供删除产物的 API，这条只是库层兜底。
//
// ★ 为什么 artifact_id 是 TEXT 而不是 INTEGER：
//   它由 (source_id, rel_path) 决定性派生（artifactIdFor），所以「整库按原路径重建」
//   会得到同一批 id —— 事件历史才对得上。自增整数换一次库就全错位。

const MIGRATION_005_SQL = [
  '-- v5（P1c）：产物元数据（前向 v5）。',
  '--   权威是原文件；这里只有 bytes / sha256 / 生命周期 / 生产溯源。',
  'CREATE TABLE artifacts (',
  '  artifact_id      TEXT PRIMARY KEY,',
  '  source_id        TEXT NOT NULL,',
  '  rel_path         TEXT NOT NULL,',
  '  kind             TEXT NOT NULL,',
  '  title            TEXT,',
  '  producer_session TEXT,',
  '  producer_task    TEXT,',
  '  created_at       TEXT NOT NULL,',
  '  updated_at       TEXT NOT NULL,',
  '  status           TEXT NOT NULL,',
  '  bytes            INTEGER NOT NULL,',
  '  sha256           TEXT NOT NULL,',
  '  metadata_json    TEXT,',
  '  last_seen_at     TEXT NOT NULL,',
  '  UNIQUE (source_id, rel_path),',
  '  FOREIGN KEY (source_id) REFERENCES sources(source_id) ON DELETE CASCADE,',
  "  CHECK (length(artifact_id) > 0),",
  "  CHECK (length(rel_path) > 0),",
  "  CHECK (instr(rel_path, char(92)) = 0),",
  "  CHECK (instr(rel_path, ':') = 0),",
  "  CHECK (substr(rel_path, 1, 1) <> '/'),",
  "  CHECK (instr('/' || rel_path || '/', '/../') = 0),",
  "  CHECK (instr('/' || rel_path || '/', '/./') = 0),",
  "  CHECK (kind = lower(kind) AND length(kind) BETWEEN 1 AND 32),",
  "  CHECK (status IN ('present', 'stale', 'missing')),",
  '  CHECK (bytes >= 0),',
  '  CHECK (length(sha256) = 64),',
  "  CHECK (length(created_at) > 0 AND length(updated_at) > 0 AND length(last_seen_at) > 0)",
  ');',
  '',
  'CREATE INDEX idx_artifacts_status ON artifacts (status, updated_at);',
  '',
  'CREATE INDEX idx_artifacts_kind ON artifacts (kind);',
  '',
  '-- 只追加的事件账：注册 / 内容变化 / 元数据变化 / 状态变化。',
  '-- bytes/sha256 记的是**这次观测到的**值，变化前的旧值放在 detail_json 里。',
  'CREATE TABLE artifact_events (',
  '  event_id    INTEGER PRIMARY KEY,',
  '  artifact_id TEXT NOT NULL,',
  '  action      TEXT NOT NULL,',
  '  from_status TEXT,',
  '  to_status   TEXT NOT NULL,',
  '  bytes       INTEGER NOT NULL,',
  '  sha256      TEXT NOT NULL,',
  '  detail_json TEXT,',
  '  created_at  TEXT NOT NULL,',
  '  FOREIGN KEY (artifact_id) REFERENCES artifacts(artifact_id),',
  "  CHECK (length(artifact_id) > 0),",
  "  CHECK (action IN ('registered', 'content-changed', 'status-changed', 'metadata-updated')),",
  "  CHECK (from_status IS NULL OR from_status IN ('present', 'stale', 'missing')),",
  "  CHECK (to_status IN ('present', 'stale', 'missing')),",
  '  CHECK (bytes >= 0),',
  '  CHECK (length(sha256) = 64),',
  "  CHECK (length(created_at) > 0)",
  ');',
  '',
  'CREATE INDEX idx_artifact_events_artifact ON artifact_events (artifact_id, event_id);',
  '',
  '-- 库层护栏：事件行不可改、不可删（绕过 API 的手工 UPDATE / DELETE 一样被拒）。',
  'CREATE TRIGGER trg_artifact_events_no_update',
  'BEFORE UPDATE ON artifact_events',
  "BEGIN SELECT RAISE(ABORT, 'META_ARTIFACT_EVENTS_APPEND_ONLY'); END;",
  '',
  'CREATE TRIGGER trg_artifact_events_no_delete',
  'BEFORE DELETE ON artifact_events',
  "BEGIN SELECT RAISE(ABORT, 'META_ARTIFACT_EVENTS_APPEND_ONLY'); END;",
].join('\n');

// v4 回填：与运行时 ingest 用同一个 ftsRowFor()，绝不在这里另写一套变换。
// 顺序按 frame_index.rowid，插进去的 rowid 与帧一一对应；先删后插，重复执行不叠行。
export function backfillFrameFts(db) {
  const rows = db.prepare('select rowid as rid, ptr, source_id, session_id, seq, snippet from frame_index order by rowid').all();
  const del = db.prepare('delete from frame_fts where rowid = ?');
  const ins = db.prepare([
    'insert into frame_fts (rowid, search_text, raw_text, ptr, source_id, session_id, seq)',
    'values (?, ?, ?, ?, ?, ?, ?)',
  ].join(' '));
  let inserted = 0;
  let empty = 0;
  for (const row of rows) {
    // 注意：select 里 rowid 的别名是 rid —— ftsRowFor 要的是 rowid 字段，
    // 直接把别名原样传进去会得到 undefined 并让绑定失败（这一行就是这么被抓出来的）。
    const fts = ftsRowFor({
      rowid: row.rid,
      ptr: row.ptr,
      source_id: row.source_id,
      session_id: row.session_id,
      seq: row.seq,
      snippet: row.snippet,
    });
    del.run(fts.rowid);
    ins.run(fts.rowid, fts.searchText, fts.rawText, fts.ptr, fts.sourceId, fts.sessionId, fts.seq);
    if (fts.tokenCount === 0) empty += 1;
    inserted += 1;
  }
  return { scanned: rows.length, inserted, withoutTokens: empty };
}

// 运行时可用的重建入口（迁移之外的修复面：删过 FTS 行、或旧库补建）。
export function rebuildFrameFts(db) {
  return backfillFrameFts(db);
}

const MIGRATION_006_SQL = [
  '-- v6 prototype: native append-only Mo ledger inside the existing meta.sqlite.',
  'CREATE TABLE mo_ledger (',
  '  row_id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  t TEXT NOT NULL,',
  "  type TEXT NOT NULL CHECK (type IN ('lead','promise','fact','shelved','gain','loss','persona','container')) ,",
  '  text TEXT NOT NULL,',
  '  by TEXT NOT NULL CHECK (length(trim(by)) > 0),',
  '  actor_session TEXT,',
  '  ref TEXT,',
  '  feel TEXT,',
  '  by_user INTEGER NOT NULL DEFAULT 0 CHECK (by_user IN (0,1)),',
  '  legacy_line INTEGER UNIQUE,',
  '  legacy_raw TEXT,',
  '  CHECK (length(trim(text)) > 0)',
  ');',
  'CREATE INDEX idx_mo_ledger_type_row ON mo_ledger(type, row_id);',
  'CREATE INDEX idx_mo_ledger_by ON mo_ledger(by);',
  'CREATE INDEX idx_mo_ledger_actor ON mo_ledger(actor_session);',
  "CREATE TRIGGER mo_ledger_no_update BEFORE UPDATE ON mo_ledger BEGIN SELECT RAISE(ABORT, 'MO_APPEND_ONLY'); END;",
  "CREATE TRIGGER mo_ledger_no_delete BEFORE DELETE ON mo_ledger BEGIN SELECT RAISE(ABORT, 'MO_APPEND_ONLY'); END;",
  "CREATE TRIGGER mo_ledger_lead_requires_ref BEFORE INSERT ON mo_ledger WHEN NEW.type='lead' AND (NEW.ref IS NULL OR length(trim(NEW.ref))=0) BEGIN SELECT RAISE(ABORT, 'MO_LEAD_REF_REQUIRED'); END;",
  "CREATE TRIGGER mo_ledger_lead_generation BEFORE INSERT ON mo_ledger WHEN NEW.type='lead' AND NEW.text NOT LIKE '%第%代%' BEGIN SELECT RAISE(ABORT, 'MO_LEAD_GENERATION_REQUIRED'); END;",
  "CREATE TRIGGER mo_ledger_promise_gate BEFORE INSERT ON mo_ledger WHEN NEW.type='promise' BEGIN SELECT RAISE(ABORT, 'MO_NO_LEAD') WHERE NOT EXISTS (SELECT 1 FROM mo_ledger WHERE type='lead'); SELECT RAISE(ABORT, 'MO_NOT_CURRENT_LEAD') WHERE NEW.actor_session <> (SELECT actor_session FROM mo_ledger WHERE type='lead' ORDER BY row_id DESC LIMIT 1); SELECT RAISE(ABORT, 'MO_PROMISE_DELEGATED') WHERE NEW.by_user <> 0; END;",
].join('\n');

const MIGRATION_007_SQL = [
  '-- v7: compare full actor_session UUID, never display-prefix by.',
  'DROP TRIGGER IF EXISTS mo_ledger_promise_gate;',
  "CREATE TRIGGER mo_ledger_promise_gate BEFORE INSERT ON mo_ledger WHEN NEW.type='promise' BEGIN SELECT RAISE(ABORT, 'MO_NO_LEAD') WHERE NOT EXISTS (SELECT 1 FROM mo_ledger WHERE type='lead'); SELECT RAISE(ABORT, 'MO_ACTOR_REQUIRED') WHERE NEW.actor_session IS NULL OR length(trim(NEW.actor_session))=0; SELECT RAISE(ABORT, 'MO_NOT_CURRENT_LEAD') WHERE NEW.actor_session <> (SELECT actor_session FROM mo_ledger WHERE type='lead' ORDER BY row_id DESC LIMIT 1); SELECT RAISE(ABORT, 'MO_PROMISE_DELEGATED') WHERE NEW.by_user <> 0; END;",
].join('\n');

// ── v8：导入溯源（批次表 + 每行批次链接 + 只追加护栏）──────────────────────
//
// v6/v7 给导入器留了两个**结构**缺口（tools/mo-ledger-import.mjs 的注释里写着，本迁移把它们补上）：
//   1. legacy_line 在 v6 是**列级全局 UNIQUE** ⇒ 一个库只装得下一份源文件。
//      多源导入要的是 UNIQUE(import_batch_id, legacy_line)。SQLite 删不掉列级约束，
//      只能整表重建（12-step）—— 这就是本迁移必须 rebuild mo_ledger 的唯一原因。
//   2. 导入行 actor_session 恒 NULL（契约，绝不从 by 反推）⇒ v6/v7 的 promise 闸门
//      与 lead 的 ref/代次约束会**拒掉全部历史 lead/promise**。v8 的做法不是伪造豁免，
//      而是把语义说清：**导入行是溯源，不是「现在」**。
//
// 三条硬口径（写在这里，别处不许各写一套）：
//   · 重建必须**逐位保住** row_id、全部旧字段、全部旧数据、三个旧索引、五个旧触发器。
//     少一个就等于把 v6/v7 砌起来的库层护栏拆了 —— 重建不是「顺手升级」。
//   · **当前主导只认本机写入的 lead**（import_batch_id IS NULL）。历史 lead 行永远
//     不参与「谁是主导」的判定，因此也被排除在 promise 闸门的比较对象之外。
//   · 导入行必须**自证完整**：带批次、无 actor、legacy_line / legacy_raw 都不为空。
//     反过来，带 legacy_line 的写入必须挂批次 —— 不接受「半个溯源行」。
//
// ★ 为什么先建表再 DROP 而不是 UPDATE 旧表：append-only 触发器封死了 mo_ledger 的
//   UPDATE / DELETE（v6 的设计）。重建走的是「新表 INSERT + DROP 旧表」，不碰这两条闸门。

const MIGRATION_008_SQL = [
  '-- v8（导入溯源）：批次表 + mo_ledger 重建（UNIQUE(import_batch_id, legacy_line)）+ 只追加护栏。',
  '--   重建保留 row_id 与全部旧字段/数据/索引/触发器；唯一被拆掉的是 legacy_line 的列级全局 UNIQUE。',
  '',
  'CREATE TABLE mo_import_batches (',
  '  batch_id       INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  source_path    TEXT NOT NULL,',
  "  source_sha256  TEXT NOT NULL UNIQUE,",
  '  source_bytes   INTEGER NOT NULL CHECK (source_bytes >= 0),',
  '  physical_lines INTEGER NOT NULL CHECK (physical_lines >= 0),',
  '  blank_lines    INTEGER NOT NULL CHECK (blank_lines >= 0),',
  '  rows_imported  INTEGER NOT NULL CHECK (rows_imported > 0),',
  '  imported_at    TEXT NOT NULL,',
  '  importer       TEXT NOT NULL,',
  '  CHECK (length(source_sha256) = 64),',
  "  CHECK (length(trim(source_path)) > 0),",
  "  CHECK (length(trim(importer)) > 0),",
  '  CHECK (blank_lines <= physical_lines),',
  '  CHECK (rows_imported <= physical_lines)',
  ');',
  '',
  '-- 只追加：批次凭据写完就改不了、也删不掉（绕过导入器的手工 UPDATE / DELETE 一样被拒）。',
  "CREATE TRIGGER mo_import_batches_no_update BEFORE UPDATE ON mo_import_batches BEGIN SELECT RAISE(ABORT, 'MO_IMPORT_BATCH_APPEND_ONLY'); END;",
  "CREATE TRIGGER mo_import_batches_no_delete BEFORE DELETE ON mo_import_batches BEGIN SELECT RAISE(ABORT, 'MO_IMPORT_BATCH_APPEND_ONLY'); END;",
  '',
  '-- 12-step 重建第 1 步：新表（列序与 v6 一致，末尾多一个 import_batch_id）。',
  'CREATE TABLE mo_ledger_v8 (',
  '  row_id INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  t TEXT NOT NULL,',
  "  type TEXT NOT NULL CHECK (type IN ('lead','promise','fact','shelved','gain','loss','persona','container')),",
  '  text TEXT NOT NULL,',
  '  by TEXT NOT NULL CHECK (length(trim(by)) > 0),',
  '  actor_session TEXT,',
  '  ref TEXT,',
  '  feel TEXT,',
  '  by_user INTEGER NOT NULL DEFAULT 0 CHECK (by_user IN (0,1)),',
  '  legacy_line INTEGER,',
  '  legacy_raw TEXT,',
  '  import_batch_id INTEGER REFERENCES mo_import_batches(batch_id),',
  '  CHECK (length(trim(text)) > 0),',
  '  UNIQUE (import_batch_id, legacy_line)',
  ');',
  '',
  '-- 逐行复制：row_id 显式带入（AUTOINCREMENT 会把 sqlite_sequence 推到 max(row_id)）。',
  'INSERT INTO mo_ledger_v8 (row_id, t, type, text, by, actor_session, ref, feel, by_user, legacy_line, legacy_raw)',
  '  SELECT row_id, t, type, text, by, actor_session, ref, feel, by_user, legacy_line, legacy_raw FROM mo_ledger;',
  '',
  'DROP TABLE mo_ledger;',
  'ALTER TABLE mo_ledger_v8 RENAME TO mo_ledger;',
  '',
  '-- 旧索引逐个重建（DROP TABLE 会把它们一起带走）。',
  'CREATE INDEX idx_mo_ledger_type_row ON mo_ledger(type, row_id);',
  'CREATE INDEX idx_mo_ledger_by ON mo_ledger(by);',
  'CREATE INDEX idx_mo_ledger_actor ON mo_ledger(actor_session);',
  'CREATE INDEX idx_mo_ledger_import_batch ON mo_ledger(import_batch_id, legacy_line);',
  '',
  '-- 旧触发器逐个重建，语义只加不减。',
  "CREATE TRIGGER mo_ledger_no_update BEFORE UPDATE ON mo_ledger BEGIN SELECT RAISE(ABORT, 'MO_APPEND_ONLY'); END;",
  "CREATE TRIGGER mo_ledger_no_delete BEFORE DELETE ON mo_ledger BEGIN SELECT RAISE(ABORT, 'MO_APPEND_ONLY'); END;",
  '',
  '-- lead 的 ref / 代次约束只约束**本机写入**的 lead；历史 lead 行免检（它们不参与权威判定）。',
  "CREATE TRIGGER mo_ledger_lead_requires_ref BEFORE INSERT ON mo_ledger WHEN NEW.type='lead' AND NEW.import_batch_id IS NULL AND (NEW.ref IS NULL OR length(trim(NEW.ref))=0) BEGIN SELECT RAISE(ABORT, 'MO_LEAD_REF_REQUIRED'); END;",
  "CREATE TRIGGER mo_ledger_lead_generation BEFORE INSERT ON mo_ledger WHEN NEW.type='lead' AND NEW.import_batch_id IS NULL AND NEW.text NOT LIKE '%第%代%' BEGIN SELECT RAISE(ABORT, 'MO_LEAD_GENERATION_REQUIRED'); END;",
  '',
  '-- promise 闸门（v7 的全量 UUID 口径）+ v8 的权威口径：',
  '--   只比较 import_batch_id IS NULL 的 lead —— 导入进来的历史 lead 永远不是「当前主导」。',
  '--   导入行本身（import_batch_id IS NOT NULL）不进这道闸门：它们没有 actor_session，也不产生承诺。',
  "CREATE TRIGGER mo_ledger_promise_gate BEFORE INSERT ON mo_ledger WHEN NEW.type='promise' AND NEW.import_batch_id IS NULL BEGIN SELECT RAISE(ABORT, 'MO_NO_LEAD') WHERE NOT EXISTS (SELECT 1 FROM mo_ledger WHERE type='lead' AND import_batch_id IS NULL); SELECT RAISE(ABORT, 'MO_ACTOR_REQUIRED') WHERE NEW.actor_session IS NULL OR length(trim(NEW.actor_session))=0; SELECT RAISE(ABORT, 'MO_NOT_CURRENT_LEAD') WHERE NEW.actor_session <> (SELECT actor_session FROM mo_ledger WHERE type='lead' AND import_batch_id IS NULL ORDER BY row_id DESC LIMIT 1); SELECT RAISE(ABORT, 'MO_PROMISE_DELEGATED') WHERE NEW.by_user <> 0; END;",
  '',
  '-- 导入行自证完整：带批次的行不许有 actor_session（契约：绝不从 8 字符 by 反推）。',
  "CREATE TRIGGER mo_ledger_import_no_actor BEFORE INSERT ON mo_ledger WHEN NEW.import_batch_id IS NOT NULL AND NEW.actor_session IS NOT NULL BEGIN SELECT RAISE(ABORT, 'MO_IMPORT_ACTOR_FORBIDDEN'); END;",
  '-- 导入行必须能逐字节回到源文件那一物理行：批次 + 行号 + 原文缺一不可。',
  "CREATE TRIGGER mo_ledger_import_rows_complete BEFORE INSERT ON mo_ledger WHEN NEW.import_batch_id IS NOT NULL AND (NEW.legacy_line IS NULL OR NEW.legacy_raw IS NULL) BEGIN SELECT RAISE(ABORT, 'MO_IMPORT_ROW_INCOMPLETE'); END;",
  '-- 反过来：带 legacy_line 的写入必须挂批次（不接受「半个溯源行」）。',
  "CREATE TRIGGER mo_ledger_import_batch_required BEFORE INSERT ON mo_ledger WHEN NEW.import_batch_id IS NULL AND NEW.legacy_line IS NOT NULL BEGIN SELECT RAISE(ABORT, 'MO_IMPORT_BATCH_REQUIRED'); END;",
].join('\n');


// ── v9：ECHO 派生索引（words / summaries）───────────────────────────────────
//
// 这一版只**新增**表面，不改 v1–v8 任何一个字节（digest 逐位不变，见 selftest 的 I 段）：
// 派生索引与帧索引平级、互不冒充。
//
// 三条硬口径（写在这里，别处不许各写一套）：
//
//   1. **派生索引不是帧。** ECHO 的 words / summaries 绝不进 frame_index：
//      · 表分开（echo_words / echo_summaries），FTS 分开（echo_words_fts / echo_summaries_fts）；
//      · 指针命名空间分开（idx: 只指向摘要），并且 frame_index 上有一条库层触发器
//        拒绝 idx: 前缀的 ptr —— 想混进去得先删掉这条触发器，那本身会留下痕迹。
//   2. **来源身份 = 全规范路径 + 版本**（UNIQUE(source_path, source_version)）。
//      同一个 session id 在 v3 与 v4 两份流里各有一行、各归各的路径 —— 这是设计，不是重复。
//      于是「同一个 sid+seq 命中两条」是**可表达的常态**，解析器必须报 AMBIGUOUS 而不是挑一个。
//   3. **摘要只是索引，指针必须完整**：srcSeqs 按源顺序逐条落在 echo_summary_src_seqs，
//      不去重、不排序、不截断（源侧 Capped 标记不是权威）。摘要行同时保存源清单 full_json 原文。
//
// ★ cursor / state 与构建审计分两处写：
//   游标与 state 是**当前值**（echo_index_sources 一行），构建记录是**只追加的历史**
//   （echo_source_builds）。二者在同一个事务里写 ⇒「回滚后库里看不见任何一半」是库层事实。
//
// ★ 推理（reasoning）**不进索引**：库层 CHECK 直接拒掉 kind/role = reasoning|thinking 的行。
//   这道闸放在 CHECK 而不是放在导入器里，是为了「绕过导入器的手工 INSERT 也写得进去」这种
//   情况不存在 —— 它不该存在。
//
// ★ src_seq_count 是**审计列**（不是完整性约束）：库层不强制它等于子表行数
//   （子表按 ord 逐行写，触发器无法在 INSERT 途中已知最终行数）。等值由导入器在
//   同一个事务里断言，并由 CLI 的 verifyEchoIntegrity() 复核 —— 漂移会被抓住，不会静默。

const MIGRATION_009_SQL = [
  '-- v9（ECHO 派生索引）：来源表 + words + summaries + 有序 srcSeqs + 两张 FTS + 构建审计。',
  '',
  '-- 一个「ECHO 索引来源」= 全规范路径 + 索引格式版本。generation 只增不减。',
  'CREATE TABLE echo_index_sources (',
  '  echo_source_id  TEXT PRIMARY KEY,',
  '  source_path     TEXT NOT NULL,',
  '  source_version  TEXT NOT NULL,',
  "  namespace       TEXT NOT NULL CHECK (namespace IN ('log', 'v4log')),",
  '  generation      INTEGER NOT NULL CHECK (generation >= 1),',
  "  state           TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'failed')),",
  '  cursor_seq      INTEGER NOT NULL CHECK (cursor_seq >= 0),',
  '  cursor_json     TEXT NOT NULL,',
  '  words_count     INTEGER NOT NULL CHECK (words_count >= 0),',
  '  summaries_count INTEGER NOT NULL CHECK (summaries_count >= 0),',
  '  src_seq_count   INTEGER NOT NULL CHECK (src_seq_count >= 0),',
  '  source_sha256   TEXT NOT NULL CHECK (length(source_sha256) = 64),',
  '  source_bytes    INTEGER NOT NULL CHECK (source_bytes >= 0),',
  '  built_at        TEXT NOT NULL CHECK (length(built_at) > 0),',
  '  imported_at     TEXT NOT NULL CHECK (length(imported_at) > 0),',
  '  importer        TEXT NOT NULL CHECK (length(trim(importer)) > 0),',
  '  UNIQUE (source_path, source_version),',
  '  CHECK (length(source_path) > 0),',
  '  CHECK (instr(source_path, char(92)) = 0),',
  "  CHECK (substr(source_path, 1, 1) = '/' OR source_path GLOB '[A-Za-z]:/*'),",
  '  CHECK (length(source_version) > 0)',
  ');',
  '',
  'CREATE INDEX idx_echo_sources_ns ON echo_index_sources (namespace, source_path);',
  '',
  '-- words：ECHO 侧字段**原样**入库（t/session/ws/seq/turn/log/role/kind/len/truncated/text）。',
  '-- word_ord 是这一代里的稳定序号（0 起）；src_line 是源文件物理行号（1 起）。',
  'CREATE TABLE echo_words (',
  '  echo_source_id TEXT NOT NULL,',
  '  word_ord       INTEGER NOT NULL CHECK (word_ord >= 0),',
  '  src_line       INTEGER NOT NULL CHECK (src_line >= 1),',
  '  t              TEXT NOT NULL CHECK (length(t) > 0),',
  '  session        TEXT NOT NULL CHECK (length(session) > 0),',
  '  ws             TEXT,',
  '  seq            INTEGER NOT NULL CHECK (seq >= 0),',
  '  turn           INTEGER,',
  '  log            TEXT,',
  '  role           TEXT NOT NULL CHECK (length(role) > 0),',
  '  kind           TEXT NOT NULL CHECK (length(kind) > 0),',
  '  len            INTEGER NOT NULL CHECK (len >= 0),',
  '  truncated      INTEGER NOT NULL CHECK (truncated IN (0, 1)),',
  '  text           TEXT NOT NULL CHECK (length(text) > 0),',
  '  content_hash   TEXT NOT NULL CHECK (length(content_hash) = 64),',
  '  PRIMARY KEY (echo_source_id, word_ord),',
  '  -- 同一来源内 (session, seq) 必须唯一：否则 log:<sid>#seq 在单一来源里就有两个答案。',
  '  UNIQUE (echo_source_id, session, seq),',
  '  FOREIGN KEY (echo_source_id) REFERENCES echo_index_sources(echo_source_id) ON DELETE CASCADE,',
  "  CHECK (kind NOT IN ('reasoning', 'thinking') AND role NOT IN ('reasoning', 'thinking'))",
  ');',
  '',
  'CREATE INDEX idx_echo_words_session ON echo_words (echo_source_id, session, seq);',
  '',
  'CREATE INDEX idx_echo_words_kind ON echo_words (echo_source_id, kind);',
  '',
  '-- summaries：一条压缩摘要。cmp_id 是 ECHO 的 idx: 目标；status 可为 active | void（吊销=追加，不删）。',
  'CREATE TABLE echo_summaries (',
  '  echo_source_id  TEXT NOT NULL,',
  '  cmp_id          TEXT NOT NULL CHECK (length(cmp_id) > 0),',
  '  ord             INTEGER NOT NULL CHECK (ord >= 0),',
  '  src_line        INTEGER NOT NULL CHECK (src_line >= 1),',
  '  t               TEXT NOT NULL CHECK (length(t) > 0),',
  '  session         TEXT NOT NULL CHECK (length(session) > 0),',
  '  ws              TEXT,',
  '  log             TEXT,',
  '  shadowed_tokens INTEGER NOT NULL CHECK (shadowed_tokens >= 0),',
  '  shadowed_chars  INTEGER NOT NULL CHECK (shadowed_chars >= 0),',
  '  provider        TEXT,',
  '  model           TEXT,',
  "  status          TEXT NOT NULL CHECK (status IN ('active', 'void')),",
  '  summary         TEXT NOT NULL CHECK (length(summary) > 0),',
  '  full_json       TEXT NOT NULL CHECK (length(full_json) > 0),',
  '  src_seq_count   INTEGER NOT NULL CHECK (src_seq_count >= 0),',
  '  content_hash    TEXT NOT NULL CHECK (length(content_hash) = 64),',
  '  PRIMARY KEY (echo_source_id, cmp_id),',
  '  FOREIGN KEY (echo_source_id) REFERENCES echo_index_sources(echo_source_id) ON DELETE CASCADE',
  ');',
  '',
  'CREATE INDEX idx_echo_summaries_session ON echo_summaries (echo_source_id, session, t);',
  '',
  'CREATE INDEX idx_echo_summaries_status ON echo_summaries (echo_source_id, status);',
  '',
  '-- 有序子表：srcSeqs 的**原顺序**就是 ord。允许重复 seq（源里重复不是我们该修的事），',
  '-- 所以唯一键是 (echo_source_id, cmp_id, ord)，不是 seq。',
  'CREATE TABLE echo_summary_src_seqs (',
  '  echo_source_id TEXT NOT NULL,',
  '  cmp_id         TEXT NOT NULL,',
  '  ord            INTEGER NOT NULL CHECK (ord >= 0),',
  '  seq            INTEGER NOT NULL CHECK (seq >= 0),',
  '  PRIMARY KEY (echo_source_id, cmp_id, ord),',
  '  FOREIGN KEY (echo_source_id, cmp_id) REFERENCES echo_summaries(echo_source_id, cmp_id) ON DELETE CASCADE',
  ');',
  '',
  'CREATE INDEX idx_echo_src_seqs_seq ON echo_summary_src_seqs (echo_source_id, seq);',
  '',
  '-- FTS：与 frame_fts 同一套写法（自带 raw_text 影子列，不做 external-content）。',
  '-- 对齐不靠 rowid（派生索引整体替换，rowid 会变），靠 (echo_source_id, word_ord / cmp_id) 列连接。',
  'CREATE VIRTUAL TABLE echo_words_fts USING fts5(',
  '  search_text,',
  '  raw_text,',
  '  echo_source_id UNINDEXED,',
  '  word_ord UNINDEXED,',
  '  session UNINDEXED,',
  '  seq UNINDEXED,',
  "  tokenize='unicode61 remove_diacritics 0'",
  ');',
  '',
  'CREATE VIRTUAL TABLE echo_summaries_fts USING fts5(',
  '  search_text,',
  '  raw_text,',
  '  echo_source_id UNINDEXED,',
  '  cmp_id UNINDEXED,',
  "  tokenize='unicode61 remove_diacritics 0'",
  ');',
  '',
  '-- 构建审计：只追加。同一来源同一代只能有一条 —— 重复导入同一代是 no-op，不是第二条历史。',
  'CREATE TABLE echo_source_builds (',
  '  build_id       INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  echo_source_id TEXT NOT NULL,',
  '  generation     INTEGER NOT NULL CHECK (generation >= 1),',
  '  source_sha256  TEXT NOT NULL CHECK (length(source_sha256) = 64),',
  '  source_bytes   INTEGER NOT NULL CHECK (source_bytes >= 0),',
  '  words_count    INTEGER NOT NULL CHECK (words_count >= 0),',
  '  summaries_count INTEGER NOT NULL CHECK (summaries_count >= 0),',
  '  src_seq_count  INTEGER NOT NULL CHECK (src_seq_count >= 0),',
  '  cursor_seq     INTEGER NOT NULL CHECK (cursor_seq >= 0),',
  '  cursor_json    TEXT NOT NULL,',
  '  built_at       TEXT NOT NULL CHECK (length(built_at) > 0),',
  '  imported_at    TEXT NOT NULL CHECK (length(imported_at) > 0),',
  '  importer       TEXT NOT NULL CHECK (length(trim(importer)) > 0),',
  '  UNIQUE (echo_source_id, generation),',
  '  FOREIGN KEY (echo_source_id) REFERENCES echo_index_sources(echo_source_id) ON DELETE CASCADE',
  ');',
  '',
  "CREATE TRIGGER echo_source_builds_no_update BEFORE UPDATE ON echo_source_builds BEGIN SELECT RAISE(ABORT, 'ECHO_BUILD_APPEND_ONLY'); END;",
  "CREATE TRIGGER echo_source_builds_no_delete BEFORE DELETE ON echo_source_builds BEGIN SELECT RAISE(ABORT, 'ECHO_BUILD_APPEND_ONLY'); END;",
  '',
  '-- 库层护栏：idx: 是摘要的命名空间，帧表不许占用它（否则 idx 指针会有两种含义）。',
  "CREATE TRIGGER trg_frame_index_reject_echo_ptr_insert BEFORE INSERT ON frame_index",
  "WHEN NEW.ptr LIKE 'idx:%' BEGIN SELECT RAISE(ABORT, 'META_ECHO_PTR_RESERVED'); END;",
  '',
  "CREATE TRIGGER trg_frame_index_reject_echo_ptr_update BEFORE UPDATE OF ptr ON frame_index",
  "WHEN NEW.ptr LIKE 'idx:%' BEGIN SELECT RAISE(ABORT, 'META_ECHO_PTR_RESERVED'); END;",
].join('\n');

// ── v10: derived per-word vector layer; no text/chunk duplicate is stored here. ──
const MIGRATION_010_SQL = [
  'CREATE TABLE echo_vector_models (',
  '  model_key TEXT PRIMARY KEY CHECK (length(model_key) = 64),',
  '  model_id TEXT NOT NULL CHECK (length(trim(model_id)) > 0),',
  '  model_revision TEXT NOT NULL CHECK (length(trim(model_revision)) > 0),',
  '  model_sha256 TEXT NOT NULL CHECK (length(model_sha256) = 64),',
  '  tokenizer_spec TEXT NOT NULL CHECK (length(tokenizer_spec) > 0),',
  '  preprocess_spec TEXT NOT NULL CHECK (length(preprocess_spec) > 0),',
  '  pooling_spec TEXT NOT NULL CHECK (length(pooling_spec) > 0),',
  '  normalize INTEGER NOT NULL CHECK (normalize IN (0, 1)),',
  '  dimension INTEGER NOT NULL CHECK (dimension > 0),',
  '  max_seq_length INTEGER NOT NULL CHECK (max_seq_length > 0),',
  '  spec_sha256 TEXT NOT NULL CHECK (length(spec_sha256) = 64),',
  '  created_at TEXT NOT NULL CHECK (length(created_at) > 0),',
  '  UNIQUE (model_id, model_revision, spec_sha256)',
  ');',
  '',
  'CREATE TABLE echo_word_vectors (',
  '  echo_source_id TEXT NOT NULL,',
  '  word_ord INTEGER NOT NULL CHECK (word_ord >= 0),',
  '  model_key TEXT NOT NULL,',
  '  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),',
  '  vector_dimension INTEGER NOT NULL CHECK (vector_dimension > 0),',
  "  vector_blob BLOB NOT NULL CHECK (typeof(vector_blob) = 'blob' AND length(vector_blob) = vector_dimension * 4),",
  '  vector_sha256 TEXT NOT NULL CHECK (length(vector_sha256) = 64),',
  '  created_at TEXT NOT NULL CHECK (length(created_at) > 0),',
  '  PRIMARY KEY (echo_source_id, word_ord, model_key),',
  '  FOREIGN KEY (echo_source_id, word_ord) REFERENCES echo_words(echo_source_id, word_ord) ON DELETE CASCADE,',
  '  FOREIGN KEY (model_key) REFERENCES echo_vector_models(model_key) ON DELETE CASCADE',
  ');',
  '',
  'CREATE INDEX idx_echo_word_vectors_model ON echo_word_vectors (model_key, echo_source_id, word_ord);',
].join('\n');

export const ECHO_PTR_NAMESPACES = Object.freeze(['log', 'v4log']);
export const ECHO_SUMMARY_PTR_PREFIX = 'idx';

// 来源身份 = (全规范路径, 版本) 的确定性派生 —— 换机器、重跑同一份源都得到同一个 id。
export function echoSourceIdFor(sourcePath, sourceVersion) {
  return 'echo-' + createHash('sha256')
    .update(String(sourcePath) + '\n' + String(sourceVersion), 'utf8')
    .digest('hex')
    .slice(0, 32);
}

export const MIGRATIONS = Object.freeze([
  Object.freeze({ version: 1, name: 'core-metadata', sql: MIGRATION_001_SQL }),
  Object.freeze({ version: 2, name: 'relocatable-ptr-and-db-guards', sql: MIGRATION_002_SQL }),
  Object.freeze({ version: 3, name: 'normalize-frame-rel-paths', sql: MIGRATION_003_SQL, after: backfillFrameRelPaths }),
  Object.freeze({ version: 4, name: 'frame-fts-and-relocation-audit', sql: MIGRATION_004_SQL, after: backfillFrameFts }),
  Object.freeze({ version: 5, name: 'artifacts-and-append-only-events', sql: MIGRATION_005_SQL }),
  Object.freeze({ version: 6, name: 'mo-append-only-ledger', sql: MIGRATION_006_SQL }),
  Object.freeze({ version: 7, name: 'mo-promise-full-actor-session', sql: MIGRATION_007_SQL }),
  Object.freeze({ version: 8, name: 'mo-import-provenance', sql: MIGRATION_008_SQL }),
  Object.freeze({ version: 9, name: 'echo-derived-index', sql: MIGRATION_009_SQL }),
  Object.freeze({ version: 10, name: 'echo-word-vectors', sql: MIGRATION_010_SQL }),
  Object.freeze({ version: 11, name: 'echo-builds-audit-survives-source', sql: MIGRATION_011_SQL }),
  Object.freeze({ version: 12, name: 'echo-sentence-window-vectors', sql: MIGRATION_012_SQL }),
  Object.freeze({ version: 13, name: 'echo-word-content-class', sql: MIGRATION_013_SQL, after: backfillEchoContentClass }),
]);

export function checksum(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function migrationDigest(migration) {
  return checksum(migration.version + '\n' + migration.name + '\n' + migration.sql);
}