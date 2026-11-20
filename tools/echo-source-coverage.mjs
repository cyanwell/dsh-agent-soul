// Synthetic-only source-domain coverage audit. This is not a live completeness claim.
// Expectations are explicit inventory declarations; never infer contiguity or max-seq coverage.
//
// Summary srcSeq refs resolve SOURCE-WIDE inside one source identity, never shard-locally.
// A ref (summary.session, seq) resolves only when BOTH sides hold inside that identity: the word
// key is explicitly DECLARED somewhere in the source inventory AND is PRESENT somewhere in the
// parsed derived shards. Declared in shard A + parsed in shard B of the same source = covered.
// A one-sided or two-sided miss is 'missing-summary-source-ref' carrying its reason
// (not-declared | not-parsed | neither), so the two failure modes stay distinguishable.
// Identity scope at this layer is (version, namespace): the reader contract flattens the parent
// sourcePath away and a shard path identifies a shard, never the source, so paths never group
// shards and shards of a different version/namespace never cross-resolve.
// KNOWN LIMITATION of that flattening (stated, not papered over): two logically different sources
// that happen to carry the same version+namespace are indistinguishable here and share ONE ref
// scope, so a summary in one can be resolved by a word key that only the other declares/holds.
// Nothing at this layer can separate them -- the inventory carries no parent-source identity and a
// shard path cannot stand in for one -- therefore this audit is a declared-vs-parsed consistency
// check inside (version, namespace) and NEVER a sourcePath-level provenance claim. Closing the gap
// needs a parent-source field in the reader contract, which is out of scope for this module.
// Do not "fix" it by scoping refs to a shard path: that reintroduces the false failure this
// source-wide rule exists to remove.
// Ref lists are never read as gaps, contiguity or max(seq): only the refs that are actually listed
// are checked. Word-level checks stay shard-local: missing-word / unexpected-word / cursor per shard.
const fail = (message) => { throw new TypeError(message); };
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = (x) => typeof x === 'string' && x.length > 0;
function canonicalSourcePath(p) {
  if (!nonempty(p) || p.includes('\\')) return false;
  if (!(p.startsWith('/') || /^[A-Za-z]:\//.test(p)) || p.endsWith('/') || p.includes('//')) return false;
  return !p.split('/').some((segment) => segment === '.' || segment === '..');
}
function identityKey(s) { return JSON.stringify([s.path, s.version, s.namespace]); }
function wordKey(w) { return JSON.stringify([w.session, w.seq]); }
function scopeKey(s) { return JSON.stringify([s.version, s.namespace]); }
function shardLabel(s) { return s.path + ' · ' + s.version + ' · ' + s.namespace; }
function addKey(map, scope, key) { if (!map.has(scope)) map.set(scope, new Set()); map.get(scope).add(key); }
function validateShard(s, where) {
  if (!isObj(s)) fail(where + ' must be an object');
  if (!canonicalSourcePath(s.path) || !nonempty(s.version) || !['log', 'v4log'].includes(s.namespace)) fail(where + ' requires canonical source path, version, namespace=log|v4log');
}
function validateWord(w, where) {
  if (!isObj(w) || !nonempty(w.session) || !Number.isSafeInteger(w.seq) || w.seq < 0) fail(where + ' requires session and safe nonnegative seq');
}
function validateSummary(s, where) {
  if (!isObj(s) || !nonempty(s.cmpId) || !nonempty(s.session) || !Array.isArray(s.srcSeqs) || s.srcSeqs.some((n) => !Number.isSafeInteger(n) || n < 0)) fail(where + ' requires cmpId, session and ordered nonnegative srcSeqs');
}
function list(value, where) { if (!Array.isArray(value)) fail(where + ' must be an array'); return value; }
function add(problems, type, shard, detail) { problems.push(Object.assign({ type, shard: shard ? shardLabel(shard) : null }, detail || {})); }
function sortProblems(a, b) {
  const ka = [a.shard || '', a.type, a.session || '', String(a.seq ?? ''), a.cmpId || '', a.key || '', a.reason || ''].join('|');
  const kb = [b.shard || '', b.type, b.session || '', String(b.seq ?? ''), b.cmpId || '', b.key || '', b.reason || ''].join('|');
  return ka.localeCompare(kb, 'en');
}
/**
 * Audit only explicitly declared synthetic expectations. Summary srcSeqs refer to words
 * in that summary's session, in declared order; repetitions are preserved for refs.
 * A ref is covered only when its (session,seq) is BOTH declared in the source inventory and
 * present in the parsed snapshot, anywhere inside the same (version,namespace) source identity.
 * That scope is (version,namespace) only: sources sharing it are not separable here, so coverage
 * says nothing about sourcePath provenance (limitation documented in the file header).
 * Missing whole shards are reported once with expected item totals (not fabricated row errors).
 */
export function auditEchoSourceCoverage(input) {
  if (!isObj(input)) fail('input must be an object');
  const inventory = list(input.sourceInventory, 'sourceInventory');
  const snapshot = input.derivedSnapshot;
  if (!isObj(snapshot)) fail('derivedSnapshot must be an object');
  const present = list(snapshot.shards, 'derivedSnapshot.shards');
  const expectedById = new Map(); const actualById = new Map(); const problems = [];
  const declaredByScope = new Map(); const presentByScope = new Map(); const audited = [];
  for (let i = 0; i < inventory.length; i++) {
    const s = inventory[i]; validateShard(s, 'sourceInventory[' + i + ']');
    const id = identityKey(s);
    if (expectedById.has(id)) add(problems, 'duplicate-expected-shard', s, { key: id });
    else expectedById.set(id, s);
    if (!Array.isArray(s.expectedWords) || !Array.isArray(s.expectedSummaries)) fail('sourceInventory[' + i + '] requires expectedWords and expectedSummaries arrays');
    const wk = new Set();
    for (let j = 0; j < s.expectedWords.length; j++) { validateWord(s.expectedWords[j], 'expected word'); const k=wordKey(s.expectedWords[j]); addKey(declaredByScope, scopeKey(s), k); if(wk.has(k)) add(problems,'duplicate-expected-word',s,{session:s.expectedWords[j].session,seq:s.expectedWords[j].seq}); else wk.add(k); }
    const sk = new Set();
    for (let j = 0; j < s.expectedSummaries.length; j++) { validateSummary(s.expectedSummaries[j], 'expected summary'); const k=s.expectedSummaries[j].cmpId; if(sk.has(k)) add(problems,'duplicate-expected-summary',s,{cmpId:k}); else sk.add(k); }
  }
  for (let i = 0; i < present.length; i++) {
    const s = present[i]; validateShard(s, 'derivedSnapshot.shards[' + i + ']');
    const id = identityKey(s);
    if (actualById.has(id)) { add(problems,'duplicate-present-shard',s,{key:id}); continue; }
    actualById.set(id,s);
    if (!Array.isArray(s.words) || !Array.isArray(s.summaries) || !Number.isSafeInteger(s.cursorSeq) || s.cursorSeq < 0) fail('derived shard requires words, summaries and safe nonnegative cursorSeq');
    const words = new Map();
    for (let j=0;j<s.words.length;j++) { const w=s.words[j]; validateWord(w,'derived word'); const k=wordKey(w); addKey(presentByScope, scopeKey(s), k); if(words.has(k)) add(problems,'duplicate-present-word',s,{session:w.session,seq:w.seq}); else words.set(k,w); }
    const summaries = new Map();
    for (let j=0;j<s.summaries.length;j++) { const m=s.summaries[j]; validateSummary(m,'derived summary'); if(summaries.has(m.cmpId)) add(problems,'duplicate-present-summary',s,{cmpId:m.cmpId}); else summaries.set(m.cmpId,m); }
    if (!expectedById.has(id)) { add(problems,'unexpected-shard',s,{key:id}); continue; }
    const expected = expectedById.get(id);
    const expectedWords = new Map(expected.expectedWords.map((w)=>[wordKey(w),w]));
    for (const [k,w] of expectedWords) {
      if (!words.has(k)) add(problems,'missing-word',s,{session:w.session,seq:w.seq});
      if (s.cursorSeq < w.seq) add(problems,'cursor-before-declared-row',s,{session:w.session,seq:w.seq,cursorSeq:s.cursorSeq});
    }
    for (const [k,w] of words) if (!expectedWords.has(k)) add(problems,'unexpected-word',s,{session:w.session,seq:w.seq});
    const expectedSummaries = new Map(expected.expectedSummaries.map((m)=>[m.cmpId,m]));
    for (const cmpId of expectedSummaries.keys()) if (!summaries.has(cmpId)) add(problems,'missing-summary',s,{cmpId});
    for (const cmpId of summaries.keys()) if (!expectedSummaries.has(cmpId)) add(problems,'unexpected-summary',s,{cmpId});
    for (const [cmpId,m] of summaries) {
      const expectedSummary=expectedSummaries.get(cmpId); if (!expectedSummary) continue;
      if (m.session!==expectedSummary.session || JSON.stringify(m.srcSeqs)!==JSON.stringify(expectedSummary.srcSeqs)) add(problems,'summary-identity-mismatch',s,{cmpId});
    }
    audited.push({shard:s,expected,summaries});
  }
  // Source-wide ref resolution, evaluated after every shard of the scope is known: a shard may
  // declare the word while a sibling shard holds it. Refs are walked in declared order with
  // repeats intact; only the emitted diagnostic is deduped per (shard,cmpId,session,seq).
  const missingRefs = new Set();
  for (const entry of audited) {
    const scope = scopeKey(entry.shard), declared = declaredByScope.get(scope), held = presentByScope.get(scope);
    for (const m of entry.expected.expectedSummaries) {
      const origin = entry.summaries.has(m.cmpId) ? 'parsed' : 'declared';
      for (const seq of m.srcSeqs) {
        const k = wordKey({ session: m.session, seq });
        const inPresent = !!(held && held.has(k)), inDeclared = !!(declared && declared.has(k));
        if (inPresent && inDeclared) continue;
        const dedupe = JSON.stringify([shardLabel(entry.shard), m.cmpId, m.session, seq]);
        if (missingRefs.has(dedupe)) continue;
        missingRefs.add(dedupe);
        add(problems, 'missing-summary-source-ref', entry.shard, {cmpId:m.cmpId,session:m.session,seq,origin,reason:inPresent?'not-declared':inDeclared?'not-parsed':'neither'});
      }
    }
  }
  for (const [id,s] of expectedById) if (!actualById.has(id)) add(problems,'missing-shard',s,{key:id,unresolvedExpectedWords:s.expectedWords.length,unresolvedExpectedSummaries:s.expectedSummaries.length,unresolvedExpectedSummaryRefs:s.expectedSummaries.reduce((n,m)=>n+m.srcSeqs.length,0)});
  problems.sort(sortProblems);
  return { ok: problems.length===0, problems };
}
