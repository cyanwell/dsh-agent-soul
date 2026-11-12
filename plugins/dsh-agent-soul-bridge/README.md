# dsh-agent-soul-bridge

agent-soul v4 **控制通道的宿主端**。零第三方依赖（只用 `node:` 内置）。

v4 有两条腿：① MCP server（宿主调它）② 控制通道 WS（它主动推指令给宿主）。本插件接 ②。

端点 `ws://127.0.0.1:7310/control`，协议源码 `D:\AI\agent-soul\src\control\{ws,hub}.mjs`（已冻结）。

## 它做四件事

1. **自报能力**：连上立刻发 `hello`，caps=`["followup","huanqi","pruner"]`
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
| `huanqi` | `break-turn` | ⚠️ 桩 | 回 `ok:false`：「未实现：要 hook 才能截断」 |
| `pruner` | `targeted-cleanup` | ⚠️ **默认仍声明为桩**（真路已写好、开关默认关） | 开关关：回 `ok:false` + 请求原样回显 + 缺口（与 11-10 一致）。开关开：走 `pruner-adapter.mjs` → 宿主侧同步 `applyDrops`，**真回执**。见 [_verify/pruner-sync/](_verify/pruner-sync/) |

★ 两个桩**在 `hello.meta.stubs` 里主动声明** —— 让 v4 在派活之前就知道，而不是派了才发现。
★ 附带的硬事实：**hub 会在派活前按 `meta.stubs` 直接拒**（`hint='stub_declared'`，见 `agent-soul/src/control/hub.mjs`）。
  所以只要还声明是桩，v4 根本不会把 exec 发过来；「桥里多写点 pruner 逻辑」在产出上是零。
  真要能清理，先得有入口（缺口与推荐接点见 EVALUATION.md §四）。

> 注：本机其实已有 `dsh-huanqi` / `dsh-yanqing-pruner` 两个插件在做这两件事，
> 但它们的触发点是**宿主内部的 hook**，不是控制通道的 exec 口。要不要把它们接进来，是下一步的事。

### pruner：11-10 的结论「接不了」，11-11 被推翻了（但默认仍关）

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

★★ **但它默认是关的**（`cfg.prunerLive = false`），而且 `stubCaps` 仍含 `'pruner'`。
理由只有一条：**「桥能不能拿到那个 pruner 实例」这个前提还没有实测证据**。
三条取用通道都写进去了（module 活实例表 / 根 `ctx.get` / `agent.ctx` 与 `agent.session.ctx`），
拿不到就抛 `no-pruner` —— 那时它仍然回 `ok:false`，**不会**退回去自己拼 surface 改写。

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

**打开的顺序（三条，缺一不可）**：

1. `cordis.patch.yml` 里给本插件加 `config: { prunerLive: true }`（`stubCaps` 先别动）→ 重启 DSH；
2. 用一个**非生产会话**手工发一条 `cap=pruner, action=targeted-cleanup` 的 exec，看回执：
   `ok:true` + `framesAffected` 是整数 + `pointer` 有值 = 通道成立；
   失败时看 `error` 前缀的 `[stage:<code>]`：
   `no-pruner`（且正文 `tried` 三条全 false）= 通道不成立，**就到这里为止，别删 stub**；
   `no-target` = 说会话给错了；`opid-reused` = opId 用过了；`stub` = 开关没生效。
3. 第 2 步过了，才把 `stubCaps` 里的 `'pruner'` 删掉（那时 hub 才会真派活）。

★ 前置：`dsh-yanqing-pruner` 必须已经是**带 `applyDrops` 的那一版**（本机当前源目录已改，
profile 里的副本还没同步 —— 见下「部署顺序」）。

## 文件

| 文件 | 作用 |
|---|---|
| `index.js` | 插件本体（宿主半，真 Node ESM） |
| `ws.js` | 最小 WebSocket 客户端（RFC 6455 子集，零依赖） |
| `cordis.patch.yml` | bundle patch（插进 profile 层栈） |
| `probe.mjs` | **不启动 DSH 也能验的探针**（见下） |
| `pruner-adapter.mjs` | 定点清理的**薄适配**（解析 → 找 agent → 找 pruner → 翻译回执；无 surface 逻辑） |
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

`fake` 覆盖 17 项（2026-11-09 实测 **PASS 17 / FAIL 0**）：hello/welcome、exec→result、
followup 真的调到 agent、**桩在派活前就被拒**（`e.hint=stub_declared`）、每轮钩子、
掉线自动重连（服务端停了再起，它会自己回来并重发 hello）。

`backoff` 2 项（**PASS 2 / FAIL 0**）：15.5 秒里只出 1 条 warn —— 退避不刷屏。

★ 2026-11-09 修了两条**过时的断言**：它们原本只认桥接自己回的「未实现」。
  但 `hub.mjs:92-103` 已按「桩提前拒绝」在**派活前** reject（秒级，不是等 15 秒超时）——
  那是更好的行为。断言改成**两条路都算过**，验的是「派到桩一定被拒且理由清楚」，
  而不是「一定由桥接拒」。桥接侧分支仍保留，作为 hub 未拦时的兜底。

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
| `caps` / `stubCaps` | 见上 | 举手 / 诚实地声明哪几个是桩 |
| `prunerLive` | `false` | **真**定点清理的总开关（见上文）。关着 = 与 11-10 行为一致 |
| `defaultSessionId` | `''` | 空 = 自动挑一个 live root agent；exec 的 `args.sessionId` 优先 |
| `pingMs` | 25000 | 0 = 关心跳 |
| `statePerTurn` | true | 每轮上报（借 `systemPrompt.context` 的 render 当钩子，**返回空串，不注入任何文字**） |
| `contextWindowFallback` | 1048576 | 真值优先从 `contextPressure.contextWindow` 读 |

## 已知缺口（不藏）

1. `outputTokens` **恒为 null**：不读宿主内部消息，宁可空着。hello 里 `meta.notWired` 已声明。
2. `huanqi` 仍是桩（要 hook 才能截断）。
   `pruner` **真路已写好但默认关闭**（`cfg.prunerLive = false`）——
   卡点不再是「有没有入口」，而是「桥能不能拿到那个 pruner 实例」这个**未实测**的前提。见上文三步开启顺序。
3. `followup` 回执只证明「投进去了」，不证明「真的开了一轮」—— 那取决于 agent 当时的运行状态。
   回执里 `note` 写死了这句话。
4. 多会话时自动挑 `roots[0]`，会在回执里带 `ambiguous:true` + `candidateIds`，
   让 v4 下次用 `args.sessionId` 指定。
