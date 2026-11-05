// 抽帧 + 视觉（B 站「看画面」）的纯逻辑测试。不联网、不调 ffmpeg。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { frameTimes, pickVideoStream, findFfmpeg, visionState, lookWithVision, describeFrames, progressiveWindows, windowAt } from '../src/bili/vision.js'
import { digestOf } from '../src/bili/duty.js'

test('frameTimes：跳过首尾 5%，均匀铺开，不重复', () => {
  const t = frameTimes(600, 6)
  assert.equal(t.length, 6)
  assert.deepEqual(t, [...t].sort((a, b) => a - b), '按时间升序')
  assert.equal(t[0], 30, '第一帧在 5%')
  assert.equal(t.at(-1), 570, '最后一帧在 95%')
  assert.equal(new Set(t).size, t.length, '没有重复')
})

test('frameTimes：片长为 0 时不给点；至少给一帧', () => {
  assert.deepEqual(frameTimes(0, 6), [])
  assert.deepEqual(frameTimes(-5, 6), [])
  assert.equal(frameTimes(1, 6).length, 1, '1 秒的片子聚成一个点后去重')
  assert.equal(frameTimes(2, 1).length, 1, '只要一帧就取中间')
})

test('frameTimes：帧数被夹在 1~12', () => {
  assert.equal(frameTimes(3600, 100).length, 12)
  assert.equal(frameTimes(3600, 0).length, 6, '给 0 用默认 6 帧')
})

test('pickVideoStream：优先 H.264、不低于 480、取带宽最低的那路', () => {
  const list = [
    { width: 1920, height: 1080, codecs: 'avc1.640028', bandwidth: 3_000_000, baseUrl: 'a' },
    { width: 852, height: 480, codecs: 'avc1.640033', bandwidth: 800_000, baseUrl: 'b' },
    { width: 640, height: 360, codecs: 'avc1.640033', bandwidth: 400_000, baseUrl: 'c' },
    { width: 1280, height: 720, codecs: 'hvc1.1.6.L120.90', bandwidth: 500_000, baseUrl: 'd' },
  ]
  assert.equal(pickVideoStream(list).baseUrl, 'b', '720p 的 HEVC 带宽更低但优先 H.264 + ≥480')
  assert.equal(pickVideoStream([{ width: 1920, codecs: 'hvc1', bandwidth: 9, baseUrl: 'only' }]).baseUrl, 'only', '没有 H.264 就退回任意一路')
  assert.equal(pickVideoStream([]), null)
  assert.equal(pickVideoStream([{ width: 640 }]), null, '没有 baseUrl 的跳过')
})

test('findFfmpeg：配置的路径优先，都找不到返回空串', () => {
  assert.equal(findFfmpeg('', { pathEnv: '', exists: () => false }), '')
  const fake = join('C:\\tools', 'ffmpeg.exe')
  assert.equal(findFfmpeg(fake, { exists: (p) => p === fake }), fake, '配置里填的直接用')
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const dir = process.platform === 'win32' ? 'D:\\bin' : '/opt/bin'
  const inPath = join(dir, exe)
  assert.equal(findFfmpeg('', { pathEnv: dir, exists: (p) => p === inPath }), inPath, '从 PATH 里找')
})

test('visionState：开关和 ffmpeg 都就绪才算 ready', () => {
  assert.equal(visionState({}).enabled, false, '默认没开')
  assert.equal(visionState({ vision: false, ffmpegPath: '' }).ready, false, '开关关着就不 ready')
  const st = visionState({ vision: true, ffmpegPath: '' })
  assert.equal(st.enabled, true)
  assert.equal(st.ready, Boolean(st.ffmpeg), 'ready 只取决于本机有没有 ffmpeg')
  assert.equal(visionState({ vision: true, ffmpegPath: 'C:\\definitely\\not\\here\\ffmpeg.exe' }).ready, Boolean(st.ffmpeg), '填了不存在的路径就当没填')
})

