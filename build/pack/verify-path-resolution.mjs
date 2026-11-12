// verify-path-resolution.mjs —— R1 的行为自证：同一个模块在「开发机」和「分发版」下拿到不同路径。
//
// 为什么必须有它：R1 改的是**默认值**，而默认值"看不出来" —— 静态扫描只能证明字面量少了，
//   证明不了"分发版不会去读开发机目录"。所以这里把两条判据都跑一遍，一条一条断言。
//
// 用法：
//   node build\pack\verify-path-resolution.mjs            # 全部用例
//   node build\pack\verify-path-resolution.mjs --json     # 机器可读
//
// 退出码：0 = 全部通过；1 = 有断言失败。
// ★ 不读生产 config.json：分发版用例用的是 config.release.json 的副本。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const SRC = path.join(REPO, 'src');
const JSON_OUT = process.argv.includes('--json');

const DEV_STATUS_DIR = 'D:/AI/yanqing-soul/30-状态';
const rows = [];
function t(name, cond, detail) { rows.push({ name, ok: !!cond, detail: detail === undefined ? null : String(detail) }); }

// ── 造一个「安装根」（分发版的形状：<安装根>\workspace + config.json）────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsoul-pathcheck-'));
const install = path.join(tmp, 'install');
fs.mkdirSync(path.join(install, 'workspace'), { recursive: true });
fs.copyFileSync(path.join(REPO, 'config.release.json'), path.join(install, 'config.json'));

// ★ 环境变量只影响本进程：先清干净，再指向临时安装根。
delete process.env.AGENT_SOUL_STATUS_DIR;
delete process.env.AGENT_SOUL_PRUNER_CONTRACT;
delete process.env.AGENT_SOUL_DATA;
// ★ 本机（DSH 宿主）设了 DSH_HOME —— 不清掉它，下面「开发目录不存在」的分支根本走不到，
//   断言会被环境变量骗成一个假通过（第一版就是这么错的）。
delete process.env.DSH_HOME;
process.env.AGENT_SOUL_HOME = install;

const imp = (rel) => import(pathToFileURL(path.join(SRC, rel)).href);
const cfgMod = await imp('config.mjs');
const sdMod = await imp('web/status-data.mjs');

// ── 1 · 分发版：config.statusDir 相对路径 → 安装根/workspace ─────────────────────────
const distCfg = cfgMod.loadConfig(path.join(install, 'config.json'));
t('分发版 loadConfig 把 statusDir 解析到安装根',
  distCfg.statusDir === path.join(install, 'workspace'), distCfg.statusDir);
t('分发版 statusDirOf() == 安装根/workspace',
  cfgMod.statusDirOf(distCfg) === path.join(install, 'workspace'), cfgMod.statusDirOf(distCfg));
t('分发版 statusDirOf() 不指向开发机目录',
  !String(cfgMod.statusDirOf(distCfg)).startsWith('D:/AI/'), cfgMod.statusDirOf(distCfg));
t('分发版 apiKey 为空串（发布夹具自证，只报长度）',
  typeof distCfg.llm.apiKey === 'string' && distCfg.llm.apiKey.length === 0, 'len=' + String(distCfg.llm.apiKey).length);

// ── 2 · 生产机（开发机）未设 env：保持原默认 ────────────────────────────────────────
t('开发机不配 statusDir 时回落到原开发默认（目录存在）',
  cfgMod.statusDirOf({}) === DEV_STATUS_DIR, cfgMod.statusDirOf({}));

// ── 3 · 显式 soul.root 优先 ─────────────────────────────────────────────────────────
const fakeSoul = path.join(tmp, 'soul');
fs.mkdirSync(fakeSoul, { recursive: true });
t('配了 soul.root 就用 <root>/30-状态',
  cfgMod.statusDirOf({ soul: { root: fakeSoul } }) === path.join(fakeSoul, '30-状态'),
  cfgMod.statusDirOf({ soul: { root: fakeSoul } }));

// ── 4 · 环境变量 ───────────────────────────────────────────────────────────────────
process.env.AGENT_SOUL_STATUS_DIR = path.join(tmp, 'envstatus');
t('AGENT_SOUL_STATUS_DIR 生效（config 未给 statusDir）',
  cfgMod.statusDirOf({}) === path.join(tmp, 'envstatus'), cfgMod.statusDirOf({}));
