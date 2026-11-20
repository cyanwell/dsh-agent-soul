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

插件仍注册以下本地管理端点：`/agent-soul/status`、`/agent-soul/start`、`/agent-soul/stop`、`/agent-soul/restart`、`/agent-soul/probe`。本轮**没有修改 start/stop/restart 行为**，也没有把它们包装成已完成权限设计的接口。

当前遗留风险：`stop` 使用镜像名终止进程，管理端点仍需要后续权限设计，包括受信来源、CSRF、PID 精确绑定、并发启停和误杀边界。该项记录为后续门，不作为本轮修复结果隐去。

## 更新记录

### 0.1.4 · 2026-11-19

- 明确本版本为纯 Host 包；保留 `client.js` 源码但移除 package client export、`files` 项和 `dsh.client` 声明。
- 统一 `package.json` 与 `index.js` 版本为 `0.1.4`。
- 保留 10 个已实现/声明 Host caps；`stubCaps` 包含 `huanqi`、`pruner`；`prunerLive=false`。
- 将 `probe.mjs` 纳入发布清单，删除重复的 `index.js`，补充 syntax、selftest 和 packaging smoke scripts。
- 管理端点实现未改；权限设计仍待后续版本处理。

### 历史说明

pruner 相关的历史评估和独立复核保留在 `_verify`，其中依赖外部 `dsh-compaction`、`dsh-yanqing-pruner` 或真实 DSH profile 的测试必须显式标为跳过，不能把它们的旧 PASS 数字当作本版本绿灯。
