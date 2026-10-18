// 临时探针：boot 后读取 ctx.compaction 的真实身份。
//
// ★ 它只回答一个问题：**沙箱里真正在管压缩的，是我们的 YanqingCompaction，还是内置的 BasicCompactionEngine？**
//   在此之前这件事一直只能靠「dump-config 里有」来间接推断 —— 那不是运行时证据。
//
// 判读：
//   ctor 含 "Yanqing"  → 我们的实现接管了
//   ctor 是 Basic...   → 没接管，内置的还在位
//   两者都不像 / ctx 读不到 → 说明服务在另一个 realm 里（isolate），探针看不见

import { appendFileSync } from 'node:fs'

const OUT = 'D:/AI/dsh-slots/logs/probe-compaction.log'

function log(tag, obj) {
  try {
    appendFileSync(OUT, new Date().toISOString() + ' [' + tag + '] ' + JSON.stringify(obj) + '\n', 'utf8')
  } catch {
    // 探针自己不许把宿主搞挂
  }
}

function describe(c) {
  if (!c) return { has: false }
  let proto = null
  try { proto = Object.getPrototypeOf(c) } catch { /* noop */ }
  const methods = proto ? Object.getOwnPropertyNames(proto) : []
  const chain = []
  let p = proto
  while (p && chain.length < 6) {
    chain.push(p.constructor ? p.constructor.name : '?')
    try { p = Object.getPrototypeOf(p) } catch { break }
  }
  return {
    has: true,
    ctor: c.constructor ? c.constructor.name : '?',
    who: typeof c.who === 'function' ? (() => { try { return c.who() } catch (e) { return 'threw: ' + e.message } })() : null,
    // 我们的类独有：__yqRange 与那两个覆盖方法
    yqMark: methods.filter((m) => m.includes('yq') || m.includes('Yq')),
    overrides: methods.filter((m) => m === 'summarize' || m === 'compactRegion'),
    chain,
    ownKeys: Object.keys(c).slice(0, 24),
    isProxy: (() => { try { return c[Symbol.toStringTag] === 'Proxy' } catch { return null } })(),
  }
}

export const name = 'soul-probe'

export function apply(ctx) {
  log('register', { note: 'soul-probe applied' })

  const probe = (when) => {
    try {
      let c = null
      let how = null
      if (typeof ctx.get === 'function') {
        try { c = ctx.get('compaction'); how = 'ctx.get' } catch (e) { how = 'ctx.get threw: ' + e.message }
      }
      if (!c && ctx.compaction) { c = ctx.compaction; how = 'ctx.compaction' }
      log('result', { when, how, ...describe(c) })
    } catch (e) {
      log('error', { when, msg: String((e && e.message) || e) })
    }
  }

  // 三次采样：注册瞬间、1.2 秒后（插件陆续就位）、5 秒后（全部稳定）
  probe('immediate')
  setTimeout(() => probe('t+1200'), 1200)
  setTimeout(() => probe('t+5000'), 5000)
}
