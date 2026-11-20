import { makeRunPowerShell } from '../lifecycle-inspect.mjs';
const ps = makeRunPowerShell();
const cmd = `$ErrorActionPreference = "Stop"; $p = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = 20788"; if ($null -eq $p) { "__NOT_FOUND__" } else { $o = [ordered]@{ ProcessId=[int]$p.ProcessId; ParentProcessId=[int]$p.ParentProcessId; ExecutablePath=[string]$p.ExecutablePath; CreationDate=[string]$p.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }; $o | ConvertTo-Json -Compress }`;
const r = await ps(cmd, { timeoutMs: 30000 });
console.log(JSON.stringify(r));
