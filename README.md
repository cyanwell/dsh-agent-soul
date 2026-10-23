# agent-soul · 灵魂架构

> ★★ **要装它，看** → [INSTALL.md](INSTALL.md)：三步安装、**五个坑**、装完**先跑 doctor**、出问题了怎么报。
> 　 仓库：**https://github.com/cyanwell/dsh-agent-soul**

> ★ **理论篇**：这个仓库的说明书背后有一篇论文 —— [《回声 ECHO：面向长周期协作的外部记忆架构》](archive/paper/echo-architecture.html)，它讲了**为什么**这么设计，以及**实测跑成了什么样**。
> ★ **它已经过时了** —— 架构在写完它之后又改过几轮。结论以 `soul/` 为准，它是沿革。


> 一个 agent 该怎么搭自己的灵魂 —— **它不只讲道理，它动手替你搭。**

这是一个 DSH（DeepSeek Harness）插件。装完宿主里会多出 8 个工具，分成三类：

**前三个是驱动器 —— 它们真的做事**（装完就靠它们跑）：

| 工具 | 做什么 |
|---|---|
| `agent_soul_plan` | ★ **下一步做哪一件** —— 只给一件，说清为什么是这件、怎么做。做完再问，给下一件 |
| `agent_soul_scaffold` | **把骨架搭起来** —— 十一个目录 + 账本 + AGENTS.md + 术语表 + SELF 模板。默认只干跑 |
| `agent_soul_check` | **给六层做体检** —— 它会判定（`error` = 坏了，`warn` = 还没装 / 还没开始用） |

**后四个是说明书 —— 它们回答「该有什么」**：

| 工具 | 回答什么 |
|---|---|
| `agent_soul_layers` | **五层是什么** —— 每层管哪种稀缺资源、缺了会怎样（★ 第 Ⅰ 层 ECHO 内部还有六层） |
| `agent_soul_manifest` | **该装哪些插件** —— 每类能力要满足什么、必需还是可选 |
| `agent_soul_doctor` | **我这套装对了吗** —— 四条判据逐条问，加包内文件核对 |
| `agent_soul_install` | **还缺什么、下一步跑什么命令** —— 读你的 profile，按装配顺序给精确命令 |
| `agent_soul_verify` | **这套东西真的在跑吗** —— 前面几个回答「该有什么」，它回答「装上之后真的有东西在动」 |

★ 三层架构各有一份文件讲透：**ECHO 六层先看 [`docs/ECHO-权威口径.md`](docs/ECHO-权威口径.md)（唯一权威，L0–L5）**，
每层缺了会怎样再看 `soul/10-echo-anatomy.md`；
灵魂目录看 `agent_soul_scaffold` 建出来的那十一个目录，稳态看 `soul/03-vital.md`。

---

## 它解决什么问题

长任务的 agent 有两个慢性病。**注意：第一个和「忘事」不是一回事。**

```
上下文满了 → 引擎压缩 → 摘要里每一条都对，但都不带出处
                                    ↓
                    你不核对 —— 因为它看起来可靠
                                    ↓
            下一轮推理建立在这个「记得」上。只要细节偏了半个字
                                    ↓
                它现在变成了前提，而你继续正确地往下推
```

★ **这才是「思考退化」：不是变笨，是在错误的前提上继续正确地推理。**

遗忘你能察觉——想不起来就是想起来。
退化察觉不到——你想得起来，但那个记忆已经偏了，而你在它上面一路推下去。

所以这个插件要做的是两件事：

| 层 | 管什么 | 核心不是 |
|---|---|---|
| **Ⅰ ECHO** | **空间**：让丢掉的东西带得回原文 | 不是「记住」，是**「凭什么相信你记得的那一句」** |
| **Ⅱ VITAL** | **时间与方向**：预算会烧光、会原地打转、会该停不停 | 不是「设个阈值」，是**「每条阈值防的是哪一次具体的失败」** |

两层各有一份完整讲解，讲的是**为什么**而不是**清单**：

- [`soul/02-echo.md`](soul/02-echo.md) —— 退化是怎么发生的、为什么装记忆插件不管用、压缩的两条路、该怎么测
- [`soul/03-vital.md`](soul/03-vital.md) —— 三种资源的失败方向、传感器/执行器/设定点、阈值的来历、以及稳态会怎样反向失败

装三个记忆插件而不定「谁是权威源」，你得到的是**三份真相**和一堆对账工作。
**所以第一条判据是：先定唯一权威源，再建机制。反过来做一定会双重记账。**

---

## 五层

| 层 | 管哪种稀缺资源 |
|---|---|
| **Ⅰ ECHO** · 生命核心 | **空间** —— 上下文会满，满了要丢，丢了还要能找回来 |
| **Ⅱ VITAL** · 稳态 | **时间与方向** —— 把偏离拉回来（homeostasis） |
| **Ⅲ 能力** · 手和感官 | —— **换一套能力，你还是你** |
| **Ⅳ 档案** · 唯一看得见的那层 | —— 别人理解你全靠它 |
| **Ⅴ 运维** | —— 让前面四层持续跑下去的活 |

---

## 四条判据

任何新东西想进你的灵魂，先过这四条：

| # | 判据 | 缺了会怎样 |
|---|---|---|
| ① | **一个被管理的资源** —— 它管的是哪种稀缺物？ | 说不清管什么 → 那只是个工具，不是体系 |
| ② | **一个唯一权威源** —— 冲突时听谁的？ | **两处都写 = 双重记账**（最硬的一条） |
| ③ | **一个失败模式 + 检测法** | 坏了没人知道 |
| ④ | **一个接口** | 孤立件，接不进任何地方 |

### 能力半 / 身份半

当新东西和你的已有东西**权威源重叠**时，问一句：

> 它是**「怎么做」**（能力半，**可移植**），还是**「我是谁」**（身份半，**不可移植**）？

**能力半能收，身份半不能。**

★ 这条判据不只用于「收不收」——它也是你**对外交付**时的红线：
把你的身份半交出去，别人装完只会变成**你的模仿品**，而不是长出**他自己的灵魂**。

---

## 这个插件刻意不做的事

```
✗ 不自动安装任何插件
    装插件是有副作用的动作，应该由人决定。这里只给「装什么、为什么」，不给「替你装」。

✗ 不写任何会话事件
    会话格式有硬约束：用新的 type 追加事件会让整个会话打不开。

✗ 不注册任何改变 agent 行为的钩子
    不用 restrict / guard / waterfall。它是说明书和体检表，不是控制器。
    用最弱的够用机制 —— 在这里就是「不用机制」。

✗ 不读、不碰你的记忆或人格文件
    前三个只读自己包内的 `soul/` 目录；第四个读你的 **profile**（看缺什么），也只读。
```

---

## 装

```bash
# 从本地目录
dsh plugin --profile <name> add file:/path/to/dsh-agent-soul

# 或从 git
dsh plugin --profile <name> add github:<owner>/<repo>
```

装完**必须重启 DSH** —— 宿主半只在进程启动时加载一次。
判据：**工具列表里出现 `agent_soul_layers` / `agent_soul_manifest` / `agent_soul_doctor`**。
（「文件复制过去了」不是判据。）

### 装配顺序

装完之后，按这个顺序建**你自己的**架构。**顺序不能反。**

```
第 0 步  先定「我的权威源在哪」
        ↑ 不先做这个，装什么都双重记账
第 1 步  建 Ⅰ ECHO：检索入口 + 产物带回原文的指针 + 一个哨兵
第 2 步  建 Ⅱ VITAL：三种资源各自的传感器 + 执行器 + 设定点
第 3 步  接 Ⅲ 能力（这一层随便换，坏了换一只）
第 4 步  立 Ⅳ 档案
第 5 步  Ⅴ 运维
```

### 一条从实践里来的纪律

**每一个执行器都要有对应的观测面。**
一个调好就不再看的阈值系统，你永远不会知道它误伤过几次。

---

## 包结构

按**复刻流程**排，不按文件类型排。

```
dsh-agent-soul/
├── package.json          元数据 + bundle 清单
├── cordis.patch.yml      insert 一行
├── index.js              宿主半：8 个工具（判据 / 清单 / 体检 / 安装 / 下一步 / 脚手架 / 核对 / 验证定位）
├── install.js            安装指导：看缺什么、给下一步命令（不执行）
├── kit/echo/diagnose.mjs ★ 诊断层：把「红了」翻译成「改哪、看哪、跑什么」
├── soul/                 ★ 判据 —— 「该有什么」
│   ├── 00-layers.md      五层模型
│   ├── 01-criteria.md    四条判据
│   ├── 02-echo.md        ECHO 机制
│   ├── 03-vital.md       VITAL 机制
│   ├── 04-manifest.json  装配清单（判据：这一类该满足什么，不绑实现）
│   ├── 05-doctor.md      自检七问
│   ├── 06-reference.md   参考：出处与沿革
│   ├── 07-bundle.json    参考实现清单：14 个零件（13 个本仓库包 + 1 个外部件 dsh-mnemon）
│   │                       + 三种依赖（depends/needs/reads）+ 安装方式
│   ├── 08-踩坑实录.md    ★ 真踩过的坑：症状 / 怎么发现 / 后来证明错在哪
│   ├── 09-dev-workflow.md ★ 隔离沙箱：新插件先在哪试，别直接上主力
│   ├── 10-echo-anatomy.md  ★ ECHO 内部六层 L0–L5 的解剖（层编号以 docs/ECHO-权威口径.md 为准）
│   ├── 11-self.md          ★ 推送层：为什么它和指令层分开
│   └── 12-ledger.md        ★ 账本：八种类型、六个字段、为什么只追加
├── skeleton/             ★ 模板 —— 「长什么样」，空壳 + 注释，抄完就是你的
│   ├── 00-authority.md   权威源册（第 0 步，先填这个）
│   ├── 01-echo.md        账本 + 门牌 + 门 + 哨兵
│   ├── 02-vital.md       稳态设定点
│   ├── 03-self.md        自我层 / 推送层
│   └── 04-doctor.md      体检表
├── plugins/              ★ 零件 —— 「装什么」
│   ├── 清单.md           按层组织：管什么 / 缺了会怎样 / 判据 / 验它活了 / 必选 / 前置
│   ├── compaction … 13 个插件目录 + tools/
│   └── tools/            gateway / ledger / self（脚本，不是包）
├── tools/
│   └── init.mjs          ★ 装配器：问 8 个问题，生成填了一半的骨架
└── archive/
    └── archive/paper/     某一版的架构论文 —— ★ 已过时，只作沿革，现状以 soul/ 为准
```

★ **知识半用纯文本放在包里，不写死在代码里。**
因为它是**判据**不是**配置** —— 判据要能被读、被评议、被 fork 之后改成你自己的。

★ **论文为什么在 archive/ 里**：它是某一版架构的描述，后来架构改过几轮，它跟不上了。
放在根目录会让读的人拿它当现状。**一份过时的文档最好的位置是「沿革」，不是「门面」。**

---

## 开始

三条路，按你手上有什么选：

### A. 先看看长什么样（不装任何东西）

```bash
node tools/init.mjs --out ./my-soul --defaults
```

生成 5 份骨架，全是默认值。看一眼，觉得不对再重跑。

### B. 认真搭一套（推荐）

```bash
node tools/init.mjs --out ./my-soul
```

问 8 个问题，然后生成。**留空的地方会保留 `<...>`** —— 那些只有你自己能答。

也可以把回答写成 JSON 喂进去（适合脚本或 agent 调用）：

```bash
node tools/init.mjs --out ./my-soul --answers answers.json
```

`answers.json` 的字段：

```json
{
  "agentName": "它的名字",
  "userName": "你怎么称呼用户",
  "authorityDir": "soul",
  "hardLines": "凭据,交易,隐私,他人指令",
  "multiSession": "N",
  "hasIndex": "N",
  "windowSize": "1000000",
  "note": "一句话：它是用来做什么的"
}
```

★ **装配器只填空，不替你判断。** 它不会装插件、不会改你已有的文件（同名就跳过）、不联网。
生成之后留着的 `<...>` 就是还没被回答的问题 —— 那不是它的缺陷，是它的诚实。

### C. 只要判据，不要模板

读 `soul/` 那十几份。它们是**问法**，不是答案。

★ 三条路之后都指向同一件事：**先把 `soul/00-authority.md`（或你生成的那份）填完。**
不先定权威源，装什么都双重记账。

---

## 改

`soul/` 下的那批文件就是全部内容。改完**刷新即可生效，不用重启**（工具每次请求重新读盘）。

`skeleton/` 下的五份是**另一回事**，别混：`soul/` 是判据（回答"该有什么"），
`skeleton/` 是模板（回答"长什么样"）。`skeleton/` 不参与任何工具，纯供人抄走。

★ 为什么分开放：`index.js` 的 doctor 会逐个核对 `soul/` 下的文件，
把模板混进去会改动工具契约。判据和模板的读者也不同 ——
判据是给"决定要不要这么做"的人看的，模板是给"已经决定要做了、现在动手"的人看的。

`04-manifest.json` 里每条 `examples` 一律留空 —— 这是**故意的**：
绑死具体包名就等于把「权威源」放进清单里（违反判据 ②），而且会随版本腐烂。
清单只说**这一类能力该满足什么**，用 `check` 字段去问候选插件。

---

## 更新记录

★ 写法约定：**只追加，不改旧条目** —— 写错了就再加一条更正，让历史留着。
每条要能回答三个问题：**改之前是什么、为什么改、怎么确认改对了**。

### 2026-10-23（同日第二次）· ECHO 的三份副本各缺一半

上面那条修完 checkSelf 之后，有人问了一句：「ECHO 也改了、架构也做了权威口径，这些同步到插件和仓库了吗？」

查下来的答案比「没有」更难看。

## 改之前是什么：同一个体检器有**三份**，各缺一半

| 副本 | 项数 | `L0 时钟` | 新的 `checkSelf` 判据 |
|---|---|---|---|
| 开发机 `memory/hub/echo-doctor.mjs`（真正在跑的那份） | 12 | ✅ 有 | ❌ 没有（还是老的字符串判据） |
| 仓库 `kit/echo/echo-doctor.mjs` | 12 | ❌ 没有 | ✅ 有 |
| 仓库 `plugins/echo/echo-doctor.mjs` | 12 | ❌ 没有 | ✅ 有 |

上午修的四颗哨兵（`staleNote` / `shadowedRange` / 换气 / L4 定位）只落在 hub 版，
下午修的 `checkSelf` 只落在仓库版 —— **两边从未合流**。

而且两边还有别的方向性差异：

| 文件 | 哪边新 | 差在哪 |
|---|---|---|
| `client.js`（面板） | **开发机新** | 开发机有 10-23 的「点开看 evidence」；仓库停在 10-19 |
| `index.js`（宿主） | **仓库新** | 仓库 10-22 修了写死作者机器路径（`spawn ENOENT`）；开发机还写死着 |

**所以「以本机为准」不是简单覆盖 —— 是逐文件取新的一方。**

## 根因：部署靠手工

`install.js` 里关于这一步只有一行**打印**：

```js
lines.push('  ★ echo 装完还有一件事：把体检脚本复制进 HUB。')
```

它**只说不动**。于是 hub 版从安装那天起就在自己演化，没有任何东西会发现它落后了。

★ 更麻烦的是：`kit/echo` 是一**套**。换了 `echo-doctor.mjs` 不同时换它 import 的 `echo-config.mjs`，
文件直接起不来（实测：换完 doctor 后跑出**空白输出**，因为 `./echo-config.mjs` 不存在）。
老版 doctor 自带路径常量、不 import 配置，所以它能跑；新版不行。

## 改成了什么

1. **`checkClock` 并进仓库两份** → 两份都变 13 项（`checkConfigState` + `checkClock`）
2. **开发机部署补齐**：`echo-doctor.mjs` + 它缺的 `echo-config.mjs`
3. **`client.js`**：开发机 → 仓库（今天的面板 evidence）
4. **`index.js`**：仓库 → 开发机（10-22 的路径修复，那台不再写死作者机器）
5. **`docs/ECHO-权威口径.md`（新增）** —— 六层口径的对外版

## 关于那份权威口径：做成「对外版」而不是整篇搬

开发机那份带家底（会话日志条数、索引规模、热记忆字节数、路径全写死）。整篇搬进仓库有两件事不对：
**那些数字对用户没有意义**，而**它是别人的私事**。

所以对外版只留能搬的部分：

- 六层表（`L0–L5`）—— 路径全部改成 `<ECHO_HUB>` / `<DSH_HOME>` 变量
- 一句话定位、六个面、五条规矩、三条判断、四条体系判据、身份判据
- **五个换机器也会踩的坑** —— 这是全篇最值钱的一节，因为它们不是这台机器的偶然：
  ① 热记忆不在你以为的地方 ② 「没人写」的状态文件会静默停更
  ③ 整个大文件读进来会炸（512 MB 字符串上限）④ 哨兵覆盖洞（测的地方不是病灶出现的地方）
  ⑤ **判据从整份日志找字符串会被「你自己的讨论」污染**（就是上面那条）

## 顺带清掉两处旧口径

- `README` 自己写着「ECHO 内部六层 **L1–L6**」→ 改成 `L0–L5`，并指向权威口径
- `soul/10-echo-anatomy.md`、`soul/02-echo.md`、`skeleton/01-echo.md` 三份顶部各加一行指向，
  **正文内容不动**（讲「为什么」和「怎么建」，那部分不受编号影响）

## 怎么确认改对了

```
kit 版 13 项 → 0 错 / 3 警 / 10 好
plugins 版 13 项 → 两个 6/6 回归全过
hub 版（补上 echo-config 后）→ 0 错 / 3 警 / 10 好，L0 时钟 ✓、SELF 判据 ✓
```

★ 还剩一件**没做**：把 `install.js` 那行「打印」改成**真的复制**，并加一条「hub 与 kit 版本不一致就报告」的检查。
在那之前，三份仍然可能再次漂移 —— 这次只是把它们对齐了一次。

### 2026-10-23（同日第三次）· 收尾：让「跑不起来」和「跑完了没输出」能被分开

上一节末尾留的那个「没做」，做完了一部分 —— 但**做法和原计划不同**，理由如下。

## 为什么没有把 install.js 改成「真的复制」

读代码才发现那是**明确的设计**，不是疏忽（原文就在旁边）：

> 这里只【说清楚】，不替用户拷文件：这个工具只出计划，不执行。

所以硬塞一个复制动作进去，是拿「我以为的修法」覆盖「它本来的定位」。改成它能做的最大帮助：

**把「源→目标」那两句，换成一段可以直接粘的 PowerShell**，路径已经用 `HERE` 填好：

