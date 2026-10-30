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

★ **想知道「每一格现在由谁填、哪格还空着」** → [docs/架构缺口清单.md](docs/架构缺口清单.md)。
一句话结论：**9 格里 7 格有明确归属**，唯一空着的是 Ⅱ 层的「目标与什么算做完」——
而那份文档的结论是**别急着为它写插件**（理由在那一篇里）。

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

### 2026-10-30 晚 · 安装层补两个静默洞 + 包名统一到 `dsh-agent-*`

**背景**：`dsh-yanqing-*` 是本机专属插件的命名空间，对外发布不该带这个名字。
但仓库里 `echo` / `huanqi-panel` 两个包已经改成了 `dsh-yanqing-*`，
而 `presets/` 引用的又是另一套名字 —— **装了但 preset 找不到包，静默降级。**

**这一版统一到 `dsh-agent-*`，并补两个「不装也不报错」的缺口：**

| # | 缺口 | 症状 | 修法 |
|---|---|---|---|
| 1 | `mcp-hub` 不在 `ORDER` | ECHO 的 MCP 召回没有底座，**召回静默空** | `ORDER` step 1 补 `mcp-hub` |
| 2 | `compact-region` 本仓库没有 | 换气的范围压缩退化成全量，**谁都不报错** | 补 `plugins/compact-region`，并入 `ORDER` |

**包名统一（4 处）：**

| 位置 | 改前 | 改后 |
|---|---|---|
| `plugins/echo/package.json` | `dsh-yanqing-echo` | `dsh-agent-echo` |
| `plugins/echo/client.js`（`load({id})`） | 同上 | 同上 |
| `plugins/huanqi-panel/package.json` | `dsh-yanqing-huanqi-panel` | `dsh-agent-huanqi-panel` |
| `plugins/huanqi-panel/client.js` | 同上 | 同上 |

★ `client.js` 那一行**必须跟着改** —— `id` 与 `package.json.name` 不等时，
client-modules 对不上注册表，整个 web boot 批次不激活，桌面端直接起不来。
`node --check` 查不出这种错，它只查语法，不查配对。

**写死路径（3 处）：**

`install.mjs` / `tools/soul-doctor.mjs` / `tools/soul-preset.mjs` 原来都兜底成
`'D:/AI/dsh/home'`。别人机器上会去读一个不存在的目录，于是 doctor 报「全是红的」，
真实原因却只是工具指错了地方。现在改成 **`DSH_HOME` 或 `--home`，都没有就明确报错** ——
按 `install.mjs` 自己写的铁律：不猜。

**同时修**：`plugins/compact-region/index.js` 的诊断日志从写死
`D:\AI\memory\hub\_plugin-diag.log` 改成 `DSH_PLUGIN_DIAG` 或系统临时目录。

**自检**：`node tools/verify-packaging.mjs` → **121 / 122**。

### 2026-10-30 深夜 · 清掉旧口径与两处会误导人的本机路径

**做这件事的起点**：这台机器上装的包叫 `dsh-yanqing-*`（专属命名空间），
而仓库发布的是 `dsh-agent-*`。两套名字并存久了，**文档和代码开始各说各话**。

**扫出来三类，性质完全不同 —— 分开处理：**

| 类 | 例子 | 处理 |
|---|---|---|
| **会让用户照着做错** | `AGENT-INSTALL.md` 全文用 `dsh-yanqing-*`；`AGENT-INSTALL.md` 的 `"home": "D:/AI/dsh/home"` 示例 | **必改** |
| **代码里写死只认一套** | `soul-doctor.mjs` / `soul-preset.mjs` 的 `REQUIRED` 只列 `dsh-yanqing-*` | **必改（会误报缺件）** |
| **历史记录 / 审计对象** | `docs/audit-2026-10-22-*.md`、`.gh-issues/*` | **不动**（改了就篡改历史） |

**具体修了：**

1. **`AGENT-INSTALL.md`** —— 10 处旧包名改成 `dsh-agent-*`；
   `"home"` 示例从本机路径改成通用占位符。
   ★ 这份是**安装向导**，用户照着它装 —— 写错名字等于让人装一个不存在的包。
2. **`tools/soul-doctor.mjs` / `tools/soul-preset.mjs`** —— `REQUIRED` 改成**双前缀都认**：
   ```js
   const PART_PREFIXES = ['dsh-agent-', 'dsh-yanqing-']
   const partNames = (dir) => PART_PREFIXES.map((p) => p + dir)
   ```
   判据是**任一前缀存在即可**，不要求两套同时装。
   ★ 不这么改的话，doctor 在发布版机器上会对着装好的包喊「缺件」。
3. **`plugins/echo/client.js` 的注释** —— 它写着「包名是 `dsh-yanqing-echo`」，
   而代码里 `id` 早已是 `dsh-agent-echo`。**注释和代码对不上比没有注释更坏**，改了。
4. **`plugins/huanqi/cordis.patch.yml` / `package.json`** —— 从 organs 迁入时它写的是
   `dsh-agent-huanqi`，而正确名字是 `dsh-huanqi`（本机 profile 与 install.js 注释两边都证实）。
5. **`docs/安装常见问题汇总与解决方法.md` / `HOW-TO-TAKEOVER.md`** —— 排错手册里的旧包名，同步。

**顺手做对的一件事：把两个导出快照移出版本库。**

`presets/_manifest.json` 和 `soul-version.json` 是 `tools/soul-preset.mjs --export`
生成的**安装状态快照**，里面带着 `"source": "D:\\AI\\dsh\\home\\..."` 这种本机路径。
它们记录的是「某台机器某时刻装了什么」，**不是仓库内容**。已加进 `.gitignore` 并从 git 移除
（本地文件保留）。全库确认过：没有任何代码读这两个文件。

**自检**：`node tools/verify-packaging.mjs` → **121 / 122**
（最后一项 `README 有 2026-10-22 的更新记录` 是历史项，非本次引入）。

**doctor 实测**：`node tools/soul-doctor.mjs --layer L1` → `4/4 都在`
（本机装的是 `dsh-yanqing-*`，双前缀改动生效）。

### 2026-10-30 深夜二 · `agent_soul_install plan` 补上了 huanqi 的安装形态限制（GitHub #5）

**起点**：issue #5（TaoCultivator）报「桌面打包版下 compaction / pruner / huanqi 三个零件
import 阶段就失败」。核对源码后确认他的根因分析成立，但要把它拆成两半 ——
**这三个里有两个有绕路，一个没有。**

| 零件 | 为什么失败 | 有绕路吗 |
|---|---|---|
| `compaction` | 要 import `@deepseek-ai/dsh-compaction`、`dsh-compaction-basic` | ✅ 有：realm 内同 id 换 name（替换内置） |
| `pruner` | 要 import `@deepseek-ai/dsh-compaction-tool-result-pruner` | ✅ 同上 |
| **`huanqi`** | 要 import `cordis` / `schemastery` / `dsh-llm` / `dsh-compaction` | ❌ **没有** —— 它是新增，不顶掉任何内置条目 |

**改了什么**：`install.js` 的 `plan` 输出里，原来只有 `if (s.step === 1)` 提示
「compaction/pruner 别走路 A、走路 B」；`huanqi` 在 step 2，**从来没被提示过**。
现在补了 `if (s.step === 2 && isDesktop)` 一段，说清三件事：

1. huanqi 没有绕路（不是替换、是新增）
2. 它要 import 哪四个包（已核对 `lib/index.js` 第 176-179 行）
3. 要装它得换一种能解析到内部包的 DSH 安装形态（源码 / CLI）

同时声明**本步其余零件不受影响**（clock / model-statusbar / huanqi-panel 照常装）。

**没做的两件（诚实记下）：**

- **没能减掉依赖**：`Context`（cordis）和 `createUserMessage`（dsh-llm）在源码里只作类型用，
  本该是 `import type` —— 但仓库和本机都**没有 tsc**，改 `src/index.ts` 会造成 src/lib 不一致。
  **宁可不改，也不留一个编不出来的源。**
- **没验证 `createRequire` 方案**（issue-5 建议 2）：本机是源码形态，没有打包版环境可测。
  **没验证的事不写进文档当结论。**

**自检**：`node tools/verify-packaging.mjs` → **121 / 122**。

### 2026-10-30 深夜三 · 两个 `echo-doctor.mjs` 副本终于一致了

**先说结论**：issue #1 和 #3 的**代码修复 10-23 / 10-25 就做完了**，不需要再改。
`detectExternalCompaction()` 在，换气判据也换成了读 `dsh-huanqi.json` 的账本。
**但这两个修好的版本只落在 `kit/echo/` 里一半，`plugins/echo/` 落后了 6 行。**

**这才是真问题**：仓库里有两份 `echo-doctor.mjs`，内容不同。

| 副本 | 用途 | 当时状态 |
|---|---|---|
| `kit/echo/echo-doctor.mjs` | 独立发行版 / GitHub Actions | 更新 |
| `plugins/echo/echo-doctor.mjs` | echo 插件自带的那份 | **落后 6 行** |

**用户不知道哪份是准的**，而两份都叫同一个名字。这次把两边拉齐，并顺手把劣的那半提升：

1. **`HQ_STATE` 的三候选查找** —— 原来只有 `SESSIONS` 反推一条路；现在按可靠度排：
   `$DSH_HOME/state/` → `SESSIONS` 反推 → `cwd`，而且**逐个试读**。
   ★ 关键判断是「能解析出 `stats`」而不是「路径存在」——
   路径在、文件坏了的情况，会让后面的读取全部抛错。
