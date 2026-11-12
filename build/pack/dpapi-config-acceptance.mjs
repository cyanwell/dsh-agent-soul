// dpapi-config-acceptance.mjs -- prove llm.apiKeyRef resolution end to end, on THIS machine.
//
// ★ Uses the SHIPPED copy of src/ (dist\AgentSoul\app\<ver>\src), not the repo one -- the thing
//   being verified is the artifact, not my working tree.
// ★ A synthetic canary stands in for a real key. No real credential is read anywhere.
//
// Usage: node dpapi-config-acceptance.mjs [--src <src>] [--ver 1.0.2] [--evidence <dir>]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const argOf = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const VER = argOf('ver', '1.0.2');
const SRC = argOf('src', 'D:/AI/agent-soul/dist/AgentSoul/app/' + VER + '/src');
const TS = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const EV = argOf('evidence', 'D:/AI/agent-soul/_verify/dpapi-102-' + TS);
fs.mkdirSync(EV, { recursive: true });

const log = [];
let fails = 0;
const Say = (s) => { log.push(s); console.log(s); };
const Check = (n, c, d) => { if (c) Say('PASS  ' + n + (d ? '  ::  ' + d : '')); else { Say('FAIL  ' + n + (d ? '  ::  ' + d : '')); fails++; } };

const CANARY = 'sk-canary-dpapi-102-' + Math.random().toString(36).slice(2, 10);
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsoul-dpapi-'));
const SS = path.join(ROOT, 'runtime', 'SecretStore.exe');
fs.mkdirSync(path.join(ROOT, 'runtime'), { recursive: true });
fs.copyFileSync('D:/AI/agent-soul/dist/AgentSoul/runtime/SecretStore.exe', SS);
Say('[dpapi] temp root = ' + ROOT);
Say('[dpapi] shipped src = ' + SRC);

// ① the shipped config must reference the secret, never carry it
{
  const rel = JSON.parse(fs.readFileSync('D:/AI/agent-soul/config.release.json', 'utf8'));
  Check('release config: llm.apiKeyRef = dpapi:deepseek-official', rel.llm.apiKeyRef === 'dpapi:deepseek-official', rel.llm.apiKeyRef);
  Check('release config: llm.apiKey 是空串', rel.llm.apiKey === '', JSON.stringify(rel.llm.apiKey));
}

// ② store the canary through the helper (stdin)
{
  const r = spawnSync(SS, ['set', '--provider', 'deepseek-official', '--root', ROOT], { input: CANARY, encoding: 'utf8' });
  Check('SecretStore set exit=0', r.status === 0, 'out=' + String(r.stdout).trim() + ' err=' + String(r.stderr).trim().slice(0, 80));
  const blob = path.join(ROOT, 'data', 'secrets', 'deepseek-official.dpapi');
  Check('密文文件已生成', fs.existsSync(blob), blob);
  const raw = fs.readFileSync(blob);
  Check('密文里搜不到 canary（DPAPI 真加密）', raw.indexOf(Buffer.from(CANARY, 'utf8')) < 0, 'bytes=' + raw.length);
}

// ③ write a config that only carries the reference
const cfgPath = path.join(ROOT, 'config.json');
function writeCfg(llmPatch) {
  const base = JSON.parse(fs.readFileSync('D:/AI/agent-soul/config.release.json', 'utf8'));
  base.llm = Object.assign({}, base.llm, llmPatch);
  fs.writeFileSync(cfgPath, JSON.stringify(base, null, 2) + '\n', 'utf8');
}

process.env.AGENT_SOUL_HOME = ROOT;
delete process.env.AGENT_SOUL_KEY;
const { loadConfig, resolveApiKeyRef, secretStorePath } = await import(pathToFileURL(path.join(SRC, 'config.mjs')).href);