test('digestOf：开了画面就写进 digest，没字幕时不再说"只能看标题"', () => {
  const v = { title: '一碗米饭', author: '小井', play: 699462, bvid: 'BV1QWbw6iEXE' }

  const noVision = digestOf(v, {})
  assert.match(noVision, /没有字幕，只能看标题、简介和评论/)

  const withVision = digestOf(v, { vision: '画面里是两只手举着炸好的鸡翅。' })
  assert.match(withVision, /画面（抽帧）：画面里是两只手举着炸好的鸡翅。/)
  assert.match(withVision, /没有字幕，只看了画面/, '有画面就别再说只能看标题')
  assert.ok(!withVision.includes('只能看标题、简介和评论'))

  const both = digestOf(v, { subtitle: '第一种烤肠芝士饭团', vision: '一口锅里在煮米饭。' })
  assert.match(both, /字幕（节选）：第一种烤肠芝士饭团/)
  assert.match(both, /画面（抽帧）：一口锅里在煮米饭。/)
  assert.ok(both.indexOf('字幕（节选）') < both.indexOf('画面（抽帧）'), '字幕在前、画面在后')
})

test('digestOf：画面描述过长时截断，别把上下文撑爆', () => {
  const v = { title: 'T', author: 'A', bvid: 'BV1' }
  const long = '啊'.repeat(2000)
  const d = digestOf(v, { vision: long })
  assert.ok(d.includes('画面（抽帧）：'), '有画面这一行')
  assert.ok(d.length < 1200, '总长度被压住了，实际 ' + d.length)
})

function pipeline(over = {}) {
  const calls = []
  const cfg = { model: {}, bili: { vision: true, visionFrames: 12 } }
  const args = {
    dsh: {}, info: { bvid: 'BV1aaaaaaaaa', cid: 9, duration: 600, title: '测试视频' },
    getConfig: () => cfg, log: { debug() {} },
    api: { playurl: async () => { calls.push('playurl'); return { video: [{ baseUrl: 'https://video.example/a.m4s' }] } } },
    deps: {
      findFfmpeg: () => 'ffmpeg', canSeeImages: async () => true,
      assertPublicUrl: async () => { calls.push('validate') },
      grabFrame: async (_exe, _url, sec) => { calls.push(sec); return Buffer.from('frame') },
      describeFrames: async (_dsh, { frames }) => { calls.push(['describe', frames.length]); return '画面里有一只猫。' },
      ...over,
    },
  }
  return { args, calls, cfg }
}

test('看画面：完整流程支持 12 帧，先校验地址再抽帧', async () => {
  const { args, calls } = pipeline()
  const r = await lookWithVision(args)
  assert.equal(r.frames.length, 12)
  assert.match(r.text, /猫/)
  assert.deepEqual(calls.slice(0, 2), ['playurl', 'validate'])
  assert.deepEqual(calls.at(-1), ['describe', 12])
})

test('看画面：开关关闭、没 cid、没 ffmpeg、模型不支持时不取流', async () => {
  for (const reason of ['off', 'cid', 'ffmpeg', 'model']) {
    const { args, calls, cfg } = pipeline()
    if (reason === 'off') cfg.bili.vision = false
    if (reason === 'cid') args.info.cid = 0
    if (reason === 'ffmpeg') args.deps.findFfmpeg = () => ''
    if (reason === 'model') args.deps.canSeeImages = async () => false
    assert.deepEqual(await lookWithVision(args), { text: '', frames: [] }, reason)
    assert.deepEqual(calls, [], reason)
  }
})

test('看画面：取流失败、空流、非法地址、抽不到帧时降级', async () => {
  for (const reason of ['api', 'stream', 'url', 'frame']) {
    const { args, calls } = pipeline()
    if (reason === 'api') args.api.playurl = async () => { throw new Error('412') }
    if (reason === 'stream') args.api.playurl = async () => ({ video: [] })
    if (reason === 'url') args.deps.assertPublicUrl = async () => { throw new Error('内网地址') }
    if (reason === 'frame') args.deps.grabFrame = async () => null
    assert.deepEqual(await lookWithVision(args), { text: '', frames: [] }, reason)
    assert.ok(!calls.some(Array.isArray), '不调用视觉模型')
  }
})

test('看画面：视觉报错或空输出时保留真实截图，不编造画面描述', async () => {
  for (const describe of [async () => { throw new Error('model failed') }, async () => '  ']) {
    const { args } = pipeline({ describeFrames: describe })
    const r = await lookWithVision(args)
    assert.equal(r.text, '')
    assert.equal(r.frames.length, 12)
    assert.match(digestOf(args.info, { vision: r.text }), /只能看标题、简介和评论/)
  }
})

