/**
 * echo-config.mjs —— 回声六层的唯一配置源
 *
 * 为什么要有这个文件：原实现把三个根目录写死在每个脚本里（共 14 处）。
 * 那份代码只在一台机器上活；要让别人装得起来，路径必须能配。
 *
 * ★ 一条设计硬规矩：**能推断的自动推，推不出来的报错停下 —— 不猜。**
 *   会话日志目录通常能从 DSH 环境推出来；书房和记忆中枢是每个人自己定的，
 *   猜错比不猜更坏（会把别人的记忆读到错的地方，而且不会报错）。
 *   这正是「装上了、没报错、但它没在工作」那个坑的解法：**让它在第一步就喊出来。**
 *
 * 优先级：环境变量 > echo.config.json > 推断 > 报错
 *
 * 环境变量：
 *   ECHO_SOUL     书房根           （例：D:\AI\yanqing-soul）
 *   ECHO_MEMORY   记忆中枢根       （例：D:\AI\memory）
 *   ECHO_SESSIONS 会话日志根       （例：D:\AI\dsh\home\sessions，不给则从 DSH_HOME 推）
 *
 * 或者放一个 echo.config.json 在脚本同目录 / 上级目录：
 *   { "soul": "...", "memory": "...", "sessions": "..." }
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function readConfigFile() {
  const candidates = [
    path.join(HERE, 'echo.config.json'),
    path.join(HERE, '..', 'echo.config.json'),
    path.join(HERE, '..', '..', 'echo.config.json'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return { ...j, __from: p };
      }
    } catch (e) {
      // 配置坏了要说出来，不能当没看见
      throw new Error(`echo.config.json 解析失败：${p}\n  ${e.message}`);
    }
  }
  return null;
}

const CFG = readConfigFile() || {};

function pick(envName, cfgKey) {
  const v = process.env[envName] || CFG[cfgKey];
  return v ? String(v).replace(/\\/g, '/').replace(/\/+$/, '') : null;
}

/** DSH 的 home（会话日志在 <home>/sessions） */
export function dshHome() {
  if (process.env.DSH_HOME) return String(process.env.DSH_HOME).replace(/\\/g, '/');
  const guess = path.join(os.homedir(), '.dsh');
  return fs.existsSync(guess) ? guess.replace(/\\/g, '/') : null;
}

export const SOUL = pick('ECHO_SOUL', 'soul');
export const MEM = pick('ECHO_MEMORY', 'memory');
export const SESSIONS = pick('ECHO_SESSIONS', 'sessions')
  || (dshHome() ? `${dshHome()}/sessions` : null);

/** ★ L1 热记忆（USER.md / MEMORY.md）不在书房里 —— 它属于运行时。
 *  默认跟 mnemon 运行时目录走，可以用 ECHO_RUNTIME 覆盖。 */
export const RUNTIME = (() => {
  const v = process.env.ECHO_RUNTIME || CFG.runtime;
  if (v) return String(v).replace(/\\/g, '/').replace(/\/+$/, '');
  const p = path.join(os.homedir(), '.mnemon', 'runtime');
  return p.replace(/\\/g, '/');
})();

export const HUB = MEM ? `${MEM}/hub` : null;
export const INDEX = HUB ? `${HUB}/index` : null;
export const LEDGER = SOUL ? `${SOUL}/02-墨.jsonl` : null;
export const SELF_SRC = HUB ? `${HUB}/SELF.src.md` : null;
export const SELF_OUT = HUB ? `${HUB}/SELF.md` : null;
export const STATE = HUB ? `${HUB}/state.json` : null;

/** 三个根各自「必需吗」——sessions 可以缺（那就只能搜《墨》和书房） */
const REQUIRED = [
  ['SOUL', SOUL, 'ECHO_SOUL', 'soul', '书房根（《墨》和十份 soul 文档在它下面）'],
  ['MEM', MEM, 'ECHO_MEMORY', 'memory', '记忆中枢根（索引、SELF、检索工具在它下面）'],
];

/**
 * 校验并给出人类看得懂的报错。
 * @param {{allowMissingSessions?: boolean}} opt
 * @returns {{ok: boolean, problems: string[], hints: string[]}}
 */
export function checkConfig(opt = {}) {
  const problems = [];
  const hints = [];

  for (const [name, val, envName, cfgKey, desc] of REQUIRED) {
    if (!val) {
      problems.push(`没有配置 ${name}（${desc}）`);
      hints.push(`  设环境变量 ${envName}，或在 echo.config.json 里写 "${cfgKey}": "<路径>"`);
    } else if (!fs.existsSync(val)) {
      problems.push(`${name} 指向的目录不存在：${val}`);
      hints.push(`  检查 ${envName} 是不是写错了；目录要先建出来`);
    }
  }

  if (!SESSIONS && !opt.allowMissingSessions) {
    problems.push('没有配置 SESSIONS（会话日志根）');
    hints.push('  设 ECHO_SESSIONS，或设 DSH_HOME（会话日志默认在 <DSH_HOME>/sessions）');
  } else if (SESSIONS && !fs.existsSync(SESSIONS) && !opt.allowMissingSessions) {
    problems.push(`SESSIONS 指向的目录不存在：${SESSIONS}`);
    hints.push('  刚装好、还没有会话日志是正常的；跑出第一条会话之后它才会有');
  }

  return { ok: problems.length === 0, problems, hints };
}

/**
 * ★ 和 checkConfig 不同：**缺了就直接退出，并把怎么办打在脸上。**
 * 所有脚本在动手之前都该先调它。宁可第一步就炸，也不要跑到一半静默写错地方。
 */
export function requireConfig(opt = {}) {
  const r = checkConfig(opt);
  if (r.ok) return r;
  const lines = [
    '',
    '回声没有配置好，停在这里（不会静默继续）：',
    ...r.problems.map((p) => `  ✗ ${p}`),
    '',
    '怎么办：',
    ...r.hints,
    '',
    `配置文件位置（任选其一）：${path.join(HERE, 'echo.config.json')}`,
    '',
  ];
  if (process.env.ECHO_ALLOW_UNCONFIGURED === '1') {
    console.error(lines.join('\n') + '\n  （ECHO_ALLOW_UNCONFIGURED=1，继续跑，但结果可能不对）\n');
    return r;
  }
  console.error(lines.join('\n'));
  process.exit(2);
}

/** 给 doctor / 面板用：现在到底在读哪几个目录 */
export function describe() {
  return {
    soul: SOUL,
    memory: MEM,
    hub: HUB,
    index: INDEX,
    ledger: LEDGER,
    sessions: SESSIONS,
    from: CFG.__from || (process.env.ECHO_SOUL || process.env.ECHO_MEMORY ? '环境变量' : '推断'),
  };
}

/** 一个小工具：目录不存在就建（幂等） */
export function ensureDir(p) {
  if (p && !fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  return p;
}