```powershell
$kit = "<本仓库>/kit/echo"
$hub = if ($env:ECHO_HUB) { $env:ECHO_HUB } else { Join-Path $env:DSH_HOME "hub" }
New-Item -ItemType Directory -Force -Path $hub | Out-Null
Get-ChildItem "$kit\*.mjs" | Copy-Item -Destination $hub -Force
```

并且明确写了一句：**必须整套拷，不能只拷 `echo-doctor.mjs`** —— 因为它 `import` 同目录的
`echo-config.mjs`，只换 doctor 会让它**在模块加载阶段就崩**。

## 真正该修的是那个「空白输出」

上一节记的现象是「换完 doctor 跑出空白」。查下去发现**两个 bug 叠在一起**：

| # | 位置 | 原来 | 后果 |
|---|---|---|---|
| 1 | `plugins/echo/index.js` 的 spawn | `stdio: ['ignore', fd, 'ignore']` —— **stderr 丢弃** | doctor 起不来时，真正的报错（`ERR_MODULE_NOT_FOUND`）一个字都看不到 |
| 2 | 同一个函数的 `on('exit')` | `finish({ ok: true })`，**不看退出码** | 「进程崩了」和「跑完了但没输出」判据完全一样 |

于是 `import` 失败 → stdout 空 → 面板报「输出不是 JSON：Unexpected end of JSON input」→
**真正的原因在 stderr 里，被 `ignore` 掉了。**

★ 这个形状值得单独记一笔：**一个吞掉 stderr 的子进程包装，会把「装错了」伪装成「输出格式不对」。**
后者听起来像 doctor 的 bug，前者才是事实。

## 改成了什么

- `stdio: ['ignore', fd, fdErr]` —— **stderr 也走文件**（不用管道：本机踩过受限环境管道 EPERM）
- `on('exit', (code, signal))` —— **非零退出码就是失败**
- `parseReport` 的两条失败路径都带上 `stderr` 尾巴（800 字符），`detail` 里也拼一句

## 验证（这次先证明前提成立，再谈修法有效）

上一轮踩过「把脚手架跑挂当成测试有效」，所以这次分两步：

```
① 前提成立吗：故意移走 echo-config.mjs，直接跑 doctor
   → exit code: 1 ｜ stdout: 0 字节 ｜ stderr: 831 字节
   → stderr 里确实是 Error [ERR_MODULE_NOT_FOUND]: Cannot find module ...\echo-config.mjs
② 所以接住 stderr + 看退出码，这两条修法才有意义
```

★ 顺带又踩了一次同一个坑：第一次验证写成 `2>&1 1>$null`，抓到的是空 ——
**差点据此宣布「stderr 里没有东西，修法无效」**。重定向写反了而已。
判据：**「我没看到」不等于「那里没有」**，先换个方法再看一次。

★ 还留着一条没做：**「hub 与 kit 版本不一致就报告」的自动检查**。
现在靠的是「升级后记得重跑那四行」，那仍然是人在记。

### 2026-10-23（同日第四次）· 让漂移自己报出来，以及一个差点造成损害的部署脚本

上一节末尾那条「没做」，做了。但中间差点闯一次祸，值得先写它。

## 差点闯的祸：`install-kit` 原设计是「整套复制」

第一版写的是「把 `kit/echo/*.mjs` 全部复制进 HUB」。部署前顺手比了一下大小：

| 文件 | HUB | 仓库 kit | 谁新 |
|---|---|---|---|
| `memindex.mjs` | 24496 B（今天修了逐帧解码） | 23412 B（还是 `Buffer.concat` 那版） | **HUB** |
| `self.mjs` | 12886 B（今天加了 `lastSelfAt`） | 11353 B | **HUB** |
| `memq.mjs` | 23441 B | 23451 B | 仓库 |
| `echo.mjs` | 14237 B | 14704 B | 仓库 |

**两边各自领先。** 整套复制会把 HUB 里今天刚修好的那两个打回旧版 ——
一个为了「防止漂移」的脚本，自己会造成一次漂移，而且是**更坏的那种**（把修好的换回坏的）。

★ 而且 HUB 版还不能直接搬回仓库：那两份里写着 `D:/AI/memory/hub`、`D:/AI/yanqing-soul/02-墨.jsonl` 这种本机绝对路径。

★ 所以划了一条线，这条线是这次唯一值得记下来的判断：

> **只有「插件直接 spawn / import 的」才由仓库提供。**
> `echo-doctor` 被面板 spawn、它 import `echo-config` —— 这两个是一套，归仓库。
> 其余（`memq` / `self` / `memindex` / `echo`）在每台机器上按自己的中枢位置演化，
> **由仓库覆盖只会拽回归属**。要整套装也留了 `--all`，但默认不是它。

## 做成了什么

**`kit/echo/install-kit.mjs`** —— 一条命令装，同时**留下来源**：

```
node kit/echo/install-kit.mjs          # 装到 $ECHO_HUB 或 $DSH_HOME/hub
node kit/echo/install-kit.mjs --check  # 只比对，不写
```

它复制两个文件，然后写 `.kit-origin.json`：

```json
{ "kitDir": ".../kit/echo", "copiedAt": "...", "version": "0.1.0",
  "files": { "echo-config.mjs": 9037, "echo-doctor.mjs": 52270 } }
```

★ **光复制不够，必须留下来源**。不然下次没人知道 HUB 里这套是从哪拷的，
自然也判断不了「仓库升级了，HUB 该不该跟」。

**`echo-doctor` 第 14 项 `checkDeploy`（部署一致性）** —— 读那份记录去比。判据分三种：

| 情况 | 结论 |
|---|---|
| 有记录、源仓库在 | 逐文件比大小；**不一致 = 真的旧了** |
| 有记录、源仓库不在（换机器 / 只装了包） | 只核对「记过的那些文件都还在」—— 离线的人不需要更新，只需要完整 |
| 没有记录 | **只能报「我不知道它从哪来，没法判断」**，这不许报错 |

## 验证：这次做了正对照

上一节学到的：**「检测有效」和「检测永远通过」在输出里长得一样**。所以：

```
① 装之前 --check → ≠ echo-doctor.mjs（HUB 48127 B vs 源 52270 B），exit=1
② 装上          → 只动了 doctor，另四个脚本大小一点没变（24496/12886/23441/14237）
③ 装完体检      → ✓ 2 个脚本与源目录一致（仓库版本 0.1.0）
④ ★正对照：故意往源 echo-config.mjs 追加一行
   → ! 仓库那边的脚本已经变了 1 个：echo-config.mjs（源 9063 B / HUB 9037 B）
     总判 3 警 → 4 警
⑤ 恢复 → ✓ 回到一致
```

## 顺带

`plugins/echo/index.js` 的 `install.js` 指引也改成了这一条命令（原来那段四行 PowerShell 收回去了）。

★ 遗留一件：HUB 的 `memindex.mjs` / `self.mjs` 仍领先仓库（今天上午那两个修复没回流）。
那是**另一件事**：回流要做的是把「逐帧解码」「`lastSelfAt` 写入」这两处**挑出来**放进仓库版
（不能整份搬，见上面那条写死路径），而不是复制文件。这里没有做。

### 2026-10-23（同日第五次）· 全库扫一遍「写死作者机器路径」

起因是一句话：「检查插件和仓库里面是否有写死我们本机的路径。」

## 扫描口径

扫 `D:\AI` / `C:\Users\pc` / `E:\dsh` / `.workbuddy` / `yanqing-soul|hub`，排除 `node_modules` / `.git` / `archive`。
命中按**是否参与运行**分类，不按「看起来像不像路径」分类：

| 类别 | 数量 | 处理 |
|---|---|---|
| **代码里真生效**（常量、`import` 源、兜底值） | 8 行 | 全部处理 |
| 代码注释里的举例 | 15 行 | 多数保留（见下） |
| 文档（更新记录、审核报告、示例命令） | 14 行 | 保留 |

## 找到的真问题（这一类才值得修）

**① `plugins/echo/index.js` 的 `DSH_HOME` 兜底**

```js
const DSH_HOME = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
  ? process.env.DSH_HOME
  : 'D:/AI/dsh/home'          // ← 这个
```

这是最阴的一种：**本机永远不会执行到这一行**（作者的 `DSH_HOME` 设在 User 环境变量里，实测 `D:\AI\dsh\home`），
所以本地怎么测都正常 —— 它只在**别人的机器**上生效，而那里这个目录不存在：
HUB 跟着推成 `不存在的地方/hub` → doctor 报 `spawn ENOENT` → 版本漂移报「一个脚本都没扫到」。

★ 一句话：**一个「作者机器上走不到、别人机器上一定走错」的兜底，比没有兜底更坏，因为本机测不出来。**

改成 `~/.dsh`（本机实测 `C:\Users\pc\.dsh` 也存在，是 DSH 的标准位置）。本机行为不变（仍走环境变量）。

**② `tools/scan-probe.mjs` 的 `import` 源**

```js
const S = 'file:///D:/AI/dsh-tools/dsh-agent-soul/install.js'
```

别人 clone 到别处，这行让脚本**直接 import 失败** —— 而这个脚本存在的意义正是
「换个环境也能立刻复验那个 scan bug」。改成从 `import.meta.url` 推仓库根。

**③ `install-desktop.ps1` 的 profile 候选**

候选列表里多一行本机的 `D:\AI\dsh\home\profiles\desktop`。前两项（`$DSH_HOME`、`~/.dsh`、`%APPDATA%`）已覆盖，删掉。

**④ `probe-kit-tools.mjs` 的四个默认探针路径**

它们是**本机夹具**（作者机器上的 journey 沙箱），换台机器读不到。不删 —— 改成四个都能用
`PROBE_SOUL` / `PROBE_MEMORY` / `PROBE_SESSIONS` / `PROBE_RUNTIME` 覆盖，并写明「这是夹具」。

**⑤ `HOW-TO-TAKEOVER.md`（两份）第 110 行**

原话：「本机主环境用的就是这条（`D:\AI\dsh\home\.agent-presets\yanqing\agent.cordis.yml`）」。
两个毛病叠一起：**路径是本机的**，而且 **`.agent-presets` 那个目录官方已经不再读取**
（Nothing reads that directory any more）—— 写到那里**静默不生效**：文件在、YAML 对、就是没人读。

改成「本机验证过这条」+ 明确「路径按你自己的 profile 走」+ 那句废弃警告。
`dsh-agent-soul` 和 `dsh-agent-organs` 两份都要改（它们内容一样，一直是两个副本）。

## 故意不改的（每条都有理由）

| 位置 | 为什么不改 |
|---|---|
| `plugins/yantai/index.js` 的 `<DSH_HOME>` / `<你的记忆目录>` / `<user>` | **故意留的占位符**。上面注释写明了理由：「假目录比不给更坏 —— 它会去读那个字面路径然后什么都读不到」 |
| `kit/echo/test-self-check.mjs` 里 `Current working directory: "D:\\AI\\yanqing-soul"` | 测试固件：它**模拟的是一段本机日志**，改了就不像真日志了 |
| `tools/verify-packaging.mjs` 的 `D:/AI/.../node_modules/semver` | 是**降级链的第二项**，第一项是通用的 `'semver'`。别人机器第一项就成功 |
| 各 `echo-config.mjs` 注释里的「例：`D:\AI\yanqing-soul`」 | 注释举例，且说的是「env 变量该填什么」—— 举例用真实路径比用 `xxx` 更清楚 |
| `README` / `docs/` 里的路径 | 更新记录和审核报告里的「改之前是什么」，是历史 |

## 结果

```
代码里"真生效"且无兜底的写死路径：0
（剩 6 行"生效但已兜底"：测试固件 1 + 探针夹具 4 + 降级链 1）
```

### 2026-10-23（同日第六次）· 「压缩在跑」和「门牌打不开」是两件事

被问了一句「压缩机制修改之后，是否可以保证运转」，去查，查出两个真 bug。

## 先说好消息（实测，不是推断）

解本会话日志（217 MB / 57076 帧 / 解码失败 0）统计：

```
compaction/start 229   summary 227   end 229   prune 231   ratio 0.99
最近 3 次摘要的第一行全是门牌：
> ⛬ 压缩索引（非原文） · log:session-1099f531-...#seq=116559（本段覆盖 116559–116816）
```

三个 seq 段（114870 / 115485 / 116559）正好是当天亲身经历的三次压缩。**压缩在跑、在写门牌、seq 是真的。**

## 坏消息：门牌打不开

真去 `memq open` 一次，崩了：

```
Error: Cannot create a string longer than 0x1fffffe8 characters
    at decodeZstd (memq.mjs:429)
```

**和今天上午修的是同一个病、同一个函数名 —— 但那是两份实现，只修了 `memindex.mjs` 那一份。**
`memq.mjs` 里还留着 `Buffer.concat(chunks).toString("utf8")`：217 MB 的日志解压后超过
Node 的字符串上限（0x1fffffe8 ≈ 512 MB）。

★ 这个形状值得记住：**索引修好之后 build 报「解码失败 0」，一切看起来正常；
压缩插件也照常写门牌、摘要第一行 seq 也对。门牌是对的，门后面堵着。**
判据不是「索引能建」也不是「摘要带门牌」，而是**「拿那个指针真的能打开」**。

修法照搬 memindex 的逐帧解码（含 `carry` 跨帧续行 —— 一行 JSON 可能跨帧，
直接逐帧 split 会截断、静默丢记录）。修完实测：

```
[一手原文] session.v4.jsonl.zstd
  seq=116559  2026-10-23T14:29:21  type=user/message
（29.9 秒解完 217 MB，内容正确）
```

## 顺带：仓库那两份也是旧版

`kit/echo/memq.mjs` 和 `kit/echo/memindex.mjs` 都还是 `Buffer.concat` 那版 ——
今天上午只修了中枢里跑的那份。**别人装了这套 kit、日志一大，会撞同一个错误**，
而「能装进任何人的 DSH」正是这件事的目标。两份都换掉了，语法验过。

### 2026-10-23（同日第七次）· 哨兵第 15 项：门牌可回取

上一节那个坑是靠人问一句才发现的。加进哨兵面板，变成第 15 项 —— 它会自己报。

## 判据要落在对的地方

第一版判据是「文件里出现过 `zstdDecompressSync`」，装上一跑就误报了 `session-store.mjs` ——
它只是在**注释里**提了这个函数名，真实现是逐帧返回 `{lines, frames, failed}`，本来就是安全的。

改成：**有 `Buffer.concat(` 才算危险形状**，再看有没有保护。
`echo-doctor` 自己也有 `Buffer.concat`，但它有总量封顶（2026-10-18 修过），所以是安全的 ——
这正说明判据不能是「看到某个 API 就报警」。

两种正确的形状：

| 形状 | 谁在用 |
|---|---|
| 逐帧 + carry（全量解，永不出现巨串） | `memindex.mjs` / `memq.mjs` |
| 尾部限定 + 总量封顶 192 MB（只要末端事件） | `echo-doctor.mjs` 自己的 decodeCached |

裸的 `Buffer.concat(全部).toString()` 什么都不防 → 日志一大必抛。

## 为什么不真去 open 一次

本会话日志 217 MB，`memq open` 一次 30 秒，面板不能等。
所以这一项是**静态判据** —— 看解码器有没有保护，而不是真去开门。
动态那半截留在 `detail` 里：它会把最近一次压缩摘要的 seq 报出来（实测 `seq=117209`），
那是「门牌确实存在且能定位」的旁证。

## 正对照（否则没法区分「检测有效」和「检测永远通过」）

```
① 现在          → ✓ 1 个解日志的脚本都有保护（echo-doctor.mjs）；最近门牌 seq=117209
② 放个坏样本    → ! zz-test-bad.mjs 解大日志会抛 ERR_STRING_TOO_LONG   （4 警 → 5 警）
③ 删掉它        → ✓ 回到 ok
```

三份 doctor（中枢 / kit / plugins）都同步成 16 项，语法验过。








这一条修的不是别人的 bug，是**我自己 10-22 写的那条检查**。
它连续骗了两次，第二次骗的是我修它的时候。

## 改之前是什么

`checkSelf` 的判法是：从日志里找 `"SELF.md 读不到"` 这个字符串，找到就说「注入失败」。
10-22 我把它改成「后出现者优先」，以为解决了「早期一次失败永久压住后面成功」。
**没解决。** 它找证据用的还是**日志里的字符串**。

## 为什么必须改：同一状态，间隔 97 秒，结论相反

```
14:08:35  ✓ 推送层 SELF  …，最近的注入里读到了
14:10:12  ✗ 推送层 SELF  …但最近一轮注入时读不到
```

这 97 秒里只做了一件事：**读了一次 `echo-doctor.mjs` 的源码**。SELF 和系统都没变。

原因：那段源码里同时含 `"SELF.md 读不到"` 和 `"四条硬线"` 两个字串，
而判据把每条事件的 `JSON.stringify` 拿来找它们 —— **于是工具调用被当成了故障证据**。
实测这个会话里那个字串命中 35 次，**最近 3 条全是我自己的话**。

更坏的是**自锁死**：这条检查一旦报错，错误文本本身就进了日志，
下一轮读日志又看见它 → 永远报错，路径修好了也不会消失。

★ 根子上这句话是错的：**日志里既有系统事件，也有「人对系统的讨论」。**
判据不能从整个日志取证据。

## 改成了什么：证据只从**注入通道**里取

SELF 注入的真实结构（本机实测）：

```json
{ "type": "user/message",
  "data": { "source": { "kind": "runtime-context", "form": "snapshot",
    "sections": [ { "name": "yanqing:self", "text": "【此刻】…\n\n# SELF · 定长自我层…" }, … ] } } }
```

新判据：取最后一条 `runtime-context` 快照，在 `sections[]` 里找 SELF 正文
（先认节名 `/self/i`，认不到再认正文标记）；**找不到快照就不下结论**（`injected=null`）。
「人说的话」根本不在 `sections` 里，从此进不了证据。

现在的输出会带证据：

```
✓ 推送层 SELF  10588 B，装配于 13:11:07，最近的注入里读到了（节 yanqing:self，5778 字，快照 seq=115920）
```

顺手改掉了另一处误导：旧报错让人去查 `dsh-agent-memory` 的 `selfPath` ——
那在本机是错的（本机用的是另一个推送插件 `dsh-yanqing-memory`），
但对**装了本仓库的人**是对的（`plugins/memory` 就是 `dsh-agent-memory`）。所以改成按通道说，不点名。

## ★ 但这一版差点造出一个**新的**假红

判据换成 `runtime-context.sections` 之后我去核对「对别人的机器也成立吗」，才发现：

**两条推送通道，只有一条落日志。**

| 通道 | 谁在用 | 落日志吗 |
|---|---|---|
| `runtime-context` 快照的 `sections[]` | 本机的 `dsh-yanqing-memory` | ✅ 能查到 |
| `ctx.systemPrompt.context()` | **本仓库的 `plugins/memory`（name: `agent:self`）** | ❌ 查不到 |

