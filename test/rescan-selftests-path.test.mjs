import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

test('rescan-selftests resolves the checkout log directory even when cwd is elsewhere', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const script = path.join(repoRoot, 'tools', 'rescan-selftests.mjs')
  assert.equal(fs.existsSync(path.join(repoRoot, '_selftest_logs')), true)
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'rescan-selftests-cwd-'))
  try {
    const result = spawnSync(process.execPath, [script], { cwd: elsewhere, encoding: 'utf8', timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /日志总数=/)
  } finally {
    fs.rmSync(elsewhere, { recursive: true, force: true })
  }
})