test('看画面：真实地址检查拒绝本机和 file 协议，未知视觉能力仍可尝试', async () => {
  for (const url of ['http://127.0.0.1/a', 'file:///etc/passwd']) {
    const { args, calls } = pipeline({ canSeeImages: async () => null })
    delete args.deps.assertPublicUrl
    args.api.playurl = async () => ({ video: [{ baseUrl: url }] })
    assert.deepEqual(await lookWithVision(args), { text: '', frames: [] })
    assert.deepEqual(calls, [])
  }
  const { args } = pipeline({ canSeeImages: async () => null })
  assert.ok((await lookWithVision(args)).text)
  assert.deepEqual(frameTimes(Infinity, 6), [])
})

test('progressiveWindows / windowAt：durl 分段按 length 拼成全片，选段和段内时间', () => {
  const ws = progressiveWindows([
    { url: 'https://cdn/1.mp4', length: 60_000 },
    { url: 'https://cdn/2.mp4', length: 30_000 },
    { url: 'https://cdn/3.mp4', length: 0 },
  ])
  assert.deepEqual(ws.map((w) => [w.url, w.startMs, w.endMs]), [
    ['https://cdn/1.mp4', 0, 60_000],
    ['https://cdn/2.mp4', 60_000, 90_000],
    ['https://cdn/3.mp4', 90_000, Infinity],
  ])
  assert.equal(windowAt(ws, 10).url, 'https://cdn/1.mp4')
  assert.equal(windowAt(ws, 60).url, 'https://cdn/2.mp4')
  assert.equal(windowAt(ws, 120).url, 'https://cdn/3.mp4')
  assert.equal(windowAt([], 5), null)
  assert.deepEqual(progressiveWindows([]), [])
})

test('看画面：durl 只覆盖前面一段时，时间点收在这段里', async () => {
  const calls = []
  const { args } = pipeline({
    assertPublicUrl: async () => {},
    grabFrame: async (_exe, url, at) => { calls.push({ url, at }); return Buffer.from('frame') },
  })
  args.api.playurl = async () => ({ video: [], durl: [{ url: 'https://cdn.example/only.mp4', length: 60_000 }] })
  args.info.duration = 600 // 接口说 10 分钟，但 durl 只有前 60 秒
  const r = await lookWithVision(args)
  assert.equal(r.frames.length, 12)
  assert.ok(calls.every((c) => c.url === 'https://cdn.example/only.mp4' && c.at <= 60), '抽帧时间点都落在已覆盖的 60 秒内')
  assert.ok(calls.some((c) => c.at >= 50), '铺到这段的末尾附近')
})

test('看画面：只有 durl（渐进式 MP4）时也能抽帧，按段定位', async () => {
  const calls = []
  const { args } = pipeline({
    assertPublicUrl: async () => {},
    grabFrame: async (_exe, url, at) => { calls.push({ url, at }); return Buffer.from('frame') },
  })
  args.api.playurl = async () => ({
    video: [],
    durl: [
      { url: 'https://cdn.example/part1.mp4', length: 120_000 },
      { url: 'https://cdn.example/part2.mp4', length: 300_000 },
    ],
  })
  args.info.duration = 400
  const r = await lookWithVision(args)
  assert.equal(r.frames.length, 12)
  assert.ok(calls.some((c) => c.url === 'https://cdn.example/part1.mp4'), '第一段被用到')
  assert.ok(calls.some((c) => c.url === 'https://cdn.example/part2.mp4'), '第二段被用到')
  const part2 = calls.find((c) => c.url.endsWith('part2.mp4'))
  assert.ok(part2 && part2.at < 300, '第二段用段内相对时间（实际 ' + part2.at + '）')
  assert.match(r.text, /猫/)
})

test('视觉描述：图片经附件服务登记后送入配置模型', async () => {
  let admitted, request
  const dsh = {
    get: () => null,
    attachments: { admitPromptContent: async (content) => {
      admitted = content
      return [{ type: 'text', text: '已登记图片' }, { type: 'attachment', id: 'shot1' }]
    } },
    llm: { stream: async function * (params) { request = params; yield { type: 'text-delta', text: '桌上有一碗饭。' } } },
  }
  const text = await describeFrames(dsh, { info: { title: '做饭', duration: 60 }, frames: [Buffer.from('jpeg')], cfg: { model: { provider: 'test', model: 'vision' } } })
  assert.match(text, /饭/)
  assert.equal(admitted[1].type, 'image')
  assert.equal(admitted[1].mediaType, 'image/jpeg')
  assert.equal(admitted[1].data, Buffer.from('jpeg').toString('base64'))
  assert.equal(request.model, 'vision')
  assert.equal(request.messages[0].content[1].type, 'attachment')
})
