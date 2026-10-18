// dsh-agent-soul —— 安装指导（宿主半，第二部分）
//
// 职责只有一个：**看当前 profile 缺什么，然后给出下一步该跑的命令。**
//
// ★ 它不执行安装。理由不是保守，是这三条：
//   ① 桌面端 profile 不接受 CLI 安装（`profile "desktop" is managed exclusively by the
//      Electron application`），所以"装法"本身就依赖环境，不能写死一条命令
//   ② 装插件有副作用（改 package.json、复制文件、动 bundles 数组），错了要能回滚
//   ③ 让 agent 读到命令再自己跑，人能看见那一步 —— 这比"它悄悄装了"安全得多
//
// ★ 所以这个工具的产出形状是「给命令」，不是「替你做」。

import { readFile, readdir, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 从插件所在位置反推 profile 目录。装在 <profile>/node_modules/<pkg>/ 时成立。 */
async function guessProfileFromPlugin() {
  // HERE = .../<profile>/node_modules/dsh-agent-soul
  const oneUp = resolve(HERE, '..') // .../node_modules
  const profile = resolve(oneUp, '..') // .../<profile>
  try {
    await access(join(profile, 'package.json'))
    const base = profile.split(/[\\/]/).pop() || ''
    if (base === 'node_modules') return null
    return profile
  } catch {
    return null
  }
}

/** 读一个 profile 里已装的包名集合。★ 调用前必须先确认 profile 真的存在。 */
async function installedPackages(profile) {
  const names = new Set()
  // ① node_modules 里的目录名
  try {
    const entries = await readdir(join(profile, 'node_modules'), { withFileTypes: true })
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith('dsh-')) names.add(e.name)
    }
  } catch {}
  // ② package.json 的 dsh.profile.bundles（更权威：装进 bundles 才算真的启用）
  let bundles = []
  try {
    const raw = await readFile(join(profile, 'package.json'), 'utf8')
    const pj = JSON.parse(raw)
    bundles = pj?.dsh?.profile?.bundles ?? []
  } catch {}
  return { names, bundles }
}

/**
 * ★ 这个函数是补上一个 bug 的：给一个**不存在**的 profile 时，
 *   readdir 和 readFile 都会失败，而它们都被 catch 吞掉了 ——
 *   于是返回「一个包都没装」，看起来像是"空 profile"，而不是"这个路径不对"。
 *   **那是假绿。** 所以先证伪，再动手。
 */
async function assertProfile(profile) {
  try {
    await access(join(profile, 'package.json'))
  } catch {
    throw new Error(
      '这不是一个 profile 目录：' + profile + '\n' +
      '它下面必须有一个 package.json。\n' +
      '★ 常见位置：<你的 DSH home>/profiles/<profile 名>\n' +
      '  例如 DSH home 是 ~/.dsh，profile 叫 desktop，那就是 ~/.dsh/profiles/desktop'
    )
  }
  let pj
  try {
    pj = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
  } catch (e) {
    throw new Error('profile 的 package.json 读不了或不是合法 JSON：' + String(e && e.message ? e.message : e))
  }
  // 一个真正的 DSH profile 应当有 dsh 字段（profile 或 profile.bundles）
  if (!pj || typeof pj !== 'object' || !pj.dsh) {
    throw new Error(
      '这个目录有 package.json，但不像是 DSH profile（缺 dsh 字段）：' + profile
    )
  }
  return pj
}

