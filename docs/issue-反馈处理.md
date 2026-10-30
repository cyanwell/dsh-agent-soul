# GitHub issue 反馈处理结论

> 仓库 `cyanwell/dsh-agent-soul`，5 个 issue。
> ★ 本机只有 SSH key（可推代码），**没有 issue 写权限**（无 `gh` CLI、无 `GITHUB_TOKEN`、无 `.git-credentials`）。
> 所以本文档做两件事：**① 每个 issue 的结论 ② 可直接粘贴的回复文案**。

---

## 速览

| # | 标题 | 作者 | 我们的结论 | 状态 |
|---|---|---|---|---|
| 1 | echo-doctor：外部压缩托管时「门牌回取」「压缩机制」恒报 warn | aslarn | **已修（10-23）**，判据改为识别外部托管 | ✅ 可关闭 |
| 2 | client.js 的 ModuleLoader id ≠ 包名 → duplicate factory registration | aslarn | **已修（10-26）** | ✅ 可关闭 |
| 3 | echo-doctor 的换气判据读 `turn/end.reason.kind` → 恒报 warn | aslarn | **已修（10-25）**，改读换气自己的账本 | ✅ 可关闭 |
| 4 | 客户端插件 id 命名空间导致崩溃**并清空 profile** + install 包名漂移 | yunchengyc | **崩溃已修**；清空是宿主行为，我们能做的是不留无效条目 | ⚠ 部分 |
| 5 | 桌面打包版下 compaction/pruner/huanqi 无法解析 `@deepseek-ai/*` | TaoCultivator | **不是 bug，是安装形态的硬限制**；已补 plan 提示 | ⚠ 部分 |

---

## #1 · echo-doctor 误报（aslarn）

**结论：已修。**

原来的问题：这两项都从日志里数 `compaction/*` 事件。而 `billion-context` 自带一个 gate
（`bili-compaction-gate`），在自身 active 时把 DSH 内置压缩**整行禁用** —— 于是那两个零件压根不跑，
日志里一条 `compaction/*` 都没有，两项恒定 warn。

**修法**（`echo-doctor.mjs`）：新增 `detectExternalCompaction()`，
判据顺序是「显式配置优先于自动探测」：

1. `ECHO_EXTERNAL_COMPACTION` / `echo.config.json` 的 `externalCompaction`：
   `off` → 不认；`auto` 或空 → 自动探测；其它字符串 → 直接当托管者名
2. 自动探测：profile 的 `dsh.profile.bundles` 含 `billion-context`，
   **且** `<profile>/node_modules/billion-context/dist/agent/dsh-compaction-gate.js` 真在盘上

命中时这一项改成 `ok`，并写明「压缩由 X 在代理层托管，门牌这一项不适用于这条链」。

★ **报告作者最要紧的那句被写进代码注释了**：这个误报不只是看着烦，它是一条诱导链 ——
用户看到「压缩没有门牌」→ 以为缺能力 → 去装 `dsh-agent-compaction` →
内置的被 bili 禁了、槽位是空的，于是它**直接注册成功** → 复活了 bili 有意关掉的兜底引擎，
两套上下文管理并存、无法归因。

---

## #2 · client.js 的 id ≠ 包名（aslarn）

**结论：已修（10-26）。**

`__ModuleLoader__.load({ id })` 的 `id` **必须严格等于该插件 `package.json` 的 `name`**。
不等时 client-modules 拿 name 当 key 对注册表、对不上就报
`loaded without registering ... via __ModuleLoader__.load`，
整个 web boot 批次不激活 → 桌面端直接弹「应用无法启动」。

**隐蔽之处**：仓库里 id 与 name 通常各自一致，本地怎么看都对；
错只发生在「把仓库文件拷进一个名字不同的部署目录」那一步。

**修法**：仓库与部署的 name/id 统一成同一组（以实际部署名为准），
并给 `tools/verify-client-ids.mjs` 补了「id == 包名」这一半（原来只查 id 有无重复）。

---

## #3 · 换气判据读错字段（aslarn）

**结论：已修（10-25）。**

原实现去 `turn/end.data.reason.kind` 里找 `/repetitive|loop|no-visible/` ——
而**换气的介入从来不写在那里**。它改的是同一轮内部的流程（continue 续写 / circuitBreak 熔断），
从不会给 `turn/end` 造一个新的 reason kind。
实测这版 DSH 的 kind 只有 `completed / aborted / error` 三种，所以 `everBroke` **恒为 false** ——
只要「有病症」就永久 warn。

★ **最坏的不是噪音**：这一项存在的全部意义是发现「该响的没响」，
而现在它无论响没响都报同一句 —— 等于这一项**没在检查它声称要检查的东西**。

**修法**：判据换成换气自己的账本 ——
读 `<DSH_HOME>/state/dsh-huanqi.json` 的 `stats.{continuations,circuitBreaks,anomalies}`。
没装换气或从没跑过 → 读不到 → `hqFired = 0` → 行为与旧版完全一致。

