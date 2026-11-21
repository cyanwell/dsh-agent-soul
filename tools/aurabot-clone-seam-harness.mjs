import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

// The first filesystem operation establishes the sole permitted root.
const TEMP_ROOT = await fs.realpath(os.tmpdir())
const runRoot = await fs.mkdtemp(path.join(TEMP_ROOT, 'aurabot-seam-harness-'))
const resolvedRunRoot = await fs.realpath(runRoot)
if (!resolvedRunRoot.startsWith(TEMP_ROOT + path.sep)) throw new Error('TEMP root escaped os.tmpdir')
const reportPath = path.join(resolvedRunRoot, 'evidence.json')
const evidence = {
  title: 'seam harness',
  classification: 'TEMP-only seam harness; not full-core',
  tempRoot: resolvedRunRoot,
  requestedKeys: [],
  rejected: [],
  defaultProductionBindingUsed: false,
  effectsCount: 0,
  hostApplyCalled: false,
  outcome: 'BLOCKED',
  blockers: ['Calling real host.apply(ctx, options) executes hard-wired config/persona/service/core setup and mods.boot(); no proven instance-level injection exists to make those operations fully reject-only without modifying production code or accessing paths outside TEMP.'],
}
try {
  const { createAllowlistLoader, createHostModules, resolveAurabotApplyOptions, resolveLoadLibImpl } = await import('../src/aurabot/src/core/clone-seam.js')
  const allowlist = ['chat/access.js', 'core/redact.js']
  const importer = async (key) => {
    evidence.requestedKeys.push(key)
    return Object.freeze({ sentinel: key })
  }
  const loader = createAllowlistLoader({ allowlist, importer })
  const options = resolveAurabotApplyOptions({ cloneMode: true, cloneLoader: loader })
  assert.deepEqual(Object.keys(options.modules), ['loadLibImpl'])
  assert.equal(options.modules.loadLibImpl, loader)
  const fakeServices = new Proxy(Object.create(null), { get(_t, key) { throw new Error('denied service access: ' + String(key)) } })
  const ctx = Object.freeze({
    get: () => { throw new Error('denied ctx.get') },
    effect: () => { evidence.effectsCount++; throw new Error('denied ctx.effect') },
    on: () => { throw new Error('denied ctx.on') },
    interval: () => { throw new Error('denied ctx.interval') },
    webServer: fakeServices,
    core: fakeServices,
  })
  const observed = []
  const fakeFactory = (args) => {
    observed.push(args)
    return { boot: () => args.loadLibImpl() }
  }
  const forwarded = createHostModules({ createModulesImpl: fakeFactory, base: { ctx }, options })
  const loaded = await forwarded.boot()
  assert.deepEqual([...loaded.keys()], allowlist)
  assert.deepEqual(observed[0].ctx, ctx)
  assert.equal(observed[0].loadLibImpl, loader)
  const productionDefault = async () => 'production'
  const selectedClone = resolveLoadLibImpl(loader, productionDefault)
  assert.equal(selectedClone, loader)
  assert.equal(resolveLoadLibImpl(undefined, productionDefault), productionDefault)
  evidence.defaultProductionBindingUsed = selectedClone === productionDefault
  assert.equal(evidence.defaultProductionBindingUsed, false)
  for (const key of ['not-listed.js', '../outside.js', 'chat\\access.js']) {
    const before = evidence.requestedKeys.length
    await assert.rejects(loader([key]))
    assert.equal(evidence.requestedKeys.length, before, 'invalid key rejected before importer')
    evidence.rejected.push(key)
  }
  const defaultOptions = resolveAurabotApplyOptions()
  assert.equal(defaultOptions, undefined)
  evidence.helperSeam = 'PASS'
  evidence.outcome = 'BLOCKED'
  await fs.writeFile(reportPath, JSON.stringify(evidence, null, 2), 'utf8')
  const persisted = JSON.parse(await fs.readFile(reportPath, 'utf8'))
  assert.equal(persisted.outcome, 'BLOCKED')
  console.log(JSON.stringify({ ...persisted, tempArtifactsReadBack: true }, null, 2))
} finally {
  await fs.rm(resolvedRunRoot, { recursive: true, force: true })
}
