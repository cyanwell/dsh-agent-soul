import { isPlaceholderText, PURGEABLE_TYPE } from './huanqi-targets.mjs'

/**
 * Offline contract v1 — use only on plain JSON data from synthetic fixtures.
 *
 * validateHuanqiRepairPlan(context, proposal)
 *   context: independently supplied by the caller, never by a proposal producer.
 *     {version:1, kind:'authorized-synthetic-visible-snapshot', binding,
 *      nowMs, evidence, targets, requiredItems}
 *   proposal: same rules for either producer label (the label grants nothing).
 *     {version:1, kind:'derived-repair-plan', origin:'manual'|'embedded-llm',
 *      binding, targets, items}
 *   binding: {sessionId, snapshotId, scopeId, evidenceRevision, projectionRevision,
 *     issuedAtMs, expiresAtMs}. Timestamps are integer Unix ms; validity is
 *     [issuedAtMs, expiresAtMs). Changing the window invalidates old proposals.
 *     The caller must change snapshotId or a revision when evidence or scope changes.
 *   evidence: [{ref, kind:'user'|'assistant'|'tool_call'|'tool_result', text}].
 *     text is authorized visible source text only, never a private trace or secret.
 *   targets: nonempty exact set of ref values, one per eligible tool result.
 *   ref: {sessionId, eventId, eventRevision, frameSeq, hostSeq}.
 *     The two sequence namespaces are independent; no fallback or conversion here.
 *   requiredItems/items: [{id, kind, text, citations}].
 *     Kinds are question/constraint/evidence/attempt/failure/inference/reversal/
 *     conclusion/unresolved. All independently enumerated requiredItems (at least
 *     one) must survive exactly: canonical decision text, kind and citation set.
 *   citation: {ref, start, end, quote}; [start,end) are UTF-16 string offsets in
 *     evidence.text; quote must match the exact source slice, without normalization.
 *
 * Evidence and derived text are separate inputs. Presence of a matching quote
 * does NOT prove a claim follows from it or that requiredItems is exhaustive.
 * The caller owns provenance, visibility, expiry/clock and obligation completeness;
 * schema markers are not proof of those. There is no source discovery, redaction,
 * host lookup, write, promotion to original, or application authority here.
 * A valid result is only a review candidate. Distinct target texts are never
 * collapsed, even when they share excerpts; originals always remain untouched.
 * The return value intentionally contains no proposal, text, source or target data.
 */
const BINDING_IDS = ['sessionId', 'snapshotId', 'scopeId', 'evidenceRevision', 'projectionRevision']
const BINDING = [...BINDING_IDS, 'issuedAtMs', 'expiresAtMs']
const REF = ['sessionId', 'eventId', 'eventRevision', 'frameSeq', 'hostSeq']
const SOURCE_TYPES = new Set(['user', 'assistant', 'tool_call', PURGEABLE_TYPE])
const ITEM_TYPES = new Set([
  'question', 'constraint', 'evidence', 'attempt', 'failure', 'inference',
  'reversal', 'conclusion', 'unresolved',
])
const MAX_SOURCE_LENGTH = 32_768

function shape (value, keys) {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return false
  if (Reflect.ownKeys(value).length !== keys.length) return false
  return keys.every((key) => ownData(value, key))
}

function ownData (object, key) {
  const desc = Object.getOwnPropertyDescriptor(object, key)
  return !!(desc && desc.enumerable && Object.hasOwn(desc, 'value'))
}

function list (value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      value.length < 1 || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) return false
  for (let i = 0; i < value.length; i++) if (!ownData(value, i)) return false
  return true
}

