import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sync-import-'));
const urls = [pathToFileURL(path.join(root, 'src/sync/core.mjs')).href, pathToFileURL(path.join(root, 'tools/soul-sync.mjs')).href];
const probe = [
  "import fs from 'node:fs';",
  'const calls={reads:[],writes:0,timers:0,logs:0};',
  "for(const k of ['readFileSync','readFile','readdirSync','readdir','statSync','stat','existsSync']){const x=fs[k].bind(fs);fs[k]=(...a)=>{calls.reads.push(String(a[0]));return x(...a)}}",
  "for(const k of ['writeFileSync','appendFileSync','mkdirSync','mkdir']){const x=fs[k].bind(fs);fs[k]=(...a)=>{calls.writes++;return x(...a)}}",
  'const si=setInterval,st=setTimeout;globalThis.setInterval=(...a)=>{calls.timers++;return si(...a)};globalThis.setTimeout=(...a)=>{calls.timers++;return st(...a)};',
  'console.log=console.error=console.warn=()=>{calls.logs++};',
  'await import(' + JSON.stringify(urls[0]) + '); await import(' + JSON.stringify(urls[1]) + ');',
  'process.stdout.write(JSON.stringify(calls));'
].join(' ');
try {
 const before=fs.readdirSync(temp);
 const child=spawnSync(process.execPath,['--input-type=module','-e',probe],{cwd:temp,encoding:'utf8',timeout:10000});
 assert.equal(child.status,0,child.stderr||'child import failed');
 const got=JSON.parse(child.stdout);
 assert.deepEqual(got.writes,0); assert.deepEqual(got.timers,0); assert.deepEqual(got.logs,0);
 assert(got.reads.every(x=>!/(config\.json|session\.v4|frames\.jsonl|sync-state|sessions)/i.test(x)),JSON.stringify(got.reads));
 assert.deepEqual(fs.readdirSync(temp),before);
 console.log('PASS fresh-process core/wrapper import has no config/session/state/filesystem/timer/output effects');
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
