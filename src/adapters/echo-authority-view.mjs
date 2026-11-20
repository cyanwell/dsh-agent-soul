// Read-only ECHO authority summary. Unknown DB authority is kept unknown; this
// adapter never opens a second connection or invokes the full integrity scanner.
const finiteOrNull = (value) => value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);

function redactedLast(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    at: value.at ?? null,
    code: value.code ?? null,
    ok: typeof value.ok === 'boolean' ? value.ok : null,
    generation: finiteOrNull(value.generation),
    attemptId: value.attemptId ?? null,
    commitId: value.commitId ?? null,
    authority: value.authority && typeof value.authority === 'object' ? {
      sourceId: value.authority.sourceId ?? null,
      generation: finiteOrNull(value.authority.generation),
      state: value.authority.state ?? null,
    } : null,
    stage: value.stage ?? null,
  };
}

function syncView(echoLive) {
  if (!echoLive || typeof echoLive.view !== 'function') {
    return { configured: null, enabled: null, running: null, last: null, stats: null };
  }
  let raw;
  try { raw = echoLive.view(); } catch { raw = null; }
  if (!raw || typeof raw !== 'object') return { configured: null, enabled: null, running: null, last: null, stats: null };
  const stats = raw.stats && typeof raw.stats === 'object' ? raw.stats : null;
  return {
    configured: typeof raw.dbPath === 'string' && !!raw.dbPath && typeof raw.sourceRoot === 'string' && !!raw.sourceRoot,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : null,
    running: typeof raw.running === 'boolean' ? raw.running : null,
    last: redactedLast(raw.last),
    stats: stats ? {
      rounds: finiteOrNull(stats.rounds), imported: finiteOrNull(stats.imported),
      unchanged: finiteOrNull(stats.unchanged), failed: finiteOrNull(stats.failed),
      lastCode: stats.lastCode ?? null, lastAt: stats.lastAt ?? null,
      lastMs: finiteOrNull(stats.lastMs), lastWords: finiteOrNull(stats.lastWords),
      lastGeneration: finiteOrNull(stats.lastGeneration),
      consecutiveFailures: finiteOrNull(stats.consecutiveFailures),
    } : null,
  };
}

function sourceStatus(store) {
  const unknown = { available: null, aligned: null, rows: null };
  if (!store || typeof store.echoSourceStatus !== 'function') return unknown;
  try {
    const raw = store.echoSourceStatus();
    if (!raw || raw.available !== true || !Array.isArray(raw.rows)) return unknown;
    return {
      available: true,
      aligned: raw.truncated === true ? null : (typeof raw.aligned === 'boolean' ? raw.aligned : null),
      truncated: raw.truncated === true,
      rows: raw.rows.map((row) => ({
        sourceId: row.sourceId ?? null, namespace: row.namespace ?? null,
        sourceVersion: row.sourceVersion ?? null, generation: finiteOrNull(row.generation),
        state: row.state ?? null, cursorSeq: finiteOrNull(row.cursorSeq),
        counts: row.counts && typeof row.counts === 'object' ? {
          words: finiteOrNull(row.counts.words), wordsFts: finiteOrNull(row.counts.wordsFts),
          summaries: finiteOrNull(row.counts.summaries), summariesFts: finiteOrNull(row.counts.summariesFts),
          srcSeqs: finiteOrNull(row.counts.srcSeqs), declaredSrcSeqs: finiteOrNull(row.counts.declaredSrcSeqs),
        } : null,
        builtAt: row.builtAt ?? null, importedAt: row.importedAt ?? null,
        aligned: typeof row.aligned === 'boolean' ? row.aligned : null,
      })),
    };
  } catch { return unknown; }
}

export function echoAuthorityView({ store, echoLive, now = Date.now() } = {}) {
  return {
    sync: syncView(echoLive),
    sources: sourceStatus(store),
    freshness: { generatedAt: null, checkedAt: new Date(now).toISOString(), ageMs: null },
    query: { status: 'not-queried' },
    issue: store && typeof store.echoSourceStatus === 'function' ? null : 'database-not-wired',
  };
}
