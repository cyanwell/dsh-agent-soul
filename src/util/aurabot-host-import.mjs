const GROUPS = Object.freeze({
  config: ['load','save','public','mergeFromPanel'], persona: ['seed','list','read','save','delete','current','rules'],
  gateway: ['onebot','snowluma'], chat: ['hub','local','groupRoles','mutes'], bridge: ['create'],
  modules: ['createHost','create'], effects: ['register'], timers: ['setTimeout','setInterval','clearTimeout','clearInterval'],
  process: ['spawn'], fs: ['readFileSync','existsSync','writeFileSync','unlinkSync','statSync','mkdirSync'],
  clock: ['now'], model: ['defaultModel','askModel','reasoning','vision'],
});

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(label + ' must be an object');
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new TypeError(label + ' keys must be exactly: ' + expected.join(', '));
}

export function validateAurabotCloneOptions(options) {
  if (options === undefined) return { mode: 'production', options: undefined };
  exactKeys(options, ['bootstrap'], 'apply options');
  exactKeys(options.bootstrap, ['mode', 'deps'], 'bootstrap');
  if (options.bootstrap.mode !== 'clone') throw new TypeError('bootstrap.mode must be clone');
  const deps = options.bootstrap.deps;
  exactKeys(deps, Object.keys(GROUPS), 'bootstrap.deps');
  for (const [group, members] of Object.entries(GROUPS)) {
    const value = deps[group]; exactKeys(value, members, 'bootstrap.deps.' + group);
    if (!Object.isFrozen(value)) throw new TypeError('bootstrap.deps.' + group + ' must be frozen');
    for (const member of members) if (typeof value[member] !== 'function' || value[member].cloneOnly !== true) throw new TypeError('bootstrap.deps.' + group + '.' + member + ' must be a clone-only function');
  }
  if (!Object.isFrozen(deps)) throw new TypeError('bootstrap.deps must be frozen');
  return { mode: 'clone', options };
}

export async function importAurabotHostBeforeEvaluation({ options, importHost }) {
  if (typeof importHost !== 'function') throw new TypeError('importHost must be a function');
  const validated = validateAurabotCloneOptions(options);
  const host = await importHost();
  return { host, applyOptions: validated.options };
}
