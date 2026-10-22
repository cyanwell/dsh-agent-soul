# dsh-agent-soul 复审报告（第二轮，修复后）

审核对象：`D:\AI\dsh-tools\dsh-agent-soul`（工作树，文件时间 2026-10-22 06:25）
方式：只读静态检查。逐条复核上轮 13 条，再查新增面（install.js 全文、ps1 全文、kit-bridge、scaffold 写入、client 渲染）。
未执行 ps1，未跑 DSH。

---

## 一、上轮 13 条的复核结果

| # | 上轮问题 | 状态 | 证据 |
|---|---|---|---|
| 1 | ps1 先删后移 + 跨卷暂存 | ✅ 已修 | `install-desktop.ps1:89` stage 移到 `$Profile\node_modules\.dsh-agent-soul-stage-$tag`；`:124-139` 改为 rename-aside，失败回滚 |
| 2 | add-bundle 检查晚于 swap | ✅ 已修 | `install-desktop.ps1:110` `$mustHave` 加入 `'tools/add-bundle.js'`，在 stage 阶段就检查 |
| 3 | 桌面指引只列 4 个文件 | ✅ 已修 | `install.js:232-235` 改为"复制整个包目录"，并逐包说明差异（echo/memory/huanqi/model-statusbar） |
| 4 | add-bundle 无 BOM 处理 | ✅ 已修 | `tools/add-bundle.js:3` 增加 `.replace(/^﻿/, "")` |
| 5 | huanqi patch name 不一致 | ✅ 已修 | `plugins/huanqi/cordis.patch.yml` 末行 `name: 'dsh-huanqi'`，与 package.json 一致 |
| 6 | PKG 硬编码前缀 | ⚠️ 部分修复 | plan 分支已修（`install.js:149-174` 新增 `PKG_NAMES`/`loadPkgNames`，`:395` 调用）；**scan 分支没修**，见新增问题 4 |
| 7 | ORDER 漏 dsh-mnemon | ❌ 未修 | `install.js:100` parts 仍为 5 项，无 `'dsh-mnemon'`；`07-bundle.json` 是 14 个 parts |
| 8 | echo-config 顶层 throw | ❌ 未修 | `plugins/echo/echo-config.mjs:43` 仍在 catch 里 throw，`:49` 模块顶层执行 |
| 9 | huanqi files 漏 index.d.ts | ❌ 未修 | `plugins/huanqi/package.json` files 仍为 `["lib/index.js","lib/types/**/*.d.ts",...]`；`lib/index.d.ts`（48 KB）不在内 |
| 10 | install.js 注释称 plugins/tools 为空 | ❌ 未修 | `install.js:132` 仍写"`plugins/tools/` 是个空目录，三个脚本一个都不存在"；实际三个目录各有 README + 脚本 |
| 11 | README 数字 | ❌ 未修 | `:181` "13 个零件包"、`:195` "14 个插件目录"、`:257/:266` "十份"（实际 13 个 soul 文件） |
| 12 | SANDBOX 第 52 行过时 | ❌ 未修 | `SANDBOX-VERIFICATION.md:52` 仍称"只有 compaction 和 pruner 没有 dsh.bundle"；实测 13 个全有 |
| 13 | 死代码 | ❌ 未修 | `install.js:418` `s.kind === 'tools'`（ORDER 无此 kind）；`:204` 三元两边都是 `'/'` |

**结论：6 条已修，1 条部分修，6 条未修。** 已修的 6 条质量都不错（尤其第 1 条的 rename-aside 和第 3 条的逐包说明），修得比原报告建议的更细。

---

## 二、会坏别人环境（新增）

### N1. `install-desktop.ps1:132-137` 回滚失败时仍然宣称"已恢复"

```powershell
} catch {
  if ($backup -and (Test-Path $backup) -and -not (Test-Path $dest)) {
    Rename-Item -Path $backup -NewName (Split-Path $dest -Leaf) -ErrorAction SilentlyContinue
  }
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Die ("swap failed: " + $_.Exception.Message + " - previous install restored, nothing was left half-applied.")
}
```

`Rename-Item` 带 `-ErrorAction SilentlyContinue`，回滚失败不抛也不记。紧接着 `Die` 的文案是**固定字符串** "previous install restored"。

