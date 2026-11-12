// HTTP 服务 —— 静态壳 + JSON API + SSE 流

import { createRequire } from 'node:module';
const require$ = createRequire(import.meta.url);
import fs from 'node:fs';
import { accept as wsAccept } from '../control/ws.mjs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FRAME } from '../session/frame.mjs';
import { loadConfig, appRoot, resolvePath, DEFAULTS, statusDirOf, wakerLedgerFileOf, wakerDeliveredFileOf, secretStorePath, describeApiKeyRef, devPathOr, diaryDirOf } from '../config.mjs';
// ★ 2026-11-10（G2a）：写面的判据不在这张路由表里 —— 只有一份，在 security/write-manifest.mjs。
import { readonlyEnabled, classifyHttp, rejection } from '../security/write-manifest.mjs';
// ★ 2026-11-10：事件接入的只读口（不新开路由，并进现有的 GET /api/events）。
import { eventsIngressPayload } from '../adapters/events-http.mjs';
// ★ 2026-11-11：出站的只读视图（发了几条 / 最近发了什么）。与 events 同一个形状：只读、脱敏。
import { outboxView } from '../adapters/outbox.mjs';
// ★ 2026-11-11：QQ 只读面的接线视图（/api/qq）。只读工具自己定义在 adapters/qq/ 里，
//   这里只取它的 view() —— 面板不该自己再算一遍「接线了没有」。
import { qqView } from '../adapters/qq/tools.mjs';
// ★ 2026-11-10（概览状态面板）：四块只读状态的聚合 —— 控制通道 / MCP Hub / DSH 心跳 / 模型。
//   单独一个模块，是因为它要能被**隔离验**（mock control / hub / heartbeat / llm），
//   而 createServer 里那坨代码没法单测。判据只写在这一处，页面只负责画。
import { createRuntimeStatusCollector, buildControlView } from './runtime-status.mjs';
// ★ 2026-11-11：概览页的迷你趋势（进程内环形缓冲）。只采样、不落盘 —— 重启清零是真话。
import { recordOverview, getSeries } from './series.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// /api/session 认的四个动作（白名单，见路由处的理由）。
const SESSION_ACTIONS = ['resolve', 'followup', 'steer', 'create'];

// 器官模块（纯函数 / 无副作用，直接引即可）
import { Diary } from './diary.mjs';
import { watermarkOf } from '../organs/context.mjs';
import { diagnose as diag } from '../organs/diagnose.mjs';
import { SoulIndex } from '../organs/soul-scan.mjs';
import { createAuth, needsAuth } from './auth.mjs';
// ★ 退化卡的读数由器官定义（degradationCard），server 只负责把它摆到面板上 ——
//   判据和显示分家，就会各漂各的（「两把尺子」这个坑本项目付过一次代价）。
import { degradationCard, DEFAULT as DEGRADATION_DEFAULT } from '../organs/degradation.mjs';
// ★ 状态台（三水位 + 六层）的数据聚合。与 /api/overview 共用同一个 measureCacheBytes —— 不另写一份。
import { gatherStatus, measureCacheBytes as measureCacheBytesOf } from './status-data.mjs';
// ★ 2026-11-10（三项死读数修复之一/之二）：器官卡的读数**必须**与状态台同一实现 ——
//   两个页面各算各的，正是「0 / 3」和「1 条台账」这类死读数活下来的方式。
import { huanqiCard, readHuanqi } from '../organs/huanqi-read.mjs';
import { wakerCard, readWakerLedger } from '../organs/waker-read.mjs';
// ★ 2026-11-10（E/F 切片）：回执与哨兵结果的**只读**出口 —— 读法与状态台同一实现。
import { readCleanupState } from '../organs/cleanup.mjs';
import { readEchoSentinel } from '../organs/echo-sentinel.mjs';
// ★★ 2026-11-12：session 能力的出口。上一轮宿主已经举手（caps 里有 session、notWired 为空），
//   而这边 createSessionDispatch 写好了却**一处调用都没有** —— 门开了、门外没路。
//   这里给它一条具体的路，判据分两半：
//     GET  /api/session → 观测面（谁能接、最近一次成败、计数），**不含任何正文**
//     POST /api/session → 派活（resolve / followup / steer / create），要 token
//   ★ create 在这个口上开着，但宿主侧本来就回 unsupported —— 不在这一层假装能造会话。
import { createSessionDispatch } from '../organs/session-dispatch.mjs';

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 8 * 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// 配置层 —— 参数可视化（GET /api/config）与设置面板（POST /api/config）
//
// ★ 三条不许妥协的规矩：
//   ① apiKey 绝不回显 —— 只回 hasKey。响应里任何地方都不出现它的值、长度、前缀。
//   ② 校验不过就不写盘 —— 先攒齐所有错误一次性返回，不做「边校验边写」。
//   ③ 写完必须读回来 —— 响应里的值来自磁盘重新解析，不是来自我们刚拼的那个对象。
//      「我以为我写进去了」和「它确实在磁盘上」是两件事。
// ═══════════════════════════════════════════════════════════════════════

/** config.json 的位置：跟着 appRoot()（开发目录 / exe 解压目录各自一份） */
function configFile() { return path.join(appRoot(), 'config.json'); }

/**
 * 调 SecretStore.exe 存 / 删一把秘密（1.0.2）。
 *
 * ★ 秘密**只走 stdin**：命令行会被别的进程读走（进程列表、审计日志），
 *   所以宁可多一层管道，也不让 key 出现在 argv 里。
 * ★ 失败只回状态和一句原因 —— 原因里绝不带秘密本体。
 */
