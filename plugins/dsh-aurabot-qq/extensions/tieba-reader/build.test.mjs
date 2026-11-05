import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildExtension } from './scripts/build.mjs';

test('distribution imports from a fresh directory without node_modules or browser installation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tieba-distribution-'));
  try {
    await buildExtension(dir);
    const pkg=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));
    assert.equal(pkg.dependencies,undefined);
    assert.ok(pkg.scripts['install:browser']);
    const result=spawnSync(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(pathToFileURL(join(dir,'index.mjs')).href)}); console.log(m.default.version);`],{cwd:dir,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),'1.5.0');
    assert.ok(readFileSync(join(dir,'session.cjs'),'utf8').includes('configureCookies'));
  } finally {rmSync(dir,{recursive:true,force:true});}
});
