# dsh-mcp-hub

本机所有 MCP 服务器的**唯一入口**：接入、卸载、检索、调用都走这一个插件。

| 段 | 内容 | 状态 |
|---|---|---|
| 第一段 | 清单 / MCP JSON-RPC（stdio 逐行 JSON）/ 工具注册与注销 | 已验收 |
| 第二段（本版） | 管理界面、增删改查路由、streamable-http 传输、连接策略定案 | 已验收 |

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 包描述；`dsh.client` + `exports["./client"]` 两个条件缺一不可 |
| `cordis.patch.yml` | 把宿主半插进 bundle |
| `index.js` | 宿主半：清单读写 / 两种传输 / 工具注册 / `/mcp-hub/*` 路由 |
| `client.js` | 浏览器半：侧边栏面板（列表 / 操作 / 搜索 / 添加 / 2s 轮询） |
| `_probe.mjs` | 探针：连真实 `windows-mcp`，验证注册与注销（回归用，约 40s） |
| `_fake-http-mcp.mjs` | 假 streamable-http MCP 服务器（json / sse 两种响应形态） |
| `_verify-http.mjs` | HTTP 传输验证：连接 → 列工具 → 调用 → 注册 → 注销 |
| `_routes.mjs` | 路由实测台：把同一份 handler 挂到 `node:http`，供 curl 打 |
| `_check-client.mjs` | `client.js` 语法 + 组件树检查（无浏览器） |
| `_tools.mjs` | 列出某台服务器的工具清单（名字 + 一句话描述） |

## 清单格式

位置：`$DSH_HOME/mcp-hub/servers.json`（本机 = `D:\AI\dsh\home\mcp-hub\servers.json`）。
可用环境变量 `DSH_MCP_HUB_SERVERS` 指向别的文件（探针/测试用）。

```json
{
  "version": 1,
  "servers": [
    {
      "serverName": "windows",
      "transport": "stdio",
      "enabled": true,
      "command": "C:\\Users\\pc\\.local\\bin\\uv.exe",
      "args": ["tool", "run", "--python", "3.14", "windows-mcp", "serve"],
      "env": { "UV_DEFAULT_INDEX": "https://mirrors.aliyun.com/pypi/simple" },
      "toolCallTimeoutMs": 60000
    },
    {
      "serverName": "web",
      "transport": "streamable-http",
      "enabled": true,
      "url": "http://127.0.0.1:9000/mcp",
      "headers": { "authorization": "Bearer ..." }
    }
  ]
}
```

字段：

| 字段 | 说明 |
|---|---|
| `serverName` | 工具名的 namespace，`[A-Za-z0-9_-]{1,32}`，同一作用域内唯一 |
| `transport` | `stdio` / `streamable-http` |
| `enabled` | 默认 `true`；`false` 时只进列表，不连接 |
| `command` / `args` / `env` / `cwd` | stdio 启动参数；`env` 叠加在**清洗过**的父环境之上 |
| `url` / `headers` | streamable-http 用 |
| `toolCallTimeoutMs` | 单次 `tools/call` 超时，默认 60000 |

顶层也可以直接是数组（兼容手写清单）。非法条目会被跳过并记进 `problems`。

**写盘**：所有增删改都经 `ManifestStore`，用 `tmp + rename` 原子替换，且保留条目里我们不认识的字段。
**顺序**：写清单先于内存变更；删除则相反——先断开、注销、关传输，最后才删清单（见「卸载语义」）。

环境清洗：删掉匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的变量和所有 `DSH_*`，再合并清单里显式给的 `env`。
所以 `UV_DEFAULT_INDEX` 必须写在清单里。

## 连接流程

```
loadServers() → 逐台 connectServer()
  → stdio：spawn(command, args, { env: 清洗后环境 })
  → http ：POST url（initialize）
  → initialize（stdio 协议 2024-11-05 / http 协议 2025-03-26）
  → notifications/initialized
  → tools/list（自己跟 nextCursor 翻页，重复 cursor 视为错误列表）
  → createToolDefinition() → ctx.tools.register() → 收下注销函数
```

**stdio 是逐行 JSON，不是 LSP 的 Content-Length 头。** 每行一条完整 JSON-RPC 消息，`\n` 分隔。

## 连接策略（第二段的定案）

**结论：不 await，后台推进；界面显示「连接中」，不假装已连上。**

理由：`windows-mcp` 首启约 20 秒（`uv tool run` 解析环境 + `tools/list`），
await 会把整个 DSH 启动路径拖住 20 秒；而 DSH 的启动不该由一台 MCP 服务器决定。

具体形态：