/** 装配顺序 —— 和 soul/04-manifest.json 的 assembly_order 对齐。 */
const ORDER = [
  {
    step: 0,
    title: '先定权威源',
    kind: 'human',
    why: '不先做这个，装什么都双重记账。',
    how: '跑 `node tools/init.mjs --out <目录>` 生成骨架，然后把 00-authority.md 填完。',
  },
  {
    step: 1,
    title: 'Ⅰ ECHO · 空间',
    kind: 'plugins',
    why: '上下文会满，满了要丢，丢了还要能找回来。',
    parts: ['compaction', 'pruner', 'memory', 'echo'],
  },
  {
    step: 2,
    title: 'Ⅱ VITAL · 时间与方向',
    kind: 'plugins',
    why: '预算会烧光、会原地打转，需要把偏离拉回来。',
    parts: ['clock', 'model-statusbar', 'huanqi', 'huanqi-panel'],
  },
  {
    step: 3,
    title: 'Ⅲ 能力',
    kind: 'plugins',
    why: '这一层随便换 —— 换掉它，你的身份判据还应该成立。',
    parts: ['mobile-adapt'],
  },
  {
    step: 4,
    title: 'Ⅳ 档案 · 对外可访问性',
    kind: 'plugins',
    why: '别人（和下一代的你）理解你，全靠它。',
    parts: ['riji', 'splash', 'yantai'],
  },
  {
    step: 5,
    title: 'Ⅴ 运维 · 装配顺序与升级路径',
    kind: 'slot',
    why: '让前面四层能持续跑下去。',

    // ★★★ 2026-10-18 修正（第八个洞）：
    //   这一段原来写的是
    //     「`plugins/tools/` 下三个（gateway / ledger / self）是脚本，不是 DSH 包，按各自 README 放到位。」
    //   —— **那是编的。** `plugins/tools/` 是个空目录，三个脚本一个都不存在，
    //   而 manifest 里第 Ⅴ 层也从来没有出现过这三个名字。
    //   查证：`soul/04-manifest.json` 的 `layers[4]` 只有一个 slot，
    //   `what: "装配顺序与升级路径"`、`required: false`、`examples: []`。
    //   ★ 后果：agent 照着这条去找三个脚本，会找不到，然后要么卡住、要么自己编一个。
    //     工具撒谎比工具报错更坏 —— 报错它会停下来问，撒谎它会顺着走。
    how: [
      '这一层**不是一个包**，是一个槽位：它问的是「你打算怎么装配、怎么升级」。',
      'manifest 里它的判据只有一句 ——',
      '「顺序是不是『先定权威源，再建机制』？反过来做一定会双重记账」。',
      '所以这一步没有命令可跑。你要做的是**写下自己的装配顺序和升级路径**，',
      '放进你的权威源（第 0 步那份）里。`required: false` —— 不写也能跑，',
      '但下次升级时，你会把已有的拆坏。',
    ].join(''),
  },
]

const PKG = (dir) => 'dsh-agent-' + dir

/**
 * ★ 找到 plugins/ 到底在哪。
 *
 * 这个函数是补一个真坑的：第一版把命令写成
 *   `dsh plugin add file:<soul 仓库>/plugins/compaction`
 * —— 一个占位符。**agent 照着这份指引去装，会卡在这里。**
 * 实测（2026-10-18，沙箱 `dsh-demo` 里跑一次真实会话）它说：
 *   「`<soul 仓库>` 是占位符，我这边推不出来 —— 找过 profile/plugins、
 *     dsh-demo/plugins、workspace/plugins，都不存在」。
 *
 * 所以：**能算就算出来，算不出来就说清算过哪里。**
 *
 * 三个来源，按可信度排：
 *   ① 环境变量 AGENT_SOUL_REPO —— 人明确告诉我们的，最可信
 *   ② HERE/plugins —— 本仓库的形态：插件包就在仓库根上，plugins/ 是它的兄弟目录
 *   ③ HERE/../plugins —— 万一将来包被挪进子目录（比如 packages/agent-soul/）
 */
