# 装完之后：让 compaction / pruner 真正接管

> 这一页回答一个问题：**为什么我装了压缩插件，兜底压缩还是内置那套？**

---

## ★★ 先看适用范围（2026-10-30 补，GitHub #23）

**这一页的两条路，都只在 `dsh` CLI 形态下成立。**

| 形态 | 能不能用 | 为什么 |
|---|---|---|
| **`dsh` CLI**（依赖装在 `node_modules` 里） | ✅ 能 | `@deepseek-ai/*` 是普通 `node_modules` 依赖，ESM 解析正常 |
| **桌面版**（Electron / `app.asar` 分发） | ❌ **必然失败** | 宿主私有包被打进 `app.asar`，**没有对外解析路径** |

**失败长这样**（不是配置错，是路线错）：

```
Error: Cannot find package '@deepseek-ai/dsh-compaction-basic'
       imported from .../profiles/desktop/node_modules/my-plugin/index.js
```

**为什么偶尔「有人能跑」—— 那是运气，不是机制。**

2026-10-30 在报告人的四条证据之外补了一条实测：

```
profiles/desktop/node_modules/@deepseek-ai/   ← 这台机器上【存在】
  cosmokit  dsh-atomic-write  dsh-client-ui-primitives  dsh-home-paths
  dsh-lsp   dsh-lsp-stdio     dsh-tool-lsp             dsh-util-values
  schemastery
```

**9 个包，没有 `dsh-compaction` / `dsh-compaction-basic`。**

它为什么存在：这个 profile 的 `dependencies` 里**恰好声明了 `@deepseek-ai/dsh-client-ui-primitives`**，
npm 装它时把 8 个传递依赖一起拽了进来。

★ 所以「桌面版能不能 import `@deepseek-ai/*`」的真实答案是：
**取决于那个包有没有恰好被别的依赖拽进 profile 的 `node_modules`。**
`dsh-client-ui-primitives` 被拽进来了，`dsh-compaction-basic` 从来没被拽进来过。

**→ 要顶掉 preset 内置条目的零件（`compaction` / `pruner`），在桌面版上不存在可行路线。
   装不上去不是你的问题，别再试了。** 详见 `#5`、`#23`。

---

## 一句话

**cordis 的服务注册是先到先得。** 谁先注册 `compaction` 这个名字，谁就占住它；
后来的同名 Service **不报错、不警告，就是静默不生效**。

实测（`tools/probe-service-order.mjs`，假 ctx 最小复现）：

```
Builtin → Mine     ⇒ ctx.compaction.who() === "builtin"   ← 先注册的赢
Mine → Builtin     ⇒ ctx.compaction.who() === "mine"      ← 先注册的赢
```

★ 注意：**这条只解释「为什么单独 insert 一个新行不管用」**。
它**不**是说「换实现不可能」——换实现有两条路，见下。

---

## 两条路，选一条

### 路 A · 把本包排到 base 之前（整个 profile 都是你的）

适用于：这个 profile 就是给灵魂用的，不需要保留「标准模式」。

`dsh plugin add` 是往 `bundles` **末尾追加**的，所以装完要手动调一次顺序：

```powershell
$p  = "D:\AI\dsh-demo\profiles\agent-soul-demo\package.json"
$pj = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
$cur = @($pj.dsh.profile.bundles)
$move = @("dsh-agent-compaction", "dsh-agent-pruner")
$rest = $cur | Where-Object { $move -notcontains $_ }
$pj.dsh.profile.bundles = @() + ($move | Where-Object { $cur -contains $_ }) + $rest
[System.IO.File]::WriteAllText($p, ($pj | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
```

★ 写无 BOM：`Set-Content -Encoding UTF8` 在 PowerShell 5.1 里带 BOM，DSH 会 `JSON.parse` 失败。

### ★★ 第二步：把内置的那个禁掉（**这一步不能省**）

**只调顺序不够。** 2026-10-22 在干净沙箱里按上面做完、`--dump-config` 确认顺序也对，
启动仍然报：

```
dsh: warning: 1 entry did not activate
dsh-agent-compaction: Error: service "compaction" has been registered at <BasicCompactionEngine>
```

原因是 `compaction-basic` 仍然**在 bundles 里**、仍然会被加载，而注册是「先到先得」——
排序只能保证谁先谁后，**不能保证后到的那个不注册**。所以要显式禁掉它。

在 profile 的 `cordis.patch.yml` 里追加（没有这个文件就新建）：

```yaml
- id: compaction-basic
  disabled: true
- id: tool-result-pruner
  disabled: true      # 用 pruner 的话同理
```

★ 这是 patch 的**非 insert** 形态：靠 `id` 找到已存在的条目，再覆盖它的字段。
（`insert` 是新增，`id` + 字段是改已有的 —— 两者别混。）

禁掉之后告警消失，运行时探针才读到下面那段。

★ 为什么两步都要做：**排序解决「谁先注册」，禁用解决「后到的那个要不要注册」。**
这是两件事，缺一样都不完整。

