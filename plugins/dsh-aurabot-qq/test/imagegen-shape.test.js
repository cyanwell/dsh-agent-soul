import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SHAPE_SIZE, imageSizeFor } from '../src/features/image-shape.js'
import { createImageGen } from '../src/features/imagegen.js'
import { normalize } from '../src/core/config.js'
import imagegenModule from '../src/modules/imagegen/index.js'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-shape-'))
const log = { info() {}, debug() {}, warn() {} }
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const config = (extra = {}) => normalize({ imageGen: { enabled: true, baseUrl: 'https://image.example/v1', model: 'image-test', size: '768x1024', ...extra } })

test('构图默认兼容旧配置，非法默认值归一化；不改写原来的 size', () => {
  for (const shape of [undefined, 'unknown', 'toString']) {
    const c = config({ shape })
    assert.equal(c.imageGen.shape, 'her')
    assert.equal(c.imageGen.size, '768x1024')
  }
  assert.equal(imageSizeFor(undefined, config().imageGen), '768x1024')
})

test('本次指定优先于面板默认，未指定 / 非法值使用面板默认', () => {
  const c = config({ shape: 'wide' }).imageGen
  assert.equal(imageSizeFor('portrait', c), '1024x1536')
  for (const shape of [undefined, '', 'unknown', 'toString']) assert.equal(imageSizeFor(shape, c), '1536x864')
})

test('OpenAI 兼容接法发送实际尺寸；不传构图保持旧请求和配置', async (t) => {
  const seen = [], c = config()
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  const gen = createImageGen({ getConfig: () => c, log })
  for (const [shape, size] of Object.entries(SHAPE_SIZE)) {
    assert.deepEqual(await gen.generate('猫', { shape }), PNG)
    assert.equal(seen.at(-1).size, size)
    assert.equal(seen.at(-1).image_size, size)
    assert.equal(seen.at(-1).prompt, '猫')
  }
  await gen.generate('猫')
  assert.equal(seen.at(-1).size, '768x1024')
  assert.equal(c.imageGen.size, '768x1024')
})

test('自定义 GET 的地址和参数占位符随本次构图变化', async (t) => {
  const urls = [], c = config({ provider: 'custom', custom: { method: 'GET', url: 'https://image.example/{width}/{height}', params: [{ key: 'size', value: '{size}' }] } })
  t.mock.method(globalThis, 'fetch', async (url) => { urls.push(new URL(url)); return new Response(PNG, { headers: { 'content-type': 'image/png' } }) })
  await createImageGen({ getConfig: () => c, log }).generate('猫', { shape: 'wide' })
  assert.equal(urls[0].pathname, '/1536/864')
  assert.equal(urls[0].searchParams.get('size'), '1536x864')
})

test('自定义 POST JSON / 表单的尺寸占位符生效，固定参数保持原值', async (t) => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => { bodies.push(init); return new Response(PNG, { headers: { 'content-type': 'image/png' } }) })
  for (const bodyType of ['json', 'form']) {
    const c = config({ provider: 'custom', custom: { method: 'POST', url: 'https://image.example', bodyType, params: [{ key: 'size', value: '{size}' }, { key: 'width', value: '{width}' }, { key: 'height', value: '{height}' }, { key: 'fixed', value: '512' }] } })
    await createImageGen({ getConfig: () => c, log }).generate('猫', { shape: 'portrait' })
    const body = bodyType === 'json' ? JSON.parse(bodies.at(-1).body) : Object.fromEntries(new URLSearchParams(bodies.at(-1).body))
    assert.deepEqual(body, { size: '1024x1536', width: '1024', height: '1536', fixed: '512' })
  }
})

test('本地接口同样收到所选尺寸，默认行为和提示词保持兼容', async () => {
  const seen = [], c = config({ stylePrompt: '水彩' })
  const local = { active: () => true, call: async (_kind, args) => { seen.push(args); return PNG } }
  const gen = createImageGen({ getConfig: () => c, log, local })
  await gen.generate('猫', { shape: 'landscape' })
  await gen.generate('猫')
  assert.deepEqual(seen, [{ prompt: '水彩，猫', size: '1536x1024' }, { prompt: '水彩，猫', size: '768x1024' }])
})

test('服务拒绝尺寸时透传错误，不静默重试成另一种构图', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ error: { message: 'unsupported size 1536x864' } }), { status: 400 }) })
  await assert.rejects(createImageGen({ getConfig: () => config(), log }).generate('猫', { shape: 'wide' }), /unsupported size 1536x864/)
  assert.equal(calls, 1)
})

test('qq_draw_image 的构图可选，传到生成器；原主人权限在取图前复查', async () => {
  let build, owner = true
  const seen = [], c = config()
  imagegenModule.setup({
    config: () => c, log, dsh: {}, lazy: () => ({}), route() {}, tool: (fn) => { build = fn },
    core: { local: { active: () => true, call: async (_kind, args) => { seen.push(args); return PNG } },
      hub: { turnSendersAllOwner: () => owner, sendSegments: async () => ({ message_id: 1 }), canSeeImages: async () => false } },
  })
  const tool = build({ chat: { kind: 'private', chatId: 'private:10001', userId: '10001' }, sessionId: 'shape-test' })
  assert.ok(!tool.parameters.required.includes('shape'))
  assert.deepEqual(tool.parameters.properties.shape.enum, ['square', 'portrait', 'landscape', 'wide'])
  assert.equal((await tool.execute({ prompt: '猫', shape: 'portrait' })).ok, true)
  assert.equal(seen[0].size, '1024x1536')
  owner = false
  assert.equal((await tool.execute({ prompt: '猫', shape: 'wide' })).ok, false)
  assert.equal(seen.length, 1)
})
