// keyref-redaction-acceptance.mjs -- P2-1 / P2-1b (F-1) / P2-2 evidence, before vs after.
//
// Why this file exists
// --------------------
// 1.0.2 shipped two leaks that only a hand-edited config.json can reach:
//   P2-1  llm.apiKeyRef = <a raw key>  ->  the error string carried s.slice(0,40), and
//         GET /api/config (refError/keyRef), /api/health (apiKeyRef) and the startup banner
//         printed it. The value could end up in a screenshot.
//   P2-2  AGENT_SOUL_SECRETSTORE could point the core at any exe in distribution builds.
// 1.0.3 closed those GET-side exits but left one:
//   F-1   POST /api/config echoed the OLD raw apiKeyRef twice (changed[].before and
//         restartRequired[].before), and settings.html rendered it as
//         "secret ref: <old raw value> -> dpapi:...". The act of FIXING a mistyped ref
//         was itself the leak.
//
// This script runs the SAME probe against shipped src trees:
//   --phase before  -> expect the 1.0.2 leaks   (GET + POST)
//   --phase mid     -> expect the 1.0.3 state   (GET clean, POST still leaks)
//   --phase after   -> expect 0 hits            (1.0.4)
// Every value is synthetic. No real credential, no external network (loopback only).
//
// The POST sequence (all against the same live core):
//   A  llm.apiKey  = SECRET_CANARY   (control: the secret branch was already safe in 1.0.3)
//   B  llm.apiKeyRef = dpapi:deepseek-official   (THE F-1 step: fixing a mistyped ref)
//   C  llm.apiKey  = NEW_SECRET      (write-through to DPAPI, old key still in apiKey)
//   D  llm.apiKeyRef = REF_CANARY    (illegal -> 400, must not echo the input)
//
// Usage: node keyref-redaction-acceptance.mjs --phase before|mid|after --src <dir> [--port 7683] [--evidence <dir>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const PHASE = argOf('phase', 'after');
const SRC = argOf('src', 'D:/AI/agent-soul/dist/AgentSoul/app/1.0.4/src');
const PORT = Number(argOf('port', '7683'));
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const EV = argOf('evidence', 'D:/AI/agent-soul/_verify/keyref-104-' + TS + '-' + PHASE);
fs.mkdirSync(EV, { recursive: true });

const log = [];
let fails = 0;
const Say = (s) => { log.push(s); console.log(s); };
const Check = (n, c, d) => { if (c) Say('PASS  ' + n + (d ? '  ::  ' + d : '')); else { Say('FAIL  ' + n + (d ? '  ::  ' + d : '')); fails++; } };
const isAfter = PHASE === 'after';
const isBefore = PHASE === 'before';
const expectGetLeak = isBefore;                     // 1.0.2 leaks GET; 1.0.3 / 1.0.4 do not
const expectPostLeak = isBefore || PHASE === 'mid'; // 1.0.2 and 1.0.3 both leak the POST receipt
// one place that guarantees no synthetic value reaches stdout / evidence files
const redact = (v) => (v === undefined || v === null) ? v : (String(v).indexOf('sk-canary-') >= 0 ? '<redacted>' : String(v));
const hitsOf = (text, canary) => (typeof text === 'string' ? text.split(canary).length - 1 : 0);
const noCanary = (text) => typeof text === 'string' && text.indexOf('sk-canary') < 0;

// Three synthetic values. None is a credential; all are generated per run.
const REF_CANARY = 'sk-canary-ref104-' + Math.random().toString(36).slice(2, 10);    // old llm.apiKeyRef
const SECRET_CANARY = 'sk-canary-sec104-' + Math.random().toString(36).slice(2, 10); // old llm.apiKey
const NEW_SECRET = 'sk-canary-new104-' + Math.random().toString(36).slice(2, 10);     // submitted new key
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsoul-keyref-'));
const REAL_SS = 'D:/AI/agent-soul/dist/AgentSoul/runtime/SecretStore.exe';
const EXT_DIR = path.join(ROOT, 'external');
const EXT_SS = path.join(EXT_DIR, 'SecretStore.exe');

