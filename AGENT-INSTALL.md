# AGENT-INSTALL.md —— 给 agent 读的安装说明书

> **你是 agent。这份文件是写给你的，不是写给人的。**
> 你的任务不是「执行命令」，是**把目标机器带到三层全绿的状态**。
>
> 人看不懂 DSH 的 profile 结构是正常的；你不需要他懂。你需要他做两件事：
> **① 告诉你 DSH 装在哪；② 装完帮他重启一次。**

---

## 0. 先做这一件事

```bash
node tools/soul-doctor.mjs              # 人看
node tools/soul-doctor.mjs --json       # 你读
```

**`--json` 的输出就是你的输入。** 它的形状：

```json
{
  "ok": false,
  "profile": "desktop",
  "home": "<你的 DSH_HOME，如 /home/you/.dsh>",
  "layers": {
    "L0": { "ok": true,  "checks": [{ "id": "...", "ok": true, "detail": "..." }] },
    "L1": { "ok": true,  "checks": [...] },
    "L2": { "ok": false, "checks": [..., { "id": "deadpresets", "ok": false, "detail": "...", "hint": "..." }] }
  },
  "failed": ["L2/deadpresets"]
}
```

**`failed` 是空的 → 装好了，跳到第 5 节。**

★★ **一条铁律：只看 `failed`。不要因为 `detail` 里某句话听起来像问题就去动手。**
   这份说明书里每一条失败都配了「怎么办」；不在里面的，别自己发明。

---

## 1. 三层是什么意思（读一次就够）

| 层 | 管什么 | 这层错了，你会看到 |
|---|---|---|
| **L0 地基** | DSH 本身装没装对、profile 在哪、配置能不能解析 | 后面两层**全白查**；UI 可能直接闪退 |
| **L1 能力** | 零件包能不能被解析到 | 零件显示红标，或者**静默不加载**（更常见） |
| **L2 装配** | preset 装进去了没、指向对不对 | picker 里看不到 preset |

**★ 按 L0 → L1 → L2 的顺序修。** 底层错了，上层报的错都是噪音 ——
doctor 失败时也只给你「最底层那一条」的建议。

---

## 2. L0 地基：五种失败

### `L0/home` —— 找不到 DSH 的 home

```bash
export DSH_HOME=/path/to/dsh/home      # Linux/macOS
$env:DSH_HOME = "D:\path\to\home"      # PowerShell
```

**默认位置**：Windows 是 `%LOCALAPPDATA%\Programs\DeepSeek Harness` 下的 `home`。
**不确定就问他**：DSH 装在哪、有没有改过用户目录。

### `L0/profile` —— 没有这个 profile

doctor 的 `detail` 里会列出**实际存在哪些 profile**。用那个名字重跑：

```bash
node tools/soul-doctor.mjs --profile web
```

★ **不要自己创建 profile 目录** —— 目录结构和默认文件由 DSH 生成，手搓出来的不能用。

### `L0/patch` —— 没有 cordis.patch.yml

**全新 profile 还没启动过。** 让他**启动一次 DSH**，这个文件会自己生成。

### `L0/pkgjson` —— JSON 解析失败 / 带 BOM

**★ 带 BOM 会让宿主 `JSON.parse` 直接崩，症状是「启动即闪退」。**

```bash
# 去 BOM（保留内容）
node -e "const f=require('fs');const p=process.argv[1];let s=f.readFileSync(p,'utf8');if(s.charCodeAt(0)===0xFEFF)s=s.slice(1);f.writeFileSync(p,s,'utf8')" "<pkgPath>"
```

### `L0/bundles` —— `dsh.profile.bundles` 不是纯字符串数组

**★★ 这是本仓库踩过的最贵的坑之一：写成 `{name, enabled}` 会被完全静默跳过 ——
不报错、不日志、界面什么都没。**

必须是：

```json
{ "dsh": { "profile": { "bundles": ["dsh-riji", "dsh-agent-memory"] } } }
```

**改之前先备份这个文件。** 改完重跑 doctor 确认条数没少。

---

## 3. L1 能力：两组失败

### `L1/parts` —— 四个砚青零件解析不到

需要在目标 profile 的 `node_modules` 里能找到这四个：

```
dsh-agent-compaction
dsh-agent-compact-region
dsh-agent-pruner
dsh-agent-memory
```

**★ 装法取决于它们的来源**（本地路径 / npm / 打包），本机是别人装的，
**所以这份说明书不写具体命令** —— 你要先问他：**这些包是从哪来的？**

**装完的判据**（不是「命令跑成功」）：

```bash
node -e "console.log(require.resolve('dsh-agent-compaction'))"
```

> ⚠️ `require.resolve` 要在 **profile 目录下**跑，否则解析到别处。

### `L1/official` —— 这个**不算失败**

标着「仅提示」，永远是 ✅。原因见脚本注释：官方包在 `app.asar` 里，
宿主加载插件时用自己的 resolve 上下文，profile 里看不到它是**正常的**。

**★ 只有当 UI 上砚青零件显示红标时，这条才需要理会。**

