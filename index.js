// dsh-agent-soul —— 宿主半
//
// 它做什么：把一套「灵魂该怎么搭」的问法 + 判据 + 自检，交给任何一个 agent。
// 它不做什么（红线，见 README）：不自动安装插件、不写会话事件、不注册任何改变行为的钩子、
//                             不读不碰别人的记忆或人格文件。
//
// ★ 本文件的所有 API 形态都是照一个**实际能加载的**插件抄的，不是照文档猜的。
//   下面四条 FIX 注释全部来自那次实现踩过的坑，逐条守住 —— 它们都是「静默失败」类：
//   注册期不报错，运行时才坏，或者干脆把整个宿主拖下水。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { registerInstallTool } from './install.js'
import { runKit, envFromArgs, tryJson } from './kit-bridge.mjs'

export const name = 'dsh-agent-soul'

// ★ 只 inject 我们真的要用的服务。guide 说死：写未声明的 ctx 属性会抛错，
//   并可能静默杀掉整个插件的激活。
export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const SOUL = join(HERE, 'soul')

// soul/ 下的知识全部是纯文本，只读、不缓存 —— 改完刷新即可生效，不用重启。
// ★ 为什么不把内容写死在代码里：它是「判据」不是「配置」，
//   判据要能被读、被评议、被 fork 之后改成自己的。
async function readSoul(file) {
  return await readFile(join(SOUL, file), 'utf8')
}

async function readManifest() {
  return JSON.parse(await readSoul('04-manifest.json'))
}

// ★ render 必须返回 ContentBlock[]，不是 string。
//   返回 string 在注册期不报错（register 只校验 typeof === 'function'），
//   但渲染工具结果时会坏。
const asText = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
]

