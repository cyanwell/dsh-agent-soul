// kit-bridge.mjs —— 插件本体 → kit 脚本的那道桥
//
// 为什么要有这一层：
//   `kit/echo/` 里那十一个脚本是**独立可跑**的（用户能直接 node 它们）。
//   插件要调它们，但不能把逻辑抄一份进来 —— 抄一份就是第二份真相，
//   改了一边忘了另一边，两个说的还不一样。
//   所以只桥接：调过去、拿回来、原样给人看。
//
// ★ 三条约束（都是踩过的）：
//   1. **绝不用 spawnSync。** 体检 deep 模式要几百毫秒到几秒，
//      同步等会把整个 DSH 宿主卡住 —— 那不是慢，那是把别人也拖下来。
//   2. **超时要给。** 卡死的脚本不能把工具调用挂在那儿。
//   3. **失败要带 stderr 回来。** 只说「失败了」没有用，
//      用户要看的是脚本自己那句错话。

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, parse } from 'node:path'
import { homedir } from 'node:os'

const execFileAsync = promisify(execFile)
const HERE = dirname(fileURLToPath(import.meta.url))
const KIT = join(HERE, 'kit', 'echo')

/**
 * 跑一个 kit 脚本。
 *
 * @param {string} script  脚本文件名，例如 'plan.mjs'
 * @param {string[]} args  命令行参数
 * @param {object} env     额外环境变量（ECHO_SOUL / ECHO_MEMORY / ...）
 * @returns {Promise<{ok:boolean, code:number|string, stdout:string, stderr:string}>}
 */
export async function runKit(script, args = [], env = {}) {
  // ★ script 目前全是硬编码字面量，但接口本身不该允许 ../ 逃逸：
  //   一旦将来把它做成外部参数，这里就会变成任意脚本执行。
  if (script.includes('..') || /[\\/]/.test(script)) {
    throw new Error('kit script must be a bare filename without path separators: ' + script)
  }
  const p = join(KIT, script)
  if (!existsSync(p)) {
    return {
      ok: false,
      code: 'ENOENT',
      stdout: '',
      stderr:
        `kit 里没有 ${script}（找的是 ${p}）。\n` +
        `这说明包装得不完整 —— 把整个 kit/ 目录一起打包，不要只发 index.js。`,
    }
  }

  // ★ 只把非空的环境变量传下去：传一个空字符串会把 kit 的「没配」判断搞坏
  //   （echo-config 用 falsy 判断配没配，空串是 falsy，但那会让报错文案变成空白）。
  const cleanEnv = { ...process.env }
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== null && String(v).trim() !== '') cleanEnv[k] = String(v)
  }

  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [p, ...args], {
      timeout: 30000,
      maxBuffer: 64 * 1024 * 1024,
      env: cleanEnv,
      encoding: 'utf8',
      windowsHide: true,
    })
    return { ok: true, code: 0, stdout: stdout || '', stderr: stderr || '' }
  } catch (e) {
    // execFile 失败时 e.code 是退出码（number）或 'ENOENT'（string）
    return {
      ok: false,
      code: e.code ?? -1,
      stdout: e.stdout || '',
      stderr: e.stderr || String((e && e.message) || e),
    }
  }
}

/** 把工具参数里的 soul/memory 变成 kit 认的环境变量。没传就不设，让 kit 自己推断。 */
export function envFromArgs(args = {}) {
  const env = {}
  const seen = new Map()
  for (const [key, envName] of [
    ['soul', 'ECHO_SOUL'],
    ['memory', 'ECHO_MEMORY'],
    ['sessions', 'ECHO_SESSIONS'],
    ['runtime', 'ECHO_RUNTIME'],
  ]) {
    if (!args[key]) continue
    const abs = guardRoot(key, args[key])
    const prev = seen.get(abs)
    if (prev) {
      throw new Error(
        `roots.${key} 和 roots.${prev} 指向同一个目录（${abs}）—— 这两样不能是同一处，` +
          `否则写档案会盖掉记忆。请分开传。`,
      )
    }
    seen.set(abs, key)
    env[envName] = abs
  }
  return env
}

// ── roots 的边界校验（N6，2026-10-22）────────────────────────────────
//
// ★ 为什么这条必须有：
//   `agent_soul_scaffold` 是**唯一一个会往用户目录里写东西**的入口
//   （scaffold.mjs 里有 mkdirSync / writeFileSync，带 --apply 就真写）。
//   在此之前 roots 是四个自由字符串，没有任何断言 —— 一段提示注入就能让 soul
//   指向 C:\Windows 或别人的 Documents。写着"别乱写"的注释挡不住执行。
//
// ★ 但也不能太严：正常的 roots 就是 D:\AI\yanqing-soul 这种深度 2 的路径。
//   所以只拦「一眼就知道写下去是灾难」的那几个，其余原样放行并规范化。

const SYSTEM_DIRS = ['Windows', 'System32', 'Program Files', 'Program Files (x86)', 'ProgramData', '$Recycle.Bin']

function guardRoot(kind, value) {
  const raw = String(value).trim()
  if (!raw) throw new Error(`roots.${kind} 是空的 —— 要么给一个目录，要么整个不传（让 kit 自己推断）。`)
  if (raw.length > 512) throw new Error(`roots.${kind} 太长（${raw.length} 字符），不像一个目录。`)

  const abs = resolve(raw) // 相对路径按当前工作目录解析
  const { root } = parse(abs)

  // ① 盘根：D:\ 这种。mkdirSync 不会炸，但那是在往盘根上撒文件。
  if (abs === root) {
    throw new Error(`roots.${kind} 指向了盘根（${abs}）—— 那不是书房，是整块盘。给一个具体目录。`)
  }

  // ② 系统目录及其子目录（任何盘都拦，不只 C —— 移到别的盘还是同一个名字）
  const segs = abs.slice(root.length).split(/[\\/]+/).filter(Boolean)
  const first = (segs[0] || '').toLowerCase()
  if (SYSTEM_DIRS.some((b) => b.toLowerCase() === first)) {
    throw new Error(
      `roots.${kind} 指向系统目录（${abs}）—— 往这里写会伤到别人的机器。` +
        `它应该是「书房 / 记忆中枢」那种你自己的目录。`,
    )
  }

  // ③ 用户主目录本身（C:\Users\pc）—— 允许其下，不允许把整个 profile 当书房
  const home = homedir()
  if (abs.toLowerCase() === home.toLowerCase()) {
    throw new Error(
      `roots.${kind} 是用户主目录本身（${abs}）—— 请指到其中一个子目录，比如 ${join(abs, 'my-soul')}。`,
    )
  }

  return abs
}

/** 把一段 JSON 输出解析出来；解析不了就给 null，绝不抛。 */
export function tryJson(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return null }
}