async function findPluginsDir() {
  const tried = []

  const fromEnv = process.env.AGENT_SOUL_REPO
  if (fromEnv) {
    const p = join(fromEnv, 'plugins')
    tried.push({ how: '环境变量 AGENT_SOUL_REPO', path: p })
    try {
      await access(join(p, 'compaction', 'package.json'))
      return { dir: p, tried, from: '环境变量 AGENT_SOUL_REPO' }
    } catch {}
  }

  // ★ 顺序要紧：HERE/plugins 在前。第一版写成 [.., ../..] 把这条路漏了，
  //   于是从仓库里跑也找不到 —— 实测抓到的（2026-10-18）。
  for (const up of ['.', '..', join('..', '..')]) {
    const p = up === '.' ? join(HERE, 'plugins') : resolve(HERE, up, 'plugins')
    tried.push({ how: up === '.' ? '插件包同目录下的 plugins/' : `从插件包往上 ${up} 再找 plugins/`, path: p })
    try {
      await access(join(p, 'compaction', 'package.json'))
      return { dir: p, tried, from: up === '.' ? '插件包同目录' : `从插件包反推（${up}）` }
    } catch {}
  }

  return { dir: null, tried, from: null }
}

/** 一条能直接粘进终端的安装命令。desktop 给手动两步，其它给 CLI。 */
function installCommand(profile, dir, isDesktop, pluginsDir) {
  const pkg = PKG(dir)
  // ★ 有真实路径就用真实路径；没有就写清占位符该填什么，别让它看起来像能直接跑
  const src = pluginsDir ? join(pluginsDir, dir) : `<soul 仓库>/plugins/${dir}`
  if (isDesktop) {
    return [
      '手动两步（桌面端不接受 CLI 安装）：',
      '  # ① 复制四个文件进 profile',
      `  #    源：${src}${pluginsDir ? '/' : '/'}`,
      `  #    目标：${join(profile, 'node_modules', pkg)}/`,
      '  #    要的文件：package.json / cordis.patch.yml / index.js / client.js',
      '  # ② 往 ' + join(profile, 'package.json') + ' 的 dsh.profile.bundles 里加 "' + pkg + '"',
      '  #    ★ 用 JSON.parse / JSON.stringify 改，不要用手写',
      '  # ③ 重启 DSH（不是刷新页面）',
    ].join('\n')
  }
  return `dsh plugin --profile ${profile.split(/[\\/]/).pop()} add file:${src}`
}

