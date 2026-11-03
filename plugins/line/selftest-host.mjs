// selftest-host.mjs —— 用假 ctx 真跑一遍宿主半的 apply，看它注册了什么、有没有抛错。
//
// 为什么要这个：宿主半的路由没注册时，唯一的症状是「404」——不报错、不留日志。
// 这个探针把 apply 从 DSH 进程里单独拎出来跑，抛错就会立刻现形。
//
// 用法：
//   node selftest-host.mjs                       # 测已安装的那一份
//   node selftest-host.mjs <插件目录>            # 测指定的那一份

const dir = process.argv[2] || 'D:\\AI\\dsh\\home\\profiles\\desktop\\node_modules\\dsh-yanqing-line'
const url = 'file:///' + dir.replace(/\\/g, '/') + '/index.js'

console.log('目标：' + dir)
console.log('')

const mod = await import(url)
console.log('  export name   = ' + mod.name)
console.log('  export inject = ' + JSON.stringify(mod.inject))
console.log('  export apply  = ' + typeof mod.apply)
console.log('')

const seen = []

const ctx = {
  // 宿主半用到的服务，各自给一个会记账的假实现
  webServer: {
    register(opts) {
      seen.push({ what: 'route', kind: opts && opts.kind, path: opts && opts.path, handler: typeof (opts && opts.handler) })
      return { dispose() {} }
    },
  },
  tools: {
    register(t) {
      seen.push({ what: 'tool', name: t && t.name, execute: typeof (t && t.execute) })
      return { dispose() {} }
    },
  },
  effect(fn, name) {
    try { fn() } catch (e) { seen.push({ what: 'effect-ERROR', name, message: String(e && e.message) }) }
    return { dispose() {} }
  },
  // 有些半会 ctx.get(...) 拿东西；给个空对象免得判空后静默 return
  get() { return undefined },
  logger: { info() {}, warn() {}, error() {} },
}

let threw = null
try {
  mod.apply(ctx)
} catch (e) {
  threw = e
}

console.log('apply 执行结果：')
if (threw) {
  console.log('  ★★ 抛错了：' + threw.message)
  console.log(String(threw.stack || '').split('\n').slice(0, 8).map((l) => '     ' + l).join('\n'))
} else {
  console.log('  ✓ 没抛错')
}
console.log('')
console.log('注册了 ' + seen.length + ' 项：')
for (const s of seen) console.log('  ' + JSON.stringify(s))
console.log('')

if (threw) { process.exit(1) }
const routes = seen.filter((s) => s.what === 'route')
if (!routes.length) {
  console.log('★★ 没有注册任何路由 —— 这就是 404 的原因（apply 跑了但没走到 register）')
  process.exit(2)
}
console.log('✓ 注册了路由：' + routes.map((r) => r.path).join(', '))
