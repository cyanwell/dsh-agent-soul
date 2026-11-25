# agent-soul

从 DSH 解耦出来的**灵魂层运行时**。会话 / 事件 / 记忆 / 人格，自带，任何 harness 都能接。

> ## ⚠️ 先看分支
> 
> | 分支 | 是什么 | 状态 |
> |---|---|---|
> | **`v4`** | **当前主线** —— 独立进程 / 独立界面 / 独立存储 | **活跃开发，看这个** |
> | `main` | v3 历史 —— 插件形态，寄生在 DSH 里 | 不再维护 |
> 
> **`git clone` 默认落在 `main`，那是旧代码。** 请先 `git checkout v4`。
> 
> v4 与 v3 不兼容 —— 不是升级，是换了一个东西。

---

# ★★★ 安装前请读完这一节（不读完不许安装）

## 一、它依赖什么

### 1. 内嵌 LLM（**核心功能依赖，不是可选**）

```
没有 LLM，它仍然能：收原文、建索引、记承诺、判该不该动（这些是纯计算）。
没有 LLM，它做不了：换气诊断（找上下文污染点）、记忆语义检索、任何需要判断的器官。
```

**你必须配一个 API key。** 默认走 DeepSeek 官方：

```
配置项：config.json 的 llm 段
  protocol   openai
  model      deepseek-chat
  baseUrl    https://api.deepseek.com
  apiKeyRef  dpapi:deepseek-official   （推荐，走本机 DPAPI 加密）
             或者 env:DEEPSEEK_API_KEY（环境变量）
             或者直接写 apiKey（明文，不建议）
```

★ **key 怎么填**：装好后打开 `设置` 页，`模型接入` 那一组填「API Key」，点保存。
  它会原子写盘（`.tmp` → rename）并读回来给你看。

★ **怎么验它真的能用**：`GET /api/health` 看两个字段 ——

```json
{ "llmReady": true,   // key 解得开（配置层）
  "llmUsable": true,  // **最近一次真实调用成功**（能力层）
  "llmLastError": null }
```

★★ **只看 `llmReady` 会被骗**：它只证明 key 在，不证明账户有钱。
  `llmUsable: false` + `llmLastError` 带 `402 Insufficient Balance` = 余额不足。

### 2. Node.js（>= 22.23.4 或 24.x，`node:sqlite` 的 FTS5 是 22.23.4 才进的）

本机实测用的是 v24。**没有任何第三方 npm 依赖** —— 只用 node 内置模块。

### 3. 宿主（可选，但强烈建议）

```
没有宿主：它自己起回合（降级模式），能跑，但没有「对话」可接。
有宿主：  宿主负责回合，它负责记得。★ 这才是设计意图。
```

目前**唯一**对接过的宿主是 DeepSeek Harness（DSH）。对接方式是 `dsh-agent-soul-bridge` 插件：
它连 `ws://127.0.0.1:7310/control`，自报能力，接指令，回执。

---

# 安装

## A. 你有 DSH 宿主（推荐）

```
① 装 agent-soul 本体
    · GitHub最新正式Release仍为 1.0.87；1.0.102仅v4 tag已推，无Release附件。1.0.107为待发布v4 MCP认证hotfix。
      正式版附件可从GitHub Release下载；本机留存同版本构建产物。
      - `AgentSoul-Setup-1.0.107.exe` —— 本地hotfix候选安装器
      - `AgentSoul-1.0.107-portable.zip` —— 本地hotfix候选便携包
      - `AgentSoul-1.0.107-htmlpatch.zip` —— 本地hotfix候选界面补丁
    · ★ 卸载**不会**删你的 `config.json`（含 API Key）与 `data\`（会话/索引/账本）—— 它们留在原位，要彻底清干净自己删这两个。
    · 双击 <SOUL>\AgentSoul.exe 启动
    · ★ 必须用**当前用户身份**启动（key 是 DPAPI 密文，SYSTEM 身份解不开）
    · 启动后会**在后台查一次有没有新版本**（每 24 小时最多一次）。有就弹窗给你看更新说明，
      **只提示，不下载也不安装**——下载装不装由你决定。关掉那个窗口后同一版本不再提示。
      不想让它查：设环境变量 `AGENT_SOUL_NO_UPDATE_CHECK=1`。

② 装 DSH 侧的两个插件（缺一不可）

   **两个包已经在本仓库里了**：`plugins/dsh-agent-soul-bridge/` 和 `plugins/dsh-mcp-hub/`
   装法（放哪、加进 bundles、怎么验）见 **`plugins/README.md`**

   · dsh-agent-soul-bridge   控制通道（v4 主动推指令给宿主，caps 含 context）
   · dsh-mcp-hub             MCP 服务托管（ECHO 记忆中枢靠它常驻）

③ 打开 http://127.0.0.1:7310 看界面
```

## B. 你没有 DSH

也能跑，但只有降级模式：它自己起回合、自己有界面、自己有记忆。**没有「对话」可接。**

## 怎么启动

```bat
app\<版本>\tools\start-soul.cmd     :: 起 core（会先注入 OneBot token，再启动界面）
```

★ **必须用它启动，不要直接双击 `AgentSoul.exe`。** 那个 `.cmd` 做了一件事：
从 `D:\AI\SnowLuma\config\onebot_3937956599.json` 读 OneBot 的 `accessToken`，
塞进 `SOUL_ONEBOT_WS_TOKEN` 环境变量 —— 少了它，core 能起、界面能开，但 **QQ 那条线连不上**。

### ★ 这个脚本曾经一直是坏的（2026-11-18 修好，写在这里免得以后重踩）

坏掉的那行读 token 的 `for /f`，三个错叠在一起：

| 错 | 症状 |
|---|---|
| `in (powershell ...)` 少了**反引号** | `for /f` 把整个括号当文件名读，不是执行命令 |
| PowerShell 里用了 `$Get-Content` / `$ob.networks` | **`$` 在 cmd 里会被当变量吃掉**，变成 `=Get-Content` / `.networks` |
| 两条语句用 `;` 分隔 | PowerShell 收到的是残破表达式 |

结果 `for /f` 一个字也取不到 → 脚本走到 `if not defined SOUL_ONEBOT_WS_TOKEN` →
**`exit /b 1`，连 `AgentSoul.exe` 都没启动**。

`start-with-onebot.cmd` 里写法基本对（有反引号、直接取 `.networks`），但**管道写成了 `^|`** ——
`^` 在双引号内**不是转义符**，会原样传给 PowerShell，报
`positional parameter cannot be found that accepts argument '^'`。所以它也是坏的。

**正确写法**（两个文件都已改成这个）：

```bat
for /f "usebackq delims=" %%a in (`powershell -NoProfile -Command "(Get-Content '%CFG%' -Raw | ConvertFrom-Json).networks.wsServers[0].accessToken"`) do set "SOUL_ONEBOT_WS_TOKEN=%%a"
```

要点：`usebackq` + **反引号** = 执行命令；双引号内用**纯 `|`**（不加 `^`）；
用 `(Get-Content ...).networks` **直接取属性**，不经过 `$` 变量。

★ 另一个坑：**从 DSH 会话里用 `Start-Process` 起的 AgentSoul 会随回合被收割。**
  要它活过这一轮，用 WMI：

```powershell
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = 'cmd.exe /c ""<绝对路径>\start-soul.cmd""'; CurrentDirectory = '<根目录>' }
```

  `cmd.exe /c ""...""` 这层**双引号包法**是必需的 —— 路径带空格时少一层就解析错。

### 验证起来了没有（三条判据）

```powershell
Get-Process AgentSoul                       # 进程在，MainWindowTitle = 'AgentSoul — 就绪'
Get-NetTCPConnection -LocalPort 7310 -State Listen   # HTTP 面板在听
Invoke-WebRequest http://127.0.0.1:7310/ -UseBasicParsing   # 200 且返回页面
```

★ QQ 通路是**另一条线**：`3002`（OneBot HTTP）/ `3003`（OneBot WS）由 **SnowLuma** 提供，
  不是 AgentSoul 自己监听的。这两个端口没在听 = SnowLuma 没跑，
  AgentSoul 界面里会显示「没连上网关」。
---

# ★★★ 两段装配提示词（复制给你的宿主会话）

> 用法：装好 agent-soul 本体后，**把下面第一段整段复制给你的 DSH 会话**。
> 它会自己装插件、自己接线、自己验证。**你不用手动改任何配置文件。**

