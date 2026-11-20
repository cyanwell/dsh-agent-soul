import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnAgentSoul, makeAgentSoulLifecycle } from '../index.js'

async function fakeExecutable(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'bridge-spawn-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, 'build'))
  await writeFile(path.join(root, 'build', 'AgentSoul.exe'), '')
  return root
}

test('spawnAgentSoul injects a fresh marker only into child environment', async (t) => {
  const root = await fakeExecutable(t)
  const captures = []
  for (const pid of [43101, 43102]) {
    const result = spawnAgentSoul({ agentSoulRoot: root }, {
      spawn(exe, args, options) {
        captures.push({ exe, args, options })
        return { pid, unref() {} }
      },
    })
    assert.deepEqual({ ok: result.ok, pid: result.pid }, { ok: true, pid })
    const env = captures.at(-1).options.env
    assert.match(env.AGENT_SOUL_MANAGER_MARKER, /^[A-Za-z0-9_-]{32,128}$/)
    assert.equal(Object.hasOwn(env, 'AGENT_SOUL_MANAGER_SHELL_PID'), false)
    assert.notEqual(env.AGENT_SOUL_MANAGER_MARKER, process.env.AGENT_SOUL_MANAGER_MARKER)
  }
  assert.notEqual(captures[0].options.env.AGENT_SOUL_MANAGER_MARKER, captures[1].options.env.AGENT_SOUL_MANAGER_MARKER)
  assert.deepEqual(captures.map(x => x.args), [[], []])
  assert.equal(captures[0].options.cwd.replace(/\\/g, '/'), root.replace(/\\/g, '/'))
})

test('supplied marker is reused; invalid supplied marker fails before spawn', async (t) => {
  const root = await fakeExecutable(t)
  const marker = 'B'.repeat(43)
  let called = 0
  const spawn = (_exe, _args, options) => {
    called += 1
    assert.equal(options.env.AGENT_SOUL_MANAGER_MARKER, marker)
    return { pid: 43105, unref() {} }
  }
  const result = spawnAgentSoul({ agentSoulRoot: root }, { marker, spawn })
  assert.equal(result.ok, true)
  assert.equal(called, 1)
  const invalid = spawnAgentSoul({ agentSoulRoot: root }, { marker: 'bad', spawn })
  assert.deepEqual({ ok: invalid.ok, error: invalid.error }, { ok: false, error: 'spawn-failed' })
  assert.equal(called, 1)
  assert.doesNotMatch(JSON.stringify(invalid), /bad/)
})

test('lifecycle-provided marker matches fake spawn environment and inspect record', async (t) => {
  const root = await fakeExecutable(t)
  let spawnedMarker = null
  let inspectedMarker = null
  let alive = false
  const lifecycle = makeAgentSoulLifecycle({
    plan: { exe: path.join(root, 'build', 'AgentSoul.exe') },
    identityAvailable: true,
    health: async () => alive ? { ok: true, pid: 43106 } : { ok: false },
    spawn: async (meta) => {
      spawnedMarker = meta.marker
      const result = spawnAgentSoul({ agentSoulRoot: root }, {
        marker: meta.marker,
        spawn(_exe, _args, options) {
          assert.equal(options.env.AGENT_SOUL_MANAGER_MARKER, meta.marker)
          return { pid: 43106, unref() {} }
        },
      })
      alive = true
      return result
    },
    inspect: async (pid, record) => {
      inspectedMarker = record.marker
      return { ok: true, realpath: path.join(root, 'build', 'AgentSoul.exe'), startedAt: 1, marker: record.marker }
    },
    waitUp: async () => ({ ok: true, health: { ok: true, pid: 43106 } }),
  })
  const result = await lifecycle.start()
  assert.equal(result.started, true)
  assert.equal(spawnedMarker, result.instance.marker)
  assert.equal(inspectedMarker, result.instance.marker)
})

test('invalid child results and thrown spawn errors expose no marker', async (t) => {
  const root = await fakeExecutable(t)
  const outputs = []
  for (const behavior of [
    () => null,
    () => ({ pid: 0, unref() {} }),
    () => ({ pid: 43103 }),
    (_exe, _args, options) => { throw new Error(options.env.AGENT_SOUL_MANAGER_MARKER) },
  ]) {
    const result = spawnAgentSoul({ agentSoulRoot: root }, { spawn: behavior })
    outputs.push(JSON.stringify(result))
    assert.equal(result.ok, false)
    assert.equal(result.error, 'spawn-failed')
  }
  assert.doesNotMatch(outputs.join('\n'), /[A-Za-z0-9_-]{43}/)
})

test('lifecycle stays fail-closed when identity cannot be verified', async () => {
  // ★★★ 2026-11-20 改写：原版断言「生产组合里硬编码 identityAvailable:false」——
  //   那正是这一轮删掉的桩。现在的判据反过来：生产组合**必须**接真核验（见 management-security M-33），
  //   而 lifecycle 在核验不可用时**仍然**一步都不许动。两条合起来才完整。
  const src = await readFile(new URL('../index.js', import.meta.url), 'utf8')
  const from = src.indexOf('const lifecycle = makeAgentSoulLifecycle')
  const to = src.indexOf('globalThis[AGENT_SOUL_LIFECYCLE] = lifecycle', from)
  assert.ok(from >= 0 && to > from)
  const composition = src.slice(from, to)
  assert.doesNotMatch(composition, /identityAvailable:\s*false/, '生产组合不该再有默认关闭身份核验的硬编码')
  let spawnCalls = 0
  const lifecycle = makeAgentSoulLifecycle({
    plan: { exe: 'not-used.exe' },
    identityAvailable: false,
    health: async () => ({ ok: false }),
    spawn: async () => { spawnCalls += 1; return { ok: true, pid: 43104 } },
    inspect: async () => ({ ok: false }),
    terminate: async () => { throw new Error('must not terminate') },
    waitUp: async () => ({ ok: false }),
    waitDown: async () => ({ down: true }),
  })
  const start = await lifecycle.start()
  const stop = await lifecycle.stop()
  const restart = await lifecycle.restart()
  const keeper = await lifecycle.keeperProbe(true, 0)
  assert.equal(start.reason, 'identity-verification-unavailable')
  assert.equal(start.started, false)
  assert.equal(stop.stopped, false)
  assert.equal(restart.restarted, false)
  assert.equal(restart.started, false)
  assert.equal(keeper.spawned, false)
  assert.equal(spawnCalls, 0)
})
