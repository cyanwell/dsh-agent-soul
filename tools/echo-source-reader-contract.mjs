// Synthetic-only source-reader adapter. No paths are opened; receipts are supplied objects.
// Coverage is derived only from explicit shard declarations, never contiguous seq or max(seq).
const bad = (m) => { throw new TypeError(m); };
const object = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = (x) => typeof x === 'string' && x.length > 0;
const array = (x, n) => { if (!Array.isArray(x)) bad(n + ' must be an array'); return x; };
function canonical(p) { return text(p) && !p.includes('\\') && (p.startsWith('/') || /^[A-Za-z]:\//.test(p)) && !p.endsWith('/') && !p.includes('//') && !p.split('/').some((s) => s === '.' || s === '..'); }
function shardIdentity(s) { return JSON.stringify([s.path, s.version, s.namespace]); }
function receiptIdentity(r) { return JSON.stringify([r.sourcePath, r.version, r.namespace, r.shardId]); }
function wordKey(w) { return JSON.stringify([w.session, w.seq]); }
function validateWord(w, where) { if (!object(w) || !text(w.session) || !Number.isSafeInteger(w.seq) || w.seq < 0) bad(where + ' requires session and safe nonnegative seq'); }
function validateSummary(s, where) { if (!object(s) || !text(s.cmpId) || !text(s.session) || !Array.isArray(s.srcSeqs) || s.srcSeqs.some((n) => !Number.isSafeInteger(n) || n < 0)) bad(where + ' requires cmpId, session, ordered srcSeqs'); }
const cmp = (a, b) => String(a).localeCompare(String(b), 'en');
/**
 * Inventory: sources[{sourcePath,version,namespace,shards:[{shardId,path,expectedWords,expectedSummaries,expectedByteEnd?,expectedCursorSeq?}]}].
 * Receipts: parserReceipts[{sourcePath,version,namespace,shardId,status,rows,summaries,consumedBytes?,cursorSeq?,completeFrameBoundary,malformedTail}].
 * Source identity is (sourcePath,version); namespace is constrained by the v4 schema.
 * Within one source, canonical shard path is the coverage identity and shardId joins receipts.
 * Therefore sourcePath/version must be unique per call and shard paths must not alias within version+namespace.
 * Partial/unknown are explicit; this adapter never reads files or claims legacy completeness.
 */
export function adaptEchoSourceReads(input) {
  if (!object(input)) bad('input must be an object');
  const sources = array(input.sourceInventory, 'sourceInventory');
  const receipts = array(input.parserReceipts, 'parserReceipts');
  const expected = [], derived = [], sourceReadProblems = [], expectedIds = new Set(), receiptMap = new Map(), sourceIds = new Set(), shardPaths = new Set();
  let unknown = false, partial = false;
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    if (!object(src) || !canonical(src.sourcePath) || !text(src.version) || !['log','v4log'].includes(src.namespace)) bad('sourceInventory[' + i + '] requires canonical sourcePath/version/namespace');
    const sourceId = JSON.stringify([src.sourcePath, src.version]);
    if (sourceIds.has(sourceId)) bad('duplicate parent source identity (sourcePath+version) in one adapter call');
    sourceIds.add(sourceId);
    const shards = array(src.shards, 'sourceInventory shards');
    const shardIds = new Set();
    for (let j = 0; j < shards.length; j++) {
      const sh = shards[j];
      if (!object(sh) || !text(sh.shardId) || !canonical(sh.path)) bad('inventory shard requires shardId and canonical path');
      if (shardIds.has(sh.shardId)) bad('duplicate shardId within parent source');
      shardIds.add(sh.shardId);
      if (sh.expectedByteEnd !== undefined && (!Number.isSafeInteger(sh.expectedByteEnd) || sh.expectedByteEnd < 0)) bad('expectedByteEnd must be a safe nonnegative integer');
      if (sh.expectedCursorSeq !== undefined && (!Number.isSafeInteger(sh.expectedCursorSeq) || sh.expectedCursorSeq < 0)) bad('expectedCursorSeq must be a safe nonnegative integer');
      const words = array(sh.expectedWords, 'expectedWords'), summaries = array(sh.expectedSummaries, 'expectedSummaries');
      words.forEach((w, k) => validateWord(w, 'expectedWords[' + k + ']'));
      summaries.forEach((m, k) => validateSummary(m, 'expectedSummaries[' + k + ']'));
      const item = { path: sh.path, version: src.version, namespace: src.namespace, expectedWords: words.map((w) => ({ session: w.session, seq: w.seq })), expectedSummaries: summaries.map((m) => ({ cmpId: m.cmpId, session: m.session, srcSeqs: m.srcSeqs.slice() })) };
      const id = shardIdentity(item);
      if (expectedIds.has(id) || shardPaths.has(id)) bad('duplicate coverage shard identity (canonical path+version+namespace)');
      expectedIds.add(id); shardPaths.add(id); expected.push(item);
      const rid = JSON.stringify([src.sourcePath, src.version, src.namespace, sh.shardId]);
      if (receiptMap.has(rid)) { sourceReadProblems.push({ type: 'duplicate-shard-id', sourcePath: src.sourcePath, shardId: sh.shardId }); continue; }
      receiptMap.set(rid, { src, shard: sh, receipt: null });
    }
  }
  for (let i = 0; i < receipts.length; i++) {
    const r = receipts[i];
    if (!object(r) || !canonical(r.sourcePath) || !text(r.version) || !['log','v4log'].includes(r.namespace) || !text(r.shardId)) bad('parserReceipts[' + i + '] requires sourcePath/version/namespace/shardId');
    const rid = receiptIdentity(r), slot = receiptMap.get(rid);
    if (!slot) { sourceReadProblems.push({ type: 'unexpected-parser-receipt', sourcePath: r.sourcePath, shardId: r.shardId }); continue; }
    if (slot.receipt) { sourceReadProblems.push({ type: 'duplicate-parser-receipt', sourcePath: r.sourcePath, shardId: r.shardId }); continue; }
    if (!['complete','partial','failed'].includes(r.status)) bad('receipt status must be complete|partial|failed');
    if (!Array.isArray(r.rows) || !Array.isArray(r.summaries)) bad('receipt requires rows and summaries');
    if (r.consumedBytes !== undefined && (!Number.isSafeInteger(r.consumedBytes) || r.consumedBytes < 0)) bad('consumedBytes must be safe nonnegative integer');
    if (r.cursorSeq !== undefined && (!Number.isSafeInteger(r.cursorSeq) || r.cursorSeq < 0)) bad('cursorSeq must be safe nonnegative integer');
    if (typeof r.completeFrameBoundary !== 'boolean' || typeof r.malformedTail !== 'boolean') bad('receipt must state completeFrameBoundary and malformedTail');
    r.rows.forEach((w, k) => validateWord(w, 'receipt rows[' + k + ']'));
    r.summaries.forEach((m, k) => validateSummary(m, 'receipt summaries[' + k + ']'));
    slot.receipt = r;
  }
  for (const [rid, slot] of receiptMap) {
    const { src, shard, receipt: r } = slot;
    if (!r) { unknown = true; sourceReadProblems.push({ type: 'absent-shard', sourcePath: src.sourcePath, shardId: shard.shardId, expectedWords: shard.expectedWords.length, expectedSummaries: shard.expectedSummaries.length }); continue; }
    if (r.status === 'failed') { unknown = true; sourceReadProblems.push({ type: 'failed-shard', sourcePath: src.sourcePath, shardId: shard.shardId, detail: text(r.error) ? r.error : 'parser reported failure' }); continue; }
    if (r.status === 'partial') { partial = true; sourceReadProblems.push({ type: 'partial-shard', sourcePath: src.sourcePath, shardId: shard.shardId }); }
    if (r.malformedTail) { partial = true; sourceReadProblems.push({ type: 'malformed-tail', sourcePath: src.sourcePath, shardId: shard.shardId }); }
    if (!r.completeFrameBoundary) { partial = true; sourceReadProblems.push({ type: 'incomplete-frame-boundary', sourcePath: src.sourcePath, shardId: shard.shardId }); }
    if (shard.expectedByteEnd !== undefined && (r.consumedBytes === undefined || r.consumedBytes < shard.expectedByteEnd)) { partial = true; sourceReadProblems.push({ type: 'cursor-before-declared-byte-boundary', sourcePath: src.sourcePath, shardId: shard.shardId, expectedByteEnd: shard.expectedByteEnd, consumedBytes: r.consumedBytes ?? null }); }
    if (shard.expectedCursorSeq !== undefined && (r.cursorSeq === undefined || r.cursorSeq < shard.expectedCursorSeq)) { partial = true; sourceReadProblems.push({ type: 'cursor-before-declared-seq-boundary', sourcePath: src.sourcePath, shardId: shard.shardId, expectedCursorSeq: shard.expectedCursorSeq, cursorSeq: r.cursorSeq ?? null }); }
    const wordSeen = new Set(), summarySeen = new Set();
    for (const w of r.rows) { const k=wordKey(w); if(wordSeen.has(k)) sourceReadProblems.push({type:'duplicate-parsed-key',sourcePath:src.sourcePath,shardId:shard.shardId,session:w.session,seq:w.seq}); wordSeen.add(k); }
    for (const m of r.summaries) { if(summarySeen.has(m.cmpId)) sourceReadProblems.push({type:'duplicate-summary-id',sourcePath:src.sourcePath,shardId:shard.shardId,cmpId:m.cmpId}); summarySeen.add(m.cmpId); }
    const present = { path: shard.path, version: src.version, namespace: src.namespace, cursorSeq: Number.isSafeInteger(r.cursorSeq) ? r.cursorSeq : 0, words: r.rows.map((w) => ({ session: w.session, seq: w.seq })), summaries: r.summaries.map((m) => ({ cmpId: m.cmpId, session: m.session, srcSeqs: m.srcSeqs.slice() })) };
    derived.push(present);
    const expectedKeys = new Set(shard.expectedWords.map(wordKey));
    for (const w of r.rows) if (!expectedKeys.has(wordKey(w))) sourceReadProblems.push({ type: 'parsed-key-mismatch', sourcePath: src.sourcePath, shardId: shard.shardId, session: w.session, seq: w.seq });
    const actualKeys = new Set(r.rows.map(wordKey));
    for (const w of shard.expectedWords) if (!actualKeys.has(wordKey(w))) sourceReadProblems.push({ type: 'declared-key-not-parsed', sourcePath: src.sourcePath, shardId: shard.shardId, session: w.session, seq: w.seq });
  }
  const stable = (x) => [x.sourcePath || '', x.shardId || '', x.type || '', x.session || '', String(x.seq ?? ''), String(x.expectedSeq ?? '')].join('|');
  expected.sort((a, b) => cmp(shardIdentity(a), shardIdentity(b)));
  derived.sort((a, b) => cmp(shardIdentity(a), shardIdentity(b)));
  sourceReadProblems.sort((a, b) => cmp(stable(a), stable(b)));
  return { sourceInventory: expected, derivedSnapshot: { shards: derived }, sourceReadProblems, sourceReadCoverage: unknown ? 'unknown' : partial || sourceReadProblems.length ? 'partial' : 'complete' };
}
