# 接入各个 harness

> 面向「换一个宿主，改动量应该只是填一个地址」这件事。
> 本文所有命令都在本机跑过，读数写在命令旁边；没跑过的会明写「未实测」。
> 核对时间：2026-11-07 02:33。node = `C:/Users/pc/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe`（v24.21.0，`Test-Path` = True）。

---

## 一、两条腿怎么选

| | **stdio** | **HTTP** |
|---|---|---|
| 进程 | 宿主 spawn 一个 node 子进程，活到宿主退出 | 自己起服务（或跟 UI 同进程）；宿主是客户端 |
| 传输 | stdin 一行一个 JSON-RPC，stdout 回一行 | `POST /mcp`，一次一条；`GET /mcp` 只回服务信息 |
| 默认地址 | 无（进程内管道） | **7311**（`mcp-http.mjs` 独立起）；**7310**（`index.mjs`，UI 与 MCP 同端口，`config.port`） |
| 端点 | — | `http://127.0.0.1:<port>/mcp`，只绑 127.0.0.1，无鉴权 |
| 前提 | 宿主**能 spawn 子进程** | 宿主**能发 HTTP**；不需要它管理进程 |
| 典型适用 | 桌面宿主（DSH / Claude Desktop / Cursor / z code） | 远程、容器、沙箱、网页版宿主；**以及人肉用 curl 验证** |
| 谁管生命周期 | 宿主（宿主关 → 进程退） | 你自己（关掉窗口/进程就是断了） |
| 工具集 | 11 个 | **同一份 11 个**（两条腿都 import `mcp-tools.mjs`，不重复定义） |

**判断依据（按顺序问）：**

1. 宿主能 spawn 子进程、并且有「MCP 服务器」这个配置项？→ **stdio**，写一份 JSON 就完了。
2. 宿主不能 spawn（网页版、远程、沙箱），只认 URL？→ **HTTP**，填一个地址。
3. 只是要确认「服务活着、工具在」而不接宿主？→ **HTTP + curl**（不需要任何 SDK，见第三节）。
4. 两者都能：**stdio 优先**。理由是进程归宿主管，不会出现「地址填了、服务没起」这种半死状态。

★ 两条腿共享同一个数据目录（`config.json` 的 `dataDir` = `D:/AI/agent-soul/data`），所以 stdio 和 HTTP 看到的是同一批会话——实测 1006 个会话 / 159,997 帧。

---

## 二、stdio 接入

### 2.1 配置片段（DSH `servers.json` 的条目形状）

```json
{
  "serverName": "agent-soul",
  "transport": "stdio",
  "enabled": true,
  "command": "C:/Users/pc/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe",
  "args": ["D:/AI/agent-soul/src/adapters/mcp.mjs"],
  "env": {},
  "toolCallTimeoutMs": 30000,
  "disabledTools": []
}
```

这就是本机 `D:\AI\dsh\home\mcp-hub\servers.json` 里已经在跑的条目（不是示例）。

### 2.2 Windows 路径转义

| 写法 | 例子 | 说明 |
|---|---|---|
| 正斜杠 | `D:/AI/agent-soul/src/adapters/mcp.mjs` | **首选**。JSON 里不需要转义，node 在 Windows 上直接认 |
| 双反斜杠 | `D:\\AI\\agent-soul\\src\\adapters\\mcp.mjs` | JSON 字符串里反斜杠必须双写，否则 `\A` 是非法转义 |
| 单反斜杠 | `D:\AI\agent-soul` | **不要写进 JSON**：`\A` 是非法转义，`JSON.parse` 会报错。shell 里才这么写 |

★ 本机 `servers.json` 同时存在两种风格：`echo` 那条用双反斜杠，`agent-soul` 那条用正斜杠——两条都在用，说明都能跑。

★ 路径里的空格（`DeepSeek Harness`）在 JSON 里**不用**加引号转义；只有写到 shell 里才需要引号。

