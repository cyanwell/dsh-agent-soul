import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { satisfies } from 'semver'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/**
 * Every `@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm` version published as
 * of 2026-09-23, oldest first; `npm view @deepseek-ai/dsh-agent versions`
 * refreshes it.
 *
 * The list is deliberately frozen: it is a record of what the range was checked
 * against, not a live query. A version published later is not covered by this
 * test — that is what the release checklist is for.
 */
const PUBLISHED = [
  '0.0.1-rc.1', '0.0.1-rc.2', '0.0.1-rc.3', '0.0.1-rc.5',
  '0.1.0-rc.2', '0.1.0-rc.3', '0.1.0-rc.6', '0.1.0-rc.7', '0.1.0-rc.8',
  '0.1.1-rc.1', '0.1.1-rc.2',
  '0.1.2-alpha.2', '0.1.2-alpha.3', '0.1.2-alpha.4', '0.1.2-alpha.5',
  '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
  '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1',
]

/**
 * The versions this plugin is expected to install against.
 *
 * The seam the guard wraps (`llm/stream`) plus the three symbols it imports
 * (`createUserMessage`, `isAgentLoopRequest`, `markAgentLoopRequest`) predate
 * all of them.
 *
 * ## Pinning a version line means pinning the WHOLE set
 *
 * Pinning only `dsh-llm` leaves a second copy nested under `dsh-session`, whose
 * own dependency still points at the newer line. Two copies of the branded
 * `MessageId` then produce a spurious "Property '[BRAND]' is missing" error that
 * looks like a plugin defect. Move every `@deepseek-ai` devDependency together.
 */
const SUPPORTED = [
  '0.1.2-rc.1',
  '0.1.3-alpha.2',
  '0.1.5-alpha.1', '0.1.5-alpha.2', '0.1.5-rc.1', '0.1.5-rc.2', '0.1.5-rc.3',
  '0.1.6-alpha.1', '0.1.6-alpha.2',
  '0.1.7-alpha.1', '0.1.7-alpha.2', '0.1.7-rc.1',
]

/**
 * Guard the peer range by *computing* admission, not by pattern-matching it.
 *
 * v0.1.6 shipped a test that merely asserted the range string contained
 * `0.1.2-rc.N` and `0.1.5-(alpha|beta|rc).N`. That form cannot tell a correct
 * range from an incorrect one — it fails only on a *different-looking* string —
 * and so it certified a range that was already wrong: the shipped
 * `>=0.1.2-rc.1 <0.2.0 || >=0.1.5-alpha.1 <0.2.0` admits only the 0.1.2-rc and
 * 0.1.5 tuples, because a semver comparator admits a prerelease only when some
 * comparator in the same group shares that prerelease's major.minor.patch
 * tuple. The 0.1.3-alpha.2 line and the whole 0.1.6 line were excluded, so a
 * user on the newest shipped dsh line got
 *
 *   npm error ERESOLVE unable to resolve dependency tree
 *   npm error peer @deepseek-ai/dsh-agent@">=0.1.2-rc.1 <0.2.0 || ..." from
 *   npm error   dsh-loop-guard@0.1.6
 *
 * for a plugin whose suite passes on that line. The dsh packages are *peers*, so
 * the range cannot be papered over with `--legacy-peer-deps`: the install simply
 * fails.
 *
 * Asserting the admitted set *exactly* makes both failure directions loud: a
 * range that quietly drops a supported line fails the equality below, and a
 * range that quietly admits an untested line fails it too.
 */
for (const dep of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm']) {
  test(`peer range for ${dep} admits exactly the tested dsh lines`, () => {
    const range = pkg.peerDependencies[dep]
    assert.ok(range, 'the dsh peer dependency must be declared')

    const admitted = PUBLISHED.filter((v) => satisfies(v, range))
    assert.deepEqual(
      admitted,
      SUPPORTED,
      `the range "${range}" admits [${admitted.join(', ')}] but the suite has only been ` +
        `run against [${SUPPORTED.join(', ')}]`,
    )

    const refused = PUBLISHED.filter((v) => !satisfies(v, range))
    assert.deepEqual(
      refused,
      PUBLISHED.filter((v) => !SUPPORTED.includes(v)),
      'older, untested prereleases must keep getting a loud ERESOLVE',
    )
  })
}

test('a bare >=0.1.2 comparator would match no published prerelease', () => {
  // Not a semver evaluator: this pins the *reason* the union exists, so a later
  // "simplification" to `>=0.1.2` fails here with the explanation attached.
  for (const version of PUBLISHED) {
    assert.equal(satisfies(version, '>=0.1.2'), false, `>=0.1.2 unexpectedly admits ${version}`)
  }
  assert.equal(satisfies('0.1.6-alpha.2', pkg.peerDependencies['@deepseek-ai/dsh-llm']), true)
})

test('the newest shipped dsh line is admitted (issue #1 regression)', () => {
  // The defect this release fixes: the whole 0.1.6 line was refused, so a user
  // on the newest dsh could not install the plugin at all.
  for (const line of ['0.1.6-alpha.1', '0.1.6-alpha.2']) {
    for (const dep of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm']) {
      assert.equal(
        satisfies(line, pkg.peerDependencies[dep]),
        true,
        `${dep} must admit ${line}`,
      )
    }
  }
})

test('the dev pins stay on a line the range admits', () => {
  // A dev pin outside the peer range would mean the suite ran against a line the
  // published package refuses — the exact mismatch this file exists to prevent.
  for (const dep of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm']) {
    const pin = pkg.devDependencies[dep]
    assert.ok(SUPPORTED.includes(pin), `devDependency ${dep}@"${pin}" is not in the tested set`)
  }
})
