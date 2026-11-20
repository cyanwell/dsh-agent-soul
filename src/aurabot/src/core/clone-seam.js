const HOST_DEP_KEYS = Object.freeze(['config', 'persona', 'gateway', 'chat', 'bridge', 'modules', 'effects', 'timers', 'process', 'fs', 'clock', 'model'])
const HOST_DEP_MEMBERS = Object.freeze({
  config: ['load', 'save', 'public', 'mergeFromPanel'], persona: ['seed', 'list', 'read', 'save', 'delete', 'current', 'rules'],
  gateway: ['onebot', 'snowluma'], chat: ['hub', 'local', 'groupRoles', 'mutes'],
  bridge: ['create'], modules: ['createHost', 'create'], effects: ['register'],
  timers: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'], process: ['spawn'],
  fs: ['readFileSync', 'existsSync', 'writeFileSync', 'unlinkSync', 'statSync', 'mkdirSync'],
  clock: ['now'], model: ['defaultModel', 'askModel', 'reasoning', 'vision'],
})

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object')
  const keys = Object.keys(value).sort()
  const want = [...expected].sort()
  if (keys.length !== want.length || keys.some((key, i) => key !== want[i])) throw new TypeError(label + ' keys must be exactly: ' + want.join(', '))
}

export function resolveHostBootstrapDeps(options, productionDeps) {
  if (options === undefined) return productionDeps
  exactKeys(options, ['bootstrap'], 'apply options')
  exactKeys(options.bootstrap, ['mode', 'deps'], 'bootstrap')
  if (options.bootstrap.mode !== 'clone') throw new TypeError('bootstrap.mode must be "clone"')
  const deps = options.bootstrap.deps
  exactKeys(deps, HOST_DEP_KEYS, 'bootstrap.deps')
  for (const group of HOST_DEP_KEYS) {
    const value = deps[group]
    exactKeys(value, HOST_DEP_MEMBERS[group], 'bootstrap.deps.' + group)
    if (!Object.isFrozen(value)) throw new TypeError('bootstrap.deps.' + group + ' must be frozen')
    for (const member of HOST_DEP_MEMBERS[group]) if (typeof value[member] !== 'function') throw new TypeError('bootstrap.deps.' + group + '.' + member + ' must be a function')
  }
  if (!Object.isFrozen(deps)) throw new TypeError('bootstrap.deps must be frozen')
  for (const group of HOST_DEP_KEYS) {
    for (const member of HOST_DEP_MEMBERS[group]) {
      if (deps[group][member].cloneOnly !== true) throw new TypeError('bootstrap.deps.' + group + '.' + member + ' must carry cloneOnly marker')
    }
  }
  return deps
}

export function resolveLoadLibImpl(loadLibImpl, productionLoadLib) {
  const impl = loadLibImpl === undefined ? productionLoadLib : loadLibImpl
  if (typeof impl !== 'function') throw new TypeError('loadLibImpl must be a function')
  return impl
}

export function resolveAurabotApplyOptions({ cloneMode = false, cloneLoader } = {}) {
  if (cloneMode !== true) return undefined
  if (typeof cloneLoader !== 'function') throw new TypeError('cloneLoader must be a function in clone mode')
  return { modules: { loadLibImpl: cloneLoader } }
}

export function createHostModules({ createModulesImpl, base, options = {} }) {
  return createModulesImpl({ ...base, ...(options.modules || {}) })
}

export function createAllowlistLoader({ allowlist, importer }) {
  if (!Array.isArray(allowlist) || typeof importer !== 'function') throw new TypeError('allowlist and importer are required')
  const allowed = new Set(allowlist)
  const invalidPath = (key) => typeof key !== 'string' || !key || key.includes('\\') || key.startsWith('/') || /^[A-Za-z]:/.test(key) || key.split('/').some((part) => !part || part === '.' || part === '..')
  if (allowed.size !== allowlist.length || allowlist.some(invalidPath)) throw new Error('invalid allowlist path')
  return async function cloneOnlyLoader(requested = allowlist) {
    if (!Array.isArray(requested)) throw new TypeError('requested keys must be an array')
    for (const key of requested) {
      if (!allowed.has(key)) throw new Error(`unknown module: ${key}`)
      if (invalidPath(key)) throw new Error(`invalid module path: ${key}`)
    }
    const loaded = new Map()
    for (const key of requested) loaded.set(key, await importer(key))
    return loaded
  }
}