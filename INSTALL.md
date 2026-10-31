# 安装 · agent-soul

> 仓库：**https://github.com/cyanwell/dsh-agent-soul**
>
> 一个 DSH（DeepSeek Harness）插件。装上它，宿主里会多出 8 个工具，
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

### 4. 装完第一件事：跑 doctor

装完最后一个零件，**先别急着用**。新开一个会话，说：

> 跑 `agent_soul_doctor`

它拿四条判据逐条问：这层管哪种稀缺资源、唯一权威源在哪、坏了长什么样怎么**当场**发现、
别人（或下一代的你）怎么一句话问到它。

**答不出来就是没搭对。** 这时候按它说的补，比用着用着才发现问题便宜太多。

★ 别把这一步放到最后。它是**你和这套架构的第一次对话**，应该发生在装完的那一刻，
而不是出问题之后。

---

## 五个坑（每一个都是实测撞出来的）

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

### 坑 5 · 装完了、没报错、但它没在工作

这是**最像成功的一种失败**。`dsh-agent-echo` 要在自己目录下找三个脚本才能跑：

```
HUB = <包目录>/runtime          ← 默认值，可用 ECHO_HUB 环境变量覆盖
  ├── echo-doctor.mjs           体检器
  ├── memindex.mjs              记忆索引
  └── self.mjs                  每轮注入的自我层
```

**这三个脚本不在 npm 包里** —— 它们是「你的记忆库」工具，得你自己有。

所以会出现这一串全绿：

- 装上了 ✓
- 加载了 ✓（`dsh.bundle` 也对）
- `verify-live` 通过 ✓
- `agent_soul_doctor` 也过 ✓

**但它调不起体检。**

因为起子进程那一行包在 `try/catch` 里，失败**不报错、不打日志、不出一行字**。

**怎么当场发现**：直接问它一句。

```bash
# 把地址换成你当前 DSH 的地址（桌面版启动日志里那个 http://127.0.0.1:<端口>）
curl http://127.0.0.1:<端口>/yanqing-echo/api/status
```

返回一段 JSON = 宿主半活着、路由通、能回话。
返回 404 或连不上 = 没在跑。这一条查一次十秒钟，比事后猜一晚上便宜。

> ★ 2026-10-25 更正（GitHub #4 第三节，yunchengyc 报）：这里原来让人查
> `runtime/echo-panel.json` 在不在。**那个判据是错的** —— 它存的是「面板档位」，
> 只在你在面板里改过档位时由 `saveCfg()` 写一次（`plugins/echo/index.js` 里
> `saveCfg` 只有一个调用点，就是 `/api/level` 那个 POST）。
> 没打开过面板时它本来就不存在 —— 照旧文档查，会把「一切正常」判成「没在跑」。
> **一个恒假阴性的判据，比没有判据更坏。**

**怎么修**：把需要的脚本放进 `runtime/`，或者用 `ECHO_HUB` 指到你已有的记忆库目录。
只要记忆检索的话，`memindex.mjs` 就够；`self.mjs` 管的是「每轮注入自我层」那一套，
没有它 echo 不会注入，但也不会崩。

★ 这条真正想说的是：**「装上了」和「在跑」是两件事。**
`verify-live` 和 `doctor` 能验前者，验不了后者 —— 后者只有你自己知道。

---

## 装完怎么验

**别只看「文件复制过去了」。** 本仓库带两个验法：

