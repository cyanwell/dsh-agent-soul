# dsh-agent-soul-bridge

agent-soul v4 **控制通道的宿主端**。零第三方依赖（只用 `node:` 内置）。

v4 有两条腿：① MCP server（宿主调它）② 控制通道 WS（它主动推指令给宿主）。本插件接 ②。

端点 `ws://127.0.0.1:7310/control`，协议源码 `D:\AI\agent-soul\src\control\{ws,hub}.mjs`（已冻结）。

## 它做四件事

1. **自报能力**：连上立刻发 `hello`，caps 现在是**十项**
   （`followup / session / sessions / workspaces / agent / events / service / huanqi / pruner / context`），
   `meta.stubs` 为**空数组** —— 没有桩了。
   —— v4 的原则是「认识能力、不认识宿主」，所以第一件事是举手，不是自我介绍。
2. **接 exec 并回执**：每条 exec 都必须回 `result`（不回，v4 那边 15 秒超时）。
   任何异常路径都会回 `ok:false` + 原因，绝不静默吞掉。
3. **每轮上报 state**：`contextTokens` / `contextWindow` / `turnId`，供「思考退化检测」。
   **拿不到就报 null + 一句 reason，不拿 surfaceTokens 冒充水位。**
4. **断线指数退避重连**：1s → 2s → 4s → 8s → 16s → 30s 封顶。日志不刷屏（见下）。

## 能力表（老实版）

| cap | action | 状态 | 说明 |
|---|---|---|---|
| `followup` | `say` | ✅ 真做 | 调 `agent.followup({role:'user', content:[{type:'text'}]})` 触发一轮 |
| `huanqi` | `break-turn` | ✅ **真做**（2026-11-21） | 调宿主自己的取消机制 `agent.cancel({kind:'hook',reason},{keepInbox})` —— 真的打断这一轮。`keepInbox` 默认 true（断这一轮，不丢队列）。回执带 `cancelled`（= statusBefore==='running'）与 `statusBefore/statusAfter`：**空闲时 cancel 是 no-op，不许笼统回 ok**。 |
| `pruner` | `targeted-cleanup` | ✅ **真做**（2026-11-21） | 走 [`pruner-adapter.mjs`](pruner-adapter.mjs) → 活 pruner 的同步 `applyDrops`，回执带 `framesAffected` 与 `pointer`（`log:<会话>#seq=<n>`，v4 可直接回取）。拿不到活实例就 `no-pruner` 明确失败，**绝不自己拼 surface 改写**。见 [_verify/pruner-sync/](_verify/pruner-sync/) |

★ `stubCaps` 现在是**空数组**。硬事实仍然成立：**hub 会在派活前按 `meta.stubs` 直接拒**
  （`hint='stub_declared'`，见 `agent-soul/src/control/hub.mjs`）——
  也就是说，以前只要还声明是桩，v4 根本不会把 exec 发过来。现在两个能力都真的能干活，
  所以这个声明被撤掉了，hub 会真派活。

> 注：本机的 `dsh-yanqing-pruner` 插件仍然是 pruner 能力的**真正执行者**
> （`applyDrops` 在它里面）；桥只是通过 `getLivePruner(sessionId)` 拿到那个活实例再调它，
> 不复制它的策略。`huanqi` 不需要任何额外插件 —— 它用的是宿主 Agent 自己的 `cancel()`。

### pruner：11-10 说「接不了」，11-11 被推翻，11-21 接真

11-10 的评估（[_verify/pruner-eval/EVALUATION.md](_verify/pruner-eval/EVALUATION.md)）结论是「三条路各自被挡死」。
**那三条判据本身没错，错的是从中推出的「所以不可能」** —— 缺的那一块不在协议里，在触发点上：