★ **查找顺序**（后来补的）：`$DSH_HOME/state/` → `SESSIONS` 反推 → `cwd`，
而且**逐个试读**。判据是「能解析出 `stats`」而不是「路径存在」——
路径在、文件坏了的情况会让后面的读取全部抛错。

---

## #4 · 启动崩溃 + 清空 profile（yunchengyc）

**结论：拆成两件事，一件已修、一件是宿主行为。**

| 拆出来的两件 | 结论 |
|---|---|
| **duplicate factory registration → 启动崩溃** | 已修（同 #2） |
| **bundles 被重置、profile 被清空** | 宿主的 `sanitizeProfile` 兜底行为，**不是插件主动干的** |

**但触发器在我们这边**：带着「无效的 bundles 条目」重启，才会走 sanitize。
而这个条件正是「**安装失败后 `plugin_manager` 不回滚**」造成的。

★ **报告人在 #5 里独立观察到了同一件事**，值得单独记：
> 安装失败后 `plugin_manager` 没有回滚：`node_modules` 里留下 dangling 符号链接，
> `bundles` 里也留着条目。带着这个 dangling 条目重启，有概率触发宿主启动失败 →
> `sanitizeProfile` 重置整个 profile。

**我们能做的**：装之前就检测、别让它留下无效条目。
**不能做的**：改宿主的 sanitize 行为 —— 那不在这个仓库。

---

## #5 · 桌面打包版装不上三个零件（TaoCultivator）

**结论：不是 bug，是安装形态的硬限制。已在 `agent_soul_install plan` 里补了提示。**

报告人的根因分析**核对源码后确认成立**。但要拆成两半 —— **三个里有两个有绕路，一个没有**：

| 零件 | 要 import 什么 | 有绕路吗 |
|---|---|---|
| `compaction` | `@deepseek-ai/dsh-compaction`、`dsh-compaction-basic` | ✅ realm 内同 id 换 name（替换内置） |
| `pruner` | `@deepseek-ai/dsh-compaction-tool-result-pruner` | ✅ 同上 |
| **`huanqi`** | `cordis` / `schemastery` / `dsh-llm` / `dsh-compaction` | ❌ **没有** —— 它是新增，不顶掉任何内置条目 |

**原因**：桌面打包版把这些封在 `resources/app.asar` 里 ——
只有 Electron 的加载器能读 asar，而插件的 `import` 走标准 ESM 解析。
从插件真实路径向上找一圈全都不在 ⇒ `ERR_MODULE_NOT_FOUND` 是必然。

★ **报告人拒绝了一条野路子，这个判断是对的**：
把 asar 里的包提取到磁盘、让 import 成功，会让插件拿到**另一个类实例**，
而不是宿主正在用的那一个 —— 正是 README 警告的「两份实现同时生效」。

**我们做了什么**：`install.js` 的 `plan` 输出里，原来只有 `if (s.step === 1)` 提示
compaction/pruner 别走路 A、走路 B；**`huanqi` 在 step 2，从来没被提示过**。
现在补了 `if (s.step === 2 && isDesktop)` 一段，说清三件事：

1. huanqi 没有绕路（不是替换、是新增）
2. 它要 import 哪四个包（已核对 `lib/index.js` 第 176-179 行）
3. 要装它得换一种能解析到内部包的 DSH 安装形态（源码 / CLI）

同时声明**本步其余零件不受影响**（clock / model-statusbar / huanqi-panel 照常装）。

**我们没做的（如实说）**：

- **没能减掉依赖**：`Context`（cordis）和 `createUserMessage`（dsh-llm）在源码里只作类型用，
  本该是 `import type` —— 但仓库和本机都**没有 tsc**，改 `src/index.ts` 会造成 src/lib 不一致。
  **宁可不改，也不留一个编不出来的源。**
- **没验证报告人的建议 2**（用 `createRequire` 从宿主安装根解析）：本机是源码形态，
  **没有打包版环境可测**。没验证的事不写进文档当结论。

---

## 二、可直接粘贴的回复文案

> ★ 本机没有 issue 写权限，所以这里备好文案 —— **粘一下就行**。

### 给 #1（aslarn）

```
已修，感谢这份报告 —— 尤其是「诱导链」那段。

修法：echo-doctor 新增 detectExternalCompaction()，判据顺序是「显式配置优先于自动探测」：
① ECHO_EXTERNAL_COMPACTION / echo.config.json 的 externalCompaction：
   off → 不认；auto 或空 → 自动探测；其它字符串 → 直接当托管者名
② 自动探测：profile 的 dsh.profile.bundles 含 billion-context，
   且 <profile>/node_modules/billion-context/dist/agent/dsh-compaction-gate.js 真在盘上

命中时这一项改成 ok，并写明「压缩由 X 在代理层托管，门牌这一项不适用于这条链」。

你那段「用户看到门牌缺失 → 去装 dsh-agent-compaction → 复活了 bili 有意关掉的兜底引擎」
已经写进代码注释了 —— 那不是噪音，是一条会把人带偏的链。

用文件级启发式而不是 cordis 反射，是因为 doctor 是子进程、读不到 ctx.reflect。
bili 其实把答案挂出来了（ctx.reflect.provide("biliBasicCompactionPolicy", …)），
但那要宿主侧探针去读再落进日志 —— 就是你在方案 B 里提的那条，留作后续。
```