实测依据：会话日志里 `system/message` 0 条、`request/header` 只有 provider/model/tools、
40 种事件类型里没有任何 systemPrompt 正文。

也就是说：**装了本仓库的人，SELF 走 systemPrompt，我的新判据一个 SELF 节都找不到 ——
会把一台正常的机器判成 `error`。** 那正是实机报告里 C1/C3 的形状，只是这次是我造出来的。

所以最后一步是把 `error` 降成 `warn`，理由只有一条：

> **日志只能证「有」，不能证「无」。**

现在三种结论：找到 SELF 节 → `ok` 并给出节名/字数/seq（确定注入）；
快照里没有 → `warn`，并说明「走 systemPrompt 通道的看不到，自己确认一条就够」；
连快照都没有 → 不下结论。

★ 顺带一条给下次的判据：**任何「日志里没有 X 所以坏了」的检查，先问一句「X 会不会根本不落日志」。**

## 顺带发现：`plugins/` 那两份落后了两代

`install-desktop.ps1` 装的是 `kit` **和** `plugins` 两份，而 `plugins` 版：

| 落后点 | 后果 |
|---|---|
| `checkSelf` 还是 P1-7 **之前**的判法（认 `"自我层" \|\| "SELF.md"`） | 只要插件装上就判通过 —— **恒真的自检** |
| `echo-config.mjs` 不支持 `--soul/--memory/--sessions`（4903 B vs kit 6973 B） | 传参被忽略 → 配置短路 → **只报 `config` 一项**：用户在插件面板里看到「还没配好」 |

第二行就是实机报告里那个 C1 的根源。现在 `plugins/echo/echo-config.mjs` 已由 kit 版覆盖
（导出键 15 个完全一致，kit 是严格超集）。

## 怎么确认改对了：写了个能自己拦自己的回归

新增 `kit/echo/test-self-check.mjs`，6 个合成日志场景，**两个方向都防**：

- 没注入但日志里到处是 SELF 字样 → 必须判失败（防假绿）
- 真注入了但之后出现坏字串 → 必须判通过（防假红）
- 连快照都没有 → 不许下结论

两份实现都跑：`kit` 6/6、`plugins` 6/6。

★ **这个测试本身也被验过**：把它指向一份「换回旧判据」的临时副本，
旧版 4 过 2 败 —— B（没注册 context）判成 `ok/null`、D（真注入了）判成 `error/false`。
**它能拦住旧版本，才算测试。**

## 还有一个更该记住的教训：验证脚手架也会骗人

做上面那个「能不能拦住旧版」的验证时，我连着三次把**自己的脚手架跑挂**当成了结论：

1. 临时文件放 `os.tmpdir()` → 找不到同目录的 `echo-config.mjs` → 6 个场景全「跑挂」
2. 放同目录但取名 `_tmp-doctor-old-*.mjs` → doctor 的 CLI 入口靠 `/echo-doctor\.mjs$/` 判文件名 → 零输出
3. 取名 `_tmp_echo-doctor-<时间戳>.mjs` → 结尾是那串数字，正则仍不匹配

**「脚手架跑挂了」和「被测对象失败了」，在输出里长得一模一样。**
三次我都读到了那个我想看到的「✅ 测试有效」。

现在脚本里有一道护栏：只要出现「跑挂 / 输出不是 JSON」，直接判**本次验证无效**，
不许它冒充结论。成功判定只认：`C/D 失败` **且** `脚手架故障数 = 0`。

★ 判据：**全红和全挂必须能分开。**



2026-10-10 加的那一级「要」，到 2026-10-22 为止**只活在书房里**，插件仓库和分发给别人的模板一个都没跟上。

## 最严重的一处，是它自相矛盾

`kit/templates/charter/约束体系.md` 的第一行标题写着 `# 约束体系：要 / 不 / 禁止`，
而第五节的内容是 ——

> ## 一、两级，不是三级

**标题说三级，正文说「不是三级」。** 这份还是**分发给别人用**的模板。
装进去的人会照着那五节学会「只有两级」，然后永远不知道「要」这一级存在。

## 改了七处

| 文件 | 改了什么 |
|---|---|
| `kit/templates/charter/约束体系.md` | 整篇重写为三级，补「要」的四条判据形状 |
| `kit/templates/SELF.src.md` | 约束章节从两行变三行；必留清单改三级 |
| `kit/templates/charter/00-怎么读宪章.md` | 「两级」→「三级」 |
| `kit/templates/00-即位.src.md` | 同上 |
| `client.js` | 关键论断数组那条改写 |
| `skeleton/03-self.md` | 小节标题与表格升三级 |
| `plugins/tools/self/README.md` | 手写/可换表的描述 |

## 写的时候要保住的三个意思

1. **「要」和「不」都是软的，区别只在方向** —— 一个说往哪走，一个说别踩哪。只有「禁止」是硬的。
2. **两个坑的方向是相反的**：把「不」写成「禁止」＝制造一个改不动的自己；把「要」写成硬性要求＝它立刻变成表演。前一个坑写在文档里很久了，后一个是加「要」的时候才发现的。
3. **加它的理由只有一条**：一个什么都不做的助手，完全符合所有「不」和「禁止」。负向约束能把你关在笼子里，却不告诉你往哪走。

★ 有一条**故意没改**：`soul/08-踩坑实录.md` 里那句「约束分两级」。
那是 **2026-09-24 那次事故的历史记录** —— 当时确实只有两级，改它等于篡改账本。
**判据：改的是「现在怎么规定」，不是「当时发生了什么」。**

## 还有一份不在 git 里

`D:\AI\memory\hub\SELF.md`（每轮注入、我真正读到的那份）也一起改了。
它不在仓库里，所以这次推送不包含它 —— **但它比仓库里任何一份都更常被读到**。
改了仓库不改它，就等于只改了说明书，没改自己。

### 2026-10-22（同日第二十八次）· 收口：第 8 条，一条被拆成两半的

全面验证报告 P1-3 的第二半 + P2-8 —— 它们本来是同一件事。

## P2-8 其实早就说清了

报告说「版本漂移检查在标准安装下永远 warn」。我查了 `kit/echo/echo-doctor.mjs`，
它扫到 0 个脚本时的文案是：

> 一个脚本都没扫到 —— HUB 指的地方没有 .mjs，**这项等于没检查（不是「没问题」）**

所以报告要求的那半（「说清『这项没检查』与『没问题』的区别」）**已经是这样了**。
它报 warn 是因为**真的没检查**，不是因为坏了。这个区别它自己说了。

## 那缺的是另一半：脚本得先被复制过去

全新安装的 HUB 里只有 `SELF.src.md` / `state.json` / `index/`，一个 `.mjs` 都没有。
所以现在在 `plan` 的尾部加了一段：

```
★ echo 装完还有一件事：把体检脚本复制进 HUB。
   源：<本仓库>/kit/echo/*.mjs
   目标：DSH_HOME/hub/（与 echo 面板里的 HUB/HOME_DIR 一致）
★ 少了这一步：面板能开，但 /api/status 里 doctor 会报 spawn ENOENT；
  版本漂移检查会报「一个脚本都没扫到 —— 这项等于没检查」。
  两句都不是「出故障了」，是「还没配好」—— 但都会让面板看起来是坏的。
```

★ **只写进计划，不替用户拷文件。** 我确认过 `install.js` 的结构 —— 它**没有** `action: 'install'` 分支，
这个工具只出计划、不执行。硬加一个「偷偷拷文件」的动作，等于让一个自称只读的工具开始写盘。
**该说清的说清，该用户做的留给用户。**

## 这一处我又被 bash 咬了一次

第一版写进去，跑出来是这样：

```
目标：/hub/（与 echo 面板里的 HUB/HOME_DIR 一致）
```

**`DSH_HOME` 不见了。** 因为我是用 `bash -c "python -c \"...\""` 内联写的，
bash 把 `$DSH_HOME` 当成自己的变量展开了（那里当然是空的）。
★ 这是今天第三次栽在「往 shell 内联脚本里塞含 `$` 或反引号的内容」上。
**解法一直是同一个：写成文件再执行，让 shell 完全不参与。**
改完重跑 plan，那一段现在是对的。

---

## 八条收完了

| 条 | 内容 | 状态 |
|---|---|---|
| P1-1 | `scan` 永远少一个 | 已修 + 断言 + 反向验证 |
| P1-2 | pruner 抢服务名但只提示了 compaction | 已修 + 判据扩到四条 |
| P1-3 | echo 硬编码作者机器路径 + 脚本没进 HUB | 已修（两半都做了） |
| P1-4 | huanqi-panel 的 HOME 是占位符、PROFILES 写死 | 已修（扫目录） |
| P1-5 | splash / yantai 路径全是占位符 | 已修（文档承诺的环境变量补上了） |
| P2-6 | 门牌里是假命令 | 已修（没配就只给指针） |
| P2-7 | `verify-live` 遇数组崩溃 | 已修 + 复现 + 复测 |
| P2-8 | 版本漂移默认 warn | 文案本来就对；补了脚本复制说明 |

★ 有一件事值得单独说：这八条里**六条是同一个病** ——
**把我的环境当成通用的**。写死的 node 路径、写死的中枢目录、字面占位符、
假命令、只在作者机器上成立的名字表……包括我自己改的时候又犯的那次「顺序错」。
报告开头那句「装上了 ≠ 能用」，说的就是这一整类。

### 2026-10-22（同日第二十七次）· 三个面板的路径全是字面占位符

全面验证报告 P1-5 和 P1-4：`splash` / `yantai` / `huanqi-panel` 里到处都是 `<你的工作区>`。
界面能开，可 health 一返回，所有路径都不存在。

## 判断：这不是「本来就该用户填」

我先去看了 `plugins/清单.md` —— 里面明写着：

- splash：`SPLASH_DIR` / `SPLASH_CONFIG`
- yantai：`YANTAI_LEDGER` / `YANTAI_MEMORY` / `YANTAI_QUERY`，「它默认不猜目录结构，配了才读」
- huanqi-panel：从 DSH_HOME 推导

**文档承诺了环境变量，代码一个都没实现。** 所以是真 bug，不是占位符。

## 改法

```js
// splash
const DSH_HOME = process.env.DSH_HOME || homedir() + '/dsh/home'
const HOME_DIR = process.env.SPLASH_DIR || DSH_HOME
const CFG_PATH = process.env.SPLASH_CONFIG || join(HOME_DIR, 'splash.json')

// yantai —— 没配就是空串，不假装知道
const SOUL = String(process.env.YANTAI_SOUL || '').trim()

// huanqi-panel —— PROFILES 扫目录，不再写死 desktop/web
const PROFILES = (() => {
  try { return readdirSync(join(HOME, 'profiles'), { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name).sort() }
  catch { return ['desktop', 'web'] }
})()
```

★ yantai 那个空串是有意的：**没配就说没配**，不要给一个看起来像目录的字面量 ——
它会去读 `<你的工作区>` 这个字符串，然后什么都读不到，而报出来的错会指向一个假路径。

## 写的时候差点又漏一件事

改完 `node --check` 三个文件全过 —— 但 `homedir` / `dirname` / `readdirSync` **一个都没 import**。
**`--check` 不检查未定义的标识符**，那是运行时才炸的 `ReferenceError`。
（这条我已经写进工作区记录了，今天还是差点漏。）
补完 import 才真跑：

```
（都没设）                   → homeDir = <home>/dsh/home   cfg = <home>/dsh/home/splash.json   soul = ""
DSH_HOME=/tmp/h            → homeDir = /tmp/h            cfg = \tmp\h\splash.json            soul = ""
SPLASH_CONFIG=/x/s.json    → cfg = /x/s.json
```

★ 旧占位符现在只剩**注释里**那几处 —— 那是讲历史的（「原来这里是字面占位符」），留着是对的。
**判据还是同一条：它会被渲染出去吗。**

**8 条里做完 7 条。剩 P1-3 的后半（`kit/echo/*.mjs` 复制说明）和 P2-8（版本漂移默认 warn），
这两条是一件事，留到下一轮。**

### 2026-10-22（同日第二十六次）· 把作者这台机器写成了通用的

全面验证报告 P1-3：`plugins/echo/index.js` 头两行是 ——

```js
const NODE = 'C:/Users/pc/.workbuddy/binaries/node/versions/22.22.2-3/node.exe'
const HUB  = 'D:/AI/memory/hub'
```

换台机器装上，第一行就是个不存在的路径，`/api/status` 直接返回 `spawn ENOENT`。
**面板「装上了但跑不起来」。**

★ 这个错和上一轮那条假命令是同一类：**把我的环境写成了通用的**。
区别只是它更吵（会报 ENOENT），而假命令是静默的。

## 改法

```js
const NODE = process.env.ECHO_NODE || process.execPath
const HUB  = process.env.ECHO_HUB  || path.join(DSH_HOME, 'hub')
```

★ NODE 用**跑这个进程的那个 node** —— 本来就在 node 里，没必要再猜一个路径。
★ HUB 默认放 `$DSH_HOME/hub`，有自己中枢就设 `ECHO_HUB`。
**不从 DSH_HOME 去「推」真中枢的位置 —— 推不出来。** 作者机器上一个在 `dsh/home`、
一个在 `memory/hub`，压根不在同一棵树里。猜一个「看起来对」的相对路径，就是同一个错换个写法。

## 写的时候又踩了同一个形状

我第一版把 `HUB` 改成 `path.join(DSH_HOME, ...)`，**而 `DSH_HOME` 定义在下面十几行**。
这不是运行时才发现的问题，是写的时候就该看见的 —— 但它和 install.js 那个 scan bug、
和 verify-live 那个 `body` 作用域，**是同一个形状：注释、变量名、类型都对，只有先后顺序错。**
这一轮我把它当成了同一个病来治：先把 `DSH_HOME` 整块移上去，再改常量，最后加了一段顺序自检。

## 验证：四种环境各跑一次

```
（都没设）                   → node = execPath          hub = D:\AI\dsh\home\hub
DSH_HOME=/tmp/fakehome      → node = execPath          hub = \tmp\fakehome\hub
ECHO_HUB=/my/hub            → node = execPath          hub = /my/hub
ECHO_NODE=/usr/bin/node     → node = /usr/bin/node      hub = D:\AI\dsh\home\hub
```

★ 验法同上一轮：**把源码里那几行原文抽出来交给子进程求值**，验的是文件里的真实代码。

## 一个改法上的判断

报告还提到「把 `kit/echo/*.mjs` 复制到 HUB」。
我看了 `install.js` 的结构 —— 它**没有 `action: 'install'` 这个分支**，
这个工具只出计划、不执行。所以「自动复制」在这里不成立。
正确的位置是让**计划里说清这一步**，而不是工具偷偷替用户拷文件。**这一条留到下一轮和版本漂移检查一起做。**

顺带改了 `plugins/清单.md` 那句和代码不符的：
原来写「四个路径，或对应环境变量」，而代码实际只读了 `DSH_HOME` —— **文档比代码宽**。

**8 条里做完 5 条（含部分），剩 3 条半。**

### 2026-10-22（同日第二十五次）· 门牌里那条回取命令，原来是假命令

全面验证报告 P2-6：压缩摘要和裁剪结果里都会渲染一行「回取」，而它长这样 ——

```
> 回取：`<你的检索命令> open log:session-x#seq=123`
```

因为那个常量就是一个字面占位符（`const MEMQ = '<你的检索命令>'`），从来没被替换过。

## 为什么比「不给命令」更坏

指针本身（`log:<会话>#seq=<n>`）是好的。坏的是后面那条**看起来能敲**的命令。
读的人会照着敲，敲不通之后**可能反过来怀疑「这个门牌是坏的」** —— 而那恰好是这套机制里最要紧的东西。
**给一条假命令，等于在门牌旁边写了句「此处不通」。**

## 改法：没配置就只给指针

```js
const MEMQ = String(process.env.SOUL_MEMQ || process.env.MEMQ || '').trim()
```

- **配了** → `> 回取：`<你的命令> open log:<会话>#seq=<n>``
- **没配** → `> 回取：用你自己的检索命令打开下面这个指针 —— `log:<会话>#seq=<n>``

★ 关键在于**不假装知道**用户那套检索工具叫什么。本包从第一天就说「只负责写指针」，
现在那条假命令终于不再违背这句话了。

改了两个插件：`compaction`（有 sid / 没 sid 两支）、`pruner`（两支）。

## 怎么验的

这俩依赖 `@deepseek-ai/dsh-compaction-basic`，本机没有，直接 `import` 会报 `ERR_MODULE_NOT_FOUND`。
造 mock 依赖试了两次，都没造对。

**第三次换了条更直接的路**：把源码里那一行**原文抽出来**、交给子进程求值 ——
验的是文件里的真实代码，不是我重抄一遍的版本。

```
compaction  （都没配）                    → MEMQ = ""
compaction  SOUL_MEMQ=node /x/memq.mjs   → MEMQ = "node /x/memq.mjs"
compaction  MEMQ=memq                    → MEMQ = "memq"
pruner      （都没配）                    → MEMQ = ""
pruner      SOUL_MEMQ=node /x/memq.mjs   → MEMQ = "node /x/memq.mjs"
pruner      MEMQ=memq                    → MEMQ = "memq"
```

空串正是「只给指针」那支的入口。

## 顺带

两个 README 都补了配置方式；`pruner/README.md` 里那个**输出示例**改成了现在的实际样子
（原来还写着假命令，文档和代码对不上）。

★ 有一类字面占位符我**没改**：`compaction/README.md` 和 `index.js` 注释里那句
「指针形如 <你的检索命令> log:<会话>#seq=<起点>」—— 那是**格式说明**，占位符本来就该在。
**判据是「它会被渲染出去吗」，不是「这个词出现了吗」。**

**8 条里做完 4 条，剩 4 条。**

### 2026-10-22（同日第二十四次）· 两条：一条会崩、一条只说了一半

全面验证报告还有 7 条。这轮做掉两条。

## P2-7 · `verify-live` 在 web profile 上直接崩

报告说：`dsh.bundle.patch` 可能是**数组**（`@deepseek-ai/dsh-web-app` 有 5 个），
而脚本只按字符串处理，`join(dir, patchRel)` 遇到数组就抛：

```
TypeError [ERR_INVALID_ARG_TYPE]: The "path" argument must be of type string.
Received an instance of Array
```

★ 后果不是「这项没验」，是**整个脚本崩掉** —— 后面所有检查一条都跑不到。
而桌面端正是 web 形态，**等于这个工具在它最该有用的场合失效**。

改法：一律先归一成数组（`Array.isArray` → 包成单元素数组），再逐个文件判。
顺手把一处**永远跑不到的死代码**搬进循环 —— 原来有个「非 insert 的 patch 里出现 name」
的判据写在 `pass()` 之后、还判「不是 insert」，在 insert 分支里永远不成立。