### 2.3 不接宿主也能验：直接喂一行 JSON-RPC

```powershell
& "C:/Users/pc/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe" D:/AI/agent-soul/src/adapters/mcp.mjs
```

给它 stdin 两行，实测输出：

```powershell
$node = "C:/Users/pc/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe"
$lines = @(
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}',
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}',
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"soul_health","arguments":{}}}'
)
($lines -join "`n") | & $node D:/AI/agent-soul/src/adapters/mcp.mjs 2>$null
```

实测三条返回：`initialize` 回 `{"capabilities":{"tools":{}},"serverInfo":{"name":"agent-soul","version":"0.1.0"}}`；`tools/list` 回 11 个工具；`soul_health` 回 `{"sessions":1006,"frames":159997,"dataDir":"D:/AI/agent-soul/data",...}`。

标准错误流有一行 `[agent-soul] MCP server ready (stdio), 11 tools`——**宿主日志里找不到这行，基本就是没起来。**

---

## 三、HTTP 接入

### 3.1 起服务

```powershell
$node = "C:/Users/pc/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe"

# 独立起（默认 7311，可用环境变量改）
& $node D:/AI/agent-soul/src/adapters/mcp-http.mjs

# 或者跟 UI 同一个进程同一个端口（7310，来自 config.json 的 port）
& $node D:/AI/agent-soul/src/index.mjs
```

起成功后 stderr 打：`[agent-soul] MCP over HTTP ready: http://127.0.0.1:7311/mcp`。

### 3.2 端点

| 方法 | 路径 | 行为 |
|---|---|---|
| `GET` | `/mcp` | 回服务信息 + 11 个工具名清单（实测见下） |
| `POST` | `/mcp` | body = 一条 JSON-RPC（`initialize` / `tools/list` / `tools/call`） |
| 其它 | | 405 `{"error":{"code":-32600,"message":"只支持 POST"}}` |

### 3.3 curl 验证（这几条本机真跑过）

```powershell
# ① 服务信息
curl.exe -s http://127.0.0.1:7311/mcp

# ② 列工具（body 用管道喂进去，绕开 PowerShell 5.1 的引号问题）
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | curl.exe -s -X POST http://127.0.0.1:7311/mcp -H "Content-Type: application/json" -d '@-'

# ③ 真调一个工具
'{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"soul_health","arguments":{}}}' | curl.exe -s -X POST http://127.0.0.1:7311/mcp -H "Content-Type: application/json" -d '@-'

# ④ 检索书房
'{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"soul_file","arguments":{"terms":["判据","他人"],"limit":2}}}' | curl.exe -s -X POST http://127.0.0.1:7311/mcp -H "Content-Type: application/json" -d '@-'
```

① 实测回：`{"server":"agent-soul","version":"0.1.0","transport":"http","tools":["soul_context","soul_file","soul_compact","soul_waker","soul_autonomy","soul_recall","soul_frame","soul_persona","soul_index","soul_sessions","soul_health"],"usage":"POST 这个路径..."}`
④ 实测回：`书房 1657 个文件 / 11.8MB（本次读了 1657 份）\n命中 2 条 / 3ms` 加两条指针。

想在 `cmd.exe` 里直接写成一行，用这种转义：

```bat
curl.exe -s -X POST http://127.0.0.1:7311/mcp -H "Content-Type: application/json" -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\"}"
```

（上面这段在 PowerShell 里要写成 `cmd /c '...'`，反斜杠再翻一倍；我在本机是这样验通的。）

### 3.4 一条必须知道的坑（本机踩过）

PowerShell 5.1 把 `-d '{"jsonrpc":"2.0",...}'` 传给原生 exe 时**会把引号剥掉**，服务端收到的是坏 JSON：

```
{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"JSON 解析失败"}}
```