```bash
# ⓪ 四条「静默失败」判据 —— 不需要 profile，任何机器上都能跑
node tools/verify-install-traps.mjs --verbose
#   查：insert.name 与包名一致 / 示例配置键名 / 模板与骨架目录一致 / 能解析
#   当前树实测：通过 22，失败 0

# ① 静态：层进没进 bundles / patch 在不在 / 副本与源一致吗
node tools/verify-live.mjs --profile <profile 目录>

# ② 运行时：现在管压缩的是谁
dsh plugin --profile <profile> add "file:<仓库>/tools/soul-probe"
# 重启后看探针日志。默认在系统临时目录：
#   <tmp>/dsh-soul-probe-compaction.log
# 想指定路径就设 SOUL_PROBE_LOG=<你的路径> 再重启。
# ★ 探针写不进去会在 stderr 说一次 —— 那不代表压缩没接管，别读反了。
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

## 出问题了怎么办

**先别自己猜。** 三样东西凑齐，大部分问题一眼就能定位 ——
而且凑齐之后**贴给你的 agent，它自己就能接着修**。

### 三样东西

**① doctor 的输出**

> 跑 `agent_soul_doctor`，把完整输出贴出来

五层逐条问过一遍，缺哪层、哪条判据答不上来，都在里面。

**② verify-live 的输出**

```bash
node tools/verify-live.mjs --profile <你的 profile 目录>
```

通过多少、需注意什么、失败在哪条。这一份回答的是「装进去的东西对不对」。

**③ 探针那一行**

```bash
cat "${SOUL_PROBE_LOG:-<tmp>/dsh-soul-probe-compaction.log}" | tail -2
```

`ctor` 是整条 ECHO 里最硬的一条证据：**现在管压缩的是谁**。
日志文件不存在 = 探针没装，或者装了没重启。

### 三样都在手上了，怎么读

| 现象 | 大概率是 |
|---|---|
| 三样都绿，但页签不出现 | 客户端半没渲染 —— 浏览器 F12 看 console，看网络面板有没有 404 |
| doctor 说某层答不出 | 那层没装，或者装了没进 bundles（坑 2） |
| verify-live 报「副本与源不一致」 | pnpm 重整过 node_modules，见坑 4 的说明 |
| 探针日志不存在 | 探针没装，或者装了没重启 |
| `ctor` 是 `BasicCompactionEngine` | 没接管，看 [HOW-TO-TAKEOVER.md](plugins/compaction/HOW-TO-TAKEOVER.md) |
| 全都对，但 echo 那个页签没数据 | 坑 5 —— `runtime/` 下那三个脚本不在 |

### 报问题的时候

带上这三样，加一行你的 DSH 版本（`dsh --version`）和操作系统。

★ **如果你是用 agent 装的，直接把这堆丢给它。** 它有源码，能自己看。
`SANDBOX-VERIFICATION.md` 里记了八个洞的完整实录，它读完能对上大半 ——
**让它修，比等我们回一句「重启试试」快得多。**

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

- 出去的：五层模型、四条判据、15 个通用零件、安装指引、体检工具
- 没出去的：某个具体 agent 的主壳、人格档案、语音、形象、对外通道

道理很简单：**身份可以复制，责任不能。** 这套东西给你的是「怎么搭自己的」，
不是「变成我」。

---

## 目录

```
agent-soul/
├── index.js              8 个工具（layers / manifest / doctor / install / plan / scaffold / check / verify）
├── install.js            安装指引生成器
├── client.js             Web 端 UI
├── soul/
│   ├── 01..05            五层文档 + 装配顺序 + 体检
│   └── 04-manifest.json  该装哪些零件的机器可读清单
├── plugins/              15 个零件包（每个都是独立 DSH 包）+ tools/（三个脚本目录，不是包）
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

---

## 坑 6 · 装完 `client.js` 不在（整个 DSH 会「裸奔」）

★ 这一条是**真实用户反馈**（2026-10-22，第一个装这个插件的人踩的）。

★★★ **动手之前先做这一个动作**（2026-10-25 加，来自第二份实机报告，GitHub #4）：

```bash
cp <profile>/package.json      <profile>/package.json.bak
cp <profile>/cordis.patch.yml  <profile>/cordis.patch.yml.bak
```

**为什么必须先备份**：这一条和别的坑不一样 —— 它**不是报错退出，而是触发自愈**。
`sanitizeProfile` 会把 `dsh.profile.bundles` 重置成只有 `@deepseek-ai/dsh-base` +
`@deepseek-ai/dsh-web-app` 两条，**该 profile 里其他所有插件一起下线**。
一次装错，代价是整个 profile，而恢复完的 DSH 看着是活的 —— 你不会立刻发现少了什么。

那位报告者说他「这次是备份了才没丢东西」。**这个前提不该靠读者自己想到。**

