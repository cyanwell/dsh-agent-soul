// dsh-yanqing-line —— 宿主半
//
// 干什么：把本机那份 ComfyUI 交给「画廊工作台」和 Agent 一起用。
//   · 启停进程（spawn / taskkill）
//   · 参数读写（落盘成 JSON —— **不烘进 client.js**，改参数不用重启）
//   · 拼 workflow、排队、轮询、取图
//
// 为什么这些活放宿主半而不是浏览器半：
//   浏览器半碰不到 child_process 和文件系统，而且 client.js 是【每次加载都要解析】的
//   启动期资源 —— 参数进去就固化了，改一次要重启一次。
//
// 浏览器半只负责画界面，通过 /yanqing-line/api/* 说话。

import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, renameSync } from 'node:fs'
import { join, extname, basename } from 'node:path'
// ★ 2026-10-02：提示词统计页的数据源。
//   解析放 scripts/ 而不是烘进 client.js —— 词典会继续长，改完 md 刷新就看到了。
//   ★ 部署注意：deploy-and-restart.cmd 必须把整个 scripts\ 一起复制过去，
//     否则这个 import 在部署后就找不到文件（"本地好、发布坏"的经典坑）。
import { parseCidian, CIDIAN_IMG_DIR } from './scripts/parse-cidian.mjs'
// ★ 2026-10-08：队列内核接进来。内核（scripts/queue.mjs）2026-10-06 就写好了，
//   但一直没被引用 —— 这一步是「接线」，不是重写。
import { createQueue } from './scripts/queue.mjs'
import path from 'node:path'

export const name = 'dsh-yanqing-line'
// ★ 2026-10-01 加 'attachments'：技术线出的图要变成 DSH 的 attachment 才能进画廊，
//   而 attachments 必须在这里声明才能拿到 ctx.attachments。
//   ★ 这个数组写多写少都是【静默失效】—— 少写会 undefined，多写一个不存在的服务会一直等、
//     apply 永不执行。服务名照 dsh-image-gen 的 inject 抄（它就是 ["tools","attachments","credentials","webServer"]）。
export const inject = ['tools', 'webServer', 'attachments']

// ── 本机路径（要换机器就改这一段）───────────────────────────────
const COMFY_DIR = 'D:\\AI\\comfyui\\ComfyUI'
const COMFY_PY = 'D:\\AI\\comfyui\\.venv\\Scripts\\python.exe'
const COMFY_PORT = 8188
const BASE = `http://127.0.0.1:${COMFY_PORT}`
const PARAMS_FILE = 'D:\\AI\\comfyui\\panel-params.json'
const OUT_DIR = 'D:\\AI\\comfyui\\panel-out'
const COMFY_INPUT = join(COMFY_DIR, 'input')

const CKPT_DEFAULT = 'animagine-xl-3.1.safetensors'
const IPA_MODEL = 'ip-adapter-plus_sdxl_vit-h.safetensors'
const CLIP_VISION = 'CLIP-ViT-bigG-14.safetensors'

const DEFAULTS = {
  mode: 'txt2img',            // txt2img | img2img
  prompt: 'masterpiece, best quality, very aesthetic, absurdres, 1girl, solo, ' +
          'long dark blue-purple hair, violet eyes, dark grey-purple coat with bright cyan lining, ' +
          'simple pale grey background',
  negative: 'lowres, worst quality, low quality, jpeg artifacts, bad anatomy, bad hands, ' +
            'extra digits, fewer digits, signature, watermark, username, text, error',
  ckpt: CKPT_DEFAULT,
  width: 896, height: 1152,
  steps: 32, cfg: 6.0,
  sampler: 'dpmpp_2m', scheduler: 'karras',
  denoise: 1.0,               // img2img 时才有意义
  seed: -1,                   // -1 = 每次随机
  batch: 1,
  initImage: '',              // img2img 的输入图（绝对路径）
  // IPAdapter（可选）—— 出角色图时靠它保脸
  ipaOn: false, ipaRef: '', ipaWeight: 0.35,
  prefix: 'yq-panel',
}

// ── 进程句柄 ──────────────────────────────────────────────────
let child = null
let startedAt = 0

function loadParams() {
  try {
    if (existsSync(PARAMS_FILE)) {
      return { ...DEFAULTS, ...JSON.parse(readFileSync(PARAMS_FILE, 'utf8')) }
    }
  } catch (e) { /* 文件坏了就用默认值，不让它把插件拖死 */ }
  return { ...DEFAULTS }
}

function saveParams(p) {
  const dir = join(PARAMS_FILE, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(PARAMS_FILE, JSON.stringify(p, null, 2), 'utf8')
}

async function comfyUp(timeoutMs = 2500) {
  try {
    const r = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(timeoutMs) })
    return r.ok
  } catch { return false }
}

async function comfyStats() {
  try {
    const r = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(4000) })
    if (!r.ok) return null
    const j = await r.json()
    const d = j?.devices?.[0] || {}
    return {
      device: d.name || '',
      vramTotal: d.vram_total || 0,
      vramFree: d.vram_free || 0,
      comfy: j?.system?.comfyui_version || '',
      python: j?.system?.python_version || '',
    }
  } catch { return null }
}

// ComfyUI 的模型清单：问它自己，别在本机猜路径
async function options() {
  const out = { ckpt: [], sampler: [], scheduler: [] }
  try {
    const r = await fetch(`${BASE}/object_info/CheckpointLoaderSimple`, { signal: AbortSignal.timeout(8000) })
    if (r.ok) out.ckpt = ((await r.json())?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0]) || []
  } catch { /* 起不来就没清单，界面照常显示 */ }
  try {
    const r = await fetch(`${BASE}/object_info/KSampler`, { signal: AbortSignal.timeout(8000) })
    if (r.ok) {
      const q = (await r.json())?.KSampler?.input?.required || {}
      out.sampler = q.sampler_name?.[0] || []
      out.scheduler = q.scheduler?.[0] || []
    }
  } catch { /* 同上 */ }
  return out
}

// ── 启停 ─────────────────────────────────────────────────────
function killTree(pid) {
  return new Promise((resolve) => {
    // ★ Windows 上杀掉 python 主进程不会带走它拉起的子进程 —— 必须 /T 连树一起杀
    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve())
  })
}

async function startComfy() {
  if (await comfyUp()) return { ok: true, already: true, message: 'ComfyUI 已经在跑' }
  if (!existsSync(COMFY_PY)) return { ok: false, message: `找不到 python：${COMFY_PY}` }
  if (!existsSync(join(COMFY_DIR, 'main.py'))) return { ok: false, message: `找不到 main.py：${COMFY_DIR}` }
  child = spawn(COMFY_PY, ['main.py', '--listen', '127.0.0.1', '--port', String(COMFY_PORT), '--disable-auto-launch'], {
    cwd: COMFY_DIR,
    // ★ 不要 pipe：不读的管道写满之后会把子进程卡死
    stdio: 'ignore',
    windowsHide: true,
  })
  startedAt = Date.now()
  child.on('exit', () => { child = null })
  // 等它就绪（实测约 20~25 秒），最多等 90 秒
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await comfyUp(1500)) return { ok: true, seconds: Math.round((Date.now() - startedAt) / 1000) }
  }
  return { ok: false, message: '启动了但 90 秒内没就绪，去看 ComfyUI 的日志' }
}

