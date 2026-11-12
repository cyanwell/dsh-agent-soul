// 配置：一个 JSON 文件 + 环境变量覆盖。
// ★ 不读任何外部系统的凭据文件 —— key 由使用者自己填进 config.json 或环境变量。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');

/**
 * 开发机路径默认值 —— 全项目**唯一**的一处声明。
 *
 * ★ 2026-11-10（R1 返工）：这些字面量以前散在 server.mjs / status-data.mjs /
 *   mcp-tools.mjs / frame-reader.mjs 里当硬编码默认。后果是真问题：
 *   分发版装到用户机上，状态页会去读 D:/AI/yanqing-soul/30-状态 —— 一个在
 *   用户机上**不存在的目录**（要么报错、要么静默空，两种都让人以为"没数据"）。
 *   现在一律经 devPathOr()：**开发默认只在它真的存在时生效**，否则用调用方给的兜底
 *   （各使用点的兜底都是 appRoot() 下的分发版目录）。
 *   于是开发机行为一字不变，分发版永远拿到自己的路径。
 */
export const DEV_PATHS = {
  soulRoot: 'D:/AI/yanqing-soul',
  statusDir: 'D:/AI/yanqing-soul/30-状态',
  dshHome: 'D:/AI/dsh/home',
  sessionRoot: 'D:/AI/dsh/home/sessions',
  backupDir: 'D:/AI/_backup',
  workspace: 'D:/AI/agent-soul',
  // pruner 的 context-contract.mjs（帧读取的唯一 hash 实现）。外部可选依赖，开发机才有。
  prunerContract: 'D:/AI/dsh-tools/dsh-yanqing-pruner/context-contract.mjs',
  // 心跳插件启动时写下的「我自己的 origin」。★ 单文件依赖，开发机才有；
  // 分发版没有它 → dshOriginFileOf() 回 null，只走启动日志那条路（那才是验收要求的主路径）。
  dshOriginFile: 'D:/AI/dsh-tools/dsh-yanqing-heartbeat/dsh-origin.txt',
  // 定长自我层（SELF.md）。★ 2026-11-11：这是「我是谁」那一份，分发版没有 → personaFilesOf 回空。
  selfMd: 'D:/AI/memory/hub/SELF.md',
};

/** 目录存在吗（不问为什么不存在 —— 那是调用方的事）。 */
export function isDirPath(p) {
  try { return !!p && fs.statSync(p).isDirectory(); } catch { return false; }
}

/** 开发默认路径：目录真的存在才用，否则用 fallback。分发版走 fallback 这条。 */
export function devPathOr(key, fallback) {
  const dev = DEV_PATHS[key];
  return isDirPath(dev) ? dev : fallback;
}

