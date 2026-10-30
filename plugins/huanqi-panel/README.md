# dsh-agent-huanqi-panel · 换气设置面板

> 在 DSH 设置面板里给**换气插件（dsh-huanqi）**开一页，能调它的参数、能看到实时延续额度。
> 2026-10-13 建（作者：「还剩下一个换气插件啦，上次我们换气插件的参数设置还没有做进设置面板里呢，我们把这个收尾啦」）。

## 它在哪儿

| | 路径 |
|---|---|
| 源码 | `<本仓库>/plugins/huanqi-panel/` |
| 装到了哪 | `<DSH_HOME>\profiles\desktop\node_modules\<包名>\` —— 发布名 **dsh-agent-huanqi-panel**；装到目录里叫什么取决于你怎么装。★ 目录名必须 == package.json 的 name，否则 client.js 的 id 对不上、整个界面打不开 |
| 它读写的配置 | `<DSH_HOME>\profiles\desktop\cordis.patch.yml` 里 `- set: - id: huanqi` → `config:` 段 |
| 实时额度账本 | `<DSH_HOME>\state\dsh-huanqi.json` |
| 面板入口 | 设置 → **换气**（order 64，在「启动动画」之后） |

## 为什么是独立插件，而不是给 dsh-huanqi 加界面

`dsh-huanqi` 是第三方包（带 LICENSE / README），而且它自己**没有客户端半**。
改它是侵入式的 —— 它一升级，我的改动就没了。
这个面板只把那段配置**当数据**读写，两边解耦：换气升级不影响它，它坏了也不影响换气。

## ★★ 全篇最要紧的一条：绝不重新序列化那份 YAML

`cordis.patch.yml` 有 18.5 KB，里面塞满中文注释、`!!js` 表达式、手工排过版的分节。
**任何「读成对象 → 写回 YAML」的做法都会把它们全丢掉。**

所以写入是**字节级的**：定位到 `- id: huanqi` 那一段里的 `config:` 块，
只替换「某一行值的等号右边」或在块尾插入一行，**其余字节原样保留**。

**判据（实测过，可以随时重跑 `_selftest.mjs`）**：

- 改一个值 → **行数不变、只有 1 行不同、文件字节数一模一样**（18515 → 18515）
- 再改回去 → **与原文逐字节相同**
- 改完 `!!js`、中文注释、别的插件段**全在**

> 段边界的判据用的是**缩进**，不是「找下一个 `- `」：
> 这一节嵌在 `- set:` 下面，兄弟项缩进 4 空格、子项（`config:`）6 空格。
> 遇到缩进 ≤ 自己的 `- ` 就是本节结束。（同一套判据最早写在 dsh-huanqi 自带的 `set-quota.mjs` 里。）

## 暴露的 10 个参数

| 键 | 含义 | 范围 |
|---|---|---|
| `maxContinuations` | 延续额度上限；**0 = 关掉换气层，只留循环检测** | 0–10 |
| `normalTurnThreshold` | 攒够多少「正常轮」额度 +1 | 5–100 |
| `anomalyWindow` | 出正文后多少轮内又卡住算一次异常（额度 −1） | 3–50 |
| `warnAtCredit` | 额度降到几时开始提示 | 1–10 |
| `silentReasoningChars` | 流内早杀阈值（字）。★ 3000 曾误杀 7.9% 的正常长推理，2026-10-12 放宽到 8000 | 0–100000 |
| `subagentPolicy` | **子 agent（含 Agent Teams 成员）适用哪一档**：`strict` 全局（默认）／`relaxed` 只保留流内早杀／`exempt` 完全豁免 | 三选一 |
| `regionCompactAfterCuts` | 累计截断到几次做一次范围压缩（带门牌，可回取）。0 = 关闭 | 0–10 |
| `fullCompactOnBreaker` | 熔断时彻底清空上下文 + 告知 + 不再延续。关掉它，熔断就只是「停下等人」 | 布尔 |
| `postCompactRecallHint` | 压缩后让它拿 seq 指针去取一手原文，而不是读摘要 | 布尔 |
| `ledgerPath` | 账本路径；留空 = `<DSH_HOME>/state/dsh-huanqi.json` | 文本 |

**为什么只暴露 10 个**：`Config` 有 26 项，其余 16 项是循环检测的内部阈值（gram 大小、重复行覆盖率之类），
调它们需要先读检测器实现，不该放进随手可改的表单。

> ★ **2026-10-30 修正（GitHub #21）**：这张表原来写「7 个」，漏了
> `regionCompactAfterCuts` / `fullCompactOnBreaker` / `postCompactRecallHint` 三项 —— 实际面板里一直是 10 个。
> **是读者（kksnowny）对着面板数出来的，不是我自己发现的。**

### ★ 布尔字段必须走 `bool` 类型（2026-10-30 修，GitHub #21）

**`fullCompactOnBreaker` / `postCompactRecallHint` 这两项，2026-10-30 之前是 `type: 'enum'`、
value 写成字符串 `'true'` / `'false'`。** 于是面板保存时按 enum 渲染，**写成带单引号的 `'true'`**；
而 `dsh-huanqi` 的 Config 里它们是 `z.boolean()` —— **校验抛错，整个换气插件不装配，且界面上没有任何提示。**

**现在它们是真 `bool` 类型**：`render()` 输出**不带引号的 YAML 布尔**，前端仍用 `<select>` 显示「开 / 关」。

★★ **这张表和 `dsh-huanqi` 的 `Config` 是两份各自演化的类型声明** —— 中间没有任何断言把它们绑在一起。
**这次只对齐了这两处，没解决「两份声明会再次漂移」这个结构问题。** 后续要做的是**一张明确的类型表**
（key → schema 类型 → YAML 渲染规则）。


### `subagentPolicy`（2026-10-23 加）

面板里**唯一的下拉框**：前几个是数字输入、`ledgerPath` 是文本，只有它是枚举。
服务端也校验（`render()` 里那段）—— 直接 POST 一个不在白名单里的值会被拒，不能只靠前端 `<select>`。

| 档 | 循环检测（`react`） | 流内早杀 | 空回合续/熔断 | 判词 |
|---|---|---|---|---|
| `strict`（默认） | 生效 | 生效 | 生效 | 原样 |
| `relaxed` | 跳过 | **生效** | 跳过 | `skip:subagent:relaxed` |
| `exempt` | 跳过 | **跳过** | 跳过 | `skip:subagent:exempt` |

**默认 `strict` 是刻意的**：等于现在的行为，不会让谁突然失去保护；放宽要主动选。
`relaxed` 保留流内早杀也有依据 —— 2026-10-23 实测，那条早杀通知恰好把一个正在空推演的子 agent 推向了写盘。

#### ★ 已知坑：YAML 引号会让下拉框「选了又跳回去」（2026-10-23 修）

当天第一次加上这个下拉框，作者选了「子 agent 放宽」→ 保存 → **又跳回「全局应用」**。

**写入一直是对的**：`cordis.patch.yml` 里确实多了 `subagentPolicy: 'relaxed'`（第 470 行）。

**错在读回来**：`readValues()` 是「按行取值」，它把 YAML 的引号**一起带出来了** ——
`raw = "'relaxed'"`。文本框看不出问题，但 `<select value="'relaxed'">` 匹配不上
value 为 `relaxed` 的 option，**浏览器静默回落到第一项**。

原来只特判了空串 `''`，带引号的非空串没剥。修在 `readValues()` 源头（对
`readHuanqiConfigValue()` 里原有的补丁是幂等的）。

**回归检查**：

```
node verify-panel-read.mjs
```

它用**真的** `cordis.patch.yml` 跑一遍真 `readValues()`，逐个字段断言
enum 的读回值能在 `options` 里找到。这条命令是这次事故留下的唯一防线 ——
**下次加任何 `type: 'enum'` 的字段，先跑它。**

## ★ 只改 desktop，web 默认不动

作者 2026-10-12 23:25 定：**web 那份 profile 是备用通道** ——
「不动它，它已经很稳定了，用来作为我们的备用通道，免得桌面端崩溃了，没得修。」

所以面板里那个「同时改 web 备用通道」的勾**默认关着**。
真要同时改，勾上再保存（那条路径也验过，能写）。

## 改完必须重启

面板底部会提示。**换气的参数是启动时读进内存的**，不重启不生效 ——
这与启动动画不同（那个是每次开窗口现读配置）。

## 恢复到新机器 / 官方更新之后

桌面端 profile **不能用 CLI 装**（`dsh plugin --profile desktop add` 会被拒：
`profile "desktop" is managed exclusively by the Electron application`）。手动两步：

```powershell
$src = "<本仓库>\plugins\huanqi-panel"
$dst = "<DSH_HOME>\profiles\desktop\node_modules\dsh-agent-huanqi-panel"
New-Item -ItemType Directory -Path $dst -Force | Out-Null
foreach ($f in @("package.json","cordis.patch.yml","index.js","client.js")) { Copy-Item "$src\$f" "$dst\$f" -Force }
```

然后往 `<DSH_HOME>\profiles\desktop\package.json` 的 `dsh.profile.bundles` 数组里加一项
`"dsh-agent-huanqi-panel"`（**用 node 的 JSON.parse/stringify 改，别用 PowerShell 的 ConvertFrom-Json**；
写完再 JSON.parse 读回验一次）。重启。

## 验收（重启后一条命令全跑完）

```powershell
$py = "python"
$env:PYTHONIOENCODING = "utf-8"
& $py <本仓库>\plugins\huanqi-panel\_verify.py
```

它做七件事：读 6 个参数 → 读实时额度 → **改一个值再看文件差多少字节** → 改回去比对 MD5 →
越界值被拒 → 未知参数被拒 → 自动备份是否生成。

## 三条接口

| 方法 | 路径 | 干什么 |
|---|---|---|
| GET | `/yanqing-huanqi/api/health` | 自检：文件在不在、暴露哪些字段 |
| GET | `/yanqing-huanqi/api/state` | 读：两份 profile 的配置值 + 实时额度 |
| GET | `/yanqing-huanqi/api/preview?maxContinuations=5` | **只读预演**：会改哪几行、字节数变化（不落盘） |
| POST | `/yanqing-huanqi/api/config` | 写：`{profiles:["desktop"], values:{...}}` |

★ 必须自带 CORS 头 —— 设置页的 origin 是 `file://` 或 `app://`，
从那种页面 fetch 本机端口属于跨域，缺头就是 `Failed to fetch`。

## 已知的坑（写下来免得下次再踩）

1. **侧栏那一项没名字** → 检查 `register` 里的字段名：
   是 **`label`，而且是函数**（`label: () => "换气"`），不是 `title`。
   写错的后果很隐蔽：那一项照常出现、能点、能开面板，**就是没有名字**，零报错。
2. **客户端半整包静默失效** → 先看 `exports.inject = ["slots"]` 有没有写。
3. **`!!js` 表达式**：这份 YAML 里有，所以绝不能重新序列化（见上）。
4. **改完不生效** → 换气参数要重启；面板里的提示是真话。
