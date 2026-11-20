import { inspectWindowsProcess } from '../process-inspector.mjs';
import { makeRunPowerShell, makeCanonicalizePath } from '../lifecycle-inspect.mjs';
const rp = makeRunPowerShell();
const cp = makeCanonicalizePath();
// 直接喂一份已知正确的 CIM 输出，绕开真实查询，看看是解析还是查询的问题
const fake = (cmd) => {
  const pid = /ProcessId = (\d+)/.exec(cmd)[1];
  if (cmd.includes('20788')) return Promise.resolve({ exitCode: 0, timedOut: false, stdout: JSON.stringify({ ProcessId: 20788, ParentProcessId: 34332, ExecutablePath: 'C:\\\\Users\\\\pc\\\\Desktop\\\\deepseek harness\\\\agent soul\\\\AgentSoul.exe', CreationDate: '2026-11-20T13:05:38.983Z' }), error: null });
  return rp(cmd, { timeoutMs: 30000 });
};
const a = await inspectWindowsProcess(20788, { runPowerShell: fake, canonicalizePath: cp });
console.log('fake-path result=' + JSON.stringify(a));
const b = await inspectWindowsProcess(20788, { runPowerShell: rp, canonicalizePath: cp, timeoutMs: 40000 });
console.log('real result=' + JSON.stringify(b));