/** 同上，但判据是「文件存在」（契约模块这类单文件依赖）。 */
export function devFileOr(key, fallback) {
  const dev = DEV_PATHS[key];
  try { return dev && fs.statSync(dev).isFile() ? dev : fallback; } catch { return fallback; }
}

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
  // ★ 2026-11-10（R1）：状态目录（活体台账 / 事件层）。null = 走 statusDirOf() 的判据链。
  //   分发版的 config.json 显式写 "workspace"（相对 appRoot = 安装根）。
  statusDir: null,
  host: '127.0.0.1',
  port: 7310,

  // LLM：默认走 DeepSeek 官方 OpenAI 兼容端点
  // ★ 2026-11-10（1.0.2）：从「一个地址 + 一个明文 key」扩到「协议 + 秘密引用」。
  //   protocol 只有两个值，别的值**报错不降级**（见 llm/client.mjs 的 normalizeProtocol）。
  //   baseUrl 留空 = 按协议取官方默认地址（OpenAI 走 /，Anthropic 走 /anthropic）——
  //   安装向导允许用户把地址留空，程序这边必须真的认这个「空」。
  llm: {
    protocol: 'openai',
    provider: 'deepseek-official',
    providerName: 'DeepSeek官方',
    baseUrl: '',
    apiKey: '',
    apiKeyRef: '',                 // env:NAME / dpapi:<providerId>；解析结果只留在内存
    model: 'deepseek-chat',
    maxTokens: 4096,
    temperature: 0.7,
  },

  // 上下文：不做压缩，只按「最近 N 帧」截断（索引不参与上下文组装）
  context: {
    maxFrames: 60,
    // ★ 2026-11-11：按 token 的上下文预算（v4 自己的「裁剪」，对应 DSH 的 ACP/pruner）。
    //   40,000 是这么定的：deepseek-chat 窗口 64K，人格约 15K token（33,262 字符 / 2.2），
    //   再留 8K 给输出 —— 剩下的给历史。**宁可折得早，不要等到报错才折。**
    maxTokens: 40000,
    // 尾部强制保留的帧数：最近的对话是它正在做的事，不能被折。
    keepTailFrames: 10,
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
    // ★ 2026-11-10：事件接入（Aurabot 只读事件 → core 的唯一事件账）。
    //   默认全关：mode=off 时**不连、不收、连目录都不建**（判据在 src/events/index.mjs）。
    //   ★ 两种通路只能启用一种：direct-ws（连 OneBot WS）或 bridge-events（只数行做计数对照）。
    //     同时打开 → 一律按 off 处理并报错（BOTH_MODES_ENABLED），不挑一个。
    //   ★ 未验 R1 之前不许连真实网关 —— 所以默认值是 off。
    ingress: {
      mode: 'off',                 // off | direct-ws | bridge-events
      onebot: {
        wsUrl: '',                 // 必须显式给（端口不是协议常量，core 不猜）
        tokenEnv: '',              // token 只从环境变量读；配置文件里不存、状态里只报布尔
        allow: { all: false, chats: [], private: [] },   // 默认 allow none
        maxReconnect: 3,
        backoffMs: [250, 500, 1000],
        selfId: '',
      },
      bridge: { eventsPath: '', pollMs: 2000, source: 'onebot' },
      // 第三条只读通路：lead-relay 队列（读文件，不占 WS，所以不在互斥范围内）。
      leadRelay: { enabled: false, queuePath: '', pollMs: 2000 },
    },
    // ★ 2026-11-12：事件 → 唤醒（链路最后一段）。**三段各自独立，一个都不默认开。**
    //   ① allow   ：要不要拼这个会话的正文（白名单，默认 none —— 跟 ingress 同一个纪律）
    //   ② deliver ：拼出来之后要不要真的投（默认 false）
    //   ★ 两段分开是有意的：先让拼的结果看得见（status 里的 ok / skipped），
    //     确认在真帧上拼对了，再打开投递。合成一段，「拼得对不对」就永远没法单独验。
    wake: {
      allow: { all: false, chats: [] },
      maxChars: 4000,            // 单个事件拼出来正文的上限（防一条长消息撑爆一轮）
      deliver: false,            // ★ 真的叫醒会话：会花钱、会动文件。默认不投。
      // ★ 2026-11-12：一组「还算我自己」的 QQ 号。
      //   场景：两个号（1901372960 / 3937956599），群里 @ 哪一个都该算叫到我；
      //   而收消息的耳朵（ingress）只能连其中一个网关。空数组 = 只认帧里的 self_id。
      selfIds: [],
      ownerQQ: '',
      policy: null,
      groupOverrides: null,
    },
    // ★ 2026-11-12：合并窗口的规则覆盖（透传给 coalesce）。
    //   ★ 这个键以前**不存在** —— events/index.mjs 一直读 config.events.coalesce.rules，
    //     读的是一个永远 undefined 的键。没出事只是因为 coalesce 自己带 DEFAULT_RULES。
    //   配法：{ private: { firstMs, extendMs }, group: { … }, default: { … } }；不配就用默认档。
    coalesce: {
      rules: null,
    },
    // ★ 2026-11-11：出站（v4 唯一的发消息出口）。
    //   ★「唯一」指**传输与记账唯一**，不是把发消息的所有策略都搬进来：
    //     hooks 改写 / 采集 / 总开关 / 试运行 / 回声抑制 仍归调用方。
    //   ★ token 的规矩跟 ingress 一模一样：只从环境变量读，配置文件里不存、
    //     状态里只报 tokenSet 布尔。别造第二套。
    egress: {
      mode: 'off',                 // off | onebot-http
      onebot: {
        httpUrl: '',               // 必须显式给（端口不是协议常量，core 不猜）
        tokenEnv: '',              // 环境变量名，不是 token 本身
        timeoutMs: 8000,
        dedupeTtlMs: 600000,       // 10 分钟内的同内容重发只发一次
      },
    },
  },

  // 器官
  organs: {
    huanqi: { enabled: true, stallThreshold: 3 },
    // ★ 2026-11-07：数值抄自 organs/degradation.mjs 的 DEFAULT（那是没人配置时的兜底）。
    //   两处必须同值 —— 面板要显示「默认是几」，那个数只能有一个口径。
    //   ★ 四项都是「拍的」，还没被真实数据标定过（理由写在 degradation.mjs 的注释里）。
    degradation: {
      lowOutputTokens: 24,       // 产出 ≤ 它算「低」：一句中文回答约 10–20 token
      sameTurnGrowthMin: 8000,   // 同一轮里涨这么多，才算「在往里塞东西」
      watchAt: 2,                // 几分进 watch
      interveneAt: 4,            // 几分进 intervene
    },
  },

  // 自主循环——★ 默认关着。要它自己动，得明确打开
  autonomy: {
    // ★ 2026-11-10 D 切片之后：**没有「推不动就 v4 自己跑」这条退路**了。
    //   所以 pushToHost=false 只有一个意思：不推宿主 = 不动（不是退回老行为）。
    pushToHost: true,
    enabled: false,
    // ★ 2026-11-11：留空 = 跟随《墨》当前 lead（动态，由 DSH 心跳解析）；
    //   显式填写 = 固定覆盖。两者都不新建 autonomy 容器。
    targetSession: null,
    idleThresholdMinutes: 15,
    // ★ 2026-11-11（爀曦定 8）：这里和 organs/autonomy.mjs 的 DEFAULT_AUTONOMY 是**两处默认值** ——
    //   实测踩到：那边改成 8，配置里没写，界面仍显示 /24。因为运行时读的是**这一份**。
    //   **同一个数写两遍，早晚有一处是旧的。** 改这两处要一起改；更好的做法是让 config.mjs 引用
    //   DEFAULT_AUTONOMY（暂不做，避免引入循环依赖 —— 记在这里）。
    maxRunsPerDay: 8,
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

  // 集成：概览页要读的 **DSH 侧只读接口** 地址（2026-11-10 · overview-status-panels）
  //
  // ★ 为什么必须显式配置，而且默认是空：
  //   DSH 的 webServer 端口每次重启都变（本机实测 59174 → 57099 → 56207）。
  //   写死一个数 = 在别人机器上永远错，在我自己机器上明天就错。
  //   ★ 没配就是 UNCONFIGURED（面板上就这么写），**不替谁猜一个端口**。
  // ★ 为什么这两个地址可以放在一起：MCP Hub 与 heartbeat 都是 DSH 同一个 webServer
  //   上的两条 GET 路由，所以共用一个 origin；要分开指就给各自的覆盖项。
  // ★ 只有 GET。这里不引入任何写路由 —— MCP Hub 的 POST/PATCH/DELETE 一条都没接。
  integrations: {
    dshBaseUrl: '',      // 例：http://127.0.0.1:<DSH 端口>（DSH 重启后会变，改了要同步这里）
    mcpHubUrl: '',       // 可选：单独指定 MCP Hub 的 origin（覆盖 dshBaseUrl）
    heartbeatUrl: '',    // 可选：整条心跳 URL（覆盖 <dshBaseUrl>/heartbeat/auto）
    // ★★ 2026-11-11：1500 → 5000。实测 DSH 在处理一轮对话时，那些只读端点（/heartbeat/auto、
    //   /mcp-hub/servers）要排队，1500ms 必超时；而我**单独 curl 只要 101ms**。
    //   dashboard 上那个「MCP Hub unreachable · 请求超时（1500ms）」就是这么来的 ——
    //   不是它对不上，是我给它的耐心比它需要的少。
    //   **判据：超时按「宿主最忙的时候」定，不是按「我单独测它的时候」定。**
    timeoutMs: 5000,     // 单次只读请求超时
    staleMs: 30000,      // 读到过、但过期多久之后就不许再冒充「现在」

    // 回声哨兵（2026-11-10 · F 切片）：复用本机唯一的回声体检器做**只读**探测。
    //
    // ★ 为什么是显式配置、默认空：
    //   体检器在开发机的另一个仓库里（D:/AI/memory/hub/echo-doctor.mjs），
    //   分发版**没有**它。默认指向一个不存在的路径，会把「没装」伪装成「回声坏了」。
    //   所以默认空 → 状态台显示 UNKNOWN + 「未配置」，配了才探。
    //   ★ 没有用 devFileOr()：那会让这台机器上的**生产**进程也开始偷偷起子进程 ——
    //     一个读状态页的请求不该顺手拉起别人的 CLI。要探就明确配。
    // ── 心跳地址自动发现（2026-11-11）────────────────────────────────
    // ★ DSH 每次重启换端口（本机实测 59174 → 57099 → 56207 → 49394），所以「写死一个端口」
    //   在重启那天必然失效，而且失效是**静默**的（自主不投、清理没目标，谁也不报错）。
    //   现在：上面两个显式地址仍然是**最高优先**（配了就不读日志）；都没配才自动发现。
    // ★ 两个来源都是「同一种记录」：谁最后写谁代表最近一次启动。
    //   ① 启动日志：<DSH_HOME>/guard/logs/server-*.out.log（桌面「DSH服务」图标写的）
    //      没配 → 依次看 环境变量 DSH_HOME / 开发机默认 D:/AI/dsh/home
    //   ② 心跳插件的 dsh-origin.txt（index.js 启动时写自己的 origin）
    //      没配 → 开发机默认路径（**文件存在才用**，分发版不用）
    // ★ 留空不等于「不发现」：留空 = 走上面两条默认位置。想关掉自动发现就把心跳地址配死。
    dshLogDir: '',            // 例：D:/AI/dsh/home/guard/logs
    dshOriginFile: '',        // 例：D:/AI/dsh-tools/dsh-yanqing-heartbeat/dsh-origin.txt

    echoDoctorPath: '',       // 例：D:/AI/memory/hub/echo-doctor.mjs
    echoProbeTimeoutMs: 15000,// 子进程超时（实测 fast 层 ~2.2s；给足余量，超时就杀掉并如实记失败）
    echoProbeTtlMs: 600000,   // 结果新鲜期（10 分钟）：期内不重跑，过期才按需再探
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

// ═══════════════════════════════════════════════════════════════════════
// 秘密引用（llm.apiKeyRef）—— 1.0.2 新增；1.0.3 收紧为「只按白名单回显」
//
// ★ 要解决的问题：安装向导必须收一把 API Key，而**明文 key 不许落在 config.json**。
//   所以配置文件里只写一个「引用」，真值由安装根里的 SecretStore.exe 用
//   DPAPI（CurrentUser）解出来，**只进内存**。
//
// ★ 支持且只支持两种引用（别的写法明确报错，不猜）：
//     env:NAME               从环境变量取（CI / 临时覆盖）
//     dpapi:<providerId>     <安装根>\runtime\SecretStore.exe 解 DPAPI 密文
//
// ★ helper 的路径**只从安装根推**（appRoot()/runtime/SecretStore.exe），
//   不写任何开发机路径 —— 分发版装到哪，就从哪找。
//   ★ 1.0.3（独立验收 P2-2）：AGENT_SOUL_SECRETSTORE 只在**显式** AGENT_SOUL_DEV=1
//     （开发 / 隔离测试）时生效。分发版默认无视它 —— 同用户下能改环境变量的人，
//     不许因此让主程序执行任意 exe 并把解出来的秘密喂进 stdin。
// ═══════════════════════════════════════════════════════════════════════

/** 合法引用的白名单 —— 唯一口径，展示与解析共用（1.0.3）。 */
const API_KEY_REF_PATTERNS = {
  env: /^env:[A-Za-z_][A-Za-z0-9_]*$/,
  dpapi: /^dpapi:[a-z][a-z0-9_-]*$/,
};

/**
 * 安全的引用描述：**响应 / 日志 / 界面唯一该用的来源**（1.0.3，P2-1）。
 * @returns {{ kind: 'empty'|'env'|'dpapi'|'invalid'|'unknown', valid: boolean, display: string }}
 * ★ display 只可能是四种：'(空)' / 合法引用原文 / 'invalid' / 'unknown'。
 *   后两个词不含输入的任何一个字符（连长度也不给 —— 长度也是线索）。
 * ★ 为什么必须有这一层：apiKeyRef 来自用户可以手改的 config.json，是**不可信输入**。
 *   旧版把输入的前 40 个字符拼进错误串，于是「把原始 Key 误填进这一栏」的配置
 *   会把密钥带进 GET /api/config 的 refError、启动横幅和被贴出去的截图。
 */
export function describeApiKeyRef(ref) {
  const s = typeof ref === 'string' ? ref.trim() : '';
  if (!s) return { kind: 'empty', valid: false, display: '(空)' };
  if (API_KEY_REF_PATTERNS.env.test(s)) return { kind: 'env', valid: true, display: s };
  if (API_KEY_REF_PATTERNS.dpapi.test(s)) return { kind: 'dpapi', valid: true, display: s };
  // 有前缀但内容不合白名单 → invalid；连前缀都不像 → unknown。两种都不回显原文。
  const prefixed = /^(env|dpapi):/i.test(s);
  return { kind: prefixed ? 'invalid' : 'unknown', valid: false, display: prefixed ? 'invalid' : 'unknown' };
}

/** SecretStore.exe 的位置：安装根/runtime/。★ 覆盖只在 AGENT_SOUL_DEV=1 时生效（1.0.3）。 */
export function secretStorePath(root = appRoot()) {
  const dev = process.env.AGENT_SOUL_DEV;
  const override = process.env.AGENT_SOUL_SECRETSTORE;
  if (dev === '1' && override) return path.resolve(override);
  return path.join(root, 'runtime', 'SecretStore.exe');
}

/**
 * 解析一个 apiKeyRef。
 * @returns { ok, value?, source, error? }
 * ★ 返回值里的 value 是**秘密本体** —— 调用方不许把它写进日志、磁盘、任何响应。
 */
export function resolveApiKeyRef(ref, root = appRoot()) {
  const desc = describeApiKeyRef(ref);
  if (desc.kind === 'empty') {
    return { ok: false, source: desc.display, error: 'apiKeyRef 是空的（可用 env:NAME 或 dpapi:<providerId>）' };
  }
  if (!desc.valid) {
    // ★ 不回显输入：只说形状不合法 + 白名单。source 也只有 'invalid' / 'unknown'。
    return {
      ok: false, source: desc.display,
      error: 'apiKeyRef 形状不合法（' + desc.display + '）：只接受 env:[A-Za-z_][A-Za-z0-9_]* 或 dpapi:[a-z][a-z0-9_-]*',
    };
  }
  const s = String(ref).trim();
  const kind = desc.kind;
  const arg = s.slice(s.indexOf(':') + 1).trim();   // 已由白名单限定字符集
  if (!arg) return { ok: false, source: desc.display, error: 'apiKeyRef 的冒号后面是空的' };

  if (kind === 'env') {
    const v = process.env[arg];
    if (!v) return { ok: false, source: desc.display, error: '环境变量 ' + arg + ' 没有值' };
    return { ok: true, source: desc.display, value: v };
  }

  const exe = secretStorePath(root);
  if (!fs.existsSync(exe)) return { ok: false, source: desc.display, error: '秘密组件不存在：' + exe };
  try {
    const out = execFileSync(exe, ['get', '--provider', arg, '--root', root], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const v = String(out || '').replace(/\r?\n$/, '');
    if (!v) return { ok: false, source: desc.display, error: 'DPAPI 里没有 ' + arg + ' 的秘密（重新运行安装向导填入 API Key）' };
    return { ok: true, source: desc.display, value: v };
  } catch (e) {
    const msg = String((e && e.stderr) || (e && e.message) || e).trim().split('\n')[0].slice(0, 200);
    return { ok: false, source: desc.display, error: '读取 DPAPI 秘密失败：' + msg };
  }
}

export function loadConfig(file = path.join(appRoot(), 'config.json')) {
  let cfg = structuredClone(DEFAULTS);
  if (fs.existsSync(file)) {
    try { cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (e) { throw new Error('config.json 解析失败: ' + e.message); }
  }
  // ★★ 2026-11-11：本机实例覆盖层 config.local.json。
  //   起因是一个真事故：我改了 dist/config.json 的 workspace（.→D:/AI），
  //   然后跑 dist.ps1 重建 —— 它把 config.json 用 config.release.json 原样覆盖，
  //   改的那一项直接丢了（实测：重建后又回到 "."，于是 glob 报「路径越界」）。
  //   根子上的问题是「本机实例长什么样」和「发布默认长什么样」被塞进了同一个文件。
  //   判据：config.json 之后再叠一层 local（深合并）；**发布包永远不带 local**。
  const localFile = path.join(path.dirname(file), 'config.local.json');
  if (fs.existsSync(localFile)) {
    try { cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(localFile, 'utf8'))); }
    catch (e) { throw new Error('config.local.json 解析失败: ' + e.message); }
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
  if (cfg.statusDir) cfg.statusDir = resolvePath(cfg.statusDir);
  // ★ 事件接入里只解析「外部给的路径」；事件账目录本身不从配置读（= <dataDir>/events）。
  if (cfg.events?.ingress?.bridge?.eventsPath) {
    cfg.events.ingress.bridge.eventsPath = resolvePath(cfg.events.ingress.bridge.eventsPath);
  }
  if (cfg.events?.ingress?.leadRelay?.queuePath) {
    cfg.events.ingress.leadRelay.queuePath = resolvePath(cfg.events.ingress.leadRelay.queuePath);
  }

  // ★ 秘密解析：优先级 环境变量 > config 明文 > apiKeyRef。
  //   解析结果只进内存；apiKeySource / apiKeyRefError 是**给运维看的来源与原因**，
  //   两个字段都不含秘密本体（来源是引用串，引用串里只有 provider id）。
  cfg.llm.apiKey = typeof cfg.llm.apiKey === 'string' ? cfg.llm.apiKey : '';
  if (process.env.AGENT_SOUL_KEY) {
    cfg.llm.apiKeySource = 'env:AGENT_SOUL_KEY';
  } else if (cfg.llm.apiKey) {
    cfg.llm.apiKeySource = 'config:llm.apiKey';
  } else if (cfg.llm.apiKeyRef) {
    const r = resolveApiKeyRef(cfg.llm.apiKeyRef, appRoot());
    if (r.ok) { cfg.llm.apiKey = r.value; cfg.llm.apiKeySource = r.source; }
    else { cfg.llm.apiKeySource = 'unresolved'; cfg.llm.apiKeyRefError = r.error; }
  } else {
    cfg.llm.apiKeySource = 'none';
  }
  return cfg;
}

/**
 * 「状态目录」（30-状态：活体台账 / 事件层都读它）。
 *
 * ★ 判据只有这一处 —— server.mjs 的 /api/live 与 status-data.mjs 的事件层共用。
 *   分两处写必然各漂各的，那正是本项目反复付代价的形状。
 * 顺序：① config.statusDir（相对 → appRoot）  ② config.soul.root + '/30-状态'
 *       ③ 环境变量 AGENT_SOUL_STATUS_DIR      ④ 开发默认（**目录存在才用**）
 *       ⑤ 兜底 = <安装根>/workspace（分发版落在安装根，绝不读开发机路径）
 */
export function statusDirOf(cfg) {
  if (cfg && typeof cfg.statusDir === 'string' && cfg.statusDir) return resolvePath(cfg.statusDir);
  if (cfg && cfg.soul && cfg.soul.root) return path.join(cfg.soul.root, '30-状态');
  if (process.env.AGENT_SOUL_STATUS_DIR) return path.resolve(process.env.AGENT_SOUL_STATUS_DIR);
  return devPathOr('statusDir', path.join(appRoot(), 'workspace'));
}

/**
 * 唤醒台账（真事件）的路 —— **唯一一处**。
 *
 * ★★ 2026-11-10（三项死读数修复之二）：soul_waker 原来读 `<dataDir>/ledger.json`，
 *   而真台账在 `<状态目录>/lead-waker-台账.json`（本机实测：前者 1 条 2026-11-07 的旧待办，
 *   后者 43 条真事件）。两个文件长得一模一样 —— 读错不会报错，只会**安静地显示一个很小的数**。
 *   所以路径判据收进这一处，读的人（状态台 / 器官卡 / soul_waker）都问它。
 * ★ 只有读走这里。**写路径一根手指都没动** —— 迁移权威文件不在本次范围。
 */
export function wakerLedgerFileOf(cfg) {
  return path.join(statusDirOf(cfg), 'lead-waker-台账.json');
}

/**
 * 人格层要装哪些文件 —— **唯一一处判据**。
 *
 * ★ 2026-11-11：清点时发现 v4 跑着但**人格占比 0 / 80000 B** —— release 配置里
 *   `persona.files` 是空数组，于是这个进程一个字都没读进来。那不是显示问题，
 *   是「接口搬过来了、人没搬过来」。
 * ★ 判据：显式配置优先；没配就自动发现本机那三份「我是谁」（**文件存在才用**）。
 *   装到别人机器上三份都不存在 → 仍然是空人格（与以前一字不差，不会读开发机的路径）。
 * ★ tier 怎么分：定长自我层是 CORE（永不裁），两份 AGENTS.md 是 WORK（超预算时可压）。
 *   三者合计约 67KB < 默认 80KB，正好放得下；超了也是先裁 WORK，不会把 SELF 裁掉。
 */
export function personaFilesOf(cfg) {
  const own = cfg && cfg.persona && Array.isArray(cfg.persona.files) ? cfg.persona.files : [];
  if (own.length) return own;
  const out = [];
  const self = devFileOr('selfMd', null);
  if (self) out.push({ path: self, tier: 'core', name: 'SELF.md' });
  const soul = devPathOr('soulRoot', null);
  if (soul) {
    const a = path.join(soul, 'AGENTS.md');
    if (isFilePath(a)) out.push({ path: a, tier: 'work', name: 'AGENTS.md（工作区）' });
  }
  const home = devPathOr('dshHome', null);
  if (home) {
    const a = path.join(home, 'AGENTS.md');
    if (isFilePath(a)) out.push({ path: a, tier: 'work', name: 'AGENTS.md（全局）' });
  }
  return out;
}

/** 文件存在吗（devFileOr 的同款判据，外部要判断单个文件时用）。 */
export function isFilePath(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * 技能目录 —— **唯一一处判据**。
 *
 * ★ 2026-11-11：DSH 的「技能」是独立能力位（preset 里 skill-filesystem + tool-skill 两行）。
 *   v4 清点时发现：21 个技能没有任何东西去加载它们。这里是加载器要找哪几个目录。
 * ★ 与 persona 不同：persona 是「显式配置 or 自动发现」二选一，
 *   技能是**可以并存**的（自己的技能 + 继承来的技能各自一个目录），所以是累加。
 * ★ 自动发现那条同样守「目录存在才用」：装到别人机器上没有那个目录就不加。
 */
export function skillsDirsOf(cfg) {
  const own = cfg && cfg.skills && Array.isArray(cfg.skills.dirs) ? cfg.skills.dirs : [];
  const out = [];
  const push = (d) => { const p = resolvePath(d); if (p && !out.includes(p)) out.push(p); };
  for (const d of own) { const v = String(d == null ? '' : d).trim(); if (v) push(v); }
  const home = devPathOr('dshHome', null);
  if (home) { const d = path.join(home, 'skills'); if (isDirPath(d)) push(d); }
  return out;
}

/**
 * 日记目录 —— **唯一一处判据**。
 * ★ 2026-11-11：显式配置优先；没配就自动发现本机书房下的 `50-日记`（devPathOr，
 *   **目录存在才用**）。理由与书房卡、lead 水位同源：
 *   「没写进配置」≠「不知道在哪」，而发行版装到别人机器上没有那个目录 ——
 *   于是行为与以前一字不差（仍然报 UNCONFIGURED，只是不再误伤本机）。
 */
export function diaryDirOf(cfg) {
  const own = cfg && cfg.diary && cfg.diary.dir;
  if (own) return resolvePath(own);
  const soul = devPathOr('soulRoot', null);
  if (!soul) return null;
  const d = path.join(soul, '50-日记');
  return isDirPath(d) ? d : null;
}

/** 投递账（下行轮询的已投递 / 在途 / 失败重试）。判据与台账同源。 */
export function wakerDeliveredFileOf(cfg) {
  return path.join(statusDirOf(cfg), 'lead-waker-已投递.json');
}
