#!/usr/bin/env node
/**
 * probe-service-order.mjs —— **两个 Service 同名注册，谁赢？**
 * ==========================================================
 *
 * ★ 为什么要有这个
 * ----------------
 * `compaction-basic` 和 `dsh-agent-compaction` 现在**两条并存**在 profile 的层栈里
 * （`insert` 只能新增，改不了已有条目的 `name` —— 见 plugins/compaction/cordis.patch.yml）。
 * 于是「谁真的在干活」就成了一个必须回答、但读源码读不出来的问题：
 *
 *   · 两个都 `extends` 同一个基类、都注册成 `compaction` 服务
 *   · 后加进去的会不会覆盖先加进去的？会不会报错？会不会两个都活着？
 *
 * 跑一次真实压缩要等上下文到阈值，太贵也太慢。
 * **而这个问题其实是 cordis 的注册语义问题，跟压缩本身无关** ——
 * 所以用最小复现来答：两个只提供同名 service 的插件，看最后 `ctx.compaction` 是谁。
 *
 * ★ 用法
 * ------
 *   node tools/probe-service-order.mjs
 *
 * 不需要 profile、不需要 API key、不碰任何真实数据。
 */

// ★ 包名是 `@deepseek-ai/cordis`，不是 `cordis` —— 宿主把它 vendored 在自己的 node_modules 里，
//   所以这个脚本要在 profile 目录下跑（或用 NODE_PATH 指过去）。
import { Context, Service } from '@deepseek-ai/cordis'

/** 先注册的那个 —— 模拟「内置 compaction-basic」 */
class Builtin extends Service {
  constructor(ctx) {
    super(ctx, 'compaction', true)
    this.tag = 'builtin'
  }
  who() {
    return this.tag
  }
}

/** 后注册的那个 —— 模拟「dsh-agent-compaction」 */
class Mine extends Service {
  constructor(ctx) {
    super(ctx, 'compaction', true)
    this.tag = 'mine'
  }
  who() {
    return this.tag
  }
}

const results = []

/**
 * ★ 第一版这里是同步调的 ctx.plugin()，然后立刻读 ctx.compaction —— 读到 undefined。
 * 那不是「没注册」，是**注册是异步的**：cordis 的 Service 构造要等 fiber 起来。
 * 所以必须 await 一个 tick 再读。**这是我的判据错了，不是框架的行为。**
 */
const tick = () => new Promise((r) => setTimeout(r, 120))

async function probe(label, order) {
  const ctx = new Context()
  const errors = []
  for (const Cls of order) {
    try {
      ctx.plugin(Cls)
    } catch (e) {
      errors.push(String(e && e.message ? e.message : e))
    }
  }
  await tick()
  let who = null
  let threw = null
  try {
    who = ctx.compaction.who()
  } catch (e) {
    threw = String(e && e.message ? e.message : e)
  }
  results.push({ label, order: order.map((c) => c.name), who, threw, errors })
}

async function main() {
  // 场景 1：先内置、后本包（**这正是当前 profile 的顺序**）
  await probe('内置先、本包后（= 当前顺序）', [Builtin, Mine])

  // 场景 2：反过来，用来确认「顺序」确实是变量
  await probe('本包先、内置后（对照）', [Mine, Builtin])

  // ── 报告 ─────────────────────────────────────────────────────
  console.log('')
  console.log('═'.repeat(64))
  for (const r of results) {
    console.log('')
    console.log('▸ ' + r.label)
    console.log('  注册顺序 : ' + r.order.join(' → '))
    if (r.errors.length) {
      console.log('  注册报错 : ' + r.errors.join(' | '))
    } else {
      console.log('  注册报错 : 无（两个都注册成功了）')
    }
    if (r.threw) {
      console.log('  读 ctx.compaction : 抛错 → ' + r.threw)
    } else {
      console.log('  最终 ctx.compaction.who() = ' + JSON.stringify(r.who))
      console.log('  ⇒ ' + (r.who === 'mine' ? '★ 后注册的赢了' : '★ 先注册的赢了'))
    }
  }

  console.log('')
  console.log('═'.repeat(64))
  console.log('')
  console.log('★ 判读方法：看「内置先、本包后」那一行')
  console.log('   · who() = "mine"   → 本包接管成功，insert 这条路成立')
  console.log('   · who() = "builtin" → 本包没接管，insert 只挂了个不干活的层，')
  console.log('                        必须换第三条路（本包自己去注册服务 / 覆盖 base 层）')
  console.log('   · 抛错              → 同名注册被拒，两条并存本来就非法')
  console.log('')
}

main()
