# 桌面端装插件：先分清「新增型」还是「替换型」

> 治的病：**拿到一个插件，不确定它在桌面端能不能装，于是先去 `app.asar` 上撞一圈。**
> 撞完之后得到的结论往往是错的 —— 因为它可能根本不需要碰 asar。

---

## 一句话判据

> **看它注册的服务名，是不是**已经有人用了**。**
>
> - **没人用过** → **新增型** → `insert` 就行，桌面端没问题
> - **有人用着**（`compaction` / `pruner` / `llm` …）→ **替换型** → 要挑对路

---

## 第一步：查它注册什么名字

**插件的 `cordis.patch.yml` 会写：**

```yaml
# 新增型（示例：dsh-huanqi）
- insert:
    - id: huanqi
      name: 'dsh-huanqi'

# 替换型（示例：dsh-agent-compaction）
- set:
    - id: compaction
      config: {...}
```

**再看它的代码里 `ctx.set(...)` / `ctx.provide(...)` 拿的是哪个名字。**

**名字撞不撞，就是分水岭。**

---

## 第二步：按类型走

### A. 新增型 —— `insert` 就行

**装法：**

```powershell
dsh plugin add <包名或路径> --profile desktop
```

**然后 `cordis.patch.yml` 里加一条 `insert`（如果包自带的 patch 没帮你加）。**

**桌面端能不能跑，取决于它的 `@deepseek-ai/*` 依赖从哪来 —— 见下面第三节。**

**★ 这类插件不需要「路 B」，也不该去改 preset。** 它没有要顶掉的东西。

### B. 替换型 —— 要挑对路

**它的目标是把内置的同名服务换掉。** 而 cordis 的规则是**同名先到先得**：

```
Builtin → Mine     ⇒ ctx.compaction.who() === "builtin"   ← 先注册的赢
Mine → Builtin     ⇒ ctx.compaction.who() === "mine"      ← 先注册的赢
```

**后注册的同名服务不报错、不警告、静默不生效。**

**所以替换型有两条路（详见 `plugins/compaction/HOW-TO-TAKEOVER.md`）：**

| 路 | 做法 | 桌面端 |
|---|---|---|
| **路 A** | 把本包排到 base 之前（整个 profile 都是你的） | ⚠️ 看依赖怎么来 |
| **路 B** | preset 的 realm 里 `id` 不变、只换 `name` | ✅ **已实证**（14/14、seq=7371） |

---

## 第三步（最容易被跳过）：`@deepseek-ai/*` 从哪来

**这是「桌面端能不能跑」的真正变量。**

### 先问：这个包自带吗？

```powershell
ls <包目录>/node_modules/@deepseek-ai/
```

**分三种情况：**

| 情况 | 桌面端 | 判据 |
|---|---|---|
| **全自带**（含 `cordis` / `dsh-session` / `dsh-llm` 等） | ✅ 跑得动 | 包里 `node_modules/@deepseek-ai/` 覆盖它 import 的全部 |
| **半数自带 + 几个「宿主提供」** | ✅ **跑得动** | 见下条 |
| **一个都不带，全靠 profile** | ⚠️ **看运气** | 见「为什么看运气」 |

### 「宿主提供」是什么意思

**有些包在代码里明确写：**

```js
// dsh-huanqi/lib/index.js:180
//   它是宿主自带的导出（dsh-compaction/tool-pairing），本包的 dependencies 里没有 ——
//   与 ctx.get('compaction') 同一个前提：运行时由宿主提供。
import { toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction';
```

**这句话的意思是：这个 import 由宿主进程解析，宿主的解析能到 `app.asar` 里。**

**它不缺，也不需要你补。**

★ **判据：看它的注释/文档有没有写「运行时由宿主提供」或「host provides」。**
**写了 → 那几个包不用管；没写、又真的缺 → 才需要看下一节。**

### 为什么「全靠 profile」是看运气

**`dsh-huanqi` 的实测（2026-10-30，本机）：**

```
profiles/desktop/node_modules/@deepseek-ai/   ← 存在，但只有 9 个
  cosmokit  dsh-atomic-write  dsh-client-ui-primitives  dsh-home-paths
  dsh-lsp   dsh-lsp-stdio     dsh-tool-lsp             dsh-util-values
  schemastery
→ 没有 dsh-compaction / dsh-compaction-basic
```

**它为什么存在 9 个？** 因为 profile 的 `dependencies` 里**恰好声明了
`@deepseek-ai/dsh-client-ui-primitives`**，npm 装它时把 8 个传递依赖一起拽了进来。

★ **所以「profile 的 `node_modules` 里有没有某个 `@deepseek-ai/*`」是个偶然事件** ——
取决于别的依赖拽没拽它。

**→ 这条只说明「profile 里不一定有」，不能推出「装不上」。**

---

## 三个不要

| 不要 | 为什么 |
|---|---|
| **不要先去解 `app.asar`** | 绝大多数情况下不需要。先按上面三步判断 |
| **不要因为「profile 的 node_modules 里没有」就判定失败** | 那只是「profile 里没有」，不是「解析不到」 |
| **不要拿一篇文档的结论盖过实测** | 文档可能写宽了（这一页自己就是被更正出来的） |

---

## 一个能救命的验法

**装完先别急着改配置，直接看它加载没有：**

```powershell
# ① 宿主有没有把它写进 bundle
grep "<包名>" <profile>/package.json

# ② 插件自己的日志（如果它写了）
ls <profile>/node_modules/<包名>/  # 看有没有 cordis.patch.yml

# ③ 最关键：它的功能有没有反应
```

**★ 判据：如果它是新增型、`bundles` 里有、功能也有反应 → 就已经好了，别再折腾。**

---

## 实例对照

| 插件 | 类型 | 装法 | 桌面端 |
|---|---|---|---|
| **`dsh-huanqi`** | **新增型**（`huanqi` 是新名字） | `insert` | ✅ **实测在跑**（2026-10-31 触发压缩成功） |
| **`dsh-agent-compaction`** | **替换型**（顶 `compaction`） | 路 B | ✅ 已实证 |
| **`dsh-agent-pruner`** | **替换型**（顶同名的裁剪服务） | 路 B | ✅ 已实证 |

---

*2026-10-31 · 砚青*