- `apply()` 里 `hub.start()` **不 await**，失败只写 `row.error`。
- 每一行有明确状态：`idle` / `connecting` / `ready` / `error` / `disabled`。
  `connecting` 就是「还在连」——**不是**「连上了」。
- 增删改路由也不 await 连接：`POST /servers`、`POST .../connect` 返回 `202` + `status: "connecting"`，
  界面 2 秒轮询 `GET /mcp-hub/servers` 看它变 `ready` 还是 `error`。
- 断开是同步语义（`await`）：因为「断开」必须真的把工具收走，否则界面会说谎。

### 考虑过但没采用的替代方案

1. **`await` 连接（`dsh-mcp-client` 的做法）**
   ✓ 工具在启动完成时就齐了。
   ✗ 一台慢服务器拖住整个 DSH 启动；多台串行更糟。
2. **惰性连接（第一次调用某台工具时才连）**
   ✓ 启动零成本；不用的服务器永远不付连接代价。
   ✗ 第一次调用要等 20 秒握手，而**工具调用是有超时的**——很容易变成「第一次用就超时」；
   ✗ 工具列表在第一次调用前是空的，模型看不到有哪些工具，等于让它猜。
3. **两段式：先用缓存的工具清单注册（stub），连上后替换成真定义**
   ✓ 启动即有列表。✗ 需要持久化工具清单 + 处理「缓存与远端不一致」，引入新的真相源，
   与「清单是唯一真相源」冲突。**不划算。**

所以选 1 的反面（后台）+ 明确的状态显示：**代价是启动头几十秒工具不在列表里，收益是 DSH 一定起得来。**
若要消掉这段空窗，正确方向是把「工具清单缓存」当成独立设计做（方案 3），而不是偷偷 await。

## 传输

### stdio

`spawn` → 逐行 JSON。收到不认识的单行只记日志、不断连接；子进程退出时把 pending 全部 reject。

### streamable-http（MCP 2025-03-26）

- `POST` 到 `url`，`content-type: application/json`，`accept: application/json, text/event-stream`。
- 响应两种都要处理：
  - `application/json` → 单条 JSON-RPC 响应（也接受数组）。
  - `text/event-stream` → SSE：按空行切事件，拼 `data:` 行，拿到 id 匹配的那条就收流。
- 通知（`notifications/initialized`）服务器回 `202`/`204`/空 `200`，没有响应体，客户端不等待。
- 会话：`initialize` 响应头里的 `mcp-session-id` 带到后续每个请求；`mcp-protocol-version` 同理。
- `close()` 会尝试 `DELETE`（规范允许客户端结束会话），服务器不支持就忽略。

**踩到的坑（已修）**：SSE 按 `\n\n` 切块后，块里**没有**空行，
所以「遇到空行才 dispatch」的写法永远不触发 → 每个事件都被丢掉，表现是「initialize 没有收到响应」。
正确做法是**一个块 = 一个事件**，切完立刻 dispatch。

## 工具命名

```
mcp__<serverName>__<toolName>
```

- 例：`mcp__windows__Snapshot`
- 超过 64 字符或含 `[A-Za-z0-9_-]` 以外的字符时，截断后追加 12 位 SHA-256（`sha256(serverName\0rawName)`）。
- `tools/call` 永远发**原始工具名**；不从公开名反解原名。

## 卸载语义

一台服务器的工具属于一个「世代」：

1. `ctx.tools.register(def)` 返回的注销函数收进该服务器的 disposer 列表
2. 卸载 = 逐个调注销函数（只移除自己那一条）→ 再 `client.close()`（stdio 关 stdin 走 EOF，1.5s 后兜底 `kill`；http 尝试 `DELETE` 会话）
3. 注册过程中任何一步抛错 → 已注册的整批回滚，不留「半台服务器」

**`DELETE /mcp-hub/servers/:name` 的顺序是硬要求：先断开（注销 + 关传输），再删清单。**
反过来的话，清单里没了这台，工具却还挂在注册表上，只能重启才能收走。

## HTTP 接口

| 方法 | 路径 | 行为 |
|---|---|---|
| `GET` | `/mcp-hub/servers` | `{ ok, file, servers, stats }` |
| `POST` | `/mcp-hub/servers` | 校验 + 写清单 + 后台连接；`201`，失败 `400` / 重名 `409` |
| `PATCH` | `/mcp-hub/servers/:name` | 改 `enabled` / `transport` / `command` / `args` / `env` / `url` / `headers` / `toolCallTimeoutMs`；停用会同步断开 |
| `DELETE` | `/mcp-hub/servers/:name` | 断开（含注销）→ 删清单；不存在 `404` |
| `POST` | `/mcp-hub/servers/:name/connect` | 未连：`202` + `connecting`；已连：`200` + `alreadyConnected` |
| `POST` | `/mcp-hub/servers/:name/disconnect` | 同步断开，返回 `idle`/`disabled` |
| `GET` | `/mcp-hub/tools?q=` | 跨已连接服务器搜工具：`{ ok, q, count, stats, tools:[{name,toolName,serverName,transport,description}] }` |