### `L1/nodever` —— node 太老

这些脚本用 `node:` 前缀的 ESM import，需要 **18+**，建议 **20 或 22**。

### `L1/pkgintegrity` —— 已装插件的 `package.json` 不自洽

**查什么**：入口里每个 `import './x'` 的文件必须真的存在；不存在时还会指出
「`files` 里也没列这个目录 → **装机必丢**」。

**★★ 为什么这条值得单独查**（用户反馈里踩过三次）：

| 次 | 白名单 | 漏了什么 | 症状 |
|---|---|---|---|
| 1 | `peerDependencies` | 没声明宿主包 | **插件不加载、无 crash 日志** |
| 2 | （id 空间） | 两个包同一 client id | **启动崩溃循环** |
| 3 | `files` | 漏列 `lib` | import 失败 ⇒ **长得像服务空窗** |

**共同形状：装机时不报错，症状出现在别处，且长得像另一个病。**

**怎么办**：在**那个包**的 `package.json` 的 `files` 里补上缺的目录，然后重装。
★ 改源码树没用 —— `files` 是包自己的字段，要重新打包/安装才生效。

### `L1/peerdeps` —— `peerDependencies` 没声明宿主包

**查什么**：源码里 `import` 了 `@deepseek-ai/*`，就必须在 `peerDependencies` 里声明。

**为什么**：宿主按 `peerDependencies` 白名单拦截。**缺声明时插件不加载，而且没有 crash 日志** ——
你会看到一个「装了、但什么都没发生」的插件。

**怎么办**：补进**那个包**的 `peerDependencies`（和 `files` 一样，要重装才生效）。

★ **一条自检**：这条检查如果在装机后仍然红，而你说「我明明改了」——
那多半是**改了源码树、没重装**。`grep -A2 peerDependencies <profile>/node_modules/<包>/package.json` 看一眼就知道。

---

## 4. L2 装配：五个检查

### `L2/presets` —— 一个 preset 块都没有

**★★ 最重要的背景：`dsh 0.2.0-rc.2` 起 preset 是 profile 层声明，不再扫描 `.agent-presets/` 目录。**
所以「目录里有文件」和「能装上」是两件事 —— 2026-09-30 那次事故就是这么来的：
文件完好、健康检查全绿，然后它们从 picker 里一起消失。

装进去：

```bash
node tools/soul-preset.mjs build --profile desktop           # 先比对，不写
node tools/soul-preset.mjs build --profile desktop --write   # 确认后写
```

**★ `build` 默认只比对。看到「一致」就不用动；看到「会插入」才加 `--write`。**

### `L2/threeparts` —— 某个 preset 缺零件

四组「三件套」，缺一级就是缺：

| 级 | 零件 | 缺了会怎样 |
|---|---|---|
| L1 压缩本身 | `dsh-agent-compaction` | 摘要没有门牌，压缩完回不去 |
| L2 裁剪带门牌 | `dsh-agent-pruner` | 被裁的工具结果回不去 |
| **L3 范围压缩** | `dsh-agent-compact-region` | **换气第二档治疗失效**（只压最近一段然后继续） |

**★ 缺 `compact-region` 时压缩仍然可用**，所以这个问题最容易被忽略 ——
表现出来是「能压缩，但遇到上下文快满时救不回思考」。

```bash
node tools/soul-preset.mjs build --profile desktop --write
```

### `L2/presetresolve` —— preset 里引用的包解析不到

`detail` 会列出具体哪几个。**这些包在 UI 上可能显示红标，也可能静默不加载。**

★ 通常是 L1 那一层没装好。**回去先修 L1。**

### `L2/registry` —— 没有 default / selectedDefault

preset 装上去了，但没人指向它 —— picker 里不会出现。
在 `cordis.patch.yml` 里找到 `agent-preset-registry` 块，补：

```yaml
default: standard          # 兜底（坏了也用这个起来）
selectedDefault: yanqing   # 新会话默认用哪个
```

**★ 不要把一个**没验过**的 preset 设成 default** —— 它会拖垮所有新会话。

### `L2/deadpresets` —— `.agent-presets/` 有残留

**文件在，但永远不生效**（0.2.0-rc.2 起不扫了）。

★ **不要直接删。** 先看清楚里面是什么 —— 可能还有你想迁移到 profile 的 preset。
确认都是旧的之后，改名成 `.agent-presets.bak-<日期>` 比删掉安全。

---

## 5. 装完的判据（三条，全过才算成）

**doctor 全绿只是第一层。** 真正要验的是「新会话能不能用上」。

### ① doctor 三层全绿

```bash
node tools/soul-doctor.mjs; echo "exit=$?"
# 期望：exit=0
```

### ② 重启 DSH

**★ 这一步不能跳。** profile 配置**只在启动时读一次**，host 不热加载。

### ③ 命令能被识别（30 秒，不用真开新会话）

重启后：

1. 打开**新建会话的界面**
2. 在 preset 选择器里切到要验的那个
3. 在输入框敲 `/compact-region`
4. **它被识别成一个命令**（出现在补全里）→ 成了

