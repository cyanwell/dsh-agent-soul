// src/db/index.mjs —— P1a + P1b + P1c 元数据层的公开入口。
//
// 用法：
//   import { openMetaStore, hashFrame, DSH_NAMESPACE, V4_NAMESPACE } from './src/db/index.mjs';
//   const store = openMetaStore({ path: '...meta.sqlite', mode: 'readwrite' });
//   store.migrate();
//   store.ingest({ source: {...}, session: {...}, frame: {...}, cursor: {...} });
//   store.resolvePtr('log:session-abc#seq=3');
//   store.search('解耦');                       // P1b：bigram 预筛 + 原文子串核实
//   store.relocateSource('dsh-home', 'E:/mirror/sessions', 'D:/AI/dsh/home/sessions');  // P1b
//   store.registerArtifact({ sourceId:'dsh-home', path:'30-状态/x.md', kind:'report' });  // P1c
//   store.verifyArtifact({ sourceId:'dsh-home', relPath:'30-状态/x.md' });                // P1c：present|stale|missing
//
// 引擎约束：node:sqlite 只经 src/db/engine.mjs 引入，别的模块不直接 require 它。

export { openMetaStore } from './store.mjs';
export { migrate, readSchemaState } from './migrate.mjs';
export { SCHEMA_VERSION, MIGRATIONS, checksum, migrationDigest, backfillFrameFts, rebuildFrameFts } from './schema.mjs';
export { engineInfo, assertEngine, ENGINE_NAME, MIN_NODE_MAJOR, MIN_SQLITE_VERSION } from './engine.mjs';
export { hashFrame } from './ingest.mjs';
export { makeStreamFingerprint, FINGERPRINT_SCHEME, FINGERPRINT_INPUT_KEYS, FINGERPRINT_FORBIDDEN_KEYS } from './fingerprint.mjs';
export { makePtr, parsePtr, isPtr, DSH_NAMESPACE, V4_NAMESPACE, MAX_PTR_SEQ } from './ptr.mjs';
export { SNIPPET_MAX, capSnippet } from './validate.mjs';
export { toPosix, relToSource, joinSourcePath, resolveFramePath } from './locator.mjs';
export {
  FTS_TABLE,
  FTS_TOKENIZER,
  SEARCH_MODES,
  SEARCH_QUERY_MAX,
  SEARCH_BATCH_SIZE,
  buildSearchText,
  buildQueryPlan,
  buildMatchExpression,
  searchFrames,
  searchIndexInfoFor,
  assertSearchIndexAligned,
  containsNeedle,
  isCjkChar,
  isCjkCodePoint,
  ftsRowFor,
} from './search.mjs';
export {
  ARTIFACT_STATUSES,
  ARTIFACT_ACTIONS,
  ARTIFACT_TITLE_MAX,
  ARTIFACT_METADATA_MAX,
  ARTIFACT_UPDATE_KEYS,
  artifactIdFor,
  canonicalJson,
  isInsideRoot,
  resolveArtifactPath,
  mapArtifact,
  normalizeArtifactRef,
  registerArtifact,
  updateArtifact,
  getArtifact,
  listArtifacts,
  verifyArtifact,
  listArtifactEvents,
  countArtifacts,
} from './artifacts.mjs';
export { relocateSource, listSourceRelocations } from './relocate.mjs';
export { verifyPtrSample } from './accept.mjs';
export { isStreamFingerprint, assertStreamFingerprint, STREAM_FINGERPRINT_SCHEME } from './validate.mjs';
export { MetaStoreError, CODES, isMetaStoreError, translateSqliteError } from './errors.mjs';
