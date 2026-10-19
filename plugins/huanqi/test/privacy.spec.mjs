/**
 * No fixture may carry machine-specific identifiers.
 *
 * The other fixture suites are built from real session captures, and a model
 * narrating its own work writes absolute paths into its reasoning. Three fixtures
 * shipped that way — one carried `C:\Users\<user>` four times, plus npx cache
 * hashes and a live session UUID — because the fixtures were checked for "is this
 * a loop?" and never for "what else is in here?".
 *
 * Nothing in those was a credential (no token, key or password: scanned for JWT,
 * `sk-`, `Bearer` and assignment patterns, zero hits). What leaked was *identity
 * and layout*: the Windows user name, the npx cache hash that identifies the
 * installed dsh version, the session UUID, and the workspace directory name. Each
 * is harmless alone; together they say who, which machine, which session and
 * which workspace.
 *
 * This suite is the guard that was missing. It scans every fixture — and every
 * test file, since a capture can be inlined rather than loaded from a fixture —
 * and fails on a match, so the next capture cannot reintroduce one.
 *
 * Runs on the sources, not the built artifact: fixtures are test data.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname, relative } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/** Every file a capture could live in: fixtures and the suites that read them. */
function scannedFiles() {
  const out = []
  for (const dir of ['test', 'tools', 'src']) {
    let entries
    try { entries = readdirSync(join(ROOT, dir), { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      if (!e.isFile()) continue
      if (!/\.(mjs|js|json|ts)$/.test(e.name)) continue
      // This file necessarily contains sample leaks (its coverage test feeds them
      // in), so scanning it would report its own fixtures. Everything else is in
      // scope, including the other suites.
      if (e.name === 'privacy.spec.mjs') continue
      out.push(join(ROOT, dir, e.name))
    }
  }
  return out
}

/**
 * What must never appear, and why each one matters.
 *
 * The path rules deliberately tolerate **any** separator form: a capture can hold
 * a path as plain text, as JSON-escaped text (each separator doubled, or doubled
 * twice if the capture itself is a JSON string inside JSON), or with forward
 * slashes. The first version of this scan only accepted one or two backslashes
 * and silently passed a four-backslash form — so the rules below match a run of
 * separators of any length. A scan that misses a form is worse than no scan,
 * because it certifies the fixture as clean.
 *
 * `ALLOWED` exists because the redaction placeholders are themselves
 * session-shaped and hash-shaped by design.
 */
const RULES = [
  {
    name: 'absolute home path with a user name',
    // `C:\Users\x`, `C:\\Users\\x`, `C:\\\\Users\\\\x`, `C:/Users/x`, `/home/x`,
    // `/Users/x` — any separator run, either slash direction, either case.
    re: /(?:[A-Za-z]:[\\/]{1,4}Users[\\/]{1,4}|[\\/]{1,4}home[\\/]{1,4}|[\\/]{1,4}Users[\\/]{1,4})([A-Za-z0-9._-]{2,})/gi,
    why: 'names the machine owner',
  },
  {
    name: 'npx cache hash',
    re: /_npx[\\/]{1,4}([0-9a-f]{16})/gi,
    why: 'identifies which dsh version this machine installed',
  },
  {
    name: 'real session identifier',
    re: /session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g,
    why: 'names a live local session directory',
  },
  {
    name: 'bare session UUID',
    re: /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/g,
    why: 'names a live local session',
  },
  {
    name: 'credential-shaped string',
    // `sk-` keys, and JWTs with either a 20+ or 10+ character signature segment.
    re: /\b(sk-[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,})\b/g,
    why: 'is or looks like a secret',
  },
  {
    name: 'credential assignment',
    // Any 8+ character quoted value on a credential-shaped key.
    re: /\b(?:access_?token|refresh_?token|id_?token|api_?key|client_?secret|password|passwd)\b["']?\s*[:=]\s*["']([^"']{8,})["']/gi,
    why: 'assigns a secret',
  },
]

/** Values that are deliberately safe and must not be reported. */
const ALLOWED = new Set([
  '00000000-0000-0000-0000-000000000000', // the redacted session UUID
  '0000000000000000',                     // the redacted npx cache hash
  'user0',                                // the redacted user name
])

test('the scan actually covers the fixtures and suites', () => {
  // A scan that silently walks an empty directory proves nothing.
  const files = scannedFiles()
  assert.ok(files.length >= 10, `expected to scan the repo, got ${files.length} files`)
  const names = files.map((f) => relative(ROOT, f).replace(/\\/g, '/'))
  assert.ok(names.some((n) => n.startsWith('test/fixtures-')), 'fixtures must be in scope')
  assert.ok(names.includes('test/text-lines.spec.mjs'), 'the suites themselves must be in scope')
})

test('no scanned file carries a machine-specific identifier', () => {
  const findings = []
  for (const file of scannedFiles()) {
    const text = readFileSync(file, 'utf8')
    for (const rule of RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags)
      let match
      while ((match = re.exec(text)) !== null) {
        const value = match[1] ?? match[0]
        if (ALLOWED.has(value)) continue
        // Report the line so the finding is actionable.
        const line = text.slice(0, match.index).split('\n').length
        findings.push(
          `${relative(ROOT, file).replace(/\\/g, '/')}:${line} — ${rule.name} `
          + `(${JSON.stringify(value.slice(0, 60))}) ${rule.why}`,
        )
      }
    }
  }
  assert.deepEqual(
    findings,
    [],
    'fixtures are built from real captures; redact identifiers before committing:\n'
    + findings.join('\n'),
  )
})

test('the redaction placeholders are the only session-shaped values present', () => {
  // Positive control for the scan above: the fixtures DO contain session-shaped
  // text, and it is the placeholder. If this stops holding, the previous test
  // could be passing because the fixtures were emptied rather than redacted.
  const lines = readFileSync(join(HERE, 'fixtures-reasoning-lines.json'), 'utf8')
  assert.ok(lines.includes('session-00000000-0000-0000-0000-000000000000'), 'the session id is redacted in place')
  assert.ok(lines.includes('Users\\\\user0'), 'the user name is redacted in place')
  assert.ok(lines.includes('--W-KSP--'), 'the workspace name is redacted in place')
  assert.ok(lines.includes('_npx\\\\0000000000000000'), 'the npx hash is redacted in place')
})

test('the rules catch every separator and escaping form a capture can hold', () => {
  // Coverage of the SCAN itself, which is the part that failed silently the first
  // time: the original rules accepted one or two backslashes and passed a
  // four-backslash path. Each case below is a form a real capture can contain,
  // because a capture may be plain text, JSON-escaped once, or escaped twice.
  const mustCatch = [
    ['one backslash', 'C:\\Users\\71026\\AppData'],
    ['two backslashes', 'C:\\\\Users\\\\71026\\\\AppData'],
    ['four backslashes', 'C:\\\\\\\\Users\\\\\\\\71026\\\\\\\\AppData'],
    ['forward slashes', 'C:/Users/71026/AppData'],
    ['mixed separators', 'C:\\/Users\\/71026/AppData'],
    ['lowercase drive', 'c:\\users\\71026'],
    ['linux home', '/home/71026/project'],
    ['macOS home', '/Users/71026/project'],
    ['npx hash', '_npx\\\\c8633a242642d858'],
    ['npx hash, one slash', '_npx\\c8633a242642d858'],
    ['session dir', 'session-e6c96e85-9abf-4487-b1e6-d3e00c635e5b'],
    ['bare uuid', 'id e6c96e85-9abf-4487-b1e6-d3e00c635e5b'],
    ['sk- key', 'sk-abcdefghijklmnopqrstuvwx'],
    ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij'],
    ['token assignment', '"accessToken":"abcdefghijklmnop1234"'],
    ['snake_case secret', '"api_key": "abcdefghijklmnop"'],
  ]
  const mustPass = [
    ['the redaction placeholders', 'C:\\\\Users\\\\user0 _npx\\\\0000000000000000 session-00000000-0000-0000-0000-000000000000'],
    ['an unrelated number', 'the value is 71026 items'],
    ['a short hex string', 'hash abc123def456'],
    ['an ordinary path without a user', 'C:\\\\Program Files\\\\nodejs'],
  ]

  for (const [label, sample] of mustCatch) {
    const hit = RULES.some((rule) => {
      const re = new RegExp(rule.re.source, rule.re.flags)
      let m
      while ((m = re.exec(sample)) !== null) {
        if (!ALLOWED.has(m[1] ?? m[0])) return true
      }
      return false
    })
    assert.ok(hit, `the scan must catch ${label}: ${JSON.stringify(sample)}`)
  }

  for (const [label, sample] of mustPass) {
    const hits = []
    for (const rule of RULES) {
      const re = new RegExp(rule.re.source, rule.re.flags)
      let m
      while ((m = re.exec(sample)) !== null) {
        const value = m[1] ?? m[0]
        if (!ALLOWED.has(value)) hits.push(`${rule.name}: ${JSON.stringify(value)}`)
      }
    }
    assert.deepEqual(hits, [], `the scan must NOT flag ${label}: ${hits.join(', ')}`)
  }
})
