import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectWindowsProcess, matchesShellCorePair } from '../process-inspector.mjs'

const shell = { ProcessId: 7001, ParentProcessId: 3000, ExecutablePath: 'C:\\install\\AgentSoul.exe', CreationDate: '20261119220000.000000+000' }
const core = { ProcessId: 7002, ParentProcessId: 7001, ExecutablePath: 'C:\\runtime\\node.exe', CreationDate: '20261119220001.000000+000' }
const ok = (value) => ({ exitCode: 0, stdout: JSON.stringify(value) })
const canonicalizePath = async value => value.replace(/\\/g, '/').toLowerCase()

test('single-PID CIM query is bounded and returns canonical process identity', async () => {
  let commandSeen = ''
  const result = await inspectWindowsProcess(7001, { runPowerShell: async (command, opts) => { commandSeen=command; assert.equal(opts.timeoutMs,25000); return ok(shell) }, canonicalizePath })
  assert.equal(result.ok,true)
  assert.match(commandSeen,/Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = 7001"/)
  // ★ 2026-11-20 实测：本机 CIM 的 CreationDate 经 ConvertTo-Json 变 /Date(...)/、[string] 强转是区域格式，
  //   所以命令必须自己输出 ISO-8601 UTC —— 这条断言钉住那个修复，别让它悄悄退回旧命令。
  assert.match(commandSeen,/ToUniversalTime\(\)\.ToString\('yyyy-MM-ddTHH:mm:ss\.fffZ'\)/)
  assert.deepEqual({processId:result.processId,parentProcessId:result.parentProcessId,executablePath:result.executablePath,creationDate:result.creationDate},{processId:7001,parentProcessId:3000,executablePath:'c:/install/agentsoul.exe',creationDate:'2026-11-19T22:00:00.000Z'})
})

test('bad PID never reaches PowerShell and failures are closed', async () => {
  let calls=0;const runPowerShell=async()=>{calls++;return ok(shell)}
  assert.deepEqual(await inspectWindowsProcess('7001',{runPowerShell,canonicalizePath}),{ok:false,code:'pid-invalid'})
  assert.deepEqual(await inspectWindowsProcess(7001,{runPowerShell:async()=>({exitCode:0,timedOut:true,stdout:''}),canonicalizePath}),{ok:false,code:'process-query-timeout'})
  assert.deepEqual(await inspectWindowsProcess(7001,{runPowerShell:async()=>({exitCode:0,stdout:'__NOT_FOUND__'}),canonicalizePath}),{ok:false,code:'process-not-found'})
  assert.deepEqual(await inspectWindowsProcess(7001,{runPowerShell:async()=>({exitCode:0,stdout:'not-json'}),canonicalizePath}),{ok:false,code:'process-json-invalid'})
  assert.deepEqual(await inspectWindowsProcess(7001,{runPowerShell:async()=>ok([shell]),canonicalizePath}),{ok:false,code:'process-result-ambiguous'})
  assert.equal(calls,0)
})

test('incomplete, wrong PID, invalid creation date, and unresolved path fail closed', async () => {
  const run=value=>async()=>ok(value)
  assert.equal((await inspectWindowsProcess(7001,{runPowerShell:run({ProcessId:7001}),canonicalizePath})).code,'process-metadata-incomplete')
  assert.equal((await inspectWindowsProcess(7001,{runPowerShell:run({...shell,ProcessId:7003}),canonicalizePath})).code,'process-metadata-invalid')
  assert.equal((await inspectWindowsProcess(7001,{runPowerShell:run({...shell,CreationDate:'bad'}),canonicalizePath})).code,'process-metadata-invalid')
  assert.equal((await inspectWindowsProcess(7001,{runPowerShell:run(shell),canonicalizePath:async()=>{throw Error('denied')}})).code,'process-path-unresolved')
})

test('DMTF timestamps normalize timezone offsets to one UTC value', async () => {
  const value={...shell,CreationDate:'20261120000000.123456+060'}
  const result=await inspectWindowsProcess(7001,{runPowerShell:async()=>ok(value),canonicalizePath})
  assert.equal(result.ok,true)
  assert.equal(result.creationDate,'2026-11-19T23:00:00.123Z')
  const bad=await inspectWindowsProcess(7001,{runPowerShell:async()=>ok({...shell,CreationDate:'20261120000000.000000+999'}),canonicalizePath})
  assert.equal(bad.code,'process-metadata-invalid')
})

test('parent, PID, and executable path mismatches fail pair binding', () => {
  const s={ok:true,processId:7001,parentProcessId:3000,executablePath:'c:/install/agentsoul.exe',creationDate:'2026-11-19T22:00:00.000Z'}
  const c={ok:true,processId:7002,parentProcessId:7001,executablePath:'c:/runtime/node.exe',creationDate:'2026-11-19T22:00:01.000Z'}
  assert.equal(matchesShellCorePair({shell:s,core:c,expectedShellPid:7001,expectedCorePid:7002,expectedShellPath:s.executablePath,expectedCorePath:c.executablePath}).ok,true)
  assert.equal(matchesShellCorePair({shell:s,core:{...c,parentProcessId:9999},expectedShellPid:7001,expectedCorePid:7002}).code,'process-pair-pid-mismatch')
  assert.equal(matchesShellCorePair({shell:s,core:c,expectedShellPid:1,expectedCorePid:7002}).code,'process-pair-pid-mismatch')
  assert.equal(matchesShellCorePair({shell:s,core:c,expectedShellPid:7001,expectedCorePid:7002,expectedShellPath:'c:/other.exe'}).code,'shell-path-mismatch')
})