writeCfg({ protocol: 'anthropic', apiKeyRef: 'dpapi:deepseek-official' });
{
  const cfg = loadConfig();
  Check('helper 路径由安装根解析（不依赖开发机）', secretStorePath(ROOT).toLowerCase() === path.join(ROOT, 'runtime', 'SecretStore.exe').toLowerCase(), secretStorePath(ROOT));
  Check('loadConfig 解出 apiKey（进内存）', cfg.llm.apiKey === CANARY, 'len=' + cfg.llm.apiKey.length);
  Check('apiKeySource = dpapi:deepseek-official', cfg.llm.apiKeySource === 'dpapi:deepseek-official', cfg.llm.apiKeySource);
  Check('没有解析错误', !cfg.llm.apiKeyRefError, String(cfg.llm.apiKeyRefError || ''));
  Check('protocol 从配置读出（anthropic）', cfg.llm.protocol === 'anthropic', cfg.llm.protocol);
  const onDisk = fs.readFileSync(cfgPath, 'utf8');
  Check('config.json 里没有 canary', onDisk.indexOf(CANARY) < 0);
  Check('config.json 里 apiKey 是空的', JSON.parse(onDisk).llm.apiKey === '');
}

// ④ 只留引用、秘密被删 → 不给假 ready，要给出原因
{
  spawnSync(SS, ['delete', '--provider', 'deepseek-official', '--root', ROOT], { encoding: 'utf8' });
  const cfg = loadConfig();
  Check('秘密缺失时 apiKey 为空（不冒充已配置）', cfg.llm.apiKey === '', 'len=' + cfg.llm.apiKey.length);
  Check('秘密缺失时给出原因', /没有|不存在|失败/.test(String(cfg.llm.apiKeyRefError || '')), String(cfg.llm.apiKeyRefError || '').slice(0, 80));
}

// ⑤ env: 引用也能用
{
  process.env.AS_TEST_CANARY_KEY = CANARY;
  writeCfg({ apiKeyRef: 'env:AS_TEST_CANARY_KEY' });
  const cfg = loadConfig();
  Check('env: 引用解析成功', cfg.llm.apiKey === CANARY, cfg.llm.apiKeySource);
  delete process.env.AS_TEST_CANARY_KEY;
  const cfg2 = loadConfig();
  Check('env: 变量缺失时明确报错', /环境变量/.test(String(cfg2.llm.apiKeyRefError || '')), String(cfg2.llm.apiKeyRefError || '').slice(0, 60));
}

// ⑥ 写法不对的引用必须报错，不猜
{
  const bad = resolveApiKeyRef('vault:whatever', ROOT);
  // 1.0.3: the message is a generic shape error and must not echo the input.
  Check('不认识的引用写法报错', bad.ok === false && /形状不合法|只认识/.test(bad.error), bad.error);
  Check('引用错误不含输入原文（1.0.3）', String(bad.error).indexOf('vault:whatever') < 0, bad.error.slice(0, 60));
  const ok = resolveApiKeyRef('dpapi:deepseek-official', ROOT);
  Check('引用解析返回的 source 不含秘密', String(ok.source) === 'dpapi:deepseek-official', ok.source);
}

// ⑦ 老配置（明文 apiKey）仍然兼容
{
  writeCfg({ apiKey: CANARY, apiKeyRef: '' });
  const cfg = loadConfig();
  Check('老配置 llm.apiKey 明文仍然生效（生产兼容）', cfg.llm.apiKey === CANARY, cfg.llm.apiKeySource);
  writeCfg({ apiKey: '', apiKeyRef: 'dpapi:deepseek-official' });
}

// cleanup
fs.rmSync(ROOT, { recursive: true, force: true });
Check('临时根已清理', !fs.existsSync(ROOT), ROOT);

Say('---');
Say('fails=' + fails);
fs.writeFileSync(path.join(EV, '99-dpapi.log'), log.join('\n') + '\n', 'utf8');
Say('evidence = ' + EV);
process.exit(fails ? 1 : 0);
