// video-settings.mjs —— 把界面参数变成 WanGP 吃得下的 settings.json
// ────────────────────────────────────────────────────────────────
// ★ 为什么要有它：WanGP CLI 不吃命令行参数，它只吃一个 settings.json
//   （`python wgp.py --process <json>`，见 wgp.py L14177「CLI Queue Processing Mode」）。
//   所以「出片页」真正做的事就是【把这个文件填出来】。
//
// ★ 模板来源：D:\AI\WanGP\install-logs\walk_49f_S_settings.json —— 那是**唯一验证通过的满档**
//   （49 帧 / 8 步 / profile 5 / 13.70 分钟）。★ 这里**只改该改的字段，其余整份照抄** ——
//   因为 WanGP 有上百个字段，乱动一个就可能掉出「验证过的档位」。
//
// 用法（两种）：
//   node video-settings.mjs --prompt "动作" --image <首帧> [--end <末帧>] [--frames 49] [--seed 42] [--template <基线模板>] --out <json>
//   node video-settings.mjs --selftest          # 拿真模板对账，不写文件
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// ── 唯一的基线：那份跑通过的模板 ──────────────────────────────
// ★ v3.0.1：模板路径**代码里一个都不留**（v3.0.0 还保留了「本机兜底」，那仍然是一条本机路径）。
//   判据：源文件里只要出现作者机器的路径，换台机器就必然「找不到基线模板」；
//   而它是 line 产线的核心资产（不是可删的调试脚本），坏掉时是静默失败。
//   所以位置只能由【知道 WanGP 装在哪的那一侧】给，两条来源：
//     ① --template <path>（宿主半 plugins/line/index.js 就是这么传的 —— 它本来就持有 WAN_GP_DIR）
//     ② 环境变量 LINE_VIDEO_TEMPLATE
//   ★ 在这里再猜一个默认值，等于把同一条本机路径换个写法继续留在代码里。
export const TEMPLATE = process.env.LINE_VIDEO_TEMPLATE || ''
const NEED_TEMPLATE = '基线模板没配：给 --template <path>，或设 LINE_VIDEO_TEMPLATE'

// ── 三档时长（★ 帧↔秒按 16 fps，2026-10-06 ffmpeg 实测的唯一口径）──
export const FRAME_CHOICES = [
  { frames: 17, seconds: 1.06 },
  { frames: 33, seconds: 2.06 },
  { frames: 49, seconds: 3.06 },   // ★ 默认；65 帧 4/4 崩，不给这个选项
]

// ── 预计耗时（实测台账，用于「按钮旁边永远写着要多久」）──
export const MINUTES_BY_FRAMES = { 17: 5, 33: 9.32, 49: 13.70 }

export function buildVideoSettings(opts = {}) {
  const tplPath = opts.template || TEMPLATE
  if (!tplPath) throw new Error(NEED_TEMPLATE)
  const tpl = JSON.parse(readFileSync(tplPath, 'utf8'))
  const s = { ...tpl }

  // ① 这次真正要改的字段
  s.prompt = String(opts.prompt || '')
  s.image_start = Array.isArray(opts.image) ? opts.image : [String(opts.image || '')]
  s.image_end = opts.end ? [String(opts.end)] : null      // ★ S 与 SE 的【全部】差别就在这一行
  s.image_prompt_type = opts.end ? 'SE' : 'S'
  s.model_type = 'i2v_2_2'
  s.resolution = opts.resolution || '480x832'
  s.video_length = Number(opts.frames || 49)
  s.num_inference_steps = Number(opts.steps || 8)
  s.guidance_scale = Number(opts.cfg != null ? opts.cfg : 3.5)
  s.guidance2_scale = s.guidance_scale
  s.guidance3_scale = s.guidance_scale
  s.flow_shift = Number(opts.flowShift != null ? opts.flowShift : 5)
  s.seed = Number(opts.seed != null ? opts.seed : 42)
  s.override_profile = Number(opts.profile != null ? opts.profile : 5)
  s.batch_size = 1
  s.repeat_generation = 1

  return s
}