三种写法我都试了：变量传参 ✗、`-d '...'` ✗、`--data-binary @文件`（文件带 BOM）✗。
**能跑的是**：`-d '@-'` 管道喂 stdin，或 `cmd /c` 里用 `\"` 转义。看到 `-32700` 先查引号，不要查服务端。

### 3.5 协议面（两条腿完全一致）

支持的方法：`initialize` / `notifications/initialized`（回 null，HTTP 侧 202 空 body）/ `ping` / `tools/list` / `tools/call`。
其余方法：`{"error":{"code":-32601,"message":"不认识的方法: <method>"}}`。

★ HTTP 是**无状态**的：没有 session id、没有 SSE、不支持一次发一批。每条请求自己带完整 `params`。

---

## 四、11 个工具（定义取自 `src/adapters/mcp-tools.mjs`）

示例都是我能贴出真实返回的那些；写操作的工具（`soul_index` / `soul_compact` / `soul_waker` 的 decide/ingest）只给请求体，返回形状来自代码。

| # | 工具 | 一句话 | 必填 |
|---|---|---|---|
| 1 | `soul_context` | 现在几点、这个会话静默多久、上下文用了多少（三档水位 45/60/80%） | 无 |
| 2 | `soul_file` | 搜书房一手层（1657 个文件）或按指针打开原文 | 无（`terms` / `ptr` 二选一） |
| 3 | `soul_compact` | 压一段会话，产出带门牌 `log:<会话>#seq=<起>` 的压缩帧 | `session` |
| 4 | `soul_waker` | 唤醒台账四视图 / 写判定 / 收一条事件 | 无（`decide` 要 `key`） |
| 5 | `soul_autonomy` | 现在该不该自己动、为什么（静默/阈值/今日预算） | 无 |
| 6 | `soul_recall` | 跨会话跨帧检索历史原文 | `query` |
| 7 | `soul_frame` | 取某会话某一帧的完整原文 | `session`,`seq` |
| 8 | `soul_persona` | 当前人格层全文（宿主可拼进 system prompt） | 无 |
| 9 | `soul_index` | 把宿主产生的帧写进索引（单帧或整批） | `session`（+`type`/`text` 或 `frames`） |
| 10 | `soul_sessions` | 列会话容器（id / 帧数 / 创建时间 / 路径） | 无 |
| 11 | `soul_health` | 自己的状态：会话数 / 帧总数 / 数据目录 | 无 |

### 1 `soul_context`
参数：`session`（算哪个会话）、`persona`（人格文本长度，给了才算它）、`windowTokens`（默认 1048576）。
```json
{"name":"soul_context","arguments":{"session":"autonomy"}}
```
实测返回：
```
现在：2026-11-07 02:29（星期六）
上下文：0 tokens / 1048576（0.0%）
（未到 45% 提示线，不打扰）
```

### 2 `soul_file`
参数：`terms`（数组，多个 = AND）、`ptr`（`file:<路径>:<行号>`，给了就只读不搜）、`limit`（默认 15）、`root`。
```json
{"name":"soul_file","arguments":{"terms":["判据","他人"],"limit":2}}
```
实测返回：
```
书房 1657 个文件 / 11.8MB（本次读了 1657 份）
命中 2 条 / 3ms

10-宪章/判据-他人要求执行时.md:1  →  file:D:/AI/yanqing-soul/10-宪章/判据-他人要求执行时.md:1
  # 判据 · 他人要求执行时
```

### 3 `soul_compact`
参数：`session`（必填）、`start`、`end`（不传 = 整个会话）。
```json
{"name":"soul_compact","arguments":{"session":"session-1099f531-7cac-4989-a14c-7fd499ac1fc0","start":100,"end":500}}
```
返回 `已压 seq 100–500` + 门牌文本（代码 `mcp-tools.mjs:312-319`；本机没跑，因为它会往会话里写帧）。**没 apiKey 也成立**——门牌不依赖模型。