delete process.env.AGENT_SOUL_STATUS_DIR;

// ── 5 · ★ 「开发目录不存在」这条分支：改 DEV_PATHS 的属性（同一函数体，不换实现）────
//    分发版机器上 D:/AI/... 不存在 —— 这里把那份表里的一项指到一个不存在的路径，
//    devPathOr() 必须返回 fallback，而不是把不存在的路径当默认值。
const keep = cfgMod.DEV_PATHS.statusDir;
cfgMod.DEV_PATHS.statusDir = 'D:/AI/__definitely_missing_R1__/30-状态';
t('开发目录不存在 → devPathOr 返回 fallback',
  cfgMod.devPathOr('statusDir', path.join(install, 'workspace')) === path.join(install, 'workspace'),
  cfgMod.devPathOr('statusDir', path.join(install, 'workspace')));
t('开发目录不存在 → statusDirOf 不返回缺失的开发路径',
  cfgMod.statusDirOf({}) === path.join(install, 'workspace'), cfgMod.statusDirOf({}));
cfgMod.DEV_PATHS.statusDir = keep;

// ── 6 · 外部可选依赖（pruner 契约）：文件不存在 → 空串，不是开发机路径 ──────────────
const keepC = cfgMod.DEV_PATHS.prunerContract;
cfgMod.DEV_PATHS.prunerContract = 'D:/AI/__definitely_missing_R1__/context-contract.mjs';
t('契约文件不存在 → devFileOr 返回空串',
  cfgMod.devFileOr('prunerContract', '') === '', JSON.stringify(cfgMod.devFileOr('prunerContract', '')));
cfgMod.DEV_PATHS.prunerContract = keepC;

// ── 7 · status-data 的 DSH 投影目录：只会跟着安装根走 ──────────────────────────────
const proj = sdMod.projcacheDirOf({ dshHome: path.join(install, 'dsh-home') });
t('projcacheDirOf 跟着显式 dshHome 走', proj === path.join(install, 'dsh-home', 'storages', 'session_projcache', 'sessions'), proj);
// ★ 这一条一开始写成 startsWith 判断，被自己的反斜杠骗过去了（假通过）。
//   现在改成对分支本身下断言：把开发 DSH home 指到不存在的路径，投影目录必须落到安装根。
const keepD = cfgMod.DEV_PATHS.dshHome;
cfgMod.DEV_PATHS.dshHome = 'D:/AI/__definitely_missing_R1__/dsh/home';
const projFallback = sdMod.projcacheDirOf({});
t('开发 DSH home 不存在 → 投影目录落在 <安装根>/workspace/dsh-home',
  projFallback === path.join(install, 'workspace', 'dsh-home', 'storages', 'session_projcache', 'sessions'),
  projFallback);
cfgMod.DEV_PATHS.dshHome = keepD;

process.env.DSH_HOME = path.join(install, 'env-dsh-home');
t('DSH_HOME 环境变量优先（装了 DSH 的用户机）',
  sdMod.projcacheDirOf({}) === path.join(install, 'env-dsh-home', 'storages', 'session_projcache', 'sessions'),
  sdMod.projcacheDirOf({}));
delete process.env.DSH_HOME;

// ── 8 · 会话 cwd 的默认值（服务端与页面共享的判据）────────────────────────────────
//    server.mjs 的 /api/sessions POST 用 config.workspace || <appRoot>/workspace。
const cwdDefault = distCfg.workspace || path.join(cfgMod.appRoot(), 'workspace');
t('分发版新建会话 cwd 落在安装根内', String(cwdDefault).startsWith(install), cwdDefault);

fs.rmSync(tmp, { recursive: true, force: true });

const bad = rows.filter((r) => !r.ok);
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: bad.length === 0, total: rows.length, failed: bad.length, rows }, null, 2));
} else {
  for (const r of rows) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? '  ::  ' + r.detail : ''));
  console.log('---');
  console.log('total=' + rows.length + ' failed=' + bad.length);
}
process.exit(bad.length === 0 ? 0 : 1);