2. **心跳目录提示** —— 采用更完整的那句（说清「本仓库不提供心跳零件，要自己建定时任务」）。
3. **注释里的包名** —— `本机 dsh-yanqing-memory` 改成中性表述，
   两套安装（本机专属 / 发布版）读起来都不别扭。

**结果**：`diff plugins/echo/echo-doctor.mjs kit/echo/echo-doctor.mjs` → **0 行差异**。

**顺手学到的一点**：`kit/` 那份的 `HQ_STATE` 原来是**一行 400 多字符的压缩写法**。
逻辑是对的，但那种写法没法 review —— 改成多行之后，**「逐个试读」这个意图一眼能看见**。
压缩代码不是简洁，是把判断藏起来。

**自检**：`node tools/verify-packaging.mjs` → **121 / 122**。

### 2026-10-30 深夜四 · 第一次把「九格填了几格」数清楚（新增 `docs/架构缺口清单.md`）

**做这件事的动机**：一直有个含混的问题 —— **架构还缺哪些插件？**
以前回答它靠印象，这次把两份一手材料摆在一起数：

- `soul/00-layers.md` —— 五层的**定义**
- `soul/04-manifest.json` —— 每层的 **slots**（9 格）+ `assembly_order`

**结论比预想的收敛**：

| | |
|---|---|
| 9 格 | **7 格有明确归属** |
| 空着 | **1 格** —— Ⅱ 层「目标与什么算做完」 |
| 归属有问题 | 3 格（其中 2 个是**描述问题**，不是实现问题） |

**最有价值的一条判断是「这个缺口不该用插件补」：**

manifest 把「目标与什么算做完」标成 `required: true`，failure 写的是
「你会**永远结束不了**，或者**做完了自己也认不出来**」。这正好是 `AGENTS.md §5.1`
那四条判据要解决的。但：

1. **DSH 自带的 goal 管的是「不断」，不管「做完」** —— `complete` 是我自己判断的，
   没有任何地方记录「这一轮的成品该长什么样」。所以 goal 填不了这一格。
2. **但「什么算做完」本质是判断题，不是状态机。** 写成插件容易变成强制填表，
   而强制填表会逼出**表演式验收**（写了四条，一条没验）。

★ 所以结论写成「**已知缺口，方向待定**」，并给了它更可能该去的地方：
**一手层**（每接一个任务先把验收标准写进能被外部打开的东西），不是运行时机制。

**顺手记下 manifest 少了一格**：`memory` 把 self 层推进每一步，是最核心的那个，
但 Ⅰ 层的三个 slot 里**没有「身份面」这一格** —— 于是它无槽可归。
**没改**，因为改 manifest 是改权威源，会连带影响 `agent_soul_manifest` 工具和 doctor 的检查。

★ **这篇文档自己也标了最弱的一处判断**：`yantai` / `riji` 是否真算 Ⅳ 层，
只按 `package.json` 的 description 判断，**没读它们的实现**。

**自检**：`node tools/verify-packaging.mjs` → **121 / 122**。

### 2026-10-30 深夜五 · 5 个 issue 的结论落成文档，附可直接粘贴的回复（新增 `docs/issue-反馈处理.md`）

**为什么要有这一篇**：5 个 issue 我都分析过了，但**分析只活在会话和书房里 ——
issue 页面上一个字没有，别人看还是 5 个 open。**

★ **查清了本机的 GitHub 权限边界**（这次是实测，不是猜）：

| 有没有 | 结论 |
|---|---|
| SSH key（`id_ed25519`） | ✅ 有 —— **能推代码** |
| `gh` CLI | ❌ 无 |
| `GITHUB_TOKEN` / `GH_TOKEN` | ❌ 未设置 |
| `.git-credentials` | ❌ 不存在 |
| `credential.helper` | 只有 `helper-selector`，无实际 helper |

**所以：能 push，不能发 issue 评论。**

**退一步的做法**：把结论写成文档 + **每个 issue 一段可直接粘贴的回复文案**。
粘一下就是一次评论 —— 不做「等我有了权限再说」。

**五个的结论（详细推导在文档里）**：

| # | 结论 | 状态 |
|---|---|---|
| 1 | **已修（10-23）** —— 新增 `detectExternalCompaction()`，识别外部托管后判 `ok` | 可关闭 |
| 2 | **已修（10-26）** —— `__ModuleLoader__.load({id})` 的 id 必须 == 包名 | 可关闭 |
| 3 | **已修（10-25）** —— 换气判据改读 `dsh-huanqi.json` 的账本 | 可关闭 |
| 4 | **拆两件**：崩溃已修；「清空 profile」是宿主 sanitize 行为，触发器是「安装失败不回滚」 | 部分 |
| 5 | **不是 bug** —— 安装形态硬限制；`huanqi` 无绕路（compaction/pruner 有） | 部分 |

★ **#1 里报告作者最要紧的那句被写进代码注释了**：
这个误报不只是看着烦，它是一条**诱导链** ——「压缩没门牌」→ 以为缺能力 →
去装 `dsh-agent-compaction` → 内置的被 bili 禁了、槽位是空的 → 它直接注册成功 →
**复活了外部策略有意关掉的兜底引擎**，两套上下文管理并存、无法归因。

**自检**：`node tools/verify-packaging.mjs` → **121 / 122**。

---

### 2026-10-28 午后 · doctor 补两条「白名单漏一项」检查（来自用户反馈）

**背景**：用户的 bug 反馈里有一条反复出现三次的模式 ——
**装机时不报错、症状出现在别处、且长得像另一个病。**

| 次 | 白名单 | 漏了什么 | 症状 |
|---|---|---|---|
| 1 | `peerDependencies` | 没声明 `@deepseek-ai/*` | 宿主按白名单拦截 ⇒ **插件不加载、无 crash 日志** |
| 2 | （id 空间） | 两个包注册同一 client id | duplicate ⇒ **启动崩溃循环** |
| 3 | `files` | 漏列 `lib` | 装机丢目录 ⇒ import 失败 ⇒ **长得像服务空窗** |

**doctor 新增两项：**

- **`L1/pkgintegrity`** —— 已装插件的 `package.json` 自洽：入口里每个 `import './x'` 的文件必须存在；
  不存在时还会指出「`files` 里也没列这个目录 → 装机必丢」
- **`L1/peerdeps`** —— 源码 import 了 `@deepseek-ai/*`，就必须在 `peerDependencies` 里声明

**★ 首跑抓到一个真 bug，也抓到一个我自己的假警：**

- **真 bug**：`plugins/compaction` 的 `peerDependencies` 只声明了 `dsh-compaction-basic`，
  但 `index.js` 里还 import 了 **`@deepseek-ai/dsh-compaction`** —— **已补**。
  （★ 这就是第 1 次那个模式，第三次在同一个仓库里出现。）
- **假警**：`pkgintegrity` 第一版只过滤 `includes('dsh-')`，把 `plugins-market` / `free-search`
  这些**第三方包**也扫了，报出 **51 处** —— 那些是「用 `exports` 而不是 `main`」的正常包。
  **已收紧到只扫 `dsh-yanqing-*` / `dsh-agent-*`，且优先认 `exports["."]`。**

★★ **判据（第三次同型，值得写死）**：
**一条检查要能回答「这条失败时，用户照着做的动作会不会是错的？」**
答「会」→ 它就不能是 error，最多是 info。
假的好消息和假的坏消息，代价一样高。

**★ 装机版需重装才生效** —— 改的是仓库源码，`profile/node_modules` 里那份还是旧的，
所以再跑 doctor 仍会报 `peerdeps`。这是正确状态，不是没修。

### 2026-10-28 午后 · 补上「安装层」的两个交付物：分层 doctor + 给 agent 读的说明书

**背景**：26 条用户反馈里有 10 条是「装不上 / 装上了不工作」。之前这个仓库只有**零件**，
没有**安装路径** —— 用户得自己看懂 profile 结构、自己改 `cordis.patch.yml`。

**① `tools/soul-doctor.mjs` —— 分三层体检**

```
L0 地基   DSH_HOME / profile / patch / package.json+BOM / bundles 数组     5 项
L1 能力   四零件 resolve / 官方包（仅提示）/ node 版本                     3 项
L2 装配   preset 块 / 三件套 / 引用包 resolve / registry / 死目录          5 项
```

★ **为什么分层**：最贵的一条教训是「装完了、体检全绿、就是不工作」——
那些绿是因为检查项只查了「文件在不在」，没查「上游认不认它」。
**L0 错，后面两层全白查；doctor 失败时只给最底层那一条建议。**

**★ 首跑就打出一个真问题 + 一个我自己的假警：**

- **真问题**：本机 `.agent-presets/` 里还有 **6 个死目录**（2026-09-30 事故的残留）
- **假警**：第一版把「`@deepseek-ai/dsh-compaction-basic` 不在 profile 里」报成 ❌

**假警的查证过程**（这段值得记）：
逐字节读了 `dsh-yanqing-compaction/index.js` 第 87 行，确实写着 `from '@deepseek-ai/dsh-compaction-basic'`；
但 `node_modules/@deepseek-ai` 只有 9 个包，一个 compaction 系列都没有 —— **可它一直在工作**。

> **宿主加载插件时用的是宿主自己的 resolve 上下文（app.asar 里有官方包），
> 不是 profile 的 node_modules。文件系统里看不到 = 正常的。**

**判据错在**：我查的是「文件在不在」，该问的是「宿主能不能拿到」。
改法：**降级为提示，不算失败**。