function label (value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function text (value, max) {
  return typeof value === 'string' && value.length <= max && value.trim().length > 0
}

function uint (value) {
  return Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
}

function equalFields (left, right, keys) {
  return keys.every((key) => left[key] === right[key])
}

export function validateHuanqiRepairPlan (context, proposal) {
  let failure = 'INVALID_INPUT'
  const stop = Symbol('invalid repair plan')
  const require = (condition, code) => {
    if (!condition) { failure = code; throw stop }
  }

  try {
    require(shape(context, ['version', 'kind', 'binding', 'nowMs', 'evidence', 'targets', 'requiredItems']) &&
      context.version === 1 && context.kind === 'authorized-synthetic-visible-snapshot', 'INVALID_CONTEXT')
    const { binding, nowMs } = context
    require(shape(binding, BINDING) && BINDING_IDS.every((key) => label(binding[key])), 'INVALID_CONTEXT')
    const { issuedAtMs, expiresAtMs } = binding
    require(uint(issuedAtMs) && uint(expiresAtMs) && uint(nowMs) && issuedAtMs < expiresAtMs, 'INVALID_TIME_WINDOW')
    require(nowMs >= issuedAtMs && nowMs < expiresAtMs, 'OUTSIDE_TIME_WINDOW')

    require(shape(proposal, ['version', 'kind', 'origin', 'binding', 'targets', 'items']) &&
      proposal.version === 1 && proposal.kind === 'derived-repair-plan' &&
      (proposal.origin === 'manual' || proposal.origin === 'embedded-llm'), 'INVALID_PROPOSAL')
    require(shape(proposal.binding, BINDING), 'INVALID_BINDING')
    require(equalFields(binding, proposal.binding, BINDING), 'BINDING_MISMATCH')

    function checkRef (ref) {
      require(shape(ref, REF) && label(ref.eventId) && label(ref.eventRevision) &&
        uint(ref.frameSeq) && uint(ref.hostSeq), 'INVALID_REFERENCE')
      require(ref.sessionId === binding.sessionId, 'REFERENCE_SESSION_MISMATCH')
    }

    const sources = new Map()
    const frameSeqs = new Set()
    const hostSeqs = new Set()
    require(list(context.evidence, 80), 'INVALID_EVIDENCE_SET')
    for (const source of context.evidence) {
      require(shape(source, ['ref', 'kind', 'text']) && SOURCE_TYPES.has(source.kind) &&
        text(source.text, MAX_SOURCE_LENGTH), 'INVALID_EVIDENCE')
      const { ref } = source
      checkRef(ref)
      require(!sources.has(ref.eventId) && !frameSeqs.has(ref.frameSeq) && !hostSeqs.has(ref.hostSeq),
        'AMBIGUOUS_EVIDENCE_IDENTITY')
      sources.set(ref.eventId, source)
      frameSeqs.add(ref.frameSeq)
      hostSeqs.add(ref.hostSeq)
    }

    function sourceOf (ref) {
      checkRef(ref)
      const source = sources.get(ref.eventId)
      require(source && equalFields(source.ref, ref, REF), 'SOURCE_NOT_IN_SNAPSHOT')
      return source
    }

    const authorized = new Map()
    require(list(context.targets, 40), 'INVALID_TARGET_SET')
    for (const ref of context.targets) {
      const source = sourceOf(ref)
      require(source.kind === PURGEABLE_TYPE && !isPlaceholderText(source.text), 'INELIGIBLE_TARGET')
      require(!authorized.has(ref.eventId), 'DUPLICATE_TARGET')
      authorized.set(ref.eventId, source)
    }
    require(list(proposal.targets, 40), 'INVALID_TARGET_SET')
    const selected = new Set()
    for (const ref of proposal.targets) {
      sourceOf(ref)
      require(authorized.has(ref.eventId), 'TARGET_OUTSIDE_SCOPE')
      require(!selected.has(ref.eventId), 'DUPLICATE_TARGET')
      selected.add(ref.eventId)
    }
    require(selected.size === authorized.size, 'TARGET_SET_MISMATCH')

    function readItems (items) {
      require(list(items, 96), 'INVALID_ITEM_SET')
      const byId = new Map()
      const covered = new Set()
      for (const item of items) {
        require(shape(item, ['id', 'kind', 'text', 'citations']) && label(item.id) &&
          ITEM_TYPES.has(item.kind) && text(item.text, 4_096) && list(item.citations, 16), 'INVALID_ITEM')
        require(!byId.has(item.id), 'DUPLICATE_ITEM')
        const citations = new Set()
        for (const citation of item.citations) {
          require(shape(citation, ['ref', 'start', 'end', 'quote']), 'INVALID_CITATION')
          const source = sourceOf(citation.ref)
          const { start, end, quote } = citation
          require(uint(start) && uint(end) && start < end && end <= source.text.length &&
            text(quote, MAX_SOURCE_LENGTH) && source.text.slice(start, end) === quote, 'CITATION_QUOTE_MISMATCH')
          // sourceOf already checked the entire ref against one unambiguous source.
          const key = JSON.stringify([source.ref.eventId, start, end])
          require(!citations.has(key), 'DUPLICATE_CITATION')
          citations.add(key)
          covered.add(source.ref.eventId)
        }
        byId.set(item.id, { kind: item.kind, text: item.text, citations })
      }
      return { byId, covered }
    }

    const mandatory = readItems(context.requiredItems).byId
    const { byId, covered } = readItems(proposal.items)
    for (const [id, expected] of mandatory) {
      const actual = byId.get(id)
      require(actual, 'MISSING_REQUIRED_ITEM')
      require(expected.kind === actual.kind && expected.text === actual.text &&
        expected.citations.size === actual.citations.size &&
        [...expected.citations].every((key) => actual.citations.has(key)), 'CHANGED_REQUIRED_ITEM')
    }
    for (const id of selected) require(covered.has(id), 'UNCITED_TARGET')

    const distinctTexts = new Set([...authorized.values()].map((source) => source.text)).size
    const targetComparison = selected.size === 1 ? 'single-target'
      : distinctTexts === 1 ? 'identical-visible-text' : 'distinct-visible-text'
    return { ok: true, disposition: 'review-only', canApply: false, targetComparison }
  } catch (error) {
    // No untrusted values or exception messages leave the validator.
    return { ok: false, disposition: 'keep-original', canApply: false,
      code: error === stop ? failure : 'INVALID_INPUT' }
  }
}
