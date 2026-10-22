# dsh-agent-soul 审核报告（2214de1）

审核方式：只读静态检查。读了 20 个文件，写了 3 个临时脚本核对（node 解析 JSON / 比对 files 覆盖 / 比对 patch name），未执行 ps1，未跑 DSH。

**总判断**：上一轮修复的方向对（files 白名单、ps1 两份清单、暂存目录、ORDER），但**修复只覆盖了被报告过的那几个点，没有覆盖同类**。下面 13 条里，第 1–4 条仍能让别人的 profile 被 sanitize，第 5–9 条是"装上了但不工作"。

---

## 一、会坏别人环境

### 1. `install-desktop.ps1:120-121` 先删后移，且暂存目录跨卷

```powershell
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Move-Item $stage $dest
```

而 `$stage` 在 `$env:TEMP`（第 88 行），`$dest` 在 profile 下。第 87 行的注释自己写着：

> Staging in the SAME parent keeps the final swap a same-volume rename.

**注释和代码矛盾**：`$env:TEMP` 通常在 C:，而默认探测路径含 `D:\AI\dsh\home\profiles\desktop`（第 41 行）。跨卷时 `Move-Item` 退化为 copy+delete，不是原子改名。

**触发**：profile 在 D 盘、DSH 正在运行（文件被占用）、杀软扫描中、磁盘满。
**后果链**：第 120 行已删掉旧目录 → Move 失败 → `node_modules/dsh-agent-soul` 不存在 → 但 `dsh.profile.bundles` 里若已有这个名字 → DSH 启动找不到包 → sanitizeProfile → **用户整个 profile 的其他插件一起下线**。
**修法**：`$stage` 移到 `Join-Path $Profile 'node_modules\.soul-stage-' + $tag`；`Move-Item` 前把 `$dest` 改名为 `$dest.old-<tag>`，成功后再删，失败则改名回去。

### 2. `install-desktop.ps1:130-131` 关键依赖的检查晚于文件写入

```powershell
$addJs = Join-Path $dest 'tools\add-bundle.js'
if (-not (Test-Path $addJs)) { Die "add-bundle.js missing at $addJs" }
```

这个检查在第 121 行 `Move-Item` **之后**。而第 4b 步的自检 `$mustHave`（第 109 行）只查 5 项：`client.js / index.js / cordis.patch.yml / package.json / plugins` —— **不含 `tools/add-bundle.js`**。

**触发**：GitHub archive 解析出的 `tools/` 目录缺文件（当前仓库里文件存在，413 B，但这条防线依赖"下载完整"这个未经校验的假设）。
**后果**：文件已 swap 进 node_modules，bundles 未改 → 留下"文件在、没启用"的半装状态；`Die` 之前没有清理 `$dest`。
**修法**：把 `add-bundle.js` 加进 `$mustHave`（针对 stage 副本检查），检查通过才 swap。

### 3. `install.js:200-210` 桌面端手动指引只列 4 个文件，对 3 个包是错的

```
'  #    要的文件：package.json / cordis.patch.yml / index.js / client.js',
```

逐个核对 13 个子包：

| 包 | 实际需要 | 按"4 个文件"复制的结果 |
|---|---|---|
| `echo` | `index.js` import `./echo-config.mjs`（package.json files 第 4、5 项） | **缺 echo-config.mjs / echo-doctor.mjs → ERR_MODULE_NOT_FOUND** |
| `memory` | main = `lib/index.js`（package.json main 字段） | 根级没有 `index.js`，照抄会找不到文件 |
| `huanqi` | main = `lib/index.js`，包名 `dsh-huanqi` | 同上，且目标目录名按指引会写成 `dsh-agent-huanqi` |
| `model-statusbar` | `index.js` 读 `probe.ps1`（index.js 内 existsSync） | 缺 probe.ps1 → 状态栏静默不工作 |

**触发**：桌面端用户按 plan 输出的这一段手动复制。
**后果**：echo 是 ECHO 层的哨兵，加载失败 → 插件报错 → 若宿主不容忍，同样走 sanitize；即使不崩，用户失去了整套体检能力。
**修法**：指引改为"复制整个包目录，不要挑文件"；或从各子包 `package.json` 的 `files` 动态生成清单。

### 4. `tools/add-bundle.js:3` 没有 BOM 处理

```js
const j = JSON.parse(fs.readFileSync(pkgPath, "utf8"))
```

`fs.readFileSync(..., 'utf8')` 不去 BOM。若 profile 的 `package.json` 被记事本或 PS 5.1 的 `Set-Content -Encoding UTF8` 保存过（带 `\uFEFF`），`JSON.parse` 直接抛 `Unexpected token`。

