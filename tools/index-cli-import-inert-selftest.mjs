import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const shimPath = fileURLToPath(new URL('../src/index.mjs', import.meta.url))
const shimSource = readFileSync(shimPath, 'utf8')
const node = process.execPath

assert.match(shimSource, /^import path from 'node:path';\nimport \{ fileURLToPath \} from 'node:url';\nimport \{ checkDirectMainPreflight \} from '\.\/util\/direct-main-preflight\.mjs';/m, 'only inert path/url and preflight helpers are statically imported')
assert.match(shimSource, /const isDirectMain = Boolean\(process\.argv\[1\]\) &&\s*path\.resolve\(process\.argv\[1\]\) === path\.resolve\(fileURLToPath\(import\.meta\.url\)\);/, 'direct-main compares exact resolved entry paths')
assert.match(shimSource, /if \(isDirectMain\) \{\s*const preflightRequested = process\.env\.AGENT_SOUL_PREFLIGHT !== undefined;\s*if \(!preflightRequested\) \{\s*await import\('\.\/core-entry\.mjs'\);\s*\} else \{\s*const preflight = await checkDirectMainPreflight\(\);\s*if \(!preflight\.ok\) \{[\s\S]*?\} else \{\s*await import\('\.\/core-entry\.mjs'\);\s*\}\s*\}\s*\}/, 'legacy direct-main imports unchanged; opted-in branch awaits gate before core import')
assert.equal((shimSource.match(/\b(?:process\.on|setTimeout|setInterval|listen\s*\(|loadConfig|new SessionStore|import\(['"]\.\/core-entry\.mjs['"]\))/g) || []).length, 2, 'no startup side effects beyond the two guarded core-import branches')

const child = spawnSync(node, ['--input-type=module', '-e', 'await import(' + JSON.stringify(new URL('../src/index.mjs', import.meta.url).href) + ')'], {
  cwd: fileURLToPath(new URL('..', import.meta.url)),
  encoding: 'utf8',
  timeout: 10000,
  windowsHide: true,
})
assert.equal(child.error, undefined, 'fresh child exits without spawn/import error')
assert.equal(child.status, 0, 'fresh child naturally exits successfully')
assert.equal(child.stdout, '', 'fresh import writes no stdout')
assert.equal(child.stderr, '', 'fresh import writes no stderr')
console.log('index CLI import inert selftest: PASS')