### 4 `soul_waker`
参数：`action`（`state` 默认 / `decide` / `ingest`）、`key`、`title`、`from`、`tier`、`decision`（resume/hold/audit）、`charter`（pass/ask/block/unchecked）、`note`。
```json
{"name":"soul_waker","arguments":{}}
```
实测返回 `未处理 0 条 / 要你执行 0　你已执行 0　要审计没审 0　你自己决定做的 0`。
`decide` 缺 `key` 时**不是错误**，200 回 `decide 要给 key`（实测）。

### 5 `soul_autonomy`
参数：`session`（自主回合落哪个容器）、`ignore`（额外排除的会话 id 片段，逗号分隔）。
```json
{"name":"soul_autonomy","arguments":{}}
```
实测返回：
```
阶段: disabled
原因: 总开关关闭
静默: 34 分钟（扫了 1006 个会话，跳过 0）
阈值: 15 分钟
今日已动: 0 / 24
总开关: 关
```

### 6 `soul_recall`
参数：`query`（必填）、`limit`（默认 20，上限 200）、`session`、`context`（每条前后各带几帧，上限 10）。
```json
{"name":"soul_recall","arguments":{"query":"门牌","limit":2}}
```
实测返回形如 `[session-1099f531-...#391] (tool_call) ...` 的命中行——门牌就是 `会话#seq`。

### 7 `soul_frame`
参数：`session`、`seq`（都必填，integer）。
```json
{"name":"soul_frame","arguments":{"session":"session-1099f531-7cac-4989-a14c-7fd499ac1fc0","seq":391}}
```
实测返回该帧 JSON（`seq` / `t` / `type` / `name` / `args` …）。
缺 `seq` 会得到 `-32603 没有 seq=undefined 的帧（共 70263 帧）`——**必填校验不在协议层**，工具自己判。

### 8 `soul_persona`
参数：无。
```json
{"name":"soul_persona","arguments":{}}
```
实测返回人格全文（开头 `===== 【不变量 · 永不裁剪】 =====`），末尾附 `已装 N 个文件，x B / 预算 80000B`，有裁剪时列 `裁掉: ...`。

### 9 `soul_index`
参数：`session`（必填，宿主的会话 id，不存在就自动建容器）、单帧 `type`+`text`、或整批 `frames`（`[{type,text,meta?}]`）、`meta`。
```json
{"name":"soul_index","arguments":{"session":"dsh-session-abc","type":"user","text":"这条要进索引"}}
```
```json
{"name":"soul_index","arguments":{"session":"dsh-session-abc","frames":[
  {"type":"user","text":"第一句"},
  {"type":"assistant","text":"第二句","meta":{"model":"deepseek-chat"}}
]}}
```
单帧回 `已索引 <sid>#<seq>`，整批回 `已索引 <sid> 共 N 帧，seq a..b`（代码 `mcp-tools.mjs:201-223`）。
★ 这是挂载模式的关键：**宿主写什么，索引就跟什么**，agent-soul 不抢存储。

### 10 `soul_sessions`
参数：`limit`（默认 30，上限 200）。
```json
{"name":"soul_sessions","arguments":{"limit":3}}
```
实测返回三行：
```
session-1099f531-7cac-4989-a14c-7fd499ac1fc0  70263 帧  2026-11-06T17:54:32  D:\AI\yanqing-soul
session-15ed002e-91ea-4731-bd79-ab46326e9004  20059 帧  2026-11-06T17:53:16  D:\AI\yanqing-soul
session-3c9267ca-34ee-44e8-90aa-9abaa5056aeb  17250 帧  2026-11-06T17:52:48  D:\AI\yanqing-soul
```

### 11 `soul_health`
参数：无。
```json
{"name":"soul_health","arguments":{}}
```
实测返回：
```json
{"sessions":1006,"frames":159997,"dataDir":"D:/AI/agent-soul/data","name":"agent-soul","version":"0.1.0"}
```

---

## 五、三种宿主的配置位置

### 5.1 DeepSeek Harness

