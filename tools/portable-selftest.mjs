#!/usr/bin/env node
// tools/portable-selftest.mjs —— 「装完就能用、且用他自己的空记忆」。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { resolveDataRoot, bootstrapDataRoot, writeInstallMarker, seedDir, programRoot } from '../src/portable.mjs';

const ok=[]; const bad=[];
const t=(n,c,d)=>{ (c?ok:bad).push(n+(c?'':'  ← '+String(d))); };
const ROOT=fs.mkdtempSync(path.join(os.tmpdir(),'portable-'));

// ── 1. AGENT_SOUL_DATA 优先，并真的建出来 ──
{
  const want=path.join(ROOT,'explicit');
  const prev=process.env.AGENT_SOUL_DATA; process.env.AGENT_SOUL_DATA=want;
  const r=resolveDataRoot(ROOT);
  t('数据根：显式 env 优先', r.dir===path.resolve(want), r.dir);
  t('数据根：source=env', r.source==='env', r.source);
  t('数据根：目录真的建了', fs.existsSync(want), 'missing');
  if (prev===undefined) delete process.env.AGENT_SOUL_DATA; else process.env.AGENT_SOUL_DATA=prev;
}

// ── 2. 没有 env 时可写就用程序目录；不可写回落到 LOCALAPPDATA ──
{
  const r=resolveDataRoot(ROOT);
  t('数据根：默认落在程序目录 data 下', r.dir===path.join(ROOT,'data'), r.dir);
  t('数据根：source=program', r.source==='program', r.source);
}

// ── 3. bootstrap：六层骨架建出来，且不带任何私有数据 ──
{
  const dataRoot=path.join(ROOT,'install');
  const seed=path.join(ROOT,'seed'); fs.mkdirSync(seed,{recursive:true});
  fs.writeFileSync(path.join(seed,'SELF.src.md'), '# SELF 骨架\n\n- 不变量\n', 'utf8');
  const r=bootstrapDataRoot(dataRoot,{ seedDir: seed });
  t('bootstrap：hub 目录在', fs.existsSync(path.join(dataRoot,'hub')), 'x');
  t('bootstrap：index 目录在（空，等派生）', fs.existsSync(path.join(dataRoot,'hub','index')), 'x');
  t('bootstrap：SELF.src.md 从种子拷来', fs.readFileSync(path.join(dataRoot,'hub','SELF.src.md'),'utf8').includes('# SELF 骨架'), 'x');
  t('bootstrap：SELF.md **不存在**（成品必须由 self.mjs 生成）', !fs.existsSync(path.join(dataRoot,'hub','SELF.md')), 'SELF.md leaked into seed!');
  t('bootstrap：空的墨已建', fs.existsSync(path.join(dataRoot,'ledger','02-墨.jsonl')) && fs.statSync(path.join(dataRoot,'ledger','02-墨.jsonl')).size===0, 'x');
  t('bootstrap：热记忆是空模板', fs.readFileSync(path.join(dataRoot,'hub','USER.md'),'utf8')==='', 'x');
  // 幂等：再跑一次不动已有文件
  fs.writeFileSync(path.join(dataRoot,'hub','USER.md'),'我自己的记忆','utf8');
  const r2=bootstrapDataRoot(dataRoot,{ seedDir: seed });
  t('bootstrap：幂等（第二次不覆盖用户内容）', fs.readFileSync(path.join(dataRoot,'hub','USER.md'),'utf8')==='我自己的记忆', 'overwritten');
  t('bootstrap：第二次全部 skipped', r2.created.length===0, JSON.stringify(r2.created));
}

// ── 4. 安装标记：保留 firstInstalledAt ──
{
  const d=path.join(ROOT,'mark'); fs.mkdirSync(d,{recursive:true});
  const a=writeInstallMarker(d,{schemaVersion:11});
  t('install.json：写了 schemaVersion', a.schemaVersion===11, a.schemaVersion);
  const b=writeInstallMarker(d,{schemaVersion:12});
  t('install.json：更新不重置首次安装时间', b.firstInstalledAt===a.firstInstalledAt, JSON.stringify({a:a.firstInstalledAt,b:b.firstInstalledAt}));
  t('install.json：版本跟到新的', b.schemaVersion===12, b.schemaVersion);
}

// ── 5. seedDir 在程序目录下 ──
t('seedDir 指向 <程序根>/seed', seedDir()===path.join(programRoot(),'seed'), seedDir());

fs.rmSync(ROOT,{recursive:true,force:true});
for (const x of ok) console.log('  ✓ '+x);
for (const x of bad) console.log('  ✗ '+x);
console.log('');
console.log(bad.length ? (bad.length+' 失败 / '+(ok.length+bad.length)+' 总') : (ok.length+' 通过 / 0 失败'));
process.exitCode = bad.length?1:0;