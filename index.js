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
        const picked = want
          ? manifest.layers.filter((l) => String(l.id).toUpperCase().startsWith(want))
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
}