**症状**：装完之后 DSH 看起来正常、进程也在跑，但 guard / 桌宠 / session switch 全都没加载。
> **crash 日志在哪儿**：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`
> （本机实测路径；**不在** Cache、**不在** Storage —— 是从 asar 里 `writeCrashReport(app.getPath("logs"))` 反推的。）
> 崩了先看这里，**别反复重启**：每重启一次可能又掉一批插件，而界面看起来一切正常。

crash 日志里 `intercom` 的 `failed to import` 排在很次要的位置，真正的原因是
`modules (required)` 因为 **soul 的 `client.js` 缺失**而 compose 失败 → 整个启动崩 →
`sanitizeProfile` 自动恢复 → **bundles 被重置** + patch 被备份。恢复完 DSH 是活的，
但你已经不在那套架构里了。

**为什么缺**：本包的 `package.json` 原先没有 `files` 字段。pnpm 在某些 node-linker 模式下
只搬白名单里的东西，没写就只搬了 `main` 和 `exports` 直接指向的那几个 —— `client.js`
不是 `main`，于是掉了。

**已经修了**（2026-10-22）：`package.json` 加了 `files`，显式列出
`index.js / client.js / install.js / cordis.patch.yml / kit-bridge.mjs / probe-kit-tools.mjs /
install-desktop.ps1 / README.md / INSTALL.md / LICENSE / soul/ / skeleton/ / kit/ / plugins/ / tools/`。
**如果你是那个用户，重新拉一次仓库、重装即可。**

**怎么自查（三秒）**：

```bash
# 装到 profile 之后，这个文件必须存在
ls <profile>/node_modules/dsh-agent-soul/client.js
```

不存在 → 就是这一条。手动补：

```bash
cp <仓库>/client.js <profile>/node_modules/dsh-agent-soul/
```

**更稳的做法**：把实体目录换成指向源的 junction / 符号链接（前提是确认那块是纯拷贝、没有运行时写入）：

```powershell
# Windows，先删掉那个副本目录，再建 junction
Remove-Item "<profile>\node_modules\dsh-agent-soul" -Recurse -Force
New-Item -ItemType Junction -Path "<profile>\node_modules\dsh-agent-soul" -Target "<仓库路径>"
```

这样源里有什么，装的就是什么，不会再漏。

★ 这一条真正想说的是：**「装上」和「在跑」是两件事**，而这一回的失败是**静默**的 ——
不报错、不提示、界面看起来好好的。所以装完务必走一遍上面「装完怎么验」那两步。

### 补记 · 两条安装路径是**两份独立的清单**（2026-10-22 第二个反馈）

★ 这一条把上面那个坑说完整：**修 `package.json` 的 `files` 只管「`dsh plugin add file:`」那条路。**
**桌面端走的是 `install-desktop.ps1`，它有自己的 `$files` / `$dirs` 数组，根本不看 `files`。**

所以第一条修完之后，桌面路径仍然是坏的 —— 那位用户踩的正是这个：

```
host crash: client bundles not found; run 'pnpm run build' before launch:
  package: dsh-agent-soul,
  path: C:\Users\ws\.dsh\profiles\desktop\node_modules\dsh-agent-soul\client.js  (ENOENT)
```

原来的清单是：

```powershell
$files = @('package.json','cordis.patch.yml','index.js','install.js','kit-bridge.mjs','README.md','INSTALL.md')
foreach ($d in @('kit','soul','skeleton','tools'))
```

`client.js` 不在里面。更糟的是 **`plugins/` 也不在里面** ——
也就是说走桌面路径装出来的东西，不但会崩，连那 15 个零件包都一个没有。

**已修**：`$files` 补 `client.js` / `probe-kit-tools.mjs` / `install-desktop.ps1`，
`$dirs` 补 `plugins`。并且加了一步**硬自检**：

```powershell
$mustHave = @('client.js','index.js','cordis.patch.yml','package.json','plugins')
# 任何一个不在 → Die，在碰 bundles 之前退出
```

★ 这一步的顺序很关键：**自检放在改 `bundles` 之前**。
因为一旦 DSH 启动失败，`sanitizeProfile` 会把用户的 `bundles` 重置成只剩内置包、
把 `cordis.patch.yml` 改名备份后清空 —— 那是**用户自己的其他插件跟着一起下线**。
所以在动 `package.json` 之前就该失败，而不是装完等他重启才炸。

**代价要讲明白**：装上这个东西失败一次，损失的不只是这个插件，**是你整个 profile 的 patch 配置和别人家的插件**。
所以在桌面端安装前，**先备份 `package.json` 和 `cordis.patch.yml`** —— 脚本只备份了前者。

---

## 如果已经中招了 · 恢复步骤

★ **先说结论：你的会话记录没丢。** 会话在 DSH home 的 `sessions/` 下（按工作区分子目录），
`storages/` 也在那里。两处都**不在 profile 目录里**，`sanitizeProfile` 碰不到它们。
被重置的是**加载谁**的名单（`bundles`）和**patch 了什么**的配置。

**而且被改的文件基本都没删，只是改名了** —— 去 profile 目录翻 `.bak`：

```powershell
# 1. 找到 sanitize 留下的备份（按时间倒序，最上面那个就是出事前的那份）
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop" -Filter "cordis.patch.yml.bak*" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 5 Name, LastWriteTime, Length

# 2. 确认那份备份里有你的原始配置（看行数和内容，不要盲拷）
Get-Content "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-<时间戳>" | Measure-Object -Line

# 3. 恢复（先把当前这份也留个底，别覆盖掉唯一线索）
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" "cordis.patch.yml.broken-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml.bak-<时间戳>" "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" -Force
```

**`bundles` 同理** —— profile 的 `package.json` 旁边也有 `.bak`：

```powershell
Get-ChildItem "$env:USERPROFILE\.dsh\profiles\desktop" -Filter "package.json.bak*" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 5
```

把那份 `package.json` 拷回来，`dsh.profile.bundles` 数组就回来了。
★ **注意用 node 读那个文件确认 JSON 合法**，不要用 PowerShell 的 `ConvertFrom-Json` 看（它容忍 BOM，会给你假通过）：

```powershell
node -e "const p=require('fs');const j=JSON.parse(p.readFileSync(process.argv[1],'utf8'));console.log('bundles:', (j.dsh&&j.dsh.profile&&j.dsh.profile.bundles||[]).length)" "$env:USERPROFILE\.dsh\profiles\desktop\package.json"
```

**确认会话还在**：

```powershell
# 有没有丢，看文件数和最近修改时间就知道
(Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Recurse -Filter "*.jsonl").Count
Get-ChildItem "$env:USERPROFILE\.dsh\sessions" -Recurse -Filter "*.jsonl" |
  Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name, LastWriteTime