路由用 **一条 prefix 覆盖整棵子树**（`/mcp-hub/servers` 与 `/mcp-hub/tools`），
因为 `dsh-host-webserver` 的 `register()` 只有 `exact` / `prefix` 两种 kind，没有 `:param`。

`serverName` 不允许改（它是工具名 namespace）；要改名请删了重建。

## 界面（侧边栏 `sidebar.panellist`）

四块，都是真的能按的：

1. **服务器列表**：状态点 + 名字 + 传输标签 + `状态 · N tools`；错误单独一行。
   行内按钮：`连接` / `断开` / `停用`（或 `启用`）/ `删除`（点两次确认，3 秒后自动取消）。
2. **工具搜索**：输入框，250ms 防抖，跨所有已连接服务器按公开名 / 原始名 / 描述 / 服务器名过滤；
   显示 `mcp__<server>__<tool>` + 一句话说明（最多 50 条）。
3. **添加服务器**：`serverName` / `transport` / `command` / `args`（每行一个）/ `env`（`KEY=VALUE`）/
   `url` / `headers`（`Key: Value`）；`保存并连接` 提交后写清单并立即尝试连接。
4. **状态自动刷新**：每 2 秒轮询 `GET /mcp-hub/servers`（不用 WebSocket）；底部显示清单路径。

## 验证

```powershell
$node = "C:\Users\pc\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
cd D:\AI\dsh-tools\dsh-mcp-hub

& $node _probe.mjs              # ① 真连 windows-mcp：注册 21 / 注销 21（约 40s）
& $node _verify-http.mjs        # ② streamable-http：json + sse 两种形态
& $node ../plugin-dryrun.mjs .  # ③ 装载前注册期契约
& $node _check-client.mjs       # ④ client.js 语法 + 组件树 + 按钮挂载

# ⑤ 路由 curl 实测（另开一个进程跑测试台）
& $node _routes.mjs             # 打印 ROUTES_URL / FAKE_URL
curl.exe -s http://127.0.0.1:<port>/mcp-hub/servers
```

`_routes.mjs` 复刻的只是「前缀匹配 → handler」这一段（与 `dsh-host-webserver` 同语义），
handler 本身是 `index.js` 里同一份 `createRouteTable()`。
**当前 DSH 进程里没有装这个插件**，所以拿不到它自己的 `webServer`；这也是为什么需要一个实测台。

## 安装（未在本轮执行——重启由主导会话决定）

- **web profile**：`dsh plugin --profile web add file:D:/AI/dsh-tools/dsh-mcp-hub`
- **desktop profile**：不能用 CLI，手动复制文件到 `profiles\desktop\node_modules\dsh-mcp-hub\`，
  再把 `dsh-mcp-hub` **追加**到 `profiles\desktop\package.json` 的 `dsh.profile.bundles` 末尾。

宿主半改动必须重启 DSH 才生效。

## 已知的坑

1. **MCP stdio 是逐行 JSON。** 按 LSP 的 `Content-Length` 头写会连不上。
2. **`uv tool run` 首启约 20 秒**（实测 `tools/list` 13–23s）。连接不能放在同步激活路径上等。
3. **`UV_DEFAULT_INDEX` 必须显式写进清单**（环境清洗会删 `DSH_*`，父进程变量也不一定在）。
4. **远端 `inputSchema` 不能原样交给 `register()`**：`$schema` / `format` 会抛 `JsonSchemaError`，
   必须先过 `sanitizeSchema()`。
5. **`output` 是注册期硬契约**：`register()` 只校验 `output.schema` + `render`，不校验 `execute`。
6. **`exports.inject = ["slots"]` 不写 = 整包静默失效**。
7. **本机 `node` 不在 bash PATH 上**，用绝对路径。
8. **SSE 的块切完要立刻 dispatch**（见「streamable-http」）。
9. **不要谎报状态**：`connect` 打到已连的服务器时回 `alreadyConnected`，不能把 `status` 改成 `connecting` 又同时报 3 个工具。
10. **`dsh-host-webserver` 没有参数路由**，只有 `exact` / `prefix`；用 prefix + 自己解析 pathname。
