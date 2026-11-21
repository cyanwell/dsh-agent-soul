# dsh-agent-soul-bridge

版本：**0.1.4**（2026-11-19 发布审计修复）

agent-soul v4 控制通道的 **纯 Host 插件**。它连接 `ws://127.0.0.1:7310/control`，自报 Host 能力、接收 exec、返回 result，并按轮上报上下文水位。运行时只使用 Node.js 内置模块，不新增第三方依赖。

本版本的产品边界已经确定：`client.js` 源码暂时保留供后续 client UI 工作，但不属于本包的发布契约。`package.json` 不导出 `./client`，不声明 `dsh.client`，也不把 `client.js` 放进 `files`。本轮不声称浏览器 UI 可达。

## 能力表

| cap | action | 状态 | 说明 |
|---|---|---|---|
| `followup` | `say` | 真实现 | 向目标 agent 投递一轮 followup。 |
| `session` | 由协议定义 | 真实现 | 会话相关控制入口。 |
| `sessions` | 由协议定义 | 真实现 | 只读会话列表和数据投影。 |
| `workspaces` | `list` / `ensure` / `get` | 真实现 | 只读或幂等确保工作区，不修改会话内容。 |
| `agent` | 工具转发 | 真实现 | 将调用转发回 v4。 |
| `events` | 订阅 / 退订 / 状态 | 真实现 | 事件回流、句柄状态和补帧。 |
| `service` | 描述 / 调用 | 真实现 | 只暴露白名单纯数据方法。 |
| `context` | 上下文操作 | 真实现 | 使用公开 Session surface 原语。 |
| `huanqi` | `break-turn` | 桩 | 需要未提供的 hook，始终回 `ok:false`。 |
| `pruner` | `targeted-cleanup` | **默认桩** | 适配层保留，但尚未完成真实会话能力验收；默认关闭并显式声明为 stub。 |

生产声明的 caps 与源码 `DEFAULTS.caps` 一致，共 10 项；`stubCaps` 固定包含 `huanqi` 和 `pruner`。`cordis.patch.yml` 不得偷开 `prunerLive`，当前值为 `false`。

pruner 的失败必须是可核对的：请求缺字段、目标不一致、找不到活实例等情况均回带 stage 的 `ok:false`，不伪造 `framesAffected`，不使用默认会话兜底。适配层与评估证据见 [_verify/pruner-eval/](_verify/pruner-eval/) 和 [_verify/pruner-sync/](_verify/pruner-sync/)。依赖外部 `dsh-compaction` / 真实 pruner 实例的测试不属于无外部依赖 selftest。

## 发布文件

| 文件 | 作用 |
|---|---|
| `index.js` | Host 插件本体。 |
| `ws.js` | 零依赖 WebSocket 客户端。 |
| `pruner-adapter.mjs` | pruner 薄适配，不复制 surface 逻辑。 |
| `context-surgeon.mjs` | context 操作适配。 |
| `probe.mjs` | 不启动 DSH 的协议探针，已纳入包清单。 |
| `cordis.patch.yml` | Host bundle patch 与配置。 |
| `README.md` | 本说明。 |

发布清单不包含 `client.js`、备份文件或验证夹具；`files` 不允许重复项。

## 验证

这些命令都从包根目录运行，不依赖绝对本机路径、不安装依赖、不联网、不重启 DSH：

```text
npm run syntax
npm run selftest
npm run packaging:smoke
```

也可以直接运行探针：

```text
node probe.mjs fake
node probe.mjs live
node probe.mjs backoff
```

`fake` 使用 agent-soul 的协议实现，只有在本机存在对应源码时才运行；发布 smoke 不依赖它。`live` 需要已运行的 7310 控制通道。`backoff` 指向空端口并验证退避日志。

真 Cordis 验证器与端到端夹具在 [_verify/cordis-harness.mjs](_verify/cordis-harness.mjs)、[_verify/e2e-harness.mjs](_verify/e2e-harness.mjs)、[_verify/selftest.mjs](_verify/selftest.mjs)，它们读取本机 DSH 安装或生产数据目录，不能算无外部依赖 smoke。

## 管理端点

插件注册以下本地管理端点：`/agent-soul/status`、`/agent-soul/probe`（GET），
`/agent-soul/start`、`/agent-soul/stop`、`/agent-soul/restart`（POST）。

**鉴权三层，各管一件事**（0.1.8 起）：

| 层 | 判据 | 说明 |
|---|---|---|
| ① loopback | 来源必须是 127.0.0.1 / ::1 | 永远生效 |
| ② 严格同源 | `Origin` **缺省 = 同源，放行**；存在则必须逐字等于本实例 | 浏览器同源 GET 不发 Origin，所以「缺省放行」不是放宽 |
| ③ token（可选） | `localAdminToken` / `localAdminTokenFile` **配了才校验** | 那份 token 没有渠道交给浏览器里的面板 |

CSRF nonce 由 `GET /agent-soul/status` 只回给**已通过 ②** 的调用方；写操作带 `requestId` + `X-DSH-CSRF`。

**`stop` 的误杀边界已收**：按 `MainModule.FileName` 过滤，读不到路径**不杀**；
打印「已停止 N（另有 M 不在本目录下，没动它）」。不再按镜像名全杀。

## 更新记录

### 0.1.4 · 2026-11-19