**触发**：用户手工编辑过 profile 的 package.json。
**后果**：ps1 走第 133–136 行回滚 + Die，**不会崩**，但报错是"bundles edit failed, restored from backup: SyntaxError..."，用户完全看不出是 BOM 问题，会反复重试。
**修法**：`const raw = fs.readFileSync(pkgPath,'utf8').replace(/^\uFEFF/,'')`。

---

## 二、功能静默失效

### 5. `plugins/huanqi/cordis.patch.yml` 的 name 与包名不一致（最严重的一条静默失效）

- `plugins/huanqi/package.json` 的 `name` = **`dsh-huanqi`**
- `plugins/huanqi/cordis.patch.yml` 里 `name:` = **`dsh-agent-huanqi`**

13 个包里只有这一个不匹配（脚本逐包比对，其余 12 个均一致）。

**后果**：patch 指向一个不存在的模块名。轻则 cordis 加载不到（报错），重则按"name 不匹配被 skip"处理 → **huanqi 装上了、文件在、进程活着、稳态引擎从未运行**，而这恰好是"思考退化治理"那一层。用户不会发现，因为没有报错。
**修法**：patch 的 name 改为 `dsh-huanqi`；或把 package.json 改名回 `dsh-agent-huanqi`（二选一，但必须与 install.js 的 `PKG()` 一起定）。

### 6. `install.js:149` 的 `PKG()` 硬编码前缀，对 huanqi 和 external 件全错

```js
const PKG = (dir) => 'dsh-agent-' + dir
```

三处依赖它做判断：
- 第 314 行 `bundles.includes(PKG(d))` —— 对 `dsh-mnemon`（`external: true`）永远为 false → **误报"在 node_modules 但不在 bundles"**（同段第 302 行的 `notBundled` 用的是 `nameOf`，两处口径不一致）。
- 第 392 行 `names.has(PKG(d))` → `dsh-agent-huanqi` 永远不存在 → **huanqi 永远显示"缺"**，用户装了也认不出，plan 会无限提示装。
- 第 205 行 desktop 目标路径 `node_modules/dsh-agent-huanqi` → 与真实包名不符。

**修法**：所有地方统一用 `nameOf(d)`，`nameOf` 从各子包 package.json 读真实 name（或至少在 install.js 里维护一张 `dir → name` 映射并加注释说明为何不能靠前缀）。

### 7. `install.js:100` 的 ORDER 漏了 `dsh-mnemon`

ORDER 的 parts 合计 13 个（5+4+1+3）；`soul/07-bundle.json` 的 `parts` 是 14 个（含 `dsh-mnemon`，`required: true`）。

**后果**：`scan` 会报 `dsh-mnemon` 缺（`allDirs` 来自 bundle，14 个），但 `plan` 的六步里没有它 —— 用户按 plan 走完，scan 仍报缺一个必备件，且不知道去哪装。
**修法**：ORDER 第 1 步 parts 补 `'dsh-mnemon'`，并为 external 件单独生成安装命令（`dsh plugin add dsh-mnemon`，不是 `file:` 路径）。

### 8. `plugins/echo/echo-config.mjs:43,49` 模块顶层会因配置损坏而抛

```js
} catch (e) {
  throw new Error(`echo.config.json 解析失败：${p}\n  ${e.message}`);
}
...
const CFG = readConfigFile() || {}
```

文件不存在是安全的（第 37 行 `existsSync` 先判断）。**但文件存在而 JSON 写坏时，throw 发生在模块顶层** → `echo/index.js` 的 import 阶段就失败 → 插件加载失败。
**后果**：取决于宿主对插件加载错误的容忍度；按背景"插件缺陷会触发 sanitize"的前提，这一条与第 1 条同级别，只是触发条件更窄（用户手写了坏的配置）。
**修法**：顶层改为记录错误并在工具输出里报（`let CFG_ERROR = null`），不要 throw；或确保 index.js 用 `try { await import('./echo-config.mjs') } catch`。

### 9. `plugins/huanqi/package.json` 的 files 漏 `lib/index.d.ts`，exports 声明了打不进去的路径

```json
"files": ["lib/index.js","lib/types/**/*.d.ts", ...],
"exports": { "./src/*": "./src/*", "./tools/*": "./tools/*" }
```

`lib/` 实际只有 `index.js`（106 KB）和 `index.d.ts`（48 KB）——**`index.d.ts` 在 lib 根下，不匹配 `lib/types/**/*.d.ts`**，不进包。`src/` 整个目录也不在 files 里，但 exports 对外暴露了 `./src/*`。
**后果**：TS 用户无类型；任何 import `dsh-huanqi/src/*` 的调用方 404。运行时不炸，编译期/子路径导入才炸。
**修法**：files 加 `"lib/index.d.ts"`，删掉 `./src/*` 这条 export 或把 src 加进 files。