``★ 一条通用的判据：每条检查都得自问「这条失败时，用户照着做的动作会不会是错的？」
  答「会」→ 它就不能是 error，最多是 info。假的好消息和假的坏消息，代价一样高。``

**② `AGENT-INSTALL.md` —— 写给 agent 读的，不是给人读的**

| | 给人读的 | **给 agent 读的** |
|---|---|---|
| 需要什么 | 理解「为什么」 | **判据：「装到什么程度算对」** |
| 命令 | 必须能抄 | 不一定要 —— 它自己能想 |
| 失败 | 安慰 + 下一步 | **「这条失败时你该做什么」** |

★ 结构就是「13 个 check id → 失败了干什么」，全部和 doctor 里的 id **逐字对齐**（已用 grep 核过）。

**★★ 两处故意没写：**
- **零件包怎么装** —— 本机那 4 个是别人装的，**我不知道确切命令**。写的是判据（`require.resolve`），不是编的命令。
- **`install.mjs update` 没真跑过 pull** —— 只验了「不是 git 仓库」的错误分支。

**③ `install.mjs` —— 安装层入口（doctor 之上的一层）**

```
node install.mjs doctor                 # 转调 soul-doctor
node install.mjs apply [--write]        # 按 doctor 结论修 L2，默认 dry-run
node install.mjs update                 # git pull + apply
node install.mjs rollback [--to <bak>]  # 从备份恢复
```

**★ 三条设计规矩：**

1. **`apply` 先跑 `doctor`，L0/L1 有任一项不过就拒绝动手。**
   地基错了还去改配置，只会把环境搞得更乱，而且会掩盖真正的问题。
   ★ **L2 不在这个门槛里** —— 因为 apply 正是修 L2 的工具（「L2 全绿才允许修 L2」是循环依赖）。

2. **默认 dry-run。** 除 `rollback` 外都要显式 `--write`。

3. **`rollback` 不指定 `--to` 就只列备份**，而且**先把当前状态另存一份**
   （`.bak-before-rollback-<时间>`）—— 否则「恢复」变成单向丢失。

**★ `apply` 只修三样**（`presets` / `threeparts` / `presetresolve`，都是 `soul-preset build` 能干的）。
`registry` 和 `deadpresets` 归「人工处理」——**它不替你决定 registry 该指哪个 preset，也不擅自删你的旧目录。**

**★ 实跑抓到一个自己的 bug**：`apply` 一上来就报 `Cannot find module ...\soul-doctor.mjs`。
原因是 `install.mjs` 在仓库根，所以 `HERE` 就是根目录，而两个子脚本在 `tools/` 下；
`ROOT = join(HERE,'..')` 也退多了一级。**是实跑才发现的，光看代码看不出来。**

### 2026-10-28 午后 · ✅ 验证通过：四个预设全部识别得到（并纠正了我自己的验证方法）

**结果**：重启后，四个预设**全部能识别 `/compact-region`**。L3 这一级补齐了。

**但更值得记的是方法 —— 爀曦给的比我原来写的对：**

> 「甚至不需要开新会话，只需要在开新会话界面切换 preset，输入指令，识别到就算成功了。」

| | 我原来写的 | 他给的 |
|---|---|---|
| 要开新会话吗 | 要 | **不要** |
| 要真跑一次压缩吗 | 要 | **不要** |
| 消耗额度 / 副作用 | 会 / 会 | **不会 / 不会** |
| 实际验的是 | 端到端四层 | **命令注册 = preset 加载成功** |

★ 我当时写的是「开新会话 → 跑一次 → 看事件流」，那是在验 **preset 加载 + 命令注册 + 压缩执行 + 门牌写入** 四件事。

★★ 而他只想确认**第一件**。**多验一步不是更严谨，是更笨** —— 尤其后面几步昨晚已经各自单独验过（`log:session-15ed002e…#seq=1307` 那条断言）。

`presets/README.md` 里的验证步骤已换成他这个。

### 2026-10-28 午后 · 补两份「给人看」和「给机器看」的东西

**前面几条做的是机制，这一条补的是**：一个用户拿到这个仓库，知道该干什么；以及一台机器能说出「我现在装的是哪一版」。

**① `presets/README.md` —— 给人看的三步**

```
node tools/soul-preset.mjs verify          # 看现在缺什么
node tools/soul-preset.mjs build --write   # 缺的补上
# 然后完全退出 DSH 再打开
```

★ **没有第三步。** 重启是唯一必须手动做的事。

里面写了五条命令的分工、`@include` 标记是什么、**八种栽倒方式各对应哪里挡**、以及「压缩是三件套不是一件」。

★ 那份文档的写法有一条刻意的地方：**先说「为什么会栽倒」，再说「命令怎么用」** —— 因为前面几节的根因（0.2.0-rc.2 起不扫 `.agent-presets/`）不知道，后面每条命令都像是多余的限制。

**② `soul-version.json` —— 给机器看的**

```
soulVersion = 2.0.0   profile = desktop
preset-yanqing             4a4bd03e29f6e948  三件套齐
preset-yanqing-cordis      679341cc9be3cdd8  三件套齐
preset-yanqing-ptc         94f1525dc2bf7775  三件套齐
preset-yanqing-distill     0837b4bc6a6ad33b  三件套齐
```

每个 preset 带完整 SHA256、三件套清单、缺什么。还有一行 `contracts: { doorplate: 1, recall: 1, record: 1 }`。

★ **为什么现在就要有这个**：`install.js` 的已装判定**只看「在不在」，完全不看版本** —— 所以「更新」等于整目录覆盖、无 diff。没有这个文件，「我装的是哪一版」只能靠猜。

★ 而 `contracts` 那三个数字是**关键的那一行**：零件版本怎么变，只要契约版本没变，就不需要迁移器。

**新增第 6 条命令：**

| 命令 | 干什么 |
|---|---|
| `version` | 生成 `soul-version.json` |

★ 它跑的是和 `verify` 同一套扫描，只是输出成 JSON 而不是打屏。

### 2026-10-28 午后 · 压缩段从「四份复制」变成「一份共享源」，且展开后逐字节还原

**这是本轮最后一块，也是前面所有铺垫的目的。**

四个 preset 的 `compaction` group 一直是**复制的**（34 行 × 4）。今天早上那次事故就是这么来的：3 个 preset 复制时漏了 `command-compact-region`，而**没人做过「这三个不需要」的决定**。

**动手前先验了一件事**（不验就拆是赌）：

```
preset-yanqing-cordis.yml   compaction group: 34 行  raw=5c8a546ba6e66637
preset-yanqing-distill.yml  compaction group: 34 行  raw=5c8a546ba6e66637
preset-yanqing-ptc.yml      compaction group: 34 行  raw=5c8a546ba6e66637
preset-yanqing.yml          compaction group: 34 行  raw=5c8a546ba6e66637
=== 去重后 1 种 ===
```

★ **四份逐字节相同** —— 才敢拆。

**做了三步：**

1. `split` —— 抽出共享源 `presets/_shared/compaction.yml`（1877 B，去缩进），四个 preset 原位留一行 `# @include $DIR/_shared/compaction.yml`
2. `build` 认这行标记，按标记的缩进把共享段展开回去
3. **验证**：展开后必须还原成原 hash

**验证结果 —— 四个全中：**

```
✅ preset-yanqing-cordis   一致（679341cc9be3cdd8）
✅ preset-yanqing-distill  一致（0837b4bc6a6ad33b）
✅ preset-yanqing-ptc      一致（94f1525dc2bf7775）
✅ preset-yanqing          一致（4a4bd03e29f6e948）
```

★ 这四个哈希**和拆分前完全相同**。所以这次重构**没有改变任何一个字节** —— 只是把「四份复制」换成了「一份源 + 展开」。

**体积变化：**

| 文件 | 拆前 | 拆后 |
|---|---|---|
| `preset-yanqing.yml` | 9259 B | 7465 B |
| 四个 preset 合计 | 39,595 B | 33,186 B（+ 共享 1877 B） |

**踩到的一个坑（记下来）：**

第一版 `split` 给共享文件加了 4 行说明注释，`build` 展开时把它们一起插进了 preset → 四个 hash 全不一致。

修法是：展开时**跳过共享文件开头连续的 `#` 行**，但段**内部**的 `#` 注释保留（压缩段里有十几行是解释性注释，那些必须留着）。

★ 教训：**「注释头」和「内容里的注释」在展开时必须分开处理** —— 否则注释会跑进产物，而它看起来像正常内容，不会报错。

**现在的五条命令：**

| 命令 | 干什么 |
|---|---|
| `verify` | 只读：目标 profile 的 preset 齐不齐 |
| `export` | profile → 仓库 |
| `build` | 仓库 → profile（默认只比对） |
| `split` | 把共享段抽出来（前提：几份逐字相同） |
| `register` | 从现成 preset 复制一份改 id/name |

★ 从「改一个零件要改四处」变成「**改一处，build 展开四处，hash 证明没走样**」。

### 2026-10-28 午后 · `build` 补上闭环：仓库里的 preset 真的能装回去（四个哈希全一致）

**接上一条：`export` 只是单向的。**

导出完还得回答一个问题：**仓库里这份，装回去和原来一样吗？** 不一样的话，进仓库的就是个好看的复制品。

补了 `build`（默认比对，`--write` 才插），然后跑了一遍：

```
源 = presets（4 个）  目标 = desktop
  ✅ preset-yanqing-cordis   一致（679341cc9be3cdd8）
  ✅ preset-yanqing-distill  一致（0837b4bc6a6ad33b）
  ✅ preset-yanqing-ptc      一致（94f1525dc2bf7775）
  ✅ preset-yanqing           一致（4a4bd03e29f6e948）
无需插入。
```

