import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const html = fs.readFileSync(new URL('../src/web/echo.html', import.meta.url), 'utf8')

test('echo UI renders API unconfigured state explicitly instead of undefined or zero checks', () => {
  assert.ok(html.includes('d.unconfigured === true'))
  assert.ok(html.includes("d.overall === 'unconfigured'"))
  assert.ok(html.includes("var summary = unconfigured ? '未配置'"))
  assert.ok(html.includes("d.why || '未配置 ECHO_DOCTOR_PATH"))
  assert.ok(!html.includes('textContent = d.mode +'))
})
