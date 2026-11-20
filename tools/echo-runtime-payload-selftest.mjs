#!/usr/bin/env node
// tools/echo-runtime-payload-selftest.mjs -- v4 ECHO runtime payload gap self-test · TEMP ONLY
// ============================================================================
// 钉住一件事：版本化载荷（dist\AgentSoul\app\<version>）里，
// src/db/echo.mjs 的**运行时** importer 真的解析得到。
//
// 缺口本体：src/db/echo.mjs 写的是
//     import { ... } from '../../tools/echo-index-import.mjs';
// 而 dist.ps1 原来只把 src\ 整棵树 + tools\soul-sync.mjs 拷进版本目录，于是
// <version>\tools\echo-index-import.mjs 根本不存在 —— 装完之后 ECHO 面
// （search / ptr / stats）第一次被用到才炸，构建期一声不响。
//
// 三组断言：
//   S  源码事实：说明符字面量、静态闭包、闭包成员位置、外部说明符
//   D  构建脚本：dist.ps1 逐条静态读（只读文本，不执行它）
//   R  真解析：按版本目录布局在 TEMP 里 stage 出来，再动态 import
//
// ★ 全程只碰 os.tmpdir() 下本次新建的根；不读不写 data/、库、索引、会话、日志。
// ★ 本文件不打开任何数据库：只 import 模块，连 node:sqlite 都不加载（R7 断言它）。
// ★ 跑法：node tools/echo-runtime-payload-selftest.mjs   （退出码 0 = 全绿）
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DIST_PS1 = path.join(REPO, 'build', 'pack', 'dist.ps1');
const ECHO_REL = 'src/db/echo.mjs';
const IMPORTER_REL = 'tools/echo-index-import.mjs';
const IMPORTER_SPECIFIER = '../../tools/echo-index-import.mjs';
const ECHO_SRC = abs(REPO, ECHO_REL);
const IMPORTER_SRC = abs(REPO, IMPORTER_REL);

const ok = [];
const bad = [];

function t(name, cond, detail) {
  const pass = cond === true;
  (pass ? ok : bad).push((pass ? 'ok   ' : 'FAIL ') + name + (detail === undefined || detail === null ? '' : '  -> ' + String(detail)));
  return pass;
}

function abs(base, rel) { return path.join(base, rel.split('/').join(path.sep)); }
function toPosix(p) { return p.split('\\').join('/'); }

// ---- 静态闭包（只读源码文本）------------------------------------------------
const SPEC_RE = /(?:^|\n)[ \t]*(?:import|export)[ \t][^;]*?\bfrom[ \t]*['"]([^'"]+)['"]/g;
const BARE_RE = /(?:^|\n)[ \t]*import[ \t]*['"]([^'"]+)['"]/g;

function specifiersOf(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  let m;
  SPEC_RE.lastIndex = 0;
  while ((m = SPEC_RE.exec(text)) !== null) out.push(m[1]);
  BARE_RE.lastIndex = 0;
  while ((m = BARE_RE.exec(text)) !== null) out.push(m[1]);
  return out;
}

function collectClosure(entryAbs) {
  const members = new Map();
  const externals = new Set();
  const missing = [];
  const queue = [entryAbs];
  while (queue.length > 0) {
    const fileAbs = path.resolve(queue.shift());
    if (members.has(fileAbs)) continue;
    members.set(fileAbs, toPosix(path.relative(REPO, fileAbs)));
    for (const spec of specifiersOf(fileAbs)) {
      if (spec.charAt(0) !== '.') { externals.add(spec); continue; }
      const target = path.resolve(path.dirname(fileAbs), spec);
      if (!fs.existsSync(target)) {
        missing.push(toPosix(path.relative(REPO, fileAbs)) + ' -> ' + spec);
        continue;
      }
      queue.push(target);
    }
  }
  return { members: [...members.values()].sort(), externals: [...externals].sort(), missing };
}

// ---- S. 源码事实 ------------------------------------------------------------
const echoSource = fs.readFileSync(ECHO_SRC, 'utf8');
t('S1 src/db/echo.mjs 里的 importer 说明符仍是 ' + IMPORTER_SPECIFIER,
  echoSource.indexOf(IMPORTER_SPECIFIER) !== -1);

const closure = collectClosure(ECHO_SRC);
t('S2 静态闭包到达 ' + IMPORTER_REL, closure.members.indexOf(IMPORTER_REL) !== -1,
  closure.members.length + ' files');
t('S3 闭包里每个相对说明符都能解析', closure.missing.length === 0, closure.missing.join(' | '));

const outside = closure.members.filter(function (r) { return r !== IMPORTER_REL && r.indexOf('src/db/') !== 0; });
t('S4 除 importer 外闭包成员都在 src/db/ 下', outside.length === 0, outside.join(', '));

