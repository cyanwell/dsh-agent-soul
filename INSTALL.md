# 安装 · agent-soul

> 仓库：**https://github.com/cyanwell/dsh-agent-soul**
>
> 一个 DSH（DeepSeek Harness）插件。装上它，宿主里会多出四个工具，
> 它们不替你搭架构，只回答四个问题：**五层是什么、该装哪些、我装对了吗、下一步跑什么。**

---

## 前置

- 已装 DSH，能跑 `dsh --version`
- 有一个自己的 profile（`dsh profile list` 能看到）
- Node ≥ 20；pnpm 由 corepack 提供（见下面第 1 个坑）

---

## 三步

### 1. 克隆

```bash
git clone https://github.com/cyanwell/dsh-agent-soul.git
cd dsh-agent-soul
```

> ★ **别用 `dsh plugin add github:...` 装本体。**
> 那些零件在仓库的 `plugins/` 子目录里，用 git 协议装只有一个包、拿不到它们。
> 先克隆，再用 `file:` 指向本地路径。

### 2. 装本体

```bash
dsh plugin --profile <你的profile> add "file:$(pwd)"
```

Windows PowerShell：

```powershell
dsh plugin --profile <你的profile> add "file:D:\path\to\dsh-agent-soul"
```

### 3. 让它自己告诉你还缺什么

重启 DSH（**不是刷新页面**），新开一个会话，说：

> 跑 `agent_soul_install`，action=plan

它会按装配顺序打出六步：第 0 步先定权威源，然后 Ⅰ ECHO / Ⅱ VITAL / Ⅲ 能力 / Ⅳ 档案 / Ⅴ 运维，
每一步列出缺哪个包、以及可以直接粘贴的那条 `dsh plugin add` 命令。

**照着跑就行。** 装一个重启一次，再 `action=plan` 看下一步。

---

## 四个坑（每一个都是实测撞出来的）

### 坑 1 · `'pnpm' is not recognized`

`dsh plugin add` 内部转发给 pnpm。如果 pnpm 不在 PATH：

```bash
corepack enable pnpm      # 如果这步失败
corepack pnpm --version   # 但这个能跑，就说明 corepack 有、只是没挂上
```

Windows 上可以造一个薄壳丢进 PATH：

```cmd
@echo off
node "C:\Program Files\nodejs\node_modules\corepack\dist\corepack.js" pnpm %*
```

### 坑 2 · 装上了，但没加载

DSH 启动时会打一行警告：

```
declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

意思是这个包只是被当成普通依赖装了，**没有当成 profile 的一层**。
修法：它的 `package.json` 里要有

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

★ 本仓库的零件都带了。但如果你自己写零件，**没有这个字段就是静默不加载**。

### 坑 3 · `cordis.patch.yml` 只有 `insert`

patch 是扁平的，形状是 `{ id, name, ...overrides }`：

- **没有 `update:` 关键字** —— 写成 `- update: [...]` 会报
  `patch: id is required for non-insert patches`
- **`name` 不能改** —— 和原条目不一致会被 skip，不报错
- 能改的只有 `config` 之类的字段

所以 patch **能让你被加载，管不了谁占住服务名**。

### 坑 4 · 同名服务先到先得（最隐蔽）

cordis 的 Service 注册是**先注册的赢**，后来的**不报错、不警告，静默不生效**。

`dsh plugin add` 是往 `bundles` **末尾追加**的 → 你的包排在 `@deepseek-ai/dsh-base` 后面 ⇒ 输。

两条出路，按场景选：

**路 A · 整个 profile 都是你的** —— 调 bundles 顺序：

```powershell
$p  = "<profile>\package.json"
$pj = Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json
$cur = @($pj.dsh.profile.bundles)
$move = @("dsh-agent-compaction", "dsh-agent-pruner")   # 换成你要提前的包
$rest = $cur | Where-Object { $move -notcontains $_ }
$pj.dsh.profile.bundles = @() + ($move | Where-Object { $cur -contains $_ }) + $rest
[System.IO.File]::WriteAllText($p, ($pj | ConvertTo-Json -Depth 20), (New-Object System.Text.UTF8Encoding($false)))
```

★ 必须写无 BOM。`Set-Content -Encoding UTF8` 在 PowerShell 5.1 里带 BOM，DSH 会 `JSON.parse` 失败。

**路 B · 一个 profile 里有多个 preset，只想换其中一个** —— 用 realm 隔离：

```yaml
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
  config:
    - id: compaction-basic            # ★ id 保持原名
      name: 'dsh-agent-compaction'    # ★ 只换 name