**四个 SHA256 前缀逐一对上。** 这是「preset 终于能进仓库」的硬证据 —— 不是「看起来一样」，是逐字节相同。

★ `build` 默认**只比对不写**。要真插必须 `--write`，且它会走和 `register` 同一条写盘路径（备份 + 复核 bundles 条数 + 无 BOM）。

**现在的四条命令：**

| 命令 | 方向 | 干什么 |
|---|---|---|
| `verify` | 只读 | 目标 profile 的 preset 齐不齐、包能不能 resolve |
| `export` | profile → 仓库 | 把本机能跑的形状提取出来 |
| `build` | 仓库 → profile | 比对（默认）/ 插入（`--write`） |
| `register` | 新建 | 从现成 preset 复制一份改 id/name |

★ **`export` 和 `build` 是同一个方向的两端**，而 `build` 的比对模式**就是一个关掉写权限的 export** —— 这两个命令互相当对方的测试。

**还没做的：拆 `_shared/`。**

四个 preset 现在各存一份完整块，压缩段是四份复制。要真正防漂，得把它抽成一份共享源再展开 —— 但那是重构，**得先有基准**（现在有了）。

### 2026-10-28 午后 · `presets/` 里第一次有了 preset —— 从「只活在部署现场」变成「可版本化」

**接上一条：为什么要导出。**

上一条把「注册 preset」做成了命令，但有件事没解决：**仓库里根本没有 preset 的文件**。它们只活在 `profiles\desktop\cordis.patch.yml` 里，是 330+ 行的内联定义。**别人 clone 这个仓库，拿不到任何 preset。**

这才是「装不到别人机器上」的根因之一 —— 不是脚本写得不好，是**要装的东西不在仓库里**。

**做法：`soul-preset export`。**

从本机跑通的 profile 里提取四个 preset 块，原样落成 `presets/*.yml`：

| 文件 | 行数 | `config.id` | 显示名 | order |
|---|---|---|---|---|
| `preset-yanqing.yml` | 167 | `yanqing` | 砚青 | 9 |
| `preset-yanqing-cordis.yml` | 191 | `yanqing-cordis` | 砚青创造 | 11 |
| `preset-yanqing-ptc.yml` | 178 | `yanqing-ptc` | 砚青 PTC | 10 |
| `preset-yanqing-distill.yml` | 178 | `yanqing-distill` | 砚青蒸馏 | 12 |

外加 `_manifest.json`：每个 preset 的 `blockId` / `configId` / `displayName` / `order` / 行数 / 三件套清单 / 缺什么。

**四件的三件套全是完整的：**

```
dsh-yanqing-compaction / dsh-yanqing-compact-region / dsh-yanqing-pruner
missing: []   ×4
```

**★ 顺手验了一件更要紧的事：这四个文件里没有一个绝对路径。**

全文扫 `[A-Za-z]:[\\/]` 零命中 —— 也就是说**preset 本身是可移植的**。

这跟零件层形成对照：`dsh-huanqi` 里写死了 `D:\AI\memory\hub\*`，那才是「装到别人机器就静默失效」的地方。**preset 是干净的，脏的是零件。**

**还没做的：`build`。**

`export` 是单向的（profile → 仓库）。要双向闭环还差一个 `build`（仓库 → profile），以及拆分 `_shared/` 让四个 preset 的压缩段只有一个真源。

★ 顺序上我故意先做 `export`：**先把能跑的配置固定下来，再谈重构。** 反过来做（先拆 shared 再导）会在还没有基准的时候动刀。

### 2026-10-28 午后 · `soul-preset.mjs`：把「注册 preset」从手工活变成一条命令，并补上三个 preset 缺的零件

**为什么做这个。** 爀曦原话：「最难的一关就是如何引导用户注册 agent preset，**我们在这上面栽倒的次数太多了**」。所以这次不是先设计，而是**先去《墨》里把栽过的跟头全捞出来**，再照着设计。

**捞到的根因（2026-09-30 那次，一手原文 `log:session-3c80e2e5…#seq=476`）：**

> 「preset 的文件一个都没丢，**丢的是「桌面端认识它的方式」**。」
> 文件完好、健康检查 24 行全绿 —— 只是**没有任何人去读那个目录了**，于是它们从 picker 里一起消失。

`dsh 0.2.0-rc.2` 起 preset 改成 **profile 层声明**（配置里一行 `@deepseek-ai/dsh-agent-preset`），**不再扫描 `.agent-presets/`**。当前 0.2.1-rc.3，那个目录里的 6 个 preset **全是死的**。

**归出八种栽倒方式（F1–F8）**，每条都对应脚本里的一个动作：写进死目录 / 改了没重启 / 改错 profile / 插件挂不上 / 坏 preset 当默认 / 裁配置丢别的块 / YAML 方言不兼容 / 编码。

**新增 `tools/soul-preset.mjs`（三个子命令）：**

| 子命令 | 作用 |
|---|---|
| `verify` | 只读。preset 块在不在、三件套齐不齐、包能不能 resolve、registry 配置 |
| `register` | 从现成 preset 复制一份改 id/name，**默认 dry-run** |
| `register-all` | 检查四个砚青 preset 是否齐，缺的报出来 |

★ **不解析 YAML** —— 那个文件里有 `!!js process.platform` 这种 loader 专有写法，普通解析器会炸（F7）。三个子命令一律用**文本扫描**。

**顺带修了一个真问题：三个 preset 缺 `command-compact-region`。**

`verify` 一跑就暴露：

```
preset-yanqing          ✅ 三件套齐全
preset-yanqing-cordis   ❌ 缺 dsh-yanqing-compact-region
preset-yanqing-ptc      ❌ 缺
preset-yanqing-distill  ❌ 缺
```

也就是说 **4 个 preset 只有 1 个能走范围压缩**（换气第二档）。已补上，插入位置与标准 preset 同构（`command-compact` 之后、`tool-result-pruner` 之前，缩进 14 空格逐字相同）。

**复核四条，全过：**

```
写回 48,870 字符（原 48,582，+288 = 3 处 × 2 行）
dsh.profile.bundles  42 → 42   ✅ 未被 sanitizeProfile 重置
BOM                          ✅ 无
四个 preset 的三件套          ✅ 全齐
```

★ **改的是 `profiles\desktop\cordis.patch.yml`（内嵌那份），不是 `.agent-presets/`。** 备份在 `*.bak-before-region-20261028042425`。

**顺手查实一条已过期的旧记录**：2026-09-30 说「desktop 是指向 web 的 junction」——**现在不是了**，四个 profile 全是实体目录，desktop 与 web 的 patch SHA 也不同。

★ **还没生效** —— profile 只在启动时读一次，要完全退出 DSH 再打开。

### 2026-10-28 凌晨 · 换气第二档治疗终于生效：部分压缩真的只压那一段

**这一版修的是一个「压缩成功、界面上一个字都不显示」的问题。**

换气的三档治疗里，第二档是**范围压缩**：累计截断 N 次之后，只压走最近那一段脏历史，然后继续对话（区别于熔断时那种整段压掉、不再延续的全量压缩）。它一直没生效，卡在两处：

**① 够不到 `compaction`。** 那个服务被 preset 的 `isolate: { compaction: true }` 关在 realm 里，根层的换气从 `agent.ctx` / `agent.session.ctx` / 根 `ctx` 三条路都取不到 —— 而删掉 isolate 会让所有会话 `resume failed`（`RemoteError: Preset services require isolate realms`）。唯一的门是 `commands` 服务，可官方的 `/compact` **不接受参数、只做全量**。

**② 命令返回没带门牌。** 前端靠 `command/done.sourceEventSeq` 去找对应的 `compaction/summary`，才渲染「· compact · 已压缩 N 条历史记录（约 X tokens）」。换气那条命令原来只回一句 `Compacted seq a–b.`，没有 `sourceEventSeq` —— 压缩真的发生了，界面一个字都不显示。

**修法（两侧各一半）：**

- **organs 侧**新增零件 `compact-region/`：在 realm 内注册 `/compact-region <start> <end>`，handler 返回 `{ kind: 'success', text, sourceEventSeq: result.summarySeq }`，与官方 `dsh-command-compact` 的 `executeCompact` 同构。
- **换气**的 region 分支改成只走 `/compact-region`，失败不降级全量（熔断那条仍然走全量）。

**实测（2026-10-27 16:10，一次自动触发的范围压缩）：**

```
[compact-region] compactRegion(1847–2108) → OK n=95 tok=130302 summarySeq=2116
[huanqi][compact] 走 commands 桥 → kind=region range=1847-2108 / OK
```

事件流 `#2113 command/run` → `#2116 compaction/summary` → `#2119 command/done kind="success" sourceEventSeq=2116`。界面两行都出来了：

```
>_ compact-region · Compacted 95 history items (~130302 tokens).
上下文已压缩 · 已压缩 95 条历史记录（约 130302 tokens）
```

**顺带把换气的源码追平产物。** `lib/index.js` 从 10-23 起被直接改过（压缩层、测试触发口、schema 字段只落在产物里），`src/index.ts` 停在 10-23。这次补齐 792 行（3017 → 3809），`tsc --noEmit` 在 strict 全开下零错误，去注释空白后与 `lib/index.js` 逐字符相同（42878 = 42878，delta = 0）—— **`lib` 本身一个字节没动**（SHA256 前后同为 `CFF585548E848122…`）。