const notBuiltin = closure.externals.filter(function (s) { return s.indexOf('node:') !== 0; });
t('S5 闭包的外部说明符只有 node: 内建', notBuiltin.length === 0, closure.externals.join(', '));

// ---- D. 构建脚本（静态读，不执行）-------------------------------------------
t('D1 build/pack/dist.ps1 存在', fs.existsSync(DIST_PS1));

const ps1 = fs.readFileSync(DIST_PS1, 'utf8');
const nonAscii = [];
for (let i = 0; i < ps1.length; i += 1) {
  if (ps1.charCodeAt(i) > 126) {
    nonAscii.push(ps1.slice(Math.max(0, i - 24), i + 24).replace(/\r?\n/g, ' '));
    if (nonAscii.length > 2) break;
  }
}
t('D2 dist.ps1 全 ASCII（PowerShell 5.1 按 GBK 读无 BOM 文件）', ps1.length > 0 && nonAscii.length === 0,
  nonAscii.join(' | '));

const crlfCount = (ps1.match(/\r\n/g) || []).length;
const newlineCount = (ps1.match(/\n/g) || []).length;
t('D3 dist.ps1 全 CRLF（没有 LF-only 行）', crlfCount > 0 && crlfCount === newlineCount,
  'crlf=' + crlfCount + ' newlines=' + newlineCount);

const srcAssign = /^\$echoImporterSrc[ \t]*=[ \t]*Join-Path[ \t]+\$repo[ \t]+"([^"]+)"/m.exec(ps1);
const dstAssign = /^\$echoImporterDst[ \t]*=[ \t]*Join-Path[ \t]+\$verDir[ \t]+"([^"]+)"/m.exec(ps1);
t('D4 dist.ps1 从 $repo 取源、写进 $verDir 的目标', srcAssign !== null && dstAssign !== null,
  (srcAssign ? srcAssign[1] : 'no source') + ' -> ' + (dstAssign ? dstAssign[1] : 'no dest'));

const expectedRel = path.posix.normalize(path.posix.join(path.posix.dirname(ECHO_REL), IMPORTER_SPECIFIER));
const dstLiteral = dstAssign === null ? '(none)' : toPosix(dstAssign[1]);
t('D5 目标相对路径 == 说明符从 src/db/ 解析出的路径',
  dstLiteral === expectedRel, 'dst=' + dstLiteral + ' expected=' + expectedRel);

const srcLiteral = srcAssign === null ? '(none)' : toPosix(srcAssign[1]);
t('D6 源相对路径与载荷内路径一致', srcLiteral === expectedRel, 'src=' + srcLiteral);

t('D7 dist.ps1 用 Copy-PayloadFile 拷 importer',
  ps1.indexOf('Copy-PayloadFile $echoImporterSrc $echoImporterDst') !== -1);

const guards = ['payload-missing:', 'payload-hash-mismatch:', 'payload-path-mismatch:'];
const absent = guards.filter(function (g) { return ps1.indexOf(g) === -1; });
t('D8 三道 fail-fast：缺件 / 哈希不符 / 源相对路径不符', absent.length === 0, absent.join(', '));

t('D9 头部布局注释声明了版本目录里的 importer',
  ps1.indexOf('<Out>\\app\\<Version>\\tools\\echo-index-import.mjs') !== -1);

// ---- R. 真解析（TEMP 里按版本目录布局 stage）--------------------------------
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-soul-echo-payload-'));
const stageFull = path.join(tempRoot, 'staged-root', 'AgentSoul', 'app', '0.0.0-selftest');
const stageBroken = path.join(tempRoot, 'broken-root', 'AgentSoul', 'app', '0.0.0-selftest');

function stageInto(root, members, skip) {
  const copied = [];
  for (const rel of members) {
    if (skip && skip.indexOf(rel) !== -1) continue;
    const to = abs(root, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(abs(REPO, rel), to);
    copied.push(rel);
  }
  return copied;
}

function sqliteFilesUnder(root) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(p);
      else if (/\.sqlite$/i.test(entry.name)) found.push(p);
    }
  }
  return found;
}

