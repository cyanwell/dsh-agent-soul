import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const client = fs.readFileSync(new URL('../src/aurabot/client/client.js', import.meta.url), 'utf8')

test('embedded Aurabot UI labels Core ingress ownership instead of a local connection failure', () => {
  assert.ok(client.includes("const ingressOwns = st.onebot.owner === 'core-events-ingress'"))
  assert.ok(client.includes('由AgentSoul v4 events ingress接管'))
  assert.ok(client.includes('接收连接由AgentSoul v4 events ingress管理；此处不单独测试或重连。'))
  assert.ok(client.includes("!ingressOwns && !conn && st.onebot.problem"))
  assert.ok(client.includes("!ingressOwns ? h('div', { className: 'ab-flex'"))
})
