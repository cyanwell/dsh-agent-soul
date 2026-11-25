import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../build/Shell.cs', import.meta.url), 'utf8')
const start = source.match(/bool StartCore\(\)[\s\S]*?\n    \}/)

test('production Shell disables the embedded Aurabot OneBot listener before starting Core', () => {
  assert.ok(start, 'StartCore must exist')
  const guard = start[0].indexOf('psi.EnvironmentVariables["AURABOT_NO_CONNECT"] = "1";')
  const launch = start[0].indexOf('Process.Start(psi)')
  assert.notEqual(guard, -1, 'Core must inherit AURABOT_NO_CONNECT=1')
  assert.notEqual(launch, -1, 'StartCore must launch the Core process')
  assert.ok(guard < launch, 'the single-ingress guard must be set before Process.Start')
})