配置文件：`D:\AI\dsh\home\mcp-hub\servers.json`（本机实测存在，1657 B，四条服务器）。
结构：`{"version":1,"servers":[{serverName, transport, enabled, command, args, env?, toolCallTimeoutMs?, disabledTools?}]}`。
**agent-soul 已经在这个文件里**，条目就是 2.1 那段。

改完要重启 DSH 才生效（servers.json 是启动时读的）。
验证：重启后工具列表里应出现 `mcp__agent-soul__soul_*` 这一组。

★ 本机这个文件里四条**全是 `"transport": "stdio"`**。这台机器上 HTTP 腿从没被宿主用过——它的价值在于「换一个只认地址的宿主」。客户端支持 MCP-over-HTTP 时才可填地址，否则走 stdio。

### 5.2 Claude Desktop

路径：`%APPDATA%\Claude\claude_desktop_config.json`
（展开 = `C:\Users\pc\AppData\Roaming\Claude\claude_desktop_config.json`）

**本机没装 Claude Desktop**：`C:\Users\pc\AppData\Roaming\Claude`、`C:\Users\pc\AppData\Local\AnthropicClaude`、`C:\Program Files\Claude` 三个路径 `Test-Path` 全是 False。所以这个文件现在不存在，**贴进去的配置要等装好、它自己生成那份之后再加**。

装好后的写法（键名是 `mcpServers`，与 DSH 的数组结构不同）：

```json
{
  "mcpServers": {
    "agent-soul": {
      "command": "C:/Users/pc/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe",
      "args": ["D:/AI/agent-soul/src/adapters/mcp.mjs"]
    }
  }
}
```

改完要**完全退出再启动**（托盘退出，不是关窗口），Claude Desktop 不热加载。

### 5.3 通用 MCP 客户端（不用 SDK）

任何客户端只要做四步，都是标准 JSON-RPC 2.0：

```text
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}
← {"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"agent-soul","version":"0.1.0"}}}

→ {"jsonrpc":"2.0","method":"notifications/initialized"}       （通知，无 id，不回）
→ {"jsonrpc":"2.0","id":2,"method":"tools/list"}
→ {"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"soul_health","arguments":{}}}
```

- stdio：每条一行，行尾 `\n`；**stdout 只许有 JSON-RPC**，日志在 stderr。
- HTTP：一条请求一个 body，`Content-Type: application/json`。

★ `protocolVersion` 服务端**回显客户端给的值**，没给就默认 `2024-11-05`。所以客户端报什么版本都能握手，不需要版本协商重试。

---

## 六、四种故障与判据

### ① 初始化超时（宿主卡在 connecting）

先证明这个进程本身能在 1 秒内吐出 `initialize`：

```powershell
$node = "C:/Users/pc/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe"
'{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' | & $node D:/AI/agent-soul/src/adapters/mcp.mjs
```

- 有 `result` → 进程没问题，去核宿主的 `command` / `args` 两个字段（引号、斜杠、盘符）。路径写错时宿主不一定报错，所以错要在这一步被看见。
- 什么都没、或报 `Cannot find module` → 路径错。跑这条确认两个路径都在：

```powershell
Test-Path "C:/Users/pc/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe"
Test-Path "D:/AI/agent-soul/src/adapters/mcp.mjs"
```

（本机两条都是 True。第一条给 False 说明 node 换了位置——DSH 升级会动它，那就把 `command` 改成新路径，或者换成系统 `node`。）

★ 判据：**卡住 = 一个字节都没回**。回了任何 JSON 就不叫超时。

### ② 工具列表为空

先看服务端到底有几个工具（HTTP 腿最省事，一条 GET）：

```powershell
curl.exe -s http://127.0.0.1:7311/mcp
```

回 `"tools":[...11 个...]` → 服务端没问题，问题在宿主：看 `servers.json` 里 `enabled` 是不是 `true`、`disabledTools` 有没有把这些名字写进去、以及**改完有没有重启**。
回连不上 → 服务没起。判据：

