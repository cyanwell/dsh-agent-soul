// 可移植数据根 —— 「内置六层、外置数据」的落地实现。
//
// ★★ 要解决的真问题（爀曦 2026-11-17）：
//   别人装上之后，程序不该带着开发机的绝对路径跑，也不该要求用户手工建库、建账本、建索引。
//   一句话：**装完就能用，且用的是他自己的空记忆，不是我的。**
//
// ★ 为什么数据不放进程序目录（这是我和爰曦讨论后仍然坚持的一条）：
//   · Program Files 不可写 —— 写库会直接失败；
//   · 更新程序会覆盖程序目录 —— 那等于把用户的记忆一起冲掉；
//   · 生产库 5.8 GB，打进安装包不现实。
//   所以：**内嵌的是「怎么建」（种子模板），外置的是「建在哪」（用户数据根）。**
//
// ★★ 六层里什么该内嵌、什么绝不能内嵌：
//   L0 时钟/心跳  → 只内嵌脚本与目录结构，**不内嵌 state.json**（那是实时状态）
//   L1 SELF       → 内嵌 \`SELF.src.md\` 骨架，**不内嵌 SELF.md 成品**（成品是渲染结果，拷过去就是旧快照）
//   L1 热记忆     → 只建**空模板**（用户的记忆必须是自己的）
//   L2 工作台     → 不涉及磁盘
//   L3 一手层     → 只建**空库与空账本**（我的 787 条墨、1828 个会话日志是我的私有数据，绝不进别人安装包）
//   L4 索引       → **不内嵌**，首次运行后由 L3 生成（索引是派生数据）
//   L5 检索       → 内嵌脚本（纯代码，无私有数据）

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 程序根（exe 解压处 / 安装目录）。 */
export function programRoot() {
  const env = process.env.AGENT_SOUL_HOME;
  if (env && fs.existsSync(env)) return path.resolve(env);
  // 本模块在 <root>/src/portable.mjs
  return path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

/** 种子目录：程序里随包带的那份「怎么建」。 */
export function seedDir(root = programRoot()) {
  return path.join(root, 'seed');
}

function writableDir(p) {
  try {
    fs.mkdirSync(p, { recursive: true });
    const probe = path.join(p, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

/**
 * 数据根。优先级：
 *   ① AGENT_SOUL_DATA（用户显式指定，最高）
 *   ② <程序根>/data —— **仅当它可写**（便携版、绿色版、开发机）
 *   ③ %LOCALAPPDATA%/agent-soul/data —— 装到 Program Files 时的正规位置
 *
 * ★ ② 先试再定，不写死：同一个程序放到 U 盘里能跑，装进 Program Files 也能跑。
 * ★ 判据必须落到「真的写进去一次」，不能只看 existsSync —— 目录存在但只读是常见情形。
 */
export function resolveDataRoot(root = programRoot()) {
  const env = process.env.AGENT_SOUL_DATA;
  if (env) {
    const p = path.resolve(env);
    fs.mkdirSync(p, { recursive: true });
    return { dir: p, source: 'env', writable: true };
  }
  const local = path.join(root, 'data');
  if (writableDir(local)) return { dir: local, source: 'program', writable: true };
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const fallback = path.join(base, 'agent-soul', 'data');
  fs.mkdirSync(fallback, { recursive: true });
  return { dir: fallback, source: 'localappdata', writable: true, programUnwritable: true };
}
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }

function copyIfMissing(srcFile, dstFile, log) {
  if (!fs.existsSync(srcFile)) return { copied: false, reason: 'seed-missing' };
  if (fs.existsSync(dstFile)) return { copied: false, reason: 'already-present' };
  ensureDir(path.dirname(dstFile));
  fs.copyFileSync(srcFile, dstFile);
  if (log) log('seeded ' + dstFile);
  return { copied: true };
}

/**
 * 首次运行把「六层」建出来。**幂等** —— 已存在的文件一个字都不动。
 *
 * ★ 只建「怎么建」，不带任何私有数据：
 *   · L0：hub/ 目录 + 空的 state 位（不写 state.json，它由 heartbeat 自己维护）
 *   · L1：hub/SELF.src.md（**不变量骨架**）+ 空的 USER.md / MEMORY.md 模板
 *         ★ 绝不拷 SELF.md —— 那是 self.mjs 的渲染成品，拷过去就是永久旧快照
 *   · L2：无（会话本身）
 *   · L3：空库（跑 migrations）+ 空的 02-墨.jsonl
 *   · L4：hub/index/ 空目录（索引是派生物，首次运行后由 L3 生成）
 *   · L5：hub/ 里的脚本由程序自带，不复制到数据目录
 */
export function bootstrapDataRoot(dataRoot, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : null;
  const seed = opts.seedDir || seedDir();
  const created = [];
  const skipped = [];

  const mark = (kind, what) => { (kind === 'created' ? created : skipped).push(what); };

  // 目录骨架
  for (const d of ['', 'hub', 'hub/index', 'hub/heartbeat', 'ledger', 'voice-cache', 'events']) {
    const p = d ? path.join(dataRoot, d) : dataRoot;
    if (!fs.existsSync(p)) { ensureDir(p); mark('created', 'dir:' + (d || '.')); } else mark('skipped', 'dir:' + (d || '.'));
  }

  // L1：SELF 不变量骨架（只此一份，不碰 SELF.md）
  const selfSeed = copyIfMissing(path.join(seed, 'SELF.src.md'), path.join(dataRoot, 'hub', 'SELF.src.md'), log);
  mark(selfSeed.copied ? 'created' : 'skipped', 'hub/SELF.src.md:' + (selfSeed.copied ? 'copied' : selfSeed.reason));

  // L1：热记忆空模板（用户的记忆必须是自己的）
  for (const name of ['USER.md', 'MEMORY.md']) {
    const dst = path.join(dataRoot, 'hub', name);
    if (!fs.existsSync(dst)) {
      fs.writeFileSync(dst, '', 'utf8');
      mark('created', 'hub/' + name + ':empty');
    } else mark('skipped', 'hub/' + name);
  }

  // L3：空的墨（只追加的账本）
  const ledgerFile = path.join(dataRoot, 'ledger', '02-墨.jsonl');
  if (!fs.existsSync(ledgerFile)) { fs.writeFileSync(ledgerFile, '', 'utf8'); mark('created', 'ledger/02-墨.jsonl:empty'); }
  else mark('skipped', 'ledger/02-墨.jsonl');

  return { dataRoot, seedDir: seed, created, skipped, ledgerFile };
}

/** 安装标记：记录这次是哪版程序建的库，便于更新时判断要不要补迁移。 */
export function writeInstallMarker(dataRoot, info = {}) {
  const p = path.join(dataRoot, 'install.json');
  const prev = (() => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } })();
  const next = {
    schemaVersion: info.schemaVersion == null ? null : Number(info.schemaVersion),
    firstInstalledAt: (prev && prev.firstInstalledAt) || new Date().toISOString(),
    lastStartedAt: new Date().toISOString(),
    programRoot: programRoot(),
    nodeVersion: process.version,
  };
  fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}
