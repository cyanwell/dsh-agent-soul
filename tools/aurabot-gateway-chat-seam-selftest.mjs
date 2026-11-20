import assert from 'node:assert/strict'
import { resolveHostBootstrapDeps } from '../src/aurabot/src/core/clone-seam.js'

const factoryTrace = []
const deny = (name) => Object.assign(function denied() {
  factoryTrace.push(name)
  const error = new Error(name + ' denied')
  error.code = 'CLONE_CAPABILITY_DENIED'
  throw error
}, { cloneOnly: true })
const names = {
  config: ['load', 'save', 'public', 'mergeFromPanel'], persona: ['seed', 'list', 'read', 'save', 'delete', 'current', 'rules'],
  gateway: ['onebot', 'snowluma'], chat: ['hub', 'local', 'groupRoles', 'mutes'], bridge: ['create'],
  modules: ['createHost', 'create'], effects: ['register'], timers: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'],
  process: ['spawn'], fs: ['readFileSync', 'existsSync', 'writeFileSync', 'unlinkSync', 'statSync', 'mkdirSync'],
  clock: ['now'], model: ['defaultModel', 'askModel', 'reasoning', 'vision'],
}
const deps = Object.freeze(Object.fromEntries(Object.entries(names).map(([group, members]) => [group, Object.freeze(Object.fromEntries(members.map((member) => [member, deny(group + '.' + member)])))])))
const options = Object.freeze({ bootstrap: Object.freeze({ mode: 'clone', deps }) })
assert.equal(resolveHostBootstrapDeps(undefined, 'production'), 'production')
assert.equal(resolveHostBootstrapDeps(options), deps)
assert.throws(() => deps.gateway.onebot(), (error) => error.code === 'CLONE_CAPABILITY_DENIED')
assert.deepEqual(factoryTrace, ['gateway.onebot'])
const badDeps = Object.freeze({ ...deps, ghost: Object.freeze({}) })
assert.throws(() => resolveHostBootstrapDeps(Object.freeze({ bootstrap: Object.freeze({ mode: 'clone', deps: badDeps }) })), /keys must be exactly/)
const unmarked = Object.freeze({ ...deps, gateway: Object.freeze({ ...deps.gateway, onebot: () => ({}) }) })
assert.throws(() => resolveHostBootstrapDeps(Object.freeze({ bootstrap: Object.freeze({ mode: 'clone', deps: unmarked }) })), /cloneOnly marker/)
console.log('aurabot gateway/chat seam selftest: PASS (resolver contract + isolated factory deny fixture; real early-boundary apply covered by bootstrap selftest)')