---

## 三、文档/口径不一致

### 10. `install.js:129-137` 注释说 `plugins/tools/` 是空目录——实际有三个脚本

注释原文：

> `plugins/tools/` 是个空目录，三个脚本一个都不存在，而 manifest 里第 Ⅴ 层也从来没有出现过这三个名字。

实测 `plugins/tools/` 下：`gateway/{README.md,index.mjs,query.mjs}`、`ledger/{README.md,ledger.mjs}`、`self/{README.md,self.mjs}`。而 `INSTALL.md:327` 也写"tools/（三个脚本目录，不是包）"——**INSTALL 对，install.js 的注释错**。
**后果**：下一个人读到这句会删掉或忽略这三个目录。
**修法**：改写这段注释，或删掉（它讨论的是一个已经不存在的问题）。

### 11. README 里的几个数字对不上实际

| 位置 | 原文 | 实际 |
|---|---|---|
| `README.md:181` | `07-bundle.json 参考实现清单：13 个零件包` | `07-bundle.json` 有 **14** 个 parts |
| `README.md:195` | `compaction … 14 个插件目录` | `plugins/` 下 **13 个包 + 1 个 tools 目录** |
| `README.md:257,266` | `读 soul/ 那十份` / `soul/ 下的十份文件` | `soul/` 实际 **13 个文件**（00–12），`index.js:173-176` 的清单也是 13 个 |
| `install-desktop.ps1:153` | `Parts live under <pkg>/plugins/ (14 of them).` | 同上，13 个包 / 14 个 parts 混用 |

### 12. `SANDBOX-VERIFICATION.md:52` 的描述已过时

> 13 个零件里 11 个有 `dsh.bundle`，只有 `compaction` 和 `pruner` 没有

实测 13 个包**全部**有 `dsh.bundle.patch` 且文件存在（compaction 与 pruner 的 `cordis.patch.yml` 都在）。这份文档开头自认"那时候 12 个零件"，但这一句没有标"已补齐"，会被当现状读。

### 13. `install.js:388` 与 `install.js:204` 有死代码，说明这段改过但没清

- 第 388 行 `s.kind === 'tools'`：ORDER 六项里没有 `kind: 'tools'`（只有 `human` / `plugins` / `slot`），分支永不进入。
- 第 204 行 `${pluginsDir ? '/' : '/'}`：三元两边都是 `'/'`。

都不影响运行，但会让下一个读代码的人以为"存在 tools 类步骤"，并去找它。

---

## 四、未能验证的部分

| 项 | 为什么 |
|---|---|
| patch name 不匹配的实际后果（报错 vs 静默跳过） | 没有 DSH 运行时，无法观察 cordis 的 patch 解析行为。第 5 条按"最坏情况静默"上报；若宿主对 insert 的 name 找不到模块会硬报错，则它降级为"会崩"，更严重。 |
| `dsh.client.inject: []` 的宿主语义 | 无法确认空数组是"自动用 exports['./client']"还是"不注入任何文件"。若是后者，**全部 7 个带 client 半的包都会静默不渲染** —— 这与"坑 5 端侧 UI 没渲染"是同一症状，值得优先确认。 |
| `sanitizeProfile` 的触发边界 | 背景说"启动失败会触发"。无法确认"单个插件加载失败"是否一定导致进程启动失败；第 1、3、8 条的后果链以此为前提，前提本身未经我验证。 |
| `install-desktop.ps1` 的实际行为 | 未执行（会写文件系统、下载网络资源），只静态读。执行策略、`Expand-Archive` 失败行为、`$LASTEXITCODE` 在 `& node` 后的取值均未实测。 |
| npm/pnpm 打包后的实际产物 | 未跑 `npm pack`，`files` 的判断基于 npm 语义推断。`lib/types/**/*.d.ts` 这种 glob 在 files 里的实际匹配也没有验证。 |
| `install.js` 的 desktop 分支是否被真实环境走到 | `isDesktop` 靠目录名 `desktop` 末尾匹配（第 275 行）。若用户的桌面 profile 不叫 desktop，会走 CLI 分支给错命令——我没有环境验证真实 DSH 的 profile 命名。 |

---

## 一句总结

最该先改的是 **第 1 条（ps1 的删-移顺序 + 跨卷暂存）和第 5 条（huanqi 的 patch name）**：前者能把别人的 profile 清空，后者会让稳态层永远不启动却毫无提示。其余 11 条都在"下一个人照它改会更好"的范围内。