**一件要说清的事**：`maxContinuations` 默认值随这次同步从 **4 变成 6**。本机 `desktop` = 6 / `web` = 4 都显式覆盖了，所以本机行为不变；从仓库装、又没配这一项的人会拿到 6。

**口径修正**：正文「三档治疗」那张表里写的是「范围压缩 = `compactRegion` 压走最近这一段」，现在实际路径是**借 `/compact-region` 命令进 realm 再调它** —— 能力没变，进门的路变了。

**两个仓库同一次落地**：`dsh-agent-organs` 的 `6735d72`（新增 compact-region + 换气源码/types + 两个测试 + 零件清单与更新记录），本仓库同步记这一条。

### 2026-10-26 凌晨 · 装了一道闸门：动了实现但没写公告 → 拒绝提交

> 起因：发布纪律那条我**记得住条文，但没执行动作**。
> 10-22 连着三个 commit 只推代码；10-26 又漏一次（`3513e61` 修完 bug，公告拖到 `8dde935`）。
> 两次漏的是**同一个动作**：提交前没想着去看更新记录。
> 所以把它从「一句需要自觉的话」变成「一件会拒绝我继续的事」。

**判据只有一条：**

> 本次暂存里动了「会被加载的实现文件」，而且 README 的「更新记录」段**字符数没有净增** → 拒绝。

「会被加载的实现文件」具体是：

| 范围 | 为什么算 |
|---|---|
| `plugins/**` 下的 `.js` / `.ts` | 源码和构建产物都要算 —— **后者才是真被加载的** |
| 根目录 `index.js` / `client.js` / `kit-bridge.mjs` / `probe-kit-tools.mjs` | 宿主的入口 |
| `soul/**` 下的 `.json` | 清单和参考实现清单是内容，不只是文档 |

**三条出路**（拒绝时会把这三条都打出来，不是只说「不行」）：

1. 往更新记录里加一条（写清为什么改 / 改了什么 / 怎么验的）
2. 这次确实不需要公告 → 提交信息里写 `[no-changelog]`，并说明理由
3. 确认误报 → `git commit --no-verify`（慎用：这就是在绕开纪律）

**为什么用「字符数净增」而不是「有没有 `+` 行」**：更新记录是只追加的，所以它只该变长。
净增是最贴近这个性质的判据，而且不必把 diff 行号映射回段内（那一步容易写错，
写错就会误放或误拦）。真要做等长的措辞修正时走 `[no-changelog]` —— 这反而让人多想一次。

**★ 装的时候自测，抓出了它自己的一个 bug —— 这个错误很值得记：**

第一版用 `execFileSync('git', ...)` 调 git，靠 PATH。而这台机器 **git 不在 PATH 里**。
于是 hook 跑起来时所有 git 调用都失败 → 返回空串 → 判定成「暂存区为空」→ **静默放行**。
也就是说：**闸门装上了，但它天天闭着眼睛。**

**判据（比这个 bug 本身重要）：**

> **一个检查工具，「读不到输入」和「输入是空的」必须是两件事。**
> 混在一起，失效就会变成沉默 —— 而沉默看起来和通过一模一样。

修法：git 路径三级探测（env → installer 注入 → PATH → 几个已知位置）；
读不到暂存区时**大声放行**（「这次没检查，不是检查过了」），而不是装作通过。

**文件：**

- `tools/pre-commit-changelog.mjs` —— 判据本身，可以脱离 hook 单独跑
- `tools/install-hooks.mjs` —— 装 / 查 / 卸。**为什么需要安装脚本**：`.git/hooks/` 不在版本控制里，
  换台机器 clone 下来就没了，而我恰恰在「重装后」最容易忘纪律。

```sh
node tools/install-hooks.mjs          # 装
node tools/install-hooks.mjs --check  # 看装没装
node tools/install-hooks.mjs --remove # 卸
node tools/pre-commit-changelog.mjs   # 对当前暂存区单独跑一次判定
```

**★ 行尾有个反方向的坑**：shell 脚本必须 LF。带 CRLF 的 `pre-commit` 会让 git 报
`bad interpreter: /bin/sh^M` —— 一个看起来和行尾毫无关系的错。
（`.cmd` 批处理则必须 CRLF，正好相反。两个坑都踩过，现在都写在注释里了。）

**自测三场景**（都跑过）：

| 场景 | 期望 | 实测 |
|---|---|---|
| 只动 `tools/` | 放行 | `rc=0`「没动实现文件」 |
| 动 `plugins/huanqi/src/index.ts` 但不写公告 | 拒绝 | `rc=1`，列出那个文件 + 三条出路 |
| 动同一个文件 + 改了更新记录 | 放行 | `rc=0`「更新记录也变长了（+19 字符）」 |

### 2026-10-26 凌晨 · 离线仿真抓出的第一个真 bug：门牌是字面量 `<会话>`

> ★ **补记**：这条对应的代码修复（`3513e61`）当时推了，公告没跟上。
> 按发布纪律补在这里 —— 更新记录是只追加的，漏了就补不回来，所以宁可晚写也不能不写。

**病是怎么发现的**：不是线上报错，是我写了个离线仿真去「假装触发」一次截断和一次熔断。
仿真第一次跑通，四条消息全对 —— 除了这一行：

```
本段原文：log:<会话>#seq=1–5
              ↑ 字面量，不是真会话号
```

**根因是源码里我自己留的残句**：

```ts
function recallHint(outcome: CompactOutcome, cuts: number): string {
  const sid = outcome.range === null ? '' : ''   // ← 两边都是空串
  void sid                                       // ← 占了个位就没再用它
  ...  'log:<会话>#seq=' + ...                  // ← 直接写了字面量
```

**为什么这个 bug 特别值得记**：它不报错、不崩、日志一切正常，
唯一的表现是「拿这张门牌去 `memq open` 会白跑一趟，然后以为是记忆丢了」。
**错的指针比没有指针更坏** —— 没有指针你会去找，错指针你会以为自己找过了。
而这句错指针恰好出现在**最需要它的时刻**（刚被压掉上下文、正要去取回原文）。

**修法三条**：

1. `recallHint` 增加第三个参数 `sid`，由调用点传真实的 `session.id`
2. **拿不到 sid 就不猜门牌** —— 降级成「落在第 N–M 条 + 用 memq 按关键词检索」
3. 熔断那条兜底同样补上会话号（全量压缩确实没有「压了哪一段」，但至少要知道去哪个会话找）

**离线仿真本身也进了仓库**：`tools/sim-huanqi.mjs`。做法是 mock 三层——
一个只含 6 个依赖的 `ctx`（`agents` / `compaction` / `get` / `logger` / `on` / `settings`）、
一个 `agent`、一个会记录调用的 `compaction`——然后**调真的 `apply()`**，
再手动 dispatch `session/event` 制造「空回合」。
临时 `DSH_HOME`，跑完自删，**不碰真实账本与会话**。

跑一次验七项：

| # | 断言 |
|---|---|
| ① | 第 1 次空回合只续跑，不压缩 |
| ② | 累计到阈值触发 `compactRegion` |
| ③ | 范围压缩后注入「取回指引」 |
| ④ | 额度耗尽触发 `compactNow` |
| ⑤ | 熔断告知写清「全量压缩 / 不再延续」 |
| ⑥ | `compactRegion` 拿到了 session |
| ⑦ | `compactNow` 的 ctx 带 `runMaintenance` |

**★ 这个仿真的边界要说清**：它验的是「代码路径对不对」，不是「真实会话里模型真的循环了会怎样」。
后者只有真发生才知道。好在这两条路径的输入输出都是确定的（空回合 → 续跑/压缩），保真度够。

**★ 可复用的判据**：**凡是要生成「给人用的指针」的地方，都必须有一个跑得通的例子**
（哪怕在仿真里），证明它不是字面量、不是占位符、不是上一版的值。
这次要不是仿真把消息原文打出来，`log:<会话>` 会在线上躺到下一次真熔断才被看见 ——
而那恰好是最需要它的时候。

### 2026-10-26 凌晨 · **v2.0.0** —— 第一次正式给自己标版本号，因为这一版真的换了一代

> 爀曦：「agent soul 版本声明迭代一下变成 v2，因为这是重大升级。」

**为什么是 2.0 而不是 0.2。** 之前仓库一直是 `0.1.0` —— 那是「还没想清楚」的占位符，
不是承诺。这一版第一次同时做到了三件事，任何一件单独都不足以叫 2.0：

1. **灵魂第一次有了「治疗」这一层。** 换气从「打断」升级到「打断 + 清创」——
   范围压缩、全量压缩、压缩后主动让它去取一手原文。详见下面两条记录。
2. **判据第一次能自己拦自己。** `verify-client-ids.mjs` 从「只查 id 重复」补到
   「同时查 id 是否等于包名」，并且**上线当天就抓到了一个还没爆炸的哑雷**。
3. **形成了「部署不变量」这个概念。** 以前部署等于拷文件；现在部署等于**保持一个等式**，
   而且有脚本能验它。

**版本表：**

| 件 | 版本 | 为什么升 |
|---|---|---|
| `dsh-agent-soul`（本体） | **2.0.0** | 上面三条 |
| `dsh-huanqi` | **1.1.0** | 加治疗层（范围压缩 / 全量压缩 / 取回指引）+ 四个新配置项 |
| `dsh-yanqing-huanqi-panel` | **0.2.0** | 面板加 4 个配置项；`maxContinuations` 默认改 6 |
| `dsh-yanqing-echo` | **0.2.0** | 判词区加「压缩」列；id 与包名统一 |

`soul/04-manifest.json` 和 `soul/07-bundle.json` 同步到 2.0.0 —— 规范和参考实现不能各标一个版本，
那等于告诉读的人「这两份描述的不是同一件事」。