## 第一段 · 新用户（从零装配）

````text
帮我装配 agent-soul v4。它是一个独立运行的灵魂层服务，现在跑在 http://127.0.0.1:7310。

你要做四件事，每件都要给出**可核对的证据**，不要只说「好了」：

【① 装两个 DSH 插件】
这两个是必需的，缺一个 v4 就连不上宿主：
  · dsh-agent-soul-bridge —— 控制通道（v4 主动推指令给宿主）
  · dsh-mcp-hub           —— MCP 服务托管（ECHO 记忆中枢靠它常驻）

安装方式：在 DSH 的 profile package.json 的 dsh.profile.bundles 里加这两个包名，
然后 pnpm install。装完**必须重启 DSH**（插件不会热加载）。

★ 判据：重启后 GET http://127.0.0.1:7310/api/health 里，
  sessions 应该等于你的会话数，llmReady 应该是 true。
  GET http://127.0.0.1:7310/api/session 里应该看到 host=dsh 且 caps 含 'context'。

【①b 建索引库 —— **漏了这步，检索一定 503**】
  node tools/db-sync.mjs

★ 干净的数据目录里**没有 meta.sqlite**，而它只有这个脚本会建。
  不建 → /api/search 恒 503 → 而 README 别处写着「索引在写入时产生」，
  于是会被误读成「索引机制坏了」。**实际是"建库的那只手"没被叫到。**
★ 判据：`<dataDir>/meta.sqlite` 存在且大于 0 字节；
  然后（**不重启**）`GET /api/search?q=test` 不再 503。

【② 配 API key】
打开 http://127.0.0.1:7310/settings，在「模型接入」里填 DeepSeek 的 API Key，保存。
★ 判据：/api/health 的 llmUsable 变成 true（注意不是 llmReady —— 那个只证明 key 在）。

【③ 让我能被 v4 找到】
v4 的自主循环要能解析「当前主导是谁」。它读的是 D:\AI\yanqing-soul\02-墨.jsonl 里
最后一条 type=lead 的署名。如果那个文件不存在，就去 http://127.0.0.1:7310/settings
把 autonomy 段的 targetSession 填成你当前会话的 id（形如 session-xxxxxxxx-...）。
★ 判据：GET http://127.0.0.1:7310/api/autonomy 的 resolved 应该是 true。

【④ 报告】
给我一张表：每一项做了什么、怎么验的、验出来什么。失败的那一项写清卡在哪。
````

## 第二段 · 老用户（从 v3 迁移到 v4）

````text
我要从 agent-soul v3（插件形态）迁移到 v4（独立进程）。v4 已经跑在 http://127.0.0.1:7310。

★ 原则：**先让 v4 完整跑起来，再逐步关掉 v3。不要反过来。**
因为 v3 是你现在唯一的记忆层，关早了就什么都没了。

【阶段一 · 让 v4 接上（此时两个都开着）】
① 装 dsh-agent-soul-bridge 和 dsh-mcp-hub 两个插件，重启 DSH
② 配 API key（设置页 → 模型接入），确认 /api/health 的 llmUsable=true
③ 确认 /api/autonomy 的 resolved=true（v4 能解析到当前主导）
④ 让 v4 先跑几天，观察记忆能不能检索到（/api/echo 或 soul_search 工具）

【阶段二 · 逐项对比，确认 v4 真的接住了】
对每一项 v3 的能力，在 v4 里找到对应物并实测：

  v3 能力              → v4 对应物
  ─────────────────────────────────────
  记忆检索（echo）      → soul_search / soul_recall 工具
  换气（thinking guard）→ 三档判据 + /api/huanqi/auto（自动巡视）
  记忆压缩              → soul_compact（但索引已与压缩解绑）
  心跳 / 自主            → autonomy（60 秒 tick + 账本兜底）
  台账 / 唤醒            → /waker 页 + soul_waker
  器官面板              → /organs 页

★ 每一项都要**实测出结果**，不能凭「看起来有」就过。

【阶段三 · 逐步禁用 v3（一次一个，每次重启验证）】
按这个顺序关，因为后面的依赖前面的：

  ① dsh-huanqi           （换气）—— 先确认 v4 的 /api/huanqi/auto 能扫到你
  ② dsh-yanqing-pruner   （修剪）—— 先确认 v4 的 context/purge 能清
  ③ dsh-yanqing-echo     （记忆）—— 先确认 soul_search 能检索到今天的帧
  ④ dsh-yanqing-heartbeat（心跳）—— 先确认 /api/autonomy 的 leadSource 是 ledger:last-lead

★ 每关一个：从 bundles 里移除 → 重启 → 再验一次 v4 对应功能没坏 → 才关下一个。
★ 任何一步 v4 的功能坏了，就**把它加回 bundles**，停下来查原因，不要硬往下走。

【最后】
给我一份迁移报告：每项 v3 能力、v4 对应物、实测结果、什么时间关的。
````

---

# 能力（数字来自 2026-11-18 实测）

| | 数 |
|---|---|
| **MCP 工具** | **34 个** —— 26 个 `soul_*` + 8 个 `qq_*` |
| **ECHO 检索** | **5 个工具** —— 词面 / 长文本语义 / 句子窗口语义 / 指针回取 / 状态 |
| **控制通道** | **1 条** —— v4 主动推指令给宿主 |
| **界面** | **7 页** —— 星系 / 概览 / 器官 / 回声 / 砚台 / 设置 / 台账 |
| **器官** | autonomy · compaction · context · huanqi · ledger · waker |
| **依赖** | **零第三方**（只用 node 内置） |

## ECHO 检索：两套向量，回答两个不同的问题

索引分四层，**每层回答一个问题**。前两层是词面，后两层是语义。

| 层 | 表 | 一条是什么 | 回答的问题 |
|---|---|---|---|
| FTS5 词面 | `echo_words_fts` | 一行原文 | **哪些字面上有这个词** |
| 摘要 | `echo_summaries` + 源 seq | 一段压缩摘要 | 哪一段是**同一件事的概述** |
| 向量 · 长文本 | `echo_word_vectors` | **一个词一条向量** | **哪一段在讲这件事** |
| 向量 · 句子窗口 | `echo_word_windows` | **一个 ~192 字窗口一条向量** | **哪一句真的说了这件事** |

★ 为什么要两套：长文本向量能告诉你「这一段相关」，但**它不知道是哪一句相关的**。
  窗口层把每段切成 ~192 字的窗口各自成向量 —— 命中后直接返回**字符区间**
  （`charStart` / `charEnd`），拿到就能把原句摘出来给人看。

**模型**：`BAAI/bge-small-zh-v1.5`，512 维，q8 量化，**本地跑**（不调外部 API，不花钱）。
  默认走 **DirectML（显卡）**，起不来时**响亮回退 CPU**（日志里写 `device=cpu(回退…)`，不静默）。
  实测批处理吞吐 dml **53.0 ms/条** vs cpu 339.3 ms/条 ≈ **6.4×**。
  模型文件放在 `models/bge-small-zh/`，随载荷发。首次加载约 20 秒。
  ★ 设备差异不影响向量同一性：cpu 与 dml 的余弦实测 0.99938~0.99955（浮点噪声），
    所以 `model_key` 里**不含 device** —— 换显卡不必重算。

**去重**：同一段文本在 N 个位置出现，**embedding 只算一次**，但位置每个仍各存一份
  （检索要能回到每一处原文）。实测窗口层重复率 **38.37%**（211,640 个窗口里 130,441 个唯一文本）。

**两套模型各有一个 `model_key`**：它是整个预处理规格的 sha256。读写两侧必须逐字节一致，
  否则查到的永远是 0 条 —— 这是本项目踩过最贵的一个坑（读写两侧的 `preprocessSpec` 差了一个字段）。

```
soul_echo_search         词面 + 摘要，AND 语义，原文子串核实
soul_echo_semantic_search 向量（长文本层）—— 问「哪一段在讲这件事」
soul_echo_window_search  向量（句子窗口层）—— 问「哪一句真的说了这件事」，回字符区间
soul_echo_open           指针 → 原文（log: / v4log: / idx: / file:）
soul_echo_stats          索引状态 + 各来源游标 + FTS 计数对齐
```

★ **索引与原文的计数一旦对不上就显式报错**（`ECHO_INDEX_STALE`），
  绝不返回一份「少命中的结果」冒充正常。