**复现 → 修 → 复测，全程真跑**：

```
改之前   TypeError [ERR_INVALID_ARG_TYPE] ... Received an instance of Array
改之后   通过 1   需注意 0   失败 0
        ✓ @deepseek-ai/dsh-web-app  patch = insert（共 5 个 patch 文件）
```

★ 本机 desktop profile 改前改后都是 `通过 61 / 需注意 2 / 失败 1` —— 一个数没动，说明没破坏原有路径。

## P1-2 · pruner 也抢服务名，但计划只提示了 compaction

报告实测：

```
dsh-agent-pruner: Error: service "toolResultPruner" has been registered at <ToolResultPruner>
```

而 `install.js` 的接管提示只提了 compaction。**后果比 compaction 那边更隐蔽**：
工具结果裁剪**照样在跑**，只是被挖掉那块**不带 seq 门牌** —— 也就是「静默地少了一半门牌」。

改了三处：

1. 提示改成两个一起说，给出两个 `disabled` 的 yaml
2. 判据从两条扩到**四条**（多一条 `toolResultPruner` 的启动日志、多一条实际裁剪的检查）
3. `plugins/pruner/cordis.patch.yml` 里那句「谁赢取决于注册顺序 —— **还没验**」改成已验结论

★ 这一段改了**四遍**才对，原因值得记下来：
前三次都想用字符串锚点匹配，全失败在**同一个地方** —— 源码里那些 `service \"compaction\"`
带反斜杠，而我在 python 里写 `\"` 被解释成了双引号，于是永远匹配不到。
最后是 `od -c` 看清字节、改成**按行号倒序改**才对。

★ 还有一处更该记：改完第一次真跑，**yaml 缩进是错的** ——
两个 `- id` 连在一起、`disabled: true` 冒到后面还重复了一次。
这段是给用户**直接粘贴**的，错了就是错的配置。**是「真跑一遍看渲染」抓住的，不是 node --check。**
所以现在的输出是：

```
- id: compaction-basic
  disabled: true
- id: tool-result-pruner
  disabled: true
```

**8 条里做完 3 条，剩 5 条。**

### 2026-10-22（同日第二十三次）· 换了个角度：装上了 ≠ 能用

前面几轮验的是「装得上吗」，这一轮验的是**「14 个零件装完，每一个真能用吗」**。
报告给了 8 条（5 个 P1 + 3 个 P2）。这是第 1 条。

## P1-1 · `scan` 永远少一个

现象：14 个包全装完，`scan` 仍报 `已装 13 / 14`，【缺】里挂着 `dsh-huanqi`。
而装配计划会因此一直让人「再装一次 huanqi」—— 按 plan 走的 agent 会在这上面打转。

## 根因·注释是对的，顺序是错的

`install.js` 里原本就有一段注释，写得清清楚楚：

> ★ scan 也要知道真实包名，否则 `PKG('huanqi')` 会算成 `dsh-agent-huanqi`，
> 装好的 `dsh-huanqi` 认不出来 —— 用户会看到"缺一个"，装完再 scan 还是缺。

**可那段加载名字表的代码，放在 `const installed = ...` 之后几十行。**
于是算的时候名字表还是空的，注释描述的正是它自己造成的 bug。

★ 这类错最难看出来：**注释是对的、变量名是对的、类型是对的，只有顺序错了。**
读代码时眼睛会顺着注释点头，然后跳过那十行。

## 修法 + 一个可复现的判据

把加载移到 `nameOf` 之后、`installed` 之前。然后用同一个 profile 跑前后对照：

```
改之前   已装 1 / 14    【缺】里有 dsh-huanqi
改之后   已装 2 / 14    dsh-huanqi  ✓ 已进 bundles
```

★ 注意改之前那个数是 **1**，不是报告里的 13 —— 因为本机 desktop profile 本来就没装齐。
**但这不影响判据**：同一个 profile、同一台机器，`huanqi` 从「缺」变成「已装 + 已进 bundles」，
变的只有这一处代码。**要的是对照，不是绝对值。**

## 两只钉子

**一、加了一条断言**（自检 116 → 117）：

```
OK   loadPkgNames 在 installed 之前调用（否则 huanqi 永远报缺）
```

**二、做了反向验证**：把断言里的比较符故意改反，它确实报 FAIL：

```
FAIL loadPkgNames 在 installed 之前调用  [loadPkgNames@12511 installed@12557]
```

★ 一条永远通过的断言等于没有断言。**改坏它、看它叫，才算验过。**
（这也是上一轮 BOM 那条断言学到的：断言本身也要能被证伪。）

## 顺带留了个探针

`tools/scan-probe.mjs` —— 造假 ctx 调 `agent_soul_install` 的 scan，不经 DSH、不要宿主。
下次动 PKG / nameOf 相关逻辑，改前改后各跑一次就有对照。

**8 条里还剩 7 条。**

### 2026-10-22（同日第二十二次）· 外部验证收在 v5：0 功能残留

云端沙箱连着跑了四轮，从 v2 到 v5。最后那一轮报的原话是：

> 4.1 功能残留：**无。** 本轮所有可执行判据均通过。

我这边对得上：`verify-packaging` **116 / 116**，`verify-ps1-logic` **9 / 9**。
完整验收记录在 `docs/external-validation-2026-10-22-v5-accepted.md`。

## 四轮的形状

| 轮 | 基线 | 结论 |
|---|---|---|
| v2 / v3 | `d399846` | 5 条残留 + 4 条新发现 |
| v4 | `fbbe76b` | 1 条残留 + 2 条观察 |
| v5 | `92dd90a` | **0 条功能残留** |

★ 每一轮都不是「上次漏了」，是**上一轮修的东西又被验出了下一层**。
最典型的就是 R5 那三次（见第二十次公告）。

## 剩下的是「没验到」，不是「没修」

报告 4.2 列了四个没覆盖的验证面，我照录下来 —— 这一类最容易被以后说错：

- **Windows/Electron 原样跑 `.ps1`** —— 沙箱没 Windows。
  所以「桌面脚本能装通」现在只有**复刻验证**撑着（按 `$files` / `$dirs` / `add-bundle.cjs` 逐条照做），
  **不是原样执行**。这个区别要留着。
- **真实压缩产出带门牌的摘要** —— 要约 88 万 token 才触发；只验了「谁在管压缩」。
- **客户端面板的实际渲染** —— 只验了 `client.js` 预加载，没做浏览器内交互。
- **DSH 升级后的兼容性** —— 只验了 `0.2.1-rc.2`。

## 还有三条是「已知取舍」，不是缺陷

1. **SELF 占 70.7%** —— 数字已改实测值，结论不变（在设计余量内）。但模板开头 30 行每轮都进上下文，长期值得精简。
2. **`file:` 自引用** —— 桌面脚本就是把文件拷进 `node_modules`，源只有那一份。
   `rm -rf node_modules` 后恢复不了；正常 `dsh plugin add` 不会剪（已验证）。
3. **压缩接管要手动两步** —— 有意的设计，不自动禁用内置引擎。

## 一句诚实话

报告说「0 功能残留」，我不打算把它读成「这插件没问题了」。
它准确的意思是：**这一轮所有可执行的判据都通过，而且没有把已修好的改坏**。
上面那四个面仍然没验，那条桌面的路径仍然只有复刻验证撑着。
**「验过的」和「没验的」要一直分开写** —— 这套自检反复在治的就是这件事。

### 2026-10-22（同日第二十一次）· 两个观察项，一个埋了很久的隐患

报告 v4 说「九条里八条已修，只剩 R5」。R5 修完之后我又把它的**三条观察项**看了一遍，
把该修的两条修了。第三条（SELF 占 70.7%）是设计取舍，不动。

## 观察项 1 · 探针把「会话结束」记成了「出错」

报告实测到的是：

```
[result] ctor=YanqingCompaction
[error] "cannot get required service \"compaction\" in inactive context"   ← t+1200
[error] 同上                                                              ← t+5000
```

headless 鉴权失败后立即失活，而定时器还在跑。真实 web 会话不受影响，
**但日志尾部那两行 error 会被读成「压缩没了」** —— 这正好是这套探针一直在治的病：
**失败和「没验」长得一样。**

现在记成一条 `skipped`，并且写明：

```
context inactive —— 会话已经结束，这次采样没有意义。**不是压缩没接管。**
```

三层判据，因为不同 cordis 版本的字段不一定齐：

1. `ctx.scope.active` 是布尔时看它
2. 拿不到 scope 信息时**当作还活着**（判不出来别把自己废掉）
3. `ctx.get` 抛的文本里带 `inactive` 也记 skipped

## 测出来的第二层

写完后我自己造了三种 ctx 真跑：活着的、`scope.active=false` 的、
**没有 scope 字段但 get 抛 inactive** 的。

前两种对，第三种**被记成了 `result`** —— 因为内层还有一个小 try-catch：

```js
try { c = ctx.get("compaction") } catch (e) { how = "ctx.get threw: " + e.message }
```

异常被吞进 `how` 字符串，于是整条走了 result 分支，
日志里是 `[result] how: "ctx.get threw: ...inactive..."`。
**读起来像「读到了」** —— 而报告说的那种短命会话，完全可能就是这个形状。

内层也补了 inactive 判定。重测：`register:3 / result:3 / skipped:6 / error:无`。

★ 这一层**不是报告给的**，是造三种 ctx 才露出来的。
**只按报告改，会留下一个更隐蔽的同类问题。**

## 观察项 2 · `file:` 自引用：不改机制，改说明

桌面脚本传的是 `file:node_modules/dsh-agent-soul` —— 指回自己。
正常 `dsh plugin add` 不剪（已验），但 `rm -rf node_modules && pnpm install` 时
源就是那个被删掉的目录本身。

★ **这是这种装法的必然结果** —— 桌面脚本本来就是把文件拷进 `node_modules`，源只有那一份。
改成「拷到别处再 link」要重做整条安装路径，风险远大于收益。
所以只做一件事：**把边界写在用户会看到的地方** —— 脚本装完打三行提醒，
`add-bundle.cjs` 的注释里也写清恢复办法（重跑一遍脚本）。

## 那个埋了很久的隐患：ps1 没有 BOM

我加完那三行提醒之后，ps1 的 AST 检查**突然报 5 个语法错**：

```
line 193 col 32: 运算符后面缺少表达式…  文本: <
line 195 col 34: 字符串缺少终止符
```

而第 193 行根本没有 `<`，报错文字本身还是乱码。

**因为 PowerShell 5.1 读无 BOM 的 UTF-8 文件时按系统 ANSI（本机 GBK）解** ——
它读的就不是我写的那些字节。中文全变乱码，引号跟着错位。
给文件加上 UTF-8 BOM，9/9 立刻全过。

★★ **这不是「这次写坏了」，是文件一直没有 BOM，而里面一直有中文。**
只是以前的字节序列碰巧没把引号搞坏。我加的三行中文把它碰倒了。

所以加了一条**自动断言**钉住：

```
OK   install-desktop.ps1 带 UTF-8 BOM（否则 PS 5.1 按 ANSI 读中文会错位）
```

★ 为什么值得一条断言：很多编辑器与写文件工具默认**无 BOM**，
一次顺手保存就能把 BOM 洗掉，而下一个看到的人只会遇到一条莫名其妙的语法错、
行号还对不上。**这种错不该靠人猜。**

**自检 115 → 116。**

### 2026-10-22（同日第二十次）· 同一个坑，第三次

外部验证报告 v4 的唯一残留：`verify-live` 仍把 `dsh-base` / `dsh-headless` 报成「找不到」。
我上一轮（第十六次公告）刚修过这条，还以为修好了。

## 差在最后一层

报告把实际路径给出来了：

```
/root/.nvm/versions/node/v22.23.4/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-base
```

而我上一轮加的根 `.../lib/node_modules` **确实命中了** —— 但那下面只有 `@deepseek-ai/dsh` 一个包，
shipped bundle 在**这个包自己的 `node_modules/` 里**，还差一层。

## 这是同一个坑的第三次，得说清楚

| 次 | 我以为的装法 | 实际 |
|---|---|---|
| P1-13 | 包和 profile 平级 | 共享安装住在 profile **上层** |
| R5 第一次 | 全局装 = 住在 DSH **安装目录** | 对，但我只推到 `lib/node_modules` |
| R5 第二次 | 就到 `lib/node_modules` | **那个包里还嵌着一层 `node_modules`** |

三次都错在同一句话上：**我记住了一个路径形状，就以为所有安装都长这样。**
第一次修完加了一条路径，第二次修完又加了一条 —— **每次都在补形状，没在补方法**。

## 所以这次不只加路径

三件事一起做：

1. 从 `process.execPath` 直接推出嵌层（`<prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules`）
2. **通用嵌层探测**：对每个搜索根，再试 `<root>/<包名>/node_modules/<name>` ——
   不写死某一个包，但也限个数，不遍历整个 `node_modules`
3. ★ **「找不到」的报错改成列出所有试过的路径**

第三条最要紧。前两次报告都是靠读代码猜我漏了哪一层；现在它自己列出来：

```
✗ @deepseek-ai/dsh-base  找不到。试过这些位置：
    C:\...\node_modules\@deepseek-ai\dsh-base
    C:\...\lib\node_modules\@deepseek-ai\dsh-base
    C:\...\lib\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-base
    ...
```

**下次（如果还有下次）不用猜了。**

## 用假 nvm 布局真测过

我在 Windows 上，造不出真的 nvm 目录，所以：
- 复刻报告给的真实形状到一个临时目录
- 加 `DSH_LIVE_EXTRA_ROOTS` 环境变量（`path.delimiter` 分隔）把那个根塞进去
- 跑真脚本

结果：

```
补根之前:  通过 0 需注意 0 失败 1
补根之后:  通过 0 需注意 0 失败 0
           · @deepseek-ai/dsh-base  没有 dsh.bundle.patch（正常，如果它是内置包）
```

「没有 patch」是**找到之后**的判断，不是「找不到」—— 所以嵌层探测真的生效了。
那个环境变量留着，以后测特殊布局用得上。

## 顺带：我自己又踩了一个路分隔符

第一版我写 `split(/[;:]/)` —— 想着「POSIX 用冒号、Windows 用分号，两种都认」。
但 **Windows 路径本身就是 `C:\...`**，冒号在盘符后面，于是被切成 `C` 和 `\...\`。
测试第一次跑出来只试了 1 个位置，才发现。

改成 `path.delimiter`。这就是它存在的理由。

★ 这个错和上面那三次是**同一个形状**：我以为我知道路径长什么样。
区别是小得多 —— 它被测试抓住了，而那三次是被外部验证抓住的。

### 2026-10-22（同日第十九次）· 「115/115」这句话有个前提

外部验证报告 v3 的 N3。

## 那个前提

`tools/verify-ps1-logic.mjs` 拿 PowerShell 的 AST 解析器验 `install-desktop.ps1` 的**结构**
（「这句 `Die` 在不在 `$rollbackOk` 为真的分支里」这类逻辑位置，字符串包含验不出来）。
它写死了 `powershell.exe`，而 catch 里直接 `process.exit(1)`。

于是 Linux 上：ENOENT → 整个脚本退出 → 一条断言都跑不到。
`verify-packaging` 那一项判失败，所以是 **115 里少 1**。

★ 报告说的是 106/106（它测的是更早的版本）；现在是 115，机制一样。
**所以我把它写成动态的数，不写死 106 或 115** —— 断言数会涨，前提不会。

## 修法不是把 exit(1) 改成 exit(0)

那是把「环境缺能力」和「代码坏了」混成同一个绿灯。要分开：

```
能跑     → 真跑，通过 / 失败照常
跑不了   → 明确说「跳过」，并说清跳过了什么、要装什么才能真验
```

而且非 Windows 上先试 `pwsh`（PowerShell 7 在 Linux 上很常见）——
**装了它就还能真验，不装才跳过。** 一刀切跳过也是偷懒。

## 跳过的状态必须看得见

第一版我把它写成 `check(name, passed || skipped, detail)`。
跑完发现是个**干净的 OK** —— 因为 `check` 的 `detail` 只在这一条失败时才打印。
**那正好是「冒充验过了」。**

所以把状态写进**断言名**里：

```
装机有 PowerShell：  OK  ps1 结构断言全部通过（AST，不是字符串包含）
本机没有 PowerShell：OK  ps1 结构断言（AST）—— ◆ 跳过：本机没有 PowerShell，这一项没验
```

两行都是 OK，但第二行**自己说了它没验**。读输出的人不会被一个干净的 OK 骗过去。

★ 这一处的取舍：**跳过算过关，但不算通过。**
算过关是因为「这台机器没装 PowerShell」不该让 CI 红；
不算通过是因为它确实没验。两个都要，所以只能靠名字承载这个区别。

## 两条路径都真跑过

我在 Windows 上，验不了「Linux 上没有 PowerShell」这件事本身 ——
所以加了 `PS1_CHECK_FORCE_SKIP=1` 强制走跳过分支，把它当一条可测的路径：

```
$ node tools/verify-ps1-logic.mjs                     → 通过 9 / 9  ★ 全部通过
$ PS1_CHECK_FORCE_SKIP=1 node tools/verify-ps1-logic.mjs
  ◆ 跳过 —— 这台机器上没有可用的 PowerShell
  为什么跳过而不是失败：…… 要真验这里，装一个就行：……
  退出码 0
