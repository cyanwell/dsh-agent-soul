import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDirectMainPreflight } from '../src/util/direct-main-preflight.mjs';

async function main() {
  const indexSource = fs.readFileSync(fileURLToPath(new URL('../src/index.mjs', import.meta.url)), 'utf8');
  const coreSource = fs.readFileSync(fileURLToPath(new URL('../src/core-entry.mjs', import.meta.url)), 'utf8');
  const configSource = fs.readFileSync(fileURLToPath(new URL('../src/config.mjs', import.meta.url)), 'utf8');
  const syncPolicySource = fs.readFileSync(fileURLToPath(new URL('../src/util/sync-root-policy.mjs', import.meta.url)), 'utf8');
  const gateCall = indexSource.indexOf('const preflight = await checkDirectMainPreflight();');
  const gatedBranch = indexSource.indexOf("await import('./core-entry.mjs');", gateCall);
  assert.ok(gateCall >= 0 && gatedBranch > gateCall, 'awaited gate runs before gated dynamic core import');
  assert.match(indexSource, /if \(isDirectMain\)[\s\S]*?if \(!preflightRequested\)[\s\S]*?await import\('\.\/core-entry\.mjs'\)[\s\S]*?await checkDirectMainPreflight\(\)[\s\S]*?await import\('\.\/core-entry\.mjs'\)/, 'legacy import remains unguarded while opted-in import follows gate');
  const configHandoffAt = indexSource.indexOf('process.env.AGENT_SOUL_PREFLIGHT_CONFIG = preflight.paths.configFile;');
  const handoffAt = indexSource.indexOf('process.env.AGENT_SOUL_PREFLIGHT_SYNC_ROOT = preflight.paths.syncSourceRoot;');
  assert.ok(configHandoffAt > gateCall && configHandoffAt < gatedBranch, 'validated managed config is handed off before core import');
  assert.ok(handoffAt > gateCall && handoffAt < gatedBranch, 'validated sync root is handed off between preflight and core import');
  assert.ok(coreSource.includes('loadManagedConfig(process.env.AGENT_SOUL_PREFLIGHT_CONFIG'), 'managed preflight loads only its explicit config');
  assert.ok(coreSource.includes(': loadConfig();'), 'legacy startup still uses the original config loader');
  assert.ok(coreSource.includes('config.workspace !== home'), 'managed workspace must equal isolated home');
  assert.ok(coreSource.includes('config.dataDir !== process.env.AGENT_SOUL_DATA'), 'managed dataDir must equal preflight data path');
  const managedAurabotSkip = coreSource.indexOf('managed TEMP: optional Aurabot host skipped');
  const storeAt = coreSource.indexOf('const store = new SessionStore(config.dataDir);');
  const hostImportAt = coreSource.indexOf('importHost: () => import(\'./aurabot/src/host.js\')');
  const hostApplyAt = coreSource.indexOf('await mod.apply(ab.ctx, applyOptions);');
  const listenerAt = coreSource.indexOf('server.listen(config.port, config.host');
  assert.ok(storeAt > 0 && managedAurabotSkip > storeAt && listenerAt > managedAurabotSkip, 'managed TEMP starts the real Core while skipping optional Aurabot host');
  assert.ok(hostImportAt > managedAurabotSkip && hostApplyAt > hostImportAt, 'production Aurabot host remains wired after the managed-only branch');
  assert.ok(coreSource.includes('if (managedPreflight) {') && coreSource.includes('optional Aurabot host skipped'), 'managed behavior is explicit; no environment presence marker bypass');

  assert.match(coreSource, /config\.__managedTemp\s*\?\s*config\.statusDir/, 'managed blocked-receipt writes go only to clone statusDir');
  assert.ok(configSource.includes('cfg.statusDir=cfg.statusDir?resolveManagedConfigPath(cfg.statusDir'), 'managed status directory is constrained to clone home');
  assert.match(configSource, /typeof cfg\.statusDir === 'string' && cfg\.statusDir/, 'runtime statusDir resolver uses explicit managed clone path first');
  assert.match(coreSource, /config\.__managedTemp\s*\?\s*''\s*:/, 'managed lead-target resolver never falls back to production ledger');
  assert.ok(coreSource.indexOf('resolveSyncRootPolicy({') < coreSource.indexOf('const store = new SessionStore(config.dataDir);'), 'core resolves source policy before constructing store');
  assert.ok(coreSource.includes('sourceRoot: syncRootPolicy.sourceRoot') && coreSource.includes('watch: syncRootPolicy.watch'), 'core consumes explicit sourceRoot/watch policy');
  assert.ok(coreSource.includes('config.integrations?.echoDoctorPath'), 'managed startup rejects an external doctor path');
  assert.ok(syncPolicySource.includes("if(!managed)return{sourceRoot:LEGACY_SOURCE_ROOT,watch:true,mode:'legacy'}"), 'legacy mode preserves production sourceRoot and watcher');
  assert.ok(syncPolicySource.includes('watch:false'), 'managed clone disables source watcher');
  assert.deepEqual(await checkDirectMainPreflight({}), { ok: true, mode: 'legacy-allowed' });
  assert.deepEqual(await checkDirectMainPreflight({ AGENT_SOUL_MANAGER_MARKER: 'a'.repeat(32), AGENT_SOUL_MANAGER_SHELL_PID: '123' }), { ok: true, mode: 'legacy-allowed' });
  assert.deepEqual(await checkDirectMainPreflight({ AGENT_SOUL_PREFLIGHT: '1' }), { ok: false, code: 'manager-identity-required' });
  assert.equal((await checkDirectMainPreflight({ AGENT_SOUL_PREFLIGHT: 'yes' })).code, 'preflight-flag-invalid');

  const tempRoot = fs.realpathSync(os.tmpdir());
  const fixture = fs.mkdtempSync(path.join(tempRoot, 'agent-soul-direct-main-preflight-'));
  try {
    const home = path.join(fixture, 'home');
    const data = path.join(home, 'data');
    const persona = path.join(home, 'persona');
    const syncSource = path.join(home, 'source-fixture');
    fs.mkdirSync(data, { recursive: true });
    fs.mkdirSync(persona, { recursive: true });
    fs.mkdirSync(syncSource, { recursive: true });
    const selfFile = path.join(persona, 'SELF.md');
    const configFile = path.join(home, 'config.json');
    fs.writeFileSync(selfFile, '# fixture\n', { flag: 'wx' });
    fs.writeFileSync(configFile, JSON.stringify({ dataDir: 'data', workspace: '.' }), { flag: 'wx' });
    const valid = {
      AGENT_SOUL_PREFLIGHT: '1', AGENT_SOUL_MANAGER_MARKER: 'a'.repeat(32),
      AGENT_SOUL_MANAGER_SHELL_PID: String(process.pid), AGENT_SOUL_PARENT: String(process.pid),
      AGENT_SOUL_HOME: home, AGENT_SOUL_PREFLIGHT_CONFIG: configFile, AGENT_SOUL_DATA: data, AGENT_SOUL_SELF: selfFile, AGENT_SOUL_SYNC_SOURCE_ROOT: syncSource,
    };
    const passed = await checkDirectMainPreflight(valid);
    assert.equal(passed.ok, true, JSON.stringify(passed));
    assert.equal(passed.mode, 'managed-preflight-passed');
    assert.equal(passed.paths.syncSourceRoot, syncSource);
    assert.equal(passed.paths.AGENT_SOUL_PREFLIGHT_CONFIG, configFile);
    assert.equal((await checkDirectMainPreflight({ ...valid, AGENT_SOUL_PREFLIGHT_CONFIG: path.join(fixture, 'missing-config.json') })).code, 'config-path-missing', 'missing managed config rejected');
    const outsideConfig = path.resolve('D:/AI/agent-soul/src/config.mjs');
    assert.equal((await checkDirectMainPreflight({ ...valid, AGENT_SOUL_PREFLIGHT_CONFIG: outsideConfig })).code, 'config-path-outside-temp', 'external config rejected');
    const siblingSource = path.join(fixture, 'sibling'); fs.mkdirSync(siblingSource);
    assert.equal((await checkDirectMainPreflight({ ...valid, AGENT_SOUL_SYNC_SOURCE_ROOT: siblingSource })).code, 'sync-source-root-outside-isolated-root', 'sync source must stay inside clone home');
    assert.deepEqual(passed.notValidated, ['persona']);
    assert.equal((await checkDirectMainPreflight({ ...valid, AGENT_SOUL_DATA: path.join(home, '..', 'missing') })).ok, false, 'traversal/nonexistent path rejected');
    assert.equal((await checkDirectMainPreflight({ ...valid, AGENT_SOUL_DATA: path.resolve('D:/AI/agent-soul') })).code, 'data-path-outside-temp', 'existing outside-TEMP path rejected');
    assert.equal((await checkDirectMainPreflight({ ...valid, AGENT_SOUL_DATA: tempRoot })).code, 'agent_soul_data-outside-isolated-root', 'TEMP root itself cannot replace isolated data');
    assert.equal((await checkDirectMainPreflight({ ...valid, AGENT_SOUL_MANAGER_MARKER: 'bad' })).code, 'manager-marker-invalid');
    assert.equal((await checkDirectMainPreflight({ ...valid, AGENT_SOUL_MANAGER_SHELL_PID: '0' })).code, 'manager-parent-mismatch');
    assert.equal((await checkDirectMainPreflight({ ...valid, AGENT_SOUL_PARENT: String(process.pid + 1) })).code, 'manager-parent-mismatch');
    const outsideFile = path.resolve('D:/AI/agent-soul/src/index.mjs');
    assert.equal((await checkDirectMainPreflight({ ...valid, AGENT_SOUL_SELF: outsideFile })).code, 'self-path-outside-temp');
    console.log('direct-main-preflight-selftest: PASS (legacy, managed TEMP, malformed identity, missing/outside/traversal; static order)');
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
    assert.equal(fs.existsSync(fixture), false, 'unique TEMP fixture removed');
  }
}
await main();