async function stopComfy() {
  if (child && !child.killed) {
    await killTree(child.pid)
    child = null
    return { ok: true }
  }
  // 不是本插件拉起来的：按端口找主人
  try {
    const r = await fetch(`${BASE}/system_stats`, { signal: AbortSignal.timeout(1500) })
    if (!r.ok) return { ok: true, message: '本来就没在跑' }
  } catch { return { ok: true, message: '本来就没在跑' } }
  const pids = await new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${COMFY_PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess`],
      (e, so) => resolve(String(so || '').trim().split(/\s+/).filter(Boolean)))
  })
  for (const p of pids) await killTree(p)
  await new Promise((r) => setTimeout(r, 1500))
  return { ok: !(await comfyUp(1500)), killed: pids }
}

// ── workflow 组装 ────────────────────────────────────────────
// 导出是为了能在装机前单独端到端测一遍：这个函数拼出来的东西必须真能被
// ComfyUI 接单，而不是等装好了再拿界面去试错。
export function graph(p) {
  const seed = p.seed >= 0 ? Math.floor(p.seed) : Math.floor(Math.random() * 1e15)
  const g = {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: p.ckpt } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: p.prompt, clip: ['1', 1] } },
    '7': { class_type: 'CLIPTextEncode', inputs: { text: p.negative, clip: ['1', 1] } },
    '9': { class_type: 'KSampler', inputs: {
      seed, steps: Math.floor(p.steps), cfg: p.cfg,
      sampler_name: p.sampler, scheduler: p.scheduler,
      denoise: p.mode === 'img2img' ? p.denoise : 1.0,
      model: ['1', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['8', 0] } },
    // ★ 必须用 VAEDecodeTiled：832×1216 那一档在普通 VAEDecode 上崩过
    //   （ComfyUI 0.36 + torch 2.14 的 conv_carry_causal_3d 路径）
    '10': { class_type: 'VAEDecodeTiled', inputs: {
      samples: ['9', 0], vae: ['1', 2], tile_size: 512, overlap: 64, temporal_size: 64, temporal_overlap: 8 } },
    '12': { class_type: 'SaveImage', inputs: { filename_prefix: p.prefix, images: ['10', 0] } },
  }

  // 模型来源：txt2img 用空 latent，img2img 用真图编码
  const srcModel = ['1', 0]
  if (p.mode === 'img2img' && p.initImage) {
    const name = stageInput(p.initImage)
    g['4'] = { class_type: 'LoadImage', inputs: { image: name } }
    g['11'] = { class_type: 'VAEEncode', inputs: { pixels: ['4', 0], vae: ['1', 2] } }
    g['8'] = { class_type: 'RepeatLatentBatch', inputs: { samples: ['11', 0], amount: Math.max(1, Math.floor(p.batch)) } }
  } else {
    g['8'] = { class_type: 'EmptyLatentImage', inputs: {
      width: Math.floor(p.width), height: Math.floor(p.height), batch_size: Math.max(1, Math.floor(p.batch)) } }
  }

  // IPAdapter（可选）
  if (p.ipaOn && p.ipaRef) {
    const refName = stageInput(p.ipaRef, 'yq-ipa-ref')
    g['2'] = { class_type: 'IPAdapterModelLoader', inputs: { ipadapter_file: IPA_MODEL } }
    g['3'] = { class_type: 'CLIPVisionLoader', inputs: { clip_name: CLIP_VISION } }
    g['5'] = { class_type: 'LoadImage', inputs: { image: refName } }
    g['13'] = { class_type: 'IPAdapterAdvanced', inputs: {
      model: srcModel, ipadapter: ['2', 0], image: ['5', 0], clip_vision: ['3', 0],
      weight: p.ipaWeight, weight_type: 'linear', combine_embeds: 'concat',
      start_at: 0, end_at: 1, embeds_scaling: 'V only' } }
    g['9'].inputs.model = ['13', 0]
  }
  return { graph: g, seed }
}

// 把外部图拷进 ComfyUI 的 input 目录（它只认自己 input 下的文件名）
function stageInput(src, forced) {
  if (!src || !existsSync(src)) throw new Error(`找不到输入图：${src}`)
  const ext = extname(src) || '.png'
  const dst = join(COMFY_INPUT, (forced || basename(src, ext)) + ext)
  writeFileSync(dst, readFileSync(src))
  return basename(dst)
}

// 生成的图落在 ComfyUI 的 output 下；我们把它挪到自己的目录，免得和别的脚本混在一起
function adopt(filename, subfolder) {
  const src = join(COMFY_DIR, 'output', subfolder || '', filename)
  if (!existsSync(src)) return null
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  const dst = join(OUT_DIR, filename)
  writeFileSync(dst, readFileSync(src))
  return filename
}

// ── HTTP 小工具 ──────────────────────────────────────────────
function json(res, code, body) {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(s)
}

function readBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0
    const chunks = []
    req.on('data', (c) => {
      n += c.length
      if (n > limit) { reject(new Error('body 太大')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8')
      if (!s) return resolve({})
      try { resolve(JSON.parse(s)) } catch (e) { reject(new Error('body 不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

// ── 技术线四层：执行器（2026-10-02 加）──────────────────────────
//
// ★ 为什么放宿主半：这四层是【四个独立的 node 脚本】，不是 ComfyUI 的 workflow。
//   浏览器半碰不到 child_process，所以只能在这里 spawn。
//
// ★ argv 规格以【脚本实际的 process.argv 解析】为准（读源码抄的），不是凭文档写。
// ★★ 但默认值取【文档实测的甜点】，不是脚本默认 —— 有两处它们不一致，见下面注释。
const NODE_EXE = 'C:\\Users\\pc\\.workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe'
const SCRIPT_DIR = 'D:\\AI\\yanqing-soul\\70-形象\\形象工程\\02-脚本'
// ★ 出片线（视频）不在这条线上 —— 它是 WanGP 的 Python，不是 node 脚本。
//   两条判据：解释器不同（.venv\python.exe）、入口不同（wgp.py --process <settings.json>）。
//   详见 scripts\video-settings.mjs 顶部的注释。
// ★ 出图线（anchor.mjs）的产物落点。别递归扫，只 readdirSync 这一层。
const COMFY_OUT_DIR = 'D:\\AI\\comfyui\\ComfyUI\\output'
const WAN_GP_DIR = 'D:\\AI\\WanGP'
const WAN_GP_PY = WAN_GP_DIR + '\\.venv\\Scripts\\python.exe'
// ★ 插件自己的目录。判据来自 scripts\queue.mjs（那边 HERE 是 scripts/，所以多一层 ..）：
//   index.js 就在插件根，data/ 是它的子目录。
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(PLUGIN_DIR, 'data')
// ★ 2026-10-06：出图线的脚本不在上面那个目录里 —— anchor.mjs 跟着插件自己走
//   （D:\AI\dsh-tools\dsh-yanqing-line\scripts\），deploy 时和插件一起复制。
//   所以 STAGES 的每一项可以带自己的 dir。
const ANCHOR_DIR = 'D:\\AI\\dsh-tools\\dsh-yanqing-line\\scripts'

// ★★★ 2026-10-11：出图线的参数拼装 —— 【两个引擎共用这一份】。
//   为什么抽出来：anchor.mjs（Z-Image）与 qwen-anchor.mjs（Qwen-Image）的 argv 接口
//   逐字相同（--size/--style/--age/--outfit/--prefix/--seed），差别只在脚本本身。
//   复制两份的代价在这份代码里已经见过一次 —— client.js 里那两份 STYLES_ 列表，
//   加一档忘一处就是「这个页面有、那个页面没有」。所以从加第二个引擎的第一天起只留一份。
//   ★ 参数契约（两个脚本都按这个读）：
//     --size WxH 原样透传（脚本层没有白名单，「支持哪些规格」由前端那张表定义）
//     --age 只在没给 --outfit 时发（服装优先于年龄档，那是脚本里写死的优先级）
//     seed 给了就按 +137 递推（同一批有连贯性又能挑）；没给则每张各自随机
const buildImageArgs = (q) => {
  const n = Math.min(Math.max(Number(q.count ?? 4) || 1, 1), 8)
  const base = Number(q.seed || 0)
  const out = []
  for (let i = 0; i < n; i++) {
    const a = [String(q.prompt || '').trim()]
    if (q.size) a.push('--size', String(q.size))
    if (q.style) a.push('--style', String(q.style))
    if (q.age && !q.outfit) a.push('--age', String(q.age))
    if (typeof q.outfit === 'string' && q.outfit) a.push('--outfit', q.outfit)
    a.push('--prefix', String(q.prefix || 'danfang'))
    if (base) a.push('--seed', String(base + i * 137))
    out.push(a)
  }
  return out
}

const STAGES = {
  // ★★★ 2026-10-06 加：出图 —— 这条才是【当前生效的生图线】。
  //   依据：05-文档\00-当前生效流程-20261004.md（9 节点纯 Z-Image，无 IPAdapter / 无 ControlNet /
  //   无白模 / 无 LoRA / 无放大重绘）。四层那一套（下面那四项）已于 10-04 被剥掉，留作沿革。
  //   与前四层不同的三点：
  //     ① 脚本不在 SCRIPT_DIR，在插件自己的 scripts\ 下（跟着 deploy 走）
  //     ② 不需要 input —— 它从提示词出图
  //     ③ 支持一次跑 N 个 seed（爀曦 2026-10-06 定：一次四张挑一张）
  anchor: {
    script: 'anchor.mjs',
    dir: ANCHOR_DIR,
    needsInput: false,
    title: '出图 · 纯 Z-Image（9 节点）',
    // 用法：node anchor.mjs "<提示词>" [--size WxH] [--style soft] [--seed N]
    //        [--prefix NAME] [--age young|mid|mature|classic] [--outfit "..."]
    // ★ 提示词只写【场景与动作】——身份串 CHARA 和画风都冻在 anchor.mjs 里，不要重复写。
    // ★ seed 留空 = 每一张各自随机（脚本自己 randomInt）；填了就按 +137 递推四张，
    //   这样同一批有连贯性又能挑。
    buildMany: buildImageArgs,
  },

  // ★★★ 2026-10-11 加：第二个出图引擎 —— Qwen-Image 2.1 Turbo（爀曦要的「二选一」）。
  //   他的原话：「丹房的工作台也要同步接入 qwen image 啦，给两个模型接口供我选择」
  //   + 「不同模型会有不同的支持规格，切换模型的时候也要同步切换到它支持的所有规格」。
  //   ★ 为什么这里只是「换一个 script」：两个脚本的 argv 接口逐字相同，
  //     身份串（CHARA）各自冻在脚本内部、四项逐字一样 —— 参数拼装直接共用上面那一份。
  //   ★ dir 不写 → 走默认的 SCRIPT_DIR（D:\AI\yanqing-soul\70-形象\形象工程\02-脚本）——
  //     qwen-anchor.mjs 住在那儿，不像 anchor.mjs 那样跟着插件目录走。
  //   ★ 尺寸不在这里校验：脚本层没有白名单，传什么给什么；
  //     「这个模型支持哪些规格」是【前端那张表】的职责（切换引擎 = 整表切换）。
  qwen: {
    script: 'qwen-anchor.mjs',
    needsInput: false,
    title: '出图 · Qwen-Image 2.1 Turbo',
    buildMany: buildImageArgs,
  },

  // ⚠ 以下四项 = 2026-09-29 的三层技术线，2026-10-04 已判定「极其不稳定」并剥掉。
  //   ★ 保留代码不删：① 出事时能回退 ② 修手（handcrop）那一步仍有效，将来要接回出图线。
  //   ★ 但界面上不该再默认展示它们 —— 见 client.js 的 WorkbenchShell。
  sdxl: {
    script: 'yq-sdxl-triple.mjs',
    title: '阶段 1 · 结构（SDXL 三重约束）· 已废弃',
    // 用法：node yq-sdxl-triple.mjs <变体|all> [seed]
    build: (q) => [q.variant || 'tag-hiten', String(q.seed ?? 927001)],
  },
  takeover: {
    script: 'yq-zimage-takeover.mjs',
    title: '阶段 2 · 画风接管（Z-Image）',
    // 用法：node yq-zimage-takeover.mjs <initImage> [denoise] [seed] [steps] [W] [H]
    build: (q) => [q.input, String(q.denoise ?? 0.65), String(q.seed ?? 20260929), String(q.steps ?? 9)],
  },
  handcrop: {
    script: 'yq-zimage-handcrop.mjs',
    title: '阶段 3 · 修手（裁手→放大→重绘→贴回）',
    // 用法：node yq-zimage-handcrop.mjs <图> <x> <y> <w> <h> [denoise] [seed] [steps] [scale] [blur]
    // ★ 脚本默认 denoise 0.65 / blur 12；而《三模型综合技术线》2026-09-29 实测的甜点是
    //   denoise 0.7 / blur 40，且框要取到 240×384（框太小则窗口边缘没上下文，接缝压不住）。
    //   这里取【文档甜点】—— 它才是实跑收敛值。
    build: (q) => [q.input, String(q.x), String(q.y), String(q.w), String(q.h),
                   String(q.denoise ?? 0.7), String(q.seed ?? 20260929), String(q.steps ?? 9),
                   String(q.scale ?? 4), String(q.blur ?? 40)],
  },
  upscale: {
    script: 'yq-upscale.mjs',
    title: '阶段 4 · 终稿（纯插值超分）',
    // 用法：node yq-upscale.mjs <输入图> [--model 名] [--scale 2] [--denoise 0.25] [--seed N]
    // ★★ denoise 在这里【锁死 0、不给调】：脚本是两段式（超分 + 低 denoise 重绘），
    //    denoise > 0 会让 Z-Image 在 3456×5184 的画布上跑扩散 ——
    //    2026-09-29 实测直接把 ComfyUI 搞卡死（进程占 5GB 内存但 HTTP 全无响应）。
    //    denoise 0 会短路掉整个扩散段，只做 lanczos 放大存图（零重绘）。
    build: (q) => [q.input, '--model', q.model || 'none', '--scale', String(q.scale ?? 3), '--denoise', '0'],
  },
}

// 一次只允许一个 —— 爀曦 2026-09-29 定的「一次只推一个 GPU 重活」，
// 而且这些脚本都连同一个 ComfyUI（8188），并发只会互相打架。
const pipelineJobs = new Map()   // id -> { stage, args, status, log[], code, startedAt, endedAt }
let pipelineChild = null

function startPipelineStage(stageKey, params) {
  const st = STAGES[stageKey]
  if (!st) return { ok: false, message: '未知阶段：' + stageKey }
  if (pipelineChild) return { ok: false, message: '上一层的任务还在跑。一次只推一个 GPU 重活（2026-09-29 定的纪律）' }

  const missing = []
  if (st.needsInput !== false && stageKey !== 'sdxl' && !params.input) missing.push('input')
  // ★ 2026-10-11：出图线现在有两个引擎（anchor=Z-Image / qwen=Qwen-Image）——
  //   这条从「只认 anchor」放宽成「不需要 input 的那条线都要 prompt」。
  //   判据用 st.needsInput === false：它恒等于「出图线」（见上面注册表），
  //   以后再加第三个引擎，这里一个字都不用动。
  if (st.needsInput === false && !String(params.prompt || '').trim()) missing.push('prompt')
  if (stageKey === 'handcrop') {
    for (const k of ['x', 'y', 'w', 'h']) {
      if (params[k] === undefined || params[k] === null || params[k] === '') missing.push(k)
    }
  }
  if (missing.length) return { ok: false, message: '缺参数：' + missing.join(', ') }

  // ★ 每一项可以带自己的 dir（anchor.mjs 跟着插件走，不在 SCRIPT_DIR 里）
  const dir = st.dir || SCRIPT_DIR
  const script = join(dir, st.script)
  if (!existsSync(script)) return { ok: false, message: '脚本不在：' + script }
  if (!existsSync(NODE_EXE)) return { ok: false, message: 'node 不在：' + NODE_EXE }

  // ★ 一次跑一组，还是一串（出图线：一次四张，顺序跑）
  let runs
  try {
    runs = st.buildMany ? st.buildMany(params) : [st.build(params)]
  } catch (e) {
    return { ok: false, message: '参数拼装失败：' + String((e && e.message) || e) }
  }
  if (!Array.isArray(runs) || !runs.length) return { ok: false, message: '没有可跑的参数' }

  const id = 'ps' + Date.now()
  const job = {
    id, stage: stageKey, title: st.title, script, dir, args: runs[0], runs,
    runIndex: 0, outputs: [], status: 'running', log: [], startedAt: Date.now(),
  }
  pipelineJobs.set(id, job)

  // ★ 抓产物路径：每张跑完只看【这一轮新增】的日志段，
  //   否则第二批会把第一批的路径再抓一遍（同一份日志累积在一个 job.log 里）。
  // ★★ 2026-10-06 部署前实测修正（真跑了一次 anchor.mjs，用真日志验的）：
  //    anchor.mjs 打出的是【纯文件名】——实际输出是
  //      「出了 1 张:\r\n  danfang_00001_.png\r\n（在 ComfyUI 的 output 目录下）」
  //    一个盘符都没有。原来那条只认 `X:\...` 的正则一张也抓不到，出图页会贴不出图。
  //    ★ 而且行尾是 CRLF —— 行锚定必须放行 \r，否则 `[ \t]*$` 匹配不到（实测踩过）。
  //    ⇒ 两层：① 先扫 output 目录，找这一轮之后新写出来的图（不依赖日志文案，最稳）
  //             ② 扫不到才退回日志：先找绝对路径，再找独占一行的纯文件名
  const OUT_ABS = /[A-Za-z]:\\[^\s"'<>|]+\.(?:png|jpe?g|webp)/gi
  const OUT_BARE = /^[ \t]*([A-Za-z0-9._-]+\.(?:png|jpe?g|webp))[ \t\r]*$/gim
  const spawnOne = () => {
    job.args = runs[job.runIndex]
    const runT0 = Date.now()
    let child
    try {
      child = spawn(NODE_EXE, [script, ...job.args], { cwd: dir, windowsHide: true })
    } catch (e) {
      job.status = 'error'
      job.log.push('spawn 失败：' + String((e && e.message) || e))
      pipelineChild = null
      job.endedAt = Date.now()
      return
    }
    pipelineChild = child
    const mark = job.log.length            // ← 这一轮的日志起点
    const push = (d) => { job.log.push(String(d)); if (job.log.length > 800) job.log.shift() }
    child.stdout.on('data', push)
    child.stderr.on('data', push)
    child.on('error', (e) => {
      job.status = 'error'
      job.log.push('spawn 失败：' + String((e && e.message) || e))
      pipelineChild = null
      job.endedAt = Date.now()
    })
    child.on('close', (code) => {
      let last = null
      // ① 主路：扫 output 目录，找这一轮开始之后新写出来的图
      //    ★ 给 3 秒余量：文件系统的 mtime 精度、以及写盘与 close 的先后
      try {
        const outDir = join(COMFY_DIR, 'output')
        if (existsSync(outDir)) {
          const fresh = readdirSync(outDir)
            .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
            .map((n) => { let m = 0; try { m = statSync(join(outDir, n)).mtimeMs } catch (e) { /* 单个文件读不到就跳过 */ } return { n, m } })
            .filter((x) => x.m > runT0 - 3000)
            .sort((a, b) => a.m - b.m)
          if (fresh.length) last = join(outDir, fresh[fresh.length - 1].n)
        }
      } catch (e) { /* 目录扫不动就退回日志那条路 */ }
      // ② 退路：从这一轮的日志段里抓
      if (!last) {
        const seg = job.log.slice(mark).join('')
        const abs = seg.match(OUT_ABS)
        if (abs && abs.length) {
          last = abs[abs.length - 1]
        } else {
          const bare = new RegExp(OUT_BARE.source, 'gim')   // 新建：带 g 的正则有 lastIndex 状态
          const found = []
          let m
          while ((m = bare.exec(seg))) found.push(m[1])
          if (found.length) last = join(COMFY_DIR, 'output', found[found.length - 1])
        }
      }
      if (last && !job.outputs.includes(last)) job.outputs.push(last)
      job.runIndex += 1
      const more = job.runIndex < runs.length
      if (code !== 0 || !more) {
        // 成功跑完全部才算 done；中途失败就停在这里（后续几张不跑）
        job.status = code === 0 ? 'done' : 'error'
        job.code = code
        job.endedAt = Date.now()
        pipelineChild = null
      } else {
        spawnOne()
      }
    })
  }
  spawnOne()
  return { ok: true, id, script, args: job.args, total: runs.length }
}

// ── 插件主体 ─────────────────────────────────────────────────
export function apply(ctx) {
  const route = ctx.webServer.register({
    kind: 'prefix',
    path: '/yanqing-line',
    handler: async (req, res) => {
      // ★★ 2026-10-01：必须给跨域放行 —— 这是丹房面板在桌面端打不开数据的真正原因。
      //   桌面端（Electron）的页面 origin 是 file:// 或 app://，从这种页面 fetch
      //   http://127.0.0.1:19387 属于跨域；没有下面这几个头，浏览器直接报
      //   `Failed to fetch`，而界面原来只显示「载入中…」，一个错都不吐 —— 卡了一整晚。
      //   ★ POST 带 content-type: application/json 会触发 OPTIONS 预检，所以必须单独回它。
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'content-type')
      if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end() }

      const url = new URL(req.url, `http://127.0.0.1:${COMFY_PORT}`)
      const p = url.pathname.replace(/^\/yanqing-line/, '') || '/'
      try {
        // 状态 + 参数 + 可选项，一次给全 —— 界面开局只要一个请求
// ─────────────────────────────────────────────────────────────
// 丹房队列 · 服务端权威（2026-10-08 接线）
//   ★ 纪律：串行消费（一次只跑一个）—— 这些活共用同一块 GPU，并发只会互相打架。
//   ★ 账本在 <插件目录>/data/queue.jsonl（只追加），★ deploy 不碰 data/，所以跨部署活下来。
//   ★ run 目前只接【出图线 anchor】；出片线接进来时再加分支。
// ★ 出片：一条 13.70 分钟。它做的事就是【把界面参数写成 settings.json，再喂给 WanGP】——
//   WanGP CLI 不吃命令行 flag（wgp.py L14177「CLI Queue Processing Mode」只认 --process 那个文件）。
//   ★ 产物落在 WanGP 自己的输出目录，不是我们指定的（日志里那行 "Output directory:" 说了算）。
async function runVideo(job) {
    // ★ 2026-10-08：出片页传过来的 image 现在是【源文件名】（savedTo），不是路径 ——
    //   客户端不知道产线目录，由这里解析。两种都接：已经是绝对路径就直接用。
    const resolveImg = (v) => {
        const t = String(v || '').trim()
        if (!t) return t
        if (/^[a-zA-Z]:[\\/]/.test(t) || t.startsWith('/')) return t
        const cands = [COMFY_OUT_DIR, OUT_DIR]
        for (const d of cands) { const p = d + '\\' + t; try { if (existsSync(p)) return p } catch (e) {} }
        return t
    }
    if (job.image) job.image = resolveImg(job.image)
    if (job.end) job.end = resolveImg(job.end)
  const t0 = Date.now()
  const q = job.params || {}
  if (!q.prompt || !String(q.prompt).trim()) return { ok: false, message: '提示词不能空' }
  if (!q.image) return { ok: false, message: '首帧不能空' }

  // ① 生成 settings.json（复用 scripts\video-settings.mjs，那份是拿真模板对过账的）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const jsonPath = path.join(DATA_DIR, 'video-' + stamp + '.json')
  const gen = await new Promise((resolve) => {
    const c = spawn(NODE_EXE, [
      path.join(PLUGIN_DIR, 'scripts', 'video-settings.mjs'),
      '--prompt', String(q.prompt),
      '--image', String(q.image),
      ...(q.end ? ['--end', String(q.end)] : []),
      '--frames', String(q.frames || 49),
      '--steps', String(q.steps || 8),
      '--seed', String(q.seed != null ? q.seed : 42),
      '--out', jsonPath,
    ], { cwd: PLUGIN_DIR, windowsHide: true })
    let buf = ''
    c.stdout.on('data', (d) => { buf += String(d) })
    c.stderr.on('data', (d) => { buf += String(d) })
    c.on('error', (e) => resolve({ ok: false, buf: String(e && e.message || e) }))
    c.on('close', (code) => resolve({ ok: code === 0, buf }))
  })
  if (!gen.ok || !existsSync(jsonPath)) {
    return { ok: false, message: '生成 settings.json 失败：' + String(gen.buf || '').slice(-300), seconds: (Date.now() - t0) / 1000 }
  }

  // ② 跑 WanGP（★ 它自己挑输出目录；启动前删 startup.lock 是它文档里写死的规矩）
  try { const lock = path.join(WAN_GP_DIR, 'startup.lock'); if (existsSync(lock)) rmSync(lock, { force: true }) } catch (e) { /* 删不掉就算了 */ }
  const r = await new Promise((resolve) => {
    const c = spawn(WAN_GP_PY, ['wgp.py', '--process', jsonPath], {
      cwd: WAN_GP_DIR, windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    })
    let buf = ''
    c.stdout.on('data', (d) => { buf += String(d) })
    c.stderr.on('data', (d) => { buf += String(d) })
    c.on('error', (e) => resolve({ ok: false, buf: String(e && e.message || e) }))
    c.on('close', (code) => resolve({ ok: code === 0, code, buf }))
  })
  if (!r.ok) {
    return { ok: false, message: 'WanGP 退出码 ' + r.code + '：' + String(r.buf || '').slice(-400), seconds: (Date.now() - t0) / 1000 }
  }
  // 产物：日志里的 mp4 文件名（纯文件名，和 anchor 那条线同一个口径）
  const outputs = [...new Set([...String(r.buf || '').matchAll(/([\w.-]+\.mp4)/g)].map((m) => m[1]))]
  return { ok: true, outputs, seconds: (Date.now() - t0) / 1000, settings: jsonPath }
}

const danfangQueue = createQueue({
  onChange: () => { /* 界面每 3 秒自己拉 /api/queue，这里不用推 */ },
  run: async (job) => {
    const t0 = Date.now()
    if (job.kind === 'video') return await runVideo(job)   // ★ 出片走另一条路（python + settings.json）
    const st = STAGES[job.kind]
    if (!st) return { ok: false, message: '不认识的活：' + job.kind }
    const dir = st.dir || SCRIPT_DIR
    const script = dir.replace(/[\/]+$/, '') + '/' + st.script   // ★ 不用 require（本文件是 ESM）；正斜杠 Windows 也认
    const q = job.params || {}
    const argSets = st.buildMany ? st.buildMany(q) : [st.build ? st.build(q) : []]
    const outputs = []
    for (const args of argSets) {
      const r = await new Promise((resolve) => {
        const c = spawn(NODE_EXE, [script, ...args], { cwd: dir, windowsHide: true })
        let buf = ''
        c.stdout.on('data', (d) => { buf += String(d) })
        c.stderr.on('data', (d) => { buf += String(d) })
        c.on('error', (e) => resolve({ ok: false, message: 'spawn 失败：' + String(e && e.message || e) }))
        c.on('close', (code) => resolve({ ok: code === 0, code, buf }))
      })
      if (!r.ok) return { ok: false, message: '退出码 ' + r.code, seconds: (Date.now() - t0) / 1000 }
      // anchor.mjs 打的是【纯文件名】
      for (const m of String(r.buf || '').matchAll(/([\w.-]+\.png)/g)) outputs.push(m[1])
    }
    return { ok: true, outputs: [...new Set(outputs)], seconds: (Date.now() - t0) / 1000 }
  },
})
danfangQueue.start()

        // ★ 图库：给出图线的产物目录，供出片页挑首帧/末帧。
        //   只列这一层（readdirSync，不递归）—— 递归扫盘是踩过的坑。
        //   ★ 返回的是【路径】，不是图 —— 显示走 DF_IMG 那条（image-gen 插件读图）。
        // ★ 2026-10-08 修：原来写成 '/gallery'，但前端拼的是 API + '/gallery'
        //   = /yanqing-line/api/gallery → 宿主半剥掉插件前缀后剩 '/api/gallery'，
        //   于是永远匹配不上、界面报「没有这个路由：/api/gallery」。
        //   这里两种都接 —— 前缀剥到哪一层不归我猜。
        if (p === '/api/gallery' || p === '/gallery') {
            // ★ 2026-10-08 修：原来 catch 成空数组，界面只说「图库空着」——那是把「不知道」伪装成「没有」。
            //   现在把错误原样吐回去，界面上能看见，排查不用猜。
            try {
                const items = readdirSync(COMFY_OUT_DIR)
                    .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
                    .map((f) => {
                        let mt = 0
                        try { mt = statSync(OUT_DIR + '/' + f).mtimeMs } catch (e) { /* 单张失败不致命 */ }
                        return { name: f, path: OUT_DIR + '/' + f, mtime: mt }
                    })
                    .sort((a, b) => b.mtime - a.mtime)     // 新的在前
                    .slice(0, 200)                          // ★ 上限 200 —— 别把整个目录塞进界面
                return json(res, 200, { ok: true, dir: OUT_DIR, count: items.length, items })
            } catch (e) {
                return json(res, 200, { ok: false, dir: OUT_DIR, count: 0, items: [],
                                        message: '读不到目录：' + String((e && e.message) || e) })
            }
        }

        // ★ 队列：GET 看列表 / POST 入队 / POST&act=cancel|retry 操作
        if (p === '/api/queue') {
          const act = url.searchParams.get('act')
          if (req.method === 'POST') {
            if (act === 'cancel') return json(res, 200, danfangQueue.cancel(String(url.searchParams.get('id') || '')))
            if (act === 'retry') return json(res, 200, danfangQueue.retry(String(url.searchParams.get('id') || '')))
            const kind = String(url.searchParams.get('kind') || 'anchor')
            const params = {
              prompt: String(url.searchParams.get('prompt') || ''),
              count: Number(url.searchParams.get('count') || 4),
              seed: url.searchParams.get('seed') || '',
              size: url.searchParams.get('size') || '',
              style: url.searchParams.get('style') || 'soft',
              age: url.searchParams.get('age') || '',
              outfit: url.searchParams.get('outfit') || '',
              prefix: url.searchParams.get('prefix') || 'danfang',
            }
            // ★ 2026-10-11：出图线现在有两个引擎（anchor / qwen）—— 这条从「只认 anchor」
            //   放宽成「STAGES 里所有不需要 input 的活都要 prompt」，与 startPipelineStage 同一判据。
            //   ★ 顺带修一个隐患：原来的 params.prompt.trim() 在 prompt 缺失时会抛 TypeError
            //     （回 500 而不是 400）。
            if ((STAGES[kind] || {}).needsInput === false && !String(params.prompt || '').trim()) {
              return json(res, 400, { ok: false, message: '提示词不能空' })
            }
            if (kind === 'video' && (!params.prompt || !String(params.prompt).trim())) return json(res, 400, { ok: false, message: '提示词不能空' })
            if (kind === 'video' && !params.image) return json(res, 400, { ok: false, message: '首帧不能空' })
            const id = danfangQueue.add(kind, params)   // ★ add() 直接返回 id 字符串
            return json(res, 200, { ok: true, id })
          }
          return json(res, 200, {
            ok: true,
            running: danfangQueue.isRunning(),
            counts: danfangQueue.counts(),
            jobs: danfangQueue.list(50),
            ledger: danfangQueue.ledgerPath,
          })
        }

        if (p === '/api/state') {
          const up = await comfyUp()
          return json(res, 200, {
            ok: true, running: up, stats: up ? await comfyStats() : null,
            params: loadParams(), options: up ? await options() : { ckpt: [], sampler: [], scheduler: [] },
            paths: { comfyDir: COMFY_DIR, outDir: OUT_DIR, paramsFile: PARAMS_FILE, port: COMFY_PORT },
          })
        }
        // ── 提示词统计页的数据（2026-10-02 加）─────────────────────
        // ★ 现解析 md、不读缓存文件：词典改完刷新页面就看到了，不用重跑脚本。
        //   208 行 / 11KB，纯字符串处理，一次几毫秒。
        // ★★ 这一页的纪律：只搬不解释 —— 词典里没写的，界面上不会出现。
        if (p === '/api/cidian') {
          const d = parseCidian()
          return json(res, d.ok ? 200 : 500, d)
        }

        // ── 词条配图（2026-10-06 加）───────────────────────────────
        // ★ 为什么需要这条路由：词条里的「图」是 stickers 目录下的**本地文件**，
        //   而浏览器碰不到本地路径 —— 必须由宿主半读出来、以二进制送过去。
        // ★ 只允许读 CIDIAN_IMG_DIR 下的**单层文件名**：先用 basename 削掉任何目录成分，
        //   再要求扩展名是图片。这样 `?f=../../../凭据.json` 这类穿越会被削成 `凭据.json`
        //   然后因为扩展名不合规被拒 —— 两道都留着，不靠其中一道。
        if (p === '/api/cidian-img') {
          const f = basename(String(url.searchParams.get('f') || ''))
          if (!f || !/\.(png|jpe?g|webp)$/i.test(f)) {
            return json(res, 400, { ok: false, message: '文件名不合法（只收单层文件名 + 图片扩展名）' })
          }
          const full = join(CIDIAN_IMG_DIR, f)
          if (!existsSync(full)) {
            return json(res, 404, { ok: false, message: '图不在：' + f })
          }
          const buf = readFileSync(full)
          const type = /\.png$/i.test(f) ? 'image/png'
            : /\.webp$/i.test(f) ? 'image/webp' : 'image/jpeg'
          res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' })
          return res.end(buf)
        }

        // ── 技术线四层：执行（2026-10-02 加）───────────────────────
        // ★ 这四层是四个独立脚本，不是 ComfyUI workflow —— 见上面 STAGES 的注释。
        // ★★ 一次只跑一个（pipelineChild 是全局单例）：它们都连同一个 ComfyUI，
        //    并发会互相打架，而且爀曦 2026-09-29 明确「一次只推一个 GPU 重活」。
        if (p === '/api/stages') {
          return json(res, 200, {
            ok: true,
            busy: !!pipelineChild,
            stages: Object.keys(STAGES).map((k) => ({
              key: k, title: STAGES[k].title, script: STAGES[k].script,
            })),
            scriptDir: SCRIPT_DIR,
            nodeExe: NODE_EXE,
          })
        }
        if (p === '/api/stage' && req.method === 'POST') {
          const body = await readBody(req)
          return json(res, 200, startPipelineStage(body.stage, body.params || {}))
        }
        if (p === '/api/stage') {
          const jid = url.searchParams.get('id')
          const j = jid ? pipelineJobs.get(jid) : null
          if (!j) return json(res, 404, { ok: false, message: '没有这个任务' })
          return json(res, 200, Object.assign({ ok: true }, j, {
            tail: j.log.slice(-80).join(''),
            seconds: Math.round(((j.endedAt || Date.now()) - j.startedAt) / 1000),
          }))
        }

        if (p === '/api/start' && req.method === 'POST') return json(res, 200, await startComfy())
        if (p === '/api/stop' && req.method === 'POST') return json(res, 200, await stopComfy())

        // ── 产线产物 → 画廊（2026-10-01 加）──────────────────────────
        // ★ 为什么需要这一环：
        //   anchor.mjs 是直接调 ComfyUI 出图的，图落在 ComfyUI 的 output 目录里，
        //   完全不经过 DSH 的 attachment 系统。而丹房图库（和画廊共用一本账）读的是
        //   IndexedDB 里的 gallery_history，每条记录都必须带一个 attachment。
        //   所以中间必须有人把「磁盘上的 png」变成「DSH 的 attachment」——
        //   那就是宿主半的 ctx.attachments.saveImage()（签名照 dsh-image-gen 抄的）。
        //   浏览器半碰不到文件系统，这一步只能在宿主半做。

        // 列出产线出过的图（扫 ComfyUI 的 output 目录，按时间倒序）
        if (p === '/api/pipeline') {
          const dir = join(COMFY_DIR, 'output')
          let files = []
          if (existsSync(dir)) {
            try {
              files = readdirSync(dir)
                .filter((n) => /\.(png|jpe?g|webp)$/i.test(n))
                .map((n) => {
                  const full = join(dir, n)
                  let size = 0, mtime = 0
                  try { const st = statSync(full); size = st.size; mtime = st.mtimeMs } catch {}
                  return { name: n, size, mtime }
                })
                .sort((a, b) => b.mtime - a.mtime)
                .slice(0, 300)
            } catch (e) { /* 目录读不了就当空的，不要把整个路由打挂 */ }
          }
          return json(res, 200, { ok: true, dir, files })
        }

        // 把其中一个文件变成 DSH attachment；前端拿到 attachment 后再写进 gallery_history
        if (p === '/api/import' && req.method === 'POST') {
          const body = await readBody(req)
          const nm = typeof body.name === 'string' ? body.name : ''
          // ★ 防目录穿越：只接受 output 目录下的**纯文件名**，不许带路径分隔符或 ..
          if (!nm || nm.includes('/') || nm.includes('\\') || nm.includes('..')) {
            return json(res, 200, { ok: false, message: '文件名不合法' })
          }
          const full = join(COMFY_DIR, 'output', nm)
          if (!existsSync(full)) return json(res, 200, { ok: false, message: '文件不存在：' + nm })

          const mediaType = /\.jpe?g$/i.test(nm) ? 'image/jpeg'
            : /\.webp$/i.test(nm) ? 'image/webp' : 'image/png'

          // ★ 先照 dsh-image-gen 的样子验一遍，别把 saveImage 打挂
          const limits = ctx.attachments && ctx.attachments.imageLimits
          if (limits && Array.isArray(limits.mediaTypes) && !limits.mediaTypes.includes(mediaType)) {
            return json(res, 200, { ok: false, message: '当前 DSH 不支持保存 ' + mediaType })
          }
          const data = readFileSync(full)
          if (limits && limits.maxImageBytes && data.length > limits.maxImageBytes) {
            return json(res, 200, { ok: false, message: '图太大（' + data.length + ' 字节），超过上限 ' + limits.maxImageBytes })
          }

          const attachment = await ctx.attachments.saveImage({
            data, mediaType, name: basename(nm, extname(nm)),
          })
          return json(res, 200, { ok: true, attachment, source: nm, bytes: data.length })
        }

        if (p === '/api/params' && req.method === 'POST') {
          const body = await readBody(req)
          const next = { ...loadParams(), ...body }
          saveParams(next)
          return json(res, 200, { ok: true, params: next })
        }
        if (p === '/api/reset' && req.method === 'POST') {
          const next = { ...DEFAULTS }
          saveParams(next)
          return json(res, 200, { ok: true, params: next })
        }

        if (p === '/api/generate' && req.method === 'POST') {
          if (!(await comfyUp())) return json(res, 200, { ok: false, message: 'ComfyUI 没在跑，先点「启动」' })
          const body = await readBody(req)
          const params = { ...loadParams(), ...body }
          saveParams(params)
          const { graph: g, seed } = graph(params)
          const r = await fetch(`${BASE}/prompt`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt: g, client_id: 'dsh-yanqing-line' }),
          })
          const t = await r.text()
          if (!r.ok) return json(res, 200, { ok: false, message: 'ComfyUI 拒绝了这个 workflow', detail: t.slice(0, 1200) })
          const { prompt_id } = JSON.parse(t)
          return json(res, 200, { ok: true, id: prompt_id, seed })
        }

        if (p === '/api/job') {
          const id = url.searchParams.get('id')
          if (!id) return json(res, 400, { ok: false, message: '缺 id' })
          const r = await fetch(`${BASE}/history/${id}`, { signal: AbortSignal.timeout(8000) })
          if (!r.ok) return json(res, 200, { ok: true, status: 'pending' })
          const h = await r.json()
          const e = h[id]
          if (!e) return json(res, 200, { ok: true, status: 'pending' })
          if (e.status?.status_str === 'error') {
            const m = (e.status.messages || []).find((x) => x[0] === 'execution_error')
            return json(res, 200, { ok: false, status: 'error', message: m ? m[1].exception_message : 'ComfyUI 执行出错' })
          }
          const imgs = e.outputs?.['12']?.images || []
          if (!imgs.length) return json(res, 200, { ok: true, status: 'running' })
          const files = imgs.map((im) => adopt(im.filename, im.subfolder)).filter(Boolean)
          return json(res, 200, { ok: true, status: 'done', files })
        }

        if (p === '/api/img') {
          const f = basename(url.searchParams.get('f') || '')
          // ★ 2026-10-08 修：原来只在 OUT_DIR 找。但图库列表（/api/gallery）列的是
          //   COMFY_OUT_DIR —— 名字不在这个目录里，于是每张图都 404、界面满屏破图标。
          //   现在两个目录都试：谁有就给谁。（两条线本来就都该被看见。）
          const dirs = [OUT_DIR, COMFY_OUT_DIR]
          const hit = f ? dirs.find((d) => { try { return existsSync(join(d, f)) } catch (e) { return false } }) : null
          if (!f || !hit) { res.writeHead(404); return res.end('not found') }
          const buf = readFileSync(join(hit, f))
          const ext = extname(f).toLowerCase()
          const mime = ext === '.webp' ? 'image/webp' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
          res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store', 'content-length': buf.length })
          return res.end(buf)
        }

        // ★ 2026-10-04 爀曦要求：「再给一个打开对应文件夹的功能，这样我可以快速访问对应的目录」
        //   浏览器做不到这件事（安全限制），只有宿主半能调资源管理器。
        //   explorer /select,<绝对路径> = 打开父目录并**选中那个文件** —— 比只开目录更准，
        //   他要找的就是"这一张"，不是"那一堆"。
        //   ★ 坑：/select, 后面不能有空格，整个 "/select,C:\..." 必须是**一个**参数。
        //   ★ 防目录穿越的判据和 /api/import 保持一致（只收纯文件名）。
        if (p === '/api/reveal' && req.method === 'POST') {
          const body = await readBody(req)
          const nm = typeof body.name === 'string' ? body.name : ''
          if (!nm || nm.includes('/') || nm.includes('\\') || nm.includes('..')) {
            return json(res, 200, { ok: false, message: '文件名不合法' })
          }
          const full = join(COMFY_DIR, 'output', nm)
          if (!existsSync(full)) {
            return json(res, 200, { ok: false, message: '文件不在产线目录里：' + nm })
          }
          try {
            const child = spawn('explorer.exe', ['/select,' + full], { detached: true, stdio: 'ignore' })
            child.unref()
            return json(res, 200, { ok: true, dir: join(COMFY_DIR, 'output'), file: nm })
          } catch (e) {
            return json(res, 200, { ok: false, message: String(e?.message || e) })
          }
        }

        // ══════════════════════════════════════════════════════════════
        // 图片元数据 & 删除（2026-10-12 加）
        // ══════════════════════════════════════════════════════════════
        // ★ 由来：爀曦要求「在原有的复制图片、打开文件夹的基础上，再加删除、
        //   查看图片提示词、seed 等信息的功能」，位置是「靠近图片左上角」。
        //   两个子界面（图库页、工作台/出图页的灯箱）都要有，所以做成通用路由。

        // 读 PNG 的 tEXt 块。出图时 ComfyUI 会把两个 JSON 塞进去：
        //   `prompt`（节点图，每个节点的 inputs 都在里面）+ `workflow`（画布结构）。
        //   seed 和正向提示词都埋在 prompt 那个 JSON 里，得挖出来。
        //   PNG 结构：8 字节签名 + 若干 [长度4 + 类型4 + 数据 + CRC4]；遇到 IDAT/IEND 就不用再往后了。
        function pngText(buf) {
          const out = {}
          let i = 8
          while (i + 8 <= buf.length) {
            const len = buf.readUInt32BE(i)
            const type = buf.toString('ascii', i + 4, i + 8)
            if (type === 'tEXt') {
              const d = buf.subarray(i + 8, i + 8 + len)
              const z = d.indexOf(0)
              if (z > 0) out[d.toString('latin1', 0, z)] = d.toString('latin1', z + 1)
            } else if (type === 'IDAT' || type === 'IEND') break
            i += 12 + len
          }
          return out
        }

        // 从 ComfyUI 的 prompt 节点图里挖参数。
        // ★ 不假设节点编号（每次出图都可能不同），改成遍历所有节点按 class_type 认。
        //   正向/负向提示词的区分靠「KSampler 的 positive/negative 指向哪个节点」，
        //   拿不到就退回「第一条 CLIPTextEncode 当正向」——够用，且不会因此报错。
        function digPrompt(json) {
          const r = { seed: null, positive: '', negative: '', steps: null, cfg: null, sampler: '', size: '', ckpt: '' }
          let g
          try { g = JSON.parse(json) } catch (e) { return r }
          const nodes = Object.entries(g || {})
          const enc = {}, samplers = []
          for (const [id, n] of nodes) {
            const ct = n && n.class_type
            if (ct === 'CLIPTextEncode') enc[id] = String((n.inputs || {}).text || '')
            if (/KSampler|SamplerCustom/i.test(ct || '')) samplers.push([id, n])
            if (/CheckpointLoader/i.test(ct || '')) r.ckpt = String((n.inputs || {}).ckpt_name || '')
            if (/EmptyLatentImage/i.test(ct || '')) {
              const inp = n.inputs || {}
              if (inp.width && inp.height) r.size = inp.width + '×' + inp.height
            }
          }
          for (const [, n] of samplers) {
            const inp = n.inputs || {}
            if (r.seed == null && inp.seed != null) r.seed = inp.seed
            if (r.steps == null && inp.steps != null) r.steps = inp.steps
            if (r.cfg == null && inp.cfg != null) r.cfg = inp.cfg
            if (!r.sampler && inp.sampler_name) r.sampler = String(inp.sampler_name)
            const pos = Array.isArray(inp.positive) ? inp.positive[0] : null
            const neg = Array.isArray(inp.negative) ? inp.negative[0] : null
            if (pos != null && enc[pos] != null) r.positive = enc[pos]
            if (neg != null && enc[neg] != null) r.negative = enc[neg]
          }
          if (!r.positive) { const k = Object.keys(enc)[0]; if (k) r.positive = enc[k] }
          return r
        }

        // ★ 一层小缓存：一张图几 MB，反复点开同一张不必重读磁盘。
        //   上限 40 条，FIFO 淘汰 —— 够用，且不会长期占内存。
        const META_CACHE = new Map()

        if (p === '/api/meta') {
          let nm = url.searchParams.get('name') || ''
          if (!nm || nm.includes('/') || nm.includes('\\') || nm.includes('..')) {
            return json(res, 200, { ok: false, message: '文件名不合法' })
          }
          // ★★★ 2026-10-12 14:23 加扩展名回退 —— **这就是图库页读不到的真正原因**。
          //   图库记录里存的 name【没有扩展名】（爀曦截图实测：danfang_00098_），
          //   而磁盘上的文件叫 danfang_00098_.png。实测对照：
          //     name=danfang_00098_      → ok=false
          //     name=danfang_00098_.png  → ok=true
          //   工作台那条能成，正是因为它传的是真文件名（出图页同理）。
          //   ⇒ 让宿主半自己补后缀：一处改，三处受益，前端一行不用动。
          if (!existsSync(join(COMFY_DIR, 'output', nm))) {
            for (const ext of ['.png', '.webp', '.jpg', '.jpeg']) {
              if (existsSync(join(COMFY_DIR, 'output', nm + ext))) { nm += ext; break }
            }
          }
          if (META_CACHE.has(nm)) return json(res, 200, META_CACHE.get(nm))
          const full = join(COMFY_DIR, 'output', nm)
          if (!existsSync(full)) return json(res, 200, { ok: false, message: '文件不在产线目录里：' + nm })
          try {
            const buf = readFileSync(full)
            const text = pngText(buf)
            const dig = text.prompt ? digPrompt(text.prompt) : null
            const out = {
              ok: true, name: nm, bytes: buf.length,
              // ★ 提示词可能很长，前端自己滚动；这里原样给全，不做截断（截断会丢参数）
              positive: dig ? dig.positive : '',
              negative: dig ? dig.negative : '',
              seed: dig && dig.seed != null ? String(dig.seed) : '',
              steps: dig && dig.steps != null ? String(dig.steps) : '',
              cfg: dig && dig.cfg != null ? String(dig.cfg) : '',
              sampler: dig ? dig.sampler : '',
              size: dig ? dig.size : '',
              ckpt: dig ? dig.ckpt : '',
              // ★ 有没有元数据本身是个信息：有些图（比如后期拼的、或别的工具出的）没有 tEXt
              hasMeta: !!(text.prompt || text.workflow),
              keys: Object.keys(text),
            }
            if (META_CACHE.size >= 40) META_CACHE.delete(META_CACHE.keys().next().value)
            META_CACHE.set(nm, out)
            return json(res, 200, out)
          } catch (e) {
            return json(res, 200, { ok: false, message: String(e?.message || e) })
          }
        }

        // ★★ 删除 —— 优先移到【系统回收站】（2026-10-12 14:28 改，爀曦的要求）。
        //
        //   ★ 为什么改：原来移到 output\_trash\，而「同步产线」扫的正是 output\ 目录 ——
        //     _trash 是它的子目录，所以下次同步会把删掉的图【又捞回图库】（爀曦实测发现）。
        //     他的原话：「要么不改图库的读取目录，直接删除，放到系统回收站里，
        //     不然我点同步产线，它们又会回来。」
        //   ★ 系统回收站 $Recycle.Bin 不在 output\ 里，同步天然扫不到；而且能还原、
        //     对他是熟悉的东西（不用再教一个我自造的目录）。
        //   ★ Node 没有内置的回收站 API，所以借 PowerShell 的 Microsoft.VisualBasic：
        //     DeleteFile(路径, OnlyErrorDialogs, SendToRecycleBin) —— 那是"删除到回收站"。
        //   ★ 万一 PowerShell 那条路失败（比如被策略挡了），退回原来的 _trash\ 做法，
        //     保证"至少不会真删掉"这条底线不破。
        function toRecycleBin(fullPath) {
          return new Promise((resolve) => {
            const script = 'Add-Type -AssemblyName Microsoft.VisualBasic;' +
              '[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(' +
              "'" + fullPath.replace(/'/g, "''") + "','OnlyErrorDialogs','SendToRecycleBin')"
            let c
            try {
              c = spawn('powershell.exe',
                ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
                { windowsHide: true })
            } catch (e) { return resolve(false) }
            let out = ''
            c.stdout.on('data', (d) => { out += d })
            c.stderr.on('data', (d) => { out += d })
            c.on('close', (code) => resolve(code === 0))
            c.on('error', () => resolve(false))
          })
        }

        if (p === '/api/delete' && req.method === 'POST') {
          const body = await readBody(req)
          let nm = typeof body.name === 'string' ? body.name : ''
          if (!nm || nm.includes('/') || nm.includes('\\') || nm.includes('..')) {
            return json(res, 200, { ok: false, message: '文件名不合法' })
          }
          // ★ 扩展名回退：图库页传的 name 没有后缀（danfang_00098_），要和 /api/meta 一致地补上，
          //   否则删除会报"文件不在产线目录里"。
          if (!existsSync(join(COMFY_DIR, 'output', nm))) {
            for (const ext of ['.png', '.webp', '.jpg', '.jpeg']) {
              if (existsSync(join(COMFY_DIR, 'output', nm + ext))) { nm += ext; break }
            }
          }
          const full = join(COMFY_DIR, 'output', nm)
          if (!existsSync(full)) return json(res, 200, { ok: false, message: '文件不在产线目录里：' + nm })

          // ① 先试系统回收站
          if (await toRecycleBin(full)) {
            META_CACHE.delete(nm)
            return json(res, 200, { ok: true, name: nm, where: 'recycle-bin',
              message: '已移到系统回收站，需要的话可以从回收站还原' })
          }
          // ② 退回 output\_trash\（底线：不真删）
          const trashDir = join(COMFY_DIR, 'output', '_trash')
          try {
            if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true })
            const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
            const dest = join(trashDir, stamp + '__' + nm)
            renameSync(full, dest)
            META_CACHE.delete(nm)
            return json(res, 200, { ok: true, name: nm, where: 'trash-dir', trash: dest,
              message: '回收站那条路没走通，已移到 output\\_trash（注意：同步产线时可能被重新捞回来）' })
          } catch (e) {
            return json(res, 200, { ok: false, message: String(e?.message || e) })
          }
        }

        // ── 显卡设置 · TDR 超时（2026-10-06 加）────────────────────
        // ★ 由来：爀曦 2026-10-06 15:19 批准把 TdrDelay 从系统默认 2 秒改成 10 秒 ——
        //   治 nvlddmkm 事件 153（原文 "Reset TDR occurred on GPUID:100"）导致的出图中断。
        // ★ 他的原话：「顺带把 GPU 设置撤销键做到工作台里面，不然我们后面都忘了这回事。」
        //   所以这一块存在的意义不是常用，是**留一个看得见的把手**：哪天想退回去，点一下就行。
        // ★ 读：`reg query` 不需要管理员权限。
        // ★ 写：必须提权 —— 本进程是普通权限，直接写 HKLM 会「不允许所请求的注册表访问权」
        //   （2026-10-06 实测试过）。所以走 Start-Process -Verb RunAs 弹一次 UAC；
        //   提权进程的 stdout 拿不到，所以前端点完自己重新 GET 一次看结果。
        if (p === '/api/gpu-tdr') {
          const TDR_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers'
          const readTdr = () => new Promise((resolve) => {
            let done = false
            const finish = (v) => { if (!done) { done = true; resolve(v) } }
            let c
            try { c = spawn('reg.exe', ['query', TDR_KEY, '/v', 'TdrDelay'], { windowsHide: true }) }
            catch (e) { return finish({ value: null }) }
            let out = ''
            c.stdout.on('data', (d) => { out += String(d) })
            c.on('error', () => finish({ value: null }))
            c.on('close', () => {
              const m = out.match(/TdrDelay\s+REG_DWORD\s+0x([0-9a-fA-F]+)/)
              finish({ value: m ? parseInt(m[1], 16) : null })
            })
          })
          const cur = await readTdr()
          if (req.method !== 'POST') {
            return json(res, 200, {
              ok: true,
              seconds: cur.value,            // null = 这个键不存在 = 走系统默认
              isDefault: cur.value === null,
              systemDefault: 2,
              key: TDR_KEY + '\\TdrDelay',
              message: cur.value === null
                ? '系统默认（2 秒）'
                : (cur.value + ' 秒' + (cur.value === 2 ? '' : '（改过）')),
            })
          }
          const body = await readBody(req)
          if (body.action !== 'reset') return json(res, 200, { ok: false, message: '不认识的动作：' + body.action })
          if (cur.value === null) {
            return json(res, 200, { ok: true, noop: true, seconds: null, isDefault: true, message: '已经是系统默认，不用动' })
          }
          const ps1 = join(COMFY_DIR, 'yanqing-tdr-reset.ps1')
          writeFileSync(ps1, [
            '$ErrorActionPreference = "Stop"',
            '$k = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers"',
            'Remove-ItemProperty -Path $k -Name "TdrDelay" -ErrorAction SilentlyContinue',
          ].join('\r\n') + '\r\n', 'utf8')
          try {
            const c = spawn('powershell.exe', ['-NoProfile', '-Command',
              "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','" + ps1 + "'"],
              { detached: true, stdio: 'ignore', windowsHide: true })
            c.unref()
          } catch (e) {
            return json(res, 200, { ok: false, message: '发起提权失败：' + String(e?.message || e) })
          }
          return json(res, 200, {
            ok: true, pending: true,
            message: '已弹出 UAC —— 点「是」，这一格会自己刷新',
          })
        }

        if (p === '/api/recent') {
          if (!existsSync(OUT_DIR)) return json(res, 200, { ok: true, files: [] })
          const files = readdirSync(OUT_DIR)
            .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
            .map((f) => ({ f, t: statSync(join(OUT_DIR, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t).slice(0, 24).map((x) => x.f)
          return json(res, 200, { ok: true, files })
        }

        return json(res, 404, { ok: false, message: '没有这个路由：' + p })
      } catch (err) {
        return json(res, 500, { ok: false, message: String(err?.message || err) })
      }
    },
  })
  ctx.effect(() => route, 'dsh-yanqing-line: routes')

  // Agent 也能启停 —— 这样我不用你点按钮
  ctx.tools.register({
    // ★★ 工具名必须和图腾老包（dsh-comfyui-panel 的 comfyui_control）区分开。
    //   2026-10-01 实测教训：两个包注册同一个工具名 → 冲突 → 整棵插件树加载失败
    //   （本文件上面那条 FIX 注释已经写过同样的症状：「plugin tree failed to load」），
    //   表现为宿主半路由 404、而包本身毫无问题 —— 我的假 ctx 探针跑得通，
    //   因为假 ctx 里没有另一个包先占掉这个名字。
    name: 'danfang',
    description: '控制本机 ComfyUI：start 拉起 / stop 停止 / status 看状态。' +
      '出图本身仍然走 generate_image(provider: comfyui) 或画廊工作台的面板。',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['start', 'stop', 'status'], description: '要做什么' } },
      required: ['action'],
    },
    // ★ FIX 2026-09-24 — dsh-tools 现在强制要求每个 tool 声明 output{schema,render}，
    //   原实现漏了 → 加载期抛 `tool "comfyui_control" must declare output {...}`
    //   → `plugin tree failed to load` → DSH 整体退出（3080 无监听）。
    //   schema 只允许子集：type/oneOf/properties/required/additionalProperties/items/enum/const。
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          running: { type: 'boolean' },
          already: { type: 'boolean' },
          message: { type: 'string' },
          stats: { type: 'object', additionalProperties: true },
          params: { type: 'object', additionalProperties: true },
        },
      },
      // ★ FIX 2026-09-24 第二处 —— 契约里 render 必须返回 ContentBlock[]，
      //   不是 string。返回 string 在注册期不报错（register 只校验 typeof === 'function'），
      //   但渲染工具结果时会坏。真实范例见 dsh-mnemon 的 render: () => [{ type:'text', text:'…' }]
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    // ★ FIX 2026-09-24 第三处 —— ToolDefinition 里跑工具的方法叫 execute，不叫 handler。
    //   写 handler 时 register() 照样通过（它不校验执行函数），但工具**永远调不动**。
    //   契约：execute(args: unknown, exec: ToolRunContext): Promise<unknown>
    execute: async ({ action }) => {
      if (action === 'start') return await startComfy()
      if (action === 'stop') return await stopComfy()
      const up = await comfyUp()
      // ★ FIX 2026-09-24 第四处 —— schema 把 `stats` 声明成 object，
      //   而 ComfyUI 没跑时这里返回 null → DSH 报
      //   `tool "comfyui_control" returned invalid output: "value.stats" must be an object`。
      //   注册期查不出（register 只看 schema 的形状、不看返回值），execute 跑通也查不出。
      //   用 `?? {}` 兜住：没跑时给空对象，语义是「没有统计信息」。
      return { ok: true, running: up, stats: (up ? await comfyStats() : null) ?? {}, params: loadParams() }
    },
  })
}
