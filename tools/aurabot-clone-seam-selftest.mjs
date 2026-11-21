import assert from 'node:assert/strict'
import { createAllowlistLoader, createHostModules, resolveLoadLibImpl } from '../src/aurabot/src/core/clone-seam.js'

const production = async () => 'production'
assert.equal(resolveLoadLibImpl(undefined, production), production, 'default loader binding stays production loadLib')
const requests = []
const allowed = ['chat/access.js', 'core/redact.js']
const fakeImporter = async (key) => { requests.push(key); return { sentinel: key } }
const cloneOnlyLoader = createAllowlistLoader({ allowlist: allowed, importer: fakeImporter })
const loaded = await cloneOnlyLoader()
assert.deepEqual(requests, allowed, 'clone imports exactly the explicit allowlist, in order')
assert.deepEqual([...loaded.keys()], allowed)
for (const bad of ['not-listed.js', '../secret.js', '/absolute.js', 'C:/absolute.js', 'chat\\access.js']) {
  requests.length = 0
  await assert.rejects(cloneOnlyLoader([bad]), /unknown module|invalid module path/)
  assert.equal(requests.length, 0, `reject ${bad} before importer`)
}
for (const badPath of ['../escape.js', '/absolute.js', 'C:/absolute.js', 'chat\\access.js']) {
  assert.throws(() => createAllowlistLoader({ allowlist: [badPath], importer: fakeImporter }), /invalid allowlist path/)
}
const broken = createAllowlistLoader({ allowlist: ['one.js'], importer: async () => { throw new Error('sentinel failure') } })
let fallbackCalls = 0
const selectedLoader = resolveLoadLibImpl(broken, async () => { fallbackCalls++; return 'fallback' })
await assert.rejects(selectedLoader(), /sentinel failure/)
assert.equal(fallbackCalls, 0, 'loader failure does not fallback')
const forwarded = []
const fakeModules = { loadLibImpl: cloneOnlyLoader }
const fakeFactory = (args) => { forwarded.push(args); return { boot: () => args.loadLibImpl() } }
const ctx = Object.freeze({ fake: true })
const hostModule = createHostModules({ createModulesImpl: fakeFactory, base: { ctx, marker: 'base' }, options: { modules: { loadLibImpl: cloneOnlyLoader } } })
await hostModule.boot()
assert.equal(forwarded[0].ctx, ctx, 'host helper receives fake ctx')
assert.equal(forwarded[0].loadLibImpl, cloneOnlyLoader, 'host forwards options.modules to module factory and boot')
assert.deepEqual(requests.slice(-allowed.length), allowed)
const defaulted = createHostModules({ createModulesImpl: fakeFactory, base: { ctx }, options: {} })
assert.equal(forwarded[1].loadLibImpl, undefined, 'omitted host options do not replace defaults')
assert.ok(defaulted)
console.log('aurabot clone seam selftest: PASS')
