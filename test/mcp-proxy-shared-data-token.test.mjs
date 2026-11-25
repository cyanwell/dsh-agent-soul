import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const proxyUrl = new URL('../src/adapters/mcp-proxy.mjs', import.meta.url)
const tokenDigest = (value) => createHash('sha256').update(value).digest('hex')

test('MCP proxy reads the configured dataDir token at each forward, including token created after module import', async () => {
  const home = mkdtempSync(join(tmpdir(), 'agent-soul-mcp-proxy-auth-'))
  const dataDir = join(home, 'shared-data')
  const staleSourceDir = join(home, 'source-data')
  mkdirSync(dataDir)
  mkdirSync(staleSourceDir)
  writeFileSync(join(home, 'config.json'), JSON.stringify({ dataDir: 'source-data' }))
  const originalHome = process.env.AGENT_SOUL_HOME
  const originalData = process.env.AGENT_SOUL_DATA
  const originalHub = process.env.SOUL_HUB_URL
  const received = []
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      received.push({ token: String(req.headers['x-soul-token'] || ''), body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } }))
    })
  })
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    process.env.AGENT_SOUL_HOME = home
    process.env.AGENT_SOUL_DATA = dataDir
    process.env.SOUL_HUB_URL = 'http://127.0.0.1:' + server.address().port
    const proxy = await import(proxyUrl.href + '?isolated=' + randomBytes(6).toString('hex'))

    const staleToken = 'synthetic-wrong-source-token-111111'
    const firstToken = 'synthetic-first-token-0123456789'
    writeFileSync(join(staleSourceDir, 'token.txt'), staleToken)
    writeFileSync(join(dataDir, 'token.txt'), firstToken)
    await proxy.forwardRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })
    assert.equal(received.length, 1)
    assert.equal(tokenDigest(received[0].token), tokenDigest(firstToken))

    const rotatedToken = 'synthetic-rotated-token-9876543210'
    writeFileSync(join(dataDir, 'token.txt'), rotatedToken)
    await proxy.forwardRpc({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} })
    assert.equal(received.length, 2)
    assert.equal(tokenDigest(received[1].token), tokenDigest(rotatedToken))
  } finally {
    await new Promise((resolve) => server.close(resolve))
    if (originalHome === undefined) delete process.env.AGENT_SOUL_HOME; else process.env.AGENT_SOUL_HOME = originalHome
    if (originalData === undefined) delete process.env.AGENT_SOUL_DATA; else process.env.AGENT_SOUL_DATA = originalData
    if (originalHub === undefined) delete process.env.SOUL_HUB_URL; else process.env.SOUL_HUB_URL = originalHub
    rmSync(home, { recursive: true, force: true })
  }
})