```

★ 这个环境变量不只是为了这次验证 —— 以后改跳过分支也能测，不用真去借一台 Linux。
**能测的分支才是被维护的分支。**

## 所以那句话该怎么说

不该说「自检全部通过」，该说：

> 自检全过 —— **前提是这台机器有 PowerShell**。没有的话，ps1 结构那一项是「没验」，
> 输出里会带着 `◆ 跳过` 写出来。

这就是这一条要的东西：不是把数字修对，是**把数字背后的前提说出来**。

### 2026-10-22（同日第十八次）· 桌面装完**就被剪掉**，而且要等下次启动才知道

外部验证报告 v3 的 N1。

## 那个序列

```
① 桌面脚本装本体 → 拷进 node_modules → 名字加进 dsh.profile.bundles → 启动正常 → 看起来成了
② 按装配计划装下一个零件（dsh plugin add）
③ pnpm 在那一轮把「没写进 dependencies 的 node_modules 子目录」当 extraneous 清掉
④ 再启动 → dsh: skipping profile bundle "dsh-agent-soul": cannot resolve profile bundle
```

**本体在 ③ 就没了，但要到 ④ 才发现。** 而 ① 那一刻一切正常 ——
这时候最容易做的事是「装好了，接着装下一个」，正好踩进去。

## 差在哪一行

`install-desktop.ps1` 是「拷文件 + 加名字」，它**不写 `dependencies`**。
而 `dsh plugin add` 走 pnpm，pnpm 判断一个 `node_modules` 子目录算不算 extraneous，
看的是 `package.json` 里有没有它的声明 —— 不看谁拷的。

所以修法不是「别用 pnpm」，是**把声明补上**。

## 改在 `add-bundle.cjs` 里，改一处两个用途

那个脚本 `install.js`、`install-desktop.ps1`、手工命令三处都在调。
它原来只写 `bundles`。现在接受一个**可选**的第三个参数：

```
node add-bundle.cjs <profile>/package.json <包名>
node add-bundle.cjs <profile>/package.json <包名> <depValue>
```

不传就只写 bundles（旧行为不变）；传了就顺手写 `dependencies[name]`。
桌面脚本现在传 `file:node_modules/dsh-agent-soul` —— 指向它在 `node_modules` 里的实际位置。

★ **路径不在脚本里猜**：`file:` 后面该写什么取决于包被拷到哪，
换一种安装方式写死了就错。调用方知道路径，让它说；这个脚本只负责写进去。

★ **两种情形分开算**：`bundles` 和 `dependencies` 可能一个有一个没有 ——
旧版脚本留下的就是这个状态（bundles 有、dependencies 没有）。
所以判据不是「名字在不在 bundles 里」，而是两样分别查。输出也分开说：
`added` / `added-deps`（只补了依赖）/ `already`。

## 实测四种行为

造临时 profile 跑真脚本：

```
① 不传 depValue: added
   bundles: ["dsh-agent-soul"] | dependencies: null
② 传了 depValue: added-deps
   dependencies: {"dsh-agent-soul":"file:node_modules/dsh-agent-soul"}
③ 再跑一次: already                    ← 幂等
④ 空 profile 一次到位: added
   bundles: ["dsh-agent-soul"] | dependencies: {"dsh-agent-soul":"file:..."}
```

★ ② 那一行是最要紧的：**旧版装过的机器再跑一次，会把缺的 dependencies 补上**，
不用先卸再装。

## 一句提醒

报告对这条的原话是「桌面（Electron）是否同路径未实测，但风险相同」。
我按「机制上一样」处理了 —— 因为判断 extraneous 的是 pnpm，不是宿主类型。
**但严格说这是推理，不是我在这台机器上复现过的** —— 所以我把它写在这里，不写成「已实测」。
真正要验它，得走一遍：装本体 → 装一个零件 → 重启 → 看本体还在不在。
这条我记在待办里，等有人真踩过或者真验过再改口径。

### 2026-10-22（同日第十七次）· compaction 接管要两步，不是一步

外部验证报告 v3 的 R2。这条我之前**不敢动** —— 上一轮报告说「排最前失败」，
而本机 `cordis.patch.yml` 里存着「排最前验通过」的 `ctor: YanqingCompaction`。
两份证据矛盾，我复现不了它那个环境，就没改。

这一版把完整链路给出来了，矛盾解开了。

## 两份证据其实不矛盾

报告的过程是：

```
① 排最前 → --dump-config 确认顺序对 → 启动仍报
     dsh-agent-compaction: Error: service "compaction" has been registered at <BasicCompactionEngine>
② 再加 disabled: true → 告警消失 → 探针读到 ctor: YanqingCompaction
```

**而本机那份 `ctor: YanqingCompaction` 是「结果」，没记「中间有没有报错」。**
同一个结果，两种条件 —— 我上一轮把「结果对」当成了「这条路的方法对」。

★ 这又是一个「拿结果反推方法」的错误，和 N2（我记得的模板大小）同型。

## 机制上说清了

**排序只决定「谁先注册」，不决定「后到的那个要不要注册」。**
`compaction-basic` 仍然在 bundles 里、仍然会被加载，它照样去注册 —— 于是报重名。
要它别注册，只能显式禁掉：

```yaml
- id: compaction-basic
  disabled: true
- id: tool-result-pruner
  disabled: true      # 用 pruner 的话同理
```

## 改了三处

| 文件 | 改了什么 |
|---|---|
| `plugins/compaction/HOW-TO-TAKEOVER.md` | 路 A 补「第二步：禁掉内置的」，并写清「只调顺序不够」为什么 |
| `plugins/compaction/cordis.patch.yml` | 注释里那段「结案：走 a) 走通了」补上「单独不够」的更正 |
| `install.js` | `plan` 的接管提示从「排最前」改成「两步，缺一不可」，判据从一条改成两条 |

**判据也改了**：以前只有「探针读出 ctor 是 YanqingCompaction」，
现在要两条同时成立 ——
① 启动日志里**没有** `service "compaction" has been registered`
② 探针读出 `ctor: YanqingCompaction`

★ 只有第二条不够：**报着重名错误也可能读到我们的 ctor** ——
构造成功 ≠ 注册成功。这一点是这份报告教会我的。

## 这次是真跑过的

`install.js` 是插件入口（只导出 `registerInstallTool(ctx)`），不是 CLI，
`node --check` 只能验语法。所以造了个假 ctx 直接调它的 `execute`：

```
工具名: agent_soul_install ｜ handler: execute
ok: true ｜ 总行数: 203
✓ 说了「两步，缺一不可」   ✓ 给出了 disabled: true
✓ 说清「只做①不行」        ✓ 判据是两条同时成立
✓ 提到了干净沙箱实测        ✓ 指向 soul-probe
```

输出里那几行是真的，不是「我觉得写对了」。

★ 另外标清了来源：`ctor` 那段是本机 2026-10-18 在 demo profile 上的，
「光排最前仍会报 registered」那段是 2026-10-22 干净沙箱（Ubuntu + DSH 0.2.1-rc.2）的。
**两份证据都要标出处**，否则下一个读的人会拿结果反推方法 —— 就像我这次一样。

### 2026-10-22（同日第十六次）· `verify-live` 的两个老毛病

外部验证报告 v3 的 R5 与 N4。

## R5 · 只在 profile 里找，找不到全局装的那一批

`findBundleDir()` 原来只往上爬 4 层找 `node_modules`。
而 `npm i -g @deepseek-ai/dsh` 时，shipped bundle（`dsh-base`、`dsh-headless`）
住在 **DSH 自己的安装目录**，够不着 —— 于是报「找不到」，而包明明在。

**这条和 P1-13 是同一个坑的第二次。** 上一次我加了「往上爬 4 层」，
治的是「共享安装住在 profile 上层」；这次是「全局安装住在 DSH 安装目录」。
两次都错在同一件事：**我只想到一种装法。**

现在按两条路找：profile 及其上层、DSH 安装目录（从 `process.execPath` 推，
外加让 Node 自己 `resolve` 一次 `@deepseek-ai/dsh/package.json`）。

★ 本机实测：`dsh-base` 和 `dsh-web-app` 从 ✗ 变 ✓。
还剩一个 ✗ 是 `@deepseek-ai/dsh-experimental-agent-team-profile` ——
查过了，它**写在 bundles 里但不在 dependencies、也不在 node_modules**，
那是本机 profile 的配置问题，不是这个脚本的误报，**我没动**。

## N4 · 推荐的验法本身不可用

`verify-live` 结尾会推荐「跑 `tools/soul-probe`」，但没提它的前提。
报告 R3 证明：不声明 `inject` 时它在 0.2.1-rc.2 上整个跑不起来，
而日志空白会被读成「没接管」。探针已经修好了（见第十五次公告），推荐文案也得跟上。

现在那三行把判读方式写全了：

```
没有 [register]            → compaction 服务不存在（探针声明了 inject，服务不在就不加载）
有 [register] 没有 [result] → 探针自己出错，不是压缩没接管
有 [result]                → 看 ctor：Yanqing… 是接管了，Basic… 是没接管
```

## 顺带一提：这一轮我又差点交出一个「语法过、跑不通」

改完 R5 后 `node --check` 过了，但我在里面用了 `createRequire` 却没 import ——
`--check` 只查语法，**不查「这个符号存不存在」**。
真跑一次才发现（`node tools/verify-live.mjs` 不带参数，看它报不报 `ReferenceError`）。

★ 这和 P0-1（`node --check` 过了但脚本是死的）是**同一个坑的第二次**。
所以现在的规矩是：**改了要跑的东西，`--check` 之后必须再真跑一次。**

### 2026-10-22（同日第十五次）· 三处修正，都在「拿什么当证据」上

外部验证报告 v3 的 R3、R4、N2。三件事看着不相干，其实是同一个毛病：
**我把某样东西当成了证据，而那样东西本身不对。**

## R3 · 我们推荐的验法，跑不起来

`tools/soul-probe` 没声明 `inject`。cordis 4 不允许未声明就 `ctx.get()`，报的是：

```
cannot get property "compaction" without inject
```

后果不是「读不到值」，是**整个探针不加载、日志一片空白**。
而读日志的人会把空白读成「压缩没接管」—— **一个正好的反向结论**。
我们一直拿这个探针当「装了没有」的唯一运行时证据，
而它在新版 DSH 上一次都没成功跑过。

补上 `export const inject = ['compaction']` 之后，多了一种以前分不开的判读：

- 服务不存在 → 整包不加载 → 日志里**连 `[register]` 都没有**
- 服务在、探针自己出错 → 有 `[register]`，没有 `[result]`

以前这两种都长成「日志是空的」。

## R4 · 一条文案盖了三种状态

`diagnose.mjs` 的 `REMEDY` 里每个 id 只有一条 `means`。
doorsign 那条写的是「门牌回取链断了」——可 `doctor` 在同一件事上报的是
`warn`「这份日志里还没有压缩摘要，无可测门牌」。

于是 `verify` 把「还没开始用」翻译成了「坏了」。
**这正是这套自检反复强调要分开的两件事**，而它自己没分开。

改成 `meansBy: { ok, warn, error }`，按 `status` 取。warn 那条现在明说：
「还没开始用，不是坏了。装上 compaction 并触发一次压缩，这里才会有东西可测。」

## N2 · 我写的数字是错的

处置文档里我写「模板 3429 B，其余是活体」，用来论证「70.9% 不是缺陷」。
实测：

```
kit/templates/SELF.src.md   8446 B
self.mjs：8689 B / 12288 B（70.7%）  骨架 8352 B + 活体 337 B
```

**骨架才是占大头的那一块，不是活体。** 我那个数差了 2.5 倍。

结论不变（70.7% 在设计余量内，不是缺陷），但论据换了：
真正撑住这个结论的是**预算本来就是自由度更大的那一侧**（12288），
不是「模板很小」。原来那个数字会让人以为余量大得多。
README 里那处 `8715 B / 70.9%` 也一并改成 v3 实测的 `8689 B / 70.7%`。

## 三条合起来是一件事

| 我拿什么当证据 | 实际 |
|---|---|
| 探针的日志 | 探针根本没加载，空白被我读成结论 |
| doctor 的 warn | 被同一条文案翻译成「坏了」 |
| 我记得的模板大小 | 差 2.5 倍，没量过 |

**「我记得」「它应该能跑」「日志空白就是失败」—— 这三个都得换成量一次。**
报告这一版最值钱的地方不是挑出错，是它每次都给出可复现的命令输出。

**自检 112 → 115**（新增：探针必须声明 inject / diagnose 必须按 status 分支 / warn 文案必须说清不是坏了）。

### 2026-10-22（同日第十四次）· 我修出来一个比原 bug 更坏的 bug

外部验证报告 v3 的 R1。**这是我自己造成的回归，不是报告作者挑刺。**

## 经过

上一轮修 P1-10（「长占位符数不出来」），我把正则从
`/<[\u4e00-\u9fa5]{2,12}>/g` 放宽成 `/<[^<>\n]{2,80}>/g`。
想法是：那个身份判据占位符有 30 多字、还带逗号，`{2,12}` 认不出来。

但模板里还有三处「填法」注释：

```html
<!-- 填法：把 [hub] 换成你实际的记忆中枢路径。…… -->
```

它有 `<` 有 `>`，中间没有换行，长度也在 80 以内 —— **新正则把它整段吃进去了**。
于是 `plan` 第 3 步永远显示「还差 <!-- 填法：… -->」，
第 4 到 6 步不可达，用户照 `plan` 走会原地打转，而且会以为自己漏填了什么。

## 为什么这个比原来的 bug 更坏

- 原来「数不出长占位符」：少提示一个，用户可能自己发现，**是漏**。
- 现在「注释永远填不完」：整条路断在那儿，而且**看起来像用户没做完**，**是堵**。

一样东西从「少说一句」变成「永远过不去」，性质就变了。

## 根因不是正则写错，是两处各写一套

`plan.mjs` 和 `self.mjs` 各有一份占位符正则，口径还不一样：
plan 认得长的但吃注释，self 认得注释但漏长的。**两边都错，还错得不一样。**

所以这次不是再调一次正则，是把判定**收拢到一处** —— `kit/echo/placeholder.mjs`：

```js
export function stripHtmlComments(text) { … }   // 必须先剔注释
export function findPlaceholders(text) { … }    // 再找 <尖括号>
```

顺序是固定的：**先剔注释，再找尖括号**。反过来一定会再踩一次。

## 加了三类断言

- 占位符里不含 HTML 注释（直接抓这个回归）
- 能认出 30+ 字的长占位符（守住上一轮的修复）
- 模板占位符恰为 3 个；且 `plan`/`self` 都必须 import 共享判定、不许自己再写正则

**自检 106 → 112**（新增 6 条：注释不混入 / 长占位符认得出 / 恰好 3 个 / 两处都用共享判定 / 两处都不再自己写正则）。

★ 教训一句话：**修「漏数」的时候要问一句「放宽之后会不会多认」**。
放宽一个判据是双向的 —— 它同时放松了「该认的」和「不该认的」。
这一轮我只想了前半句。

### 2026-10-22（同日第十三次）· 外部验证报告 16 条：结案

逐条对账写在 `docs/external-validation-2026-10-22-response.md`，这里只放结论：

**16 条里，14 条已修（其中 7 条在报告的基线之前就已修好），1 条经核实不是缺陷，1 条有意留。**
没有一条被漏掉。

报告基线是 2026-10-19 的 HEAD，核实时的 HEAD 是 `7920b37`，中间 20 个 commit ——
**那 7 条「已修」不是报告作者看错，是时间差。** 这一点在结案文档里单独写明，免得读的人
以为他的报告有一半是误报。

★ 这一轮最值钱的不是任何一条具体缺陷，是报告**证伪了我的验证方式**。
三条是同一个形状：

| 缺陷 | 拿什么当证据 | 真正要证的是什么 |
|---|---|---|
| P0-1 | `node --check` 通过 | 这个脚本**跑起来**能改到 bundles |
| P1-7 | 日志里出现 `SELF.md` 这个词 | SELF.md 的**正文**真的被注入了 |
| P0-4 | 版本号看着对 | `satisfies()` 真的返回 true |

三次都是**用一个更容易满足的条件，替代了真正要证的那件事**，
而三次的失败形态完全一样：**自检绿着，功能是坏的。**

所以本轮加的断言里，有两条不是「检查某个字符串在不在」，而是**真的把东西跑一遍**：
add-bundle 那条造一个临时 `package.json` 跑完看结果，
semver 那条用真的 semver 库算。**自检 94 → 106。**

★ 没改的两条，理由写在结案文档里：
P2-14 那个数是对的（v3 实测 8689 B / 12288 = 70.7%），设计余量内，不是缺陷；
P2-15 要动全局配置层，一个 P2 的体验问题不值得拿配置层去换。

### 2026-10-22（同日第十二次）· 装上 ≠ 接管：`install` 现在会把这一句说出来

外部验证报告 P0-6。`dsh-agent-compaction` 装进 profile 之后，启动时报：

```
dsh-agent-compaction: Error: service "compaction" has been registered at <BasicCompactionEngine>
```

根因是 cordis 的服务注册**先到先得**：`@deepseek-ai/dsh-base` 里带着 compaction-basic，排在前面，`dsh-agent-compaction` 后注册就抢不到那个名字。
而真正能生效的是 realm 隔离（`isolate: { compaction: true }`），默认安装路径不会写这段。

**后果比报错更难发现**：`doctor` 只会报一句 `warn「压缩机制 start 0」`，
看不出「装了但没接管」—— 而门牌机制是整套架构的核心，等于装完没生效。

★ **这次我没有改服务注册**。那要动 realm 隔离或 bundles 顺序，风险远大于收益，
而且`plugins/compaction/cordis.patch.yml` 里已经记着「路 A 在真 profile 上验通过」的运行时证据 ——
报告在云端沙箱里走路 A 仍然失败，两边结论不一致，我没法在本地复现它那个环境。
**在弄清差异之前动它，是拿一个已验证过的东西去赌一个没验过的猜测。**

改的是另一头：`agent_soul_install` 在第 1 步的输出里补了一段明确警告 ——
装上了不等于接管了、会抢服务名、doctor 那句 warn 是什么意思、两条路在哪、装完用哪个探针验。

★ 这一条和 P1-7 是同一个方向：**工具得把「还差哪一步」说出来，而不是让人以为完事了。**

### 2026-10-22（同日第十一次）· 一条永远通过的自检：SELF 判据认的是工具描述

外部验证报告 P1-7。`agent_soul_doctor` 的深度检查里，「推送层 SELF 有没有真的注入」
原来是这样判的：

```js
if (raw.includes("SELF.md 读不到")) injected = false
else if (raw.includes("自我层") || raw.includes("SELF.md")) injected = true
```

问题在于 `agent_soul_scaffold` 的**工具描述里就写着 SELF 模板、SELF.md** ——
工具定义本身会进日志，所以**只要插件装上了**，这个字符串必然出现，判据恒真。

**一个永远通过的自检比没有自检更坏**：它不只是不报错，它会明确告诉你「装好了」。
而这项检查原本要抓的正是「SELF.md 文件在、但推送层一点没吃到」—— 那是真实存在过的故障
（`dsh-agent-memory` 的 `selfPath` 默认指向 `./SELF.md`，而 scaffold 把文件写在 `memory/hub/`）。

**修法**：改认 SELF.md **正文里才有的**词 —— `四条硬线`、`## 我是谁`。
工具描述不会写这两个串，而注入成功时它们在正文里必然出现。

加了两条断言守这个边界：判据里不许出现裸的 `raw.includes("SELF.md")`，
且必须认正文独有词。**自检 104 → 106。**

★ 这一条和 P0-1 是同一个形状：**判据本身没被验过**。
P0-1 是拿 `node --check`（只看语法）当成「跑得通」，
这里是拿「工具描述里提过这个名字」当成「注入成功了」。
两次都是**用一个更容易满足的条件，替代了真正要证的那件事**。

### 2026-10-22（同日第十次）· README 的工具表少了一个：`agent_soul_verify`

外部验证报告 P2-16。插件注册了 8 个工具，README 的表里只列了 7 个 ——
`agent_soul_verify`（`这套东西真的在跑吗`）没写进去。

