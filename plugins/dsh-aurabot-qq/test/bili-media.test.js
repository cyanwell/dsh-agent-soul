// 用真实 ffmpeg + 本机 HTTP 视频夹具验证抽帧；不连接 B 站或模型。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { findFfmpeg, grabFrame } from '../src/bili/vision.js'

const ffmpeg = findFfmpeg()

test('真实 ffmpeg：HTTP seek 抽出 JPEG，带 B 站请求头，限制输出和等待时间', { skip: !ffmpeg, timeout: 20000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aurabot-media-'))
  const file = join(dir, 'fixture.mp4')
  const gen = spawnSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', '3', '-c:v', 'mpeg4', '-movflags', '+faststart', file], { windowsHide: true, timeout: 10000 })
  assert.equal(gen.status, 0, gen.stderr?.toString())
  const bytes = readFileSync(file)
  const requests = []
  const server = createServer((req, res) => {
    requests.push(req.headers)
    if (req.url === '/hang') return
    const start = Number(req.headers.range?.match(/bytes=(\d+)-/)?.[1] || 0)
    res.writeHead(req.headers.range ? 206 : 200, {
      'content-type': 'video/mp4', 'accept-ranges': 'bytes',
      'content-length': bytes.length - start,
      ...(req.headers.range ? { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` } : {}),
    })
    res.end(bytes.subarray(start))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}`
  const frame = await grabFrame(ffmpeg, url + '/video', 1)
  assert.ok(frame?.length > 500, '确实抽出 JPEG')
  assert.equal(frame.readUInt16BE(0), 0xffd8)
  assert.equal(frame.readUInt16BE(frame.length - 2), 0xffd9)
  assert.equal(requests[0].referer, 'https://www.bilibili.com/')
  assert.match(requests[0]['user-agent'], /Mozilla/)
  assert.equal(await grabFrame(ffmpeg, url + '/video', 1, { maxBytes: 100 }), null)
  const start = Date.now()
  assert.equal(await grabFrame(ffmpeg, url + '/hang', 1, { timeoutMs: 150 }), null)
  assert.ok(Date.now() - start < 3000, '超时结束子进程')
  assert.equal(await grabFrame(join(dir, 'missing-ffmpeg'), url, 1), null)
})
