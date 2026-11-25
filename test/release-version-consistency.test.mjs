import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const readme = readFileSync(resolve(root, 'README.md'), 'utf8')
const notes = readFileSync(resolve(root, `release-notes-${pkg.version}.md`), 'utf8')

test('package, README downloads and release notes use one version', () => {
  const version = pkg.version
  assert.match(readme, new RegExp(`### ${version} v4 hotfix`))
  assert.match(readme, new RegExp(`AgentSoul-Setup-${version}\\.exe`))
  assert.match(readme, new RegExp(`AgentSoul-${version}-portable\\.zip`))
  assert.match(readme, new RegExp(`AgentSoul-${version}-htmlpatch\\.zip`))
  assert.match(notes, new RegExp(`AgentSoul v4 ${version}`))
})