```powershell
Test-NetConnection -ComputerName 127.0.0.1 -Port 7311 -InformationLevel Quiet
# 本机起服务时实测 True；没起时 False
```

### ③ 调用报 `-32601`

`-32601` 在这套代码里只有两个来源：**不认识的方法**、**不认识的工具名**（`NO_TOOL`，见 `mcp-tools.mjs:367-369`）。

```powershell
'{"jsonrpc":"2.0","id":9,"method":"foo/bar"}' | curl.exe -s -X POST http://127.0.0.1:7311/mcp -H "Content-Type: application/json" -d '@-'
# 实测：{"jsonrpc":"2.0","id":9,"error":{"code":-32601,"message":"不认识的方法: foo/bar"}}
```

对照名字：

```powershell
'{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | curl.exe -s -X POST http://127.0.0.1:7311/mcp -H "Content-Type: application/json" -d '@-' | Select-String -Pattern '"name":"soul_[a-z_]+"' -AllMatches | ForEach-Object { $_.Matches.Value }
```

★ 注意区别：**工具名错 → `-32601`；工具内部抛异常 → `-32603`；JSON 本身坏了 → `-32700`。** 三个码指向三个不同的层，别混。

### ④ stdio 进程退出

看宿主日志里有没有这行（启动时一定打，走 stderr）：

```text
[agent-soul] MCP server ready (stdio), 11 tools
```

手工复现它的退出码与 stderr：

```powershell
$node = "C:/Users/pc/AppData/Local/Programs/DeepSeek Harness/resources/runtime/primary-runtime/dependencies/node/bin/node.exe"
'{"jsonrpc":"2.0","id":1,"method":"ping"}' | & $node D:/AI/agent-soul/src/adapters/mcp.mjs
echo "exit=$LASTEXITCODE"
```

正常：`{"jsonrpc":"2.0","id":1,"result":{}}`，然后 stdin 关闭 → 进程 `exit=0`（`process.stdin.on('end')` 里会先 `closeStore()` 再退）。

★ **stdin 一关就退出是设计，不是崩溃**——说明宿主把它当一次性进程用了。判据：有 `result` 且 `exit=0` 就是正常的；非 0 才去读 stderr 里的堆栈。

---

## 七、怎么确认接上了（逐条勾）

- [ ] node 路径存在：`Test-Path "<node 绝对路径>"` → True
- [ ] 脚本路径存在：`Test-Path "D:/AI/agent-soul/src/adapters/mcp.mjs"` → True
- [ ] 手工喂 `initialize` 能拿到 `serverInfo.name = "agent-soul"`
- [ ] 手工喂 `tools/list` 数出 **11** 个工具
- [ ] `soul_health` 回的 `sessions` / `frames` 不是 0（本机 1006 / 159997）
- [ ] `soul_sessions` 能列出会话，且 `cwd` 是本机真实目录
- [ ] `soul_context` 回的「现在：」与系统时钟对得上（本机 2026-11-07 02:29）
- [ ] `soul_file` 搜一个你确定存在的词，返回带 `file:<路径>:<行号>` 的指针
- [ ] 故意传个错工具名，回 `-32601`（证明错误通道是通的，不是假 200）
- [ ] HTTP 腿：`curl.exe -s http://127.0.0.1:7311/mcp` 回 11 个工具名
- [ ] （接宿主时）宿主工具列表里出现 `soul_*` 这一组，且改完 `servers.json` **已重启**
- [ ] （接宿主时）宿主日志里能看到 `[agent-soul] MCP server ready (stdio), 11 tools`

★ 最后一条判据：**「能看到 11 个工具」不等于「能用」。** 真接上的证据是**至少成功调用过一次 `soul_index` 又用 `soul_recall` 把它搜回来**——写入、索引、检索整条链通了，才叫接上。
