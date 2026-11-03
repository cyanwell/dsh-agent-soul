// selftest-deploy.mjs —— 丹房工作台 v2 部署后自检
//
// 用途：deploy-and-restart.cmd 跑完之后，一条命令判断「这次部署到底通没通」。
//   ★ 为什么不靠肉眼看界面：界面能打开 ≠ 新代码加载了。
//     这个脚本查的是【已安装副本】的实际内容 + 【宿主半真的注册了 anchor 阶段】。
//
// 用法：
//   node D:\AI\dsh-tools\dsh-yanqing-line\scripts\selftest-deploy.mjs
//   node ... --wait 90      等 DSH 起来（最多 90 秒，每 5 秒试一次）

const INSTALL_DIR = 'D:\\AI\\dsh\\home\\profiles\\desktop\\node_modules\\dsh-yanqing-line'
const BASE = 'http://127.0.0.1:19387'

const argv = process.argv.slice(2)
const waitIdx = argv.indexOf('--wait')
const WAIT_SEC = waitIdx >= 0 ? Number(argv[waitIdx + 1] || 90) : 0

let pass = 0, fail = 0
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '   → ' + extra : '')) }
  return cond
}

async function readIf(p) {
  try {
    const { readFileSync } = await import('node:fs')
    return readFileSync(p, 'utf8')
  } catch (e) { return null }
}

// ── 1) 已安装副本的内容 ────────────────────────────────────────
console.log('[1] 已安装副本里到底是不是新代码')
const idx = await readIf(INSTALL_DIR + '\\index.js')
const cli = await readIf(INSTALL_DIR + '\\client.js')
const q = await readIf(INSTALL_DIR + '\\scripts\\queue.mjs')

ok('index.js 存在', idx !== null)
if (idx) {
  ok('index.js 里有 anchor 阶段', /anchor:\s*\{/.test(idx), '没找到 anchor: {')
  ok('index.js 里有 buildMany（批量）', /buildMany/.test(idx))
  ok('index.js 里有 ANCHOR_DIR', /ANCHOR_DIR/.test(idx))
  ok('index.js 里有 mtime 主路（抓产物）', /runT0/.test(idx))
  console.log('        index.js 大小 = ' + idx.length + ' 字节')
}
ok('client.js 存在', cli !== null)
if (cli) {
  ok('client.js 里有 DrawPage（出图页）', /function DrawPage/.test(cli), '没找到 DrawPage')
  ok('client.js 的工作台默认落出图', /useState\('draw'\)/.test(cli))
  console.log('        client.js 大小 = ' + cli.length + ' 字节')
}
ok('queue.mjs 被复制过来了', q !== null, '（第二步的队列内核，这次部署会一起带上）')

// ── 2) 宿主半真的注册了吗（要等 DSH 起来）────────────────────
async function probe(path) {
  const r = await fetch(BASE + path, { signal: AbortSignal.timeout(4000) })
  return await r.json()
}

let stages = null
const deadline = Date.now() + WAIT_SEC * 1000
for (;;) {
  try {
    stages = await probe('/yanqing-line/api/stages')
    break
  } catch (e) {
    if (Date.now() >= deadline) break
    console.log('        DSH 还没起来，5 秒后再试…（等 ' + WAIT_SEC + ' 秒）')
    await new Promise((r) => setTimeout(r, 5000))
  }
}

console.log('')
console.log('[2] 宿主半的 /api/stages')
if (!stages) {
  console.log('  SKIP  DSH 没应答（还没起来，或者端口不是 19387）')
  console.log('        ⇒ 窗口/日志里要出现 "dsh web: ...?token=..."，且等满 60 秒再下结论')
} else {
  const keys = (stages.stages || []).map((s) => s.key)
  ok('anchor 阶段在线', keys.includes('anchor'), keys.join(', '))
  ok('旧的四个阶段还在（可回退）',
     ['sdxl', 'takeover', 'handcrop', 'upscale'].every((k) => keys.includes(k)), keys.join(', '))
  console.log('        阶段列表 = ' + keys.join(', '))
  try {
    const st = await probe('/yanqing-line/api/state')
    console.log('        ComfyUI 在跑吗 = ' + (st.running ? '在跑 ✓' : '没跑（出图前要先启动）'))
  } catch (e) { /* 状态查不到不影响判定 */ }
}

console.log('')
console.log('=== ' + pass + ' 通过 / ' + fail + ' 失败 ===')
if (fail === 0) console.log('⇒ 部署通了。下一步：界面上真跑一次四张（丹房 → 工作台 → 出图）。')
else console.log('⇒ 有失败项，先看上面哪一条，再决定要不要重新部署。')
process.exit(fail === 0 ? 0 : 1)