- 明确本版本为纯 Host 包；保留 `client.js` 源码但移除 package client export、`files` 项和 `dsh.client` 声明。
- 统一 `package.json` 与 `index.js` 版本为 `0.1.4`。
- 保留 10 个已实现/声明 Host caps；`stubCaps` 包含 `huanqi`、`pruner`；`prunerLive=false`。
- 将 `probe.mjs` 纳入发布清单，删除重复的 `index.js`，补充 syntax、selftest 和 packaging smoke scripts。
- 管理端点实现未改；权限设计仍待后续版本处理。

### 历史说明

pruner 相关的历史评估和独立复核保留在 `_verify`，其中依赖外部 `dsh-compaction`、`dsh-yanqing-pruner` 或真实 DSH profile 的测试必须显式标为跳过，不能把它们的旧 PASS 数字当作本版本绿灯。

### 0.1.7 · 2026-11-21

- **修「只上报一个会话」**。
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

### 0.1.8 · 2026-11-21

- **修「面板恒 403」——两把锁同时锁死了自己。**
  线上现象：agent-soul 面板显示「失败：HTTP 403」「状态读不到：HTTP 403」，
  而 apply 回执显示 5 个路由**都注册成功**（`route:/agent-soul/status …`、`wired:5`）——
  不是没挂上，是挂上了却一律拒绝。
  · 锁一：`configured: !!(token && origin)`，而 `localAdminToken` 默认空串 →
    `configured` 恒 false → `origin-denied`（curl 四种 Header 组合全 403）。
  · 锁二：写操作要 CSRF nonce，它是 `randomBytes` 临时生成、只活在内存里，panel 拿不到 → 恒 403。
  · 附带：`client.js` 注释「所有管理端点只接 GET」是错的（status/probe 是 GET，另三个是 POST），
    写操作全走 GET → 405。
  改法见上面「管理端点」一节的鉴权三层表。
- `client.js` 写操作改 POST + `requestId` + `X-DSH-CSRF`；失败时把服务端 `code` 显示出来。

### 0.1.10 · 2026-11-21

- **修「同源 GET 不带 Origin 被挡」**（0.1.8 的遗留）。
  0.1.8 仍要求 `Origin` 逐字等于本实例 —— 而浏览器**同源 GET 不发 Origin**，
  于是 panel 自己的请求照样 403。实测确认：不带 Origin → 403；带正确 Origin → 200。
  现在：`Origin` **缺省视为同源放行**，存在则必须逐字匹配。
  理由写在代码里：能发 HTTP 到 loopback 的伪造者已过 ① 层；浏览器里的跨源页面**一定**被自动加上 Origin，
  走 ② 的分支被拒 —— 所以「缺省 = 同源」在浏览器语义下成立，不是放宽。
- **修 pruner 适配器静默吞掉 `dryRun`。**
  调用方写 `dryRun:true` 以为「只解析」，适配器只传五个字段 → **真的动了刀**。
  `applyDrops` 侧本来就有 dryRun 分支（`index.js:1067`），是适配器把它拦在门外。
  ★ 这种「参数被静默吞掉」比报错坏得多：它看起来成功了。
- **修 pruner 回执丢诊断字段。**
  原来只翻白名单 11 个字段，pruner 给的 `resolved:{surfaceSize,inRange,candidates}` /
  `pairs` / `skipped` / `reason` 全被丢掉 —— 于是 `framesAffected=0` 时调用方**分不出**：
  ① 区间里真的没有 tool/result（正常）；② 挑错了 seq；③ surface 读不出来 / 被 strict 跳过。
  ★ 与 `hub.snapshot` 白名单漏字段**同一个形状**：白名单本身没错，错在「0 必须能自证原因」。
- 测试新增 6 条：`M-34``M-35``M-36``M-37`（同源无 Origin 放行 / 坏 Origin 仍拒 / 未配 token 可通 / 非 loopback 拒）
  与 pruner 的 `⑦ dryRun 必须转发`、`⑧ 回执必须带诊断字段`。全套 **88/88**。

### 0.1.11 · 2026-11-21

- **pruner 回执加 `diagnosis`：每个 seq 为什么不合格，要写清。**
  起因：线上连续三次 `framesAffected=0` / `noMatch=true`，而回执不说每个 seq 怎么不合格 ——
  我换了三次 seq 才发现真正的原因是**挑的 seq 早就不在 surface 上了**。
  · 判据必须两边都查：pruner 是看 `session.surface.nodes` 判「在不在区间」的，
    而 `eventAt(seq)` 对**已移出 surface** 的 seq 照样返回事件（事件还在库里）。
    只看 eventAt 会把「不在 surface 上」误报成「形状合格」—— 我第一次诊断就是这么被误导的。
  · 回执新增：`diagnosis.surfaceSize` + 每个 seq 的
    `onSurface` / `type` / `callId` / `hasMarker` / `supported` / `mixed` / `chars` / `why`。
  · `why` 的取值分开且不合并：`no-event`（挑错 seq）/ `not-on-surface`（早剪过或不是 surface 节点）/
    `not-tool-result` / `mixed-frame` / `unsupported-shape` / `ok`。
    ★ 混成一个码就又要靠猜，而这次的成本是三轮。
  · 适配器**不替 pruner 决策**：diagnosis 只翻译它看到的事实，剪不剪仍由 pruner 定。
- 测试新增 ⑨：断言 `diagnosis` 存在、`surfaceSize` 正确、`onSurface` 能区分
  「不在 surface 上」与「连事件都没有」。全套 **89/89**。
