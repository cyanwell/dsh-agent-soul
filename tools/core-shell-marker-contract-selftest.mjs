import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const shellPath=path.resolve('build/Shell.cs');
const text=fs.readFileSync(shellPath,'utf8');
const start=text.indexOf('bool StartCore()');
assert(start>=0,'StartCore method exists');
const end=text.indexOf('core = Process.Start(psi);',start);
assert(end>start,'Node Process.Start occurs after env setup');
const body=text.slice(start,end);
const markerRemove=body.indexOf('psi.EnvironmentVariables.Remove("AGENT_SOUL_MANAGER_MARKER")');
const pidRemove=body.indexOf('psi.EnvironmentVariables.Remove("AGENT_SOUL_MANAGER_SHELL_PID")');
const markerRead=body.indexOf('Environment.GetEnvironmentVariable("AGENT_SOUL_MANAGER_MARKER")');
const parentSet=body.indexOf('psi.EnvironmentVariables["AGENT_SOUL_PARENT"] = Process.GetCurrentProcess().Id.ToString()');
const formatCheck=body.indexOf('managerMarker.Length >= 32 && managerMarker.Length <= 128');
const allowedCheck=body.indexOf("c == '_' || c == '-'");
const shellPidDerived=body.indexOf('psi.EnvironmentVariables["AGENT_SOUL_MANAGER_SHELL_PID"] = Process.GetCurrentProcess().Id.ToString()');
const markerSet=body.indexOf('psi.EnvironmentVariables["AGENT_SOUL_MANAGER_MARKER"] = managerMarker');
const optInBranch=body.indexOf('if (validManagerMarker)',allowedCheck);

for(const [name,at] of Object.entries({markerRemove,pidRemove,markerRead,parentSet,formatCheck,allowedCheck,optInBranch,markerSet,shellPidDerived}))assert(at>=0,'missing contract: '+name);
assert(markerRemove<markerRead && pidRemove<markerRead,'inherited manager values removed before opt-in env read');
assert(parentSet<formatCheck && formatCheck<allowedCheck && allowedCheck<optInBranch && optInBranch<markerSet && markerSet<shellPidDerived && shellPidDerived<end,'forward occurs only inside marker-only opt-in; Shell PID is derived locally');
assert.match(body,/AGENT_SOUL_PARENT/,'legacy parent watchdog env remains set');
assert.equal(body.includes('Process.Start(psi)'),false,'test only slices source text before the real process call; it does not invoke it');
console.log('core-shell-marker-contract-selftest: PASS (static mapping only; no compile or process start)');
