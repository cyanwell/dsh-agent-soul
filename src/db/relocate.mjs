// src/db/relocate.mjs —— 来源搬迁（前置 1）：独立更新 source 的当前根，不依赖新帧。
//
// 背景（P1a 定点验证 CHANGES 3）：改名的机器上，如果只有「重放一帧」能顺带刷新 sources.raw_path，
// 那「没有新帧」的源就永远钉在旧根上 —— P6 抽样会解析出一条不存在的路径，而库里看起来一切正常。
// 所以搬迁必须是**独立动作**：只动 sources 一行，帧一行都不碰（帧的可回取路径由
// 「当前根 + 相对路径 + frame_ordinal」在读取时算出来，见 locator.resolveFramePath）。
//
// 审计：库层触发器（v4 的 trg_sources_relocation_audit）在任何 raw_path 变化时写一行
// source_relocations —— 不经过本函数的直插 UPDATE 也留痕。这里只负责把「调用方的前提」
// （expectedOldRoot）先验掉，并把刚写下的审计行读回来。
//
// ★ 不可搬迁的帧（raw_rel_path IS NULL）不会因为搬家变得可用。审计行把两个计数分开记，
//   调用方据此知道「这次搬家之后还有多少帧是钉死的」，而不是拿到一个漂亮的 relocated:true。

import { fail, CODES } from './errors.mjs';
import { assertPath, assertSourceId } from './validate.mjs';

function counts(db, sourceId) {
  const row = db.prepare([
    'select',
    '  (select count(*) from frame_index where source_id = ?) as frames_total,',
    '  (select count(*) from frame_index where source_id = ? and raw_rel_path is not null) as frames_relocatable,',
    '  (select count(*) from frame_index where source_id = ? and raw_rel_path is null) as frames_unresolved',
  ].join(' ')).get(sourceId, sourceId, sourceId);
  return { framesTotal: row.frames_total, framesRelocatable: row.frames_relocatable, framesUnresolved: row.frames_unresolved };
}

function mapRelocation(row) {
  return {
    relocationId: row.relocation_id,
    sourceId: row.source_id,
    oldRoot: row.old_root,
    newRoot: row.new_root,
    framesTotal: row.frames_total,
    framesRelocatable: row.frames_relocatable,
    framesUnresolved: row.frames_unresolved,
    at: row.at,
  };
}

// relocateSource(db, { sourceId, newRoot, expectedOldRoot })
//
// status:
//   'relocated'  根确实变了，审计行已写
//   'unchanged'  新根与当前根相同 —— 不写审计行、不改 updated_at（幂等重放不打脏账）
// 失败：
//   SOURCE_NOT_FOUND        指定的 source 不存在
//   SOURCE_ROOT_MISMATCH    expectedOldRoot 与库里当前根不一致（有人已经搬过，前提失效）
export function relocateSource(db, input, options) {
  const o = options || {};
  const now = o.now || new Date().toISOString();
  const spec = input || {};
  const sourceId = assertSourceId(spec.sourceId, 'sourceId');
  const newRoot = assertPath(spec.newRoot, 'newRoot');
  const expectedOldRoot = spec.expectedOldRoot === undefined || spec.expectedOldRoot === null
    ? null
    : assertPath(spec.expectedOldRoot, 'expectedOldRoot');

  const current = db.prepare('select source_id, raw_path, kind, namespace, authority from sources where source_id = ?').get(sourceId);
  if (!current) {
    fail(CODES.SOURCE_NOT_FOUND, 'no source with source_id ' + sourceId, { sourceId });
  }
  if (expectedOldRoot !== null && current.raw_path !== expectedOldRoot) {
    fail(CODES.SOURCE_ROOT_MISMATCH,
      'source ' + sourceId + ' is at ' + current.raw_path + ', not at the expected old root ' + expectedOldRoot + '; refusing to relocate on a stale premise',
      { sourceId, expectedOldRoot, currentRoot: current.raw_path });
  }

  if (current.raw_path === newRoot) {
    return Object.assign({
      status: 'unchanged',
      sourceId,
      previousRoot: current.raw_path,
      newRoot,
      expectedOldRoot,
      auditId: null,
      at: null,
    }, counts(db, sourceId));
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('update sources set raw_path = ?, updated_at = ? where source_id = ?').run(newRoot, now, sourceId);
    const audit = db.prepare('select * from source_relocations where source_id = ? order by relocation_id desc limit 1').get(sourceId);
    if (!audit) {
      // 触发器没了 = 库被改坏。宁可整笔回滚，也不留一次「搬了但没痕」的搬家。
      fail(CODES.MIGRATION_REQUIRED, 'source_relocations audit trigger did not fire; refusing a silent relocation', {
        sourceId, newRoot, hint: 'schema v4 trigger trg_sources_relocation_audit is missing',
      });
    }
    db.exec('COMMIT');
    return {
      status: 'relocated',
      sourceId,
      previousRoot: audit.old_root,
      newRoot: audit.new_root,
      expectedOldRoot,
      expectedMatched: expectedOldRoot === null ? null : true,
      auditId: audit.relocation_id,
      framesTotal: audit.frames_total,
      framesRelocatable: audit.frames_relocatable,
      framesUnresolved: audit.frames_unresolved,
      at: audit.at,
    };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) { /* 事务可能已经没了 */ }
    throw err;
  }
}

export function listSourceRelocations(db, sourceId, options) {
  const o = options || {};
  const limit = typeof o.limit === 'number' ? Math.max(1, Math.min(1000, Math.floor(o.limit))) : 50;
  const sid = sourceId === undefined || sourceId === null ? null : assertSourceId(sourceId, 'sourceId');
  const rows = db.prepare([
    'select * from source_relocations',
    'where (? is null or source_id = ?)',
    'order by relocation_id desc limit ?',
  ].join(' ')).all(sid, sid, limit);
  return rows.map(mapRelocation);
}