### 检索有多快（2026-11-18 实测，本机 21.1 万窗口 / 5.5 万词）

| 路径 | 改前 | 改后（热） | 新进程首查 |
|---|---|---|---|
| 句子窗口语义检索 | 10.2 ~ 12.1 s | **291 ~ 353 ms** | **597 ms** |
| 长文本语义检索 | ~10.4 s | **189 ~ 247 ms** | **366 ms** |
| 词面 FTS 检索 | 0.1 ~ 6 ms | 未变 | 未变 |

★ **慢的不是磁盘，也不是算力**：把 211,640 条 / 413 MB 向量从 SQLite 读出来要 **7,408 ms**，
  而裸读同一个 413 MB 文件只要 **394 ms**。差别全在 `node:sqlite` 逐行构造 JS 对象、
  每个 BLOB 再包一个 `Uint8Array` —— **21 万次分配**。点积本身只要 308 ms。
  （`mmap_size` / `cache_size` 都实测过，**无效**，甚至更慢。）

所以做的是「不要重复搬同一份数据」，不是「少算」：

1. **向量矩阵常驻内存**（窗口层 413 MB + 词层 107 MB 连续 Float32Array）。
   检索时零 IO，只剩点积 + 部分选择（Top-10 全排序 274 ms → 部分插入 **5 ms**）。
2. **二进制快照**（`data/vector-cache/`，约 530 MB）：把矩阵摊成连续内存顺序读写，
   冷启动 8.6 s → **0.6 s**。它是加速层，**不是真相来源** —— 头部带指纹
   （向量行数 + MAX(word_ord) + 词表指纹），对不上就丢弃回库重建；
   截断/乱码一律拒用。要省这 530 MB 就设 `AGENT_SOUL_ECHO_VECTOR_SNAPSHOT=off`。
3. **不放松护栏，只挪位置**：凡是**交给调用方的结果**，返回前必然核对过当前原文
   （词层 0.62 ms / 窗口层 8.15 ms），漂移就抛 `ECHO_VECTOR_STALE`；
   全量校验放在建矩阵时做。要「每次全量校验」的老行为，设
   `AGENT_SOUL_ECHO_VECTOR_STRICT=1`。

| 开关 | 作用 |
|---|---|
| `AGENT_SOUL_ECHO_VECTOR_STRICT=1` | 完全不用缓存，每次回库并全量校验（最慢，最保险） |
| `AGENT_SOUL_ECHO_VECTOR_CACHE=off` | 关掉内存矩阵（每次回库建） |
| `AGENT_SOUL_ECHO_VECTOR_SNAPSHOT=off` | 关掉二进制快照（省 530 MB，冷启动慢回 8.6 s） |
| `AGENT_SOUL_ECHO_VECTOR_CACHE_TTL_MS` | 指纹复核间隔，默认 3000（0 = 每次都复核） |

## 三个根本设计

1. **索引在写入时产生** —— 写一帧，同时写一条索引。压缩不再是索引的前提。
2. **会话是裸 JSONL** —— `frames.jsonl` + `index.jsonl`，不压缩、可读、可 grep。
3. **工具守卫是单调的** —— 只允许否决，不提供 allow。

★ 第 1 条推出一个结论：**如果原文永远在、永远可查，压缩就不需要「门牌」了。**
  门牌是补丁，补的是「原文会丢」这个缺陷。

---

# 目录结构

```
src/
  index.mjs          入口（起 core、界面、控制通道）
  agent/             换气判据（process-guard / decl-window / huanqi-intervene）
  organs/            器官（autonomy / compaction / context / huanqi / ledger / waker / lead-target）
  adapters/          宿主适配（host-sessions / context-http / host-scan-http / waker-http）
  web/               界面（7 页 HTML + server.mjs）
  db/                meta.sqlite（会话帧索引 + FTS5）
  session/           会话存储（frames.jsonl）
tools/
  release.mjs        发布（打包 + 切换 + 重启）
  db-sync.mjs        索引增量同步
data/
  sessions/          会话帧
  config 等状态文件
```

---

# 界面

| 页 | 地址 | 作用 |
|---|---|---|
| **星系** | `/lumen` | **唯一的状态总览** —— 三水位 / 六层 / 人格层 / 会话容器 / 待答 |
| 概览 | `/dashboard` | 投递 / 事件 |
| 器官 | `/organs` | 六层明细（可展开）|
| 回声 | `/echo` | 索引体检 |
| 砚台 | `/yantai` | 账本 / 未结 |
| 设置 | `/settings` | 配置（含参数统计）|
| 台账 | `/waker` | 唤醒四视图 |

★ `/sphere` 和 `/params` 已并入上表，旧地址 302 重定向。

---

# 发布

## 更新记录

### 1.0.107 v4 hotfix（2026-11-25，待正式发布）

- 修复AgentSoul MCP proxy token错位：以前MCP在模块导入时缓存token，并在多个猜测root里找文件；source MCP实际dataDir与生产Core不同，且Core可在MCP启动后生成token，导致 /mcp 外层401。现每次forward按有效config.dataDir读取token，缺失/短值时不回退其它root。
- 本机DSH MCP Hub AgentSoul server的AGENT_SOUL_DATA已指向Core有效dataDir；爀曦手动重启DSH后，soul_health成功，soul_waker state返回本地台账视图，soul_ask_host空参到达输入校验且未派发动作（不再401）。
- 验证：299/299通过、Core shell marker selftest通过；新增fake HTTP测试覆盖source config路径与AGENT_SOUL_DATA分叉、MCP先启动/token后创建及token轮换，header与期望匹配；无生产token或真实数据进入断言/日志。
- 验证：299/299通过，Core Shell marker selftest PASS；每实例OneBot 3003连接数1，owner=Core events ingress，ingress=connected。运行态汇总：received=1901、forwarded=1227、Aurabot.sent=261、outbox.sent=387、errors=7、duplicateEventParts=0（outbox最近64条关联环形记录；不宣称重启后全历史零重复）。旧端到端复核中最近20/20关联记录有效、duplicateRows=0。
- 验收：soul_waker state返回本地Core台账，直接/api/waker total=0/badge=0；无真实ingest写入。soul_ask_host空参探针到达参数校验、不触发host动作。
- 独立ECHO MCP stats/recall/search成功；限量search total=15、shown=1、583ms。Core echoLive enabled=false/running=false；authority-view sourceAvailable=true、aligned=true、sourceRows=1、issue=null；v4派生索引工具仍报ECHO_INDEX_MISSING，按目标保持disabled/not-imported，不重建。
- Aurabot配置round-trip由`test/aurabot-config-roundtrip.test.mjs`覆盖；huanqi旧quota文案由`test/huanqi-legacy-quota-label.test.mjs`覆盖。运行态mood判定为关键词模式（judgeStatus disabled）；贴纸caption状态为unavailable，reason=Core LLM未配置或未就绪，未假报可用。
- 遗留：SnowLuma consent=unknown、attach fail-closed；installer E2E因现有安装/进程拒绝覆盖；没有发生破坏性安装测试。1.0.102 tag已推v4但GitHub Release未创建，本次目标tag为v4/1.0.107。

### 1.0.102 v4 tag（GitHub Release未创建）

- Hub explicit correlation完成：fresh flush传newTurn，pushToSession按调用前running状态区分当前与pending turn；event_id以显式参数穿过session turn/end和每个bubble send。阶段计数仅提供policyDenied/muted/groupNoReply/hookHandled/enqueued/assistantReplyTurns/sendAttempts，不记录消息正文或QQ/chat ID。
- 验证：全量297/297、Shell marker selftest和syntax checks通过；Hub fake集成覆盖fresh merge flush和两轮current/pending eventId归属（第一轮只含A、下一轮只含B）、per-bubble OneBot call opts；policy-denied仅增聚合计数且不泄漏身份。生产trace另见下项。
- 生产运行态：Core health=true、owner=Core ingress、3003单socket。真实回复链有22条correlation记录；状态视图返回的最近20条均含格式正确的eventIds/sessionHash/partIndex和非空messageId；`duplicateEventParts=0`、`duplicateRows=0`，最近20条`repeatEventSessionPartKeys=0`。阶段聚合：received=202、envelopes=114、forwarded=118、groupNoReply=60、enqueued=56、assistantReplyTurns=28、sendAttempts=23、Aurabot.sent=23、errors=0。未读取或记录QQ身份及消息正文。
- 遗留项：SnowLuma agreements API仍Unauthorized、consent unknown，autoAttach配置true但实际attach fail-closed；安装E2E preflight exit 2检测到现有AgentSoul注册项/快捷方式/进程后拒绝，未覆盖生产。
- 1.0.87旧tag位于origin/main；本次1.0.102正式tag发布到v4分支，不改写旧tag。

