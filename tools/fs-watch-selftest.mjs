#!/usr/bin/env node
// tools/fs-watch-selftest.mjs —— 探针不许把自己噎死（2026-11-17 实测到的自激）。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { installFsWatch } from '../src/util/fs-watch.mjs';

const ok=[]; const bad=[];
const t=(n,c,d)=>{ (c?ok:bad).push(n+(c?'':'  ← '+String(d))); };
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'fsw-'));
const LOG=path.join(ROOT,'fs-slow.log');
const DATA=path.join(ROOT,'business.bin');

const inst = installFsWatch({ logFile: LOG, thresholdMs: 1 });
t('装上了', inst.installed===true, JSON.stringify(inst));

// ① 业务文件：慢调用必须被记
fs.writeFileSync(DATA, Buffer.alloc(8 * 1024 * 1024));
const big = fs.readFileSync(DATA);
t('业务读被记录', big.length === 8*1024*1024, big.length);
const lines1 = fs.existsSync(LOG) ? fs.readFileSync(LOG,'utf8').trim().split('\n').filter(Boolean) : [];
t('日志里有业务记录', lines1.some(l=>l.includes('readFileSync')), lines1.length);

// ② 探针自己的日志文件：**不许**出现在记录里（这是自激的根）
const selfRefs = lines1.filter(l=>/"path":"[^"]*fs-slow\.log"/.test(l));
t('探针不记录自己写日志', selfRefs.length === 0, JSON.stringify(selfRefs.slice(0,2)));

// ③ 反复写业务文件：记录条数应线性增长，不是爆炸式
const before = lines1.length;
for (let i=0;i<20;i++) fs.appendFileSync(DATA, 'x'.repeat(1024));
const lines2 = fs.readFileSync(LOG,'utf8').trim().split('\n').filter(Boolean);
const added = lines2.length - before;
// ★ 一次 appendFileSync 会产生两条记录：append 本体 + 探针为取 size 而做的 statSync。
//   这是**如实记录**，不是自激 —— 判据要看「业务文件 vs 探针日志」的比例，不是绝对条数。
t('20 次业务写 → 记录不超过 40 条（每次最多 2 条：append + stat）', added <= 40, added);
const bizRefs = lines2.slice(before);
t('新增记录全部指向业务文件（无一指向探针日志）',
  bizRefs.every(l=>/business\.bin/.test(l)),
  JSON.stringify(bizRefs.filter(l=>!/business\.bin/.test(l)).slice(0,2)));
t('记录不回指 fs-slow.log', lines2.every(l=>!/"path":"[^"]*fs-slow\.log"/.test(l)), 'self-ref found');

// ④ 探针日志文件绝不出现在“被监听目标”里：写 loop-stall.log 也不该被记
const stall = path.join(ROOT,'loop-stall.log');
fs.writeFileSync(stall, 'x'.repeat(4*1024*1024));
const lines3 = fs.readFileSync(LOG,'utf8').trim().split('\n').filter(Boolean);
const stallRefs = lines3.filter(l=>/loop-stall\.log/.test(l));
t('探针不记录写 loop-stall.log', stallRefs.length === 0, JSON.stringify(stallRefs.slice(0,2)));

// 日志文件可能仍被持有，清理失败不算测试失败（临时目录交给系统清）。
try { fs.rmSync(ROOT,{recursive:true,force:true,maxRetries:3,retryDelay:50}); } catch { /* 无所谓 */ }
for (const x of ok) console.log('  ✓ '+x);
for (const x of bad) console.log('  ✗ '+x);
console.log('');
console.log(bad.length ? (bad.length+' 失败 / '+(ok.length+bad.length)+' 总') : (ok.length+' 通过 / 0 失败'));
process.exitCode=bad.length?1:0;