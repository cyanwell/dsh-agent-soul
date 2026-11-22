import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(repo, 'tools', 'make-dist.mjs'), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsoul-pack-guard-'));
const cases = [
  { name: 'runtime data directory', rel: 'data/token.txt' },
  { name: 'nested token file', rel: 'nested/token.txt' },
  { name: 'local config', rel: 'config.local.json' },
  { name: 'dotenv file', rel: '.env.production' },
  { name: 'nested symlink', symlink: true },
  { name: 'payload root symlink', rootSymlink: true },
];
try {
  const results = [];
  for (const [i, test] of cases.entries()) {
    const project = path.join(root, 'project-' + i);
    const prod = path.join(root, 'prod-' + i);
    const stage = path.join(project, 'dist', 'build', 'AgentSoul-1.0.99');
    const payload = path.join(prod, 'app', '1.0.99');
    fs.mkdirSync(path.join(project, 'tools'), { recursive: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ version: '1.0.99' }));
    if (test.rootSymlink) {
      const real = path.join(prod, 'real-version');
      fs.mkdirSync(real, { recursive: true });
      fs.writeFileSync(path.join(real, 'payload.mjs'), 'synthetic');
      fs.mkdirSync(path.dirname(payload), { recursive: true });
      try { fs.symlinkSync(real, payload, 'junction'); }
      catch (error) { results.push({ case: test.name, skipped: 'junction creation unavailable: ' + error.code }); continue; }
    } else {
      fs.mkdirSync(payload, { recursive: true });
      if (test.symlink) {
        const target = path.join(prod, 'outside-target');
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, 'payload.mjs'), 'synthetic');
        try { fs.symlinkSync(target, path.join(payload, 'linked-dir'), 'junction'); }
        catch (error) { results.push({ case: test.name, skipped: 'directory junction creation unavailable: ' + error.code }); continue; }
      } else {
        fs.mkdirSync(path.dirname(path.join(payload, test.rel)), { recursive: true });
        fs.writeFileSync(path.join(payload, test.rel), 'SYNTHETIC-CREDENTIAL-MUST-NOT-APPEAR');
      }
    }
    fs.writeFileSync(path.join(stage, 'sentinel.txt'), 'preserve');
    const prodJs = prod.replace(/\\/g, '/');
    const packer = source.replace(/const PROD = process\.env\.AGENT_SOUL_PROD \|\| '[^']+';/, 'const PROD = ' + JSON.stringify(prodJs) + ';');
    assert.notEqual(packer, source, 'fixture must redirect PROD to temporary root');
    fs.writeFileSync(path.join(project, 'tools', 'make-dist.mjs'), packer);
    const logPath = path.join(root, 'child-' + i + '.log');
    const logFd = fs.openSync(logPath, 'w');
    const child = spawnSync(process.execPath, [path.join(project, 'tools', 'make-dist.mjs')], { cwd: project, stdio: ['ignore', logFd, logFd] });
    fs.closeSync(logFd);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.equal(child.status, 1, test.name + ' should reject');
    assert.match(log, /拒绝打包|真实目录/);
    assert.equal(log.includes('SYNTHETIC-CREDENTIAL-MUST-NOT-APPEAR'), false);
    assert.equal(fs.readFileSync(path.join(stage, 'sentinel.txt'), 'utf8'), 'preserve', 'guard must run before staging cleanup');
    results.push({ case: test.name, refused: true, stagingPreserved: true, contentRedacted: true });
  }
  const passed = results.filter((r) => !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log(JSON.stringify({ passed, skipped, results }));
  if (passed < 4) process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