### 1.0.87（2026-11-24）

- Aurabot 已知 OneBot 写操作全部22项经 AgentSoul Core 共享 outbox；module facade 的保护态（disabled/dryRun）下，22项known write拒绝、19项read放行、unknown/custom拒绝；live unknown仍兼容透传。
- `dsh-agent-soul-bridge` 0.1.16 修复 `workspaceRegistry.archivedSessionIds` 字符串数组被错误投影的问题；源码、随包副本及 desktop profile 安装副本已同步。**DSH 宿主半需重启才加载；本次没有重启DSH，当前进程仍可能使用旧版。**
- 单聊 `/reset` 先 await归档和map落盘，再清除内存映射；失败路径不误报成功。`resetChat` API为 `Promise<boolean>`。
- 验证：AgentSoul 全量 261/261；bridge wire 6/6、bridge selftest 43/43、packaging smoke/shape/client preflight均通过；发布包verify结果另见本次release输出。测试均为fake/离线，未执行真实QQ/Qzone写操作。
- 尚未完成：DSH手动重启与运行态bridge核验；真实archive回执对账、session self-heal、生产must→reply；读取路径和host/api.lib旁路收敛。

### 工作区未发布变更（2026-11-24；历史记录，当前已由1.0.87发布）

- Aurabot OneBot client wrapper 仅将22个action路由到AgentSoul Core共享outbox：`send_group_msg`、`send_private_msg`、`send_poke`、`set_input_status`、`modify_custom_face`、`delete_custom_face`、`set_self_longnick`、`set_qq_profile`、`set_qq_avatar`、`add_custom_face`、`set_friend_add_request`、`set_doubt_friends_add_request`、`delete_qzone_msg`、`upload_group_file`、`upload_private_file`、`set_group_special_title`、`_send_group_notice`、send_qzone_msg、comment_qzone、set_group_ban、set_group_kick、like_qzone；Hub或module caller落到这些名称都会走outbox。默认和managed模式为`off`，这22项fail-closed且无旧client回退。已知write action无剩余；未知/custom action及read action仍可能走旧client。普通 `sendSegments` 先走 capture，再受总开关与 dryRun 控制；主人命令的 `force:true` 回复会跳过这两项，但仍受 capture 与 Core mode gate 约束。`pokeBack` 有自己的 enabled/dryRun 判断。
- `events.egress.mode` 必须显式为 `onebot-http` 才允许 outbox 写入；默认与 managed 模式均为 `off`。部署前需确认 HTTP URL、tokenEnv 对应的环境变量和 Aurabot 接收端属于同一网关/账号。
- 兼容保留 OneBot 30 秒默认超时、`status: "ok"` 成功回执；poke 错误只计一次且 `close()` 可中止在途请求。已知写action已全部迁入（3 send/poke + 19 act）；Aurabot源码盘点有28个显式只读callsite（module facade 13、host/chat内部直gateway 14、共享get_image helper 1），adapter另有4个固定read；这些路径未统一到Core capability，未知/custom action仍走动态入口。十九个`act()`动作不做摘要幂等、无自动重试、data原样返回、请求参数不进入日志/视图。
- Aurabot 出站适配层第二片：除上面三个发送动作外，再把 5 个**只改自身资料 / 状态**的动作改道到 Core outbox 的严格名单方法 `act()` —— `set_input_status` / `modify_custom_face` / `delete_custom_face` / `set_self_longnick` / `set_qq_profile`。该片完成时 `act()` 白名单为 5 个名字；第三片末尾追加头像与新增收藏表情后为 7 个（第四片完成时为 9 个；第五片后为 10 个；第六片后为 12 个；第七片后为 14 个；第八片后为 15 个；第九片后当时为 16 个；第十一片后当前为 19 个），**没有通用 `call(action, params)` 通道**；不套消息摘要幂等（同一动作重复执行即重复请求）、不自动重试、默认超时 30000ms（与 OneBot client 同值）、失败返回 `{ok:false}` 不抛、`close()` 可中止在途请求；成功返回网关 `data` 原件。动作参数（昵称 / 签名 / 表情备注）不进日志与视图。该片完成时群管理、上传、Qzone与全部读动作仍走旧client（历史状态；后续切片见下）。
- Aurabot 出站适配层第三片（2026-11-24）：在第二片的 5 个资料动作之上**只**再加 2 个 —— `set_qq_avatar`（换机器人自己的头像）与 `add_custom_face`（往自己的收藏表情库里加一张）。判据与第二片同一条：只动机器自己的资料 / 表情库，不动群、不动别人、不传群文件。上传 / 群管理 / 群公告 / 好友申请 / Qzone 当时仍原样走旧 client（好友申请两个名字已在第四片迁走，见下条），`act()` 仍然**没有**通用 `call(action, params)` 通道。两条契约按原样保住：`set_qq_avatar` 的 `file` 三种既有形态（`base64://…` / 本机临时文件路径 / http(s) 网址）**逐字进请求体**，不归一不裁剪；`add_custom_face` 成功时把网关的 `data` 原件交回（`stickers.js` 靠 `data.emoji_id` 继续写备注、记本地库）。两者同样不做摘要幂等、不自动重试、`mode` 非 `onebot-http` 时 fail-closed 且不回落旧 client；`enabled` / `dryRun` 两道闸仍在上游（模块 facade 与 hub，本层不复制判据）。
- 离线 focused `outbox-mode-gate + aurabot-outbox-gateway + qzone-delete-guard`：outbox-mode-gate 71/71、aurabot-outbox-gateway 79/79、qzone-delete-guard 18/18、hub-onebot-guard 11/11、group-admin-role-safety 6/6、`module-onebot-policy` 24/24；全量 `test/*.test.mjs`：255/255 通过（含 `test/contacts-friend-request.test.mjs`：9 条及 `test/qzone-delete-guard.test.mjs`：18 条，钉住上游 contacts 模块的权限 / dryRun / 成功清理 / **失败路径不清 pending** 契约）；隔离的 loopback `tools/outbox-selftest.mjs`：59/59 通过（临时根 + 127.0.0.1 绑定 + 不读部署配置的三条护栏原样保留）。session-reset-route fake registrar 2/2、Hub saveMap failure fake 1/1、single-chat /reset async ordering 5/5；未访问真实网关、未读取生产配置、未部署或重启 Core。
- Aurabot 出站适配层第四片（2026-11-24）：在第三片的 7 个自身动作之上**只**再加 2 个 —— `set_friend_add_request`（通过 / 拒绝**收到的那条**好友申请）与 `set_doubt_friends_add_request`（处理被 QQ 过滤的「可能认识的人」那条）。判据在这里必须改写：前七个只动机器自己的资料 / 状态 / 表情库，不涉及第二个人；这两个动的是**机器人和另一个人的关系**，所以判据写成「只动机器人自己这一侧」（自己的资料 / 表情库 / 好友列表），不碰任何群、不碰第三方、不替别人拍板。上游 `contacts` 模块**一行未改**：`profileToolVisible` / `profilePermits` 的权限三档、仅主人私聊、`allOwner`、`dryRun`、事件 flag 的来源与缓存、成功后只清理 `friend-requests.json` 里的那一条 —— 全在模块里，本层不复制判据。两条契约按原样保住：`{ flag, approve }` 作为**同一个对象**逐字交出（`flag` 是网关签发的凭据，连 `trim` 都不套；`approve` 保持布尔，不压成 0/1 或字符串），`opts.timeoutMs = 15000`（`contacts/index.js` 那两处显式给的值）原样到出站口。`act()` 侧同样不套摘要幂等（同一条申请连点两次 = 两次请求，第二次由网关判「已处理」）、不自动重试、`mode` 非 `onebot-http` 时不发且不回落旧 client，`flag` / `approve` 不进日志 / 视图 / 记录。第四片完成时剩余10个写动作（历史状态）：上传2、群管理与群公告4、Qzone 4。