function runSecretStore(argv, stdinText) {
  const exe = secretStorePath(appRoot());
  if (!fs.existsSync(exe)) return { ok: false, error: '秘密组件不存在：' + exe };
  return new Promise((resolve) => {
    try {
      const cp = require$('node:child_process').spawn(exe, argv.concat(['--root', appRoot()]), {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '', err = '';
      cp.stdout.on('data', (d) => { out += d; });
      cp.stderr.on('data', (d) => { err += d; });
      cp.on('error', (e) => resolve({ ok: false, error: String(e && e.message) }));
      cp.on('close', (code) => {
        if (code === 0) resolve({ ok: true, out: out });
        else resolve({ ok: false, error: (err || out || ('exit ' + code)).trim().split('\n')[0].slice(0, 200) });
      });
      if (stdinText != null) cp.stdin.end(stdinText); else cp.stdin.end();
    } catch (e) {
      resolve({ ok: false, error: String((e && e.message) || e) });
    }
  });
}

/** 环境变量覆盖 —— 与 config.mjs 里 loadConfig() 的那五处一一对应 */
const CONFIG_ENV = {
  'llm.apiKey': 'AGENT_SOUL_KEY',
  'llm.baseUrl': 'AGENT_SOUL_BASE_URL',
  'llm.model': 'AGENT_SOUL_MODEL',
  // ★ host / port / dataDir / workspace 在 config.json 里是**顶层**键，不是 server.*
  'port': 'AGENT_SOUL_PORT',
  'dataDir': 'AGENT_SOUL_DATA',
};

/**
 * 为什么这一组改了要重启。
 * ★ 不写「全部需要重启」这种糊话 —— 每条都说清是哪个对象在启动时把值拷走了。
 */
const CFG_RESTART_WHY = {
  llm: 'LlmClient 在启动时把地址 / 模型 / key 拷成自己的字段，之后不再回看配置文件。',
  context: '配置只在进程启动时 load 一次 —— 文件改了，进程里那份对象不会跟着变。',
  persona: '人格层在启动时把文件读进内存，预算也是那一刻的快照。',
  events: '调度器的 tick 间隔与两条规则在启动时定下。',
  organs: '换气阈值在会话第一次调用时读取；思考退化的四项是启动时 spread 进 DegradationTracker 的（index.mjs:216-219）—— 两组都是构造那一刻拍快照，已经在跑的检测器不回看配置，改了都要重启才生效。',
  autonomy: '自主循环在启动时构造，配置被 spread 进实例。',
  soul: '书房索引第一次用到时建好并常驻，不会自己重建。',
  server: '监听地址在 server.listen() 那一刻定死；SessionStore 也只在启动时拿一次数据目录。',
};

/**
 * 字段表 —— 参数页和设置页都由它渲染。
 *
 * ★ 这是「界面」和「程序」的唯一对账表：一个字段在这里没登记，
 *   页面上就看不见它，POST 也改不动它（未知键会被拒）。宁可漏也不许悄悄多。
 * ★ wired:false = 配置里有、程序里没接线。★ 这种必须说出来，不能装作它有效。
 */
const CFG_GROUPS = [
  {
    id: 'llm', name: '模型接入',
    note: '一轮对话发去哪里、用哪个模型、回答多长多热。',
    fields: [
      // ★ 1.0.2：协议是新的第一栏 —— 它决定端点路径、鉴权头、默认地址三件事。
      //   这里只收两个值；客户端遇到别的值会**报错**，不会猜一个继续跑。
      { key: 'llm.protocol', label: '协议', type: 'string', restart: true,
        pattern: /^(openai|anthropic)$/i, patternMessage: '只能是 openai 或 anthropic',
        note: 'openai = POST <地址>/chat/completions；anthropic = POST <地址>/v1/messages（带 anthropic-version 与 x-api-key）。' },
      { key: 'llm.baseUrl', label: '接口地址', type: 'string', restart: true, allowNull: true,
        pattern: /^https?:\/\/[^\s]+$/i, patternMessage: '要是一个 http(s):// 开头的地址',
        note: '模型请求发往哪里。**留空 = 用该协议的官方默认地址**（openai → https://api.deepseek.com，anthropic → https://api.deepseek.com/anthropic）。不带 /chat/completions，也不带 /v1/messages。' },
      { key: 'llm.apiKey', label: 'API Key', type: 'secret', restart: true,
        note: '调用模型的凭据。★ 只显示「有没有配」，不回显内容，连长度都不给。★ 若下面配了 dpapi 引用，在这里提交会直接写进 DPAPI，config.json 里一个字都不落。' },
      { key: 'llm.apiKeyRef', label: '秘密引用', type: 'string', restart: true, allowNull: true,
        pattern: /^(env:[A-Za-z_][A-Za-z0-9_]*|dpapi:[a-z][a-z0-9_-]*)$/, patternMessage: '写成 env:变量名（字母/数字/下划线）或 dpapi:<providerId>（小写字母开头，只含小写字母、数字、- _）',
        note: 'apiKey 从哪来：env:NAME（环境变量）或 dpapi:<providerId>（安装根 runtime\\SecretStore.exe 解 DPAPI 密文）。留空 = 用上面那栏的明文 key（老配置兼容）。' },
      { key: 'llm.model', label: '模型名', type: 'string', restart: true,
        note: '请求体里的 model 字段。名字由供应商定，写错会在第一次对话时报 HTTP 400。' },
      { key: 'llm.maxTokens', label: '回复上限', type: 'int', min: 1, max: 200000, unit: 'tokens', restart: true,
        note: '单次回复最多多少 token。调太小会在半句话上截断。' },
      { key: 'llm.temperature', label: '温度', type: 'float', min: 0, max: 2, step: 0.1, restart: true,
        note: '越高越发散；0 附近最稳，超过 1.5 容易跑偏。' },
    ],
  },
  {
    id: 'context', name: '上下文',
    note: '组装一轮对话时，往回看多远。',
    fields: [
      { key: 'context.maxFrames', label: '回看帧数', type: 'int', min: 1, max: 10000, unit: 'frames', restart: true,
        note: '每轮带多少条历史帧进去。索引不参与上下文组装，只做检索。' },
      { key: 'context.windowTokens', label: '窗口大小', type: 'int', min: 1024, max: 10000000, unit: 'tokens', restart: true,
        note: '水位百分比的分母。★ 只影响「用了多少」的显示，不影响模型真实窗口。' },
    ],
  },
  {
    id: 'persona', name: '人格层',
    note: '装哪些文件、上限多大、超了裁谁。',
    fields: [
      { key: 'persona.budget', label: '预算', type: 'int', min: 1000, max: 2000000, unit: 'bytes', restart: true,
        note: '字节上限。超了按 core 永不裁 → work → context 的顺序，从最可换的开始裁。' },
      { key: 'persona.files', label: '装载清单', type: 'files', restart: true,
        note: '每项的 path 必须真实存在；tier 决定超预算时先裁谁。' },
    ],
  },
  {
    id: 'events', name: '事件层',
    note: '每隔一会儿看一眼表，以及「静默」这条规则。',
    fields: [
      { key: 'events.intervalMs', label: '心跳间隔', type: 'int', min: 5000, max: 3600000, unit: 'ms', restart: true,
        note: '调度器多久 tick 一次。调小更灵敏，也更费 CPU。' },
      { key: 'events.silenceMs', label: '静默阈值', type: 'int', min: 60000, max: 86400000, unit: 'ms', restart: true,
        note: '会话静默多久记一条事件。实际检查间隔是它的一半。' },
      { key: 'events.session', label: '挂在哪个会话', type: 'string', allowNull: true, restart: true,
        note: '事件写进哪个会话；留空 = 不指定。' },
    ],
  },
  {
    id: 'organs', name: '器官',
    note: '看不见的东西要看得见 —— 换气是其中唯一有开关的一项。',
    fields: [
      { key: 'organs.huanqi.enabled', label: '换气开关', type: 'bool', restart: true, wired: false,
        note: '★ 配置里有、程序里没接线：当前没有任何代码读它，改了不会有任何变化。' },
      { key: 'organs.huanqi.stallThreshold', label: '连续空转阈值', type: 'int', min: 1, max: 50, unit: 'times', restart: true,
        note: '连续几次没产出就中断这一回合。太小会误杀，太大就是白烧。' },
      // ★ 2026-11-07：思考退化器官的四项判据阈值。默认值不在这一行写 ——
      //   它由 config.mjs 的 DEFAULTS 自动带出来（describeField 用 getIn(DEFAULTS, key)）。
      //   这四项只调「判得松还是紧」，判据本身在 organs/degradation.mjs 里。
      { key: 'organs.degradation.lowOutputTokens', label: '低产出阈值', type: 'int', min: 0, max: 100000, unit: 'tokens', restart: true,
        note: '一轮的 outputTokens ≤ 它就算「低产出」，连续几轮才升级。24 是拍的（一句中文回答约 10–20 token），没有真实分布可标定。' },
      { key: 'organs.degradation.sameTurnGrowthMin', label: '同轮膨胀阈值', type: 'int', min: 0, max: 10000000, unit: 'tokens', restart: true,
        note: '同一轮里上下文净增长 ≥ 它、且该轮累计产出为 0，才判「在往里塞东西」。' },
      { key: 'organs.degradation.watchAt', label: '观察档分数', type: 'int', min: 1, max: 100, unit: '分', restart: true,
        note: '证据权重加起来到几分进 watch（黄）。' },
      { key: 'organs.degradation.interveneAt', label: '干预档分数', type: 'int', min: 1, max: 100, unit: '分', restart: true,
        note: '到几分进 intervene（红）。★ 必须比「观察档分数」大，否则 watch 永远到不了 —— 这里不做交叉校验，写反了只会一直报警。' },
    ],
  },
  {
    id: 'autonomy', name: '自主',
    note: '人不在了，它自己动。★ 默认关着 —— 打开是一个明确的决定。',
    fields: [
      { key: 'autonomy.enabled', label: '总开关', type: 'bool', restart: true,
        note: '关着时连手动触发也不许绕过 —— 这是老版立下的规矩，不因这次改界面而松。' },
      { key: 'autonomy.idleThresholdMinutes', label: '静默多久算人不在', type: 'int', min: 1, max: 1440, unit: 'minutes', restart: true,
        note: '宿主按 session 上报的最后活动距今多久算「人不在」。★ 拿不到宿主上报 = UNKNOWN = 不动（不再拿本机会话文件的 mtime 顶）。' },
      { key: 'autonomy.maxRunsPerDay', label: '每日预算', type: 'int', min: 0, max: 1000, unit: 'runs', restart: true,
        note: '一天最多自己动几次。这是上限，不是目标。' },
      { key: 'autonomy.quietHours', label: '安静时段', type: 'hours', allowNull: true, restart: true,
        note: '这两个整点之间不动，例如 [2, 7]；留空 = 不设。' },
      // ★★ 2026-11-10 D 切片：字段名从 session 改成 targetSession，语义也换了 ——
      //   旧值**不自动迁移**（旧语义是「没有就新建 autonomy 容器」，那从来不是谁指定的目标）。
      // ★★★ 2026-11-11 语义修正（爀曦：「自主默认下发 lead，lead 会话 id 会随交接变化，
      //   所以默认动态匹配」）：D 切片把「留空」读成了「不下发」，那是**把能力收窄**了。
      { key: 'autonomy.targetSession', label: '自主下发给哪个会话', type: 'string', allowNull: true, restart: true,
        note: '★ 留空 = 跟随《墨》当前 lead（动态）；显式填写 = 固定覆盖（不请求心跳）；无法解析（心跳不可用 / 没主导 / 缺 id / 歧义）= 不下发。'
          + '绝不新建 autonomy 容器。填的话要填宿主回执里会回的那个会话 id（DSH 的 agent.id，通常带 session- 前缀，要逐字一致）。' },
      { key: 'autonomy.pushToHost', label: '推给宿主', type: 'bool', restart: true,
        note: '关 = 连宿主都不投（现在也没有「自己跑」这条退路）。这是一个明确决定，不是故障。' },
    ],
  },
  {
    id: 'soul', name: '书房',
    note: '扫哪儿、多久重扫一次。',
    fields: [
      { key: 'soul.root', label: '书房根目录', type: 'path', pathKind: 'dir', allowNull: true, restart: true,
        note: '扫它来算「书房 N 文件」。★ 留空 = 不配书房，器官卡就显示「未配置」—— 不替用户指一个别人的目录。' },
      { key: 'soul.ttl', label: '索引缓存窗口', type: 'int', min: 0, max: 600000, unit: 'ms', restart: true,
        note: '这么多毫秒内不重扫。调小更实时，代价是每次都要全量 walk。' },
    ],
  },
  {
    id: 'server', name: '服务',
    note: '监听在哪、库放在哪。★ 这一组改错会让下次启动起不来。',
    // ★★ 这四个键在 config.json 里是**顶层**的（host / port / dataDir / workspace），
    //    不是 server.* —— loadConfig() 读的就是顶层。第一版我按分组名加了 server. 前缀，
    //    结果 GET 全部显示「未设置」；POST 更糟：会往一个 loadConfig 根本不看的嵌套键里写，
    //    界面报「已写入、读回一致」，程序毫无变化。页面上显示的名字必须是文件里的名字。
    fields: [
      { key: 'host', label: '监听地址', type: 'string', restart: true,
        pattern: /^\S+$/, patternMessage: '不能有空格',
        note: '127.0.0.1 = 只有本机能连；0.0.0.0 = 局域网可达（自己判断该不该）。' },
      { key: 'port', label: '端口', type: 'int', min: 1, max: 65535, unit: 'port', restart: true,
        note: 'GUI 与 MCP 共用这一个端口。★ 环境变量 AGENT_SOUL_PORT 会盖过这里。' },
      { key: 'dataDir', label: '数据目录', type: 'path', pathKind: 'dir', restart: true,
        note: '会话与状态文件放哪。换了等于换一个库 —— 旧数据不会跟过去。' },
      { key: 'workspace', label: '工作区', type: 'path', pathKind: 'dir', allowNull: true, restart: true,
        note: '工具读写的工作区。留空 = 程序根目录。' },
    ],
  },
  {
    id: 'integrations', name: '集成（DSH 侧只读）',
    note: '概览页要读的两条 DSH 接口。★ 面板这一侧按显式配置显示（不配 = UNCONFIGURED，不猜端口）；'
      + '★ 自主/清理的**动态目标**另有一条自动发现的路（读最新 DSH 启动日志拿 origin，见 docs/DSH地址自动发现.md）。',
    fields: [
      { key: 'integrations.dshBaseUrl', label: 'DSH 地址', type: 'string', restart: false, allowNull: true,
        pattern: /^https?:\/\/[^\s]+$/i, patternMessage: '要是一个 http(s):// 开头的地址（只填 origin，不带路径）',
        note: '宿主 DSH 的 webServer origin，例如 http://127.0.0.1:<端口>。MCP Hub 与心跳都从这里派生（各加一条固定路径）。★ 留空 = 不配：概览上写 UNCONFIGURED，不去试任何端口。' },
      { key: 'integrations.mcpHubUrl', label: 'MCP Hub 覆盖', type: 'string', restart: false, allowNull: true,
        pattern: /^https?:\/\/[^\s]+$/i, patternMessage: '要是一个 http(s):// 开头的地址',
        note: '只想单独指 MCP Hub 时填 origin（会拼上 /mcp-hub/servers）。留空 = 用上面的 DSH 地址。' },
      { key: 'integrations.heartbeatUrl', label: '心跳覆盖', type: 'string', restart: false, allowNull: true,
        pattern: /^https?:\/\/[^\s]+$/i, patternMessage: '要是一个 http(s):// 开头的地址',
        note: '只想单独指心跳时填整条 URL（例如 …/heartbeat/auto）。留空 = <DSH 地址>/heartbeat/auto。' },
      { key: 'integrations.dshLogDir', label: 'DSH 启动日志目录', type: 'path', pathKind: 'dir', restart: false, allowNull: true,
        note: '心跳地址**自动发现**用：读这里最新的 server-*.out.log，只取 http://127.0.0.1:<port> 这个 origin（查询串/token 当场丢弃）。留空 = <DSH_HOME>/guard/logs（本机 = D:/AI/dsh/home/guard/logs）。' },
      { key: 'integrations.dshOriginFile', label: '心跳 origin 文件', type: 'path', pathKind: 'file', restart: false, allowNull: true,
        note: '心跳插件启动时写下的 dsh-origin.txt（内容就是它自己的 origin）。留空 = 开发机默认路径（文件存在才用，分发版不用）。' },
      { key: 'integrations.timeoutMs', label: '只读超时', type: 'int', min: 200, max: 15000, unit: 'ms', restart: false,
        note: '单次请求最多等多久。超时就按 read-fail 处理（面板写读不到），不拖住整页。' },
      { key: 'integrations.staleMs', label: '过期窗', type: 'int', min: 1000, max: 600000, unit: 'ms', restart: false,
        note: '上次读到的值最多还能顶多久；过了这个窗口就退回 unavailable / unreachable —— 不拿旧数冒充实况。' },
    ],
  },
];

const CFG_FIELD_INDEX = (() => {
  const m = new Map();
  for (const g of CFG_GROUPS) for (const fd of g.fields) m.set(fd.key, Object.assign({ group: g.id }, fd));
  return m;
})();

const sha256hex = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function getIn(obj, key) {
  let o = obj;
  for (const k of String(key).split('.')) {
    if (o === null || typeof o !== 'object') return undefined;
    o = o[k];
  }
  return o;
}

function setIn(obj, key, val) {
  const ks = String(key).split('.');
  let o = obj;
  for (let i = 0; i < ks.length - 1; i++) {
    if (!o[ks[i]] || typeof o[ks[i]] !== 'object') o[ks[i]] = {};
    o = o[ks[i]];
  }
  o[ks[ks.length - 1]] = val;
  return obj;
}

/** 路径比较要归一化 —— 同一个目录写成 D:/x 和 D:\\x，不该算「改过」 */
function normPathValue(p) {
  if (typeof p !== 'string' || !p) return '';
  try { return path.resolve(resolvePath(p)).replace(/\\/g, '/').toLowerCase(); } catch { return p; }
}

function sameValue(a, b, type) {
  if (type === 'path') return normPathValue(a) === normPathValue(b);
  const A = a === undefined ? null : a;
  const B = b === undefined ? null : b;
  return JSON.stringify(A) === JSON.stringify(B);
}

function fmtDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  if (n < 1000) return n + ' ms';
  if (n < 60000) return (n / 1000).toFixed(n % 1000 ? 1 : 0) + ' 秒';
  if (n < 3600000) return (n / 60000).toFixed(n % 60000 ? 1 : 0) + ' 分钟';
  return (n / 3600000).toFixed(n % 3600000 ? 1 : 0) + ' 小时';
}

/** 人类可读的值。服务端统一算好，两个页面就不会各写一套格式。 */
function displayOf(fd, v) {
  if (v === undefined || v === null) return '未设置';
  if (fd.type === 'bool') return v ? '开' : '关';
  if (fd.type === 'int' || fd.type === 'float') {
    const n = Number(v);
    if (fd.unit === 'ms') return n.toLocaleString('en-US') + ' ms · ' + fmtDuration(n);
    if (fd.unit === 'bytes') return n.toLocaleString('en-US') + ' B';
    return n.toLocaleString('en-US');
  }
  if (fd.type === 'hours') {
    return Array.isArray(v) && v.length === 2 ? v[0] + ' – ' + v[1] + ' 点' : String(v);
  }
  if (fd.type === 'strings') return Array.isArray(v) && v.length ? v.join('、') : '（空）';
  if (fd.type === 'files') return Array.isArray(v) ? v.length + ' 个文件' : String(v);
  return String(v);
}

/**
 * 敏感字段的唯一判据（1.0.4 · 独立验收 F-1）。
 *   secret    —— 秘密本体（llm.apiKey 等），只允许说「已配置 / 未配置」；
 *   apiKeyRef —— 秘密引用那一栏，只允许给白名单描述（合法引用 / unknown / invalid / (空)）。
 * ★ 判据只写在这一处。以前它散在两个 if 里，于是新增一个展示点就又漏一次。
 */
function isSensitiveField(fd) {
  return Boolean(fd) && (fd.type === 'secret' || fd.key === 'llm.apiKeyRef');
}

/**
 * **展示**敏感值的唯一出口（1.0.4 · F-1）。
 * @param {object} fd  字段描述（可以是 {}, 缺失的登记项就当普通字段）
 * @param {*} v        磁盘上 / 生效里的原值
 * @returns {string}   敏感字段永远只可能是：'已配置' / '未配置' / '(空)' / 合法引用原文 / 'unknown' / 'invalid'
 *
 * ★ 为什么必须是「展示函数」这一层，而不是某一个响应字段：
 *   1.0.3 只堵了 GET 的 value/fileValue/keyRef/refError，POST /api/config 的
 *   changed / restartRequired 还在用 displayOf(fd, prev) 原样拼旧值 —— 于是
 *   「用户把误填的 Key 改成合法引用」这个**修复动作本身**，把旧原值回显了两次，
 *   再被 settings.html 渲染成「…：<旧原值> → dpapi:…」。那正是 P2-1 要堵的东西。
 *   把判据放在这里，任何人以后再新增一个展示点，只要用 safeDisplayOf 就自动是安全的。
 */
function safeDisplayOf(fd, v) {
  const f = fd || {};
  if (f.type === 'secret') return (v === undefined || v === null || v === '') ? '未配置' : '已配置';
  if (f.key === 'llm.apiKeyRef') return describeApiKeyRef(v).display;
  return displayOf(f, v);
}

/** 读磁盘上的 config.json（不抛 —— 坏了也把错误带回去给页面看） */
function readConfigFile() {
  const file = configFile();
  if (!fs.existsSync(file)) {
    return { file, exists: false, data: {}, text: '', bytes: 0, sha256: null, mtime: null, error: null };
  }
  try {
    const text = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(text);
    const st = fs.statSync(file);
    return {
      file, exists: true, data, text,
      bytes: Buffer.byteLength(text),
      sha256: sha256hex(text).slice(0, 16),
      mtime: st.mtime.toISOString(),
      error: null,
    };
  } catch (e) {
    return { file, exists: true, data: null, text: '', bytes: 0, sha256: null, mtime: null,
      error: 'config.json 读不出来：' + String((e && e.message) || e) };
  }
}

/** 生效配置（含环境变量覆盖与路径解析）—— 与程序启动时用的是同一个函数 */
function loadEffective() {
  try { return { cfg: loadConfig(configFile()), error: null }; }
  catch (e) { return { cfg: null, error: String((e && e.message) || e) }; }
}

function describeField(fd, fileData, eff) {
  const out = {
    key: fd.key, label: fd.label, type: fd.type, note: fd.note,
    restart: fd.restart !== false,
    restartWhy: CFG_RESTART_WHY[fd.group] || '',
    wired: fd.wired !== false,
    envVar: CONFIG_ENV[fd.key] || null,
    // 给设置页用的控件元信息 —— 服务端说清约束，前端就不用自己记一套范围
    min: fd.min == null ? null : fd.min,
    max: fd.max == null ? null : fd.max,
    step: fd.step == null ? null : fd.step,
    unit: fd.unit || null,
    allowNull: fd.allowNull === true,
    pathKind: fd.pathKind || null,
  };

  // ★ 凭据：只给布尔值。value / fileValue / source / changed 一律不写进响应。
  //   ★ 1.0.3（独立验收 P2-1）：**响应里没有 value 字段**（连 null 都没有）。
  if (fd.type === 'secret') {
    const raw = eff ? getIn(eff, fd.key) : undefined;
    out.hasKey = typeof raw === 'string' && raw.length > 0;
    // ★ 1.0.2：告诉界面「这把 key 从哪来的」以及「引用为什么没解出来」。
    // ★ 1.0.3：keyRef 是用户可以手改的 config.json 里的**不可信输入** ——
    //   只回白名单内的合法引用；其余只给 'invalid' / 'unknown'，绝不原样回显。
    const refDesc = describeApiKeyRef(eff && eff.llm && eff.llm.apiKeyRef);
    out.keySource = (eff && eff.llm && eff.llm.apiKeySource) || 'none';
    out.keyRef = refDesc.display;
    out.keyRefKind = refDesc.kind;
    out.keyRefValid = refDesc.valid;
    out.refError = (eff && eff.llm && eff.llm.apiKeyRefError) || null;
    out.display = out.hasKey ? '已配置' : '未配置';
    out.defaultDisplay = '未配置';
    out.fileValue = null;
    return out;
  }

  const value = eff ? getIn(eff, fd.key) : undefined;
  const fileValue = fileData ? getIn(fileData, fd.key) : undefined;
  const def = getIn(DEFAULTS, fd.key);
  const envVar = CONFIG_ENV[fd.key];
  const envSet = Boolean(envVar && process.env[envVar] !== undefined && process.env[envVar] !== '');

  out.value = value === undefined ? null : value;
  out.fileValue = fileValue === undefined ? null : fileValue;
  out.hasFileValue = fileValue !== undefined;
  out.defaultValue = def === undefined ? null : def;
  out.source = envSet ? 'env' : (fileValue !== undefined ? 'file' : 'default');
  out.changed = fileValue !== undefined && !sameValue(fileValue, def, fd.type);
  // ★ 1.0.4（F-1）：一律走 safeDisplayOf —— 这里虽然只剩 apiKeyRef 一种敏感字段
  //   （secret 在上面已经 return 了），但口径必须和 POST 回执、页面元信息是同一个。
  out.display = safeDisplayOf(fd, value);
  out.defaultDisplay = safeDisplayOf(fd, def);

  // ★ 1.0.3（独立验收 P2-1 的第三个出口）：llm.apiKeyRef 本身也是一栏**普通字符串**，
  //   旧实现把 config.json 里的原值直接放进 value / fileValue 回显 —— secret 字段的
  //   防护被从旁边绕过去了。这里把它降级成「白名单描述」：
  //   合法引用原样（dpapi:deepseek-official 与 1.0.2 完全兼容），其余只有 invalid / unknown。
  //   value 与 fileValue 用同一个安全值 —— 界面上的输入框不会替用户"记住"原始内容。
  if (fd.key === 'llm.apiKeyRef') {
    const rawRef = fileValue !== undefined ? fileValue : value;
    const rd = describeApiKeyRef(rawRef);
    const safe = rd.kind === 'empty' ? null : rd.display;
    out.value = safe;
    out.fileValue = safe;
    out.display = rd.kind === 'empty' ? '(空)' : rd.display;
    out.defaultDisplay = '(空)';
    out.refKind = rd.kind;
    out.refValid = rd.valid;
    return out;
  }

  if (fd.type === 'path' && typeof value === 'string') {
    const abs = path.resolve(resolvePath(value));
    out.resolved = abs;
    try { out.pathType = fs.statSync(abs).isDirectory() ? 'dir' : 'file'; out.exists = true; }
    catch { out.pathType = null; out.exists = false; }
  }
  if (fd.type === 'files' && Array.isArray(value)) {
    out.items = value.map((it) => {
      const p = it && typeof it === 'object' ? String(it.path || '') : String(it || '');
      const abs = p ? path.resolve(resolvePath(p)) : '';
      let ok = false;
      try { ok = fs.statSync(abs).isFile(); } catch { ok = false; }
      return { path: p, name: (it && it.name) || path.basename(abs || p), tier: (it && it.tier) || 'context', exists: ok };
    });
  }
  return out;
}

/** 一次完整的「当前状态」快照 —— GET 与 POST 的成功响应共用它 */
function buildConfigView() {
  const f = readConfigFile();
  const eff = loadEffective();
  const groups = [];
  for (const g of CFG_GROUPS) {
    const fields = g.fields.map((fd) => describeField(Object.assign({ group: g.id }, fd), f.data, eff.cfg));
    groups.push({ id: g.id, name: g.name, note: g.note, restartWhy: CFG_RESTART_WHY[g.id] || '', fields });
  }
  const all = [];
  for (const g of groups) for (const x of g.fields) all.push(x);
  return {
    ok: !f.error && !eff.error,
    at: new Date().toISOString(),
    file: f.file,
    exists: f.exists,
    sha256: f.sha256,
    bytes: f.bytes,
    mtime: f.mtime,
    fileError: f.error,
    configError: eff.error,
    groups,
    stats: {
      total: all.length,
      changed: all.filter((x) => x.changed).length,
      env: all.filter((x) => x.source === 'env').length,
      restart: all.filter((x) => x.restart).length,
      unwired: all.filter((x) => x.wired === false).length,
    },
  };
}

/** 单个字段的校验。返回错误句子数组（空 = 通过）。 */
function validateField(fd, v) {
  const errs = [];
  if (v === null) {
    if (!fd.allowNull) errs.push(fd.label + ' 不能为空');
    return errs;
  }
  switch (fd.type) {
    case 'bool':
      if (typeof v !== 'boolean') errs.push(fd.label + ' 只能是开或关');
      break;
    case 'int':
      if (typeof v !== 'number' || !Number.isInteger(v)) errs.push(fd.label + ' 必须是整数');
      else if (fd.min != null && v < fd.min) errs.push(fd.label + ' 不能小于 ' + fd.min);
      else if (fd.max != null && v > fd.max) errs.push(fd.label + ' 不能大于 ' + fd.max);
      break;
    case 'float':
      if (typeof v !== 'number' || !Number.isFinite(v)) errs.push(fd.label + ' 必须是数字');
      else if (fd.min != null && v < fd.min) errs.push(fd.label + ' 不能小于 ' + fd.min);
      else if (fd.max != null && v > fd.max) errs.push(fd.label + ' 不能大于 ' + fd.max);
      break;
    case 'string': {
      if (typeof v !== 'string') { errs.push(fd.label + ' 必须是文本'); break; }
      const s = v.trim();
      if (!s && !fd.allowNull) errs.push(fd.label + ' 不能是空白');
      else if (s.length > 2000) errs.push(fd.label + ' 太长（最多 2000 字符）');
      else if (s && fd.pattern && !fd.pattern.test(s)) errs.push(fd.patternMessage || (fd.label + ' 格式不对'));
      break;
    }
    case 'path': {
      if (typeof v !== 'string' || !v.trim()) { errs.push(fd.label + ' 不能是空路径'); break; }
      const abs = path.resolve(resolvePath(v.trim()));
      let st = null;
      try { st = fs.statSync(abs); } catch { st = null; }
      if (!st) errs.push(fd.label + ' 指向的路径不存在：' + abs);
      else if (fd.pathKind === 'dir' && !st.isDirectory()) errs.push(fd.label + ' 不是目录：' + abs);
      else if (fd.pathKind === 'file' && !st.isFile()) errs.push(fd.label + ' 不是文件：' + abs);
      break;
    }
    case 'strings': {
      if (!Array.isArray(v)) { errs.push(fd.label + ' 要是字符串数组'); break; }
      if (v.some((x) => typeof x !== 'string' || !x.trim())) errs.push(fd.label + ' 里有空项');
      if (v.length > 200) errs.push(fd.label + ' 最多 200 项');
      break;
    }
    case 'hours': {
      if (!Array.isArray(v) || v.length !== 2) { errs.push(fd.label + ' 要两个整点，例如 [2, 7]'); break; }
      if (!v.every((h) => typeof h === 'number' && Number.isInteger(h) && h >= 0 && h <= 23)) {
        errs.push(fd.label + ' 的小时要在 0..23 之间');
      }
      break;
    }
    case 'files': {
      if (!Array.isArray(v)) { errs.push(fd.label + ' 要是数组'); break; }
      v.forEach((it, i) => {
        const at = '第 ' + (i + 1) + ' 项';
        if (!it || typeof it !== 'object') { errs.push(at + ' 格式不对'); return; }
        if (typeof it.path !== 'string' || !it.path.trim()) { errs.push(at + ' path 不能为空'); return; }
        if (['core', 'work', 'context'].indexOf(it.tier) < 0) { errs.push(at + ' 的 tier 只能是 core / work / context'); }
        const abs = path.resolve(resolvePath(it.path.trim()));
        let ok = false;
        try { ok = fs.statSync(abs).isFile(); } catch { ok = false; }
        if (!ok) errs.push(at + ' 的文件不存在：' + abs);
      });
      break;
    }
    default:
      break;
  }
  return errs;
}

/** 把提交上来的值收拾成要落盘的形状 */
function normalizeField(fd, v) {
  if (v === null) return null;
  switch (fd.type) {
    case 'int': return Math.trunc(Number(v));
    case 'float': return Number(v);
    case 'bool': return Boolean(v);
    case 'string': return String(v).trim();
    case 'path': return String(v).trim();
    case 'strings': return v.map((x) => String(x).trim()).filter(Boolean);
    case 'hours': return [Number(v[0]), Number(v[1])];
    case 'files': return v.map((it) => {
      const abs = path.resolve(resolvePath(String(it.path).trim()));
      return {
        path: String(it.path).trim(),
        tier: it.tier,
        name: (it.name && String(it.name).trim()) || path.basename(abs),
      };
    });
    default: return v;
  }
}

/**
 * 原子写：同目录先写 .tmp，落盘后再 rename 覆盖。
 *
 * ★ 为什么非要这么写：rename 是原子的 —— 要么旧文件还在，要么新文件整份在位，
 *   不存在「写到一半程序被关掉，config.json 变成半截 JSON」这种状态。
 *   config.json 坏了，下次启动直接起不来，所以这一步不能省。
 * ★ Windows 上如果编辑器正开着这个文件，rename 会 EBUSY —— 所以重试几次再说失败。
 */
async function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, text, 'utf8');
    try { fs.fsyncSync(fd); } catch { /* 有些文件系统不支持 fsync，不影响 rename 的原子性 */ }
    fs.closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }

  let lastErr = null;
  for (let i = 0; i < 4; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 60 * (i + 1))); }
  }
  try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  throw new Error('rename 失败（文件可能正被别的程序占着）：' + String((lastErr && lastErr.message) || lastErr));
}