**部署侧也同步了**（`profiles/desktop/node_modules/` 三个 package.json 的 version）。
★ 那是元数据、不影响加载，但**本地 / 远端 / 部署三处版本号不一致本身就是一种谎**，
下次有人 `dsh plugin list` 会看到三个数，然后开始猜哪个才是真的。

---

### 2026-10-26 凌晨 · `verify-client-ids.mjs` 补完：从「只查重复」到「两条判据都查」

**原来它只查一件事：id 有没有重复。** 注释里甚至写着
「id ≠ 包名本身不是错，只有重复才是错」——**这句话是错的，已删。**

今天实测：id ≠ 包名会让 web boot 报 `loaded without registering`，整个界面起不来。
所以正确的判据是两条：

| # | 判据 | 不满足会怎样 |
|---|---|---|
| ① | id 必须全局唯一 | `duplicate factory registration` |
| ② | **id 必须等于自己 package.json 的 name** | `loaded without registering` → 应用无法启动 |

**分三档报，不是一刀切：**

- `error` · id 重复
- `error` · **我们自己的包**（`dsh-yanqing-*` / `dsh-agent-*`）id ≠ 包名
- `warn` · 别人的包 id ≠ 包名（可能是官方短 id，只报不判失败；`--strict` 才算失败）

**为什么要分档**：我们无法确知所有第三方包的真实加载语义，
误报会让人开始无视这个脚本 —— 那比没有脚本更坏。但我们自己的件没有这个借口。

**上线当天就抓到一个哑雷：**

```
✗ id = "dsh-agent-soul"   pkg = "dsh-yanqing-echo"
    profiles\web\node_modules\dsh-yanqing-echo\client.js
```

web profile 里 echo 的 client id 跟包名完全无关（是更早的一次手滑），
只是桌面端用的是 desktop profile 所以一直没炸。已修。

**也做了负向测试**：故意把仓库 echo 的 id 改错 → 脚本报错 → 改回 → 脚本通过。
一个检查如果没被「故意弄坏」验过，就不知道它是真在查还是恰好没报。

### 2026-10-26 凌晨 · 一次真实的「应用无法启动」—— client id 与包名必须相等

> 起因：换气升级部署时，我把仓库版的 `client.js` 拷进了 `profiles/desktop/node_modules/`，
> 重启后桌面端直接弹「应用无法启动」，进不去界面。爀曦让 workbuddy 修好了，我事后复盘。

**根因是「命名分裂」，而且我拼出了最坏的组合：**

| | 部署目录（实际被加载） | 仓库（发布源） |
|---|---|---|
| echo package name | `dsh-yanqing-echo` | `dsh-agent-echo` |
| echo client `id` | `dsh-yanqing-echo` ✓ | `dsh-agent-echo` ✓ |
| panel package name | `dsh-yanqing-huanqi-panel` | `dsh-agent-huanqi-panel` |
| panel client `id` | `dsh-yanqing-huanqi-panel` ✓ | `dsh-agent-huanqi-panel` ✓ |

**两边各自内部一致、互相不一致。** 我只拷了 `client.js`（id = `dsh-agent-*`）进部署目录
（name = `dsh-yanqing-*`），拼出了一个 id ≠ name 的包 —— 而这正是 DSH 的硬约束：

```
client-modules 拿 package.json 的 name 当 key 去对注册表，
对不上就报 "loaded without registering ... via __ModuleLoader__.load"，
整个 web boot 批次随之不激活 → 界面弹「应用无法启动」。
```

**修法：把仓库的 name 和 client id 都统一成部署名（`dsh-yanqing-*`）** ——
部署那一侧是唯一被验证过能跑的组合，仓库向它对齐。
两边都加了注释写明这条约束，免得下次又只改一边。

**★ 这个坑为什么能藏这么久**：仓库里 id 和 name 本来是**一致**的（都是 `dsh-agent-*`），
所以本地看怎么都对；错只发生在「把仓库文件拷进一个名字不同的部署目录」这一步。
而部署版一直是旧的（10-19 的文件），从没被覆盖过，于是两边各自都对、合起来就炸。

**★ 教训（已写进脚本与注释）**：

1. **改 `client.js` 或 `package.json` 的任何一边之前，先确认**
   `package.json.name === __ModuleLoader__.load({ id })`，这两个是一对，不能只动一个。
2. **部署不是「拷文件」，是「保持一对不变量」** —— 拷完要验这条等式，不是验文件大小。
3. `tools/verify-client-ids.mjs` 现在只查「id 有无重复」，**不查「id 是否等于包名」** ——
   那是漏掉的那一半，下次补上。

### 2026-10-26 凌晨 · 换气第一次能治病：从「打断」升级到「打断 + 清创」

> 起因：爀曦的定位——「**换气插件我的定位是思考退化挽救**」。
> 他给了一个观察：对话到两三百轮之后，思考会明显退化；两种压缩机制都让上下文大小没问题，
> 但**没有阻止退化本身**。

**先说调查（这一步推翻了设计里最重要的假设）：**

用本会话真实日志跑全量（**15,525 条 assistant/message**）：

| 判据 | 命中 | 结论 |
|---|---|---|
| 纯思考无输出 | **163 条（1.1%）** | ✅ 真实存在 |
| tool-call 真空 ≥3 条 | 130 段 | ⚠️ 太敏感 |
| 意图声明密度 ≥0.4 | **2452 个窗口** | ❌ **没有区分度** |

**★ 关键：我原本以为「意图声明密度」能提前报警。数据说不能** ——
`我要 / 让我 / 接下来` 这些词在正常文本里本来就高频，它测的是**文风**，不是状态。

真正有区分度的是**同一个碎片异常重复**：`做。`×283、`写。` 在 407 条里重复 ≥4 次。
所以退化的形状不是「说了不该说的话」，是**「话越说越碎、动作越来越少」**。

**再看换气自己：** 它已经有 `ReasoningLoopBreaker`（流级、逐字循环检测、shape 2 区分「换个说法」），
**症状识别这一层做得比我离线的统计准得多**。那缺什么？

**缺的是清创。**

打断只结束**当前这一轮**，但那段循环**已经进了历史** ——
下一次模型读到「刚才是这样做出来的」，**更容易被激活**。这是复利。

**所以这次的升级：**

| 层 | 做什么 | 触发 |
|---|---|---|
| ① 打断 | 结束当前流（**已有**） | 检测到循环 |
| ② **范围压缩** | 借 `/compact-region` 命令进 realm，调 `compactRegion` 压走最近这一段、**继续对话** | 累计截断 **3** 次 |
| ③ **全量压缩** | `compactNow` 彻底清空 + **告知 + 不再延续** | 熔断 |

**★★ 最重要的一条：压缩之后不让它读摘要。**

压缩会产出摘要，而**如果压缩后去读摘要，摘要就成了新的输入** —— 那是摘要复利，压了等于白压。
所以注入的是一张地图 + 一句明确指令：

```
[huanqi] 刚才连续 N 次陷入重复，已做范围压缩（上下文已清）。
本段原文：log:<会话>#seq=A–B
★ 不要依赖摘要 —— 它是二手转述。需要细节时先用 memq open 取一手原文，再继续。
```

**这才是「门牌」这套地基被充分利用的样子**：不是压缩时带个指针，而是**压缩后主动让它去用那个指针**。

**参数与配置（新）：**

| 项 | 默认 | 说明 |
|---|---|---|
| `maxContinuations` | 4 → **6** | 一口气能接几次 |
| `regionCompactAfterCuts` | **3** | 累计截断几次做一次范围压缩（0 = 关） |
| `fullCompactOnBreaker` | **true** | 熔断时全量压缩 |
| `postCompactRecallHint` | **true** | 压缩后注入取回指引 |
| `compactionService` | `''` | 留空 = `compaction` |

**同步改的三处：**

| 件 | 改了什么 |
|---|---|
| `plugins/huanqi` | 核心逻辑（`src/index.ts` + 构建出 `lib/index.js`） |
| `plugins/huanqi-panel` | 设置面板加 4 个项，`maxContinuations` 默认改 6 |
| `plugins/echo` | 判词区加「压缩」列（`index.js` 不用改——它整行透传） |

**三个实现上的坑（都写进代码注释了）：**

1. **`compactNow` 要 `ManualCompactAgentContext`**（比 `CompactionAgentContext` 多一个 `runMaintenance`）——
   因为手动压缩是**非 turn 维护任务**。最干净的写法是塞进 `agent.runMaintenance(task)`，
   它顺带给了 signal、保证「没在跑回合」、还挡住后续唤醒输入。
2. **`session/event` 的处理器是同步的**，不能 `await`。而压缩必须 await 完才 resume（否则改 surface 会和下一轮撞车）。
   解法：`void (async () => {...})()` —— 处理器同步返回，压缩+resume 后台按序跑。
3. **构建链本机原本缺失**（没有 npm/tsc）。补法：`curl.exe` 下 typescript tgz + junction 链 DSH 的 239 个类型包。
   **验证方式：构建出的 `lib/index.js` 与仓库现有版本 SHA256 逐字节一致** —— 说明环境正确、产物可复现。
   详细步骤见 `30-状态/构建链-huanqi-20261026.md`（在书房里，不在这仓库）。
### 2026-10-25 深夜 · 补上漏掉的一块：dsh-mcp-hub 进仓库与清单