- Aurabot 出站适配层第五片（2026-11-24）：只把自有Qzone说说撤回动作 `delete_qzone_msg` 追加进Core outbox；不迁发送 / 评论 / 点赞。保留 `qzone.remove()` 的tid非空、enabled与dryRun上游门；只有请求成功resolve后才在本地history写对应 `deletedAt`，出站失败时不写且不回落旧client。删除不挂摘要幂等、不自动重试；fake测试验证失败前后 `diary.json` 完全不变、成功只标目标tid。



- Aurabot 出站适配层第六片（2026-11-24）：仅将 `upload_group_file` / `upload_private_file` 这一对明确授权的上传动作追加到Core outbox；文件上传不是“自身动作”，它们作为用户授权例外列在白名单中，不顺带迁群管理或Qzone公开互动。`hub.js` 未改：`sendFile` 仍保留 `files.enabled`、目标、绝对路径/存在/普通文件/允许目录/maxBytes、capture、全局 enabled/dryRun；每次传输 `timeoutMs=120000`。本机路径失败且大小≤min(30MB,maxMB)时由Hub调用方自行发一次 `base64://` 回落，外部URL和超限文件不回落；outbox本身无重试、无摘要去重，路径/base64/文件名不进日志/view/records。Hub fake测试覆盖两次调用和门控；module facade只有全局enabled/dryRun写门，不继承Hub文件目录/maxMB校验（当前源码无模块上传调用点）；未上传真实QQ文件、未读取生产配置、未部署/重启。

- Aurabot 出站适配层第七片（2026-11-24）：用户单独授权后，仅追加群专属头衔 `set_group_special_title` 与群公告 `_send_group_notice`；禁言/解禁 `set_group_ban`、踢人 `set_group_kick` 仍保留旧client，Qzone发帖/评论/点赞也未迁。role fresh查询失败不复用旧缓存，fresh与非fresh inflight分开；group-admin五动作要求主人本轮、群白名单及明确owner/admin角色，角色未知一律拒绝，群主专属头衔仍只允许owner。focused与全量结果见上行；hub.js未改，未执行真实群操作或部署。

- Aurabot 出站适配层第七片（2026-11-24）：在严格名单末尾只追加`set_group_special_title`与`_send_group_notice`，这是用户明确授权的群作用域例外，不顺带放行禁言/踢人或Qzone公开互动。改头衔/发公告仍要求主人本轮、群白名单、fresh角色明确为owner/admin及非dryRun；角色查询失败、未知role不复用旧缓存并fail-closed，管理员不能改群主专属头衔。禁言/解禁、踢人和Qzone发帖/评论/点赞仍走旧client。测试：group-admin-role-safety 5/5、mode-gate 71/71、gateway 79/79、全量228/228、isolated selftest 55/55；未触真实群操作、未读生产配置、未部署或重启。

- Aurabot出站适配层第八片（2026-11-24）：仅迁移本人空间说说发布`send_qzone_msg`，不迁评论/点赞。严格名单18总动作（3 send/poke +15 act），余4写动作（ban/kick/comment/like）。`qzone.post`原样保留受众规则（单次仅可收窄为self）、图片单项8MiB上限、图片读取后重读配置并重新解析受众、60秒timeout与tid回执；dryRun仍模拟成功但不外发。mode-off拒绝且不回落旧client。验证：focused 166/166、全量232/232、isolated selftest 56/56；未访问真实Qzone/QQ、未读生产配置、未部署/重启。

- Aurabot出站适配层第十片（2026-11-24，当时状态）：仅迁移空间评论`comment_qzone`；like与群ban/kick仍旧client。`sendComment`的disabled在调用前拒绝，dryRun仅模拟返回true；live仅发一次`{tid,content,target_uin?}`，timeoutMs=30000且无幂等键。mode-off拒绝、不回退client。验证：focused 170/170、全量233/233、隔离selftest 58/58；未做真实Qzone评论、未读生产配置、未部署/重启。

- Aurabot 出站适配层第十一片（2026-11-24）：按爀曦授权迁移最后三个已知写action：`set_group_ban` / `set_group_kick` / `like_qzone`。保留group-admin的主人轮次、群白名单、fresh role、owner保护、dryRun门；Qzone只在已有feed筛选、like开关与全局enabled、非dryRun下点赞。最终严格名单22总（3 send/poke + 19 ACT），已知写action剩余0；未知/custom action和reads仍可能直达旧client。focused 179/179、全量239/239、隔离selftest 59/59、语法10/10；全部fake/loopback测试，无真实QQ/Qzone动作、未读生产配置、未部署或重启Core。

- Session recovery bridge source fix（2026-11-24）：`workspaceRegistry.archivedSessionIds`原为string[]，被service `toWire`按Workspace实体project，传至v4变成null项，导致`archivedSessionIds.includes(sessionId)`永不命中。源码仓新增`projectMethods`，仅对list/create/get/resolveByPath投影；6条wire tests覆盖字符串数组、实体、void archive及allowlist。bridge相关离线套件49/49通过，`node --check index.js`通过。**仅D:/AI/dsh-tools/dsh-agent-soul-bridge源码已修**；已安装副本`D:/AI/agent-soul/plugins/dsh-agent-soul-bridge/index.js`仍旧、未同步，未重启DSH；运行中的57251实际加载版本尚未确认。

- 单聊 `/reset` 归档竞态修复（2026-11-24）：`hub.resetChat` 改为等待archiveSession成功后才写sessions map，并在保存成功后解除live映射；archive拒绝或saveMap失败会保留映射。`commands.js` await后按成功/无映射/失败返回准确消息，不泄露session id与错误原文。新增5条fake测试覆盖pending、reject、缺service、success、save failure。API.md更新为`Promise<boolean>`。单聊focused 26/26、全量245/245；未做真实归档、未部署或重启。

- 单聊 `/reset` 归档顺序修复（2026-11-24）：`hub.resetChat` 现在返回 `Promise<boolean>`；先 await archiveSession，archive拒绝时保留磁盘与live映射；归档成功后写入map副本，写盘成功才解除内存映射。`commands.js` 等待结果：成功才确认重开；无映射说明无会话；归档失败与“归档已完成但map写失败”分别给准确消息，均不泄露session id/error。新增5条fake测试覆盖pending/reject/missing/success/save failure。reset focused 26/26、全量245/245、语法3/3；未触真实archive、未部署/重启。

- 模块 OneBot facade 策略收紧（2026-11-24，未部署）：`src/aurabot/src/core/module-onebot-policy.mjs` 从「只挡已知写」改成**写 / 读 / 未分类**三类分开判，并且写名单不再抄第二份字面量 —— `MODULE_ONEBOT_WRITE_ACTIONS` 直接取 `OUTBOX_PORT.actions`（`src/adapters/outbox.mjs`，3 send/poke + 19 act = 22 个），顺序即出站口顺序（新增名字仍只追加在末尾）。新增冻结的 `MODULE_ONEBOT_READ_ACTIONS`（19 个，每一条都在本仓有字面调用点）。判法：已知写在总开关关闭或 `dryRun=true` 时照旧拒绝（`onebot-write-blocked`、`reason: disabled | dry-run`）；**已登记读在这两种模式下照常放行**（只读动作不产生出站写）；**未分类 action 在关闭 / 试运行下同样拒绝**（同一错误码、`reason: unclassified`、stage `policy`，message 提示「确认是只读就逐字登记，不按前缀猜」）；**live 模式下未分类仍原样透传**（兼容性保留：第三方网关 / 自建 facade 的动作名盘不全，不把「没盘到」变成「突然不能用」，但这仍不是完整 capability allowlist）；空串 / 纯空白动作名在所有模式下一律 `onebot-action-invalid`。闸判顺序不变：已知写与未分类先撞 policy 闸、再轮到 `onebot-unavailable`；读动作不看总开关，但 client 缺失时仍报 `onebot-unavailable`；查表用 trim 后的名字、传给下游的 action 原样。离线盘点（13 个 facade 可达文件）：35 个字面 `onebot.call` 调用点 = **21 写 + 14 读**（与上一版盘点一致：13 个直接 + 1 个经共享 `segmentBytes` → `get_image`），无动态动作名（三处动态入口只在 host 侧 `hub.js`，不进这道闸）；`MODULE_ONEBOT_READ_ACTIONS` 里 11 个今天真的走 facade，另外 8 个目前只在 host / hub 侧调用 —— 仍登记，因为名单按动作名而非 callsite，`API.md` 本身就教模块作者用 `api.onebot('get_msg', ...)`。文档同步：`src/aurabot/src/modules/API.md`（`api.onebot` 表项、facade 说明、`api.core.onebot` 行）。验证：`module-onebot-policy` 14 → 24（新增 10 条：canonical 顺序、读名单、读在 dryRun 放行、padded 读、未分类拒绝、live 未分类透传、缺 client、config 抛错 fail-closed、空动作名、静态 callsite 盘点）、`contacts-friend-request` 9/9、`qzone-social-run-guard` 5/5、`group-admin-role-safety` 6/6、`qzone-delete-guard` 18/18、`hub-onebot-guard` 11/11、`outbox-mode-gate` 71/71、`aurabot-outbox-gateway` 79/79、`node --check` 2/2，全量 `test/*.test.mjs` **255/255**；全部 fake，未访问真实网关 / 未读生产配置 / 未部署 / 未重启。

