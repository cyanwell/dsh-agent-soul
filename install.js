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
    const pj = JSON.parse(raw.replace(/^﻿/, ''))
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
    pj = await readJsonNoBom(join(profile, 'package.json'))
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
    // ★ 第 6 个是外部件（dsh-mnemon），不在本仓库。它照样要进 ORDER ——
    //   因为 plan 只沿着 ORDER 生成安装清单，不收录就等于永远不提示装。
    //   它和 mnemon-probe 是两样东西：一个是引擎（别人的），一个是仪表（我们的）。
    //
    // ★★★ 2026-10-30 补 mcp-hub（第九个洞）：
    //   ECHO 的记忆召回现在走 MCP 服务 —— 没有 mcp-hub，echo 的召回是静默空的。
    //   原来 ORDER 里一次都没出现过它，于是 plan 永远不提示装，
    //   而「不装」不会报错，只会让人觉得「ECHO 好像没生效」。
    //   ★ 静默失效比报错难查得多：它不是坏了，是根本没接线。
    //
    // ★★★ 同日补 compact-region（第十个洞）：
    //   它给 compaction realm 开一扇「能指定范围」的门（注册 /compact-region <s> <e>），
    //   让换气的「范围压缩」真的只压那一段，而不是退化成全量。
    //   presets 里一直在引用它，但它从来不在本仓库、也不在 ORDER —— 
    //   于是新用户装完，范围压缩静默降级成全量，谁也不报错。
    parts: ['mcp-hub', 'compaction', 'pruner', 'compact-region', 'memory', 'echo', 'mnemon-probe', 'dsh-mnemon'],
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

// ★ 包名不能靠前缀拼。`huanqi` 的真实包名是 dsh-huanqi（没有 agent），
//   拼出来的 dsh-agent-huanqi 既不是它、也不在 bundles 里 —— 于是 plan 会
//   对着一个装好的包喊「缺」，而用户照着装会装出一个 DSH 认不出的目录名。
//   所以这里从每个子包自己的 package.json 读 name，拼前缀只作为读不到时的兜底。
/** 读 JSON 并去掉 BOM。记事本 / PS 5.1 的 Set-Content -Encoding UTF8 会写 U+FEFF，
 *  而 JSON.parse 不认它 —— 用户会看到"不是合法 JSON"，去查语法而不是编码。 */
async function readJsonNoBom(p) {
  const raw = await readFile(p, 'utf8')
  return JSON.parse(raw.replace(/^﻿/, ''))
}

const PKG_NAMES = new Map()
// ★ 外部件（external: true）的包名就是它自己的目录名，不加 dsh-agent- 前缀。
//   以前这个机制写了却从没被用过 —— ORDER 里一个外部件都没有，于是它是死代码。
const EXTERNAL_DIRS = new Set()

/**
 * ★★ 只能用「路 B」装的零件（2026-10-25 加，GitHub #5 的建议 1）。
 *
 * 为什么是写死的两个名字，而不是从 package.json 自动推：
 * ------------------------------------------------------------------
 * 我一开始想用「依赖里有没有 @deepseek-ai/*」当判据，实测**会误报** ——
 * 本机 profile 的 `@deepseek-ai` 目录里只有 9 个包，`cordis` / `dsh-agent` / `dsh-llm`
 * 一个都不在，可 `memory` 和 `huanqi` 这两个零件照样跑得好好的。
 * 所以「依赖了内置包」≠「路 A 会失败」——能不能解析，取决于**它在哪个位置被加载**，
 * 那是结构知识，不是包元数据能推出来的。
 *
 * 真正的分界是这个：**该零件要顶掉 preset 里一个已经存在的内置条目。**
 *   compaction → 顶掉 `compaction-basic`
 *   pruner     → 顶掉 `tool-result-pruner`
 * 这两个 id 本来就在 `agent.cordis.yml` 的 compaction realm 里，所以只有「同 id 换 name」
 * （= 替换）能接管；另起一份实现（路 A）会 import 不到 asar 里的东西。
 *
 * 其余零件是**新增**，走 profile bundles（路 A）没问题。
 * ★ 将来若有新零件要顶别的内置条目，把目录名加进这个集合，并在这里记一笔。
 */
