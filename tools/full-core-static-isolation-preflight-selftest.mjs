import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const indexSource = path.join(root, 'src', 'index.mjs');
const tempBase = await fs.realpath(os.tmpdir());
const tempRoot = await fs.mkdtemp(path.join(tempBase, 'agent-soul-static-gate-'));
const copyRoot = path.join(tempRoot, 'source-copy');
const sha256 = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const within = (base, target) => {
  const rel = path.relative(base, target);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
};
let cleanupVerified = false;
try {
  await fs.mkdir(copyRoot);
  assert.equal(within(tempBase, await fs.realpath(tempRoot)), true, 'TEMP root escaped canonical temp');
  const copiedIndex = path.join(copyRoot, 'index.mjs');
  const sourceHash = await sha256(indexSource);
  await fs.copyFile(indexSource, copiedIndex, fs.constants.COPYFILE_EXCL);
  const copiedHash = await sha256(copiedIndex);
  assert.equal(copiedHash, sourceHash, 'copied entry hash differs from source');
  const source = await fs.readFile(copiedIndex, 'utf8');
  const gatedAt = source.indexOf('const preflight = await checkDirectMainPreflight();');
  const handoffAt = source.indexOf('process.env.AGENT_SOUL_PREFLIGHT_SYNC_ROOT = preflight.paths.syncSourceRoot;');
  const imports = [...source.matchAll(/await import\(['"]\.\/core-entry\.mjs['"]\);/g)].map((m) => m.index);
  assert.ok(gatedAt >= 0 && handoffAt > gatedAt, 'validated managed source root must be handed off after preflight');
  assert.equal(imports.length, 2, 'one legacy and one managed core-entry import only');
  assert.ok(imports[0] < gatedAt && gatedAt < handoffAt && handoffAt < imports[1], 'managed handoff must happen after preflight and before core import');
  assert.equal(source.includes('await import("./core-entry.mjs")'), false, 'unexpected alternate core-entry import form');
  const result = { ok:true, scope:'copied src/index.mjs hash + source-order contract only; core-entry not imported or executed; closure/runtime isolation not tested', node:process.version, checks:[{name:'entrypoint copied into canonical TEMP and SHA256 matches',ok:true,sha256:sourceHash},{name:'opt-in preflight structurally precedes core-entry dynamic import',ok:true}] };
  console.log(JSON.stringify(result,null,2));
} finally {
  await fs.rm(tempRoot,{recursive:true,force:true});
  cleanupVerified = !(await fs.stat(tempRoot).then(()=>true,()=>false));
  assert.equal(cleanupVerified,true,'selftest TEMP root remains');
  console.log('TEMP cleanup: '+(cleanupVerified?'PASS':'FAIL'));
}