> 起因：爀曦反馈「mcp 服务接不上，记忆召回要 1 秒」。
> 查下来 MCP 本身是好的（`status=ready`、3 个工具、46 ms）——
> 但 **`dsh-mcp-hub` 这个插件一直没进仓库、也没进安装清单**，
> 所以复刻的人根本不知道该装它；不装它，ECHO 就只能走 CLI（650 ms），慢一个数量级。

**补了什么：**

| 件 | 位置 |
|---|---|
| 插件源码（11 个文件） | `plugins/mcp-hub/` |
| 零件清单（Ⅲ 能力层加一行） | `plugins/清单.md` |
| 灵魂装配清单（Ⅲ 层加 slot） | `soul/04-manifest.json` |

**为什么归 Ⅲ 能力层而不是 Ⅰ ECHO：**

判据是「把它整个删掉，身份判据还成立吗」——**成立**（ECHO 有 `memq` 兜底）。
所以它是能力，不是命脉。**但它决定「门有多快」：有它 46 ms，没它 650 ms。**

★ 这条差异值得单独说：**「能不能查」和「查得多快」是两件事。**
前者是 Ⅰ 层（必选），后者是 Ⅲ 层（可选但影响体验）。

**关于「1 秒」的真相（记录在此，免得下次又当成故障查）：**

`echo-mcp` 启动要预热 650-788 ms（读 43073 条词 + 1017 条摘要 + 591 条墨），
而 `mcp-hub` 是**后台异步连接**的（它的设计：不 await，免得一台慢服务器拖住 DSH 启动）。
⇒ **刚重启的一两秒内，工具还没注册，这时候查会走 CLI。之后才是 46 ms。**

★ 这不是 bug，是「启动不被拖住」的代价。要消掉这段空窗，正确的做法是
「工具清单缓存 + 连上后替换」，而不是偷偷 await —— 那是 mcp-hub README 里已经论证过的取舍。

### 2026-10-25 深夜 · 从 21 秒到 46 毫秒：把门换成 MCP

> 这一晚的主线是一句话：**「记忆召回要进 100 毫秒。」**

**做了什么（按顺序，每一段都有实测）：**

| 阶段 | 手段 | 结果 |
|---|---|---|
| 一 | memq 索引层接常驻服务（named pipe） | 300-440 ms → **23 ms** |
| 二 | 书房层也进服务（754 文件缓存 mtime+size） | 整机 1987 → 1237 ms |
| 三 | 书房按需扫描（索引 ≥5 条就跳过 walk，省 250 ms stat） | 1141 → **648 ms** |
| 四 | ★ **换成 MCP**：cho-mcp.mjs 由 mcp-hub 常驻 | **46 ms** |

**为什么前三段到不了 100 ms，第四段到了：**

CLI 每次调用 spawn 一个 node，**273 ms 是地板**（实测 
ode -e ""），与代码无关。
MCP server 由 mcp-hub 启动一次、之后常驻，agent 调用走宿主内部管道 —— **启动成本只付一次**。
同一条检索路径，换个开法：648 ms → 46 ms。

**新增：**

- kit/echo/echo-mcp.mjs —— stdio MCP 服务器（协议 2024-11-05，逐行 JSON-RPC）
- 三个工具：cho_search（terms / near / since / until / limit / **soul**）、cho_open、cho_stats
- 接入方式：mcp-hub/servers.json 里加一条 serverName: "echo"，工具名自动成 mcp__echo__*

**三条硬规矩（两条路必须遵守同一条尺子）：**

1. 展示永远是原文；归一化只用于匹配
2. hitKind 与 memq **逐字一致** —— 漂了就会出现「两个门答案不同」
3. 跳过书房**必须显式说明**（
ote 字段）。让人以为查全了、其实漏了，比慢 250 ms 坏得多

**★ 两条路并存，不是替代：**
memq 是「任何情况下都能用」的兜底（不依赖 DSH）；MCP 是「我在对话里」时的快车道。
**门可以有两把钥匙，但只能有一把尺子。**

**踩到的三个坑（同一形状）：**

- SVC_EXTRA =（赋值）把书房层已累加的 119 条覆盖 → 命中数 1096 ≠ 1215
- idxHits.length < 5 拿被 limit 截断的数组当总数 → 「跳过书房」永远不成立
- 测量噪声：同一组 import 测量里 +net 反而比 baseline 快 60 ms → **小于 50 ms 的差异在这台机器上不可信**

★ 三个都是「拿局部变量当全局事实」。**同一个错误出现两次就该加断言，不是第三次手动翻。**

只保留最近三条。**更早的看 git log**：

```bash
git log --oneline -- README.md
git show <commit>:README.md | head -300
```

### 2026-10-25 晚 · 三段重构：取回 70×、检索 9×、建索引 6× ＋ 补上 ACP 消失后的水位提示

一晚上只干一件事：**把「记忆触发」这条路从一分半压到两三秒，而且先把尺子立好再动手。**

**基线（改前实测，三跑取中位）**

| 段 | 命令 | 改前 | 改后 | 倍率 |
|---|---|---|---|---|
| ① 索引记录 | `memindex build` | 49,561 ms | **8.0 s**（有变更）/ **4.9 s**（无变更） | 6× / 10× |
| ② 索引检索 | `memq <词>` | 21,654 ms | **1.54 s** | 14× |
| ③ 命中取回 | `memq open <指针>` | 31,460 ms | **446 ms** | 70× |

**① `build`：别再「文件一变就全量重解压」**

增量判断原来是 `mtime:size` —— 文件变了（哪怕只追加一条）就全量重解压。
而当前会话日志 237 MB 一直在写 → 每次 build 都全量 → 43 秒。
现在记 `nextByte`（**最后一个成功解压的帧的结束位置**），只解压尾巴那几帧。

★ 最险的一处：**不能拿文件 size 当续读点** —— 最后一帧可能正写到一半，
从那里续会得到一个**残片**，而残片**可能看起来像正常的帧**，于是静默丢记录。
所以 `nextByte` 只在帧完整解出来之后才推进。文件**变短**时一律全量（那说明被重写，前缀靠不住）。

★ 还发现一个浪费：早退判断原来写在循环里，可那时**已经把 1864 个分片全读完了** ——
省下的那点被读分片吃回去（8.13 → 7.18，只快 1 秒）。把预判提到读分片之前才降到 4.9 s。

**② `memq`：真凶不是「读 52 MB 索引」，是书房 walk**

`walk(SOUL)` 扫的是书房根 —— 本机 **8.3 GB / 6,462 个文件**，
而排除清单只认 mp3/wav/png/jpg/zip/pyc：**`.mp4/.mov/.pdf/.gguf/.safetensors` 全被当文本读进来逐行匹配**，
而且**没有任何大小上限**。

两道闸：扩展名扩表（媒体/模型/压缩包/二进制）+ **单文件 512 KB 上限**。
判据很简单：**按行找回原文的检索，对超大文件和媒体文件没有意义。**

**②后半 · 只 parse 命中行（9× → 14×）**

前一步把 21.7 s 压到 2.4 s，但其中还有一段浪费：`readJsonl` 是「整文件读进来 → **每行 JSON.parse** → 再筛」。
`words.jsonl` 有 4.3 万条 / 41 MB，绝大多数跟这次检索无关，**却每一条都被 parse 成对象**才轮到 `hit()` 说不要。

现在先在**原始行文本**上做 `includes` 粗筛（不 parse），只对通过的行 `JSON.parse`。
**2.4 s → 1.54 s**（parse 从 5 万次降到一千多次）。

★ 等价性有两个边界，都写进了代码：
1. **JSON 转义**：`"` `\` 和换行在行里是 `\"` `\\` `\n`。检索词若含这些字符，原行里根本不会出现它 ⇒ 粗筛会**漏掉**本该命中的行。
   所以含转义字符的词**一律退回全量 parse**（宁慢不错）。
2. **跨字段拼接**：如果调用点写了 `hit(r.text + " " + r.ref)`，一个跨字段边界的词组在原行里也搜不到 ⇒
   这类调用点**不用这个函数**（《墨》那一段保持原样）。

★★ **验证方式是「对拍」不是「看起来差不多」**：用同一份数据跑新旧两条路，**逐条 key 比对集合**
（不是只比数量）。`门牌` 852/852、`水位+压缩` 109/109、`D:\AI` 3837/3837（这条自动降级），**漏 0 多 0**。

**③ `memq open`：新增 `framestore.mjs`**

会话日志不是一条 zstd 流，是**六万多个独立追加的帧**。
新建帧偏移索引（`{byteOffset, seqLo, seqHi}` + 校验头 + 增量补帧），按 seq 二分直取，
**只读需要的字节区间**（`openSync` + `readSync(position)`），不读整个 237 MB。
★ 保留全量解码作降级路径 —— 索引坏了只是变慢，不会打不开门牌。

**★ 顺手补上一个真实的洞：ACP 没了，水位提示也没了**

新版桌面端**不再包含 ACP 插件**（`billion-context-dsh` 在 asar 里已不存在），
于是那套 `0.45 / 0.60 / 0.80` 的预警**整体静默失效** —— 压缩只在兜底 0.88 那一刻才发生，
**一路上没有任何提示**。

`plugins/memory` 现在每轮读一次真水位，过线就在提示里写出来：

```
【水位】61%（642K / 1049K） ★★ 该压了（≥60%）—— 先落盘再压缩，顺序不能反
```

- **三档刻意与原 ACP 的 min/max/emergency 一一对齐**（0.45 / 0.60 / 0.80）。
  换的只是**承载位置**，语义不该跟着换 —— 否则「45% 是什么概念」又要重新学一遍。