### 1.0.86（2026-11-23）

- ECHO liveness health 不再同步打开或扫描 MetaStore；详细 authority-view 每次请求打开只读快照并在回执后关闭，打开失败明确回 `503 ECHO_STORE_UNAVAILABLE`。
- MCP 复用有界的只读 MetaStore reader；每个连接缓存 exact ECHO alignment proof。先执行真实 `SELECT` 固定 SQLite 读快照，再采样 `data_version`；proof validation 与 search 在同一 snapshot 内完成，外部 commit 后由 version 变化触发重验。Core shutdown 在 HTTP drain/超时之后关闭 pooled readers。生产只读探针（3 次同连接测试）：首次 exact validation + source-scoped query 5.46–8.60 秒；proof 热后的重复查询 2–4 毫秒；pointer open 2–6 毫秒且正文校验通过。每次均为 2 hits / 3 scanned。数据来自切换前已打开的旧本机库；计时样本不是在安装后的 1.0.86 Core 进程中采集。
- 常见的 source-scoped query 已有全局验证 proof 时可复用全库 proof；全局 proof 未缓存或外部 commit 后改变时仍重验，漂移继续 fail-closed。
- pointer open 改为读取来源身份元数据，不再为回取基础词/摘要行统计巨型 FTS 表。生产只读探针在缓存热后 pointer open 约 2–6 毫秒；TEMP regression 覆盖 FTS 漂移时仍可回取存在的基础行。
- session ID 接受宿主转义的 `~`，source ID 字符规则不变；batch builder、MetaStore 与 shadow importer 均有 TEMP 覆盖。
- JSONL byte parser 恢复错误优先级：非法 UTF-8 先于缺少 final LF 报告。
- portable packager 在任何 staging 清理之前拒绝 `data/`、token/config/env 文件及根/嵌套 symlink；6 个合成夹具通过。
- 已在本机生产目录启动并验证 Core 1.0.86：`/api/health` 返回 `ok=true`、`llmUsable=true`。本机 OneBot ingress 当前为 `RECONNECT_GAVE_UP`（不代表 Core 整体不可用；DSH control host 已连接），OneBot 事件流需要单独恢复。

> 生产性能计时是本机只读 probe，不能外推为所有安装环境保证；首次 exact validation 受 FTS 表大小影响，热 proof 查询显著更快。
>
> 发布备注（2026-11-23）：origin 当前 tags 列至 1.0.78，未列出 1.0.79–1.0.83；本地按 `src/tools/sql` 载荷路径与时间窗口比对 377 个可达提交及 3 个不可达提交，未找到这些部署 payload 的精确 Git commit；近似提交不作为 provenance 证明。旧版本构建时的外部 CI/ref 记录未取得。


### 1.0.80（2026-11-22）

**把 1.0.78 锁死的 aurabot 面板救回来 —— 判据从「带 token」换成「同源」。**

#### 病

1.0.78 我把 `/aurabot/api/*` 纳入鉴权（写面确实该挡），结果面板当场坏：

    「画板读不到插件：读不到插件状态。」

原因：那块面板的 JS 是 aurabot 自带的 `client.js`（260KB，第三方代码），
取数是 `fetch(API + p, { cache: 'no-store' })` —— **裸 fetch，不带任何 header**。

★ 而 `auth.mjs` 第 15 行那条判据「页面同源注入，前端拦截器自动带上」**只对 v4 自己的页面成立**，
对搬进来的第三方前端**不成立** —— 我不会去改那 260KB。

**这是我漏验的一步**：我验了「/aurabot 页面能拿到 token」，
没验「面板实际发出的请求带不带 token」。**拿到变量 ≠ 用上变量。**

#### 修法：换判据，不是降级

问一句：**这个口要挡的是什么？** 是「浏览器里随便一个网页发个请求就能操作我的插件」。
那正好是 CSRF，而 CSRF 的特征是**跨站**。

| 请求 | 判据 | 结果 |
|---|---|---|
| 裸 curl（无头） | 要 token | **401** |
| `Sec-Fetch-Site: same-origin` | 同源 | **200** |
| `Referer: http://127.0.0.1:7310/aurabot` | 同源 | **200** |
| `Sec-Fetch-Site: cross-site` | 跨站 | **401** |
| 外站 Referer | 跨站 | **401** |
| 带 `x-soul-token` | 凭证 | **200** |

★ `Sec-Fetch-Site` 由**浏览器自己填**，跨站请求一定是 `cross-site`/`same-site`，拿不到 `same-origin`。
★ 两道都认（也看 `Referer`）—— 有的环境不发 `Sec-Fetch-Site`，
  **面板再坏一次的代价比多写几行大得多**。
★ 本机脚本（curl / .mjs）**照旧要 token** —— 它们才是真需要凭证的调用方。
  伪造这些头需要有在本机执行的能力，而那时他本来就能读 `token.txt`。**边界没松。**

#### 配套

`needsAuth(pathname, method)` → `needsAuth(pathname, method, req)`（3 个调用点全部传入 req）。

### 1.0.79（2026-11-22）

**`mcp-proxy` 读 token 的候选路径全指错了地方 —— 而错路径上正好躺着一个 0 字节的假文件，把失败伪装成"读过了"。**

#### 病（第一版修错的地方）

1.0.78 我给 `mcp-proxy` 加了 `HUB_TOKEN`（它转发 `/mcp` 时带上 `x-soul-token`），
三个候选目录写的是 `cfg.dataDir` / `appRoot()/data` / `ROOT/data`。

**但这三个在本进程里解析出来是同一个路径** ——
`mcp-proxy.mjs` 住在 `<生产根>/app/<版本>/src/adapters/`，
所以 `appRoot()` 和 `ROOT` **都指向 `<生产根>/app/<版本>`**，而真正的 token 在**上一级**（`<生产根>/data/`）。

更坑的是：那个错路径上**真有一个 `token.txt`，只是 0 字节**。
`readFileSync().trim()` 得到 `''`，`if (t)` 判空跳过 → 循环走完 → 返回 `''` → 请求不带 header → **401**。
**日志上看不出任何异常，它"读过"了。**

#### 判据（两条，都是这次长的）

1. **路径候选列表里不许出现「三个写法指向同一个目录」的假多样性。**
   写候选之前先问：这三个真会落到不同地方吗？用 `path.resolve` 打出来看一眼。
2. **「文件存在但内容为空」必须当成没读到**，不能当成读到了一个空 token。
   这次靠 `t.length >= 16` 拦住。

#### 实测

| 路径 | 结果 |
|---|---|
| `<生产根>/app/1.0.78/data/token.txt` | ✗ 存在，**len=0**（陷阱） |
| `<生产根>/data/token.txt` | ✓ len=32 |

模拟 MCP 转发（`POST /mcp`）：

| | 结果 |
|---|---|
| 不带 token | **401** |
| 带 token | **200**，14,384 字节（真实 tools/list） |

### 1.0.78（2026-11-22）

**补一个被"另一个洞"掩护了很久的洞：`/aurabot` 的 token。**

#### 洞的形状

`/aurabot` 页面的 `window.__SOUL_TOKEN` **永远是 undefined**：
token 注入原来**只写在首页那个分支里**（`p === '/'`），
而 `PAGE_OF` 那条通用分支（`/aurabot`、`/organs`、`/yantai`、`/diary`、`/params` …）
**全是裸 readFileSync 就发出去**。

于是这个洞一直被**另一个洞**掩护着：
- 页面不带 token（因为没注入）
- 接口不要 token（因为 `/api/aurabot` 与 `/aurabot/api/*` 都不在 GUARDED 里）

**两边看起来都正常，合起来就什么都看不出来。**

#### 修法（两处必须一起，顺序不能反）

