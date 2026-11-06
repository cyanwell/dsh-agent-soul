// 配置：一个 JSON 文件 + 环境变量覆盖。
// ★ 不读任何外部系统的凭据文件 —— key 由使用者自己填进 config.json 或环境变量。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/**
 * 默认值 —— **唯一的真源**。
 *
 * ★ 2026-11-07 扩到八组：原来只有 llm / context / persona / 三个顶层标量，
 *   而 events / organs / autonomy / soul 的默认值散在 index.mjs 与 server.mjs 的
 *   `|| 60000` 这样的兜底里。参数页要显示「默认」——散着写就意味着**页面上那个数
 *   和程序真正兜底的那个数会各走各的**。
 *   收进来的这四组，数值与各处原有的兜底**逐个对过**，行为不变。
 *
 * ★ 导出（export）是给 /api/config 用的：页面要能说「这一项默认是几」。
 */
export const DEFAULTS = {
  dataDir: path.join(ROOT, 'data'),
  workspace: null,                 // null = 用 appRoot()（见 index.mjs）
  host: '127.0.0.1',
  port: 7310,

  // LLM：默认走 DeepSeek 官方 OpenAI 兼容端点
  llm: {
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    maxTokens: 4096,
    temperature: 0.7,
  },

  // 上下文：不做压缩，只按「最近 N 帧」截断（索引不参与上下文组装）
  context: {
    maxFrames: 60,
    windowTokens: 1048576,         // 水位百分比的分母
  },

  // 人格层：指向书房或任意 markdown
  persona: {
    files: [],
    budget: 80000,                 // 字节上限；超了按 tier 从低到高裁
  },

  // 事件层
  events: {
    intervalMs: 60000,
    silenceMs: 900000,             // 会话静默多久记一条事件（15 分钟）
    session: null,
  },

  // 器官
  organs: {
    huanqi: { enabled: true, stallThreshold: 3 },
  },

  // 自主循环——★ 默认关着。要它自己动，得明确打开
  autonomy: {
    enabled: false,
    idleThresholdMinutes: 15,
    maxRunsPerDay: 24,
    quietHours: null,              // [起, 止]，如 [2, 7]
    ignoreSessions: [],
  },

  // 热记忆探针
  // ★ 默认 null —— 路径通常不在任何「惯例位置」，老版自己就写着
  //   「默认路径在仓库布局下不存在」。所以：调用方给就用，不给就回落
  //   环境变量 MNEMON_RUNTIME，再不行才用 ~/.mnemon/runtime。
  mnemon: {
    runtimeDir: null,
  },

  // 日记
  // ★ 默认 null —— 和书房同一条判据：**没配就是不配**。
  //   老版踩过的坑：默认 join(cwd,'diary')，而进程 cwd 是安装目录，
  //   那底下没有 diary/ → 接口静默返回 [] → 界面上写「还没有日记」。
  //   **装上、界面在、里面空的** —— 空列表和读不到必须能分开。
  diary: {
    dir: null,
    maxSnippet: 200,
  },

  // 书房
  // ★ root 默认 null —— 2026-11-07 改。原来写死 'D:/AI/yanqing-soul'，
  //   于是发布版带着开发机的 1657 个文件一起走。**没配就是不配**，
  //   器官卡会显示「未配置」，而不是替用户指一个不存在的目录。
  soul: {
    root: null,
    ttl: 5000,                     // 书房索引的重扫时间窗
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

/**
 * 应用根目录。
 *
 * ★ 这个函数解决一个真问题：开发时根是 D:/AI/agent-soul，
 *   而 exe 版解压到 %LOCALAPPDATA%\agent-soul —— 两边都得对。
 *   判据：谁是「src/ 的上一级」谁就是根，除非 AGENT_SOUL_HOME 明说了。
 */
export function appRoot() {
  const env = process.env.AGENT_SOUL_HOME;
  if (env && fs.existsSync(env)) return path.resolve(env);
  return ROOT;
}

/**
 * 配置里的路径解析。
 * ★ 允许写相对路径 —— 相对的是 appRoot()，这样同一个 config.json
 *   在开发目录和 %LOCALAPPDATA% 下都能指向各自的那份数据。
 *   绝对路径原样返回（开发时我用的是绝对路径，不改它）。
 */
export function resolvePath(p, root = appRoot()) {
  if (!p || typeof p !== 'string') return p;
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p)) return p;   // 绝对路径
  return path.join(root, p);
}

export function loadConfig(file = path.join(appRoot(), 'config.json')) {
  let cfg = structuredClone(DEFAULTS);
  if (fs.existsSync(file)) {
    try { cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (e) { throw new Error('config.json 解析失败: ' + e.message); }
  }
  // 环境变量优先
  if (process.env.AGENT_SOUL_KEY) cfg.llm.apiKey = process.env.AGENT_SOUL_KEY;
  if (process.env.AGENT_SOUL_BASE_URL) cfg.llm.baseUrl = process.env.AGENT_SOUL_BASE_URL;
  if (process.env.AGENT_SOUL_MODEL) cfg.llm.model = process.env.AGENT_SOUL_MODEL;
  if (process.env.AGENT_SOUL_PORT) cfg.port = Number(process.env.AGENT_SOUL_PORT);
  if (process.env.AGENT_SOUL_DATA) cfg.dataDir = process.env.AGENT_SOUL_DATA;

  // ★ 2026-11-07：dataDir / workspace 走相对路径解析，发布版才不会指回开发目录。
  //   config.json 里写 "data" 就落在 appRoot()/data；
  //   写绝对路径（开发时）就原样用 —— 两种都对。
  cfg.dataDir = resolvePath(cfg.dataDir);
  if (cfg.workspace) cfg.workspace = resolvePath(cfg.workspace);
  if (Array.isArray(cfg.persona?.files)) {
    cfg.persona.files = cfg.persona.files.map((f) =>
      typeof f === 'string' ? resolvePath(f) : { ...f, path: resolvePath(f.path) });
  }
  if (cfg.soul?.root) cfg.soul.root = resolvePath(cfg.soul.root);
  if (cfg.diary?.dir) cfg.diary.dir = resolvePath(cfg.diary.dir);
  return cfg;
}