try {
  const copied = stageInto(stageFull, closure.members, []);
  const missingFull = closure.members.filter(function (r) { return !fs.existsSync(abs(stageFull, r)); });
  t('R1 全量 stage 无缺件', missingFull.length === 0 && copied.length === closure.members.length,
    copied.length + ' files');

  // 探针：站在 staged 的 src/db/ 里问——说明符到底解析到哪一份
  const probePath = abs(stageFull, 'src/db/_echo-importer-resolve-probe.mjs');
  fs.writeFileSync(probePath, "export const resolved = import.meta.resolve('" + IMPORTER_SPECIFIER + "');\n", 'utf8');
  const probe = await import(pathToFileURL(probePath).href);
  const expectedUrl = pathToFileURL(abs(stageFull, IMPORTER_REL)).href;
  t('R2 importer 在版本布局里解析到 <version>/tools/echo-index-import.mjs',
    probe.resolved === expectedUrl, probe.resolved);

  const stagedEcho = await import(pathToFileURL(abs(stageFull, ECHO_REL)).href);
  t('R3 动态 import staged src/db/echo.mjs 成功', typeof stagedEcho.searchEcho === 'function',
    abs(stageFull, ECHO_REL));

  const ECHO_EXPECTED = {
    searchEcho: 'function',
    searchEchoSurface: 'function',
    openEchoPtr: 'function',
    echoStatsFor: 'function',
    assertEchoAligned: 'function',
    normalizeEchoTerms: 'function',
    EchoImportRefusal: 'function',
    ECHO_SURFACES: 'object',
    ECHO_SEARCH_LIMIT_MAX: 'number',
    ECHO_SEARCH_LIMIT_DEFAULT: 'number',
    ECHO_PTR_NAMESPACES: 'object',
    ECHO_SUMMARY_PTR_PREFIX: 'string',
  };
  const echoWrongType = Object.keys(ECHO_EXPECTED).filter(function (k) {
    return typeof stagedEcho[k] !== ECHO_EXPECTED[k];
  });
  t('R4 staged ECHO 面导出齐全且类型正确', echoWrongType.length === 0, echoWrongType.join(', '));

  const stagedImporter = await import(pathToFileURL(abs(stageFull, IMPORTER_REL)).href);
  const repoImporter = await import(pathToFileURL(IMPORTER_SRC).href);
  t('R5 同一实例：echo 绑的是 staged importer，不是仓库那份',
    stagedEcho.EchoImportRefusal === stagedImporter.EchoImportRefusal &&
    stagedEcho.EchoImportRefusal !== repoImporter.EchoImportRefusal);

  const IMPORTER_EXPECTED = ['IMPORTER_VERSION', 'ECHO_INDEX_VERSION_RE', 'ECHO_REASONING_KINDS',
    'ECHO_WORD_FIELDS', 'ECHO_SUMMARY_FIELDS', 'ECHO_SUMMARY_STATUSES', 'ECHO_SEARCH_BATCH', 'EXIT',
    'EchoImportRefusal', 'parseEchoPtr', 'resolveEchoPtr', 'echoIndexInfoFor', 'verifyEchoIntegrity',
    'listEchoSources', 'searchEchoWords', 'searchEchoSummaries', 'parseJsonl', 'V9_REQUIRED_SCHEMA', 'runImport'];
  const importerMissing = IMPORTER_EXPECTED.filter(function (k) { return !(k in stagedImporter); });
  t('R6 staged importer 可独立 import 且契约成员齐全', importerMissing.length === 0, importerMissing.join(', '));

  const loadList = Array.isArray(process.moduleLoadList) ? process.moduleLoadList : [];
  const sqliteLoads = loadList.filter(function (n) { return String(n).toLowerCase().indexOf('sqlite') !== -1; });
  t('R7 导入过程没有加载 node:sqlite', sqliteLoads.length === 0,
    'loadList=' + loadList.length + ' sqlite=' + sqliteLoads.length);

  const dbFiles = sqliteFilesUnder(stageFull);
  t('R8 stage 里没有生成任何 .sqlite 文件', dbFiles.length === 0, dbFiles.join(', '));

  stageInto(stageBroken, closure.members, [IMPORTER_REL]);
  const missingBroken = closure.members.filter(function (r) { return !fs.existsSync(abs(stageBroken, r)); });
  t('R9 缺件 stage 只报缺 ' + IMPORTER_REL,
    missingBroken.length === 1 && missingBroken[0] === IMPORTER_REL, missingBroken.join(', '));

  let brokenErr = null;
  try {
    await import(pathToFileURL(abs(stageBroken, ECHO_REL)).href);
  } catch (err) {
    brokenErr = err;
  }
  t('R10 缺 importer 时 staged echo.mjs 的 import 必须失败（缺口不许静默出厂）',
    brokenErr !== null && brokenErr.code === 'ERR_MODULE_NOT_FOUND' &&
    String(brokenErr.message).indexOf('echo-index-import.mjs') !== -1,
    brokenErr === null ? 'no error raised' : String(brokenErr.code));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

t('R11 清场：temp 根已删除', !fs.existsSync(tempRoot), tempRoot);

// ---- 汇总 -------------------------------------------------------------------
console.log('---- echo runtime payload selftest ----');
for (const line of ok) console.log(line);
for (const line of bad) console.log(line);
console.log('closure = ' + closure.members.length + ' files');
console.log('checks = ' + (ok.length + bad.length) + '  pass = ' + ok.length + '  fail = ' + bad.length);
process.exitCode = bad.length === 0 ? 0 : 1;
