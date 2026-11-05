// 本地接口：模板、开关、脚本改完立即生效、出错记录、生图返回值统一、翻唱报错翻译。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let L
let cfg
let normalize
const logs = []
const log = { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), debug() {} }

before(async () => {
  process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-local-'))
  L = await import('../src/local/local.js')
  ;({ normalize } = await import('../src/core/config.js'))
  cfg = normalize({})
})

test('默认都关着；生成模板（带说明，不覆盖已有的）', () => {
  assert.deepEqual(cfg.local, { tts: false, image: false, song: false, asr: false })
  const local = L.createLocal({ getConfig: () => cfg, log })
  assert.equal(local.active('tts'), false)
  const r = local.template('tts')
  assert.equal(r.created, true)
  assert.ok(existsSync(join(local.dir(), 'README-本地接口.md')))
  assert.match(readFileSync(r.path, 'utf8'), /export default async function tts/)
  writeFileSync(r.path, '// 我改过的')
  assert.equal(local.template('tts').created, false, '已有的不覆盖')
  assert.equal(readFileSync(r.path, 'utf8'), '// 我改过的')
  assert.equal(local.active('tts'), false, '开关没开不接管')
  const st = local.status().find((x) => x.slot === 'tts')
  assert.equal(st.exists, true)
  assert.match(st.prompt, /README-本地接口\.md/)
  assert.match(st.prompt, /只改这一个脚本/)
})

test('开关打开就接管；脚本改完不用重启；出错有记录', async () => {
  const local = L.createLocal({ getConfig: () => cfg, log })
  cfg.local.tts = true
  writeFileSync(local.pathOf('tts'), 'export default async ({ text, outDir }) => ({ file: outDir + "/a-" + text + ".wav" })')
  assert.equal(local.active('tts'), true)
  assert.match(L.fileOf(await local.call('tts', { text: '一' })), /a-一\.wav$/)
  // 改脚本（修改时间变了）立刻用新的
  await new Promise((r) => setTimeout(r, 30))
  writeFileSync(local.pathOf('tts'), 'export default async () => { throw new Error("服务没开") }')
  await assert.rejects(local.call('tts', { text: '二' }), /服务没开/)
  const st = local.status().find((x) => x.slot === 'tts')
  assert.equal(st.last.ok, false)
  assert.match(st.last.message, /服务没开/)
  await new Promise((r) => setTimeout(r, 30))
  writeFileSync(local.pathOf('tts'), 'export const nothing = 1')
  await assert.rejects(local.call('tts', { text: '三' }), /export default/)
  cfg.local.tts = false
})

test('生图：脚本返回 Buffer / base64 / 文件都认；接管后不需要在线生图服务', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  assert.deepEqual(await L.toImageBuffer(png), png)
  assert.deepEqual(await L.toImageBuffer({ base64: 'data:image/png;base64,' + png.toString('base64') }), png)
  const f = join(tmpdir(), 'aurabot-local-img.png')
  writeFileSync(f, png)
  assert.deepEqual(await L.toImageBuffer({ file: f }), png)
  await assert.rejects(L.toImageBuffer({}), /没返回图片/)
  const local = L.createLocal({ getConfig: () => cfg, log })
  local.template('image')
  writeFileSync(local.pathOf('image'), `export default async ({ prompt, size }) => ({ base64: Buffer.from(prompt + '|' + size).toString('base64') })`)
  const { createImageGen } = await import('../src/features/imagegen.js')
  const gen = createImageGen({ getConfig: () => cfg, log, local })
  assert.equal(gen.enabled(), false)
  cfg.local.image = true
  assert.equal(gen.enabled(), true, '没填在线服务也能画')
  cfg.imageGen.stylePrompt = '水彩'
  assert.equal(String(await gen.generate('小鱼')), '水彩，小鱼|' + cfg.imageGen.size)
  cfg.local.image = false
})

test('翻唱报错翻译成人话；本地换声接管时不需要内置音色', async () => {
  const studio = await import('../src/song/studio.js')
  assert.match(studio.explainSongError('RuntimeError: Error(s) in loading state_dict for Synthesizer: size mismatch for enc_p'), /不兼容/)
  assert.match(studio.explainSongError('torch.OutOfMemoryError: CUDA out of memory'), /显存/)
  assert.equal(studio.explainSongError('网易云上没搜到「x」'), '网易云上没搜到「x」')
  const denied = studio.explainSongError("RuntimeError: Failed to instantiate Roformer model: [Errno 13] Permission denied: 'E:\\\\Aurabot\\\\rvc\\\\separator-models\\\\model_bs_roformer_ep_317_sdr_12.9755.ckpt'.")
  assert.ok(denied.includes('读不了「E:\\Aurabot\\rvc\\separator-models\\model_bs_roformer'), denied)
  assert.match(denied, /杀毒/)
})

test('模型文件能读就放行，不存在的跳过', async () => {
  const studio = await import('../src/song/studio.js')
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const d = mkdtempSync(join(tmpdir(), 'ab-read-'))
  writeFileSync(join(d, 'a.ckpt'), 'x'.repeat(32))
  await studio.ensureReadable([join(d, 'a.ckpt'), join(d, 'missing.ckpt')], 1, 1)
})