### 给 #2（aslarn）

```
已修。

判据确认：__ModuleLoader__.load({ id }) 的 id 必须严格等于该插件 package.json 的 name。
不等时 client-modules 拿 name 当 key 对注册表、对不上就报
"loaded without registering ... via __ModuleLoader__.load"，
整个 web boot 批次不激活 → 桌面端弹「应用无法启动」。

隐蔽之处正如你指的：仓库里 id 与 name 通常各自一致，本地怎么看都对；
错只发生在「把仓库文件拷进一个名字不同的部署目录」那一步。

修法：仓库与部署的 name/id 统一成同一组（以实际部署名为准），
并给 tools/verify-client-ids.mjs 补了「id == 包名」这一半（原来只查 id 有无重复）。
```

### 给 #3（aslarn）

```
已修，感谢 —— 你指出的是最关键的那点：问题不是噪音，是这一项没在检查它声称要检查的东西。

原实现去 turn/end.data.reason.kind 里找 /repetitive|loop|no-visible/，
而换气的介入从不写在那里（它改的是同一轮内部的流程，不给 turn/end 造新的 reason kind）。
这版 DSH 的 kind 只有 completed / aborted / error 三种，所以 everBroke 恒为 false
→ 只要「有病症」就永久 warn。

修法：判据换成换气自己的账本 —— 读 <DSH_HOME>/state/dsh-huanqi.json 的
stats.{continuations,circuitBreaks,anomalies}。
没装换气或从没跑过 → 读不到 → hqFired = 0 → 行为与旧版完全一致。

★ 你贴的 dsh-huanqi.json 正好把这件事钉死了：continuations 3 / circuitBreaks 7 / anomalies 3，
换气明明在干活，旧判据却一条都看不见。
```

### 给 #4（yunchengyc）

```
感谢，已修正其中一半，另一半需要说清楚归属。

拆成两件事：

① 「duplicate factory registration → 启动崩溃」—— 这是我们的 bug，已修。
   client.js 里 __ModuleLoader__.load({ id }) 的 id 必须严格等于 package.json 的 name。
   错只发生在「把仓库文件拷进一个名字不同的部署目录」那一步，本地怎么看都对。

② 「bundles 被重置、profile 被清空」—— 这是宿主 sanitizeProfile 的兜底行为，
   不是插件主动干的。但触发器在我们这边：带着「无效的 bundles 条目」重启才会走 sanitize，
   而这个条件正是「安装失败后 plugin_manager 不回滚」造成的。

   我们能做的是装之前就检测、别留下无效条目；不能做的是改宿主的 sanitize —— 那不在这个仓库。
   这条会和 #5 一起跟。
```

### 给 #5（TaoCultivator）

```
这份报告的根因分析我核对源码后确认成立 —— 尤其是「只有 Electron 的加载器能读 asar，
而插件的 import 走标准解析」这一句。也谢谢你没有选择解包 asar 那条野路子：
那会让插件拿到另一个类实例，而不是宿主正在用的那一个，正是 README 警告的「两份实现同时生效」。

但要把它拆成两半 —— 三个里有两个有绕路、一个没有：

  compaction  → @deepseek-ai/dsh-compaction、dsh-compaction-basic
                  ✅ 有路：realm 内同 id 换 name（替换内置条目）
  pruner      → @deepseek-ai/dsh-compaction-tool-result-pruner
                  ✅ 同上
  huanqi      → cordis / schemastery / dsh-llm / dsh-compaction
                  ❌ 没有：它是新增的思考预算管理器，不顶掉任何内置条目

我们做的改动：install.js 的 plan 输出里，原来只有 if (s.step === 1) 提示
compaction/pruner 别走路 A、走路 B；huanqi 在 step 2，从来没被提示过。
现在补了 if (s.step === 2 && isDesktop) 一段，说清它没有绕路、要 import 哪四个包、
以及要装它得换一种能解析到内部包的安装形态（源码 / CLI）。
同时声明本步其余零件（clock / model-statusbar / huanqi-panel）不受影响。

关于你的建议 2（createRequire 从宿主安装根解析）—— 方向我认同，
但本机是源码形态、没有打包版环境可测，所以没验证、也没写进文档当结论。
如果你能测，结果贴上来我直接改。

关于你顺带提的宿主问题（安装失败后 plugin_manager 不回滚，留 dangling 条目）——
已记录，这条和 #4 的「清空 profile」是同一个触发器。
```

---

## 三、我自己这边没做到的

- **没法在 issue 页面上回复** —— 本机只有 SSH key（推代码用），
  没有 `gh` CLI、没有 `GITHUB_TOKEN`、没有 `.git-credentials`。
  所有结论落在本文档和代码里，**issue 页面仍是 open**。
- **#5 的建议 2 没验证** —— 没有打包版环境。