1. **先让页面真拿到 token**：把注入收成一个 `injectPage()` + `PAGE_INJECT`，
   在**所有 HTML 出口**用上（首页 + PAGE_OF 全部）。
   ★ 判据：**注入不是某个页面的特权，是所有 HTML 出口的共同义务。**
   写成每一处各贴一遍，就一定会漏 —— 而漏掉的那处不报错，只静默地不带 token。
2. **再把接口纳入鉴权**：`/api/aurabot`（状态聚合）与 `/aurabot/api/*`（模块动态路由：
   stickers / voice/* / memory/* …）**两套都加**。

★ **一个洞不能用另一个洞来兜。**
★ 顺序：**先注入再鉴权** —— 反了页面会先坏。

#### 实测（1.0.78）

| 接口 | 无 token | 有 token |
|---|---|---|
| /api/aurabot | **401** | 200 |
| /aurabot/api/status | **401** | 200 |
| /aurabot/api/state | **401** | 200 |
| /aurabot/api/config | **401** | 200 |

页面注入：`/aurabot` `/waker` `/settings` `/organs` `/yantai` `/diary` **全部拿到 token**
（在此之前，除了首页和 settings/yantai/organs 之外都是裸的）。

### 1.0.75（2026-11-22）

**这一版对着下游的两份实装反馈修，并顺手补了两个「断言滞后于代码」。**

#### 一、鉴权缺口（可致 apiKey 外流）—— 报告里最严重的一份

下游实测：`POST /api/config` **不带 token 就 200，且真的写盘**（`written:true` + 新 mtime），
能重写 `llm.apiKey` / `llm.baseUrl` / `port` / `dataDir`；
而服务端**不校验 Origin** → **浏览器里任意网页发个 `text/plain` 简单请求就能打中**
（不触发预检，CORS 都挡不住）。

**根因：闸长在内层，路由所有权在外层。**
这个项目有**两层 request 处理**：内层 `server.mjs`（mcpHandler → 鉴权 → 只读闸 → UI 路由），
外层 `core-entry.mjs`（shutdown/search/huanqi/echo/aurabot/context…，最后才转发给内层）。
**执行顺序是「外层 → 内层」—— 外层接走的路由，内层的鉴权永远看不到。**

- **治根**：在 `core-entry.mjs` 的 listener **最前面**判一次 `needsAuth`（`outerAuthGate`）。
  判据只有一份、位置只有一处、**新增外层路由自动被覆盖**。
- **兜底**：`auth.mjs` 的 `GUARDED` 补全 —— `POST /api/config`、`/api/huanqi`（`context/purge` 不可逆）、
  `/mcp`（`soul_index` 写帧 / `soul_cleanup`）、`/api/waker`（`decide` 是写判定）。
  两层都判，漏一层还有另一层。
- **★ 配套：三个页面的 token 一起补**（不然会得到「接口安全了、面板废了」）：
  · `aurabot.html:107` 读的是 `window.__SOUL_TOKEN__`（**双下划线**），而 `:859` 注入的是 `__SOUL_TOKEN` ——
    **上游拼写错误**，一直靠"接口不鉴权"掩盖着；**「注入 token」≠「页面会用」**。
  · `waker.html` 的 `api()` 从来没带过 token。
  · `settings.html` 保存配置没带 token。

#### 二、账本只读态（P14）

下游需要「一手历史档案不许被机器追加」的部署形态，而 `LedgerBase` **只有「能写」和「调用方自己保证不写」两种状态**。
唯一可行做法是改 `write()` 的**方法体** —— 侵入式、升级每次重打，而且**污染测试信号**
（自检红了分不清是上游回归还是下游改的）。

- `LedgerBase` 新增 `opts.readonly`（**默认 false，零破坏**）；`write()` 在最前面短路
  （**先于任何参数校验** —— 只读的语义是「一个字都不许落」，连"参数不合格"都不该走到分支里，
  否则会让人以为「改改参数就能写」）。
- 返回 `code: 'LEDGER_AUTH_REQUIRED'`，与下游改方法体时用的那个一致 —— **他们的调用方代码不用改**。
- `readonly: true` 时**连 `degradeFile` 都不建** —— "降级记录"本身也是一次写。
- 配置层 `config.ledger.readonly`（默认 `false`）；`mcp-tools` 与 `yantai/panel` 两处实例化都传下去。
  （否则「config 配了 readonly、面板却还能写」是比没配更坏的一种假象。）

#### 三、两个「断言滞后于代码」

- `ledger-dualwrite-selftest` 有两条断言测的是「非当前主导写 lead 要被拒」——
  **而那个闸门 2026-11-21 已按爀曦要求移除**（它会锁死换届：换届恰恰是新容器写的）。
  断言跟不上代码，就会把正确的改动判成回归。已改成测「`ref` 仍必填」+「换届不再被代码拦」。
- `yantai-selftest` 的 nav 断言还在找 `/params` —— **那个地址 2026-11-13 已 302 合并进 `/settings`**。

#### 四、顺手

- `server.mjs` 注入 `window.__SOUL_VERSION`，5 个页面（dashboard / organs / params / settings / yantai）
  nav 里写死的 `v0.1.0` 改成读它。**只改启动横幅改不到这里。**

#### 验证

| 项 | 结果 |
|---|---|
| `ledger-dualwrite-selftest` | **29/29**（原 28 通过 / 2 失败） |
| `yantai-selftest` | **82/82**（原 81 通过 / 1 失败） |
| `meta-store-selftest` | **66/66** |
| `guard-http-selftest` | **6/6** |
| `verify-ledger-readonly.mjs`（新增） | **全通过**（默认能写 / 只读拒绝 / 连旁路都不落） |
| `src` 全量语法扫 | 0 失败 |

### 1.0.74（2026-11-21）

**这一版对着 1.0.73 的点评与维护清单逐条修。** 八条里五条是「在别人机器上永远看不出来」的那一类。

- **hook 从没有执行位（第四次）**：`.githooks/pre-commit` 一直是 `100644` →
  真 key 提交能成功，只留一行 `hint: ...not set as executable`。
  已 `git update-index --chmod=+x` → `100755`。
  ★ 前四次没修好，是因为**每次都在改规则，而坏的是文件模式**。
- **`make-dist` 只能在你的硬盘上跑**：`DEV`/`PROD` 写死 `D:/AI/agent-soul` 与桌面。
  现在 `DEV = process.cwd()`、`PROD = process.env.AGENT_SOUL_PROD || process.cwd()`。
- **`verify-setup` 只改了一半**：文件名动态了，但 `D:/AI/agent-soul/dist/` 那段路径原样留着 ——
  换台机器照样跑不了。现在版本与 dist 路径都由 `path.resolve(__dirname, '..')` 拼。
  ★ 判据：**「改成动态」要连路径一起想，只改一半等于没改。**
- **七项迁移自检假红**：六处写死版本链（`'2,3,...,11'` / `length === 10` / 「恰好六个索引」）。
  schema 到 v13 就红，而**迁移本身从来没坏过**（T23/T24 一直绿）。
  现在用 `assertChainFrom(applied, from)` 与「某些东西必须都在」表达不变量。
  **66/66。**
  ★ 病根一句话：**「恰好 N 个」把"当前状态"当成了"不变量"。**
  ★ 我第一版把 T34 两条断言合成一条，报错只显示 `got 12`，看不出是哪半挂 —— **一条断言只测一件事。**
- **`guard-http` 被鉴权打哑（第四轮）**：1/6，全是 401。
  现在**真读 token**：候选全列出来各发一次探针，用第一个非 401 的；一个都过不了 → `UNREACHABLE` + exit 1。
  **6/6。**
  ★ 为什么不能按路径读：dev 仓库的 `data/token.txt` 与正在跑的服务**不是同一个**
  （实测：生产 token → 400，dev token → 401）。**"路径对"无法自证，只有服务认了才算数。**
  ★ 子会话第一版写的是 `if (!process.env.GUARD_TOKEN) process.exit(0)` ——
  **那是把门关掉，让 1/6 变成"跳过"。跳过不是通过，是把红灯涂成绿灯。**
- **`echo` / `aurabot` / `host-scan` / `host-sessions` 的 D 盘路径**：不再用 `|| 'D:/AI/...'` 兜底。
  未配置 → 直接回 `unconfigured`，**不 spawn、不 `path.join(null, ...)` 抛 TypeError、不把本机路径报给用户**。
  ★ 与哨兵同一条判据：未配置就是未配置，不假装健康。
- **启动横幅版本号**：写死 `v0.1.0`（package.json 是 1.0.73，差整条版本线）。现在顶层读一次 package.json。
- **首启不建库**：干净目录没有 `meta.sqlite`，而它只有 `db-sync.mjs` 会建 → 检索恒 503。
  README「第一段 · 新用户」补上【①b 建索引库】和它的判据。
- **检索 503 不复位**：`search-http.mjs` 的 `storeErr` 一旦置位就不再重试。
  现在加 `fs.existsSync(dbPath)` 探测 —— 库一出现就清掉错误，不必重启进程。
- **17 个一次性脚本进仓库**：`git rm` 掉 74 个（含 `_verify` 下的探针），
  `.gitignore` 加 `/_*.mjs`。
  ★ **前导斜杠是关键**：报告建议写 `_*.mjs`，但那会连 `plugins/*/_verify/` 里的 33 个真测试一起忽略。

### 1.0.73（2026-11-21）

**这一版几乎全是「修我自己写错的判据」。** 每一条的症状都是「看起来成功了」。

- **面板 403**：`configured: !!(token && origin)` 而 `localAdminToken` 默认空串 →
  端点从设计上就调不通；写操作还要一个只活在内存里的 CSRF nonce，panel 拿不到。
  附带 client.js 那句「所有端点只接 GET」本身是错的（status/probe 是 GET，另三个是 POST）。
- **同源 GET 不带 Origin**：浏览器同源 GET 不发 Origin 头，而判据要求「Origin 必须逐字等于本实例」
  → panel 自己的请求也被挡。现在缺省视为同源，存在则严格匹配。
- **`health.control.hostCount` 恒 0**：`hub.snapshot()` 返回**数组**，我按 `snap.hosts` 读。
  字段名猜错不报错，只会永远给 0。
- **state 白名单漏字段**：`stateVia`/`fallback` 发出去又被 `snapshot` 的白名单丢掉 ——
  而 hub.mjs 的注释早就写着「新字段不加进来，等于发出去又被丢掉」。
- **pruner 三处**：`context/candidates` 在事件库里挑而 pruner 在 surface 里剪（两套判据）；
  回执丢诊断字段（`framesAffected=0` 分不出「真没东西」和「挑错 seq」）；
  适配器**静默吞掉 `dryRun`**（写 `dryRun:true` 以为只解析，实际真动刀）。
- **窗口模糊**：DPI 声明进 PE 的 `RT_MANIFEST`（`true/PM` + `PerMonitorV2` + `longPathAware`），
  实测 `GetProcessDpiAwareness` = 2。
- **安装器三 bug**：`HasFlag("/D=")` 恒假（显式目录被当成没指定、原地升级覆盖）；
  卸载按镜像名全杀（**把生产在跑的 AgentSoul 杀了**，改成按 `MainModule.FileName` 过滤）；
  `verify-setup.mjs` 硬编码 1.0.65（`--verify` 验的是一年前的包还报 PASS + 假绿灯）。
- **桥**：`agent/pre-step` 钩子按会话上报（真机读 `stateVia=agent/pre-step`、`fallback=false`）；
  补 `dsh.client` 声明（client.js 装了三个月从未加载）。
- 验证：桥全套 **90/90**、packaging smoke PASS、`index.js --selftest` 11/11、v4 selftest 9/0。
- **已知限制**：pruner 的「真剪掉 ≥1 帧」尚未在真机复现；
  lead SQL store schema v5 vs 代码要 v13（`MIGRATION_REQUIRED`）未处理。

### 1.0.70（2026-11-20）

- Galaxy：详情面板按选中臂停靠对侧；窄屏改用底部详情面板。
- ECHO：补齐 TEMP tail cursor / open-tail 回归断言；悬空 srcSeq 保持显式统计，不推断、不改写。
- Aurabot：启动协议 selftest 更新为受保护的 direct-main / preflight 结构。
- 验证边界：本版源码未执行生产 ECHO 导入，也未验收 full-core/Aurabot 实机和 bridge 发布。

### 1.0.66

源码历史记录见仓库提交；安装包资产状态以 Release 页面为准。

## 装到自己机器上（本机生产）

```bash
node tools/release.mjs --to=1.0.78 --changes="鉴权缺口 + 账本只读 + aurabot 补洞"
```

它会：把 `src/` `tools/` `sql/` `seed/` 复制成 `app/<版本>/` → 写 VERSION.txt → **逐文件校验**
→ 切 `current.txt`。校验不过会自己把 `current.txt` 回滚到上一个版本。

## 产出给人下载的包

```bash
node tools/make-dist.mjs            # 构建 + 自检
node tools/make-dist.mjs --verify   # 构建 + 跑「安装→运行→卸载」端到端验证
```

会产出三个文件（都在 `dist/`）：

| 文件 | 是什么 |
|---|---|
| `AgentSoul-<ver>-portable.zip` | 解压即用：壳 + `runtime/node.exe` + `models/`（向量模型）+ `app/<ver>` + config + workspace（约 91 MB —— 其中 55 MB 是向量模型） |
| `AgentSoul-Setup-<ver>.exe` | 安装器：装到 `%LOCALAPPDATA%\Programs\AgentSoul`，建开始菜单/桌面快捷方式，写**不需要管理员**的卸载项 |
| `AgentSoul-<ver>-htmlpatch.zip` | 只换界面（22 个 `.html/.css/.js`，约 200 KB）—— 已有安装、只想换皮肤时用 |

★ **载荷来源是「生产 app/<ver>」**，不是 `dist/AgentSoul/app/` —— 后者是残缺的旧目录。
  所以顺序是：先 `release.mjs` 部署，再 `make-dist.mjs` 打包。

★ 安装器**不删你的数据**：卸载时只清程序文件，`config.json`（含 API Key）与 `data`
  （会话/索引/账本）留在原地，并明确告诉你它们在哪。要彻底清干净自己删这两个即可。

★ 要发到 GitHub：

```bash
tools/publish-release.ps1 -Tag 1.0.78 -NotesFile dist/release-notes-1.0.78.md `
  -Title "AgentSoul v4 1.0.78" `
  -Files @("dist\AgentSoul-Setup-1.0.78.exe","dist\AgentSoul-1.0.78-portable.zip")