| 11-10 的判断 | 11-11 的实况 |
|---|---|
| `pruneSession(session)` 只按字符预算整会话扫，**不按 seq 点名** | 对。但「点名」可以是**调用者的作用域**：`dsh-yanqing-pruner` 里 `__yqAllowed` 让 `pruneContent` 只对点名的 seq 动刀，其余回 `null`。**父类一行没改** |
| drop 指令层是**异步**的（等 `agent/pre-step`） | 对。但异步的是**触发点**，不是能力：`pruneSession` 本身同步，直接调它就是同步的 |
| `SurfaceOp` 没有 remove，范围级清理没有原语 | 对，而且**不需要** remove：官方路径从来就是「替换一条 `tool/result` 的正文」，配 `surfaceOp.replace` + `sourceEventSeqs`，replay 语义完整 |

所以 11-11 在本机落地的是：宿主侧 `applyDrops(req)`（`dsh-yanqing-pruner/index.js`，
**同步**、复用官方落盘原语、回执带 `framesAffected`），桥这边只留
[`pruner-adapter.mjs`](pruner-adapter.mjs) —— 解析请求、找活 agent、找活 pruner、翻译回执，
**不写一行 surface 逻辑**。

★★ **2026-11-21：默认开启**（`cfg.prunerLive = true`），`stubCaps` 已清空。

★ 关于「桥能不能拿到那个 pruner 实例」这个前提 —— 现在有实测答案了，而且是**分层**的：

| 通道 | 结果 | 依据 |
|---|---|---|
| module 活实例表（`import('dsh-yanqing-pruner')` → `getLivePruner(sid)`） | ✅ 唯一能拿到 `applyDrops` 的路 | 活的 `toolResultPruner` 服务只有 `config / measureContent / pruneContent / pruneSession` 四个成员（Cordis Inspect 查得到），**没有 applyDrops**；`applyDrops` 是 fork 加的，只在那个模块实例上 |
| 根 `ctx.get('toolResultPruner')` | ⚠️ 只到服务，够不到 `applyDrops` | 同上 |
| `agent.ctx` / `agent.session.ctx` | ⚠️ 同上 | 同上 |

三条仍然都试（多一条通道不多花钱），但**只有第一条能真正干活**。
拿不到就抛 `no-pruner` —— 那时它回 `ok:false`，**不会**退回去自己拼 surface 改写。

★ **`prunerLive` 现在是真开关**（2026-11-21 之前它从没被任何一行读过 ——
历次发布审计反复强调「必须保持 prunerLive=false」，而那个 false 什么也没挡住）。
语义：`true` = 执行；`false` = 回 `pruner/disabled`，一步不动。运维级 kill-switch。

### 失败回执带 stage（2026-11-11 上线前修正 F1）

线上 `result` 帧原来只有一句 `error` 字符串，`e.stage` 在 `handleExec` 的
`String(e)` 那一行就丢了 —— v4 的 `stageOfError()` 只认 timeout /「宿主不在」，
其余一律记 `transport-error`，排障时分不清「没目标」和「拿不到 pruner」。

现在失败帧固定形如：

```js
{ type:'result', id, ok:false,
  error: '[stage:no-target] 目标会话 session-x 不在活的 agent 里…',
  stage: 'no-target' }
```

- 前缀 `[stage:<code>]` 稳定可解析，`code` ∈ 适配器自报的
  `no-target / no-pruner / no-session / target-mismatch / bad-request / opid-reused / prune-threw …`
  或兜底映射 `stub / timeout / no-host / host-error`；
- 帧上同时给结构化 `stage` 字段（只读字段的消费方也能用）；
- 正文单行、隐去 `token/secret/password/api_key/cookie/authorization` 的键值对、限长 500；
- **成功帧不带 `error` / `stage`**（不把成功包成失败，反之亦然）。

★ 配套：`agent-soul/src/organs/cleanup.mjs` 的 `stageOfError()` 已认这个前缀
（机器可读优先于人话正则）。闭环测试：[`_verify/pruner-sync-fix/wire.stage.test.mjs`](_verify/pruner-sync-fix/wire.stage.test.mjs)。

★ 另外修正了「按会话挑活实例」：`getLivePruner` 只认同一个实例的
`__yqSeenSids` 含目标会话，未知/不唯一 → `null`（→ `no-pruner`），
**不再退回最后一个活实例**。代价：冷启动首轮该会话若还没被 pre-step 登记过，
模块通道会先 miss，落到 `ctx` / `agent.ctx` 通道。