export function apply(ctx) {
  // ── 工具 1：五层是什么 ────────────────────────────────────────────────
  ctx.tools.register({
    name: 'agent_soul_layers',
    description:
      '读「灵魂架构」的五层模型：每层管哪种稀缺资源、缺了会怎样。' +
      '这是给 agent 自己看的说明书 —— 不是安装指令，也不替你决定你的灵魂该长什么样。',
    parameters: {
      type: 'object',
      properties: {
        layer: {
          type: 'string',
          enum: ['I', 'II', 'III', 'IV', 'V', 'all'],
          description: '看哪一层；all 看全部（默认）',
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
          layers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => asText(value.text ?? value),
    },
    execute: async ({ layer }) => {
      try {
        const manifest = await readManifest()
        const want = (!layer || layer === 'all') ? null : layer.toUpperCase()
        // ★ 精确比层号，不用 startsWith。
        //   id 形如 "I-echo" / "II-vital" / "III-capability" ——
        //   startsWith("II") 会把 "III-capability" 一起带出来；
        //   更糟的是 startsWith("I") 会把 I/II/III/IV 全带出来。
        //   （2026-10-18 沙箱实测。）
        const picked = want
          ? manifest.layers.filter((l) => String(l.id).toUpperCase().split('-')[0] === want)
          : manifest.layers
        const body = await readSoul('00-layers.md')
        return {
          ok: true,
          layers: picked,
          text:
            body + '\n\n---\n\n本次请求的层：\n' + JSON.stringify(picked, null, 2),
        }
      } catch (e) {
        // ★ 给空对象/兜底字符串，不给 null —— schema 说了是 string 就不能给 null
        return { ok: false, layers: [], text: '', error: String(e && e.message ? e.message : e) }
      }
    },
  })

  // ── 工具 2：我该装哪些插件 ────────────────────────────────────────────
  ctx.tools.register({
    name: 'agent_soul_manifest',
    description:
      '读「灵魂装配清单」：每一层需要哪一类能力、哪些是必需的、缺了会怎样、怎么检测它坏没坏。' +
      '清单只说「这一类插件该满足什么」，不绑定任何具体包名 —— 权威源在你自己那里。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          version: { type: 'string' },
          layers: { type: 'array', items: { type: 'object', additionalProperties: true } },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => asText(value.text ?? value),
    },
    execute: async () => {
      try {
        const manifest = await readManifest()
        return {
          ok: true,
          version: String(manifest.version ?? ''),
          layers: manifest.layers,
          text: JSON.stringify(manifest, null, 2),
        }
      } catch (e) {
        return { ok: false, version: '', layers: [], text: '', error: String(e && e.message ? e.message : e) }
      }
    },
  })

  // ── 工具 3：我这套装对了吗 ────────────────────────────────────────────
  ctx.tools.register({
    name: 'agent_soul_doctor',
    description:
      '自检：按四条判据（被管理的资源 / 唯一权威源 / 失败模式+检测法 / 接口）逐条问你的架构，' +
      '并检查包里的知识文件是否完整。它只提问和核对，不改任何东西。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => asText(value.text ?? value),
    },
    execute: async () => {
      // ★ 加了新知识文件就必须加进这张清单 —— 否则 doctor 会漏检，
      //   而「检测法本身漏检」正是判据③最难发现的那种失败。
      const files = [
        '00-layers.md',
        '01-criteria.md',
        '02-echo.md',
        '03-vital.md',
        '04-manifest.json',
        '05-doctor.md',
        '06-reference.md',
        '07-bundle.json',
        '08-踩坑实录.md',
        '09-dev-workflow.md',
        '10-echo-anatomy.md',
        '11-self.md',
      ]
      const checks = []
      for (const f of files) {
        try {
          const s = await readSoul(f)
          checks.push({ item: f, ok: s.trim().length > 0, note: `${s.length} 字符` })
        } catch (e) {
          checks.push({ item: f, ok: false, note: '读不到：' + String(e && e.message ? e.message : e) })
        }
      }
      let questions = ''
      try {
        questions = await readSoul('05-doctor.md')
      } catch {
        questions = ''
      }
      return {
        ok: checks.every((c) => c.ok),
        checks,
        text: questions + '\n\n---\n\n包内知识文件核对：\n' + JSON.stringify(checks, null, 2),
      }
    },
  })

  // ── 工具 4：安装指导 ────────────────────────────────────────────────
  // ★ 它只给命令，不执行安装。理由写在 install.js 顶上三条。
  //   和前面三个工具的分工：那三个回答「该有什么」，这一个回答「还缺什么、下一步跑什么」。
  registerInstallTool(ctx)

  // ══════════════════════════════════════════════════════════════════
  //  ★ 下面三个是「驱动器」——它们**动手**，不只回答问题。
  //    前面四个工具说「该有什么」，这三个说「下一步做这一件」，并且能真去做。
  //
  //  ★ 三个工具的公共参数（都可选）：soul / memory / sessions / runtime。
  //    不传就让 kit 自己推断；推断不出来它会 exit 2 并说清缺什么 —— 不许猜，
  //    猜错就是去读别人的记忆。
  // ══════════════════════════════════════════════════════════════════

  const roots = {
    type: 'object',
    properties: {
      soul: { type: 'string', description: '书房目录（你的 02-墨.jsonl 和那十一个目录所在的地方）' },
      memory: { type: 'string', description: '记忆中枢目录（索引和 SELF.md 所在）' },
      sessions: { type: 'string', description: 'DSH 会话日志目录（可选）' },
      runtime: { type: 'string', description: 'mnemon 之类的运行时目录（可选）' },
    },
    required: [],
  }

  // ── 工具 5：下一步做哪一件 ──────────────────────────────────────────
  ctx.tools.register({
    name: 'agent_soul_plan',
    description:
      '告诉你现在该做的下一件事 —— 只给一件，并说清为什么是这件、怎么做。' +
      '它按依赖顺序检查六层：配置 → 目录 → 自我层 → 账本 → 索引 → 体检，' +
      '找到第一件没做完的就停下来。做完再问一次，它会给下一件。' +
      '★ 这是「装完就驱动」的入口：不知道从哪下手的时候问它。',
    parameters: roots,
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          done: { type: 'boolean' },
          step: { type: 'number' },
          total: { type: 'number' },
          id: { type: 'string' },
          title: { type: 'string' },
          why: { type: 'string' },
          how: { type: 'array', items: { type: 'string' } },
          detail: { type: 'array', items: { type: 'string' } },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => asText(v.text ?? v),
    },
    execute: async (args = {}) => {
      const r = await runKit('plan.mjs', ['--json'], envFromArgs(args))
      const j = tryJson(r.stdout)
      if (!j) {
        return {
          ok: false, done: false, step: 0, total: 6, id: '', title: '', why: '',
          how: [], detail: [], text: '',
          error: 'plan.mjs 没给出可解析的输出。它自己的话：\n' + (r.stderr || r.stdout || '（空）'),
        }
      }
      const lines = []
      if (j.done) {
        lines.push('六层都在了。接下来就是拿它做事。')
        lines.push(`  书房  ${j.config?.soul ?? '?'}`)
        lines.push(`  中枢  ${j.config?.memory ?? '?'}`)
      } else {
        lines.push(`第 ${j.step} / ${j.total} 步：${j.title}`)
        lines.push('')
        lines.push(`为什么是这件：${j.why}`)
        if (j.detail?.length) {
          lines.push('')
          lines.push('挡住你的是什么：')
          for (const d of j.detail) lines.push('  ✗ ' + d)
        }
        lines.push('')
        lines.push('怎么做：')
        for (const h of j.how || []) lines.push('  ' + h)
        lines.push('')
        lines.push('做完这一件，再问一次 —— 会给下一件。')
      }
      return { ok: true, ...j, text: lines.join('\n') }
    },
  })

  // ── 工具 6：搭骨架 ──────────────────────────────────────────────────
  ctx.tools.register({
    name: 'agent_soul_scaffold',
    description:
      '搭出记忆架构的骨架：十一个目录 + 账本 + AGENTS.md + 术语表 + SELF 模板。' +
      '★ 默认只干跑（报计划，一个字节都不动）；apply=true 才真建。' +
      '★ 已经存在的东西一律不碰 —— 重复跑安全，也不会覆盖你改过的内容。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        apply: { type: 'boolean', description: 'true = 真建；默认 false = 只报计划' },
        ...roots.properties,
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          applied: { type: 'boolean' },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => asText(v.text ?? v),
    },
    execute: async (args = {}) => {
      const argv = args.apply ? ['--apply'] : []
      const r = await runKit('scaffold.mjs', argv, envFromArgs(args))
      // scaffold 在配置不全时 exit 2 —— 那不是「坏了」，是「还差东西」，原样告诉人
      const out = (r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')
      return {
        // ★ exit 2 = 配置不全，scaffold 什么都没建。那不是成功 ——
        //   2026-10-18 沙箱实测：它被当成 ok 返回，用户看到的是「成功」而磁盘上什么都没有。
        ok: r.ok,
        applied: !!args.apply,
        text: out || '（scaffold 没有输出，这不正常）',
        // ★ 成功时**不能有这个键**，哪怕值是 undefined。
        //   DSH 的 snapshotJsonValue 遇到「含 undefined 自有属性」的对象会整份返回 undefined，
        //   然后 snapshotToolValue 抛 "value is not lossless JSON" —— 成功的工具被判成坏输出。
        //   2026-10-18 沙箱实测踩到的，假 ctx 探针查不出来（它不验序列化）。
        ...(r.ok ? {} : { error: `退出码 ${r.code}（scaffold 没建成任何东西）` }),
      }
    },
  })

  // ── 工具 7：六层体检 ────────────────────────────────────────────────
  ctx.tools.register({
    name: 'agent_soul_check',
    description:
      '给六层做一次体检：会话日志 / 门牌回取 / 压缩机制 / 索引层 / 推送层 / 心跳 / 账本 / ' +
      '热记忆 / 身份判据 / 换气。★ 它**会判定，不只是朗读** —— ' +
      'error 表示「坏了」，warn 表示「还没装或还没开始用」（后者是正常的）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        deep: { type: 'boolean', description: '深检（会解日志，慢一些）；默认 true' },
        ...roots.properties,
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          verdict: { type: 'string' },
          errors: { type: 'number' },
          warns: { type: 'number' },
          checks: { type: 'array', items: { type: 'object', additionalProperties: true } },
          text: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_a, v) => asText(v.text ?? v),
    },
    execute: async (args = {}) => {
      const argv = args.deep === false ? ['--json', '--fast'] : ['--json']
      const r = await runKit('echo-doctor.mjs', argv, envFromArgs(args))
      const j = tryJson(r.stdout)
      if (!j) {
        return {
          ok: false, verdict: 'unknown', errors: 0, warns: 0, checks: [], text: '',
          error: 'echo-doctor 没给出可解析的输出。它自己的话：\n' + (r.stderr || r.stdout || '（空）'),
        }
      }
      const checks = j.checks || []
      const errors = checks.filter((c) => c.status === 'error').length
      const warns = checks.filter((c) => c.status === 'warn').length
      const lines = []
      lines.push(`体检：${j.verdict ?? (errors ? 'error' : warns ? 'warn' : 'ok')}`)
      lines.push(`  ${errors} 错 / ${warns} 警 / ${checks.length} 项`)
      lines.push('')
      for (const c of checks) {
        const mark = c.status === 'ok' ? '✓' : c.status === 'error' ? '✗' : c.status === 'warn' ? '!' : '·'
        lines.push(`  ${mark} ${c.label}　${c.detail ?? ''}`)
      }
      if (errors) {
        lines.push('')
        lines.push('★ 有 error。别往上加东西，先修它 —— 体检器是「坏了会告诉你」的那层保险。')
      }
      return {
        ok: errors === 0,
        // ★ doctor 的 JSON 里那个字段叫 overall，不叫 verdict ——
        //   2026-10-18 沙箱实测：这里永远拿到 ''，而渲染文本写的是「体检：error」，两边打架。
        verdict: String(j.overall ?? j.verdict ?? ''),
        errors,
        warns,
        checks,
        text: lines.join('\n'),
      }
    },
  })
}