export function registerInstallTool(ctx) {
  ctx.tools.register({
    name: 'agent_soul_install',
    description:
      '看当前 profile 里「灵魂架构」的零件装了哪些、缺哪些，并给出下一步该跑的命令。\n' +
      '★ 它不执行安装 —— 只给命令。装插件有副作用，那一步应该看得见。\n' +
      'action=scan 看已装/未装；action=plan 按装配顺序给出有序步骤；action=verify 装完再验一次。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['scan', 'plan', 'verify'],
          description: 'scan=现状；plan=有序步骤；verify=装完复查',
        },
        profile: {
          type: 'string',
          description: 'profile 目录路径；留空则从插件自身位置反推',
        },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          profile: { type: 'string' },
          installed: { type: 'array', items: { type: 'string' } },
          missing: { type: 'array', items: { type: 'string' } },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: typeof value.text === 'string' ? value.text : JSON.stringify(value, null, 2),
        },
      ],
    },
    execute: async ({ action, profile: profileArg }) => {
      try {
        const profile = profileArg ? resolve(profileArg) : await guessProfileFromPlugin()
        if (!profile) {
          return {
            ok: false,
            error:
              '找不到 profile 目录。请用 profile 参数指定，例如：\n' +
              '  <你的 DSH home>/profiles/<profile 名>\n' +
              '★ 它必须是一个含 package.json 的目录。',
          }
        }

        // ★ 先证伪，再动手。不存在的 profile 必须报错，不能悄悄返回「一个都没装」。
        await assertProfile(profile)

        const { names, bundles } = await installedPackages(profile)
        const isDesktop = /[\\/]desktop$/.test(profile)

        const allDirs = [
          'compaction', 'pruner', 'memory', 'echo',
          'clock', 'model-statusbar', 'huanqi', 'huanqi-panel',
          'mobile-adapt', 'riji', 'splash', 'yantai',
        ]
        const installed = allDirs.filter((d) => names.has(PKG(d)))
        const missing = allDirs.filter((d) => !names.has(PKG(d)))
        // ★ 装进 node_modules 但没进 bundles 的，等于「文件在、没启用」——
        //   这是最常见的一种假绿，必须单独报出来。
        const notBundled = installed.filter((d) => bundles.length > 0 && !bundles.includes(PKG(d)))

        if (action === 'scan' || action === 'verify') {
          const lines = []
          lines.push('profile: ' + profile)
          lines.push('类型：' + (isDesktop ? '桌面端（只能手动两步装）' : 'CLI 管理（可以用 dsh plugin add）'))
          lines.push('')
          lines.push('已装 ' + installed.length + ' / ' + allDirs.length)
          lines.push('')
          lines.push('【已装】')
          if (installed.length === 0) lines.push('  （一个都没有）')
          for (const d of installed) {
            const b = bundles.length === 0 ? '' : bundles.includes(PKG(d)) ? '  ✓ 已进 bundles' : '  ★ 在 node_modules 但不在 bundles —— 等于没启用'
            lines.push('  ' + PKG(d) + b)
          }
          lines.push('')
          lines.push('【缺】')
          if (missing.length === 0) lines.push('  （齐了）')
          for (const d of missing) lines.push('  ' + PKG(d))
          if (notBundled.length > 0) {
            lines.push('')
            lines.push('★ 有 ' + notBundled.length + ' 个是「文件在、没启用」：' + notBundled.map(PKG).join(', '))
          }
          lines.push('')
          lines.push('下一步：要装的话，先跑 action=plan 看顺序。')
          return { ok: true, profile, installed, missing, text: lines.join('\n') }
        }

        // ── plan ──
        // ★ 先找 plugins/ 在哪。找不到就明说，别让命令里留一个占位符假装能跑
        //   —— 那是实测踩过的坑：agent 会照着占位符去装，然后卡住。
        const pluginsInfo = await findPluginsDir()
        const lines = []
        lines.push('装配顺序（按这个走，不要跳步）')
        lines.push('profile: ' + profile)
        lines.push('')
        if (pluginsInfo.dir) {
          lines.push('插件源码目录：' + pluginsInfo.dir)
          lines.push('  （来源：' + pluginsInfo.from + '）')
        } else {
          lines.push('★ 插件源码目录：没找到 —— 下面命令里的 <soul 仓库> 得换成真实路径')
          lines.push('  找过：')
          for (const t of pluginsInfo.tried) {
            lines.push('    · ' + t.path)
            lines.push('      （' + t.how + '）')
          }
          lines.push('  ★ 为什么会找不到：装进 profile 的只有插件本体，plugins/ 那 13 个零件没跟着进去。')
          lines.push('  ★ 最快的办法：设环境变量 AGENT_SOUL_REPO=<仓库根>，再跑一次 plan。')
          lines.push('')
        }
        let needInstall = 0
        for (const s of ORDER) {
          lines.push('── 第 ' + s.step + ' 步 · ' + s.title + ' ──')
          lines.push('  为什么：' + s.why)
          if (s.kind === 'human' || s.kind === 'tools' || s.kind === 'slot') {
            lines.push('  ' + s.how)
          } else {
            for (const d of s.parts) {
              if (names.has(PKG(d))) {
                lines.push('  ✓ ' + PKG(d) + '  已装')
              } else {
                needInstall++
                lines.push('  · ' + PKG(d) + '  缺')
                lines.push(indent(installCommand(profile, d, isDesktop, pluginsInfo.dir), '      '))
              }
            }
          }
          lines.push('')
        }
        lines.push('合计还要装 ' + needInstall + ' 个。')
        if (isDesktop) {
          lines.push('')
          lines.push('★ 桌面端的每一个都要重启 DSH 才生效 —— 不是刷新页面。')
          lines.push('  宿主半只在进程启动时加载，客户端半刷新即可。')
        }
        return {
          ok: true,
          profile,
          installed,
          missing,
          steps: ORDER.map((s) => ({ step: s.step, title: s.title, kind: s.kind })),
          text: lines.join('\n'),
        }
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) }
      }
    },
  })
}

function indent(text, pad) {
  return text
    .split('\n')
    .map((l) => pad + l)
    .join('\n')
}