**怎么判断它真的通了（排障口径）**：

发一条 `cap=pruner, action=targeted-cleanup` 的 exec，看回执：

| 回执 | 含义 |
|---|---|
| `ok:true` + `framesAffected` 是整数 + `pointer` 有值 | 通道成立，真的改了 surface |
| `[stage:no-pruner]`（正文 `tried` 里 module-registry 是 false） | 桥解析不到那份 fork —— 检查 `dsh-yanqing-pruner` 是否和桥装在**同一个 node_modules 树**下 |
| `[stage:no-target]` | 会话 id 给错了，或那个 agent 不在了 |
| `[stage:target-mismatch]` | `agents.get(sid)` 给出的 `session.id` 与请求不一致（不替你换一个） |
| `[stage:opid-reused]` | 同一个 opId 换区间重发了 |
| `[stage:unavailable]` + `pruner/disabled` | `prunerLive=false`，被开关挡住 |

★ 前置：`dsh-yanqing-pruner` 必须是**带 `applyDrops` 的那一版**，且与桥装在同一个 node_modules 树里。

★ **刚重启后第一次测会报 `no-pruner`，这不是故障**（2026-11-21 查证）：
`getLivePruner(sessionId)` 的判据不是「实例存在」，而是「**这个实例见过这个会话**」——
`__yqLive.add(this)` 在构造时就执行（实例立刻登记），但 `__yqSeenSids` 只在
`agent/pre-step` 或一次 applyDrops 里才填（dsh-yanqing-pruner/index.js:1032 / :1495）。
所以目标会话**必须先跑过至少一轮**，模块通道才会命中；这是 F5 那次修正的有意行为
（不退回「最后一个活实例」——那会把 A 会话的清理打到 B 的头上）。
排查顺序：先让那个会话走一轮（哪怕只说一句话），再发 targeted-cleanup。

★ 静态前提已实测（2026-11-21）：从 `profiles/desktop/node_modules/dsh-agent-soul-bridge/`
里 `import('dsh-yanqing-pruner')` **能解析到**，且导出 `getLivePruner` 与 `applyDropsForSession`。
剩下一层（同一个模块实例）由「两者同处 profile 的 node_modules 树」保证。


## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件本体（宿主半，真 Node ESM） |
| `ws.js` | 最小 WebSocket 客户端（RFC 6455 子集，零依赖） |
| `cordis.patch.yml` | bundle patch（插进 profile 层栈） |
| `probe.mjs` | **不启动 DSH 也能验的探针**（见下） |
| `pruner-adapter.mjs` | 定点清理的**薄适配**（解析 → 找 agent → 找 pruner → 翻译回执；无 surface 逻辑） |
| `context-surgeon.mjs` | `cap='context'` 的定点替换（用公开 Session 原语 `append + surfaceOp.replace`） |
| `lifecycle-inspect.mjs` | 管理端的**真实身份核验**：进程本体 + manager-proof + marker 三者对齐 |
| `process-inspector.mjs` | 单 PID 的 CIM 查询（ISO-8601 输出，见下「本机怪癖」） |
| `manager-proof-client.mjs` | 读 `/api/manager-proof`（X-Soul-Token，只认 loopback） |
| `bridge-proof.mjs` | 桥自己的身份证明 |
| `client.js` | 浏览器半源码（侧栏控制面板）。★ 当前**未**作为 client half 声明（无 `dsh.client` / `exports['./client']`），装上不会加载 —— 见「已知缺口」 |
| `_verify/pruner-eval/` | pruner 评估证据（`EVALUATION.md`）+ 16 条离线测试 |
| `_verify/pruner-sync/` | 薄适配的证据（8 条测试，含**把回执喂给 v4 的真判官**那次） |
| `_verify/pruner-sync-independent/` | 独立复核另造的 7 + 线上 1（未参与实现的人写的） |
| `_verify/pruner-sync-fix/` | F1 修正的 5 条（线上 stage 前缀/字段、stub/timeout/opid-reused、v4 真 stageOfError 闭环） |

## 安装（desktop profile）