```

★ **顺序很重要**：先恢复文件，**再装/重装本插件**。
反过来的话，一次失败的启动又会把刚恢复的东西再重置一遍。

### 补记 2 · 桌面脚本的两条实测边界（2026-10-22）

**① 直接 `& .\install-desktop.ps1` 会被执行策略拦住**

实测原文：

```
& : 无法加载文件 ...\install-desktop.ps1，因为在此系统上禁止运行脚本。
    + PSSecurityException
    + FullyQualifiedErrorId : UnauthorizedAccess
```

脚本一行都没跑。`INSTALL.md` 上面写的是 `powershell -ExecutionPolicy Bypass -File .\install-desktop.ps1`，
那是**能过的**；但如果你图省事直接 `&`，会以为是脚本坏了，其实是没跑起来。
★ 判据：**看输出里有没有 `dsh-agent-soul - desktop install` 这行标题** —— 没有就是没跑，别去怀疑脚本逻辑。

**② 现在改成「先拷到暂存目录、验过再换上」**

以前的顺序是「建 `node_modules\dsh-agent-soul` → 往里面拷 → 自检」。
自检失败时 `Die` 会退出，**但那个建了一半的目录留在原地** —— `package.json` 确实没被动（这点没问题），
可是用户下次来看，会看到一个残缺的 `dsh-agent-soul` 目录，很难判断它到底是装好的还是坏的。

现在：拷到 `%TEMP%\dsh-agent-soul-stage-<tag>` → 在**暂存目录上**自检 →
缺任何一样就删掉暂存目录并退出，**profile 一个字节都不碰** → 全齐了才 `Move-Item` 到位。

**失败路径的实测证据**（用一个假 profile + 一个不存在的分支，模拟下载 404）：

```
  ok   profile: ...\fake-profile-test
  ok   node: ...\primary-runtime\dependencies\node\bin\node.exe
  get  https://github.com/cyanwell/dsh-agent-soul/archive/refs/heads/definitely-no-such-branch.zip
  FAIL download failed: 远程服务器返回错误: (404) 未找到。
```

事后核对：

| 检查项 | 结果 |
|---|---|
| `package.json` 的 SHA256 | **没变** |
| `node_modules/` | **没被创建** |
| `bundles` 内容 | 还是原来的 `["keep-me"]` |

★ 这条的意义：**「装不上」是可接受的结局，「装到一半」不是。**
所以失败都发生在碰用户配置之前 —— 下载、解压、拷贝、自检，四道关全在改 `bundles` 之前。

---

## 坑 7 · 改了仓库，重装一遍 —— 副本没变

★ 这一条是**实测**（2026-10-27）：按上面第 2 步原样重跑

```bash
dsh plugin --profile web add "file:$(pwd)"
# → Already up to date / resolved 40, reused 0, added 0
```

**它什么都没做。** `file:` 目录依赖在 pnpm 里按内容缓存，源码改了不会重拷。
装好的 `node_modules/dsh-agent-soul/` 里既没有新加的文件，改过的文件也还是旧的 ——
而命令的退出码是 0，输出是「Already up to date」，看起来像成功了。

**怎么当场发现**（十秒钟）：

```bash
ls node_modules/dsh-agent-soul/tools/verify-install-traps.mjs    # 新加的文件在不在
grep -c "hub', 'echo.config.json" node_modules/dsh-agent-soul/kit/echo/echo-config.mjs
```

**修法：别用 `file:`，用 `link:`。** 这是坑 6 最后建议的那条路，这里是它的第二个理由：

```jsonc
// <profile>/package.json
"dependencies": {
  "dsh-agent-soul": "link:/path/to/dsh-agent-soul"   // ← 不是 file:
}
```

然后让 `node_modules/dsh-agent-soul` 成为指向上游仓库的符号链接：

```bash
cd <profile>
rm -rf node_modules/dsh-agent-soul
ln -s /path/to/dsh-agent-soul node_modules/dsh-agent-soul
```

这样**源里有什么，装的就是什么**，改一处立刻生效，也不会再出现「重装了一遍但它没变」。

★ 这一条真正想说的是：**「命令成功」和「副本更新了」是两件事**。
和坑 1、坑 5 是同一个形状 —— 这次连报错都没有，只有一句看起来像好消息的 `Already up to date`。