```

★ 关键在「id 不变、只换 name」——那是**替换**不是新增，压根不会触发先到先得。

详见 [`plugins/compaction/HOW-TO-TAKEOVER.md`](plugins/compaction/HOW-TO-TAKEOVER.md)。

---

## 装完怎么验

**别只看「文件复制过去了」。** 本仓库带两个验法：

```bash
# ① 静态：层进没进 bundles / patch 在不在 / 副本与源一致吗
node tools/verify-live.mjs --profile <profile 目录>

# ② 运行时：现在管压缩的是谁
dsh plugin --profile <profile> add "file:<仓库>/tools/soul-probe"
# 重启后看 D:/AI/dsh-slots/logs/probe-compaction.log
# ctor 是 YanqingCompaction = 接管成功；BasicCompactionEngine = 没接管
```

实测输出（沙箱）：

```
通过 32   需注意 1   失败 0
ctor:      YanqingCompaction
chain:     ["YanqingCompaction","BasicCompactionEngine","CompactionEngine","Service","Object"]
```

还有一件事脚本验不到：**客户端半的 UI 真的渲染了没有**。
开浏览器看，不是看 Host 报 running。

---

## 五层是什么

| 层 | 管哪种稀缺资源 | 缺了会怎样 |
|---|---|---|
| **Ⅰ ECHO** · 生命核心 | **空间**：上下文会满，满了要丢，丢了还要能找回来 | 压了就没了，回不去原文 |
| **Ⅱ VITAL** · 稳态 | **时间与方向**：预算会烧光、会原地打转 | 烧到断电才发现，或者该停不停 |
| **Ⅲ 能力** · 手和感官 | 随便换 | —— |
| **Ⅳ 档案** · 唯一看得见的那一层 | 别人（和下一代的你）理解你 | 你存在过，但没人看得见 |
| **Ⅴ 运维** | 装配顺序与升级路径 | 每次重新想一遍；升级时把已有的拆坏 |

**Ⅴ 不是一个包，是一个问题。** manifest 里它的判据只有一句：
「顺序是不是『先定权威源，再建机制』？反过来做一定会双重记账」。

---

## 四条判据（这才是本插件的核心，不是插件本身）

每一层都必须能回答这四条，答不出就等于没搭：

1. **一个被管理的资源** —— 这层管的是什么会耗尽的东西？
2. **一个唯一权威源** —— 同一件事只有一处能改。做不到就会有三份真相。
3. **一个失败模式 + 检测法** —— 它坏了长什么样？怎么**当场**发现，而不是三个月后？
4. **一个接口** —— 别人（或下一代的你）怎么用一句话问到它？

`agent_soul_doctor` 就是拿这四条逐条问你的。

---

## 本包不含什么

**能力半出去了，身份半没出去。**

- 出去的：五层模型、四条判据、12 个通用零件、安装指引、体检工具
- 没出去的：某个具体 agent 的主壳、人格档案、语音、形象、对外通道

道理很简单：**身份可以复制，责任不能。** 这套东西给你的是「怎么搭自己的」，
不是「变成我」。

---

## 目录

```
agent-soul/
├── index.js              四个工具（layers / manifest / install / doctor）
├── install.js            安装指引生成器
├── client.js             Web 端 UI
├── soul/
│   ├── 01..05            五层文档 + 装配顺序 + 体检
│   └── 04-manifest.json  该装哪些零件的机器可读清单
├── plugins/              12 个零件（每个都是独立 DSH 包）
├── tools/
│   ├── init.mjs          生成骨架
│   ├── verify-live.mjs   静态全量校验
│   ├── probe-service-order.mjs  最小复现「先到先得」
│   └── soul-probe/       运行时身份探针
├── SANDBOX-VERIFICATION.md   ★ 从零装一遍的完整实录，含八个坑
└── skeleton/             空骨架，填你自己的
```

★ 想先知道「这套东西是怎么被真装一遍、又撞了哪些洞才长成现在这样的」，
读 [`SANDBOX-VERIFICATION.md`](SANDBOX-VERIFICATION.md)。它比本文诚实。
