import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { loadConfig, mergeFromPanel, saveConfig } from '../src/aurabot/src/core/config.js'

test('Aurabot panel settings merge, persist and read back in a temporary data directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aurabot-config-roundtrip-'))
  const prior = process.env.AURABOT_DATA_DIR
  try {
    process.env.AURABOT_DATA_DIR = dir
    const before = loadConfig()
    const next = mergeFromPanel(before, { mood: { judge: true }, stickers: { caption: false }, merge: { waitSec: 4 } })
    saveConfig(next)
    const after = loadConfig()
    assert.equal(after.mood.judge, true)
    assert.equal(after.stickers.caption, false)
    assert.equal(after.merge.waitSec, 4)
    assert.equal(fs.existsSync(path.join(dir, 'config.json')), true)
  } finally {
    if (prior === undefined) delete process.env.AURABOT_DATA_DIR
    else process.env.AURABOT_DATA_DIR = prior
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
