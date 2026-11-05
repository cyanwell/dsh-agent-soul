// 生图的「自定义接口」：GET/POST、URL 模板占位、自定义参数名、两种返回形态。
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { customRequest, createImageGen } = await import('../src/features/imagegen.js')

const PNG = (() => {
  const b = Buffer.alloc(64)
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47; b[7] = 0x0a
  b.writeUInt32BE(512, 16)
  b.writeUInt32BE(512, 20)
  return b
})()

const baseGen = (custom, extra = {}) => ({
  enabled: true,
  provider: 'custom',
  apiKey: '',
  model: '',
  size: '1080x1920',
  stylePrompt: '',
  custom,
  ...extra,
})

const log = { info () {}, warn () {}, debug () {} }

test('GET：提示词进地址，自定义参数名拼在后面（pollinations 那种）', () => {
  const req = customRequest(baseGen({
    method: 'GET',
    url: 'https://image.pollinations.ai/prompt/{prompt}',
    params: [
      { key: 'model', value: 'flux-anime' },
      { key: 'width', value: '1080' },
      { key: 'height', value: '1920' },
      { key: 'seed', value: '42' },
      { key: 'nologo', value: 'true' },
    ],
  }), '一只白鲸')
  assert.equal(req.method, 'GET')
  assert.equal(req.body, undefined)
  assert.ok(req.url.startsWith('https://image.pollinations.ai/prompt/'), '提示词在路径里')
  assert.ok(req.url.includes(encodeURIComponent('一只白鲸')), '中文提示词要编码')
  assert.ok(req.url.includes('?model=flux-anime&width=1080&height=1920&seed=42&nologo=true'), req.url)
})

test('地址里已经有问号时用 & 续接；{width}/{height} 从尺寸推出来', () => {
  const req = customRequest(baseGen({
    method: 'GET',
    url: 'https://x.test/gen?token=abc&w={width}&h={height}',
    params: [{ key: 'style', value: 'anime' }],
  }), '猫')
  assert.ok(req.url.startsWith('https://x.test/gen?token=abc&w=1080&h=1920&style=anime'), req.url)
})

test('POST JSON：参数进请求体，值里的 {prompt} 是原文', () => {
  const req = customRequest(baseGen({
    method: 'POST',
    url: 'https://x.test/v1/gen',
    bodyType: 'json',
    params: [{ key: 'prompt', value: '{prompt}' }, { key: 'size', value: '{size}' }],
  }), '一只猫')
  assert.equal(req.method, 'POST')
  assert.equal(req.url, 'https://x.test/v1/gen', 'POST 不往地址上拼参数')
  assert.equal(req.headers['content-type'], 'application/json')
  const body = JSON.parse(req.body)
  assert.deepEqual(body, { prompt: '一只猫', size: '1080x1920' })
})

test('POST 表单：同一套参数变成 urlencoded', () => {
  const req = customRequest(baseGen({
    method: 'POST',
    url: 'https://x.test/gen',
    bodyType: 'form',
    params: [{ key: 'text', value: '{prompt}' }],
  }), '一只猫')
  assert.equal(req.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(req.body, `text=${encodeURIComponent('一只猫')}`)
})

test('填了 API Key 就带 Authorization', () => {
  const req = customRequest(baseGen({ method: 'GET', url: 'https://x.test/{prompt}', params: [] }, { apiKey: 'sk-123' }), '猫')
  assert.equal(req.headers.authorization, 'Bearer sk-123')
})

test('接口直接回图片字节：照原样收下', async () => {
  const calls = []
  const orig = globalThis.fetch
  globalThis.fetch = async (url, opt) => {
    calls.push({ url, method: opt?.method })
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG }
  }
  try {
    const gen = createImageGen({ getConfig: () => ({ imageGen: baseGen({ method: 'GET', url: 'https://x.test/p/{prompt}', params: [{ key: 'model', value: 'flux' }] }) }), log, local: null })
    const buf = await gen.generate('一只白鲸')
    assert.equal(buf.length, PNG.length)
    assert.equal(buf[0], 0x89)
    assert.ok(calls[0].url.includes('model=flux'))
    assert.equal(calls[0].method, 'GET')
  } finally { globalThis.fetch = orig }
})

test('接口回 JSON：按取值路径拿到 base64 图片', async () => {
  const orig = globalThis.fetch
  const dataUri = 'data:image/png;base64,' + PNG.toString('base64')
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ output: { images: [{ b64: dataUri }] } }) })
  try {
    const gen = createImageGen({ getConfig: () => ({ imageGen: baseGen({ method: 'POST', url: 'https://x.test/gen', bodyType: 'json', params: [{ key: 'prompt', value: '{prompt}' }], responsePath: 'output.images.0.b64' }) }), log, local: null })
    const buf = await gen.generate('一只猫')
    assert.equal(buf.length, PNG.length)
    assert.equal(buf[1], 0x50)
  } finally { globalThis.fetch = orig }
})

test('没配取值路径时也能自动在 JSON 里找到图片', async () => {
  const orig = globalThis.fetch
  const dataUri = 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]).toString('base64')
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ result: { items: [{ image: dataUri }] } }) })
  try {
    const gen = createImageGen({ getConfig: () => ({ imageGen: baseGen({ method: 'GET', url: 'https://x.test/{prompt}', params: [] }) }), log, local: null })
    const buf = await gen.generate('猫')
    assert.equal(buf[0], 0xff)
    assert.equal(buf[1], 0xd8)
  } finally { globalThis.fetch = orig }
})

test('接口回了别的东西：报错而不是发一张坏图', async () => {
  const orig = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ message: 'ok but no image' }) })
  try {
    const gen = createImageGen({ getConfig: () => ({ imageGen: baseGen({ method: 'GET', url: 'https://x.test/{prompt}', params: [] }) }), log, local: null })
    await assert.rejects(() => gen.generate('猫'), /没有返回图片/)
  } finally { globalThis.fetch = orig }
})

test('enabled()：自定义模式看地址有没有填', () => {
  const cfg = (custom) => ({ imageGen: { enabled: true, provider: 'custom', custom } })
  const gen = (custom) => createImageGen({ getConfig: () => cfg(custom), log, local: null })
  assert.equal(gen({ url: 'https://x.test/{prompt}' }).enabled(), true)
  assert.equal(gen({ url: '' }).enabled(), false, '没填地址就当没开')
  assert.equal(gen({}).enabled(), false)
  // 关掉总开关时不管填没填都不行
  const off = createImageGen({ getConfig: () => ({ imageGen: { enabled: false, provider: 'custom', custom: { url: 'https://x.test/{prompt}' } } }), log, local: null })
  assert.equal(off.enabled(), false)
})
