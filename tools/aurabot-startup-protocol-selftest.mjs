import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHostModules, resolveAurabotApplyOptions } from '../src/aurabot/src/core/modules.js'

const shimSource = readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8')
const coreSource = readFileSync(new URL('../src/core-entry.mjs', import.meta.url), 'utf8')
assert.match(coreSource, /await mod\.apply\(ab\.ctx, applyOptions\);/, 'ordinary startup retains the production apply options call in the moved core')
assert.doesNotMatch(coreSource, /AURABOT_CLONE|cloneMode|cloneLoader/, 'production core does not read clone mode from environment or globals')
assert.match(shimSource, /path\.resolve\(process\.argv\[1\]\) === path\.resolve\(fileURLToPath\(import\.meta\.url\)\)/, 'shim uses exact resolved path comparison for direct-main detection')
assert.match(shimSource, /if \(isDirectMain\) \{[\s\S]*await import\('\.\/core-entry\.mjs'\);[\s\S]*\}/, 'shim imports core only within the direct-main branch, including guarded preflight paths')

const fallback = resolveAurabotApplyOptions()
assert.equal(fallback, undefined, 'default protocol is off and returns no options')
assert.equal(resolveAurabotApplyOptions({ cloneMode: false, cloneLoader: async () => new Map() }), undefined, 'loader cannot activate clone mode alone')
assert.throws(() => resolveAurabotApplyOptions({ cloneMode: true }), /cloneLoader must be a function/, 'clone mode without explicit loader fails closed')
const cloneOnlyLoader = async () => new Map([['sentinel.js', { clone: true }]])
const options = resolveAurabotApplyOptions({ cloneMode: true, cloneLoader: cloneOnlyLoader })
assert.deepEqual(Object.keys(options), ['modules'])
assert.deepEqual(Object.keys(options.modules), ['loadLibImpl'])
assert.equal(options.modules.loadLibImpl, cloneOnlyLoader, 'clone-only loader is passed by explicit options')

const forwarded = []
const ctx = Object.freeze({ fake: true })
const fakeFactory = (args) => { forwarded.push(args); return { boot: async () => args.loadLibImpl() } }
const host = createHostModules({ createModulesImpl: fakeFactory, base: { ctx }, options })
const loaded = await host.boot()
assert.equal(forwarded[0].ctx, ctx)
assert.equal(forwarded[0].loadLibImpl, cloneOnlyLoader, 'Host forwards explicit clone options to createModules')
assert.deepEqual([...loaded.keys()], ['sentinel.js'])
const ordinary = createHostModules({ createModulesImpl: fakeFactory, base: { ctx } })
assert.equal(forwarded[1].loadLibImpl, undefined, 'omitted options preserve factory default')
assert.ok(ordinary)
console.log('aurabot startup protocol selftest: PASS')
