import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// First filesystem action: canonicalize TEMP, then create a unique disposable root.
const tempRoot = fs.realpathSync(os.tmpdir());
function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
const cloneRoot = fs.mkdtempSync(path.join(tempRoot, 'agent-soul-echo-full-clone-preflight-'));
assert.equal(inside(tempRoot, fs.realpathSync(cloneRoot)), true, 'created clone root escaped TEMP');
const checks = [];
async function check(name, fn) {
  try { const detail = await fn(); checks.push({ name, ok: true, ...(detail === undefined ? {} : { detail }) }); }
  catch (error) { checks.push({ name, ok: false, error: String(error?.message || error) }); }
}
function noReparse(target) {
  let current = target;
  while (inside(cloneRoot, current)) {
    const st = fs.lstatSync(current);
    assert.equal(st.isSymbolicLink(), false, 'symlink/reparse candidate: ' + path.relative(cloneRoot, current));
    assert.equal((st.mode & 0o170000), 0o040000, 'expected directory: ' + path.relative(cloneRoot, current));
    if (current === cloneRoot) break;
    current = path.dirname(current);
  }
}
function assertTempCloneTarget(target) {
  const tempReal = fs.realpathSync(os.tmpdir());
  const cloneReal = fs.realpathSync(cloneRoot);
  assert.equal(inside(tempReal, cloneReal), true, 'clone root escaped TEMP');
  assert.equal(inside(cloneReal, path.resolve(target)), true, 'target escaped clone');
  return cloneReal;
}
function mkdirCloneDir(target) {
  assertTempCloneTarget(target);
  fs.mkdirSync(target, { recursive: false });
  const real = fs.realpathSync(target);
  assert.equal(inside(fs.realpathSync(cloneRoot), real), true, 'created directory escaped clone');
  noReparse(real);
}
function writeCloneFile(target, content) {
  const cloneReal = assertTempCloneTarget(target);
  const parentReal = fs.realpathSync(path.dirname(target));
  assert.equal(inside(cloneReal, parentReal), true, 'write parent escaped clone');
  noReparse(parentReal);
  fs.writeFileSync(target, content, { flag: 'wx' });
}
const dirs = Object.fromEntries(['app', 'data', 'echo-db', 'source-fixture', 'evidence', 'user-modules', 'aurabot-cache', 'session-root'].map((name) => [name, path.join(cloneRoot, name)]));
for (const dir of Object.values(dirs)) mkdirCloneDir(dir);
const rootReal = fs.realpathSync(cloneRoot);
const canonical = Object.fromEntries(Object.entries(dirs).map(([name, dir]) => [name, fs.realpathSync(dir)]));
await check('canonical clone directories contained, non-reparse, disjoint', () => {
  assert.equal(rootReal, cloneRoot);
  for (const [name, p] of Object.entries(canonical)) { assert.equal(inside(rootReal, p), true, name + ' escaped clone root'); noReparse(p); }
  const vals = Object.values(canonical);
  for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) {
    assert.equal(inside(vals[i], vals[j]) || inside(vals[j], vals[i]), false, 'directory overlap');
  }
  return canonical;
});

// Fixed source allowlist; this pass only verifies entries, it never copies or executes them.
const allowlist = [
  'src/index.mjs', 'src/config.mjs', 'src/web/server.mjs', 'src/web/auth.mjs',
  'src/adapters/echo-authority-view.mjs', 'src/organs/echo-live.mjs',
  'tools/echo-live-sync.mjs'
];
const sourceRoot = fs.realpathSync(process.cwd());
await check('allowlist paths are regular source files (verification only)', () => {
  for (const rel of allowlist) {
    const full = path.join(sourceRoot, rel);
    assert.equal(inside(sourceRoot, full), true, 'allowlist escape');
    const st = fs.lstatSync(full);
    assert.equal(st.isFile(), true, 'not a regular file: ' + rel);
    assert.equal(st.isSymbolicLink(), false, 'symlink source: ' + rel);
  }
  return { mode: 'verify-only; not executable', files: allowlist, historicalReportFileCount: 132, closureReport: '_forensics/ECHO-愿景审计-12-full-core-closure-20261119.md', currentClosureReconciledSeparately: true };
});