Say('[keyref] phase   = ' + PHASE);
Say('[keyref] src     = ' + SRC);
Say('[keyref] temp    = ' + ROOT);
Say('[keyref] port    = ' + PORT);
Say('[keyref] canaries are synthetic; only lengths are logged');
Say('[keyref] expectations: getLeak=' + expectGetLeak + ' postLeak=' + expectPostLeak);

// -- 0. preconditions -------------------------------------------------------
Check('src/config.mjs exists', fs.existsSync(path.join(SRC, 'config.mjs')));
Check('shipped SecretStore.exe exists', fs.existsSync(REAL_SS));
const portBusy = await new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port: PORT });
  s.once('connect', () => { s.destroy(); resolve(true); });
  s.once('error', () => resolve(false));
  setTimeout(() => { s.destroy(); resolve(false); }, 800);
});
Check('test port is free before start', !portBusy, 'port=' + PORT);

// -- 1. load the shipped config.mjs (the artifact, not the working tree) ---
process.env.AGENT_SOUL_HOME = ROOT;
delete process.env.AGENT_SOUL_KEY;
delete process.env.AGENT_SOUL_SECRETSTORE;
delete process.env.AGENT_SOUL_DEV;
const cfgMod = await import(pathToFileURL(path.join(SRC, 'config.mjs')).href);

// -- 2. P2-1 - the resolver itself must not echo the bad ref ---------------
{
  const r = cfgMod.resolveApiKeyRef(REF_CANARY, ROOT);
  const err = String(r.error || '');
  Check('resolver rejects a raw key shaped apiKeyRef', r.ok === false, 'source=' + redact(r.source));
  if (isBefore) Check('BEFORE: resolver error DOES contain the input (leak reproduced)', err.indexOf(REF_CANARY) >= 0, 'errLen=' + err.length);
  else Check('resolver error does NOT contain the input', err.indexOf(REF_CANARY) < 0, 'errLen=' + err.length);
  Say('[keyref] resolver source kind = ' + (String(r.source).indexOf(REF_CANARY) >= 0 ? '<redacted: echoes input>' : String(r.source)));
  Say('[keyref] resolver error      = ' + (err.indexOf(REF_CANARY) >= 0 ? '<redacted: echoes input>' : err));

  if (!isBefore) {
    const d1 = cfgMod.describeApiKeyRef('dpapi:deepseek-official');
    const d2 = cfgMod.describeApiKeyRef('env:MY_KEY');
    const d3 = cfgMod.describeApiKeyRef(REF_CANARY);
    const d4 = cfgMod.describeApiKeyRef('dpapi:Bad Provider');
    Check('describe: dpapi:deepseek-official is valid and shown as-is', d1.valid === true && d1.display === 'dpapi:deepseek-official');
    Check('describe: env:MY_KEY is valid and shown as-is', d2.valid === true && d2.display === 'env:MY_KEY');
    Check('describe: raw key -> unknown, no echo', d3.kind === 'unknown' && d3.display === 'unknown');
    Check('describe: malformed dpapi -> invalid, no echo', d4.kind === 'invalid' && d4.display === 'invalid');
    const r2 = cfgMod.resolveApiKeyRef('dpapi:Bad Provider', ROOT);
    Check('resolver error for malformed ref carries no input characters', String(r2.error).indexOf('Bad Provider') < 0, String(r2.error).slice(0, 60));
  }
}