const REPLACES_BUILTIN = new Set(['compaction', 'pruner'])

/**
 * 依赖 `@deepseek-ai/*` 的零件：目录名 → 它要 import 的那个包。
 * **只用来把提示写具体**（能对上报错），不作判定依据 —— 判定只看 REPLACES_BUILTIN。
 */
const NEEDS_BUILTIN = new Map()

/** 这个包的依赖里有没有 `@deepseek-ai/*`。 */
function dependsOnBuiltin(pj) {
  const groups = [pj.peerDependencies, pj.dependencies, pj.optionalDependencies]
  for (const g of groups) {
    if (!g || typeof g !== 'object') continue
    for (const k of Object.keys(g)) if (k.startsWith('@deepseek-ai/')) return k
  }
  return null
}

const PKG = (dir) =>
  EXTERNAL_DIRS.has(dir) ? dir : PKG_NAMES.get(dir) || 'dsh-agent-' + dir

/** 扫描 plugins/ 下每个子包，把目录名 → 真实包名记下来。读不到就跳过（不是包）。 */
async function loadPkgNames(pluginsDir) {
  if (!pluginsDir) return
  let entries
  try {
    entries = await readdir(pluginsDir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    try {
      const pj = await readJsonNoBom(join(pluginsDir, e.name, 'package.json'))
      if (pj && typeof pj.name === 'string' && pj.name) PKG_NAMES.set(e.name, pj.name)
      // ★ 顺手记下"它要 import 哪个内置包" —— 只用于把提示写具体，不作判定依据
      const dep = pj && dependsOnBuiltin(pj)
      if (dep) NEEDS_BUILTIN.set(e.name, dep)
    } catch {
      // tools/ 这种没有 package.json 的目录，跳过
    }
  }
}

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
  // ★ 外部件不在本仓库，不能给 file:<仓库>/plugins/<dir> —— 那个目录不存在。
  if (EXTERNAL_DIRS.has(dir)) {
    const pname = profile.split(/[\\/]/).pop()
    const pj = join(profile, 'package.json')
    if (isDesktop) {
      return [
        '外部件（别人的 npm 包，不是本仓库的）：',
        '  # ① 把 "' + dir + '" 加进 ' + pj + ' 的 dependencies',
        '  # ② 在 profile 目录下重装依赖（pnpm install / npm install）',
        '  # ③ 往 dsh.profile.bundles 里加 "' + dir + '"',
        '  # ④ 重启 DSH',
        '  # ★ 判据不是"装上了"，是"有空间可用"：跑一次 mnemon_status，看有没有 active 的 space。',
      ].join('\n')
    }
    return 'dsh plugin --profile ' + pname + ' add ' + dir
  }
  // ★ 有真实路径就用真实路径；没有就写清占位符该填什么，别让它看起来能直接跑
  const src = pluginsDir ? join(pluginsDir, dir) : `<soul 仓库>/plugins/${dir}`
  if (isDesktop) {
    // ★★ 路 A 对这类零件在桌面端必然失败（2026-10-25 加，GitHub #5 的建议 1）
    //
    // 为什么必须在这里拦：报错里**一个字都不提装法**，只写
    //   Cannot find package '@deepseek-ai/dsh-compaction-basic' imported from ...
    // 于是读的人（尤其 AI）会得出一个很自然的结论：「这东西桌面端装不上」。
    // 而真相是 —— 路走死了，不是东西不存在。已经不止一个人这么理解错过了。
    if (REPLACES_BUILTIN.has(dir)) {
      return [
        '★ 这个零件**不能**用下面这条路装 —— 在 Electron 打包版上必然失败。',
        '  （它要顶掉 preset 里已经存在的内置条目，所以只有路 B 能接管。）',
        ...(NEEDS_BUILTIN.has(dir) ? [`  它要 import 的正是：${NEEDS_BUILTIN.get(dir)}`] : []),
        '',
        '  失败时会看到：',
        "",
        "      Cannot find package '@deepseek-ai/…' imported from …",
        '',
        '  ★ 看到它**别**得出「这东西桌面端装不上」的结论 —— 那是在路 A 上钻牛角尖。',
        '    真正的原因是：它要 import 的 @deepseek-ai/* 住在 resources/app.asar 里，',
        '    只有 Electron 补过的 fs 读得到；profile 的 node_modules 里没有，',
        '    pnpm 也不会替你装（autoInstallPeers: false）。',
        '',
        '  它只有一条路能跑 —— **路 B**：在 preset 的 realm 内部换 name，',
        '  靠「同一个 id 再注册一次 = 替换」接管，包就跑在宿主进程同一个 realm 里了。',
        '',
        `  # ① 复制**整个包目录**进 profile（和别的零件一样，别挑文件）`,
        `  #    源：${src}/`,
        `  #    目标：${join(profile, 'node_modules', pkg)}/`,
        '  # ② 在 **preset** 的 agent.cordis.yml 里，找到它要替换的那一条：**只换 name，id 不动**',
        '  #      - id: compaction-basic            # ← id 保持原样，这是"替换"的钥匙',
        `  #        name: '${pkg}'                  # ← 只把 name 换成它`,
        '  #    ★ 不要把它加进 dsh.profile.bundles —— 那是路 A，会变成另起一份实现',
        '  # ③ 重启 DSH（不是刷新页面）',
        '  # ④ 验证（最简单的一条，不用装任何探针）：',
        '  #    手动 /compact 一次，看摘要首块有没有 log:session-…-#seq= 门牌。',
        '  #    有 = 我们的实现接管了（内置引擎写不出门牌）；没有 = 还是内置在跑。',
        '  #',
        '  # 完整说明与 rc.2 / rc.3 的实测记录：',
        '  #   docs/安装常见问题汇总与解决方法.md 的「桌面端怎么装（路 B）」',
      ].join('\n')
    }
    return [
      '手动两步（桌面端不接受 CLI 安装）：',
      '  # ① 复制**整个包目录**进 profile（不要挑文件）',
      `  #    源：${src}/`,
      `  #    目标：${join(profile, 'node_modules', pkg)}/`,
      '  #    ★ 别只抄 package.json / cordis.patch.yml / index.js / client.js ——',
      '  #      包与包长得不一样：echo 还要 echo-config.mjs 和 echo-doctor.mjs，',
      '  #      memory / huanqi 的入口是 lib/index.js 不是根级 index.js，',
      '  #      model-statusbar 还要 probe.ps1。挑文件的后果是 ERR_MODULE_NOT_FOUND，',
      '  #      而那个报错发生在运行时，看起来完全不像"少拷了一个文件"。',
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

        // ★★ 2026-10-18 改：原来这张表是硬编码的，和 soul/07-bundle.json 各记一份 ——
        //   两处会漂（bundle 加了件，这里忘了加，于是那个件永远不会被报「缺」）。
        //   现在以 bundle 为唯一真相；读不到才退回硬编码。
        let bundle = null
        try {
          bundle = await readJsonNoBom(join(HERE, 'soul', '07-bundle.json'))
        } catch { /* 读不到就用兜底 */ }
        const bundleParts = new Map()
        if (bundle && Array.isArray(bundle.parts)) {
          for (const p of bundle.parts) {
            bundleParts.set(p.dir, p)
            if (p.external === true) EXTERNAL_DIRS.add(p.dir)
          }
        }
        const allDirs = bundleParts.size
          ? [...bundleParts.keys()]
          : [
              'compaction', 'pruner', 'memory', 'echo',
              'clock', 'model-statusbar', 'huanqi', 'huanqi-panel',
              'mobile-adapt', 'riji', 'splash', 'yantai',
            ]
        // ★ 外部零件（external: true）不在本仓库，包名就是它自己（不加 dsh-agent- 前缀）
        const isExternal = (d) => bundleParts.get(d) && bundleParts.get(d).external === true
        const nameOf = (d) => (isExternal(d) ? d : PKG(d))
        // ★★ 名字表必须在**算 installed / missing 之前**就加载好（2026-10-22 全面验证报告 P1）。
        //
        //   这段原来写在下面几十行之后 —— 注释明明写着「scan 也要知道真实包名，
        //   否则 PKG('huanqi') 会算成 dsh-agent-huanqi」，**可加载放在了计算之后**。
        //   于是 installed / missing 用的还是空表，装好的 dsh-huanqi 被算成缺失：
        //   14 个装完仍然报 13/14，而装配计划会一直让人「再装一次 huanqi」——
        //   新 agent 会在这上面打转。
        //
        //   ★ 光读代码看不出来：注释是对的、变量名也对，只有**顺序**错了。
        //   所以这一处加了断言（见 tools/verify-packaging.mjs）。
        if (!PKG_NAMES.size) {
          const pi = await findPluginsDir()
          await loadPkgNames(pi.dir)
        }

        const installed = allDirs.filter((d) => names.has(nameOf(d)))
        const missing = allDirs.filter((d) => !names.has(nameOf(d)))
        // ★ 装进 node_modules 但没进 bundles 的，等于「文件在、没启用」——
        //   这是最常见的一种假绿，必须单独报出来。
        const notBundled = installed.filter((d) => bundles.length > 0 && !bundles.includes(nameOf(d)))

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
            lines.push('  ' + nameOf(d) + b)
          }
          lines.push('')
          lines.push('【缺】')
          if (missing.length === 0) lines.push('  （齐了）')
          const missingRequired = missing.filter((d) => bundleParts.get(d)?.required === true)
          for (const d of missing) {
            const p = bundleParts.get(d)
            const tag = p?.required === true ? '  ★ 必备 —— 缺了架构少一层' : ''
            lines.push('  ' + nameOf(d) + tag)
          }
          if (missingRequired.length) {
            lines.push('')
            lines.push('★ 缺 ' + missingRequired.length + ' 个必备件：' + missingRequired.map(nameOf).join(', '))
            lines.push('  必备件不是「装上更好」，是「不装那一层就不存在」——')
            lines.push('  而它不会让体检变红，只会让某个零件一直报「未配置」。')
          }

          // ★ 三种依赖。最有价值的是 reads —— 它回答「装了这个，我还必须建出什么」。
          const withNeeds = [...installed, ...missing]
            .map((d) => [d, bundleParts.get(d)])
            .filter(([, p]) => p && ((p.needs && p.needs.length) || (p.reads && p.reads.length)))
          if (withNeeds.length) {
            lines.push('')
            lines.push('【装了之后还缺什么，它才有用】')
            for (const [d, p] of withNeeds) {
              lines.push('  ' + PKG(d))
              for (const n of p.needs || []) {
                lines.push('     · 需要同时装 ' + n.what + '：' + n.why)
              }
              for (const r of p.reads || []) {
                lines.push('     · 读「' + r.what + '」—— 缺了会：' + r.missing)
              }
            }
            lines.push('')
            lines.push('  ★ 「成功但空着」是最难查的一种坏 —— 插件没报错，界面能开，只是没内容。')
            lines.push('    先确认上面这些产物在不在，再怀疑插件。')
          }
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
        await loadPkgNames(pluginsInfo.dir)
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
          lines.push('  ★ 为什么会找不到：装进 profile 的只有插件本体，plugins/ 那 13 个零件包没跟着进去。')
          lines.push('  ★ 最快的办法：设环境变量 AGENT_SOUL_REPO=<仓库根>，再跑一次 plan。')
          lines.push('')
        }
        let needInstall = 0
        for (const s of ORDER) {
          lines.push('── 第 ' + s.step + ' 步 · ' + s.title + ' ──')
          lines.push('  为什么：' + s.why)
          if (s.kind === 'human' || s.kind === 'slot') {
            lines.push('  ' + s.how)
          } else {
            for (const d of s.parts) {
              if (names.has(PKG(d))) {
                lines.push('  ✓ ' + PKG(d) + '  已装')
              } else {
                needInstall++
                lines.push('  · ' + nameOf(d) + '  缺')
                lines.push(indent(installCommand(profile, d, isDesktop, pluginsInfo.dir), '      '))
              }
            }
          }
          lines.push('')
          // ★ P0-6（外部验证报告，2026-10-22）：第 1 步里有 compaction，而它
          //   「装上了」和「接管了」是两件事 —— 默认安装后它会和内置的
          //   compaction-basic 抢同一个服务名，先到先得、后来的不生效，
          //   而 doctor 只会报一句 warn（压缩机制 start 0），看不出这个区别。
          //   报告的原话是「门牌机制——整套架构的核心——装完等于没有」。
          //   这里不替用户改配置，但必须把「还差哪一步」说出来。
          if (s.step === 1) {
            // ★★★ 2026-10-24 晚间更正（这一版之前写错了，留此存照）：
            //   我一度在这里写「桌面端装不上」，依据是一位用户说「DS 告诉他桌面版就不行」。
            //   **那是错的。** 2026-10-23 的《安装验收报告》证明：桌面端 14/14 装齐、
            //   自动裁剪 5 条、手动 /compact 出了带门牌 seq=7371 的摘要。
            //
            //   真相反过来 —— 是**两条路**的区别：
            //     · 路 A（profile bundles `insert`）：新加载一个包，它要 import `@deepseek-ai/*`，
            //       而 profile 是 autoInstallPeers:false、那些包又打在 app.asar 里
            //       ⇒ `Cannot find package`。**这条路在桌面端走不通。**
            //     · 路 B（preset 的 realm 里 `id` 不变、只换 `name`）：那是**替换**已有条目，
            //       不是新增；包的代码跑在**宿主进程的同一个 realm** 里，
            //       `@deepseek-ai/*` 从 app.asar 解析得到 ⇒ **能跑，而且已验证。**
            //   所以要告诉用户的是「别走 A，走 B」，不是「放弃这两个零件」。
            if (isDesktop) {
              lines.push('  ⚠ 你现在是**桌面端**。这两个零件**能装**，但**别用「路 A」**：')
              lines.push('     路 A（profile bundles + insert）在桌面端会报 Cannot find package ——')
              lines.push('     因为它要 import @deepseek-ai/*，而 profile 是 autoInstallPeers:false、')
              lines.push('     那些包又打在 app.asar 里。**这不是插件的问题，是这条路在桌面端不成立。**')
              lines.push('')
              lines.push('     ★ 桌面端走「路 B」：在 preset 的 agent.cordis.yml 里，')
              lines.push('       于 compaction 那个 realm **内部**把已有条目的 name 换掉（id 不变）：')
              lines.push('')
              lines.push('         - id: compaction')
              lines.push('           group: true')
              lines.push('           isolate: { compaction: true, toolResultPruner: true }')
              lines.push('           config:')
              lines.push('             - id: compaction-basic            # ← id 保持不变')
              lines.push("               name: 'dsh-agent-compaction'    # ← 只换 name")
              lines.push('             - id: tool-result-pruner')
              lines.push("               name: 'dsh-agent-pruner'")
              lines.push('')
              lines.push('       ★ 为什么这条路行：id 已存在 ⇒ 是**替换**不是新增，不触发「先到先得」；')
              lines.push('         而且包跑在宿主进程的同一个 realm 里，@deepseek-ai/* 解析得到。')
              lines.push('       ★ 参考证据：2026-10-23《安装验收报告》——桌面端 14/14 装齐、')
              lines.push('         自动裁剪 5 条、手动 /compact 出了带门牌 seq=7371 的摘要。')
              lines.push('')
            }
            // ★★★ 2026-10-30 加（GitHub #5，TaoCultivator 报）：
            //
            //   **huanqi 和上面那两个不是一回事。**
            //   compaction / pruner 是**替换**内置条目 —— 有「路 B」可走（realm 内部同 id 换 name）。
            //   huanqi 是**新增**的思考预算管理器，不顶掉任何内置条目，**所以没有路 B**。
            //
            //   它要 import 四个宿主内部包（已核对 lib/index.js 第 176-179 行）：
            //     @deepseek-ai/cordis            只用 Context 作类型标注
            //     @deepseek-ai/schemastery       Config 定义（真用）
            //     @deepseek-ai/dsh-llm           isAgentLoopRequest（真用）
            //     @deepseek-ai/dsh-compaction    toolPairingBalancedBefore（真用）
            //
            //   桌面打包版把这些封在 resources/app.asar 里 —— 只有 Electron 的加载器能读 asar，
            //   而插件的 import 走标准 ESM 解析 ⇒ 装上就报 ERR_MODULE_NOT_FOUND。
            //   ★ 这不是配置错，是**安装形态的硬限制**。说清楚，比让用户反复试好。
            if (s.step === 2 && isDesktop) {
              lines.push('  ⚠ 这一步里的 **huanqi 在桌面打包版下装不上**，而且它没有绕路：')
              lines.push('     compaction / pruner 能靠「realm 内同 id 换 name」接管既有条目 —— 那是替换；')
              lines.push('     huanqi 是**新增**的零件，不顶掉任何内置条目，所以那条路对它不成立。')
              lines.push('')
              lines.push('     它要 import 宿主内部包（cordis / schemastery / dsh-llm / dsh-compaction），')
              lines.push('     而打包版把它们封在 resources/app.asar 里 —— 插件的标准 ESM 解析读不进去。')
              lines.push('     症状：启动日志里 `dsh-huanqi: failed to import: Cannot find package`。')
              lines.push('')
              lines.push('     ★ 要装 huanqi，得换一种**能解析到内部包**的 DSH 安装形态（源码 / CLI 安装）。')
              lines.push('     ★ 本步其余零件（clock / model-statusbar / huanqi-panel）不受影响，照常装。')
              lines.push('     ★ 这个问题有 GitHub issue #5 的记录，含完整的复现步骤。')
              lines.push('')
            }
            lines.push('    两个各自和内置的抢同一个服务名，而 cordis 是「先到先得」：')
            lines.push('      dsh-agent-compaction  ←→ 内置 compaction-basic')
            lines.push('      dsh-agent-pruner      ←→ 内置 tool-result-pruner')
            lines.push('    默认装完，doctor 只会报 warn（压缩机制 start 0）—— 看不出「装了但没接管」。')
            lines.push('    接管办法见 plugins/compaction/HOW-TO-TAKEOVER.md：')
            lines.push('')
            lines.push('    ★★★ 做任何一步之前，先确认「我们的包到底加载成功没有」：')
            lines.push('      node -e "require.resolve(\'dsh-agent-pruner\')"   # 或者看 profile 的 node_modules')
            lines.push('      更有用的判据：**启动日志里有没有** import failed / Cannot find package。')
            lines.push('      ★ 为什么这一步是硬前置：下面第②步会把内置的裁剪器**禁掉**。')
            lines.push('        如果我们的包没加载成功，你就会**两个都没有** ——')
            lines.push('        工具结果不再被裁剪，而且**不报任何错**。')
            lines.push('        2026-10-24 有一位用户正是这样：12000 字符的输出原样保留，')
            lines.push('        既没有官方 marker、也没有 seq 门牌。他以为「只是少了门牌」，实际是全停了。')
            lines.push('')
            lines.push('      路 A —— 两步，缺一不可：')
            lines.push('             ① 把两个都排到 profile bundles 最前面（dsh-base 之前）')
            lines.push('             ② 在 profile 的 cordis.patch.yml 里禁掉内置的：')
            lines.push('                  - id: compaction-basic')
            lines.push('                    disabled: true')
            lines.push('                  - id: tool-result-pruner')
            lines.push('                    disabled: true')
            lines.push('                ★ 只做①不行 —— 排序只决定谁先注册，不决定后到的要不要注册。')
            lines.push('                  2026-10-22 干净沙箱实测：只做①启动仍报 service \"compaction\" has been registered。')
            lines.push('                ★ pruner 少禁也一样，而且更隐蔽：启动报 service \"toolResultPruner\" has been registered，')
            lines.push('                  但工具结果裁剪**照样在跑** —— 只是被挖掉那块不带 seq 门牌。「静默地少了一半门牌」')
            lines.push('      路 B —— preset + isolate: { compaction: true, toolResultPruner: true }（realm 隔离）')
            lines.push('    装完必须验，别靠肉眼。判据是四条同时成立：')
            lines.push('      ① 启动日志里没有 service \"compaction\" has been registered')
            lines.push('      ② 启动日志里没有 service \"toolResultPruner\" has been registered')
            lines.push('      ③ tools/soul-probe 读出 ctor: YanqingCompaction')
            lines.push('      ④ 跑一次工具结果裁剪，被挖掉那块是**带 seq 的门牌**、不是内置那句静态 marker')
            lines.push('')
          }
        }
        // ★★ echo 装完还有一件事：它的体检脚本不在包里，得复制到 HUB（2026-10-22 P1-3/P2-8）。
        //
        //   报告实测：全新安装后 HUB 里只有 SELF.src.md / state.json / index，
        //   一个 .mjs 都没有 —— 于是 echo-doctor 扫到 0 个脚本，
        //   版本漂移检查只能报「这项等于没检查」。**它诚实，但等于没用。**
        //
        //   这里只【说清楚】，不替用户拷文件：这个工具只出计划，不执行。
        //   （试过找 action: 'install' 的分支，没有 —— 它压根不干这事。）
        {
          const echoWanted = bundles.some((b) => /echo/.test(b)) || allDirs.some((d) => d === 'echo')
          if (echoWanted) {
            const kitInstaller = join(HERE, 'kit', 'echo', 'install-kit.mjs')
            lines.push('')
            lines.push('  ★ echo 装完还有一件事：把体检脚本装进 HUB（一条命令）。')
            lines.push('       node "' + kitInstaller + '"')
            lines.push('     目标默认是 DSH_HOME/hub；有自己的中枢就设 ECHO_HUB，或用 --hub <目录>。')
            lines.push('    ★ 它只装两个文件：echo-doctor.mjs + echo-config.mjs ——')
            lines.push('      这两个是面板直接 spawn / import 的一套，缺一个 doctor 就起不来。')
            lines.push('    ★ 其余（memq / self / memindex / echo）**故意不装**：')
            lines.push('      它们在每台机器上按自己的中枢位置演化，2026-10-23 实测 HUB 里那两份')
            lines.push('      比仓库还新（各自修过不同的地方）。由仓库覆盖 = 把新修的打回旧版。')
            lines.push('    ★ 装的时候会写 .kit-origin.json（来源目录 / 版本 / 每个文件大小），')
            lines.push('      体检第 14 项「部署一致性」就靠它判断 HUB 里跑的是不是旧的。')
            lines.push('    ★ 升级本仓库之后重跑这条 —— 忘了也没关系：那一项会自己报出来。')
            lines.push('    ★ 少了这一步：面板能开，但 /api/status 里 doctor 会报 spawn ENOENT；')
            lines.push('      版本漂移检查会报「一个脚本都没扫到 —— 这项等于没检查」。')
            lines.push('      两句都不是「出故障了」，是「还没配好」—— 但都会让面板看起来是坏的。')
          }
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