```powershell
$src = "D:\AI\dsh-tools\dsh-agent-soul-bridge"
$dst = "D:\AI\dsh\home\profiles\desktop\node_modules\dsh-agent-soul-bridge"
Copy-Item $src $dst -Recurse -Force
# 再往 profiles\desktop\package.json 的 dsh.profile.bundles 里加 "dsh-agent-soul-bridge"
```

**宿主半只在 DSH 进程启动时加载 —— 必须重启 DSH 才生效。**

## 验证（不需要重启）

```powershell
node probe.mjs fake      # 用 agent-soul 真实的服务端代码起一个「假 v4」，验全链路
node probe.mjs live      # 连真实的 7310，只验握手 + hello
node probe.mjs backoff   # 指向空端口，验退避序列
```

`fake` 覆盖 21 项（2026-11-21 实测 **PASS 21 / FAIL 0**）：hello/welcome、exec→result、
followup 真的调到 agent、**huanqi/break-turn 真的调 agent.cancel**（cause.kind=hook、keepInbox 默认 true）、
**pruner 拿不到活实例时明确失败 no-pruner**（不伪造 framesAffected）、每轮钩子、
掉线自动重连（服务端停了再起，它会自己回来并重发 hello）。

**`node index.js --selftest`**（2026-11-21 新增）：不启动 DSH 也能判断「这个包会不会被加载」。
检查 11 项 —— 模块能否 import、`apply` 是不是函数、`cordis.patch.yml` 在不在、
`package.json` 的 `dsh.bundle` / `dsh.client` / `exports["./client"]` 是否成对、`stubCaps` 声明了什么。
★ 它**只查包自己的形状**：全部通过而宿主里仍无效，问题在宿主侧（bundles 列表 / 版本兼容 / loader 报错）。

`backoff` 2 项（**PASS 2 / FAIL 0**）：15.5 秒里只出 1 条 warn —— 退避不刷屏。

★ 2026-11-21 又修了两条**过时的断言**：桩没了（`stubCaps: []`），
  所以「派到桩一定被拒」这条断言本身失去意义。换成验**真行为**，而且比原来硬：
  break-turn 是否真的打到 `agent.cancel`、`cancelled` 是否与 `statusBefore` 对得上、
  pruner 在拿不到活实例时是否**明确失败**而不是伪造成功。

★ 探针 import 的是**本插件自己的 index.js**，不是复制一份逻辑 —— 验的就是要装进去的那份代码。
★ 探针还会 import `D:/AI/agent-soul/src/control/*.mjs`（**只读**）：对着协议的真实实现验，比对着文档验硬。

## 日志纪律（为什么重连不打屏）

| 时刻 | 打什么 |
|---|---|
| 连上（第一次） | `已连上 ws://…/control` |
| 第 1 次失败 | 一行：开始指数退避、上限多少、**「重试期间不刷屏」** |
| 间隔到顶（只一次） | `仍在重连（已 N 次，间隔已到 30s 上限）` |
| 重连成功 | `已重连 …（重试 N 次，空了 Xs）` |

中间的重试**一条都不打** —— v4 常常不开机，一开一关几十次重试，每次打一行会把日志埋掉。

## 配置（`cordis.patch.yml` 的 `config:`）

| 键 | 默认 | 说明 |
|---|---|---|
| `url` | `ws://127.0.0.1:7310/control` | 端点 |
| `hostName` | `dsh` | hello 里的 host 名 |
| `caps` / `stubCaps` | 十项 / `[]` | 举手 / 诚实地声明哪几个是桩（现在是零个） |
| `prunerLive` | `true` | **真**开关（以前从没被读过）。`false` = 回 `pruner/disabled`，一步不动 |
| `defaultSessionId` | `''` | 空 = 自动挑一个 live root agent；exec 的 `args.sessionId` 优先 |
| `pingMs` | 25000 | 0 = 关心跳 |
| `statePerTurn` | true | 每轮上报（借 `systemPrompt.context` 的 render 当钩子，**返回空串，不注入任何文字**） |
| `contextWindowFallback` | 1048576 | 真值优先从 `contextPressure.contextWindow` 读 |

## 已知缺口（不藏）