**触发**：`Move-Item` 失败的原因（目标被占用、权限、磁盘满）通常**同样会让 `Rename-Item` 失败**——两者操作的是同一个目录。
**后果**：用户被告知"旧版已恢复"，重启后发现 `node_modules/dsh-agent-soul` 不存在、而 bundles 里仍然有它 → 启动失败 → sanitize。**这条比上轮的 1 号更隐蔽：它让用户相信可以放心重启。**
**修法**：回滚后 `if (-not (Test-Path $dest)) { Die "swap failed AND rollback failed; your old copy is at $backup — move it back to $dest before restarting." }`，把备份路径明确告诉用户。

### N2. `install-desktop.ps1:128` 改名失败时抛裸异常，残留 stage/zip/tmp

```powershell
Rename-Item -Path $dest -NewName (Split-Path $backup -Leaf) -ErrorAction Stop
```

`$ErrorActionPreference = 'Stop'`（第 26 行）下，这一行抛错会直接终止脚本，**不经过 `Die`**，因此：
- 用户看到的是 PowerShell 红色堆栈，不是可读的失败提示；
- `$stage`、`$zip`、`$tmp`、以及可能已建了一半的 `$backup` 都留在磁盘上；
- 好在此时 `$dest` 未被删除、bundles 未动，**环境是安全的**——属于体验问题，不是事故。

**修法**：把第 125-129 行包进 try/catch，失败时 `Die "cannot rename the live package (is DSH running?) — close DSH and rerun."`。

---

## 三、功能静默失效（新增）

### N3. `install.js` 里还有 3 处 `JSON.parse` 没去 BOM —— 同类问题修了一处漏三处

`add-bundle.js`（第 3 行）已经修了 BOM，但 `install.js` 的三处读盘没有：

| 行号 | 位置 | 后果 |
|---|---|---|
| 47-48 | `installedPackages()` 读 profile/package.json | 被外层 `catch {}` 吞掉 → `bundles = []` → **所有已装包都显示"在 node_modules 但不在 bundles"**，用户以为全都没启用 |
| 73 | `assertProfile()` | `throw new Error('profile 的 package.json 读不了或不是合法 JSON')` → **把 BOM 说成"不是合法 JSON"**，用户会去查语法而不是编码 |
| 168 | `loadPkgNames()` 读子包 package.json | 被 `catch {}` 跳过 → 该包名不在 Map 里 → 退化为 `'dsh-agent-' + dir` → **huanqi 又变成 `dsh-agent-huanqi`**，plan 报"缺" |

**触发**：profile 或子包的 package.json 被记事本 / PS 5.1 `Set-Content -Encoding UTF8` 保存过（真实发生过，第 4 条就是因此上报的）。
**修法**：抽一个 `readJsonNoBom(p)` helper，四处共用。

### N4. `install.js` 的 scan 分支没有调用 `loadPkgNames()` —— huanqi 在 scan 里仍报"缺"

- `loadPkgNames()` 只在 plan 分支调用（第 395 行）；
- scan/verify 分支（第 333-388 行）在它之前返回；
- 于是 scan 时 `PKG_NAMES` 是空 Map，`PKG('huanqi')` 退化为 `'dsh-agent-huanqi'`；
- 第 327 行 `installed = allDirs.filter(d => names.has(nameOf(d)))` → 装好的 `dsh-huanqi` 认不出 → **"已装 N/13" 永远少一个**；
- 第 343 行 `bundles.includes(PKG(d))` 也会对 huanqi 误报"未启用"。

**症状为什么不易发现**：用户跑 `agent_soul_install action=scan`，看到"缺 dsh-agent-huanqi"，去装（正确装的是 `dsh-huanqi`），回来再 scan **还是缺**。他会怀疑"是不是没装进去"，而不是"工具认错了名字"。
**修法**：`loadPkgNames()` 提前到 `assertProfile` 之后、scan 分支之前调用一次（`findPluginsDir()` 的结果可以复用，但 scan 分支目前没调用它——需要允许 scan 时找不到目录就跳过）。

### N5. `kit-bridge.mjs:56` 的超时是 180 秒 —— 工具调用会被挂三分钟

```js
timeout: 180000,
```

第 12 行的注释写着"超时要给。卡死的脚本不能把工具调用挂在那儿"，但 3 分钟对 agent 工具调用来说仍然是"卡死"的体验。多数 kit 脚本是百毫秒级（`plan.mjs` 8 KB、`diagnose.mjs` 11 KB），只有 `echo-doctor.mjs`（36 KB，deep 模式）可能慢。
**修法**：默认 30 秒，deep 模式单独传 120 秒；超时后返回 `code: 'ETIMEDOUT'` 并提示"这通常意味着配置指向了一个巨大/不可读的目录"。

