import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPackageMetadataGetter } from '../src/aurabot/src/core/package-metadata.js'
import { resolveHostBootstrapDeps } from '../src/aurabot/src/core/clone-seam.js'

const toolDir = dirname(fileURLToPath(import.meta.url))
const hostPath = resolve(toolDir, '../src/aurabot/src/host.js')
const hostSource = readFileSync(hostPath, 'utf8')
const packageMetadataPath = resolve(dirname(hostPath), '..', 'package.json')
assert.equal(packageMetadataPath, resolve(toolDir, '../src/aurabot/package.json'), 'default metadata path is Aurabot package.json')
const metadataReadTrace = []
const metadataFixture = Object.freeze({ version: 'fixture-version' })
const getFixtureMetadata = createPackageMetadataGetter({ path: packageMetadataPath, readFile(path, encoding) { metadataReadTrace.push([path, encoding]); return JSON.stringify(metadataFixture) } })
assert.deepEqual(metadataReadTrace, [], 'creating the lazy getter performs no read')
const firstMetadata = getFixtureMetadata()
const secondMetadata = getFixtureMetadata()
assert.deepEqual(firstMetadata, metadataFixture)
assert.equal(secondMetadata, firstMetadata, 'cached metadata object is reused')
assert.deepEqual(metadataReadTrace, [[packageMetadataPath, 'utf8']], 'getter reads exactly once')
assert.ok(hostSource.includes("const getPackageMetadata = createPackageMetadataGetter({ path: join(ROOT, 'package.json'), readFile: readFileSync })"))
const metadataUse = hostSource.indexOf('const PKG = getPackageMetadataImpl()')
const applyStart = hostSource.indexOf('export function apply(')
assert.ok(metadataUse > applyStart, 'host import has no top-level metadata getter call')
assert.equal((hostSource.match(/const PKG = getPackageMetadataImpl\(\)/g) || []).length, 1, 'apply has one injected metadata getter call site')
assert.ok(hostSource.indexOf("phaseTrace.push('systemPrompt', 'stop-before-gateway')") < metadataUse, 'metadata consumption follows the clone early boundary')

const trace = []
const factoryTrace = []
let deniedWrites = 0
const cfg = { enabled: false, dryRun: true, botQQ: '', ownerQQ: '', gateway: 'onebot', workspaceDir: '', model: {}, persona: { current: 'fixture' }, security: {}, snowluma: {}, imageGen: {}, bridge: {}, modules: {}, safeMode: true, allow: { groups: [] } }
const cfgAdapter = {
  load() { trace.push('config.load'); return cfg },
  save() { deniedWrites++; throw Object.assign(new Error('clone config save denied'), { code: 'CLONE_WRITE_DENIED' }) },
  public(value) { trace.push('config.public'); return value },
  mergeFromPanel() { deniedWrites++; throw Object.assign(new Error('clone config merge denied'), { code: 'CLONE_WRITE_DENIED' }) },
}
const personaAdapter = {
  seed() { trace.push('persona.seed'); return { seeded: 0, fixtureOnly: true } },
  list() { trace.push('persona.list'); return [{ id: 'fixture', name: 'Fixture', tags: [], chars: 7 }] },
  read(id) { trace.push('persona.read'); return id === 'fixture' ? { id, name: 'Fixture', tags: [], body: 'fixture', raw: 'fixture' } : null },
  save() { deniedWrites++; throw Object.assign(new Error('clone persona save denied'), { code: 'CLONE_WRITE_DENIED' }) },
  delete() { deniedWrites++; throw Object.assign(new Error('clone persona delete denied'), { code: 'CLONE_WRITE_DENIED' }) },
  current(id) { trace.push('persona.current'); return id === 'fixture' ? 'fixture persona' : '' },
  rules(kind) { trace.push('persona.rules.' + kind); return 'fixture rules' },
}
const groups = {
  config: ['load', 'save', 'public', 'mergeFromPanel'],
  persona: ['seed', 'list', 'read', 'save', 'delete', 'current', 'rules'],
  gateway: ['onebot', 'snowluma'], chat: ['hub', 'local', 'groupRoles', 'mutes'], bridge: ['create'],
  modules: ['createHost', 'create'], effects: ['register'],
  timers: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'], process: ['spawn'],
  fs: ['readFileSync', 'existsSync', 'writeFileSync', 'unlinkSync', 'statSync', 'mkdirSync'],
  clock: ['now'], model: ['defaultModel', 'askModel', 'reasoning', 'vision'],
}
const deps = Object.freeze(Object.fromEntries(Object.entries(groups).map(([group, members]) => [group, Object.freeze(Object.fromEntries(members.map((member) => {
  const fn = group === 'config' ? cfgAdapter[member] : group === 'persona' ? personaAdapter[member] : (...args) => {
    factoryTrace.push(group + '.' + member)
    const error = new Error('factory must not run: ' + group + '.' + member)
    error.code = 'CLONE_CAPABILITY_DENIED'
    throw error
  }
  fn.cloneOnly = true
  return [member, fn]
}))) ])))
const valid = Object.freeze({ bootstrap: Object.freeze({ mode: 'clone', deps }) })
assert.equal(resolveHostBootstrapDeps(undefined, 'production-sentinel'), 'production-sentinel')
assert.equal(resolveHostBootstrapDeps(valid, null), deps)
for (const options of [{}, { bootstrap: { mode: 'production', deps } }, { bootstrap: { mode: 'clone', deps: { ...deps, extra: {} } } }]) assert.throws(() => resolveHostBootstrapDeps(options, null))
for (const group of Object.keys(groups)) {
  const incomplete = Object.freeze({ ...deps, [group]: Object.freeze({}) })
  assert.throws(() => resolveHostBootstrapDeps(Object.freeze({ bootstrap: Object.freeze({ mode: 'clone', deps: incomplete }) }), null), new RegExp('bootstrap\.deps\.' + group))
}
for (const operation of [() => deps.config.save(cfg), () => deps.config.mergeFromPanel(cfg, {}), () => deps.persona.save('x', {}), () => deps.persona.delete('x')]) assert.throws(operation, (error) => error.code === 'CLONE_WRITE_DENIED')
assert.equal(deniedWrites, 4)

const host = await import(new URL('../src/aurabot/src/host.js', import.meta.url).href)
const registrations = []
const fakeCtx = Object.freeze({
  systemPrompt: Object.freeze({ variable(name, callback) { registrations.push({ name, callback }) } }),
})
let boundary
let cloneGetterCalls = 0
try { host.apply(fakeCtx, valid, () => { cloneGetterCalls++; return metadataFixture }) } catch (error) { boundary = error }
assert.equal(cloneGetterCalls, 0, 'clone apply stops before the injected metadata getter')
assert.equal(boundary?.code, 'CLONE_SCOPE_UNISOLATED')
assert.equal(boundary?.phase, 'stop-before-gateway')
assert.deepEqual(boundary?.phaseTrace, ['cloneConfig', 'clonePersona', 'systemPrompt', 'stop-before-gateway'])
assert.deepEqual(trace.slice(0, 2), ['config.load', 'persona.seed'])
assert.deepEqual(registrations.map(({ name }) => name), ['aurabot_persona', 'aurabot_rules_private', 'aurabot_rules_social'])
assert.deepEqual(factoryTrace, [], 'no gateway/chat/bridge/modules/effect/timer/fs/process/model factory runs')
assert.equal(deniedWrites, 4)
console.log('aurabot bootstrap seam selftest: PASS (real apply reaches fixture config/persona and stops before gateway; apply not successful)')
