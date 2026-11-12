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
   · 下载发布包：[AgentSoul v4 1.0.63](https://github.com/cyanwell/dsh-agent-soul/releases/latest)（双击装，向导会问「新用户还是老用户」）
     - `AgentSoul-Setup-1.0.63.exe` —— 大多数人选这个，双击装
     - `AgentSoul-1.0.63-portable.zip` —— 不想装的人，解压即用（下称 <SOUL>）
     - `AgentSoul-1.0.63-htmlpatch.zip` —— 已有安装，只换界面（129KB）
   · 双击 <SOUL>\AgentSoul.exe 启动
   · 双击 <SOUL>\AgentSoul.exe 启动
   · ★ 必须用**当前用户身份**启动（key 是 DPAPI 密文，SYSTEM 身份解不开）

② 装 DSH 侧的两个插件（缺一不可）

   **两个包已经在本仓库里了**：`plugins/dsh-agent-soul-bridge/` 和 `plugins/dsh-mcp-hub/`
   装法（放哪、加进 bundles、怎么验）见 **`plugins/README.md`**

   · dsh-agent-soul-bridge   控制通道（v4 主动推指令给宿主，caps 含 context）
   · dsh-mcp-hub             MCP 服务托管（ECHO 记忆中枢靠它常驻）

③ 打开 http://127.0.0.1:7310 看界面
```

## B. 你没有 DSH

也能跑，但只有降级模式：它自己起回合、自己有界面、自己有记忆。**没有「对话」可接。**

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

# 能力（数字来自 2026-11-13 实测）

| | 数 |
|---|---|
| **MCP 工具** | **15 个** |
| **控制通道** | **1 条** —— v4 主动推指令给宿主 |
| **界面** | **7 页** —— 星系 / 概览 / 器官 / 回声 / 砚台 / 设置 / 台账 |
| **器官** | autonomy · compaction · context · huanqi · ledger · waker |
| **依赖** | **零第三方**（只用 node 内置） |

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

```bash
node tools/release.mjs --changes="这一版改了什么"
```

它会：打包 → 切版本号 → 重启 core → 自检。

---

# 许可

MIT