---

## 四、安全

### N6. `agent_soul_scaffold` 的 roots 参数没有路径边界校验

`index.js:222-231` 定义 `soul / memory / sessions / runtime` 四个自由字符串（无 `pattern`、无白名单），经 `envFromArgs`（`kit-bridge.mjs:75-82`）变成环境变量，`kit/echo/scaffold.mjs` 直接 `path.join(CFG.SOUL, ...)` 并 `mkdirSync` / `writeFileSync`（`scaffold.mjs:163, 170, 230, 245, 262`）。

**已确认的护栏**：每个写入点前都有 `existsSync`（`:157/:180/:217/:238/:254`），**不会覆盖已有文件**；`apply=false` 时一个字节都不写。
**剩余风险**：`apply=true` 时可以在任意可写目录下创建"11 个目录 + 账本 + AGENTS.md + SELF/VITAL 模板"。威胁模型不是外部攻击，而是 **prompt injection 让 agent 把 soul 指到 `C:\Users\pc\Documents` 之类的位置**，然后在用户目录里留下一堆 `00-宪章/01-墨/...` 目录。
**修法**：`scaffold.mjs` 增加一条前置断言——`CFG.SOUL` 必须已存在且是目录（不自动创建它的父级之外的路径），或在 index.js 层校验路径不含 `..`、且位于用户 home 之下（可用 `process.env.USERPROFILE` 比较）。

### N7. `kit-bridge.mjs:35` 的 script 参数可被 `../` 逃逸（当前不可利用）

```js
const p = join(KIT, script)
```

`join` 不阻止 `../`。当前四个调用点的 script 全是硬编码字面量（`index.js:263/327/379/445`），所以**现在不可利用**；但接口本身允许 `runKit('../../../evil.mjs')`，一旦将来把 script 做成参数就会变成任意脚本执行。
**修法**：`if (script.includes('..') || script.includes('/') || script.includes('\\')) throw`。

---

## 五、未修复的旧问题（复用上轮编号，位置已更新）

- **7** `install.js:100` ORDER 缺 `dsh-mnemon`（必备件，scan 报缺但 plan 永不提示）
- **9** `plugins/huanqi/package.json` files 缺 `lib/index.d.ts`；`exports` 仍暴露 `./src/*` 而 `src/` 不在 files
- **10** `install.js:132` "plugins/tools 是空目录" 的错误注释（实际三个目录有脚本）
- **11** README 四处数字（`:181`、`:195`、`:257`、`:266`）
- **12** `SANDBOX-VERIFICATION.md:52`
- **13** `install.js:418` / `:204` 死代码
- **（新）** `install-desktop.ps1:171` 仍写 "14 of them"，与 13 个包/14 个 parts 的混用

---

## 六、未能验证

| 项 | 原因 |
|---|---|
| `sanitizeProfile` 的真实触发条件 | 无 DSH 运行时。N1 的后果链建立在"启动找不到 bundles 中的包即失败"这一前提上，该前提未经我实测。 |
| `dsh.client.inject: []` 的宿主语义 | 与上轮同。若空数组 = "不注入"，7 个带 client 的包会全部不渲染。 |
| ps1 的执行行为 | 未执行（会写盘/下载）。N2 的"抛裸异常"是按 `$ErrorActionPreference='Stop'` 的语义推断，未实测。 |
| npm 打包后 `files` 的实际结果 | 未跑 `npm pack`；`lib/types/**/*.d.ts` 这种 glob 行为是推断。 |
| `scaffold.mjs` 在 `CFG.SOUL` 为相对路径时的行为 | 未执行；`path.join` 对相对路径会基于 `process.cwd()`，而 agent 宿主的 cwd 不确定——这一点值得实测。 |

---

## 七、优先级建议

1. **N1**（回滚失败仍宣称恢复）——它让用户放心重启，代价最大。
2. **N3 + N4**（BOM 三处 + scan 不加载包名）——两者叠加会让"装好了但工具说没装"，且都是高频动作。
3. **7**（ORDER 缺 dsh-mnemon）——必备件漏提示，架构少一层。
4. **N6**（scaffold 路径校验）——唯一有"写用户目录"风险的入口。
5. 其余为文档与体验，集中在一次清理即可。
