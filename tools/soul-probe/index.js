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
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ★ 别写死本机路径。原先这里是 `D:/AI/dsh-slots/logs/probe-compaction.log`，两个问题：
//   ① 换一台机器，那个目录不存在 → 写入失败 → 被下面的 catch 吞掉 →
//      于是「探针没写」和「压缩没被接管」在现象上**分不开**，读的人会得出相反结论。
//   ② 就算那台机器碰巧有同名目录，也是在往别人的目录里写。
//   现在：优先 `SOUL_PROBE_LOG`，否则落到系统临时目录（一定可写）。
const OUT = process.env.SOUL_PROBE_LOG || join(tmpdir(), 'dsh-soul-probe-compaction.log')

let warned = false

function log(tag, obj) {
  try {
    appendFileSync(OUT, new Date().toISOString() + ' [' + tag + '] ' + JSON.stringify(obj) + '\n', 'utf8')
  } catch (e) {
    // ★ 探针自己不许把宿主搞挂 —— 但也**不许一声不吭**。
    //   只说一次（避免每帧刷屏），并且把「写不进去」这件事本身说清楚：
    //   它是「探针坏了」，不是「压缩没接管」。
    if (!warned) {
      warned = true
      try {
        console.error(`[soul-probe] 探针写不进 ${OUT}：${e && e.message ? e.message : e}\n` +
          `  → 这是探针写不了日志，**不代表压缩没被接管**。设 SOUL_PROBE_LOG 换个可写路径。`)
      } catch { /* 连 stderr 都没有就算了 */ }
    }
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

// ★★ cordis 4 不允许没声明 inject 就 ctx.get()（报告 v3 R3 实测）：
//      cannot get property "compaction" without inject
//    不声明的后果不是「读不到」，是**整个探针跑不起来** —— 日志空白，
//    而读日志的人会把空白读成「压缩没接管」。那是错的结论。
//
// ★ 声明之后多了一种判读，别忽略：
//    服务不存在 → **整个探针不加载** → 日志里连 [register] 都没有
//    服务存在但探针自身出错 → 有 [register]，没有 [result]
//   以前这两种都长成「日志是空的」，现在能分开。
export const inject = ['compaction']

export function apply(ctx) {
  log('register', { note: 'soul-probe applied' })

  // ★ 会话还活着吗（报告 v4 观察项 1，2026-10-22）。
  //
  //   headless 在鉴权失败后**立即失活**，而我们的定时器还在跑。
  //   失活之后 ctx.get 抛的是：
  //     cannot get required service "compaction" in inactive context
  //   以前它被 catch 记成 [error] —— 于是日志尾部两行 error，
  //   **读的人会以为「压缩没了」**，而实际上只是会话结束了。
  //
  //   ★ 这和 R3 是同一类病：失败和「没验」长得一样。
  //   所以这里记一条 skipped，把「为什么没验」写明白，
  //   而不是让它掉进 error 里冒充一个真问题。
  const alive = () => {
    try {
      const s = ctx.scope
      // 拿不到 scope 信息时**当作还活着** —— 别因为判不出来就把自己废掉。
      if (!s || typeof s.active !== 'boolean') return true
      return s.active
    } catch {
      return true
    }
  }

  const probe = (when) => {
    if (!alive()) {
      log('skipped', {
        when,
        why: 'context inactive —— 会话已经结束，这次采样没有意义。**不是压缩没接管。**',
      })
      return
    }
    try {
      let c = null
      let how = null
      if (typeof ctx.get === 'function') {
        try {
          c = ctx.get('compaction')
          how = 'ctx.get'
        } catch (e) {
          const m = String((e && e.message) || e)
          // ★ 内层也要判失活（这是测出来的第二层）：
          //   以前这里把异常吞进 how 字符串，于是**整条被记成 result**，
          //   result 里带着 "ctx.get threw: ...inactive..." —— 读起来像「读到了」。
          if (/inactive/i.test(m)) {
            log('skipped', {
              when,
              why: 'context inactive —— 会话已经结束，这次采样没有意义。**不是压缩没接管。**',
              seen: m,
            })
            return
          }
          how = 'ctx.get threw: ' + m
        }
      }
      if (!c && ctx.compaction) { c = ctx.compaction; how = 'ctx.compaction' }
      log('result', { when, how, ...describe(c) })
    } catch (e) {
      const msg = String((e && e.message) || e)
      // ★ 即使 alive() 判出来了也保一道：错误文本里带 inactive 就不是真错。
      //   （scope 字段在不同 cordis 版本里不一定有，别把判据押在一处。）
      if (/inactive/i.test(msg)) {
        log('skipped', {
          when,
          why: 'context inactive —— 会话已经结束，这次采样没有意义。**不是压缩没接管。**',
          seen: msg,
        })
      } else {
        log('error', { when, msg })
      }
    }
  }

  // 三次采样：注册瞬间、1.2 秒后（插件陆续就位）、5 秒后（全部稳定）
  probe('immediate')
  setTimeout(() => probe('t+1200'), 1200)
  setTimeout(() => probe('t+5000'), 5000)

  // ★ 判读口径（配合上面两个 skipped）：
  //   [result]  → 有答案
  //   [skipped] → 会话结束得太快，没来得及看。**这不是坏消息，是没有消息。**
  //   [error]   → 会话还活着但读失败了。这个才是真问题。
}