1. `outputTokens` **恒为 null**：不读宿主内部消息，宁可空着。hello 里 `meta.notWired` 已声明。
2. **`client.js`（浏览器半）不会加载** —— 这是**已查实**的，不是推测：
   `dsh-client-modules`（`lib/index.js:67-68`）的注释就是它的装载判据：
   > *"scans the host Loader's entries for packages **declaring `dsh.client`**"*
   而本包的 `package.json` 里 `dsh` 只有 `{ bundle }`，**没有 `client`** → 它根本不在扫描范围内。
   `client.js` 仍在 `files` 里（会随包发布），但发出去也没人加载。

   **要补什么（形状是从 `parseDshClient` 读出来的，不是猜的）**：

   ```jsonc
   // package.json
   "exports": { "./client": "./client.js" },   // 字符串，或 { "default": "./client.js" }
   "dsh": {
     "bundle": { "patch": "./cordis.patch.yml" },
     "client": {
       "platform": "...",        // ★ 必填，string
       "inject": ["slots"],      // 可选 string[]
       "external": [],           // 可选 string[]
       "immediately": false      // 可选 boolean
     }
   }
   ```

   `platform` 填什么值由宿主侧约定决定，**本包目前没有确证**，不要在没查清前随便填一个过关
   （`parseDshClient` 只校验它是 string，值错了不会当场报错，而是装载时不出东西 —— 那是最难查的一种）。

   **判据**：补完后侧栏应出现那个圆钮；若没出现，按 `client.js` 头注的顺序查三件事
   （`exports.inject` 是否含 `slots`、`platform` 值与宿主一致、浏览器控制台有没有报错）。
   ★ 这是**已知缺口，不是已完成**。
3. `followup` 回执只证明「投进去了」，不证明「真的开了一轮」—— 那取决于 agent 当时的运行状态。
   回执里 `note` 写死了这句话。
4. 多会话时自动挑 `roots[0]`，会在回执里带 `ambiguous:true` + `candidateIds`，
   让 v4 下次用 `args.sessionId` 指定。

## 更新记录

（只追加，不改旧条目 —— 旧条目是对当时事实的记录，改它等于伪造历史。）

### 0.1.7 · 2026-11-21

- **修「只上报一个会话」**（用户报告 bridge-session-report-issue.md：/api/autonomy 恒 UNKNOWN）。
  根因是**钩子拿不到主角**：原来借 `systemPrompt.context` 的 render 当钩子并读 `context.agent`，
  而 `AssembleContext`（dsh-system-prompt/lib/types/index.d.ts:37-45）只有 `scope` 与 `signal` 两个字段
  —— **没有 agent，也没有 session**。于是既能解释「重启后第一轮 sessionId 为 null」，
  也能解释「退回 pickLiveAgent 后整台机器只有一条 state」。
  · 主路换成 `agent/pre-step`：payload 里**明确有 agent**
    （dsh-agent/lib/types/runtime-types.d.ts:313-319），且按 agent 作用域派发、每轮每 agent 各触发一次。
  · 节流从「全局一个 lastStateAt」改成「按会话 lastStateAtBySession」——
    否则不同会话互相把对方的 state 挤掉。
  · state 帧新增 `stateVia` 与 `fallback`：拿不到 agent 时的兜底上报**明确标记**，
    不让 v4 把它当成「这个会话活跃过」的证据。
  · `systemPrompt.context` 保留为退路，只在 pre-step 装不上时用。
- **补上 client half 声明**（`client.js` 装了三个月但从未加载）：
  `exports["./client"]` + `dsh.client = { platform: "web", inject: [] }`。
  判据来自 `dsh-client-modules/lib/index.js:67-68`：它只扫**声明了 `dsh.client`** 的包。
  `packaging-smoke` 加了一条断言：`dsh.client` / `exports["./client"]` / `files 含 client.js`
  三者必须**成对**出现 —— 少一个都是坏包。
- README 里那段「client.js 缺口」从推测升级为已查实 + 完整补法（含 `platform` 值的来历说明）。

### 0.1.6 · 2026-11-21

