import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { runLedger } from '../src/adapters/mcp-tools.mjs'
import { needsAuth } from '../src/web/auth.mjs'
import { injectPage } from '../src/web/server.mjs'

test('soul_ledger stats reads the explicitly configured ledger without ReferenceError', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-ledger-stats-'))
  const file = path.join(dir, '02-墨.jsonl')
  fs.writeFileSync(file, '')
  try {
    const result = await runLedger({ action: 'stats' }, { ledger: { file } })
    assert.match(result, /共 0 条/)
    assert.ok(result.includes(file))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('injectPage injects when HTML merely reads the token global and stays idempotent for assignment', () => {
  const page = '<html><head></head><body><script>if (window.__SOUL_TOKEN) boot()</script></body></html>'
  const snippet = '<script>window.__SOUL_TOKEN="placeholder";</script>'
  const injected = injectPage(page, snippet)
  assert.ok(injected.includes(snippet))
  const already = '<html><head><script>window.__SOUL_TOKEN="placeholder";</script></head><body></body></html>'
  assert.equal(injectPage(already), already)
})

test('waker read stays public while decision mutation requires authentication', () => {
  assert.equal(needsAuth('/api/waker', 'GET'), false)
  assert.equal(needsAuth('/api/waker/summary', 'GET'), false)
  assert.equal(needsAuth('/api/waker/decide', 'POST'), true)
})

test('settings and echo inline UI scripts parse after error-state fixes', () => {
  for (const name of ['settings.html', 'echo.html']) {
    const html = fs.readFileSync(new URL('../src/web/' + name, import.meta.url), 'utf8')
    const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).filter((x) => x.trim())
    assert.ok(scripts.length > 0, name + ' has inline script')
    for (const script of scripts) assert.doesNotThrow(() => new vm.Script(script, { filename: name }), name)
  }
})