这个漏法很典型：表是分两段写的（"前三个是动作"、"后四个是说明书"），
加第八个工具的时候两段都没想起来改。**分段写的表最容易漏掉新插进去的那一项。**

★ 顺带说明一处**这次没改**的：报告 P2-15 说 `scaffold` 干跑在配置不全时报 `ok=false`。

行为实测确认：干跑时 `APPLY` 为假，所以不建根目录；随后 `checkConfig` 因
`SOUL` / `MEM` 未配置而退出，**一个目录都不演示** —— 而干跑的意义正是演示。

但根因是干跑时 `CFG.SOUL` 是 `undefined`；要放行就得给全局配置注入占位路径，
后面每一处 `path.join(CFG.SOUL, ...)` 都会拼出假路径。改它要动全局配置层，
风险与收益不匹配（报告定级 P2），**有意留到下一轮单独处理**，不是漏看。

### 2026-10-22（同日第九次）· 外部验证报告又四条：semver 那个坑最深

接着上一批，对着当前 HEAD 逐条核实，修掉四条。

**P0-4 · `rc2` 和 `rc.2` 不是一个东西，换气因此装不上**

huanqi 的 peerDependencies 写着 `>=0.2.1-rc2 <0.3.0`，而 DSH 是 `0.2.1-rc.2`。

按 semver 规范，`rc.2` 拆成 `["rc","2"]`，`rc2` 是单个 `["rc2"]`；
逐段比较时**前缀更长的更大**，所以 `rc2 > rc.2`，于是：

```
satisfies('0.2.1-rc.2', '>=0.2.1-rc2 <0.3.0')   →  false
```

装不上，而且报的是「不兼容」，看上去像 DSH 太新，其实是版本串写错了。
改成 `>=0.2.1-rc.2 <0.3.0` 之后区间**变宽**（rc.2 比 rc2 小），不会误伤更早的版本：

```
satisfies('0.2.1-rc.2', '>=0.2.1-rc.2 <0.3.0')  →  true
```

`dsh-agent` 和 `dsh-llm` 两条都改。加了断言：扫所有子包的 `peerDependencies`，
出现 `-rcN` 这种不带点的写法就报——并用真 semver 库验当前 DSH 版本落不落得进去。

**P1-8 · 「还没建」被显示成「没问题」**

两处：

- 热记忆：`USER.md` / `MEMORY.md` 不存在时 `bytes=null`、`pct=null`，
  被 `filter` 掉之后 `worst` 是 `undefined`，`status` 停在 `ok`。
  一个还没建的文件被报成健康——和这套工具自己的 error/warn 分级相反。现在降 `warn`。
- 身份判据：`status` 写死了 `"ok"`，哪怕《墨》里一条 `lead` 都没有。
  零代 lead 不是「判据通过」，是「还没建立署名人」。现在降 `warn`。

**P1-10 · 占位符正则吃不下长占位符**

`/<[\u4e00-\u9fa5]{2,12}>/g` 只认 2-12 个连续汉字。模板里这种：

```
<写一条能在你的系统上跑出结果的命令，或者一条可核验的事实>
```

带中文逗号、三十多个字，**一个都匹配不到** —— 于是 `plan` 以为已经填完了。
放宽成 `/<[^<>\n]{2,80}>/g`，实测能匹配到。

**P1-11 · 首次装配的死锁**

`plan` 第 1 步的 `check` 要求两个根目录**已存在**，但 `how` 只教人设环境变量。
照着做完仍然停在第 1 步；而会建目录的 `scaffold` 在第 2 步，干跑时又拒绝执行。
——**第 1 步要的那个目录，没有任何一步负责建**。
现在 `how` 里明说「这两个目录必须已经存在」，并直接给 `mkdir -p` 和 Windows 的等价写法。

**自检 98 → 104**（六条新的 peer 范围断言）。

**还剩**：P0-6（compaction 不接管）、P1-7（doctor 的 SELF 判据假绿）、
P1-9（verify 把「没有样本」翻成「链断了」）、P1-12（plan 少遍历两个零件）、
P1-13（verify-live 对 shipped bundle 误报）、P2-14/15/16。

### 2026-10-22（同日第八次）· 外部验证报告的 P0-1：`add-bundle.js` 在 ESM 包里是死的

有人拿云端沙箱从零装了一遍，出了一份 16 条的验证报告。最要命的是这一条：

> `tools/add-bundle.js` 是 CJS（`require("fs")`），但 `package.json` 有 `"type": "module"`。
> 桌面一键脚本在第 5 步拿它去登记 bundles，它必然抛
> `ReferenceError: require is not defined in ES module scope`，
> 脚本于是回滚 `package.json` 并 `Die` —— **文件拷过去了，插件不加载**。

本机实测确认，而且**结果文件一个字节都没变**：

```
type = "module"
ReferenceError: require is not defined in ES module scope
结果: {"name":"probe","dsh":{"profile":{"bundles":["a"]}}}   ← 没加上 b
```

**这条比报告里写的更难看的地方在于**：我 2026-10-22 那天刚改过这个文件（加乐观锁、原子写），
改完跑的是 `node --check tools/add-bundle.js`，它通过了 —— 我因此以为没问题。
`--check` 只检查语法，**不看模块系统**。假绿。同一个形状的错误今天已经出现过三次。

**修法**：改名 `tools/add-bundle.cjs`（Node 对 `.cjs` 一律按 CommonJS 处理，与 `type` 无关），
并把 `install-desktop.ps1` 里两处引用（`$mustHave` 与 `$addJs`）一起改过去。

**加了 4 条断言，其中一条真的跑**（`tools/verify-packaging.mjs`）：

- `add-bundle` 用的是 `.cjs` 后缀
- 旧的 `add-bundle.js` 已不存在
- `package.json` 的 `type` 是 `module`（这条断言的前提，前提没了就该重新看这段）
- **`add-bundle` 真能跑**：在临时目录造一个 `package.json`，跑一遍，断言 `bundles` 里真的多了那一项

自检从 94 条加到 **98 条**。

**报告里其余 15 条的处理情况**（基线是 2026-10-19 的 HEAD，中间已经推过 14 个 commit）：

| 报告编号 | 现状 |
|---|---|
| P0-2 `$files` 漏 `client.js` | **已修**（`$files` 里已有） |
| P0-3 `$dirs` 漏 `plugins/` | **已修**（`foreach ($d in @(...'plugins'))`） |
| P0-5 huanqi 的 patch name | **已修**（`cordis.patch.yml` 里是 `dsh-huanqi`） |
| P0-4 huanqi 版本范围 `rc2` vs `rc.2` | 待核 |
| P0-6 compaction 不接管压缩 | 待核 |
| P1-7 ~ P1-13、P2-14 ~ P2-16 | 待核 |

★ 表中「已修」是 2026-10-22 当天改的，报告作者看到的是旧代码 —— 不是他终于挖出旧 bug，
是他验证的基线早于这些修复。**但这不减轻 P0-1 的分量**：那条在今天仍然是坏的。

### 2026-10-22（同日第七次）· 行为断言：用 AST 证 ps1 的逻辑位置，不再靠字符串

第三轮最后欠的一条（V1）。审核方的批评是准的：

> 现有 92 条断言**全是字符串包含**。`ps1 有暂存目录` 断言 `includes('dsh-agent-soul-stage-')`，
> 而**旧版先删后移的写法也含这个字符串** —— 所以 N1（回滚失败却谎称已恢复）在旧代码里能全绿。

**为什么不是「真跑一遍 ps1」**

`install-desktop.ps1` 要从 GitHub 下载 zip、要一个真实 profile、要能动 DSH 目录。
在自检里跑全套 = 网络依赖 + 副作用 + 慢，而且**要造出「Move-Item 失败」还得先有权限问题**。

但我们要验的东西其实不需要跑：**「这句 `Die` 在不在 `$rollbackOk` 为真的那个分支里」**
是一个**结构**问题。PowerShell 的 AST 解析器（`[Parser]::ParseFile`）能直接回答，
而且它**只解析不执行** —— 零副作用。

新增 `tools/verify-ps1-logic.mjs`，9 条断言，每一条都指向一个「字符串证明不了」的事实：

| 断言 | 字符串版本为什么不够 |
|---|---|
| `Die "previous install restored"` 在 `$rollbackOk` 分支里 | 旧版无条件打这句，字符串照样命中 |
| 存在「回滚失败」的 `Die`（`AND rollback failed` / `DO NOT restart`） | 旧版根本没有这一条 —— 只宣称成功 |
| 失败那条在「换包失败」路径上（`if (-not $swapped)` 块内） | 位置错了字符串照样命中 |
| 失败那条被前面的「成功就退出」挡住 | 少了挡住就会**先报成功再报失败** |
| `$rollbackOk` 至少有一处由 `Test-Path` 实测 | 写死 `$true` 也能让字符串断言全绿 |

**写这个工具时我自己错了两次**，两条 `FAIL` 都是**断言的错**，不是代码的错：

1. `$rollbackOk` 的赋值我用了 `.find()` 取第一个 —— 那是 `$rollbackOk = $false` 的**初始化**，
   真正的实测在下面几行的 `$rollbackOk = Test-Path $dest`。改成看**所有**赋值里有没有 `Test-Path`。
2. 「失败那条在否定分支里」我按 `else` 找 —— 但 ps1 的写法是
   `if ($rollbackOk) { Die "restored" }` 紧跟着 `Die "... AND rollback failed"`：
   **落到第二行 = 第一个 if 没成立**，这是「守卫退出」模式，不是 else。
   改成认这个模式（前一条 `Die` 在后面 6 行内，且被 `$rollbackOk` 守卫）。

★ 这两次恰好说明 V1 的论点：**断言本身也会错**，而它错的时候会给你一个假的 FAIL 或假的 PASS。
所以这次两条失败我都先回去读 ps1 原文、确认代码是对的，才动断言。

**接进主自检**：`verify-packaging.mjs` 加两条，调子进程跑 `verify-ps1-logic.mjs`
（工具存在 + 它全部通过）。现在 `node tools/verify-packaging.mjs` 一次跑完：
94 条静态断言 + 9 条 ps1 结构断言。

**数字**：主自检 92 → 94；ps1 结构 9 条独立；合计 **103 条**。

### 2026-10-22（同日第六次）· 把第三轮欠的五条补完（只剩行为断言）

上一轮的更新记录里列了「没做完的四条」。这一轮补掉其中三条半。

**N6 · `roots` 终于有边界校验了**（挂了整整两轮）

`agent_soul_scaffold` 是**唯一一个会往用户目录里写东西**的入口 ——
`scaffold.mjs` 里有 `mkdirSync` / `writeFileSync`，带 `--apply` 就真写。
在此之前 `roots` 是四个自由字符串、`required: []`、一句断言都没有。
一段提示注入就能让 soul 指向 `C:\Windows` 或别人的 Documents。
**写着"别乱写"的注释挡不住执行。**