const port = 0; // No bind/listen or network probe in preflight.
const personaDir = path.join(canonical.app, 'synthetic-persona');
mkdirCloneDir(personaDir);
const personaDirReal = fs.realpathSync(personaDir);
assert.equal(inside(rootReal, personaDirReal), true, 'persona fixture escaped clone root');
noReparse(personaDirReal);
const syntheticSelf = path.join(personaDir, 'SELF.md');
const syntheticAgents = path.join(personaDir, 'AGENTS.md');
writeCloneFile(syntheticSelf, '# synthetic SELF\n');
writeCloneFile(syntheticAgents, '# synthetic AGENTS\n');
const cloneEnvManifest = {
  AGENT_SOUL_HOME: canonical.app, AGENT_SOUL_SYNC: 'off',
  AGENT_SOUL_DATA: canonical.data, AGENT_SOUL_STATUS_DIR: path.join(canonical.data, 'status'),
  AGENT_SOUL_SELF: syntheticSelf, AGENT_SOUL_DEV: '0', DSH_HOME: canonical.app,
  disabledDevPaths: ['soulRoot', 'statusDir', 'dshHome', 'sessionRoot', 'backupDir', 'workspace', 'prunerContract', 'dshOriginFile', 'selfMd'],
  disabledServices: ['leadRelay', 'bridge', 'aurabot', 'llm-network', 'onebot'],
  consumerPreflight: {
    doctor: { endpointRequested: false, hardcodedDoctorEntry: 'D:/AI/memory/hub/echo-doctor.mjs', importerPolicy: 'deny', executed: false },
    aurabot: { applyExecuted: false, loadLibExecuted: false, srcScan: { executed: false, collection: [], policy: 'explicitly-blocked; no SRC enumeration' } },
    userModules: { directory: canonical['user-modules'], entries: [], safeMode: true, blockedOperations: ['sync', 'reload', 'create', 'fork', 'cache-copy', 'cache-delete'] },
    sharp: { bufferKind: 'synthetic', byteLength: 8, maxBytes: 1024, importerPolicy: 'deny-sharp-and-native-candidates', realNativeLoaded: false },
    frameReader: { defaultReaderCalled: false, createFrameReaderCalled: false, contract: { kind: 'in-memory-stub' }, sessionRoot: canonical['session-root'], sessionRootEntries: [], sessionAccessed: false }
  }
};
const envManifestPath = path.join(canonical.app, 'clone-env-manifest.json');
writeCloneFile(envManifestPath, JSON.stringify(cloneEnvManifest, null, 2) + '\n');
const cfg = {
  host: '127.0.0.1', port,
  dataDir: canonical.data,
  workspace: canonical.app,
  llm: { baseUrl: '', apiKey: '', model: '', maxTokens: 1024, temperature: 0 },
  context: { maxFrames: 4 },
  persona: { budget: 0, files: [syntheticSelf, syntheticAgents] },
  self: { file: syntheticSelf },
  statusDir: path.join(canonical.data, 'status'),
  events: {
    intervalMs: 60000, silenceMs: 900000, session: null,
    ingress: { mode: 'off', enabled: false, onebot: { enabled: false, wsUrl: '', url: '', token: '' }, bridge: { enabled: false, eventsPath: '', source: '' }, leadRelay: { enabled: false, queuePath: '' } },
    egress: { mode: 'off', enabled: false, onebot: { enabled: false, httpUrl: '', url: '', token: '' } },
    wake: { deliver: false, ownerQQ: '' }
  },
  organs: { huanqi: { enabled: false }, autonomy: { enabled: false }, sentinel: { enabled: false } },
  soul: { root: canonical['source-fixture'], ttl: 0 },
  diary: { dir: canonical.evidence, maxSnippet: 0 },
  mnemon: { runtimeDir: path.join(canonical.data, 'mnemon-empty') },
  chat: { enabled: false, host: '127.0.0.1', port: 0 },
  autonomy: { enabled: false },
  integrations: { dshBaseUrl: null, mcpHubUrl: null, heartbeatUrl: null, dshLogDir: null, dshOriginFile: null, ledgerFallback: false, useBridgeSessions: false },
  sync: { enabled: false, sourceRoot: canonical['source-fixture'], sourceSessions: canonical['source-fixture'] },
  aurabot: { enabled: false, safeMode: true, autoStart: false, dataDir: canonical.data, modulesDir: canonical['user-modules'], cacheDir: canonical['aurabot-cache'], bridge: { enabled: false }, onebot: { enabled: false }, snowluma: { enabled: false } },
  consumerPreflight: cloneEnvManifest.consumerPreflight,
  cloneEnv: { AGENT_SOUL_SYNC: 'off' },
  cloneClosure: { historicalReportFileCount: 132, report: '_forensics/ECHO-愿景审计-12-full-core-closure-20261119.md', mode: 'static-report-only; not runnable' },
  echoLive: { enabled: false, intervalSec: 120, sourceRoot: canonical['source-fixture'], dbPath: path.join(canonical['echo-db'], 'meta.sqlite') }
};
const configPath = path.join(canonical.app, 'config.json');
writeCloneFile(configPath, JSON.stringify(cfg, null, 2) + '\n');
await check('clone config has only clone-local paths and all egress disabled', async () => {
  const readBack = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  for (const p of [readBack.dataDir, readBack.echoLive.dbPath, readBack.echoLive.sourceRoot, readBack.workspace, readBack.host]) {
    if (p.includes(path.sep) || p.includes('/')) assert.equal(inside(rootReal, path.resolve(p)), true, 'path outside clone: ' + p);
  }
  assert.equal(readBack.echoLive.enabled, false);
  assert.equal(readBack.events.ingress.mode, 'off');
  assert.equal(readBack.events.egress.mode, 'off');
  assert.equal(readBack.events.wake.deliver, false);
  assert.equal(readBack.llm.apiKey, '');
  assert.equal(readBack.integrations.dshBaseUrl, null);
  assert.equal(readBack.host, '127.0.0.1');
  assert.equal(readBack.port, 0);
  assert.deepEqual(readBack.persona.files, [syntheticSelf, syntheticAgents]);
  assert.equal(readBack.self.file, syntheticSelf);
  for (const p of [...readBack.persona.files, readBack.self.file, readBack.statusDir, readBack.sync.sourceRoot]) assert.equal(inside(rootReal, path.resolve(p)), true, 'clone-only path escaped: ' + p);
  assert.equal(readBack.sync.enabled, false);
  assert.equal(inside(rootReal, path.resolve(readBack.sync.sourceSessions)), true, 'sync sourceSessions escaped clone');
  assert.equal(/(?:^|[\\/])sessions(?:[\\/]|$)/i.test(readBack.sync.sourceSessions), false, 'sync source points at sessions');
  assert.equal(/(?:^|[\\/])sessions(?:[\\/]|$)/i.test(readBack.sync.sourceRoot), false, 'sync sourceRoot points at sessions');
  assert.equal(cloneEnvManifest.AGENT_SOUL_SYNC, 'off');
  const envBack = JSON.parse(fs.readFileSync(envManifestPath, 'utf8'));
  assert.deepEqual(envBack, cloneEnvManifest);
  assert.equal(/(?:^|[\\/])sessions(?:[\\/]|$)/i.test(JSON.stringify(envBack)), false);
  assert.deepEqual(envBack.disabledDevPaths, ['soulRoot', 'statusDir', 'dshHome', 'sessionRoot', 'backupDir', 'workspace', 'prunerContract', 'dshOriginFile', 'selfMd']);
  assert.deepEqual(envBack.disabledServices, ['leadRelay', 'bridge', 'aurabot', 'llm-network', 'onebot']);
  assert.equal(readBack.aurabot.enabled, false);
  assert.equal(readBack.aurabot.safeMode, true);
  const consumers = readBack.consumerPreflight;
  assert.equal(consumers.doctor.endpointRequested, false);
  assert.equal(consumers.doctor.hardcodedDoctorEntry, 'D:/AI/memory/hub/echo-doctor.mjs');
  assert.equal(consumers.doctor.importerPolicy, 'deny');
  assert.equal(consumers.doctor.executed, false);
  assert.equal(consumers.aurabot.applyExecuted, false);
  assert.equal(consumers.aurabot.loadLibExecuted, false);
  assert.deepEqual(consumers.aurabot.srcScan.collection, []);
  assert.equal(consumers.aurabot.srcScan.executed, false);
  assert.equal(consumers.aurabot.srcScan.policy, 'explicitly-blocked; no SRC enumeration');
  assert.equal(fs.readdirSync(consumers.userModules.directory).length, 0);
  assert.deepEqual(consumers.userModules.entries, []);
  assert.equal(consumers.userModules.safeMode, true);
  assert.deepEqual(consumers.userModules.blockedOperations, ['sync', 'reload', 'create', 'fork', 'cache-copy', 'cache-delete']);
  assert.equal(readBack.aurabot.modulesDir, consumers.userModules.directory);
  assert.equal(readBack.aurabot.cacheDir, canonical['aurabot-cache']);
  const syntheticSharpBuffer = Buffer.alloc(consumers.sharp.byteLength);
  assert.equal(consumers.sharp.bufferKind, 'synthetic');
  assert.equal(syntheticSharpBuffer.length < consumers.sharp.maxBytes, true);
  assert.equal(consumers.sharp.importerPolicy, 'deny-sharp-and-native-candidates');
  assert.equal(consumers.sharp.realNativeLoaded, false);
  assert.equal(consumers.frameReader.defaultReaderCalled, false);
  assert.equal(consumers.frameReader.createFrameReaderCalled, false);
  assert.deepEqual(consumers.frameReader.contract, { kind: 'in-memory-stub' });
  assert.equal(consumers.frameReader.sessionRoot, canonical['session-root']);
  assert.equal(fs.readdirSync(consumers.frameReader.sessionRoot).length, 0);
  assert.deepEqual(consumers.frameReader.sessionRootEntries, []);
  assert.equal(consumers.frameReader.sessionAccessed, false);
  assert.equal(readBack.events.ingress.bridge.enabled, false);
  assert.equal(readBack.events.ingress.bridge.eventsPath, '');
  assert.equal(readBack.events.ingress.leadRelay.enabled, false);
  assert.equal(readBack.events.ingress.leadRelay.queuePath, '');
  assert.equal(readBack.events.ingress.onebot.enabled, false);
  assert.equal(readBack.events.egress.onebot.enabled, false);
  assert.equal(readBack.llm.baseUrl, '');
  assert.equal(readBack.cloneClosure.historicalReportFileCount, 132);
  assert.equal(readBack.cloneClosure.report, '_forensics/ECHO-愿景审计-12-full-core-closure-20261119.md');
  assert.match(readBack.cloneClosure.mode, /not runnable/);
  assert.equal(fs.existsSync(path.join(canonical.app, 'config.local.json')), false);
  const forbiddenRootTokens = ['D:/AI/memory/', 'D:/AI/dsh/', 'D:/AI/yanqing-soul/'];
  const checkedPathFields = [readBack.dataDir, readBack.echoLive.dbPath, readBack.echoLive.sourceRoot, readBack.workspace, readBack.statusDir, ...readBack.persona.files, readBack.self.file, readBack.sync.sourceRoot, readBack.aurabot?.modulesDir, readBack.aurabot?.cacheDir];
  assert.deepEqual(forbiddenRootTokens.filter((token) => checkedPathFields.some((value) => typeof value === 'string' && value.toLowerCase().includes(token.toLowerCase()))), [], 'real user root path detected');
  for (const candidate of Object.values(canonical)) assert.equal(/(?:^|[\\/])sessions(?:[\\/]|$)/i.test(candidate), false, 'source candidate contains sessions path: ' + candidate);
  return { configPath, port, configLocalAbsent: true, secrets: 'empty', noRealDataPaths: true };
});

const summary = {
  ok: checks.every((c) => c.ok), cloneRoot, tempRoot, port, checks,
  scope: {
    cloneCreated: true, sourceCopy: false, allowlistVerifiedOnly: true,
    agentSoulCoreStarted: false, handlerOnlyExecuted: false, fullCoreExecuted: false,
    browserExecuted: false, networkAccessed: false, realLibraryOrSessionRead: false,
    productionConfigModified: false, srcConfigModified: false, deploymentOrRestart: false,
    prohibitedScriptsRun: false
  }
};
writeCloneFile(path.join(canonical.evidence, 'preflight-result.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
const preflightExit = summary.ok ? 0 : 1;
fs.rmSync(cloneRoot, { recursive: true, force: true });
assert.equal(fs.existsSync(cloneRoot), false, 'unique preflight TEMP root was not removed');
console.log('TEMP cleanup: PASS');
if (preflightExit) process.exitCode = preflightExit;