// -- 3. P2-2 - external helper override must be DEV-only (after) -----------
{
  fs.mkdirSync(EXT_DIR, { recursive: true });
  fs.copyFileSync(REAL_SS, EXT_SS);
  const r = spawnSync(EXT_SS, ['set', '--provider', 'deepseek-official', '--root', ROOT], { input: SECRET_CANARY, encoding: 'utf8' });
  Check('external helper stored the synthetic secret', r.status === 0 && fs.existsSync(path.join(ROOT, 'data', 'secrets', 'deepseek-official.dpapi')));

  process.env.AGENT_SOUL_SECRETSTORE = EXT_SS;
  // no root/runtime helper on purpose: if the override is ignored, resolution must fail.
  const p = cfgMod.secretStorePath(ROOT);
  Say('[keyref] secretStorePath (override set, DEV unset) = ' + p);

  if (isAfter) {
    Check('P2-2 release mode: external override is ignored', path.resolve(p) === path.resolve(path.join(ROOT, 'runtime', 'SecretStore.exe')), p);
    const rr = cfgMod.resolveApiKeyRef('dpapi:deepseek-official', ROOT);
    Check('P2-2 release mode: external helper is NOT executed', rr.ok === false && String(rr.error).indexOf('external') < 0 && String(rr.error).indexOf(EXT_SS) < 0, String(rr.error).slice(0, 80));
    process.env.AGENT_SOUL_DEV = '1';
    const pDev = cfgMod.secretStorePath(ROOT);
    Check('P2-2 DEV=1: override applies', path.resolve(pDev) === path.resolve(EXT_SS), pDev);
    const rd = cfgMod.resolveApiKeyRef('dpapi:deepseek-official', ROOT);
    Check('P2-2 DEV=1: external helper resolves the synthetic secret', rd.ok === true && rd.value === SECRET_CANARY, 'len=' + String(rd.value || '').length);
    process.env.AGENT_SOUL_DEV = 'true';
    Check('P2-2 DEV must be exactly "1"', path.resolve(cfgMod.secretStorePath(ROOT)) === path.resolve(path.join(ROOT, 'runtime', 'SecretStore.exe')));
    delete process.env.AGENT_SOUL_DEV;
  } else if (PHASE === 'mid') {
    Check('MID (1.0.3): external override is ignored too', path.resolve(p) === path.resolve(path.join(ROOT, 'runtime', 'SecretStore.exe')), p);
    const rrMid = cfgMod.resolveApiKeyRef('dpapi:deepseek-official', ROOT);
    Check('MID (1.0.3): external helper is NOT executed', rrMid.ok === false, 'ok=' + rrMid.ok);
  } else {
    Check('P2-2 BEFORE: external override takes effect without DEV', path.resolve(p) === path.resolve(EXT_SS), p);
    const rr = cfgMod.resolveApiKeyRef('dpapi:deepseek-official', ROOT);
    Check('P2-2 BEFORE: external helper is executed', rr.ok === true && rr.value === SECRET_CANARY, 'ok=' + rr.ok);
  }
  delete process.env.AGENT_SOUL_SECRETSTORE;
}

// -- 3b. the shipped helper goes where a distribution build looks for it ---
//      (section 3 needed it ABSENT; the live server needs it PRESENT so that the
//       "submit a new key while a dpapi ref is active" path can run for real)
fs.mkdirSync(path.join(ROOT, 'runtime'), { recursive: true });
fs.copyFileSync(REAL_SS, path.join(ROOT, 'runtime', 'SecretStore.exe'));

// -- 4. live server: config / health / startup banner ----------------------
//      llm.apiKeyRef holds a raw key; llm.apiKey is empty, so the banner still fires.
const cfgPath = path.join(ROOT, 'config.json');
fs.writeFileSync(cfgPath, JSON.stringify({
  llm: { protocol: 'openai', provider: 'deepseek-official', providerName: 'test', baseUrl: '', apiKey: '', apiKeyRef: REF_CANARY, model: 'deepseek-chat' },
  chat: { enabled: false },
  autonomy: { enabled: false },
  soul: { root: path.join(ROOT, 'workspace') },
}, null, 2) + '\n', 'utf8');

function httpGet(p, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, timeout: 3000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}
function httpJson(p, method, obj) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method, timeout: 15000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}
const parseJson = (s) => { try { return JSON.parse(s); } catch { return null; } };
const pickChanged = (o, key) => ((o && Array.isArray(o.changed)) ? o.changed.find((c) => c.key === key) : null) || null;
const pickRestart = (o, key) => ((o && Array.isArray(o.restartRequired)) ? o.restartRequired.find((c) => c.key === key) : null) || null;