★ **不需要真的开这条会话、也不需要跑一次压缩。** 命令能被识别，
就说明 preset 加载成功、`dsh-agent-compact-region` 注册上了。

★ 这个方法比「开新会话跑一次」好：**更快，而且不消耗额度、不产生压缩副作用。**

---

## 6. 三条硬规矩

### ① 写配置前先备份

```bash
cp cordis.patch.yml "cordis.patch.yml.bak-$(date +%Y%m%d%H%M%S)"
cp package.json     "package.json.bak-$(date +%Y%m%d%H%M%S)"
```

**★ 改 `cordis.patch.yml` 之后必须复核 `dsh.profile.bundles` 的条数没变** ——
`sanitizeProfile` 会在某些情况下把它重置，表现是「别的插件一起消失」。

### ② 不解析 YAML

`cordis.patch.yml` 里有 `!!js process.platform` 这种 loader 专有写法，
**普通 YAML 解析器会炸**。本仓库所有脚本一律**文本扫描**。

你要改这个文件，也用文本操作（读整段、按行改、整段写回），不要 `yaml.load` 再 `dump`。

### ③ 不碰 default / selectedDefault（除非你确认过）

一个坏 preset 当默认，**会让所有新会话起不来**。改之前问一句：「这个 preset 验过吗？」

---

## 7. 装不上时，先看这个

### ★ 崩了去哪找日志（最常被问、且最难找）

**启动崩溃时 DSH 把报告写到：**

```
%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log
```

（Linux / macOS 对应 Electron 的 `app.getPath("logs")`。）

**★ 这个路径不在 Cache、不在 Storage** —— 它是从 asar 里的
`writeCrashReport(app.getPath("logs"))` 反推出来的。

**★ 崩了的人第一反应是反复重启 —— 那是错的**，因为每重启一次，掉出来的插件越多。
**先去看日志，再重启。**

### 已知问题

- `https://github.com/cyanwell/dsh-agent-soul/issues` —— 17 条，按类型分：
  **装不上**（#18 / #5 / #12）、**装上了崩**（#4 / #2）、**功能不符预期**（9 条）、**文档不清**（2 条）
- 本仓库 `README.md` 的「更新记录」—— 每条都写了「为什么改、怎么验的」

**★ 报告问题时请带上：**
`node tools/soul-doctor.mjs --json` 的完整输出 + DSH 版本 + 操作系统。
没有这三样，问题基本没法定位。

---

## 8. 这份说明书的诚实边界

| 这里写的 | 可靠性 |
|---|---|
| doctor 的 **15 项**检查 | **本机真跑过**（2026-10-28，见 `30-状态/调研.../21-分层doctor首跑记录.md`） |
| 「命令能被识别就算成」的验证法 | **真验过**（四个 preset 全部识别） |
| 每条失败的处理办法 | 逐条对应 doctor 的 `hint`，都来自实测 |
| `install.mjs` 的 doctor / apply / rollback | **三个都实跑过**（apply 的路径 bug 是实跑才发现的） |
| `install.mjs update` | ⚠️ **只验证了「不是 git 仓库」的错误分支**，没真跑过一次 pull |
| **零件包怎么装** | ★ **我不知道** —— 本机是别人装的，这段故意没写命令 |
| **新加的两项**（`pkgintegrity` / `peerdeps`） | ★ 首跑就抓到真 bug 和我自己的假警，都写进 README 了 |

**★ 最后一条原则：这份文件里没有一条是「应该有」。写了的，都是跑过的。**

---

## 9. 快捷方式：`install.mjs`

不想一条条对着上面做，可以用 `install.mjs` —— **它就是这份说明书的可执行版**。

```bash
node install.mjs doctor                 # = 第 0 节（转调 soul-doctor）
node install.mjs apply                  # 按 doctor 结论修 L2（默认 dry-run）
node install.mjs apply --write          # 真写
node install.mjs update                 # git pull + apply
node install.mjs rollback               # 列出备份，不指定 --to 不动手
node install.mjs rollback --to "<备份名>"
```

**它的三条设计规矩：**

1. **`apply` 先跑 `doctor`，L0/L1 有任一项不过就拒绝动手。**
   ★ 地基错了还去改配置，只会把环境搞得更乱，而且会掩盖真正的问题。
   ★ L2 **不在**这个门槛里 —— 因为 apply 正是修 L2 的工具（要求「L2 全绿才允许修 L2」是循环依赖）。

2. **默认 dry-run。** 除 `rollback`（它本身就是恢复动作）外，都要显式 `--write`。

3. **`rollback` 不指定 `--to` 就只列备份。** 恢复错的文件比不恢复更坏。
   而且它**先把当前状态另存一份**（`.bak-before-rollback-<时间>`）——
   否则「恢复」就变成了单向丢失。

**★ `apply` 现在只能修三样**：`presets`、`threeparts`、`presetresolve`（都是 `soul-preset build` 能干的）。
其余 L2 项（`registry`、`deadpresets`）它会列成「需要人工处理」——**它不替你决定
registry 该指哪个 preset，也不擅自删你的旧目录。**