- **huanqi 接真**：动作名回到协议一直写的 `break-turn`，实现为 `agent.cancel({kind:'hook',reason},{keepInbox})`。
  回执带 `cancelled`（= statusBefore==='running'）与 `statusBefore/statusAfter` —— cancel 在空闲时是 no-op，
  不许笼统回 ok。★ 撤掉 0.1.5 期间我误加的 `prune` / `measure`：那是把 pruner 的活抄了一份挂到 huanqi 名下。
- **pruner 回到适配器**：`targeted-cleanup` 走 `pruner-adapter.mjs` → 活 pruner 的同步 `applyDrops`，
  回执带 `pointer`（`log:<会话>#seq=<n>`，v4 可直接回取）。
  ★ 撤掉 0.1.5 期间用 `context-surgeon` 自己拼 `surfaceOp.replace` 的做法 ——
  adapter 头注早就写着「绝不自己拼，那是把 pruner 的策略抄一份到桥里」。v4 的 `judgeCleanupReceipt` 要的正是原生 pointer。
- **`prunerLive` 变成真开关**：查出来的事实是它从 2026-11-11 写进来以后**从来没有一处读过**。
  历次发布审计反复强调「必须保持 prunerLive=false」，而那个 false 什么也没挡住。
  现在：`true` 执行 / `false` 回 `pruner/disabled` 且一步不动。默认 `true`。
- **`stubCaps` 清空**（`[]`）：huanqi / pruner 都不再是桩，`hello.meta.stubs` 是空数组。
- **`prunerRefusalMessage` 重写**：原文案有三处已变成假话 ——
  ①「没有可执行的宿主实现」②「缺口：PRUNER_GAP」（那个缺口已被 applyDrops 填上）
  ③「本宿主已在 hello.meta.stubs 里声明 pruner」。现在它只回答一件事：这次请求哪里不合法。
- **stage 映射修正两处**（这两处是我自己引入的错，靠测试抓出来的）：
  ① 不许拿粗桶（not-found/unsupported）去顶适配器自报的具体原因（no-target/no-pruner）——
     契约 F1 要求 stage 原样带回，v4 的 `stageOfError()` 按具体值分流；
  ② 适配器没自报 stage 时**不硬塞** `'failed'` —— 塞了就会把 `execStageOf()` 的文本启发式
     （超时 → timeout）整个挡掉。
- **打包契约改成断言语义**：`_verify/packaging-smoke.mjs` 原来把「0.1.4 / stubCaps 含两项 / prunerLive=false」
  写死成断言，版本一升就整片红；而真正该守的那条（**index.js import 的模块必须都在 files 里**）反而没被守住。
  现在断言：版本单一真相、files 覆盖所有相对 import、两边 config 一致、caps 十项不少。
- **`process-inspector.mjs`**：CIM 的 `CreationDate` 由 PowerShell 自己输出 ISO-8601 UTC
  （本机 `ConvertTo-Json` 得到 `/Date(...)/`、`[string]` 强转得到区域格式，两者都解析不了）；
  超时 5000 → 25000（powershell 冷启动约 5.4s，CIM 查询合计 6–13s）。
- **新增 `lifecycle-inspect.mjs`**：管理端的真实身份核验（进程本体 + manager-proof + marker 三者对齐），
  三条半边任何一条拿不到都明确说拿不到，不合成一个「看着像通过」的 true。
- 测试：全套 82 条通过（含 4 个 `pruner-sync*` 文件，需 `--import dsh-yanqing-pruner/test/register.mjs`）；
  `probe.mjs fake` 21/21。

### 0.1.5 · 2026-11-20

- 生产 `AgentSoul.exe` 重新编译：`build/Shell.cs` 在 11-19 改对了但**从没重编**，
  生产二进制还是旧的（133,632 B，UTF-16 里扫不到 `AGENT_SOUL_MANAGER_MARKER`）。
  重编后 152,064 B，`/api/manager-proof` 返回 200。★ 判据：源码对了 ≠ 跑的是对的。
- 桥的 caps 与 patch 两边对齐（10 项）；`agentSoulPlan` 同时接受 `<root>/build/AgentSoul.exe` 与 `<root>/AgentSoul.exe`。