const nodeExe = process.execPath;
const child = spawn(nodeExe, [path.join(SRC, 'index.mjs')], {
  cwd: ROOT,
  env: Object.assign({}, process.env, {
    AGENT_SOUL_HOME: ROOT,
    AGENT_SOUL_PORT: String(PORT),
    AGENT_SOUL_DATA: path.join(ROOT, 'data'),
    AGENT_SOUL_SYNC: 'off',
    AGENT_SOUL_CHAT: 'off',
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
child.stdout.on('data', (d) => { serverOut += String(d); });
child.stderr.on('data', (d) => { serverOut += String(d); });

let healthBody = null;
const t0 = Date.now();
while (Date.now() - t0 < 60000) {
  try {
    const r = await httpGet('/api/health');
    if (r.status === 200) { healthBody = r.body; break; }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 400));
}
Check('core answered /api/health 200', healthBody !== null);
Say('[keyref] health up after ' + (Date.now() - t0) + 'ms');

let configBody = null;
if (healthBody !== null) {
  const c = await httpGet('/api/config');
  configBody = c.body;
}

// -- 4b. F-1: the POST /api/config receipt ---------------------------------
let pA = null; let pAObj = null;   // llm.apiKey = SECRET_CANARY
let pB = null; let pBObj = null;   // llm.apiKeyRef = dpapi:deepseek-official   <-- the F-1 step
let pC = null; let pCObj = null;   // llm.apiKey = NEW_SECRET
let pD = null; let pDObj = null;   // llm.apiKeyRef = REF_CANARY (illegal)
if (healthBody !== null) {
  pA = await httpJson('/api/config', 'POST', { patch: { 'llm.apiKey': SECRET_CANARY } });
  pAObj = parseJson(pA.body);
  Say('[keyref] POST#A (set key) status=' + pA.status + ' changed=' + (pAObj && pAObj.changed ? pAObj.changed.length : 'null'));

  pB = await httpJson('/api/config', 'POST', { patch: { 'llm.apiKeyRef': 'dpapi:deepseek-official' } });
  pBObj = parseJson(pB.body);
  Say('[keyref] POST#B (fix the ref) status=' + pB.status + ' changed=' + (pBObj && pBObj.changed ? pBObj.changed.length : 'null')
    + ' restartRequired=' + (pBObj && pBObj.restartRequired ? pBObj.restartRequired.length : 'null'));

  pC = await httpJson('/api/config', 'POST', { patch: { 'llm.apiKey': NEW_SECRET } });
  pCObj = parseJson(pC.body);
  Say('[keyref] POST#C (new key -> DPAPI) status=' + pC.status + ' changed=' + (pCObj && pCObj.changed ? pCObj.changed.length : 'null'));

  pD = await httpJson('/api/config', 'POST', { patch: { 'llm.apiKeyRef': REF_CANARY } });
  pDObj = parseJson(pD.body);
  Say('[keyref] POST#D (illegal ref) status=' + pD.status + ' errorFields=' + JSON.stringify(pDObj && pDObj.errors ? pDObj.errors.map((e) => e.field) : null));
}

let configAfterBody = null;
if (healthBody !== null) {
  try { const c2 = await httpGet('/api/config'); configAfterBody = c2.body; } catch { configAfterBody = null; }
}

// stop the core (loopback POST, then bounded wait, then kill)
try { await httpGet('/api/shutdown', 'POST'); } catch { /* already gone */ }
{
  const deadline = Date.now() + 20000;
  while (!child.killed && child.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
  }
  if (child.exitCode === null) { try { child.kill(); } catch { /* ignore */ } }
  await new Promise((r) => setTimeout(r, 800));
}

// -- 5. assertions ---------------------------------------------------------
const hits = (text) => hitsOf(text, REF_CANARY);
let healthObj = null;
if (healthBody) { try { healthObj = JSON.parse(healthBody); } catch { healthObj = null; } }
let keyField = null;
let refField = null;
if (configBody) {
  try {
    const cv = JSON.parse(configBody);
    for (const g of cv.groups || []) for (const f of g.fields || []) {
      if (f.key === 'llm.apiKey') keyField = f;
      if (f.key === 'llm.apiKeyRef') refField = f;
    }
  } catch { keyField = null; refField = null; }
}

const refError = keyField ? String(keyField.refError || '') : '';
const startupHitsRef = hitsOf(serverOut, REF_CANARY);
const startupHitsSecret = hitsOf(serverOut, SECRET_CANARY) + hitsOf(serverOut, NEW_SECRET);
const startupHasLeak = startupHitsRef > 0 || startupHitsSecret > 0;
const healthHasLeak = healthBody ? (healthBody.indexOf(REF_CANARY) >= 0 || healthBody.indexOf(SECRET_CANARY) >= 0) : null;
const configHasLeak = configBody ? (configBody.indexOf(REF_CANARY) >= 0 || configBody.indexOf(SECRET_CANARY) >= 0) : null;
const configAfterHasLeak = configAfterBody
  ? (configAfterBody.indexOf(REF_CANARY) >= 0 || configAfterBody.indexOf(SECRET_CANARY) >= 0 || configAfterBody.indexOf(NEW_SECRET) >= 0) : null;

const cA = pickChanged(pAObj, 'llm.apiKey');
const cB = pickChanged(pBObj, 'llm.apiKeyRef');
const rB = pickRestart(pBObj, 'llm.apiKeyRef');
const cC = pickChanged(pCObj, 'llm.apiKey');
const rC = pickRestart(pCObj, 'llm.apiKey');
const leakA = pA ? (pA.body.indexOf(SECRET_CANARY) >= 0) : null;
const leakB = pB ? (pB.body.indexOf(REF_CANARY) >= 0 || pB.body.indexOf(SECRET_CANARY) >= 0) : null;
const leakC = pC ? (pC.body.indexOf(NEW_SECRET) >= 0 || pC.body.indexOf(SECRET_CANARY) >= 0) : null;
const leakD = pD ? (pD.body.indexOf(REF_CANARY) >= 0 || pD.body.indexOf(SECRET_CANARY) >= 0) : null;

Say('[keyref] leak counts: healthBody=' + hits(healthBody) + ' configBody=' + hits(configBody)
  + ' refError=' + hits(refError) + ' startupLog=' + hits(serverOut));
Say('[keyref] POST#A body canary hits=' + hitsOf(pA && pA.body, SECRET_CANARY)
  + '  changed.before=' + redact(cA && cA.before) + ' changed.after=' + redact(cA && cA.after));
Say('[keyref] POST#B body canary hits: ref=' + hitsOf(pB && pB.body, REF_CANARY) + ' secret=' + hitsOf(pB && pB.body, SECRET_CANARY)
  + '  changed.before=' + redact(cB && cB.before) + ' changed.after=' + redact(cB && cB.after)
  + '  restart.before=' + redact(rB && rB.before) + ' restart.after=' + redact(rB && rB.after));
Say('[keyref] POST#C body canary hits: new=' + hitsOf(pC && pC.body, NEW_SECRET) + ' old=' + hitsOf(pC && pC.body, SECRET_CANARY)
  + '  changed.before=' + redact(cC && cC.before) + ' changed.after=' + redact(cC && cC.after));
Say('[keyref] POST#D status=' + (pD && pD.status) + ' body canary hits=' + hitsOf(pD && pD.body, REF_CANARY)
  + ' message=' + redact(pDObj && pDObj.errors && pDObj.errors[0] ? pDObj.errors[0].message : ''));
Say('[keyref] health.apiKeyRef = ' + (healthObj ? redact(healthObj.apiKeyRef) : '(no health)'));
Say('[keyref] config.keyRef    = ' + (keyField ? redact(keyField.keyRef) : '(no field)'));
Say('[keyref] startup banner present: ' + (serverOut.indexOf('引用没解出来') >= 0));
Say('[keyref] banner line (redacted) = ' + (serverOut.split(/\r?\n/).find((l) => l.indexOf('引用没解出来') >= 0) || '').replace(new RegExp(REF_CANARY, 'g'), '<redacted>').replace(new RegExp(SECRET_CANARY, 'g'), '<redacted>'));

if (isAfter) {
  Check('GET /api/health body: 0 canary', healthHasLeak === false);
  Check('GET /api/config body: 0 canary', configHasLeak === false);
  Check('GET /api/config refError: 0 canary', hits(refError) === 0, 'len=' + refError.length);
  Check('startup log: 0 canary', !startupHasLeak, 'ref=' + startupHitsRef + ' secret=' + startupHitsSecret);
  Check('startup log still explains the failure (banner kept)', serverOut.indexOf('引用没解出来') >= 0);
  Check('health.apiKeyRef is "unknown" (no echo)', healthObj && healthObj.apiKeyRef === 'unknown', healthObj && String(healthObj.apiKeyRef));
  Check('health.apiKeyRefKind == unknown', healthObj && healthObj.apiKeyRefKind === 'unknown');
  Check('config keyRef is "unknown"', keyField && keyField.keyRef === 'unknown', keyField && String(keyField.keyRef));
  Check('config keyRefKind == unknown', keyField && keyField.keyRefKind === 'unknown');
  Check('config secret field has NO value property', keyField && !Object.prototype.hasOwnProperty.call(keyField, 'value'));
  Check('config secret field fileValue is null', keyField && keyField.fileValue === null);
  Check('config apiKeyRef field carries no canary in value/fileValue/display',
    refField ? noCanary(String(refField.value)) && noCanary(String(refField.fileValue)) && noCanary(String(refField.display)) : false,
    refField ? ('value=' + redact(refField.value) + ' fileValue=' + redact(refField.fileValue)) : '(no field)');

  // F-1 - the receipt, field by field
  Check('POST#A (set key) returns 200', pA && pA.status === 200, 'status=' + (pA && pA.status));
  Check('POST#A response body: submitted key never echoed', leakA === false && noCanary(pA && pA.body));
  Check('POST#A changed[llm.apiKey].before == "未配置"', cA && cA.before === '未配置', cA && String(cA.before));
  Check('POST#A changed[llm.apiKey].after == "已配置"', cA && cA.after === '已配置', cA && String(cA.after));
  Check('POST#A changed[llm.apiKey].sensitive == true', cA && cA.sensitive === true);

  Check('POST#B (fix the bad ref) returns 200', pB && pB.status === 200, 'status=' + (pB && pB.status));
  Check('POST#B response body: 0 canary (both synthetic secrets)', leakB === false);
  Check('POST#B response body: no "sk-canary" slice at all', pB && noCanary(pB.body));
  Check('POST#B changed[llm.apiKeyRef].before == "unknown"', cB && cB.before === 'unknown', cB && String(cB.before));
  Check('POST#B changed[llm.apiKeyRef].after == "dpapi:deepseek-official"', cB && cB.after === 'dpapi:deepseek-official', cB && String(cB.after));
  Check('POST#B changed[llm.apiKeyRef].sensitive == true', cB && cB.sensitive === true);
  Check('POST#B restartRequired[llm.apiKeyRef].before == "unknown"', rB && rB.before === 'unknown', rB && String(rB.before));
  Check('POST#B restartRequired[llm.apiKeyRef].after == "dpapi:deepseek-official"', rB && rB.after === 'dpapi:deepseek-official', rB && String(rB.after));
  Check('POST#B restartRequired carries no canary', rB && noCanary(JSON.stringify(rB)));
  Check('POST#B legal ref really landed on disk', pBObj && pBObj.ok === true && pBObj.written === true);

  Check('POST#C (new key while a dpapi ref is active) returns 200', pC && pC.status === 200, 'status=' + (pC && pC.status));
  Check('POST#C response body: 0 canary (submitted + old)', leakC === false && noCanary(pC && pC.body));
  Check('POST#C changed[llm.apiKey].before == "已配置"', cC && cC.before === '已配置', cC && String(cC.before));
  Check('POST#C changed[llm.apiKey].after == "已配置" (DPAPI write-through)', cC && cC.after === '已配置', cC && String(cC.after));
  Check('POST#C changed[llm.apiKey].sensitive == true', cC && cC.sensitive === true);
  Check('POST#C restartRequired carries no canary', rC && noCanary(JSON.stringify(rC)));

  Check('POST#D illegal ref returns 400', pD && pD.status === 400, 'status=' + (pD && pD.status));
  Check('POST#D 400 body: 0 canary', leakD === false);
  Check('POST#D message is the allow-list text, not the input', !!(pDObj && pDObj.errors && pDObj.errors[0] && /dpapi:/.test(String(pDObj.errors[0].message))));
  Check('POST#D wrote nothing', pDObj && pDObj.written === false);

  Check('GET /api/config AFTER the POSTs: 0 canary', configAfterHasLeak === false);
} else {
  // The probe must be able to SEE the leak; otherwise a green "after" proves nothing.
  if (expectGetLeak) {
    Check('BEFORE baseline: health body leaks the synthetic ref', healthHasLeak === true);
    Check('BEFORE baseline: config body leaks the synthetic ref', configHasLeak === true);
    Check('BEFORE baseline: refError leaks the synthetic ref', hits(refError) > 0);
    Check('BEFORE baseline: startup log leaks the synthetic ref', startupHasLeak);
  } else {
    Check('MID baseline: GET is already clean', healthHasLeak === false && configHasLeak === false);
    Check('MID baseline: startup log is already clean', !startupHasLeak);
  }
  Check('F-1 baseline: POST#B receipt DOES echo the old raw ref (leak reproduced)', leakB === true);
  Check('F-1 baseline: changed[llm.apiKeyRef].before == the raw ref', cB && String(cB.before) === REF_CANARY, 'changed.before=' + redact(cB && cB.before));
  Check('F-1 baseline: restartRequired[llm.apiKeyRef].before == the raw ref', rB && String(rB.before) === REF_CANARY, 'restart.before=' + redact(rB && rB.before));
}

// -- 6. evidence (never contains the full canary) --------------------------
const evidence = {
  phase: PHASE, src: SRC, port: PORT, at: new Date().toISOString(),
  canary: { kind: 'synthetic', refLen: REF_CANARY.length, secretLen: SECRET_CANARY.length, newLen: NEW_SECRET.length },
  leakCounts: { healthBody: hits(healthBody), configBody: hits(configBody), refError: hits(refError), startupLog: hits(serverOut) },
  health: healthObj ? { apiKeyRef: redact(healthObj.apiKeyRef), apiKeyRefKind: redact(healthObj.apiKeyRefKind), apiKeyRefValid: healthObj.apiKeyRefValid, llmReady: healthObj.llmReady } : null,
  configField: keyField ? { keyRef: redact(keyField.keyRef), keyRefKind: redact(keyField.keyRefKind), keyRefValid: keyField.keyRefValid, hasValueProperty: Object.prototype.hasOwnProperty.call(keyField, 'value'), fileValue: keyField.fileValue } : null,
  configRefField: refField ? { value: redact(refField.value), fileValue: redact(refField.fileValue), display: redact(refField.display), refKind: redact(refField.refKind) } : null,
  post: {
    A: pA ? { status: pA.status, bodyHasCanary: leakA, changed: cA ? { before: redact(cA.before), after: redact(cA.after), sensitive: cA.sensitive } : null } : null,
    B: pB ? { status: pB.status, bodyHasCanary: leakB, changed: cB ? { before: redact(cB.before), after: redact(cB.after), sensitive: cB.sensitive } : null, restartRequired: rB ? { before: redact(rB.before), after: redact(rB.after) } : null, ok: pBObj ? pBObj.ok : null, written: pBObj ? pBObj.written : null } : null,
    C: pC ? { status: pC.status, bodyHasCanary: leakC, changed: cC ? { before: redact(cC.before), after: redact(cC.after), sensitive: cC.sensitive, note: redact(cC.note) } : null } : null,
    D: pD ? { status: pD.status, bodyHasCanary: leakD, message: redact(pDObj && pDObj.errors && pDObj.errors[0] ? pDObj.errors[0].message : null), written: pDObj ? pDObj.written : null } : null,
  },
  started: healthBody !== null,
  fails,
};
fs.writeFileSync(path.join(EV, '10-keyref-probe.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(EV, '99-keyref.log'), log.join('\n') + '\n', 'utf8');

// verify the evidence itself is clean
const evText = fs.readFileSync(path.join(EV, '99-keyref.log'), 'utf8') + fs.readFileSync(path.join(EV, '10-keyref-probe.json'), 'utf8');
Check('evidence file carries no canary', evText.indexOf(REF_CANARY) < 0 && evText.indexOf(SECRET_CANARY) < 0 && evText.indexOf(NEW_SECRET) < 0);

Say('---');
Say('fails=' + fails);
Say('evidence = ' + EV);

// cleanup
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* best effort */ }
Check('temp root removed', !fs.existsSync(ROOT), ROOT);

process.exit(fails ? 1 : 0);