// ── 自检：拿真模板对账（证明我改的只有该改的）──────────────
function selftest(tplPath = TEMPLATE) {
  if (!tplPath) { console.error('✗ ' + NEED_TEMPLATE); return false }
  const tpl = JSON.parse(readFileSync(tplPath, 'utf8'))   // ★ 换模板要能换掉这一处，所以走参数
  console.log('基线模板：', tplPath)
  const checks = []
  const ok = (c, label, got, want) => checks.push({ c, label, got, want })

  ok(tpl.model_type === 'i2v_2_2', 'model_type', tpl.model_type, 'i2v_2_2')
  ok(tpl.image_prompt_type === 'S', 'image_prompt_type', tpl.image_prompt_type, 'S')
  ok(tpl.video_length === 49, 'video_length', tpl.video_length, 49)
  ok(tpl.num_inference_steps === 8, 'num_inference_steps', tpl.num_inference_steps, 8)
  ok(tpl.seed === 42, 'seed', tpl.seed, 42)
  ok(tpl.guidance_scale === 3.5, 'guidance_scale', tpl.guidance_scale, 3.5)
  ok(tpl.flow_shift === 5, 'flow_shift', tpl.flow_shift, 5)
  ok(tpl.override_profile === 5, 'override_profile', tpl.override_profile, 5)
  ok(tpl.guidance_phases === 2, 'guidance_phases', tpl.guidance_phases, 2)
  ok(tpl.switch_threshold === 900, 'switch_threshold', tpl.switch_threshold, 900)
  ok(tpl.image_end === null, 'image_end(S 档应为 null)', tpl.image_end, null)
  ok(Array.isArray(tpl.image_start) && tpl.image_start.length === 1, 'image_start 是数组且 1 张', tpl.image_start.length, 1)

  checks.forEach((k) => console.log(`  ${k.c ? '✓' : '✗'} ${k.label} = ${JSON.stringify(k.got)}`))

  // ★ 造一个 SE 的，验证「只差 image_end 一处」
  const a = buildVideoSettings({ prompt: 'x', image: 'A.png', template: tplPath })
  const b = buildVideoSettings({ prompt: 'x', image: 'A.png', end: 'B.png', template: tplPath })
  const diff = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]))
  console.log(`\n  S vs SE 的全部差异字段：${JSON.stringify(diff)}`)
  const expect = ['image_end', 'image_prompt_type']
  const diffOk = diff.length === expect.length && expect.every((k) => diff.includes(k))
  console.log(`  ${diffOk ? '✓' : '✗'} 差异恰好是 ${JSON.stringify(expect)}`)

  const bad = checks.filter((k) => !k.c).length + (diffOk ? 0 : 1)
  console.log(`\n${bad === 0 ? '★ 全部通过' : `✗ ${bad} 项不符`}`)
  return bad === 0
}

// ── 命令行 ────────────────────────────────────────────────
const argv = process.argv.slice(2)
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d }
const has = (n) => argv.includes('--' + n)

const isMain = import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`
if (isMain) {
  const tplArg = arg('template', TEMPLATE)      // ★ 宿主半会把知道的那条路径从这里递进来
  if (has('selftest')) {
    process.exit(selftest(tplArg) ? 0 : 1)
  }
  if (!tplArg) {
    console.error('✗ ' + NEED_TEMPLATE)
    process.exit(1)
  }
  if (!existsSync(tplArg)) {
    console.error('✗ 找不到基线模板：' + tplArg)
    process.exit(1)
  }
  const out = arg('out')
  if (!out) { console.error('用法: node video-settings.mjs --prompt "…" --image <首帧> [--end <末帧>] [--frames 49] [--seed 42] [--template <基线模板>] --out <json>'); process.exit(1) }
  const s = buildVideoSettings({
    prompt: arg('prompt', ''), image: arg('image', ''), end: arg('end', null),
    frames: arg('frames', 49), steps: arg('steps', 8), seed: arg('seed', 42),
    cfg: arg('cfg', 3.5), flowShift: arg('flowShift', 5), profile: arg('profile', 5),
    template: tplArg,
  })
  writeFileSync(out, JSON.stringify(s, null, 4), 'utf8')
  const min = MINUTES_BY_FRAMES[s.video_length] || '?'
  console.log(`✓ 写好：${out}`)
  console.log(`  ${s.model_type} · ${s.resolution} · ${s.video_length} 帧 · ${s.num_inference_steps} 步 · seed ${s.seed} · ${s.image_prompt_type} 锚 · profile ${s.override_profile}`)
  console.log(`  预计 ${min} 分钟`)
}
