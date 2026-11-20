import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { makeRunPowerShell, makeCanonicalizePath, makeInspect } from '../lifecycle-inspect.mjs';
import { readManagerProof } from '../manager-proof-client.mjs';

const token = fs.readFileSync('C:/Users/pc/Desktop/deepseek harness/agent soul/data/token.txt', 'utf8').trim();
const marker = fs.readFileSync('C:/Users/pc/AppData/Local/Temp/marker.txt', 'utf8').trim();
const health = async () => {
  const r = await fetch('http://127.0.0.1:7310/api/health');
  if (!r.ok) return { ok: false };
  const b = await r.json();
  return { ok: true, pid: b.pid };
};
const readProof = async (a) => readManagerProof({ ...a, token, fetchImpl: fetch, baseUrl: 'http://127.0.0.1:7310' });
const inspect = makeInspect({ runPowerShell: makeRunPowerShell(), canonicalizePath: makeCanonicalizePath(), readProof, health });

const h = await health();
console.log('corePid=' + h.pid);
console.log('sha256(marker)=' + createHash('sha256').update(marker, 'utf8').digest('hex'));
// ★ 正向：shellPid 用 core.lock 里记录的真实 manager.shellPid
const lock = JSON.parse(fs.readFileSync('C:/Users/pc/Desktop/deepseek harness/agent soul/data/core.lock', 'utf8'));
console.log('lock.manager=' + JSON.stringify(lock.manager));
const shellPid = Number(lock.manager && lock.manager.shellPid);
const realpath = 'C:\\Users\\pc\\Desktop\\deepseek harness\\agent soul\\AgentSoul.exe';
const rec = { pid: shellPid, realpath, marker };
const out = await inspect(shellPid, rec);
console.log('INSPECT(正向)=' + JSON.stringify(out));
// ★ 反向 1：marker 不对
const bad = await inspect(shellPid, { ...rec, marker: 'x'.repeat(48) });
console.log('INSPECT(坏 marker)=' + JSON.stringify(bad));
// ★ 反向 2：pid 指向 core 自己（不是壳）
const bad2 = await inspect(h.pid, { ...rec, realpath: 'C:\\Windows\\System32\\notepad.exe' });
console.log('INSPECT(错 pid)=' + JSON.stringify(bad2));