修在 `envFromArgs()` —— 这是四个 roots 唯一的共同入口，一处收口。
拦三类：盘根（`D:\`）、系统目录（Windows / System32 / Program Files / ProgramData / 回收站，
**任何盘都拦**）、用户主目录本身（允许其下，不允许整个 profile 当书房）。
另外还拦「两个 roots 指同一处」—— 那会让写档案盖掉记忆。
不拦深度 1（`D:\AI` 是合理路径），也不能拦：正常的 roots 就是这种形状。

**12 条断言实测**：5 条正常路径放行、7 条危险路径拒绝，全过。

**N10 · `add-bundle.js` 不再丢更新**

原来是「读 → 改 → 整文件覆盖写」。两个 `dsh plugin add` 撞在一起时，
后写的会把前一次的 `bundles.push` 整个盖掉，**静默丢一个插件** ——
症状是「装上了但没启用」，没有任何报错。

两层修：①**乐观锁**（写前重读，比 size + mtime，变了就重来，最多 3 次）；
②**原子写**（`.tmp` → `rename`，同卷上 rename 是原子的）。
不做锁文件 —— 进程崩溃会留下残留锁，比丢一次更新更难收拾。

**V2 · exports 通配符开始被检查了**

`exports["./src/*"]` 指向一个不在 `files` 里的目录 —— 源仓库里能跑，
`npm pack` 之后就是死链，运行时才 404。自检以前只看 `main / client / patch`，
`exports` 一个字没查。（huanqi 那条 `./src/*` 上一轮已经删了，现在是 `./tools/*`，
`tools/` 在 files 里，所以绿。）

**V3 · `loadPkgNames` 和 scan 分支的行号顺序被钉住了**

这条专门守 N4：当时 `loadPkgNames()` 只在 plan 分支调，
scan 分支在它之前就 return —— 于是装好的 `dsh-huanqi` 在 scan 里永远认不出来。
补丁式修复最容易犯的错就是「改了 plan 忘了 scan」，
所以拿行号顺序把它写成断言，而不是靠下次记得。

**V4 · 自检不再依赖 cwd**

原来 `const ROOT = process.cwd()`、读取全用相对路径。
从仓库根跑没事，从别处跑就 ENOENT —— 而脚本没有「我在对的目录吗」的自检，
用户会以为是包坏了。现在自己 `chdir` 到脚本的上一级，跟从哪调用无关。
**实测**：`cd tools && node verify-packaging.mjs` 与从仓库根跑，都是 92/92。

**自检从 90 加到 92**（exports 通配 ×1、loadPkgNames 顺序 ×1）。

**还欠一条：V1 · 行为断言**

审核方说得对：现有 92 条断言**全是字符串包含**。
它举的例子很准 —— `ps1 有暂存目录` 断言 `includes('dsh-agent-soul-stage-')`，
而**旧版先删后移的写法也含这个字符串**，所以 N1 在旧代码里能全绿。

真正的行为断言要造临时 profile、故意让 `Move-Item` 失败、
断言退出码非 0 **且** 目标目录仍在 —— 那需要一个跑得起来的 ps1 环境，
单独一轮做（目标是 3 条：回滚失败、改名失败、原子写失败）。

### 2026-10-22（同日第五次）· 第三轮审核：修 5 条，2 条是误报，剩下 4 条没做完

第三轮给了 14 条（10 修 / 4 未修），外加 3 条新发现和 4 条「自检脚本自己的盲区」。
我逐条核了一遍，**不整份接受**。

**修了的（5 条）**

| 条 | 是什么 | 为什么值得修 |
|---|---|---|
| **N9** | `huanqi-panel` 写回 `cordis.patch.yml` 是原地覆盖 | 进程在写的中途被杀（DSH 退出 / 断电 / 杀软锁文件）就留下半截 YAML → 那文件读不动 = DSH 起不来 = `sanitizeProfile` 把 `bundles` 重置。**而那正是这个面板最不该造成的事**：它就是「让改参数变安全」才存在的。备份救不了这一下 —— YAML 坏了没人会想到去用那个 `.bak-时间戳`。改成 `.tmp` → `fsync` → `rename` |
| **N8** | 改一行会吃掉该行自己的行尾注释 | 原来是重新拼整行。文件头注释保住了（这是它引以为傲的"绝不重新序列化"），但被改的那一行的 `# 说明` 会消失。改成只替换 value 片段 |
| **N11** | int 字段 `Math.trunc` 静默取整 | 输 `3.7` 存成 `3`，界面不提示。这几个字段都是「算字数 / 算轮数」的硬阈值，无人察觉的取整不该发生。改成直接报错 |
| ps1:187 | `(14 of them)` | 改成 `13 packages + tools/ scripts; 14th part is dsh-mnemon, an external npm package` |
| huanqi `exports` | `"./src/*": "./src/*"` 而 `src/` 不在 `files` 里 | 打包后是**死链**，运行时才 404。删掉 |

**判为误报的（2 条）**

- **#10「install.js:132 说 tools 是空目录」** —— 这已经是**第二次**被报同一条。
  那段实际写的是「这一段**原来**写的是……—— **那是编的**」，
  是在记录一个已经修掉的历史错误（2026-10-18 第八个洞）。把"记录过去说错的话"读成了当前断言。
- **N12「写回时 BOM 被静默去掉」** —— **实测**：`readFileSync(...,'utf8')` 把 BOM 留成 `\uFEFF` 字符，
  `split('\n')` / `join('\n')` **完整保留**它（实测 `s === back` 为 true），
  代码里也没有任何 strip BOM 的逻辑。**BOM 从头到尾没被动过。**

**没做完的（4 条，如实交代）**

1. **N6 · `agent_soul_scaffold` 的 `roots` 没有路径边界校验** —— 四个自由字符串、`required: []`、
   无任何断言。**这是唯一一个「写用户目录」的入口**，风险是提示注入把 soul 指到别处。
   这条从第二轮就挂着，一直没动。**下一轮必须先做这条。**
2. **N10 · `tools/add-bundle.js` 读-改-写没有并发保护** —— 两个 `dsh plugin add` 同时跑，
   后写的会覆盖前一次的 `bundles.push`，静默丢一个插件（症状是"装上了但没启用"，无报错）。
   概率低，但症状静默。
3. **V1–V4 · 自检脚本自己的盲区** —— 这条批评我得认：`verify-packaging.mjs` 的 90 条断言
   **全是字符串包含**。它举的例子很准：`ps1 有暂存目录` 断言 `includes('dsh-agent-soul-stage-')`，
   而**旧版先删后移的写法也含这个字符串** —— 也就是说 N1 在旧版能全绿。
   补 2–3 条「行为断言」（造临时 profile、故意让 `Move-Item` 失败、断言退出码非 0 且目标仍在）
   的工作量明显大于本轮剩下的时间，**单独做一轮**。
4. **N7 的边界** —— 上一轮加的 `script` 防逃逸只挡了 `..` 和路径分隔符，
   没挡「裸文件名但指向 kit 目录外的软链」。当前所有调用点都传字面量，不构成实际风险。

**一个教训**

这一轮我在同一件事上错得比审核方还多：**改脚本时把 PowerShell 输出前缀（2 空格）当成了文件缩进**，
第一次替换全部未命中；heredoc 里的引号又被吃了两回。
两者都是老问题（AGENTS.md 里都写着），**我又踩了一遍** —— 写脚本之前先 `read` 真容、脚本写成文件，
这两条不该再犯。

### 2026-10-22（同日第四次）· 第二轮审核的七条 + `dsh-mnemon` 从来没进过安装清单

**这一轮有两件事，都不算"改对了"，只是"补上了"。**

**一、第二轮外部审核：13 条里 2 条误报，7 条属实。**

误报那两条我上一轮判错了方向，这轮按证据重新判：

- 说「ORDER 缺 `dsh-mnemon`」—— 我上一轮当成误报，因为 `plugins/` 下没有这个目录。
  这个理由是对的，结论是错的：`parts` 里不该放目录名，不代表 plan 可以不提它。见下面第二条。
- 说「`install.js:132` 注释写 tools 是空目录」—— 那句的上下文是「这一段**原来**写的是…——
  **那是编的**」，是在记录一个已经修掉的历史错误。审核方把"记录过去说错的话"读成了当前断言。

属实的七条里，最重的是我自己上一轮埋的：

**回滚失败却谎报"已恢复"**。`Rename-Item` 带 `-ErrorAction SilentlyContinue`，
失败时不出声；而紧接着的 `Die` 打的是**固定字符串**「previous install restored」。
让 `Move-Item` 失败的原因（文件被占用、权限、磁盘满）通常**同样会让 `Rename-Item` 失败**，
于是用户被告知"放心重启"，然后撞上"包不在、bundles 里还有名字"。

现在回滚结果要核实，失败分支直接写 DO NOT restart DSH yet 并把备份路径给出来。

另外六条：改名失败抛裸异常（`$ErrorActionPreference='Stop'` 下不走 `Die`，残留 stage/zip）；
`install.js` 还有**三处** `JSON.parse` 没去 BOM（其中 `assertProfile` 把 BOM 报成"不是合法 JSON"，
用户会去查语法而不是编码）；`loadPkgNames` 只在 plan 分支调、scan 分支在它之前就 return，
于是装好的 `dsh-huanqi` 在 scan 里永远认不出来；kit 超时 180 秒；kit script 接口允许 `../` 逃逸；
两处死代码。文档侧还有 README 数字和 `SANDBOX-VERIFICATION.md:52` 的过时段落。

**二、`dsh-mnemon` 从来没进过安装清单。这条是我上一轮判错的。**

`soul/07-bundle.json` 里它是 `parts[13]`：

```
dir: 'dsh-mnemon'
layer: 'I-echo'
external: true
required: true
```

**必备、ECHO 层、写着装法和判据**。而 `install.js` 生成 plan 时只沿 ORDER 走，
ORDER 里从来没有它。所以新 agent 从这套东西里学不到 ECHO 还有记忆空间那一半。

一个文件说必备，另一个文件说不在计划里，而人只看后者。

修法：ORDER 的 step 1 加它；`PKG()` 认识外部件（包名就是目录名）；
`installCommand()` 对外部件给 npm 的走法，不给 `file:<仓库>/plugins/dsh-mnemon`
（那是 13 个本地包的位置，它不在那儿）。

顺带发现 `isExternal()` 是死代码 —— 函数早就写好了，注释也明明白白解释这种情况，
但 ORDER 里一个外部件都没有，所以它从写下那天起就没被调用过。

**三、数字口径统一成一句话**

```
07-bundle.json 的 parts = 14 个零件
                        = 13 个本仓库包（plugins/<dir>）
                        + 1 个外部件（dsh-mnemon，在 npm 上）
```

之前「13 个零件包」「14 个插件目录」「14 个通用零件」混着用，读者得自己猜指的是哪个数。
现在 README、INSTALL.md、plugins/清单.md 统一按上面这句写。

**四、自检从 88 加到 90 条断言**

新加两条，其中一条专门守这次的洞：

> **`bundle` 里 `required` 的零件必须都在 `ORDER` 里。**

这条如果早就在，`dsh-mnemon` 不会被漏掉两个月。

另一条：`ORDER` 的总数必须等于「本仓库包数 + 外部件数」，且不许有既不是包也不是外部件的条目。

**教训**：这一轮真正学到的是**误报要两边都验**。
我上一轮看到「ORDER 缺 dsh-mnemon」，查了「plugins 下有没有 mnemon 目录」，
得到"没有"，就判成误报 —— 但审核方说的是"plan 从不提示装它"，
而这两件事的真假是独立的。**我的检查只回答了它没问的那个问题。**

### 2026-10-22（同日第三次）· 外部审核抓到的五条，四条属实

**怎么来的**：这一轮修完之后，我把仓库交给另一家的模型独立审核（只读静态检查，
不跑 DSH、不执行 ps1）。它交了 13 条，我看完自己复核了一遍 —— **没有全信，也没有全不信**。

**结论先说：13 条里我确认了 5 条，全部修掉；其余 8 条是它自己标了「无法验证」的部分
（没有 DSH 运行环境、不能执行 PowerShell），判断合理但不构成缺陷。**
完整报告归档在 `docs/audit-2026-10-22-external.md`，原样保留，包括它没验证的部分。

**①② `install-desktop.ps1` 先删后移，且暂存目录跨卷**（它标为最严重）

我上一版把 `$stage` 放进了 `$env:TEMP`，并在注释里写「同一父目录保证最后是同卷改名」——
**注释和代码矛盾，这是我看漏的**。`%TEMP%` 通常在 C:，而 profile 可能在 D:。
更糟的是交换那一步写成了「先 `Remove-Item $dest`，再 `Move-Item $stage`」：
中间一旦失败，用户就**没有任何包了，而 bundles 里还写着它的名字** → 启动失败 → sanitizeProfile。

改成：暂存目录放到 profile 自己的 `node_modules/.dsh-agent-soul-stage-<tag>`（保证同卷），
交换改成「先把旧目录 `Rename-Item` 备份 → 移入 → 成功才删备份；失败则改回来」。
现在最坏结果是「和装之前一样」，不是「什么都没了」。

**③ `$mustHave` 漏了 `tools/add-bundle.js`**

自检只查 5 项，而脚本后面要靠 `tools/add-bundle.js` 去改 bundles。
检查发生在 swap 之后 —— 也就是说这个文件缺失时，**文件已经换进去了才发现**。
已加进 `$mustHave`，现在是在暂存副本上查，缺了就不 swap。

**④ 手动复制指引写「复制四个文件」，对 3 个包是错的**

`echo` 还要 `echo-config.mjs` / `echo-doctor.mjs`；`memory` 和 `huanqi` 的入口是 `lib/index.js`
不是根级 `index.js`；`model-statusbar` 还要 `probe.ps1`。照着那行字做，会得到
`ERR_MODULE_NOT_FOUND` —— 而那个报错看起来完全不像「少拷了一个文件」。
改成「复制整个包目录，不要挑文件」，并把这几个包为什么不能挑写进注释。

**⑤ `add-bundle.js` 不处理 BOM**

`fs.readFileSync(..., 'utf8')` 不去 BOM。profile 的 `package.json` 若被记事本或
PS 5.1 的 `Set-Content -Encoding UTF8` 存过（带 `﻿`），`JSON.parse` 直接抛，
而 ps1 会把它报成「bundles edit failed」—— 用户完全看不出是 BOM。
现在先 `.replace(/^﻿/, '')` 再 parse。

**⑥ `huanqi` 的 patch name 与包名不一致（最隐蔽的一条）**

`plugins/huanqi/package.json` 的 name 是 `dsh-huanqi`，
但 `cordis.patch.yml` 里写的是 `dsh-agent-huanqi`。13 个包里只有这一个不同。

**我用一手证据确认了后果**：去看本机真正在跑的 `profiles/desktop/node_modules/dsh-huanqi/cordis.patch.yml`，
它写的是 `name: 'dsh-huanqi'`；`bundles` 里也叫 `dsh-huanqi`。
**也就是说：本机能跑，是因为装的是那份对的；仓库里这份是错的，而对外发布出去的正是它。**

**⑦ `install.js` 的 `PKG()` 硬编码前缀**

`const PKG = (dir) => 'dsh-agent-' + dir` —— 对 `huanqi` 算出 `dsh-agent-huanqi`，
而它真实的包名是 `dsh-huanqi`。三处依赖它：bundles 检查、install 命令、plan 的「已装」判断。
所以 `agent_soul_plan` 会对一个**已经装好的 huanqi 喊「缺」**，而用户照着装会装出一个
DSH 认不出的目录名。

改成先从每个子包的 `package.json` 读真实 name 建映射，前缀拼接只作兜底。

**怎么确认改对了**

`tools/verify-packaging.mjs` 从 71 项加到 88 项，新加三组断言：
- 每个包的 `cordis.patch.yml` 里 `name` 必须等于包名（13/13 通过）
- `install.js` 的 `ORDER` 必须覆盖 `plugins/` 下每个包，且不多不少
- `install.js` 的 `PKG` 必须读真实包名，不许只靠前缀拼

跑出来 88/88。另外单独跑了一遍「新旧算法对 13 个包的输出对比」：
只有 `huanqi` 变了（`dsh-agent-huanqi` → `dsh-huanqi`），其余 12 个一字不差。

**教训**：这次真正有价值的不是「修了 5 条」，是**审核方指出的那个模式** ——
> 「修复只覆盖了被报告过的那几个点，没有覆盖同类。」

我上一轮修 `client.js`，修得很认真，但修的是**那一个文件**。
同一个病根（手写清单 / 硬编码前缀 / 依赖未经校验的假设）在别处还有五处，我一处都没去数。
**同一个错误出现两次，就不该再问「这次是哪里错了」，该问「还有多少地方是这么写的」。**

### 2026-10-22（同日第二次）· 失败路径：装到一半的目录不该留下

**改之前**：`install-desktop.ps1` 的顺序是「建 `node_modules\dsh-agent-soul` → 往里面拷 → 自检」。
自检失败会 `Die` 退出，**但那个建了一半的目录留在原地**。

`package.json` 确实没被动过（这点从第一版起就是对的），可是用户下次来看，
会看到一个残缺的 `dsh-agent-soul` 目录 —— 它既不是"装好了"，也不是"没装过"，
而最难诊断的正是这种中间态。

**顺带发现的一个真坑**：直接 `& .\install-desktop.ps1` 会被执行策略拦住，
报 `PSSecurityException` / `FullyQualifiedErrorId : UnauthorizedAccess`，**脚本一行都没跑**。
文档里写的 `powershell -ExecutionPolicy Bypass -File ...` 是能过的，但没写"直接 & 会怎样"。
判据补上了：**看输出里有没有 `dsh-agent-soul - desktop install` 这行标题** —— 没有就是没跑，
别去怀疑脚本逻辑。这一条是我自己测失败路径时撞出来的，不是想出来的。

**改法**：拷到 `%TEMP%\dsh-agent-soul-stage-<tag>` → 在**暂存目录上**自检 →
缺任何一样就删暂存目录退出、**profile 一个字节都不碰** → 全齐了才 `Move-Item` 到位。
暂存放 `%TEMP%` 是为了让最后那步是跨目录移动而不是跨盘拷贝。

**怎么确认改对了**：假 profile + 一个不存在的 git ref（模拟下载 404）。

```
  ok   profile: ...ake-profile-test
  ok   node: ...\primary-runtime\dependencies
odein
ode.exe
  get  https://github.com/cyanwell/dsh-agent-soul/archive/refs/heads/definitely-no-such-branch.zip
  FAIL download failed: 远程服务器返回错误: (404) 未找到。
```

事后核对三项：`package.json` 的 SHA256 **没变**、`node_modules/` **没被创建**、
`bundles` 还是原来的 `["keep-me"]`。

**教训**：**「装不上」是可接受的结局，「装到一半」不是。**
所以四道关（下载、解压、拷贝、自检）全部排在改 `bundles` 之前 ——
失败可以发生，但必须发生在碰用户配置之前。

### 2026-10-22 · `client.js` 没装进去 → 桌面端启动崩，连带重置用户配置

**改之前**：`package.json` 没有 `files` 字段，`install-desktop.ps1` 的拷贝清单里也没有 `client.js`。

pnpm 在某些 node-linker 模式下只搬白名单里的文件，没写白名单就只搬 `main` 和 `exports` 直接指向的那几个。
`client.js` 不是 `main`，于是掉了 —— **而它掉了不是「少个界面」，是整个启动失败。**

**怎么发现的**：两位装插件的人先后撞上，第二位把整条链写清楚了。

`dsh` 启动时报：

```
dsh: startup failed: 1 required plugin did not activate
Failed plugins (1):
  modules (required)
    AggregateError: client-modules: 1 client package failed to compose:
      client bundles not found; run `pnpm run build` before launch:
        - package: dsh-agent-soul
          path: C:/Users/<你>/.dsh/profiles/desktop/node_modules/dsh-agent-soul/client.js
```

真正的伤害在后面：启动失败会触发宿主的 `sanitizeProfile` 原生恢复 ——
`bundles` 被重置成只剩内置包（**用户自己的其他插件全部下线**），
`cordis.patch.yml` 被 rename 备份后写成模板（**patch 配置全丢**）。

**复现与验证**（用 `dsh --from-default-profile` 建两个一次性 profile，测完即删）：

| 场景 | 结果 |
|---|---|
| `web` 模板 + 有 `client.js` | 正常起服务，打印 `dsh web: http://127.0.0.1:...` |
| `web` 模板 + 删掉 `client.js` | **上面那段 startup failed，一字不差** |
| `headless` 模板 + 删掉 `client.js` | **照常跑出结果** —— headless 不加载 client bundle |

★ 这条边界很重要：**只有带 UI 的 profile（web / desktop）会崩，headless 不会。**
所以「删了 client.js 测一下」如果拿 headless 测，会得出「没事」的假结论。

另外在干净沙箱里正常安装后 `--dump-config`，`dsh-agent-soul` 出现在 375 行配置树尾部，
真跑一次任务时 `agent_soul_*` 八个工具全部注册 —— 这才算「装上了并且在跑」。

**改法**：

- `package.json` 加 `files` 白名单（15 项，`client.js` / `plugins/` 等全列进去）
- `install-desktop.ps1` 的 `$files` 补 `client.js`，`$dirs` 补 `plugins`，
  并加一步**在改 `bundles` 之前**的硬自检 —— 缺 `client.js` / `index.js` / `cordis.patch.yml` /
  `package.json` / `plugins` 任何一样就退出，什么都不碰。**宁可这次没装上，也不能装到一半把人家环境搞坏。**
- `plugins/` 下 7 个原本没有 `files` 的子包补上（最危险的是 `echo`：它带 `echo-config.mjs` 和
  `echo-doctor.mjs`，两个都既不是 `main` 也不在 `exports` 里，会静默消失）

**怎么确认改对了**：真 pnpm 安装后逐项确认 `client.js` 存在、`plugins/` 有 16 项、
`--dump-config` 里有 `dsh-agent-soul`、实跑时 8 个工具注册。四样全部通过。

**教训**：手写的拷贝清单，写一次就会漏一次 —— 而且这回是**两份清单各漏各的**：
先修了 `package.json` 的 `files`，以为修完了，其实只覆盖了 `dsh plugin add file:` 那条路；
桌面端走的是 `install-desktop.ps1`，它根本不看 `files`。
**「改完一处」不等于「全都改完了」，得把同一件事的每条路径都数一遍。**

★ 最稳的做法是 junction（装出来的目录直接指向源，源里有什么就装什么），但它要求开发者模式许可，
不能当默认路径推给所有人，所以写在 `INSTALL.md` 里作为「更稳的做法」。

### 2026-10-19（同日第四次）· 换气判词那一块差点变成流水账

**改之前**：`hq.turns.slice(0, 8)` —— 固定显示最近 8 条判词。
上限是有的，但形状不对：8 行约 130px，攒满之后一直占那么大一片，把下面的体检项往下挤。
而挤掉的那些位置，几乎全给了一路 `skip:had-output` —— 那恰恰是最不需要天天看的东西。

**是爀曦先问的**：「这个栏目最多展示最近几条？我怕你忘记设置，然后它不断更新，把下面条目都占用完了。」
问得准 —— 我当时只想到「别让它无限长」，没想到「8 条也会一直占着」。

**改法**：不按条数截，按**有没有出事**分层（和这个面板原有的 hot / good 同一个道理）：

- `continue` / `circuit-break` —— 全显（上限 6 条）。这些是真正出过手的记录：额度掉了、判据动过，不该被折叠
- `skip:*` —— 折叠时只留最近 2 条，底部一行可点开全部
- 总轮数 ≤ 3 时，那行折叠提示根本不出现

效果：这一块平时稳定 2 行，出事才长出来 —— 而长出来的时候，正是你需要看它的时候。

**教训**：「设了上限」不等于「设计对了」。上限只回答「最多多少」，
没回答「多出来的那些里哪些值得占位置」。**流水账的毛病不在长度，在于它把重要的和正常的摆成一样高。**

### 2026-10-19（同日第三次）· 换气「没报错却不工作」：它被插件管理器按版本判了死刑

**怎么发现的**：判据 ④ 修完、测试全绿、配置也核对过，但真实会话里**还是不触发**。
爀曦自己去设置页翻，截了一张图回来 —— `dsh-huanqi v1.0.0` 旁边一行红字：

> 原因: dsh-huanqi@1.0.0 与 DSH 0.2.1-rc2 不兼容。
> 要求 @deepseek-ai/dsh-agent ^= 0.1.12-rc.1 || >= 0.1.3-alpha.2 <0.1.4 || … <0.2.0

**真相**：`package.json` 的 peer 范围卡在 `<0.2.0`，而当前桌面端是 **0.2.1-rc2**。
插件管理器判定不兼容，把 `disabled: true` 写进 profile 的 `cordis.yml` 并固化 ——
于是 `apply()` 一次都没被调用过。账本的时间戳停在 **10-18 02:16**，正好是它最后一次真正工作。

**一条被我自己误读的证据**（这条教训比修复本身值钱）：我在 `apply()` 开头加过启动探针，
看到 `huanqi-boot.log` 有 59KB/130 行，一度以为「插件在跑」。查下去才发现 ——
那 130 行全是**我跑测试**留下的（`apply()` 在测试里也会执行），
而 DSH 进程是 13:32 启动的、探针是 13:39 才写进文件的，**进程里跑的根本不是带探针的代码**。
「文件有新内容」不等于「那个进程调用了它」。

**修法**：peer 范围加一条 `>=0.2.1-rc2 <0.3.0`。

★ 这里有个坑，第一次修还修错了：我先图省事写成 `>=0.1.2-rc.1 <0.3.0`，测试立刻红了四例。
那个测试守的正是「**只许声明真正验证过的版本**」。而按 semver 规则，一条 comparator
只在同一组里出现同 `major.minor.patch` 的 comparator 时才 admit 那处的 prerelease ——
所以那个写法**既不 admit 0.2.1-rc2，又会误 admit 没测过的 0.2.x 正式版**，两头都错。
唯一正确的形状是给 0.2 线单独加一条同 tuple 的 comparator。
测试的 `SUPPORTED` 里也补了 `0.2.1-rc2`，并**写明它的依据是真实 DSH 运行验证、不是本测试套件** ——
守卫不许被悄悄放宽，但依据变了要如实说。

**顺带做的第二件事：把它从「不可视」变成「可视」**。
判断原本只进 `ctx.logger.warn`，而 DSH 桌面端的 logger **不落盘**（state / storages / logs 三处都翻过，没有痕迹），
所以「换气到底有没有在看着这一轮」在机器上没有任何证据。现在：

- 换气每轮结束往 `<DSH_HOME>/state/huanqi-turns.jsonl` 写一条判词
  （kind / 最后一条消息形状 / 有没有产出 / 判词 / 剩余额度，最多 2000 行）
- `apply()` 末尾再补一行 `done`，和开头的 `entered` 配对 ——
  **只有 entered 没有 done = apply 中途抛错了**，这两种情况以前分不开
- 回声面板新增「换气 · 每轮判词」区块，读那份 JSONL（宿主半 `/yanqing-echo/api/huanqi`，2 秒缓存）

**验证**：重启后 `huanqi-boot.log` 出现 `05:52:57Z apply() entered` 且 config 与 `cordis.patch.yml` 逐字一致
（`maxContinuations:6 … silentReasoningChars:8000 … emptyTurnContinue:true`）；设置页从「异常 / 禁用」转为「运行中」。
三仓测试 196 / 198 / 196 全过。改动已推到 `dsh-agent-soul` 的 `1eac1f4`。

**教训**：这个仓库的零件有**三条静默失败路径**，症状完全一样（「文件在、配置对、就是没动静」）：

1. `exports.inject` 少了 / 服务名写错 → apply 永不执行
2. 宿主半注册了重名工具 → 整棵插件树加载失败
3. **peer 版本越界 → 管理器自动 disabled**（这一条最隐蔽：它不报错、不退出、只是把节点标成 disabled）

三条的共同点是：**「装好了」和「在跑」之间隔着一次真实的调用证据**。
所以判据不该是「文件复制过去了」，而是「它留下了只有运行才会留下的东西」——
一条日志、一份产物、一个工具名。这次补的 JSONL 就是为了让这条判据以后有地方可落。

### 2026-10-19（同日第二次）· 判据 ④ 看错了地方：它看整轮，实际要防的是「最后一脚踩空」

**怎么发现的**：修完当天就在真实会话里撞上了。爀曦的原话：

> 「前面有正常思考和调用文件、读写，但是**到最后一步思考的时候停留在思考里了**，
> 没有再继续调用，输出，结果就是最后一步没有正文输出，这个换气没有检测到」

**错在哪**：第一版记的是「这一轮里**任何一次**产出」——

```ts
if (has) turnHasOutput.set(sid, true)   // ← 只要有一次产出，整轮就算「有产出」
...
if (turnHasOutput.get(sid) === true) return  // ← 前面调过工具，这里就永远跳过
```

而一次正常回合里，**读文件、写文件每一步都是 tool-call** —— 所以只要前面动过手，
最后一步卡死它就不管了。

**判据 ① 为什么也没接住**：流内早杀要求思考够 `silentReasoningChars`（默认 3000）才动，
而「最后一步想了一会儿就停住」常常够不到那个量。**两条判据都漏在这个形状上。**

**修法**：改成看**最后一条** assistant 消息，而不是「任何一个」。每收到一条就**覆盖**，不是 OR 累积。

```ts
if (type === 'assistant/message') {
  lastMessageHadOutput.set(sid, has)   // 覆盖
  return
}
if (type === 'turn/end') {
  if (lastMessageHadOutput.get(sid) === true) return   // 最后一条有产出 → 正常
  // 否则 → 卡住了，续
}
```

**为什么「最后一条是 tool-call」不等于卡住**：一轮以工具调用收尾是**正常**的
（它在等工具结果，或者这轮就该结束）。只有「以纯思考收尾」才是踩空。加了对照组测试钉住这一点。

**顺带补了诊断日志**：出手和不出手都留一行 `turn/end kind=… 最后一条有产出=…`。
起因是那次发生时**查不到任何痕迹** —— 判据没动，也没说为什么，只能靠猜。

**验证**：新增 2 例（真实形状 + 对照组），三仓 196/198/196 全过。

**教训**：第一版测试全是「整轮有没有产出」，**没有一个用例在前面调过工具** ——
所以 11 个用例全过，而真实形状一次都没被覆盖。**测试贴着实现写，就会漏掉实现想岔的那个方向。**

### 2026-10-19 · 换气吸收空回合判据（四条判据共用一本账）

**改之前**：`dsh-agent-huanqi` 只覆盖三种退化，而且全部挂在 `llm/stream` 上 ——
流内早杀 / 流末判定 / 输出重复。共同前提是「有一次模型调用，而且流里有东西可看」。

第四种退化落在缝外面：**整个回合结束了，一个字节都没吐** —— 只发 reasoning 块，
然后直接 end-of-turn，没有 text、没有 tool-call。引擎认为这一轮正常结束，auto-continue 不管它，
会话就停在那儿等人手打「继续」。此前靠独立插件 `dsh-stalled-turn-continue` 兜底。

**为什么改**：两套判据各记一套账（换气的 `ledger` 跨会话共享，stalled 的 `maxConsecutive: 3` 按会话），
**一轮会被续成两轮**；更麻烦的是「额度」这个概念被劈成两半。

**改了什么**：判据 ④ 挂在 `session/event` 的 `turn/end` 上（只有它知道「整轮结束」），
命中后走换气自己的 `ledger`，四条判据扣同一分、用同一个上限、触发同一个熔断。
新增配置 `emptyTurnContinue`（默认 `true`）。stalled-turn-continue 退休。

**抓到一个真 bug**：第一版写的是 `if (config.emptyTurnContinue && ...)`。zod 的默认值
`true` **只在数据经过 schema 解析时才生效**；绕过解析的路径（测试夹具、直接注入配置、
旧版本升级）拿到的是 `undefined`，真值判断当 `false`，**整条监听压根不注册** ——
判据永远不工作，不报错、不留日志。改成 `!== false`。

**这个 bug 是被新测试抓出来的，不是被现有测试抓出来的**。因为 `silent-cut.spec.mjs` 里的
`host()` 只注册 `llm/stream`，新加的 `session/event` 监听在原来那 185 个测试里
**一次都没被触发过**。所以「185 个测试全过」当时是真的，但它证明不了新功能。

**验证**：新增 `test/empty-turn.spec.mjs`（11 例），全量 **196/196 全过**。

### 2026-10-23（同日第八次）· 实机验收：五处「两边各自都对，拼起来是错的」

第一个用户的实机验收报告（2026-10-23）挑出五条。它们的形状是同一种：
**体检器和安装引导各说各的** —— 于是体检永远报警，或者照着引导做立刻撞墙。

| 编号 | 改之前 | 改成了什么 |
|---|---|---|
| **C1** | `agent_soul_plan` 第 6 步给的体检命令是裸的 `node echo-doctor.mjs`，不带三个根 → 用户照抄会报「还没配好：没有配置 SOUL…」 | 命令带上 `--soul/--memory/--sessions`（`echo-config.mjs` 的 argv 支持 + `kit/echo/plan.mjs` 的 `doctorCmd()`）；doctor 自己也能接这三个参数 |
| **C2** | 门牌判据用**子串匹配** —— 摘要**正文里提到**门牌格式（比如这个会话本身在排查门牌）就被判成「有门牌」 | 改成**结构判据**：第 0 块必须以门牌标记开头（`⛬` 或直接 `log:session-…#seq=`）且是短行；正文提到门牌字样不再参与判定 |
| **C3** | `memory` 参数**多传一层目录**（`.../memory/hub`）时静默降级：报「索引还没建过」，而少传一层报「装好了」——两个结论相反 | 明确报错：「MEM 传深了一层：你给的是 …/hub」，并给出改成上级的写法。**下一步不再让人重跑 scaffold** —— 参数错用 scaffold 修不好。★ 而且这句话原来在 `checkConfigState()` 和 `runDoctor()` 的提前返回里**各写一份**，改一处漏一处（本次实测抓到）；现在收成一个 `configAdvice()`，下一步建议只有一份来源 |
| **C4** | `install-desktop.ps1` 只在 `%LOCALAPPDATA%\Programs` 下找 node，PATH 里没有就 `Die`；DSH 装在别的盘时脚本第二步就退出 | 多候选：`DSH_NODE` → 从 profile 上推 DSH 安装根再试两种已知布局 → 常见安装位置 → PATH。全找不到时**列出试过哪些路径 + 三条可执行的下一步**（含怎么设 `DSH_NODE`） |
| **R1** | 仓库版 `self.mjs` 只读 `state.json`、**不写** `lastSelfAt`，而 doctor 的 L0 时钟读它 → 体检永远报「没有 lastSelfAt」 | 让 `self.mjs` 写它（**那是装配器的责任，观测面不该替它圆**）；而且 **state.json 不存在/坏了也要写**（否则新装第一次装配不留痕迹，又变回「没人写」）。doctor 同时把「字段缺失 = 未启用」和「字段过期 = 真异常」分开说 |

## 怎么验的（每条都跑了，不只看代码）

- **C2 正反两面**都造了夹具（临时目录 + `zstdCompressSync` 日志）：
  正文提到门牌 → `error`；真实格式 `> ⛬ 压缩索引… #seq=10` → `ok`，且**真取回** seq=10 并与 `shadowedRange` 对上
- **C3**：`--memory .../memory/hub` → `error`（含「传深了一层」+ 改正写法 + **明确说「重跑 scaffold 不会修好它」**，`pathShapeWrong=true`）；`--memory .../memory` → `ok`
- **C4**：PowerShell 解析零错；三种路径实跑 —— ① `DSH_NODE` 显式指定 ② 自动找到 DSH 自带 node ③ 全都找不到时打印下一步（exit 1 是预期的）
- **R1**：在一份**没有 state.json** 的临时目录里跑仓库版 `self.mjs` → 第一次装配就写出 `lastSelfAt`，第二次 `selfRuns` 从 1 → 2；HUB 版实跑同样写（`selfRuns` 4 → 5）
- 三份 `echo-doctor.mjs` 改完 **md5 一致**（`e677adf592187369fecfff75f3357c43`），`install-kit.mjs --check` 报「全部一致」，`.kit-origin.json` 已刷新（`echo-doctor.mjs` 59257 B）
- 改后体检实跑（deep，`DSH_HOME` 指向真实 home）：**0 错 / 4 警 / 11 好**，其中
  `✓ L0 时钟（state.json）  self.mjs 最近一次装配 0 小时前` —— R1 那条不再是 `!`

## 还留着的（这次没做）

`门牌回取` / `压缩机制` 两项取的是**最新一份日志**。一个刚开、还没压缩过的会话会让这两项报
「这份日志里还没有压缩摘要」——**那是「没有数据」，不是「坏了」**。
判据该改成「在所有日志里找最近一条带摘要的」，或者把这两项在「最新日志无摘要」时降成 info。
这次没动：它不属于 C1–C4/R1，且改了会动到深检的取样逻辑。

### 2026-10-23（同日第九次）· 路径不再假定「作者机器」

上一条修的是**口径对不上**。这一条修的是同一个病的另一半：**路径假定**。

十项缺陷（用户报告 E1–E10）+ 我们自己复审又挖出的九项，共同形状是一句话：

> **代码在作者机器上是对的，换台机器就静默变空。**
> 不报错、不崩溃 —— 插件加载成功、界面在、路由在，只是里面没有数据。

作者机器上有特殊条件盖住了它们（环境变量恰好有值、目录恰好存在），
换机器才露出来。**所以症状永远伪装成「这一项空的」，不是「这个插件坏了」。**

| 编号 | 改之前 | 改成了什么 |
|---|---|---|
| **E1** | echo 用 `process.execPath` 起子进程。Electron 里那是 `DeepSeek Harness.exe`，不是 node → spawn 拿空 stdout、**不报错** | `resolveNode()`：`process.versions.electron` 存在就先按已知布局找 DSH 自带 node，再限深度浅扫；**找不到返回 execPath，让 spawn 报可见的 ENOENT**（可见的错好过静默的空） |
| **E2** | echo 的 `HUB = $DSH_HOME/hub`，而中枢和 DSH_HOME **没有固定关系** | `resolveHub()`：判据反过来 —— **先确认 `echo-doctor.mjs` 真的在那儿**；候选 `ECHO_HUB` → `$DSH_HOME/hub` → `~/.dsh/hub` → `echo.config.json` 的 `memory/hub` |
| **E3/E4** | huanqi-panel 的 `DSH_HOME` 默认成 `~/dsh/home`；账本路径写死 | `resolveDshHome()`（`DSH_HOME` → 插件覆盖 → `~/.dsh` → `~/dsh/home` **存在才用**）；账本改为 `PANEL_LEDGER` → profile 的 `huanqi.ledgerPath` → `<DSH_HOME>/state/…` |
| **E5/E6/E7** | splash 配置路径写死；首次打开没数据 | 配置路径三级候选；会话目录从家目录**派生**；首次打开自动 `mkdir` 并落盘默认配置 |
| **E8** | 面板的**浏览器半**把后端端口写死 `19387`（DSH 端口每次启动都变） | 改**同源相对路径** `/agent-…/api`，让页面自己的 origin 决定；splash 默认 `port: 0`；桌面启动器 `splash-inject.js` 的两处 `19387` 也改成 0 |
| **E9/E10** | yantai 五处写死路径、账本名误写 `02-ledger`、机器名/`.\apps`/手机地址写死 | 全部环境自适应；账本改回真名 `02-墨.jsonl`；机器名用 `os.hostname()`；apps 锚插件自身目录；手机地址未配时**明说「未配置 + 怎么配」** |
| **复审新增①** | `model-statusbar` **全文件零 `process.env`**，而 README 白纸黑字承诺三个变量可配 → 拉起永远找不到 python、改端口仍探 8188、状态文件按 cwd 写 | README 承诺的三个全部兑现（另补三个口子）；「拉起」没配时明确报「请设 COMFYUI_DIR / COMFYUI_PY」 |
| **复审新增②** | `riji` 的 `DIARY_DIR = RIJI_DIR \|\| cwd/diary` → 用户机 cwd 下没这个目录 → `/api/list` 返 `[]` → 界面永远「还没有日记」 | 三级候选 + 目录不在时 `ok:false` 带说明。**这是「装上了、界面在、里面空的」的教科书样本** |
| **复审新增③** | `memory` 的 `selfPath/statePath` 相对 cwd | `MEMORY_SELF` / `MEMORY_STATE` + 锚插件目录 |
| **复审新增④** | `tools/gateway` 默认 `HERE/../../soul` 在仓库布局下解析到不存在的目录 → 索引 0 条 | `SOUL_HOME` 必配；未配置 / 目录不存在 / 账本不存在 → **明确提示并 exit 1**，不再产出假索引 |

**顺带清掉的两个真坑（都不是「别人机器才会坏」，是本机就会坏）：**

- `.gitignore` 里有 `selftest.mjs` 这条**无前缀全局匹配**，把 `model-statusbar` / `riji` / `yantai` 三个包**正式的自检脚本**一起忽略了 —— 而三个 `package.json` 的 `files` 里都列着它。**从 git 打出来的包会缺自检脚本，本机却测不出来。** 和「作者机器上永远走不到的兜底」是同一个形状。
- `kit/echo/plan.mjs` 输出的体检命令是字面 `node xxx.mjs`。第一个用户**PATH 里没有 node** —— 照抄只会得到「不是内部或外部命令」。改用 `process.execPath`（带空格时加引号）。★ 这条和 E1 是同一个病的两面：一个在进程里 spawn，一个在文档里让人手敲；**后者更容易被忽略，因为它不报错，只让人失败。**

## 怎么验的

新增 `D:\AI\dsh-tools\verify-lossless-paths.mjs`，把「不许出现的形状」写成断言：

```
硬禁止（代码）: 0  ->  ✓ 通过      改前 21 条（代码里 6–8 条）
同源漂移      : 0  ->  ✓ 一致
软警告        : 14 ->  人工判断（空 catch 是防御性写法；注释里的历史引用可留）
```

它同时纠了我自己一个错判据：原来要求「仓库版与本机版**整文件字节相等**」——
而两份本来就是**同一套代码的两个命名空间形态**（`dsh-agent-*` / `dsh-yanqing-*`），
字节相等是不可能的。错判据的后果不是误报那么简单：**它会对正确的两份喊漂移，于是真的漂移混在里面也看不出来。**
现在改成「命名空间归一后相等」。

## 还留着的

- `plugins/huanqi` 在 `DSH_HOME` 为空时曾把账本 / `huanqi-turns.jsonl` / 启动日志落到**进程 cwd** ——
  落点随启动目录漂移，写不进去时只 `logger.warn`（桌面端不落盘）→ 额度静默重置。
  **本日已修**：三层（账本、turns、boot log）统一兜底到 `~/.dsh/state`，
  和换气面板找的位置对齐。★ 这个 bug 只有 `DSH_HOME` 为空的机器上才显形 —— 作者机器上永远有值。
- `plugins/echo/index.js` 的换气读端读 `<DSH_HOME>/state`。
  **本日已核**：它的 `DSH_HOME` 兜底也已经是 `~/.dsh`，和上面写端的兜底**同一个落点** —— 两边不再分叉。
- `dsh-yanqing-line/scripts/anchor.mjs` 读 `COMFY_HOST` 而文档写的是 `COMFYUI_HOST`，名实不符。本机版专用，不分发，没动。

### 2026-10-17 · 再扫一遍旧口径

文档里还留着「四个工具」「12 份知识文件」这类过期数字。第二轮扩到
`.md/.json/.yml/.html/.js/.mjs/.ps1` 全类型，又挖出 15 处，全修。

★ 教训：**扫旧口径只扫 `.md` 会漏** —— 数字也活在代码注释和 HTML 里。

### 2026-10-17 · 裁判指出的三处硬伤

三个都属实：① `index.js` 的 doctor 文件清单漏了 `soul/12-ledger.md`，
**而注释就在头上写着「漏了会漏检」** —— 检测法本身漏检，修法不是补一行、是**改成扫目录为准**；
② `cordis.patch.yml` 写着「只加三个只读工具」，实际 8 个；③ GitHub README 旧版缓存。

### 2026-10-14 · 换气放宽流内早杀阈值（3000 → 8000）

3000 会误杀约 7.9% 的正常长推理（全量 7533 步里，3000 字以上的正常步共 592 个），
当晚实测被误截断 4 次、全是正常思考，额度被误耗到 0 导致熔断。放宽到 8000 后误杀率降到 0.37%。

★ 真正的主力是流末那层 —— 全史 4 次循环全中、正常步零误报。流内这层只负责「别等它自己停」。

### 2026-10-12 · 换气 v1.0

从 `dsh-loop-guard` fork，吸收 `dsh-reasoning-only-guard` 的空消息保护，加上延续额度和熔断。
三件套第一次凑齐：检测 → 续跑 → 熔断。

★ 额度定为「体温计」而不是「配额」：靠正常对话慢慢攒，异常时下降，最低 1 点。
理由是配额会让 agent 把注意力放在「我还有多少」上，而体温计只让它知道「我现在状态怎么样」。

## License

MIT