重启后 `--dump-config` 应该看到：

```
- id: dsh-agent-compaction
- id: dsh-agent-pruner
- id: compaction-basic        ← 内置的排到后面去了
- id: tool-result-pruner
```

★★ **DSH 尊重手写的 bundles 顺序**（2026-10-18 实测，`--dump-config` 原样保留）。

★★★ **判据不是「顺序看着对」，是这两样同时成立**：

1. 启动日志里**没有** `service "compaction" has been registered` 这条
2. 探针读出下面的运行时身份：

```
ctor:      YanqingCompaction
chain:     ["YanqingCompaction", "BasicCompactionEngine", "CompactionEngine", "Service", "Object"]
overrides: ["compactRegion", "summarize"]
ownKeys:   [..., "__yqRange"]
```

`BasicCompactionEngine` 在**继承链第二层**，不是两个实例并存 ——
也就是说**构造的是我们的类**，内置的只是它的父类。

★ 证据来源要说清（2026-10-22）：
- 上面这段 `ctor` / `chain` 是**本机 2026-10-18** 在 demo profile 上跑出来的；
- 「光排最前仍会报 registered」那一段是**外部验证在干净沙箱（Ubuntu + DSH 0.2.1-rc.2）**里实测的。

两边结果一致，但**达成的条件不同**：本地那次没有记录「有没有报错」，
所以不能据此反推「本地排最前就够了」。**两步都做在两种情形下都安全** ——
内置的如果本来没注册，禁掉它没有副作用；如果注册了，禁掉它是必需的。

### 路 B · preset + isolate（要保留标准模式，只在某个 preset 里换）

适用于：一个 profile 里有多个 preset，只想让其中一个换成你的实现。

**本机验证过这条**（作者机器写在 profile 的 `cordis.patch.yml` 里）：

> ★ **路径按你自己的 profile 走，别照抄。**
> 旧版 DSH 还有一个 `.agent-presets\<名字>\agent.cordis.yml` 的位置 ——
> **那个目录官方已经不再读取了**（原话：Nothing reads that directory any more）。
> 写到那里会**静默不生效**：文件在、YAML 也对、就是没人读。
> 现在写在 `<profile>/cordis.patch.yml`。

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic              # ★ id 保持原名
      name: 'dsh-agent-compaction'    # ★ 只换 name
```

★ **关键在「id 不变、只换 name」**：这一行是**替换**，不是新增 ——
所以整个过程只有一次注册，先到先得根本不会被触发。

★ 而 `isolate` 让这个实例只活在这个 preset 的 realm 里，不和别的 preset 抢名字。
preset 里任何服务行**必须**挂在 `isolate` group 下，否则 `dsh-agent-presets` 在挂载时直接拒。

★ 这条路**没有在沙箱里验过**（沙箱没装 presets，走的是路 A）。机制是从主环境配置读出来的。

---

## 那 patch 是干什么的

`cordis.patch.yml` 让本包**被加载**（`dsh.bundle.patch` 指对了、包能 import）。
它**管不了**谁占住服务名 —— 那是层栈顺序或 realm 的事。

★ 两个是分工，不是二选一：

- `dsh.bundle.patch` → **能不能被加载**
- `bundles` 顺序 / `isolate` realm → **加载之后谁生效**

---

## 怎么验（别再等一次真实压缩）

原来的验法：跑一次兜底压缩，看 checkpoint 前面有没有 `log:<会话>#seq=<n>` 指针块。

**那个验法要 88 万 token 才会触发**，一个空会话造不出来 —— 于是很容易一欠再欠。

**换成直接问它一声。** `tools/soul-probe/` 是个不注册任何服务的探针包：
boot 后 1.2 秒和 5 秒各读一次 `ctx.get('compaction')`，把结果写进日志文件。

```powershell
# 装进 profile
dsh plugin --profile <名字> add "file:<仓库>/tools/soul-probe"
# 重启，然后看探针日志（默认 <tmp>/dsh-soul-probe-compaction.log；可用 SOUL_PROBE_LOG 指定）
```

判读三件事：

| 看什么 | 是 → | 否 → |
|---|---|---|
| `ctor` | `YanqingCompaction` | `BasicCompactionEngine` ＝ 没接管 |
| `chain` 里 base 的位置 | 第二层（继承） | 两个并列 ＝ 有别的实例 |
| `ownKeys` 里有没有 `__yqRange` | 有 ＝ 是我们的类 | 没有 ＝ 不是 |

★★ **这一条比「跑一次压缩」更硬**，因为它回答的是「谁在管」，而不是「这一次产出对不对」。
一次压缩只能证明「这一次走通了」，身份能证明「以后都走这条路」。

★ 还有一个更细的点没验：`summarize` 真被调用时门牌有没有写进产物。
但那已经不是「接管没接管」的问题了 —— 管的是我们的类，`summarize` 就在 `overrides` 里。