- **三级兜底读水位**，每级都 try/catch 包死，拿不到就返回 0、不注入：
  ① `sessionProjections` 的 `projectedTokens`（**引擎自己的准星**）→ ② `pressureTokens`
  → ③ 直接读 `session_projcache` 文件（带 mtime 缓存，那个文件 1.6 MB，不能每轮 parse）。
- ★ **`contextWindow` 用 1048576，不是 1000000** —— 实测值，写整数会让百分比虚高 2.3 个点。
- ★ 为什么不放在 SELF.md：那是**推送层**，本身也会被压缩、会超预算被截断。
  这条要在我每次写摘要时都在眼前，所以放在这一侧。

**测试**：`memindex.mjs` / `memq.mjs` / `framestore.mjs` / `plugins/memory/lib/index.js` 全部 `node --check` 通过；
kit 版（走 `echo-config`）在设好 `ECHO_SOUL/ECHO_MEMORY/ECHO_SESSIONS` 后 `stats` 正常、`--status` 正确报错退出。

---

### 2026-10-25 · 八条用户反馈：两条已修过、四条修掉了、一条不成立

来自两封邮件（白毛狼狼 10-25、此胡桃非比胡桃是也 10-24），逐条核实后：

**已经修过的**（只回信说明，没再动）

- `memindex.mjs` / `memq.mjs` 的 `Buffer.concat` 巨串 —— 10-23 已改成逐帧 + carry。
  反馈里「原话数 382 → 439」少的那 57 条，正是旧实现在小日志上**静默吞掉**的
- `self.mjs` 不写 `state.json` —— 现在写了（`lastSelfAt` / `updatedAt`）

**修掉的**

- `tools/soul-one-shot.mjs`：包名匹配同时接受 `dsh-<x>` / `dsh-agent-<x>` / `dsh-yanqing-<x>` 三种写法（一代老名一个都不能漏）。
  原来用写死的 `part.pkg` 精确匹配，而 PARTS 表里两种写法混着 —— 于是「装了、只是名字写法不同」被判没装
- `echo-doctor.mjs`（kit + hub 两份）：换气账本按优先级找多处。
  `dsh-huanqi` 的 `defaultPath()` 在 `DSH_HOME` 为空时落在**宿主 cwd**，不在 `<DSH_HOME>/state/`；只认一处就会误报「没装」
- `echo-doctor.mjs`（两份）：心跳那项说清**本仓库不提供**这个零件，别让人去找一个不存在的东西
- `plugins/echo/client.js` 首行注释：旧注册名改成 `dsh-agent-echo`，并把「历史名已弃用」写上去
- `INSTALL.md`：补 crash 日志真实路径（`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`）

**不成立的**

- `compaction` 的 `files` 漏 `lib`：那个 `lib/` 目录现在已经不存在（内容并进 `index.js`），不再适用。
  但反馈建议的「打包期校验 `files` 必须覆盖入口的相对 import」是对的，已列入待做

★ 反馈里有一句总结值得记住：**「白名单类配置，漏一项就是静默失效，而且症状长得像另一个病。」**
  这条已经踩过三次（`peerDependencies` / client id / `files`）—— 第四次该由自动检查挡住，不该再由人踩。

### 2026-10-25 · ECHO 六层与 mnemon 的协同（新文档，纠正同一天早些时候那版）

`docs/ECHO六层与mnemon协同说明书.md`。

★ **这一条替换掉同一天早些时候的「记忆三层怎么联用」** —— 那份把 ECHO 写成了「体检台」，
而体检台只是它的**观测面**。权威口径写得很硬：哨兵不是第七层，也不是六层之一。

所以重写，按六层骨架来，并回答真正的问题：**mnemon 这个外来插件嵌在六层的哪里？**

答案在权威口径 L1 和 L4 的右列里：**L1 的热记忆（USER.md / MEMORY.md）由 mnemon 运行时
装在自己的目录；L4 的图记忆（洞察 + 关系边）就是 mnemon 的记忆空间。**
它不是「第六层之外又一个记忆系统」，它横跨两层。

协同的四个接缝：

1. L1 里 SELF.md 保底（推送，不会静默消失）对热记忆管容量（满了会静默丢最宽泛的）—— 互换就出事
2. L4 里索引精确（`memq`，带门牌能回原文）对图记忆模糊（`recall`，想不起词也能搜）—— 两条腿走路
3. L3 事件 → L4 判据，单向向上，且**不许复制正文**（复制是记忆系统最常见的腐烂方式）
4. 门牌 `log:<会话>#seq=<n>` 是索引 / 检索 / 压缩共用的那个接口

★ 文档里还诚实写了一个**已知缺口**：L4 的规矩是「没有指针的摘要不许进 L4」，
而 mnemon 的洞察天然没有 seq 门牌。目前的处理是「洞察算图记忆、不算摘要」，
但这一条不完美，写出来是为了将来谁动这个边界时不用重新发现一遍。

### 2026-10-25 · 路 A 在桌面端会把人带到错误结论上，install.js 现在会拦

`compaction` 和 `pruner` 这两个零件要顶掉 preset 里已有的内置条目，**只有路 B 能装**。
而走错路时给出的报错是：

```
Cannot find package '@deepseek-ai/dsh-compaction-basic' imported from ...
```

**通篇没有一个字提到装法。** 于是很自然的反应是「这东西桌面端装不了」——
然后就在这个结论上停住了，不再试路 B，也不再怀疑「我是不是走错路了」。
而它其实是**路线选错**，不是东西不存在。

现在 `installCommand` 认得这两个零件（`REPLACES_BUILTIN`），**不再给路 A 的手动两步**，
直接说明必然失败的原因、路 B 的四步，以及一行能自证的验证法：
手动 `/compact` 一次，看摘要首块有没有 `log:session-…-#seq=` 门牌 ——
有就是我们的实现接管了（内置引擎写不出门牌）。**不用装探针，也不用重启第二次。**

★ 顺带记一条没走通的推断：本来想用「依赖里有没有 `@deepseek-ai/*`」当判据，实测**会误报** ——
本机 profile 的 `@deepseek-ai` 里只有 9 个包，`cordis` / `dsh-agent` / `dsh-llm` 一个都不在，
可 `memory` 和 `huanqi` 照样跑。所以判据改成显式标注：**要顶掉内置条目的才走路 B**。

另外 `install-desktop.ps1` 装完会先跑一次 `verify-client-ids`（静态查注册 id 撞墙）。
撞了的话 DSH 启动直接失败，装完不查等于把雷留到重启。

---

## 2026-10-25 深夜 · 检索准确度 + 常驻服务第一轮

### ① 归一化（默认生效）

**病因是实测出来的**：`62829` 命中 0 条，因为日志里写的是 `62,829`（带千分位）。
同类问题：`DSH`(3615) 与 `dsh`(5888) 是**两批不同结果**；全角 `ＤＳＨ` 不认。

`norm()` 做三件事：**全角→半角、小写、去千分位**。
★ **只用于匹配，展示永远是原文** —— 把一手材料归一化再显示，等于篡改证据。

★ 踩了一个自己埋的坑：第一版正则 `/(\d),/g → ""` **把数字也吃掉了**，
`62,829` 变 `6829`。而「62,829」自己仍能命中（走 exact 档），**正好把 bug 掩盖了**。
**是 `62829` 查不到才暴露的**。教训：写「去掉某些字符」的正则，必须先跑一个带数字的用例。

★ 性能：纯中文词归一化后等于自己，不可能因此多命中 → 跳过整行 norm，省 800 ms。

### ② 近义匹配（`--near`，且**自动放宽**）

不用向量模型（要部署模型、占显存、响应慢）。用可编辑同义词表 `kit/echo/synonyms.json`，
双向生效，改完立即生效。

★ **它不该是用户记着的开关。** 爀曦 22:53 说：「这个开关是捏在你手上的，
近义匹配就是帮你做了『换个关键词再查一遍』这一步。」
所以：**精确 + 归一化只命中少于 3 条时，自动带 `--near` 重跑一次**（子进程 + 防递归）。
0 条也放宽：「真的没有」和「词不对」在结果上无法区分，而放宽一次只花 2.5 s。

实测：`指针` 800 → 1819 条；`帧偏移`（表里没有）31 → 31 条完全不变。

### ③ 常驻检索服务（第一轮）

`kit/echo/echo-svc.mjs` —— named pipe（`\\.\pipe\echo-hub`）+ 索引常驻内存 + stat 热更新。

**`memq` 自己用 top-level await 连 pipe**（不 spawn 子进程）。

★★ **三条退路，任何一条都回到原路径**：`ECHO_NO_SVC=1` / 连不上 / 900 ms 超时。
**实测命中数完全一致（1215 = 1215）。宁可慢，不可错。**

| 项 | 实测 |
|---|---|
| 服务内检索（索引层） | **23 ms**（原来是 300-440 ms） |
| `memq <词>` 整机 | **1.3-1.7×**（1875 vs 3131 ms，有负载干扰） |

★★ **没到 100 ms，而且原因要说准**：服务只替换了**四层里的索引层**。
剩下 1.5-2 s 全在 **书房 walk（8.3 GB / 6462 文件）**、墨、留底。
**第二轮必须把书房层也服务化**，否则「几十毫秒」是假的。

★ 三个估错的数（都记下来，免得下次还估错）：
1. 「遍历内存数组 + includes」不是 10-20 ms，是 **300-440 ms**（逐条 norm）；
2. `spawn` 一个 node 进程不是 60 ms，是 **310 ms**；
3. 服务只替换一层却接管了全局计数 → 命中数 954 vs 1215（**改局部时要问：这个变量是谁的**）。
