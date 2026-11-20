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

### 2. Node.js（>= 20，内置 `node:sqlite` 需要 22+）

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
    · 下载发布包：[AgentSoul v4 1.0.70](https://github.com/cyanwell/dsh-agent-soul/releases/latest)
      - `AgentSoul-Setup-1.0.70.exe` —— 大多数人选这个，双击装（装到 %LOCALAPPDATA%\Programs\AgentSoul，
        建开始菜单/桌面快捷方式，卸载项进「设置→应用」，**不需要管理员**）
      - `AgentSoul-1.0.70-portable.zip` —— 不想装的人，解压即用（下称 <SOUL>）
      - `AgentSoul-1.0.70-htmlpatch.zip` —— 已有安装，只换界面（199 KB）
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

### 1.0.70（2026-11-20）

- Galaxy：详情面板按选中臂停靠对侧；窄屏改用底部详情面板。
- ECHO：补齐 TEMP tail cursor / open-tail 回归断言；悬空 srcSeq 保持显式统计，不推断、不改写。
- Aurabot：启动协议 selftest 更新为受保护的 direct-main / preflight 结构。
- 验证边界：本版源码未执行生产 ECHO 导入，也未验收 full-core/Aurabot 实机和 bridge 发布。

### 1.0.66

源码历史记录见仓库提交；安装包资产状态以 Release 页面为准。

## 装到自己机器上（本机生产）

```bash
node tools/release.mjs --to=1.0.70 --changes="ECHO / Aurabot / Galaxy updates"
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
tools/publish-release.ps1 -Tag 1.0.70 -NotesFile dist/release-notes-1.0.70.md `
  -Title "AgentSoul v4 1.0.70" `
  -Files @("dist\AgentSoul-Setup-1.0.70.exe","dist\AgentSoul-1.0.70-portable.zip")
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