// ★ degradation 是**第七个平级器官**（和 autonomy / ledger / persona 一样），
//   不挂在 control 底下：hub 认识「谁连上来了、谁会什么」，器官认识「这意味着什么」。
// ★ 2026-11-10：多收一个 llm —— /api/guard 的模糊层要用**同一个** LlmClient 实例。
//   不新建第二套宿主：配置、协议、key 来源、运行统计都跟对话主链路共用一份。
export function createServer({ store, loop, tools, config, bus, sched, persona, autonomy, ledger, control, degradation, eventsIngress = null, sessionDispatch: sessionDispatchIn = null, llm = null, cleanup = null, echoSentinel = null }) {
  // ★ overview 缓存：首次采集要 3.2 秒（1006 个会话建索引），开页面等这么久不可接受。
  //   30 秒内的重复请求直接回缓存；?fresh=1 强制重算。
  let ovCache = null, ovAt = 0;
  const OV_TTL = 30000;
  // ★ 2026-11-10（概览状态面板）：四块只读状态 —— 控制通道 / MCP Hub / DSH 心跳 / 模型。
  //   在 createServer 里只建一次，是为了让「上次读到的值」能跨请求活下来：
  //   DSH 重启的那几十秒里，面板不该从「有数」瞬间变「全空」—— 那会让人以为是自己这边坏了。
  // ★ 2026-11-13：把 autumn 传进去 —— DSH 心跳不通时，这一格改用本进程判定。
  //   （爀曦：「心跳插件集成到 v4 之后就禁用 DSH 侧的心跳插件」）
  const collectRuntimeStatus = createRuntimeStatusCollector({ config, control, loop, autonomy });
  // ★ 2026-11-12：会话调度器**只建一次** —— 它自己带计数（counts / noHost / lastOutcome），
  //   每个请求新建的话，观测面永远是刚开机的样子。
  //   control 不存在时也建得起来：view() 如实报 hostCount:0，调用回 NO_CONTROL。
  // ★ 用 index.mjs 传进来的那个（与事件层共用，读数是同一份）；没传才自己建一个。
  const sessionDispatch = sessionDispatchIn || createSessionDispatch({
    hub: control,
    // 日志只留「动作 + 成没成」，正文不进日志（与 view() 同一口径）。
    log: (m) => { try { if (bus && typeof bus.emit === 'function') bus.emit('log', m); } catch { /* 日志炸了不许把请求带下去 */ } },
  });
  /**
   * /api/guard 的模糊层参数。
   * ★ 三件事都收口在这里，路由里不写第二次：
   *   ① llm —— 传进去的是**同一个实例**（index.mjs 建的那个），不另建；
   *   ② llmConfigured —— 「没配」和「调用失败」必须能分开，所以由 client.ready() 显式给出；
   *   ③ 上限 —— 环境变量可调，但 guard 里还有硬顶（clampInt），这里给的是意图不是权力。
   */
  function guardLlmOpts(client) {
    const ms = Number(process.env.AGENT_SOUL_GUARD_LLM_TIMEOUT_MS);
    const chars = Number(process.env.AGENT_SOUL_GUARD_MAX_CHARS);
    return {
      llm: client || null,
      llmConfigured: Boolean(client && (typeof client.ready === 'function' ? client.ready() : typeof client.chat === 'function')),
      timeoutMs: Number.isFinite(ms) && ms > 0 ? ms : undefined,
      maxChars: Number.isFinite(chars) && chars > 0 ? chars : undefined,
    };
  }
  let soulIdx = null;   // 书房索引（懒建，常驻）
  // ★ 磁盘占用单独缓存 5 分钟 —— 1006 个会话 × 2 次 stat 是 3 秒的大头，
  //   而磁盘大小不会每 30 秒变一次。overview 的 30 秒缓存挡不住首次，这一层能。
  let diskCache = null, diskAt = 0;
  const DISK_TTL = 300000;
  // ★ 2026-11-09 修 cacheMB：_index.cache / _index.fp 在 **dataDir** 下，不在 store.root 下
  //   （store.root = dataDir/sessions）。以前拼成 store.root/_index.cache → 多一层目录
  //   → stat 失败被 sizeOf 吞成 0 → 读数恒为 0，而「0 MB」和「文件不存在」长得一样，读数就废了。
  //   路径的唯一来源 = store 自己算好的 cacheFile / fpFile（store.mjs:84 写的就是这两个字段，
  //   saveIndexCache 也写它们）；store 没给才退回 config.dataDir。**绝不从 store.root 推**。
  // ★ 2026-11-09 晚：算式搬进 status-data.mjs —— **同一个读数只能有一份实现**。
  //   状态台的 ECHO 层也要这个数，两处各写一遍迟早漂（这个项目在「两把尺子」上付过代价）。
  //   搬走的是算式，不是语义：一个都 stat 不到 → null（未知），不是 0（真的 0 字节）。
  const measureCacheBytes = () => measureCacheBytesOf(store, config);
  // ★ 同一个进程、同一个端口，既服务 UI 也服务 MCP。
  //   理由：爀曦 2026-11-07 说清了形态 ——「双击桌面图标 → 程序界面出来了，MCP 服务器也起来了」。
  //   两个进程 = 要起两次 = 用户会忘。**一个进程两个职责**才对。
  let mcpHandler = null;
  (async () => { try { const m = await import('../adapters/mcp-http.mjs'); mcpHandler = m.createMcpHttpHandler(); } catch { /* 没挂上也不影响 UI */ } })();

  // ★★ 2026-11-11：最小鉴权。判据与路径清单在 web/auth.mjs ——
  //   只读不设卡，写/执行要 token。token 只在 <dataDir>/token.txt，不进 config。
  const auth = createAuth({ dataDir: config.dataDir, log: (m) => { if (!config.quiet) console.log('  [鉴权] ' + m); } });

  const server = http.createServer(async (req, res) => {
    // MCP over HTTP 先试（它认 /mcp，其余交回下面）
    if (mcpHandler) {
      try { if (await mcpHandler(req, res)) return; } catch { /* 落到 UI 路由 */ }
    }
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    const p = url.pathname;

    // ★★ 2026-11-11（批二收尾）：**写/执行的接口先过锁**，再进任何路由。
    //   位置很关键：在 readBody 之前 —— 否则 POST /api/turn 的帧已经 append 了，
    //   「拒绝」只是没写进响应，副作用已经发生（这个道理 readOnly 闸那一段已经写过了）。
    //   ★ 只读的 /api/health、/api/vitals、/api/questions 不设卡：界面要靠它们活着。
    if (needsAuth(p, req.method) && !auth.ok(req, url)) {
      return json(res, 401, {
        ok: false, error: 'missing-or-bad-token',
        hint: '页面会内联注入；脚本请读 <dataDir>/token.txt 放到 X-Soul-Token 头里',
      });
    }

    // ═══════════════════════════════════════════════════════════════════
    // ★★ 2026-11-10 · G2a 显式只读闸（AGENT_SOUL_READONLY=1）
    //
    //   位置是三件事一起决定的，不是随手放的：
    //     ① 在 **mcpHandler 之后** —— /mcp 的 POST 必须交给 MCP 那一份 manifest
    //        逐个 tools/call 判（MCP 的粒度是「工具 × action」，HTTP 这一层判不了）；
    //     ② 在 **readBody() 之前** —— 否则 POST /api/config 的 body 已经被读进来、
    //        POST /api/turn 的帧已经 append 了，"拒绝"只是没写进响应，副作用已经发生；
    //     ③ 在**整条路由链之前** —— manifest 之外的东西（现在没有、以后会有的 POST）
    //        一律默认拒绝。写面清单是白名单，不是黑名单。
    //
    //   ★ 拒绝的形状（reason=UNAVAILABLE / code=SOUL_READONLY / service=online）由
    //     manifest 的 rejection() 统一生成 —— 两条腿同一份，上游只写一次解析。
    //   ★ 没有 AGENT_SOUL_READONLY=1 时，这一段整段不执行，生产默认行为一个字都不变。
    // ═══════════════════════════════════════════════════════════════════
    if (readonlyEnabled()) {
      const v = classifyHttp(req.method, p);
      if (v.verdict !== 'read' && v.verdict !== 'control' && v.verdict !== 'delegate') {
        return json(res, 403, rejection('http', v, { method: req.method, path: p }));
      }
    }

    try {
      // —— 静态壳 ——
      // ★★ 2026-11-11（爀曦拍板）：**首页是对话页，不是监控台**。
      //   起因：打开旧首页（dashboard）时它要装配 81 个会话的索引 + 读会话元数据，
      //   叠上后台那个每 30 秒一次、每次「跳过 1352 个没变的」会话扫描（实测最长阻塞 3076ms），
      //   WebView2 等不到就 ConnectionAborted —— 用户看到的是「页面加载失败」。
      //   判据：**v4 的正面是它自己那个 LLM 的对话界面；监控台是后台，不该挡在门口。**
      //   所以 / 给对话（shell.html，纯 /api/turn，不碰会话索引），dashboard 挪到 /dashboard。
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const chat = path.join(HERE, 'shell.html');
        // ★ 2026-11-11：把 token 内联进页面（同源）。前端用 fetch 拦截器自动带上 ——
        //   **不新增一个「取 token」的 HTTP 口**，那种口等于把锁挂在门上。
        const injected = '<script>window.__SOUL_TOKEN=' + JSON.stringify(auth.token) + ';</script>';
        let html = fs.readFileSync(fs.existsSync(chat) ? chat : path.join(HERE, 'dashboard.html')).toString('utf8');
        html = html.indexOf('</head>') >= 0 ? html.replace('</head>', injected + '</head>') : injected + html;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
      }
      // 监控台保留原地址之后的新门 —— 老书签不炸，只是不再挡在首页。
      if (req.method === 'GET' && p === '/dashboard') {
        const f = path.join(HERE, 'dashboard.html');
        if (!fs.existsSync(f)) return json(res, 404, { error: '页面文件缺失：src/web/dashboard.html' });
        const html = fs.readFileSync(f, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
      }
      if (req.method === 'GET' && p === '/chat') {
        const html = fs.readFileSync(path.join(HERE, 'shell.html'));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      // ★ 参数 / 设置 / 器官三页：同一个壳，三块面板。
      //   缺文件时明确报 404 并说缺哪个 —— 不要让浏览器拿到一屏 404 HTML 再猜。
      // ★ 2026-11-12：从一串三元改成表 —— 加第六页时那行已经长到看不清了。
      //   ★ 表还有一个好处：加了页面但没加进表里，比三元写漏更容易看出来（几行并列，一眼能比对）。
      /**
 * ★ 2026-11-13：判断 LLM **真能不能用**（不只是 key 在不在）。
 *
 *   起因：health 显示 llmReady:true，而实际调用返回 HTTP 402 Insufficient Balance。
 *   `ready()` 只查 baseUrl 和 apiKey 有没有 —— 那是**配置**，不是**能力**。
 *
 *   这里用已有统计（stats）推：最近一次真实调用的结果是成功还是失败。
 *   ★ 不额外发请求（health 会被轮询，探一次就多一次外网开销 + 一次计费）。
 *   ★ 从没调用过 = usable（不知道 ≠ 不可用，别一上来就报错）。
 */
function llmUsability (llm) {
  try {
    if (!llm || typeof llm.stats !== 'function') return { llmUsable: null, llmLastError: null }
    const s = llm.stats() || {}
    const okAt = s.lastOkAt ? Date.parse(s.lastOkAt) : 0
    const errAt = s.lastErrorAt ? Date.parse(s.lastErrorAt) : 0
    // 从没失败过，或最后一次成功晚于最后一次失败 → 可用
    const usable = Boolean(s.ready) && (!errAt || okAt > errAt)
    return {
      llmUsable: usable,
      // ★ 最近一次失败原文（已脱敏，客户端会截断显示）—— 402 会带 Insufficient Balance
      llmLastError: (usable ? null : (s.lastError || null)),
      llmLastErrorAt: (usable ? null : (s.lastErrorAt || null)),
      llmCalls: s.calls ?? null,
      llmFailures: s.failures ?? null,
    }
  } catch { return { llmUsable: null, llmLastError: null } }
}

const PAGE_OF = {
        // ★ 2026-11-13：/params 合并进 /settings（见下面 302 重定向）。
  //   理由：/params 是只读看生效值，/settings 是可编辑 —— 而设置的输入框本来就显示当前值，
  //   两页可以合成一页。params 独有的四个统计数（总数/改动/环境变量/重启）已搬进 settings 顶部。
        '/settings': 'settings.html',
        '/organs': 'organs.html',
        '/diary': 'diary.html',
        '/yantai': 'yantai.html',
        // ★ 2026-11-12：换成 aurabot **自己的面板**（整个插件搬进 v4 之后）。
        //   旧的 aurabot.html 是我手写的只读仪表盘，留着当兜底。
        '/aurabot': 'aurabot-panel.html',
        // ★ 2026-11-13：echo 体检页（v3 的 dsh-yanqing-echo 在 v4 的对应物）
        '/echo': 'echo.html',
        // ★ 2026-11-13：台账面板（v3 的 lead-waker 面板在 v4 的对应物）
        '/waker': 'waker.html',
      };
      // ★ 2026-11-13：/sphere → /lumen（状态球并入星系，旧地址重定向）
  if (req.method === 'GET' && (p === '/sphere' || p === '/sphere.html')) {
    res.writeHead(302, { Location: '/lumen' });
    return res.end();
  }
  // ★ 2026-11-13：/params → /settings（合并后的旧地址，永久重定向）
  if (req.method === 'GET' && (p === '/params' || p === '/params.html')) {
    res.writeHead(302, { Location: '/settings' });
    return res.end();
  }
  if (req.method === 'GET' && PAGE_OF[p]) {
        const name = PAGE_OF[p];
        const f = path.join(HERE, name);
        if (!fs.existsSync(f)) return json(res, 404, { error: '页面文件缺失：src/web/' + name });
        const html = fs.readFileSync(f, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
      }

      // ★ 2026-11-11 新增：/ask —— 回答 v4 问你的问题。
      //   为什么单独一页：它不是「看数据」，是「做一个动作」（是 / 否）。
      //   塞进 dashboard 会让那页同时承担「看」和「答」两种节奏。
      // ★ 2026-11-11：状态球（3D 状态演示）。纯 CSS 3D，零依赖，拖动可转。
      if (req.method === 'GET' && p === '/sphere') {
        const f = path.join(HERE, 'sphere.html');
        if (!fs.existsSync(f)) return json(res, 404, { error: '页面文件缺失：src/web/sphere.html' });
        const html = fs.readFileSync(f, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
      }
      if (req.method === 'GET' && p === '/ask') {
        const f = path.join(HERE, 'ask.html');
        if (!fs.existsSync(f)) return json(res, 404, { error: '页面文件缺失：src/web/ask.html' });
        const html = fs.readFileSync(f, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
      }

      // ★ 2026-11-09 新增：状态台（三水位 + 六层）。
      //   单独一段，**不动上面那张共用的路由表** —— 往一个共用条件里加路径，
      //   等于同时动六个页面的行为；这一页是纯新增，就该走纯新增的门。
      if (req.method === 'GET' && p === '/status') {
        const f = path.join(HERE, 'status.html');
        if (!fs.existsSync(f)) return json(res, 404, { error: '页面文件缺失：src/web/status.html' });
        const html = fs.readFileSync(f, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
      }

      // ★ 2026-11-11 新增：极光腔（3D 六层运行状态）。与 /status、/sphere 并存 ——
      //   旧页不删（它是走弯路的证据），新页走新门，验收过了再切。
      if (req.method === 'GET' && (p === '/lumen' || p === '/lumen.html')) {
        const f = path.join(HERE, 'lumen.html');
        if (!fs.existsSync(f)) return json(res, 404, { error: '页面文件缺失：src/web/lumen.html' });
        const html = fs.readFileSync(f, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html) });
        return res.end(html);
      }

      // ★ 2026-11-11：three.js 走本地 vendor（仍是白名单两个文件名，不做通用静态目录）。
      if (req.method === 'GET' && (p === '/vendor/three.module.min.js' || p === '/vendor/OrbitControls.js')) {
        const name = p.slice('/vendor/'.length);
        const f = path.join(HERE, 'vendor', name);
        if (!fs.existsSync(f)) return json(res, 404, { error: '静态文件缺失：src/web/vendor/' + name });
        const buf = fs.readFileSync(f);
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
        });
        return res.end(buf);
      }

      // ★ 2026-11-10 新增：极光设计系统的两份共享文件（aurora.css / aurora.js）。
      //   八页都靠 <link href='/aurora.css'> 与 <script src='/aurora.js'> 引用它们，
      //   所以这两个路径必须有人应答 —— 否则页面拿到 404，整页退回无样式。
      //   只放行这两个文件名（白名单，不做通用静态目录）：少一个可遍历的面。
      if (req.method === 'GET' && (p === '/aurora.css' || p === '/aurora.js')) {
        const name = p.slice(1);
        const f = path.join(HERE, name);
        if (!fs.existsSync(f)) return json(res, 404, { error: '静态文件缺失：src/web/' + name });
        const buf = fs.readFileSync(f);
        res.writeHead(200, {
          'Content-Type': name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/javascript; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
        });
        return res.end(buf);
      }

      // —— 仪表盘 · 数据可视化（全部真实读数，不写死一个） ——
      // —— 活体：我现在在等谁 / 刚判了什么 ——
      // ★ 2026-11-07：这三样以前面板上看不到，所以「宪章 pass 了却没传到」
      //   只能靠翻 JSON 文件才发现。现在摊到台面上。
      if (p === '/api/live' && req.method === 'GET') {
        // ★ 2026-11-10（R1）：不再写死开发机路径。判据在 config.mjs 的 statusDirOf()，
        //   与 status-data.mjs 共用一处 —— 分发版落到 <安装根>/workspace，不读开发机目录。
        // ★ 2026-11-10（三项修复之二）：**文件名**也收进 config.mjs（wakerLedgerFileOf / wakerDeliveredFileOf）——
        //   statusDir 是一处判据，文件名是另一处；分开写两次，早晚会有一个走岔。
        const safeJson = (f) => { try { return JSON.parse(require$('node:fs').readFileSync(f, 'utf8')); } catch { return null; } };
        const led = safeJson(wakerLedgerFileOf(config)) || {};
        const st = safeJson(wakerDeliveredFileOf(config)) || {};
        const evs = led.events || [];
        const stage = (x) => String(x.stage || '');
        const pend = evs.filter((x) => stage(x) === 'pending' || stage(x) === 'woken');
        const blocked = evs.filter((x) => stage(x) === 'blocked');
        const recent = evs.slice(-8).reverse().map((x) => ({
          t: x.t, title: String(x.title || '').slice(0, 80), stage: x.stage,
          charter: x.charter, note: String(x.charterNote || '').slice(0, 100),
        }));
        // ★★ 2026-11-11（爀曦报的）：界面上永远挂着「投递中 3 / 投递失败 3」，而那三件事早完成了。
        //   查到真因：`lead-waker-已投递.json` 里留着**陈旧记录** ——
        //     · inflight 三条 phase=sent，挂了 **14 小时**（投递是秒级的事，它不可能还在途）；
        //     · fails 十二条，最老那条是 **5 天前**。
        //   v4 之前只是照读这个文件，没做时间判断 —— 于是「历史」被当成「此刻」。
        //   ★ 判据：150 秒判失败，那 10 分钟就是**绝对不可能在途**。超过就折叠，不当作现状。
        //   ★ 但折叠不等于隐瞒：另给 stale 计数，界面上写「另有 N 条更早的记录」。
        const LIVE_WINDOW_MS = 10 * 60 * 1000;
        const fresh = (x) => (Date.now() - Number(x && x.at || 0)) < LIVE_WINDOW_MS;
        const allInflight = Object.values(st.downInflight || {});
        const allFails = st.downFails || [];
        const inflight = allInflight.filter(fresh).map((v) => ({
          phase: v.phase, waitedMs: Date.now() - Number(v.at || 0), text: String(v.text || '').slice(0, 60),
        }));
        const freshFails = allFails.filter(fresh);
        return json(res, 200, {
          now: Date.now(),
          waiting: { pending: pend.length, blocked: blocked.length, total: evs.length },
          inflight,
          fails: freshFails.slice(-3).reverse(),
          stale: { inflight: allInflight.length - inflight.length, fails: allFails.length - freshFails.length },
          recent,
        });
      }

      if (p === '/api/overview' && req.method === 'GET') {
        const fresh = url.searchParams.get('fresh') === '1';
        if (!fresh && ovCache && Date.now() - ovAt < OV_TTL) {
          // ★ 缓存命中也要给最新趋势：采样窗口会随别的请求往前走，
          //   把旧 payload 里的 series 原样返回 = 趋势看上去卡住了。
          return json(res, 200, { ...ovCache, series: getSeries(), cached: true, cacheAgeMs: Date.now() - ovAt });
        }
        const t0 = Date.now();
        const prof = [];
        const mark = (n, t) => prof.push(n + ':' + (Date.now() - t));
        const _t1 = Date.now();
        const metas = fresh ? store.list({ fresh: true }) : store.list();
        mark('list', _t1);
        const _t2 = Date.now();
        try { store.buildIndex(); } catch { /* 索引没建好也不挡这一页 */ }
        mark('buildIndex', _t2);

        const _t3 = Date.now();
        let indexRows = 0;
        if (store.ix && typeof store.ix.forEach === 'function') {
          for (const [, arr] of store.ix) indexRows += Array.isArray(arr) ? arr.length : 0;
        }

        const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
        mark('indexRows', _t3);
        const _t4 = Date.now();
        let dataBytes = 0, cacheBytes = 0;
        if (!diskCache || Date.now() - diskAt > DISK_TTL) {
          try { for (const m of metas) dataBytes += sizeOf(path.join(store.root, m.id, 'frames.jsonl')) + sizeOf(path.join(store.root, m.id, 'index.jsonl')); } catch {}
          cacheBytes = measureCacheBytes();
          diskCache = { dataBytes, cacheBytes }; diskAt = Date.now();
        } else { dataBytes = diskCache.dataBytes; cacheBytes = diskCache.cacheBytes; }

        mark('disk', _t4);
        const _t5 = Date.now();
        // 检索实测（挑一个真实存在的会话，量一次）
        let searchMs = null, searchHits = 0;
        try {
          if (metas.length) {
            const probe = metas[0].id;
            const t1 = Date.now();
            searchHits = store.search(probe, '会话').length;
            searchMs = Date.now() - t1;
          }
        } catch { /* 量不到就 null */ }

        mark('search', _t5);
        const _t6 = Date.now();
        const mem = process.memoryUsage();
        const pr = (() => { try { return persona && persona.render(); } catch { return null; } })();

        const payload = {
          at: new Date().toISOString(),
          tookMs: Date.now() - t0,
          sessions: metas.length,
          indexRows,
          dataMB: Math.round(dataBytes / 1048576 * 10) / 10,
          // ★ 取不到就是 null（= 未知），不是 0 —— 0 与「文件不存在」必须可区分。
          cacheMB: cacheBytes === null ? null : Math.round(cacheBytes / 1048576 * 10) / 10,
          cacheAvailable: cacheBytes !== null,
          searchMs,
          searchHits,
          memMB: Math.round(mem.rss / 1048576),
          heapMB: Math.round(mem.heapUsed / 1048576),
          uptimeSec: Math.round(process.uptime()),
          node: process.version,
          llmReady: loop.llm.ready(),
          // ★ 2026-11-13：`llmReady` 只证明「key 解得开」，不证明「账户有钱」。
          //   今天的教训：health 显示 llmReady:true，实际每次调用都 HTTP 402 Insufficient Balance。
          //   → 加 llmUsable：**最近一次真实调用的结果**（不额外探，只用已有统计）。
          //   判据：ready && （从没失败过 或 最后一次成功晚于最后一次失败）
          ...llmUsability(loop.llm),
          // ★ 2026-11-07 加：**缺模型时告诉用户去哪填**，而不只是「未配」。
          //   爀曦定：「发布的时候可以留空，要求用户填写」——
          //   那就必须有一句话说清怎么填，否则「留空」等于「坏了」。
          llmHint: loop.llm.ready() ? null : {
            what: '还差一个 API Key',
            where: [
              '运行一次 AgentSoul-Setup 安装向导，在「API 配置」页填（推荐；key 会用 DPAPI 收起来）',
              '或在本页「设置」里改「API Key」那一项',
              '或在 config.json 里配 llm.apiKeyRef = dpapi:<providerId> / env:<变量名>',
              '或设环境变量 AGENT_SOUL_KEY（优先级最高）',
            ],
            effect: '不填也能用：检索、心跳、审核的规则层都正常。只有需要模型的部分会降级 —— 审核的模糊判断转人工，换气诊断做不了。',
            restart: '填完要重启才生效（key 是启动时读的）',
          },
          model: config.llm.model,
          tools: tools.tools.size,
          persona: pr ? { used: pr.used, budget: pr.budget, dropped: pr.dropped } : null,
          events: { rules: sched ? sched.rules.length : 0, ticks: sched ? sched.stats().ticks : 0 },
          // ★ 2026-11-07 加：概览页要能看见「谁连着」。
          //   原来这件事只能翻 gui.log 猜，而那是 >> 重定向的 stdout（块缓冲），
          //   连接建立了日志也可能几十分钟不出现 —— 会骗人。
          // ★★ 2026-11-10 修（原 bug：868-870 行）：这里原来只抄 id/host/caps/stubs/connectedAt，
          //   **把 hello.meta 整块丢了** —— 桥接报的 pid / plugin / version / contextWindow /
          //   contextTokens / watermarkSource 一个都没到过界面。丢字段不报错，只会让人以为
          //   「宿主没报」，是最难查的那一类。现在走同一份 buildControlView（与 /api/runtime-status
          //   一字不差），旧字段一个不少，新字段只增不减。
          control: control ? (() => {
            try {
              const v = buildControlView(control.snapshot());
              return {
                enabled: true,
                connected: v.connected,
                hosts: v.hosts.map((h) => ({
                  // —— 旧字段（1.0.4 之前就有的，一个都不许少）——
                  id: h.id, host: h.host, caps: h.caps, stubs: h.stubs, connectedAt: h.connectedAt,
                  // —— 新增：meta 与排障字段 ——
                  transport: h.transport, meta: h.meta, state: h.state,
                  lastError: h.lastError, lastErrorAt: h.lastErrorAt,
                  calls: h.calls, failures: h.failures,
                })),
              };
            } catch (e) { return { enabled: true, error: String(e && e.message || e) }; }
          })() : { enabled: false, connected: 0, hosts: [] },
        };
        mark('rest', _t6);
        if (url.searchParams.get('prof') === '1') payload.prof = prof;
        // ★ 2026-11-11：采样一次趋势（进程内环形缓冲，不落盘）。
        //   放在缓存赋值**之前** —— 缓存里也带 series，这样缓存命中时趋势仍然看得到。
        payload.series = recordOverview({
          sessions: payload.sessions, indexRows: payload.indexRows,
          dataMB: payload.dataMB, memMB: payload.memMB, searchMs: payload.searchMs,
        });
        ovCache = payload; ovAt = Date.now();
        return json(res, 200, { ...payload, cached: false });
      }

      // —— 砚台（把「我现在是什么状态」摊开在一屏里） ——
      if (req.method === 'GET' && p === '/api/yantai') {
        const { gather } = await import('../yantai/panel.mjs');
        try {
          // ★ 水位那一块必须说清一句：**它是安全网，不是考核。**
          //   过线只该触发一个动作 —— 落盘；禁止第二个 —— 缩。
          const r = await gather({ store, config, persona, ledger: null, loop: null });
          // ★ motto 是个对象（{ text, src }）—— 直接展开成 JSON 顶层会变成 [object Object]。
          //   摊平成两个字段，界面才好用。
          const { motto, ...rest } = r;
          return json(res, 200, {
            at: new Date().toISOString(),
            motto: motto && motto.text ? motto.text : String(motto || ''),
            mottoSrc: motto && motto.src ? motto.src : '',
            ...rest,
          });
        } catch (e) {
          return json(res, 500, { code: 'GATHER_FAIL', hint: '砚台读数失败：' + (e && e.message) });
        }
      }

      // —— 状态台：三水位 + 六层（2026-11-09） ——
      //
      // ★ 三格水位的口径必须在代码里就分清楚，界面上才可能不混：
      //     ① lead   = DSH 的 contextPressure.pressureTokens ÷ **该会话自己的** contextWindow
      //     ② active = 同上，取 30 分钟 mtime 窗口内的会话（只 stat，不解析全量）
      //     ③ mirror = 本进程对被镜像帧做的**字符估算**（不是水位，是另一把尺子）
      // ★ 读不到一律 null，界面画「无读数」；绝不拿 0 顶 —— 0 和「文件不在」长得一样。
      // ★ 每层都带 provenance：pid / 启动时刻 / 配置快照。本机踩过「进程跑着旧配置」的坑，
      //   图上没有出处，就看不出一个「好」是好几天前的代码说的。
      if (p === '/api/status' && req.method === 'GET') {
        try {
          const payload = await gatherStatus({ config, store, persona, tools, autonomy, loop });
          return json(res, 200, payload);
        } catch (e) {
          return json(res, 500, {
            error: String((e && e.message) || e),
            hint: '状态台聚合失败 —— 这一屏宁可空着，也不填假数',
          });
        }
      }

      // —— 日记（一手层的一部分，不是「宿主加的面板」） ——
      if (req.method === 'GET' && p === '/api/diary/list') {
        const d = new Diary(diaryDirOf(config), { maxSnippet: config.diary && config.diary.maxSnippet });
        const r = d.list();
        // ★ state 和 entries 一起给 —— 界面靠 state 区分「没配 / 不存在 / 空的 / 有东西」
        return json(res, 200, { at: new Date().toISOString(), state: r.state, entries: r.entries });
      }
      if (req.method === 'GET' && p === '/api/diary/doc') {
        const u = new URL(req.url, 'http://x');
        const d = new Diary(diaryDirOf(config), { maxSnippet: config.diary && config.diary.maxSnippet });
        const r = d.read(u.searchParams.get('name'));
        if (!r.ok) return json(res, r.code === 'NOT_FOUND' ? 404 : 400, r);
        return json(res, 200, r);
      }

      // —— 器官状态（六张卡，看不见的东西要看得见） ——
      if (p === '/api/organs' && req.method === 'GET') {
        const out = [];
        const safe = (f) => { try { return f(); } catch (e) { return { error: String(e && e.message || e) }; } };

        // ① 换气 —— 两条一手源，与状态台共用 organs/huanqi-read.mjs（一处实现）
        // ★★ 2026-11-10（死读数修复之一）：这里原来取 d.streak —— 判定器上**没有**这个字段
        //   （真实字段是 stalled，见 organs/huanqi.mjs:172），而 loop.__huanqiByRound 当时也没人赋值。
        //   两处错叠在一起，结果恒为 0，界面上长期写着「0 / 3」。
        out.push(safe(() => huanqiCard(readHuanqi({ map: loop && loop.__huanqiByRound }))));

        // ② 自主
        out.push(safe(() => {
          if (!autonomy) return { name: '自主', key: 'autonomy', value: '—', note: '未接入', level: 'ok' };
          const c = autonomy.check();
          // ★ 2026-11-10 D 切片：卡上必须能看见**目标**与**真值来源** ——
          //   否则「unknown」看起来像坏了，而它其实是「没有 targetSession / 宿主没上报」。
          // ★ 2026-11-11：目标现在有三种来源（固定 / 跟随 lead / 解析不出），卡上要能分开 ——
          //   「跟随 lead 但还没解析到」跟「没配目标」是两件事，混在一起就没人能判断通不通。
          const tgt = String(autonomy.config.targetSession || '').trim();
          const rt = c.target || null;
          const targetText = tgt
            ? '固定 ' + tgt
            : (rt && rt.ok
              ? '跟随 lead ' + rt.sessionId
              : '跟随 lead（未解析：' + String((rt && rt.why) || '还没读过心跳').slice(0, 80) + '）');
          const ha = c.hostActivity;
          const sub = targetText
            + ' · ' + (ha && ha.ok ? '宿主上报 ' + Math.round(ha.minutes) + ' 分钟前活动' : '拿不到宿主上报（UNKNOWN）')
            + ' · ' + (autonomy.state.runsToday || 0) + '/' + autonomy.config.maxRunsPerDay;
          return { name: '自主', key: 'autonomy', value: c.phase, note: c.reason + '（' + sub + '）', level: c.phase === 'autonomous' ? 'warn' : 'ok' };
        }));

        // ③ 唤醒台账 —— **只读**权威台账（与状态台 / soul_waker 同一实现）
        // ★★ 2026-11-10（死读数修复之二）：这里原来读进程里那个 Ledger 实例
        //   （= <dataDir>/ledger.json，本机 1 条 2026-11-07 的旧待办），
        //   而真事件在 <状态目录>/lead-waker-台账.json（本机 43 条）。
        //   两个文件同构、字段同名 —— 读错**不报错**，只会安静地显示一个很小的数。
        out.push(safe(() => wakerCard(readWakerLedger({ file: wakerLedgerFileOf(config) }))));

        // ④ 压缩水位
        out.push(safe(() => {
          const pr = persona ? persona.render() : null;
          const win = (config.context && config.context.windowTokens) || 1048576;
          
          // ★ 2026-11-07 修的真 bug：原来 pct 算的是 pr.used（**字节**）÷ win（**token**）。
          //   两种单位相除，CJK 下大约高估 3 倍 —— 而这个数字是「水位」，
          //   高估它等于让人以为自己快满了，然后开始缩。**那把尺子一错，判断就全错。**
          //   人格层有它自己的预算，用字节比字节；水位的 token 口径在砚台那张卡里，各标各的尺子。
          const pct = pr && pr.budget ? (pr.used / pr.budget * 100).toFixed(1) : '0';
          const wm = watermarkOf(pr ? pr.used : 0, (pr && pr.budget) || win);
          return { name: '人格占比', key: 'watermark', value: pct + '%', note: (pr ? pr.used : 0) + 'B / 预算 ' + (pr ? pr.budget : 0) + 'B（字节 ÷ 字节）' + (pr && pr.dropped && pr.dropped.length ? '（丢 ' + pr.dropped.length + ' 项）' : ''), level: wm ? wm.level : 'ok' };
        }));

        // ⑤ 书房扫描
        out.push(safe(() => {
          // ★ 不硬编码任何人的书房路径 —— 发布版带着我的 1657 个文件是错的。
          // ★ 2026-11-11 补：但「没写进配置」≠「不知道在哪」。本机书房真实存在于
          //   DEV_PATHS.soulRoot，判据是**目录存在才用**（devPathOr）。所以：
          //   显式配置优先；没配就自动发现；两者都没有才说「未配置」。
          //   装到别人机器上没有那个目录 —— 行为与以前一字不差。
          const own = config.soul && config.soul.root;
          const root = own || devPathOr('soulRoot', null);
          if (!root) return { name: '书房', key: 'soul', value: '—', note: '未配置（config.soul.root，且本机没有默认书房）', level: 'ok' };
          // 自动发现要在卡上说出来 —— 不声不响读开发机路径，正是 R1 要消灭的那件事。
          const via = own ? '' : ('自动发现' + ' · ');
          if (!soulIdx) soulIdx = new SoulIndex(root, { ttl: (config.soul && config.soul.ttl) || 5000 });
          const read = soulIdx.refresh();
          const st = soulIdx.stats();
          return { name: '书房', key: 'soul', value: st.files + ' 文件', note: via + st.mb + 'MB · 本次读 ' + read + ' 份 · 上次 walk ' + st.lastWalkMs + 'ms', level: 'ok' };
        }));

        // ⑥ 思考退化 —— 宿主上报 state 的判据结果（器官在 organs/degradation.mjs）
        out.push(safe(() => {
          const snap = degradation && degradation.snapshot ? degradation.snapshot() : null;
          const th = (config.organs && config.organs.degradation && config.organs.degradation.interveneAt) || DEGRADATION_DEFAULT.interveneAt;
          const card = degradationCard(snap, th);
          // ★ 没有宿主上报过时，note 说明「等数据」，不留一个会让人误读的 0 分
          return card;
        }));

        // ⑦ 换气诊断 —— ★ 2026-11-07 加。
        //
        //   ★ 为什么不每次请求都真跑：它扫 5600 帧要 740ms，挂进 /api/organs 会把面板拖慢。
        //     所以**懒加载 + 缓存**：第一次请求跑一次，之后 10 分钟复用。
        //   ★ 为什么缓存而不是永不刷新：诊断的是「历史」，而历史在长（新帧在写）。
        //     10 分钟是「够新」和「不拖慢」之间的折中 —— 是判断，不是标准值。
        out.push(safe(() => {
          const TTL = 10 * 60 * 1000;
          const c = globalThis.__diagCache;
          if (!c || Date.now() - c.at > TTL) {
            const list = store.list();
            const target = [...list].sort((x, y) => (y.mtime || 0) - (x.mtime || 0))[0];
            if (!target) return { name: '换气诊断', key: 'diagnose', value: '—', note: '没有会话', level: 'ok' };
            const st = store.load(target.id);
            const r = diag(st && st.frames ? st.frames : []);
            globalThis.__diagCache = { at: Date.now(), r, sid: target.id };
          }
          const cc = globalThis.__diagCache;
          const n = cc && cc.r ? cc.r.candidates.length : 0;
          const by = (cc && cc.r && cc.r.stats && cc.r.stats.byKind) || {};
          const parts = Object.entries(by).map(([k, v]) => k + ' ' + v).join(' · ');
          // ★ 2026-11-07：**「要管几段」比「总共几段」有用**。
          //   dup 报的 392 帧是已止血的历史（本库只追加，清不掉也不该清），
          //   把它和「还在绕圈」混在一句「2 段」里，人就得自己再判断一遍。
          //   ★ 判据：只有 alive !== false 的才算「要管」—— 明确说了已止血的不算。
          const alive = (cc && cc.r ? cc.r.candidates : []).filter((c) => c.alive !== false).length;
          return {
            name: '换气诊断',
            key: 'diagnose',
            value: n + ' 段',
            note: n ? (parts + '　★ ' + alive + ' 段要管') : '没发现可疑段',
            level: alive > 5 ? 'warn' : 'ok',
          };
        }));

        return json(res, 200, { at: new Date().toISOString(), organs: out });
      }

      // —— 健康 ——
      // ★★ 2026-11-07 加：**「谁连着」这件事本来就该有个接口**。
      //
      //   原来只有 control.snapshot() 方法，没有任何路由暴露它 ——
      //   于是「桥接插件连上没有」只能靠翻日志猜。
      //   而日志是 `>> gui.log` 重定向的，**stdout 块缓冲**：连接建立了 hello 也打了，
      //   但文件里可能几十分钟不出现（node 写 pipe/file 是 4KB~64KB 才 flush）。
      //   ★ 判据不能建立在「日志里有没有」上，要能当场问出来。
      // ★★ 2026-11-07 加：诊断详情。organs 那张卡只显示汇总，详情走这里。
      //   ★ 为什么要单独一个接口而不是塞进 /api/organs：
      //     卡片要快（460ms 可接受），详情会跑全量 + 可能几十条，
      //     **把「快的那部分」和「慢的那部分」分开**，页面才不会一起卡。
      if (p === '/api/diagnose') {
        const u = new URL(req.url, 'http://x');
        const wantSid = u.searchParams.get('session') || '';
        const wantKind = u.searchParams.get('kind') || '';
        const lim = Math.max(1, Math.min(200, Number(u.searchParams.get('limit')) || 30));
        try {
          const list = store.list();
          let target = null;
          if (wantSid) {
            target = list.find((x) => x.id === wantSid) || list.find((x) => x.id.includes(wantSid));
          } else {
            target = [...list].sort((x, y) => (y.mtime || 0) - (x.mtime || 0))[0];
          }
          if (!target) return json(res, 200, { ok: false, error: '没有会话' });
          const st = store.load(target.id);
          if (!st || !Array.isArray(st.frames)) return json(res, 200, { ok: false, error: '读不出帧' });
          const r = diag(st.frames);
          let cands = r.candidates;
          if (wantKind) cands = cands.filter((c) => c.kind === wantKind);
          return json(res, 200, {
            ok: true,
            session: target.id,
            frames: r.frames,
            total: cands.length,
            byKind: r.stats.byKind,
            note: '这些是「值得看一眼的段落」，不是判决。点门牌会去 memq open 看原文 —— 要删要留由人定。',
            items: cands.slice(0, lim),
          });
        } catch (e) {
          return json(res, 500, { ok: false, error: String(e && e.message || e) });
        }
      }

      // ── 定点清理回执（2026-11-10 · E 切片）──────────────────────────────
      //
      // ★ 只读。**这里没有触发清理的路由** —— 清理只能由 agent 经 MCP 的 soul_cleanup 发起，
      //   因为那条路有 manifest 判「这是写面」、有宿主能力筛选、有回执核对。
      //   给 HTTP 再开一个 POST = 第二条入口、第二套判据，正是这个项目反复付代价的形状。
      // ★ 返回「最近一条 + 历史 + 失败原因」：失败也要看得见，否则人只会以为「没跑过」。
      if (p === '/api/cleanup' && req.method === 'GET') {
        const st = readCleanupState({ dataDir: config.dataDir });
        return json(res, 200, {
          at: new Date().toISOString(),
          ...st,
          note: st.ok
            ? '回执来自宿主 pruner/targeted-cleanup 的真实返还；pointer 形如 log:<session>#seq=<n> 可直接回取'
            : '还没有可信回执（文件不存在 / 读不出）—— 这是 UNKNOWN，不是「清理失败」',
        });
      }

      // ── 回声哨兵（2026-11-10 · F 切片）────────────────────────────────
      //
      // ★ 默认只读**已落盘的结果**；?refresh=1 才真的跑一次探测（并等它跑完再回，便于取证）。
      // ★ 没有结果、或结果过期时，顺手起一条后台探测，但**立刻**返回当前读数 + probing:true ——
      //   不让一个读接口被 2 秒的体检拖住，也不拿旧结果冒充现在。
      if (p === '/api/echo-sentinel' && req.method === 'GET') {
        if (!echoSentinel) {
          return json(res, 200, { ok: false, state: 'unknown', why: '哨兵没接（createServer 没收到 echoSentinel）' });
        }
        const u = new URL(req.url, 'http://x');
        const wantRefresh = u.searchParams.get('refresh') === '1';
        let probing = false;
        if (wantRefresh) {
          probing = true;
          await echoSentinel.probe('refresh').catch(() => null);
          probing = false;
        }
        const cur = readEchoSentinel({
          dataDir: config.dataDir,
          ttlMs: echoSentinel.ttlMs,
        });
        if (!wantRefresh && (!cur.ok || cur.stale)) {
          echoSentinel.probeInBackground(cur.ok ? 'stale' : 'first-read');
          probing = true;
        }
        return json(res, 200, {
          at: new Date().toISOString(),
          ok: cur.ok,
          state: cur.state,
          resultAt: cur.at,
          ageMs: cur.ageMs,
          stale: cur.stale,
          why: cur.why,
          file: cur.file,
          ttlMs: echoSentinel.ttlMs,
          doctorPath: echoSentinel.doctorPath || null,
          probing,
          record: cur.record,
        });
      }

      if (p === '/api/control') {
        if (!control) return json(res, 200, { enabled: false, hosts: [], note: '控制通道没接（createServer 没收到 control）' });
        const hosts = control.snapshot();
        return json(res, 200, {
          enabled: true,
          // ★ connected 只数「已经 hello 过」的 —— 连上但没自报家门的不能算可用
          connected: hosts.filter((h) => h.host && h.host !== '(未 hello)').length,
          hosts,
        });
      }

      // —— 会话调度（2026-11-12）——
      //   GET  只读观测面：谁能接、最近一次成败、四个动作各调了几次。**没有正文**。
      //   POST 派活：{ action, chatId?, sessionId?, text?, preset?, level? }
      //        回的是**器官的判定**，不是宿主原始帧 —— 判据在 session-dispatch 里，这里不复述。
      //   ★ 动作走白名单，不拿 body.action 直接当键去取函数（原型上的 constructor 也会被点中）。
      if (p === '/api/session') {
        if (req.method === 'GET') return json(res, 200, { ok: true, ...sessionDispatch.view() });
        if (req.method === 'POST') {
          let body = {};
          try { body = (await readBody(req)) || {}; } catch { body = {}; }
          const action = String(body.action || '').trim();
          if (SESSION_ACTIONS.indexOf(action) < 0) {
            return json(res, 400, {
              ok: false, error: 'action 只认 ' + SESSION_ACTIONS.join(' / ') + '（拿到 ' + JSON.stringify(action) + '）',
            });
          }
          const input = {};
          for (const k of ['chatId', 'sessionId', 'text', 'preset', 'level', 'meta']) {
            if (body[k] !== undefined && body[k] !== null) input[k] = body[k];
          }
          const r = await sessionDispatch[action](input);
          return json(res, r && r.ok ? 200 : 400, r);
        }
        return json(res, 405, { ok: false, error: '/api/session 只认 GET / POST' });
      }

      // —— 运行状态（2026-11-10 · 概览状态面板）——
      //
      // 四块，两个侧，**全部只读**：
      //   v4 侧  控制通道（谁连上来了、meta、最近错误）· 模型（调用/失败/耗时/usage）
      //   DSH 侧 MCP Hub（服务与工具）· 心跳倒计时（DSH 插件自己的计时器）
      //
      // ★ 为什么不并进 /api/overview：那一页缓存 30 秒，而倒计时要每秒都新。
      // ★ 这里没有第二条路径能写：没有 POST 分支、没有 connect / reconnect、不碰自主开关。
      //   MCP Hub 的写路由（POST/PATCH/DELETE）一条都没接。
      // ★★★ 2026-11-13：自主状态直读接口 —— 回答「账本到底接手了没」。
  //
  //   为什么要有它：`/api/runtime-status` 里的心跳格是**快照**（tick 之前拍的），
  //   而「lead 解析到没」要等 60 秒 tick 才更新一次。靠界面猜太慢。
  //   ★ 这里直接吐两样：leadTarget 的 last（谁给的答案）+ autonomy 的 check（现在该不该动）
  //     —— 都不写盘，可以放心轮询。
  if (p === '/api/autonomy' && req.method === 'GET') {
    const nowMs = Date.now()
    let lead = null, verdict = null, leadErr = null, verdictErr = null
    try {
      const lt = globalThis.__leadTarget
      if (lt && typeof lt.current === 'function') lead = lt.current(nowMs)
      else leadErr = 'globalThis.__leadTarget 没挂上'
    } catch (e) { leadErr = String((e && e.message) || e).slice(0, 160) }
    try {
      if (autonomy && typeof autonomy.check === 'function') verdict = autonomy.check(nowMs)
      else verdictErr = 'autonomy 没接上'
    } catch (e) { verdictErr = String((e && e.message) || e).slice(0, 160) }
    return json(res, 200, {
      ok: true,
      at: new Date(nowMs).toISOString(),
      // ① lead 是谁给的：dsh:/heartbeat/auto（宿主）还是 ledger:last-lead（账本）
      lead,
      leadErr,
      // ② 现在该不该动（phase / reason / idleMinutes / targetSession）
      verdict,
      verdictErr,
      // ③ 一眼看结论
      leadSource: lead && lead.leadSource ? lead.leadSource : null,
      resolved: Boolean(lead && lead.ok && lead.sessionId),
      phase: verdict && verdict.phase ? verdict.phase : null,
      idleMinutes: verdict && Number.isFinite(verdict.idleMinutes) ? verdict.idleMinutes : null,
      reason: verdict && verdict.reason ? String(verdict.reason).slice(0, 200) : null,
      targetSession: verdict && verdict.targetSession ? verdict.targetSession : (lead && lead.sessionId) || null,
    })
  }
  if (p === '/api/runtime-status' && req.method === 'GET') {
        try {
          return json(res, 200, await collectRuntimeStatus());
        } catch (e) {
          return json(res, 500, {
            error: String((e && e.message) || e),
            hint: '运行状态聚合失败 —— 这一屏宁可空着，也不填假数',
          });
        }
      }

      // ★★ 2026-11-10 身份契约（壳的启动链靠它，见 build/Shell.cs WaitHealthy）：
      //   health 必须自报 **service + pid** —— 只回 ok:true 的应答**证明不了是谁**。
      //
      //   事故形状（data\_bench 里留了现场）：上一个慢 core 占着 7310，
      //   壳起的真 core 因 EADDRINUSE 退出；而壳只认 "ok":true，
      //   于是把那个**不是自己启动的**进程当成 core，导航到它的 404 页面（白屏 "nope"）。
      //
      //   ★ 判据只能落在「这个 pid 是不是我刚起的那个子进程」上：
      //     · pid 对不上 → 端口被别的进程占着，壳必须报错，**不许导航**；
      //     · pid 不在 → 无法证明身份，壳同样不许认（契约是必填，不是可选）。
      //   ★ 这里只加字段，不动任何业务逻辑 —— health 的其余读者
      //     （mcp-proxy 的「像不像 agent-soul」探测、面板 health）只增不减，全部不受影响。
      if (p === '/api/health') {
        const refDesc = describeApiKeyRef(config.llm.apiKeyRef);
        return json(res, 200, {
          ok: true,
          service: 'agent-soul-core',
          pid: process.pid,
          port: config.port,
          llmReady: loop.llm.ready(),
          ...llmUsability(loop.llm),
          model: config.llm.model,
          // ★ 1.0.2：这两组字段是**自述**，验收与排障靠它们证明「协议和来源是不是预期的」。
          //   ★ 不含任何秘密：protocol/provider 是配置值，keySource 是引用串（只有 provider id）。
          protocol: loop.llm.protocol,
          provider: config.llm.provider,
          providerName: config.llm.providerName,
          baseUrl: loop.llm.baseUrl,
          keySource: config.llm.apiKeySource,
          // ★ 1.0.3（P2-1）：只回白名单内的合法引用（dpapi:deepseek-official 原样兼容）；
          //   其余给 'invalid' / 'unknown' —— 手改 config.json 把 key 粘进 apiKeyRef 时，
          //   health 不再成为它的出口。空值保持旧行为：null。
          apiKeyRef: refDesc.kind === 'empty' ? null : refDesc.display,
          apiKeyRefKind: refDesc.kind,
          apiKeyRefValid: refDesc.valid,
          tools: [...tools.tools.keys()],
          sessions: store.list().length,
          // ★ 2026-11-12：加 dataDir —— 但要**只给尾部两段**。
          //
          //   为什么要它：打包新版本时如果 cwd 错了，dataDir 会指到 app/<版本>/data（空目录），
          //   于是 sessions=0，而症状看起来像「升级把数据弄丢了」。
          //   **有这一个字段，一眼就能看出「看错目录」和「真的没有」。**
          //
          //   ★ 为什么不给全路径：/api/health **不设卡**（谁都能读），
          //     全路径会带出用户名和安装位置。尾部两段（如 agent soul/data）
          //     足够定位，又不泄露完整路径。
          dataDirTail: String(config.dataDir || '').split(/[\\/]/).filter(Boolean).slice(-2).join('/'),
        });
      }

      // —— 事件与心跳 ——
      if (p === '/api/events' && req.method === 'GET') {
        const u = new URL(req.url, 'http://x');
        return json(res, 200, {
          bus: bus ? bus.stats() : null,
          scheduler: sched ? sched.stats() : null,
          recent: bus ? bus.recent(20) : [],
          // ★ 2026-11-10：事件接入的状态读口并进这里 —— 形状见 adapters/events-http.mjs。
          //   仍然只读：没有 POST 分支、没有 send 路由；事件列表只给元数据（正文按 raw_ptr 回账取）。
          ingress: eventsIngressPayload(eventsIngress, { limit: u.searchParams.get('limit') }),
        });
      }
      // —— 出站口（只读）——
      // ★ 为什么要有：出站也收进 core 了（src/adapters/outbox.mjs）。没有这条视图，
      //   「发了几条」只能靠翻网关日志 —— 而 v4 里没有网关日志。
      // ★ 为什么只给 20 条 + 前 40 字：这个口会被页面读到，正文不该顺手摊开；
      //   要正文请回网关看，账本才是权威（与 /api/events 只给元数据同一条规矩）。
      if (p === '/api/outbox' && req.method === 'GET') {
        const u = new URL(req.url, 'http://x');
        return json(res, 200, outboxView({ limit: u.searchParams.get('limit') }));
      }
      // —— QQ 只读面（接线视图）——
      // ★ 为什么只给「接线了没有 / 调过几次 / 有哪些工具」：
      //   这个口会被页面读到，而 QQ 那两格东西（accessToken / 会话令牌）不该跟着走；
      //   消息正文同理 —— 要看正文请对工具本身发问，走 MCP 那条带鉴权的路。
      // ★ 不新开路由树：一条 GET，位置与形状都跟 /api/outbox 并排。
      //   多一棵树 = 多一份「谁负责判只读」的判据。
      if (p === '/api/qq' && req.method === 'GET') {
        return json(res, 200, qqView());
      }
      if (p === '/api/persona' && req.method === 'GET') {
        if (!persona) return json(res, 200, { text: '', note: '未配置人格层' });
        const r = persona.render();
        return json(res, 200, { text: r.text, used: r.used, budget: r.budget, dropped: r.dropped, stats: persona.stats() });
      }

      // —— 配置 · 读（/params 用）——
      // ★ 返回的是「生效值」，不是「文件里写的字」：环境变量会盖过文件，
      //   路径也会被 resolvePath 解析。页面上看到的数，就是程序下一次真会用的数。
      if (p === '/api/config' && req.method === 'GET') {
        const view = buildConfigView();
        return json(res, view.ok ? 200 : 500, view);
      }

      // —— 配置 · 写（/settings 用）——
      if (p === '/api/config' && req.method === 'POST') {
        const t0 = Date.now();
        const body = await readBody(req);
        const patch = (body && typeof body === 'object' && body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch))
          ? body.patch
          : (body && typeof body === 'object' && !Array.isArray(body) ? body : {});

        const errors = [];
        const clean = {};
        let dpapiSecretSaved = false;   // 这一次请求里有没有把 key 写进 DPAPI（影响回执文案）

        // ① 未知键先拦 —— 打错一个字母不该被悄悄忽略
        for (const k of Object.keys(patch)) {
          if (!CFG_FIELD_INDEX.has(k)) errors.push({ field: k, message: '没有这个参数（字段表里没登记）' });
        }

        // ② 逐字段校验，全部收齐再返回 —— 不做「改一个报一个」
        for (const [key, raw] of Object.entries(patch)) {
          const fd = CFG_FIELD_INDEX.get(key);
          if (!fd) continue;

          if (fd.type === 'secret') {
            // ★ 凭据单独一条路：null = 明确清除；空串/空白 = 拒。
            //   错误信息里绝不回显提交上来的内容，一个字都不带。
            //
            // ★ 1.0.2：如果 config.json 里已经配了 dpapi 引用，这把 key **不写进 config** ——
            //   交给安装根里的 SecretStore.exe 用 DPAPI 收起来，配置里只留引用。
            //   判据取自磁盘（before），不是内存里那份对象：别人刚手改过也要跟得上。
            const pre = readConfigFile();
            const preRef = (pre && pre.data && pre.data.llm && typeof pre.data.llm.apiKeyRef === 'string')
              ? pre.data.llm.apiKeyRef.trim() : '';
            const dpapiProvider = /^dpapi:/i.test(preRef) ? preRef.slice(6).trim() : '';

            if (raw === null) {
              if (dpapiProvider) {
                const del = await runSecretStore(['delete', '--provider', dpapiProvider]);
                if (!del.ok) { errors.push({ field: key, message: '清不掉 DPAPI 里的秘密：' + del.error }); continue; }
              }
              clean[key] = '';
              continue;
            }
            if (typeof raw !== 'string') { errors.push({ field: key, message: 'API Key 必须是文本' }); continue; }
            const s = raw.trim();
            if (!s) { errors.push({ field: key, message: 'API Key 不能是空白；要清除请提交 null' }); continue; }
            if (/\s/.test(s)) { errors.push({ field: key, message: 'API Key 里不能有空格或换行' }); continue; }
            if (s.length > 512) { errors.push({ field: key, message: 'API Key 太长（超过 512 字符）' }); continue; }
            if (dpapiProvider) {
              const st = await runSecretStore(['set', '--provider', dpapiProvider], s);
              if (!st.ok) { errors.push({ field: key, message: '写不进 DPAPI：' + st.error }); continue; }
              clean[key] = '';           // ★ 明文一个字都不落进 config.json
              dpapiSecretSaved = true;
              continue;
            }
            clean[key] = s;
            continue;
          }

          const errs = validateField(fd, raw);
          if (errs.length) errors.push({ field: key, message: errs.join('；') });
          else clean[key] = normalizeField(fd, raw);
        }

        if (!Object.keys(clean).length && !errors.length) {
          errors.push({ field: '(patch)', message: '没有要改的项' });
        }

        // ★ 校验没过就到此为止 —— 一个字都不写盘。这条是硬规矩。
        if (errors.length) {
          return json(res, 400, {
            ok: false, written: false, wrote: false,
            tookMs: Date.now() - t0,
            errors,
            note: '校验没过 —— 一个字都没写盘',
            file: configFile(),
          });
        }

        // ③ 用磁盘上的最新内容当底 —— 不用内存里那份旧对象，
        //    否则会覆盖掉别人刚手改过的字段。
        const before = readConfigFile();
        if (before.error) {
          return json(res, 500, {
            ok: false, written: false, tookMs: Date.now() - t0,
            errors: [{ field: 'config.json', message: before.error }],
            note: '现存的 config.json 就读不出来，不敢往里写',
          });
        }

        // ★ 必须拷贝。直接改 before.data 会让下面「改前 → 改后」的对照两头都变成新值 ——
        //   第一版就是这么错的：界面显示「90 → 90」，看着像没改过。
        const next = structuredClone((before.data && typeof before.data === 'object') ? before.data : {});
        for (const k of Object.keys(clean)) setIn(next, k, clean[k]);

        let text;
        try { text = JSON.stringify(next, null, 2) + '\n'; }
        catch (e) {
          return json(res, 500, { ok: false, written: false, tookMs: Date.now() - t0,
            errors: [{ field: 'config.json', message: '序列化失败：' + String((e && e.message) || e) }] });
        }

        // ④ 原子写：.tmp → rename。要么旧文件整份还在，要么新文件整份在位。
        try { await writeFileAtomic(before.file, text); }
        catch (e) {
          return json(res, 500, { ok: false, written: false, tookMs: Date.now() - t0,
            errors: [{ field: 'config.json', message: '写盘失败：' + String((e && e.message) || e) }] });
        }

        // ⑤ 读回来 —— 响应里所有值都来自磁盘重新解析，不是来自刚拼的那个对象
        const back = buildConfigView();
        const backRaw = readConfigFile();
        const changed = [];
        const verify = [];
        for (const k of Object.keys(clean)) {
          const fd = CFG_FIELD_INDEX.get(k);
          const prev = getIn(before.data || {}, k);
          const now = backRaw.data ? getIn(backRaw.data, k) : undefined;
          verify.push({ key: k, match: sameValue(now, clean[k], fd ? fd.type : 'string') });
          // ★★ 1.0.4（独立验收 F-1）：before / after 一律走 safeDisplayOf。
          //   1.0.3 的错就错在这里：secret 走了一条安全分支，而 llm.apiKeyRef 是普通 string，
          //   于是 before: displayOf(fd, prev) 把磁盘上的原始 Key 原样拼进了回执，
          //   再被 restartRequired（同一个对象）带第二遍。
          //   现在敏感字段在这条回执里只可能是「已配置 / 未配置 / 合法引用 / unknown / invalid」。
          // ★ secret 写进 DPAPI 时 config.json 里留的是空串 —— 光看磁盘会说「未配置」，
          //   那是错的（key 在 DPAPI 里）。这一格仍然只是布尔语义，不含秘密本体。
          const afterShown = (fd && fd.type === 'secret' && dpapiSecretSaved && !now)
            ? '已配置' : safeDisplayOf(fd, now);
          const item = {
            key: k,
            label: fd ? fd.label : k,
            before: safeDisplayOf(fd, prev),
            after: afterShown,
            restart: fd ? fd.restart !== false : true,
          };
          if (isSensitiveField(fd)) {
            // 给页面一个明确标记：这一项已经脱敏过 —— settings.html 据此再兜一层，
            // 服务端万一回退，页面也只显示「已脱敏」，不会把原值送上屏。
            item.sensitive = true;
            if (fd.type === 'secret' && dpapiSecretSaved) {
              item.note = '这次写进 DPAPI（SecretStore）—— config.json 里只留引用';
            }
            if (fd.key === 'llm.apiKeyRef') {
              const rdNow = describeApiKeyRef(now);
              item.refKind = rdNow.kind;
              item.refValid = rdNow.valid;
            }
          }
          changed.push(item);
        }
        const matchAll = verify.every((x) => x.match);
        const restartRequired = changed.filter((c) => c.restart);

        // ★ 写成功但读回对不上 —— 必须报出来，不能报成功。
        if (!matchAll) {
          return json(res, 500, {
            ok: false, written: true, tookMs: Date.now() - t0,
            errors: [{ field: 'config.json', message: '写盘后读回的值与提交的不一致（可能被别的程序改过）' }],
            verify, changed, file: before.file,
          });
        }

        return json(res, 200, {
          ok: true,
          written: true,
          tookMs: Date.now() - t0,
          at: new Date().toISOString(),
          file: back.file,
          exists: back.exists,
          sha256: back.sha256,
          bytes: back.bytes,
          mtime: back.mtime,
          changed,
          restartRequired,
          restartNote: restartRequired.length
            ? '这些项已经落盘，但进程里还是旧值 —— 重启后生效'
            : '没有需要重启的项',
          readBack: { checked: verify.length, match: matchAll },
          groups: back.groups,
          stats: back.stats,
        });
      }

      // —— 会话列表 ——
      if (p === '/api/sessions' && req.method === 'GET') {
        // ★ 2026-11-07 修卡顿：进 /chat 页面要拉全量会话列表，1023 条约 1.6 秒。
        //   每次进页面都重算一遍，而列表本身几乎不变（只在新建会话时才变）。
        //   加 3 秒缓存：连续进出页面不再重算，新建会话最多 3 秒后可见。
        const nowMs = Date.now();
        if (!globalThis.__sessCache || nowMs - globalThis.__sessCacheAt > 3000) {
          globalThis.__sessCache = store.list();
          globalThis.__sessCacheAt = nowMs;
        }
        return json(res, 200, { sessions: globalThis.__sessCache });
      }

      // —— 新建会话 ——
      if (p === '/api/sessions' && req.method === 'POST') {
        const body = await readBody(req);
        // ★ 2026-11-10（R1）：cwd 的默认值不再由页面写死开发机路径。
        //   顺序：请求给的 → config.workspace → <安装根>/workspace。分发版永远落在安装根里。
        const h = store.create(body.cwd || config.workspace || path.join(appRoot(), 'workspace'), body.persona || null);
        return json(res, 200, { session: h });
      }

      // —— 读会话帧 ——
      const mFrames = p.match(/^\/api\/session\/([\w-]+)\/frames$/);
      if (mFrames && req.method === 'GET') {
        const s = store.load(mFrames[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, { header: s.header, frames: s.frames });
      }

      // —— 检索 ——
      if (p === '/api/search' && req.method === 'GET') {
        const q = url.searchParams.get('q') || '';
        const sid = url.searchParams.get('session');
        if (!q) return json(res, 200, { hits: [] });
        const hits = sid ? store.search(sid, q).map(r => ({ sessionId: sid, ...r })) : store.searchAll(q, 100);
        return json(res, 200, { hits });
      }

      // —— 跑一个回合（SSE）——
      // ★★★ 2026-11-07：宪章审核开了个 HTTP 口。
    //
    //   在这之前 guard 只有 MCP 一个入口（soul_guard），也就是**只有 MCP 宿主能问**。
    //   但「谁该被审」不止 MCP 宿主 —— lead-waker 要审一条 wake 请求、
    //   以后别的插件也要审。让每个插件自己实现一遍 MCP 客户端是浪费，也不现实。
    //
    //   ★ HTTP 是最通用的门：一个 POST 就行，不用协议、不用库。
    //   而且它天然满足「审核是只读判断」—— 这个端点**不改任何状态**。
    // ★ 2026-11-11：轻量状态口（/chat 右侧栏每 5 秒轮一次）。
    //   ★ 与 /api/overview 的分工：overview 是「全貌」，要建索引、要 stat 每个会话；
    //     这里是「此刻的心跳」，只读几个内存值 + 一个状态文件。
    //     分开的理由很实际：页面每 5 秒轮一次 overview，等于每 5 秒把索引震一遍。
    if (p === '/api/vitals' && req.method === 'GET') {
      const mem = process.memoryUsage();
      let sessions = 0;
      try { sessions = store.list().length; } catch { sessions = 0; }
      let openQ = 0;
      try { const st = globalThis.__questionStore; if (st && st.digestAll) openQ = st.digestAll({ answeredLimit: 0 }).open.length; } catch { openQ = 0; }
      let sync = null;
      try {
        const sp = path.join(config.dataDir, 'sync-state.json');
        if (fs.existsSync(sp)) {
          const j = JSON.parse(fs.readFileSync(sp, 'utf8'));
          sync = { at: j.at || null, files: j.files == null ? null : j.files, frames: j.frames == null ? null : j.frames };
        }
      } catch { sync = null; }
      let pv = null;
      try { pv = typeof globalThis.__vitals === 'function' ? globalThis.__vitals() : null; } catch { pv = null; }
      return json(res, 200, {
        ok: true, at: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        memMB: Math.round(mem.rss / 1048576), heapMB: Math.round(mem.heapUsed / 1048576),
        sessions, openQuestions: openQ, sync,
        persona: pv ? { chars: pv.personaChars, budget: pv.personaBudget } : null,
        context: pv ? (pv.context || null) : null,
      });
    }

    // ★ 2026-11-11：只读回显 —— v4 这一轮到底给模型喂了什么（前 1200 字符 + 长度）。
    //   用途：和 dsh-yanqing-memory 推的那一段逐项对比，判断「能不能禁掉它」。
    //   ★ 仅本机、只读、不写任何东西；它回显的是**已拼好的提示**，不是额外造一份。
    if (p === '/api/prompt' && req.method === 'GET') {
      const LOOP = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1'];
      const addr = String((req.socket && req.socket.remoteAddress) || '');
      if (LOOP.indexOf(addr) < 0) return json(res, 403, { ok: false, error: '只接受 127.0.0.1' });
      const sid = url.searchParams.get('session') || (store.list()[0] || {}).id;
      if (!sid) return json(res, 400, { ok: false, error: '没有会话' });
      let text = '';
      try { text = loop.systemPrompt(sid) || ''; } catch (e) { return json(res, 500, { ok: false, error: String((e && e.message) || e) }); }
      return json(res, 200, { ok: true, sessionId: sid, chars: text.length, head: text.slice(0, 1200) });
    }

    // —— 2026-11-11：ask_user 的两个口 ——
    //   ★ 只在**本机**能答（与 /api/shutdown 同一条判据）。理由：问题是「问这个人」的，
    //     不是「问能连上这个端口的人」的 —— 局域网里谁都能答就等于没问。
    if (p === '/api/questions' && req.method === 'GET') {
      const st = globalThis.__questionStore;
      const sid = url.searchParams.get('session');
      if (!st) return json(res, 200, { ok: false, error: '问题存储没接上', open: [], answered: [] });
      // ★ 不带 session = 看**所有会话**的问题。理由：前端只有一个提问口，
      //   而「问题属于哪个会话」是内部账，不该让要看问题的人先去查会话 id。
      const d = sid ? st.digest(sid) : st.digestAll();
      return json(res, 200, { ok: true, at: new Date().toISOString(), sessionId: sid || null, open: d.open, answered: d.answered });
    }
    if (p === '/api/answer' && req.method === 'POST') {
      const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1'];
      const addr = String((req.socket && req.socket.remoteAddress) || '');
      if (LOOPBACK.indexOf(addr) < 0) return json(res, 403, { ok: false, error: '只接受 127.0.0.1 的回答' });
      const st = globalThis.__questionStore;
      if (!st) return json(res, 500, { ok: false, error: '问题存储没接上' });
      let body = {};
      try { body = (await readBody(req)) || {}; } catch { body = {}; }
      const r = st.answer(body.questionId, body.text, body.by || 'panel');
      return json(res, r.ok ? 200 : 400, r);
    }

    if (p === '/api/guard' && req.method === 'POST') {
      // ★ 2026-11-07 修：readBody **已经 JSON.parse 过了**，返回的是对象。
      //   我又 parse 一次 → 抛错 → catch 把 body 变成 {} → 所有请求都说「text 是空的」。
      //   ★ 这是今晚同一个毛病的第 N 次：**用别人的 API 之前先看它返回什么形状**。
      //   （前面还有：whoHas 返回数组不是 id、readBody 在别的路由里返回对象）
      let body = {};
      try { body = (await readBody(req)) || {}; } catch { body = {}; }
      const text = String(body.text || '').trim();
      if (!text) {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: '要审什么？text 是空的' }));
        return;
      }
      try {
        const { check, redactText: guardRedact, redactEvidence: guardRedactEvidence, redactBody: guardBody } = await import('../organs/guard.mjs');
        // ★★ 2026-11-10：模糊层接上了。
        //   2026-11-07 那版传 `{}`（createServer 当时拿不到 llm），于是 via 恒为 rule ——
        //   「LLM 在不在」这件事从来没被真正用上过。现在传**同一个 LlmClient 实例**，
        //   规则层照旧不碰模型，只有 needsJudge 的请求才花一次调用。
        // ★ 没配 key 时不传一个「会抛错的东西」进去：llmConfigured=false 让 guard 走
        //   fallback/unconfigured（ask + 证据），而不是 exception —— 这两种原因必须分得开。
        const r = await check(
          { text, from: body.from || '', role: body.role || '', ip: req.socket.remoteAddress },
          guardLlmOpts(llm)
        );
        const ev = r.evidence || {};
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: true,
          verdict: r.verdict,
          via: r.via,
          // ★ 2026-11-10：三个文本出口在这里**再脱一次**（guard 内部已过一遍）。
          //   这是第二道，不是重复劳动 —— 验收实测过「错误文本带出明文」，而这条路是
          //   evidence.error → reason → 台账 → 人眼，中间没有第二个过滤器。
          reason: guardRedact(r.why, 400),
          why: guardRedact(r.why, 400),          // ★ 兼容：lead-waker 读的是 why（index.js:323）
          lines: Array.isArray(r.lines) ? r.lines.map((x) => guardRedact(x, 40)) : [],
          degraded: r.via === 'fallback',
          llm: {
            configured: ev.llmConfigured === true,
            called: ev.llmCalled === true,
            model: ev.model == null ? null : ev.model,
            protocol: ev.protocol == null ? null : ev.protocol,
          },
          evidence: guardRedactEvidence(ev),
          // ★ 原文回声是**脱敏本**：审核响应会进日志/台账，凭据不跟着走。
          //   ★ 2026-11-10 第二轮（P2）：回声要和 reason/evidence **过同一份结构脱敏**
          //     （redactBody = 不截断的 redactText）。以前只过文本规则，
          //     请求里贴一段 {"key":{…}} 就原样带回去了。
          //   ★ 调用方真要原文，它自己手里有 —— 不该从响应里拿。
          text: guardBody(r.text),
        }));
      } catch (e) {
        // ★ 审不出来 ≠ 审过了。这条和 guard.mjs 里的 catch 是同一条规矩。
        const { redactText } = await import('../organs/guard.mjs').catch(() => ({ redactText: (s) => String(s) }));
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
          ok: false,
          verdict: 'ask',
          via: 'error',
          reason: '审核出错，转人判断：' + redactText(e && e.message, 200),
          why: '审核出错，转人判断：' + redactText(e && e.message, 200),
          lines: [],
          degraded: true,
          evidence: { layer: 'error', kind: 'exception', code: 'GUARD_ERROR', llmConfigured: Boolean(llm), llmCalled: false },
        }));
      }
      return;
    }

    if (p === '/api/turn' && req.method === 'POST') {
        const body = await readBody(req);
        const sessionId = body.sessionId;
        const text = String(body.text || '').trim();
        if (!sessionId || !text) return json(res, 400, { error: '缺 sessionId 或 text' });
        const s = store.load(sessionId);
        if (!s) return json(res, 404, { error: '会话不存在' });

        store.append(sessionId, FRAME.USER, { text });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });
        const send = (obj) => { try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch { /* 客户端断了 */ } };
        send({ kind: 'start', sessionId });

        try {
          await loop.turn(sessionId, (e) => send(e));
        } catch (e) {
          send({ kind: 'error', message: String((e && e.message) || e) });
        }
        send({ kind: 'end' });
        return res.end();
      }

      return json(res, 404, { error: '没有这个路由: ' + p });
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String((e && e.message) || e) });
      else try { res.end(); } catch { /* ignore */ }
    }
  });

  /**
   * 预热 —— 启动时把「第一次访问才会算」的慢活先干完。
   *
   * ★ 为什么要有它：首次 /api/overview 要 3.9 秒（建索引 + 2012 次 stat + 书房全扫）。
   *   而那三样在**启动后一秒钟内就不会再变**。
   *   「双击图标 → 界面出来」这个形态里，启动多花几秒是没人看见的；
   *   但打开页面等 4 秒是**每次都看得见**的。
   *   把慢的挪到看不见的地方 —— 这就是预热。
   */
  server.warmup = async () => {
    const t0 = Date.now();
    const steps = [];
    // ★ 2026-11-10：**必须**走分片版。同步 buildIndex 会占住事件循环 3–40 秒，
    //   而「用户在这几秒里关窗」正是 data/shutdown.log 里那条 shell:timeout 的成因：
    //   POST /api/shutdown 进不来 → 壳超时 → 强杀 → 索引缓存没写 → 下次还慢。
    //   分片版同样的结果，只在项与项之间 setImmediate 让出（实测让出 280–950 次）。
    try {
      const tIx = Date.now();
      if (typeof store.buildIndexAsync === 'function') {
        const r = await store.buildIndexAsync({ yieldMs: 8 });
        steps.push('索引 ' + store.list().length + ' 会话'
          + (r && r.aborted ? '（让给同步建库）' : '')
          + ' ' + (Date.now() - tIx) + 'ms/让出' + ((r && r.yields) || 0) + '次');
      } else {
        store.buildIndex();
        steps.push('索引 ' + store.list().length + ' 会话');
      }
    } catch (e) { steps.push('索引 ✗'); }
    // ★ 2026-11-10：写缓存也走分片版。84–98MB 的同步写要 1.5–4 秒，
    //   而「启动期一直能应答 /api/shutdown」必须贯穿整个 warmup，不只是建库那一段。
    try {
      if (typeof store.saveIndexCacheAsync === 'function') await store.saveIndexCacheAsync({ yieldMs: 8 });
      else store.saveIndexCache();
    } catch { /* 写不了不影响 */ }
    try {
      const metas = store.list();
      const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
      let dataBytes = 0;
      // ★ 2026-11-10：这个循环是 2×会话数 次 statSync，实测 400 个会话要 1.7 秒 ——
      //   在「启动期要一直能应答关窗请求」的前提下，它也是一段必须让出的阻塞。
      //   分段让出后，这条路径上就不再有超过几十毫秒的连续占用。
      let _k = 0;
      let _lastY = Date.now();
      for (const m of metas) {
        dataBytes += sizeOf(path.join(store.root, m.id, 'frames.jsonl')) + sizeOf(path.join(store.root, m.id, 'index.jsonl'));
        if ((++_k & 15) === 0 && Date.now() - _lastY >= 8) {
          await new Promise((r) => setImmediate(r));
          _lastY = Date.now();
        }
      }
      const cacheBytes = measureCacheBytes();
      diskCache = { dataBytes, cacheBytes }; diskAt = Date.now();
      steps.push('磁盘 ' + Math.round(dataBytes / 1048576) + 'MB');
    } catch { steps.push('磁盘 ✗'); }
    // ★ 没配书房就不扫 —— 发布版不该带着开发机的 1657 个文件。
    //   这里和 /api/organs 用的是同一条判据：config.soul.root 有值才动。
    try {
      const root = config.soul && config.soul.root;
      if (!root) { steps.push('书房 未配置'); }
      else {
        soulIdx = new SoulIndex(root, { ttl: (config.soul && config.soul.ttl) || 5000 });
        soulIdx.refresh();
        steps.push('书房 ' + soulIdx.size + ' 文件');
      }
    } catch { steps.push('书房 ✗'); }
    return { ms: Date.now() - t0, steps };
  };

  // ── 控制通道：宿主连上来自报能力，v4 主动推指令 ─────────────────────
  //
  // ★ 这是 2026-11-07 补上的那条腿。在此之前 v4 只有「被宿主调用」（MCP），
  //   没有「主动告诉宿主该动了」。而「触发源是 v4 触发 harness」（爀曦的原话）——
  //   没有这条通道，那句话就是空的。
  //
  // ★ 为什么是 WS 而不是让 v4 去轮询宿主：v4 是常驻的，它自己知道「该动了」；
  //   宿主是被拉起的，它不知道 v4 想什么时候动。**方向只能是 v4 → 宿主。**
  //
  // ★ 路径 /control：和 /mcp、UI 同一个端口（一个进程两个职责那套的延续）。
  if (control) {
    server.on('upgrade', (req, socket, head) => {
      let p2;
      try { p2 = new URL(req.url, 'http://x').pathname; } catch { p2 = ''; }
      if (p2 !== '/control') { try { socket.destroy(); } catch {} return; }
      try {
        const conn = wsAccept(req, socket);
        if (conn) control.attach(conn);
      } catch (e) {
        try { socket.destroy(); } catch {}
      }
    });
  }

  return server;
}
