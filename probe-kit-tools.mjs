// probe-kit-tools.mjs —— 用假 ctx 验证三个新工具真的能调通 kit
//
// ★ 为什么用假 ctx 而不是重启 DSH：
//   重启要几十秒、会打断会话，而这里要验的是「注册对不对、execute 跑不跑得通」，
//   假 ctx 足够，而且能把失败信息留在手上。
// ★ 但它证明不了「宿主真的加载了」—— 那要看 agent 工具列表里有没有新名字。

const registered = []
const ctx = {
  tools: {
    register(t) { registered.push(t) },
  },
}

const mod = await import('./index.js')
console.log('name   =', mod.name)
console.log('inject =', JSON.stringify(mod.inject))
mod.apply(ctx)
console.log('注册工具数 =', registered.length)
for (const t of registered) console.log('  ·', t.name)

const want = ['agent_soul_plan', 'agent_soul_scaffold', 'agent_soul_check']
const missing = want.filter((w) => !registered.some((t) => t.name === w))
if (missing.length) {
  console.log('\n✗ 缺工具:', missing.join(', '))
  process.exit(1)
}

// ★ 参数用 journey 那间已经搭好的书房 —— 这样验的是「真跑通」而不是「报错也对」
//   ★ 2026-10-23：这四个默认值是**本机夹具**（作者机器上的那套 journey 沙箱），
//   换台机器跑会读不到。所以四个都能用环境变量覆盖 —— 别人要验，
//   设 PROBE_SOUL / PROBE_MEMORY / PROBE_SESSIONS / PROBE_RUNTIME 指到自己那套。
const ROOTS = {
  soul: process.env.PROBE_SOUL || String.raw`D:\AI\dsh-slots\logs\journey\soul`,
  memory: process.env.PROBE_MEMORY || String.raw`D:\AI\dsh-slots\logs\journey\memory`,
  sessions: process.env.PROBE_SESSIONS || String.raw`D:\AI\dsh-slots\logs\journey\sessions`,
  runtime: process.env.PROBE_RUNTIME || String.raw`D:\AI\dsh-slots\logs\journey\memory\runtime`,
}

function head(s, n = 14) {
  return String(s || '').split('\n').slice(0, n).join('\n')
}

for (const name of want) {
  const t = registered.find((x) => x.name === name)
  console.log('\n' + '═'.repeat(70))
  console.log('  ' + name)
  console.log('═'.repeat(70))
  const t0 = Date.now()
  let r
  try {
    r = await t.execute(name === 'agent_soul_check' ? { ...ROOTS, deep: false } : { ...ROOTS })
  } catch (e) {
    console.log('  ✗ execute 抛了:', e && e.message ? e.message : e)
    continue
  }
  const ms = Date.now() - t0
  console.log(`  ok=${r.ok}  用时 ${ms}ms`)
  if (r.error) console.log('  error:', head(r.error, 6))
  console.log('  ── 输出 ──')
  console.log(head(r.text, 18).split('\n').map((l) => '  ' + l).join('\n'))

  // ★ render 必须返回 ContentBlock[]，返回 string 会在渲染时坏
  const blocks = t.output.render({}, r)
  const okBlocks = Array.isArray(blocks) && blocks.every((b) => b && b.type === 'text' && typeof b.text === 'string')
  console.log(`  render: ${okBlocks ? '✓ ContentBlock[]' : '✗ 不是 ContentBlock[]'}`)
}

console.log('\n' + '═'.repeat(70))
console.log('  探针结束')
console.log('═'.repeat(70))