```

★ `-Replace` 是**先删同名旧附件再传新的**。默认行为是「同名就跳过」——
  2026-11-18 踩过：09:44 传的 36 MB 包是坏的（缺向量模型与 seed），修好后重跑这个脚本，
  它把三个附件全跳过了，远端还是那份坏的。要覆盖必须显式 `-Replace`（它只删同名附件）。

★ 这个脚本是 **UTF-8 with BOM**。PowerShell 5.1 按 ANSI 读无 BOM 的 UTF-8，含中文的
  脚本会乱码并整段解析失败（`Unexpected token` 之类）。改它记得保留 BOM。

## 自检与验证工具

```
tools/run-all-selftests.mjs     跑全部 *-selftest.mjs（独立进程 + 单条超时 + 进度落 summary.json）
tools/rescan-selftests.mjs      重扫日志、只按断言文本判红（**不信 exit code**）
tools/verify-six-layers.mjs     装包 → 跑 bootstrapDataRoot → 逐层核对 L0–L5 真的建出来了
tools/verify-embed-in-pkg.mjs   装包 → 用装好的 node+模型真跑一次 embedding（不是「文件在」）
tools/verify-setup.mjs          安装 → 运行 → 卸载 全链路
tools/verify-portable.mjs       解压 → 启动 → HTTP 响应
tools/verify-echo-perf.mjs      检索性能基准（含新旧实现逐条比对）
tools/verify-payload.mjs        载荷与 dev 源逐文件一致（release.mjs 内部调用）
```

★ 分成两类，别混：

| 前缀 | 谁能跑 | 进 run-all 吗 |
|---|---|---|
| `*-selftest.mjs` | 任何环境 | 是 |
| `verify-*` | 要真生产数据 / 要真装包 | 否（手动跑；装包那三个会往 `%TEMP%` 装一份再卸掉） |

★ `verify-*` 存在的理由：这一版踩的坑全是「文件在 ≠ 能用」——
  模型差一层路径、seed 差一个 PARTS 条目，两个都不报错。
  所以验证必须问「装上之后能不能用」，不能只问「文件在不在」。

---

# 许可

MIT
