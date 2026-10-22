# plugins · 零件

这个目录放**能装的东西**。判据在 `../soul/`，模板在 `../skeleton/`，这里是实物。

## 三件事

**一、这些零件是从 `dsh-agent-organs` 迁过来的。**
原仓库保留作为开发源头。迁进来的是**源码**：不含 `node_modules`，不含演示视频（`yantai/demo/`），不含本机调试产物。

**二、每个子目录是一个完整的 DSH 插件包。**
通常是 `package.json` / `cordis.patch.yml` / `index.js`；带界面的再加 `client.js`。
`tools/` 下三个是**脚本**，不是插件，按各自 README 放到位即可。

**三、装之前先读清单。**
[`清单.md`](清单.md) 按「层」组织，每一行给：管什么 / 缺了会怎样 / 判据 / **装完怎么验它活了** / 必选 / 前置。

★ 最后那一列最要紧。**「文件复制过去了」不是判据。**

## 装

两条路，取决于你的 profile 是哪种：

**桌面端（Electron 应用管理）—— 不能用 CLI。** 实测报错：
`profile "desktop" is managed exclusively by the Electron application`。
走手动两步：把插件目录整个复制进 `<profile>/node_modules/<包名>/`，
在 `<profile>/package.json` 的 `dsh.profile.bundles` 数组里加上包名，然后**重启 DSH**。

**web / 其它 profile —— 用 CLI：**

```bash
dsh plugin --profile <名字> add file:<本仓库>/plugins/<目录>
```

★ 详细步骤（两个 profile 的差异、pnpm 的坑、硬链接会断的坑）见
[`../soul/07-bundle.json`](../soul/07-bundle.json) 的 `install` 段。

★ 也可以让 agent 调内置工具 `agent_soul_install`（`scan` / `plan` / `verify`）：
它看你这个 profile 缺什么、按装配顺序给精确命令。**它不替你装，只给命令。**

## 顺序

**不要跳步。** 尤其第 0 步：

```
第 0 步  先定权威源        ← 不先做这个，装什么都双重记账
第 1 步  Ⅰ ECHO
第 2 步  Ⅱ VITAL
第 3 步  Ⅲ 能力（这一层随便换）
第 4 步  Ⅳ 档案
第 5 步  Ⅴ 运维
```

`agent_soul_install` 的 `plan` 就是按这个顺序给的，不用自己记。

---

## ★ 已知的源缺陷（不是你装错了）

迁移时核出来三处**源仓库本来就带的毛病**。写在这里，免得复刻的人对着它们查半天：

**一、四个 README 还在让你跑一个已被排除的文件。**

`huanqi-panel` / `model-statusbar` / `riji` / `yantai` 的 README 里写着
`node selftest.mjs`，但那个文件**没有迁进来**（`.gitignore` 规则排除本机自测脚本）。

★ 这不影响插件运行 —— `selftest.mjs` 只是开发时的手动自测，装插件不需要它。
你看到「文件不存在」是对的，不是你拷漏了。

**二、`model-statusbar/package.json` 的 `files` 列了两个不存在的文件。**

```json
"files": ["index.js", "client.js", "cordis.patch.yml", "probe.ps1",
          "selftest.mjs",        // ← 迁移时排除
          "verify-gui.expr.js",  // ← ★ 源仓库里本来就没有这个文件
          "README.md"]
```

`verify-gui.expr.js` 在源仓库也不存在 —— 是当初写 `files` 时多写的一行，不是迁移造成的。
`files` 字段只影响 `npm pack` 打包，**不影响 DSH 加载**，所以装的时候不会报错。

**三、`model-statusbar` 名实不符（清单里也标了）。**

它按层位归在 Ⅱ「状态读数」那一格，但实际读的是**本地模型服务**（ComfyUI 的进程/显存/静息），
不是上下文水位。真正读水位的是 `yantai`。清单里把这处写明了，
因为复刻的人该知道这个格子里的实物和名字不完全对得上。

★ 这三处都是在**源仓库**里的，本仓库只是照实搬过来，**没有改源码**。
改源码会让这份副本和源头分叉，那比带着毛病更糟 —— 毛病能查，分叉查不出来。

---

## ★★ 2026-10-18 · 在真沙箱里装了一遍，撞出四个洞

上面三处是**读代码**读出来的。下面四处是**真的装**才撞出来的 ——
前三个洞用 mock 测、用眼睛看，都发现不了。

**一、`dsh plugin add` 在这台机器上根本跑不了：pnpm 不在 PATH。**

```
'pnpm' is not recognized as an internal or external command,
operable program or batch file.
dsh: pnpm failed in profile directory <profile>
```

`dsh plugin` 内部转发给 pnpm，而本机（workbuddy 带的 node 22.22.2）**没有 pnpm**。
`corepack enable` 也失败（它要往 node 目录写 shim，报 `Internal Error: not found: corepack`）。

★ **能用的路**：`corepack pnpm` 本身是好的（它会自己下载 pnpm 12.14.0 到
`%LOCALAPPDATA%\node\corepack\v1\pnpm\<ver>\`）。所以造一层薄壳放进 PATH 就行：

```bat
@echo off
"<node.exe 的绝对路径>" "<node 目录>\node_modules\corepack\dist\corepack.js" pnpm %*
```

★ 两个坑：`dist` 下是 **`corepack.js`** 不是 `corepack.cjs`；`corepack enable` 失败不等于 `corepack pnpm` 不能用。

**二、`compaction` 和 `pruner` 装完是死的 —— 它们没有 `dsh.bundle`。**

> ★★ **2026-10-22 已修，下面这段是历史记录。**
> 现在 13 个零件包**全部**都有 `dsh.bundle`，这两个也补上了壳层
> （`cordis.patch.yml` + 一个 `apply()` 去替换引擎）。
> 实测：`plugins/compaction/package.json` 与 `plugins/pruner/package.json` 的
> `dsh.bundle.patch` 都指向 `./cordis.patch.yml`，文件都在。
> `node tools/verify-packaging.mjs` 会逐包核对 `main` / `client.js` / `bundle.patch`
> 是否都被 `files` 清单覆盖（当前 13/13 通过）。
> **所以「装了、退出码 0、但不会被加载」不再成立** —— 保留这段是为了说明当初为什么是那个形状。

**当时**的情况：13 个零件包里 11 个有 `dsh.bundle`，这两个没有。装的时候 DSH 会明确警告：

```
warning: dsh-agent-compaction declares no dsh.bundle —
installed as a plain dependency, not a profile layer
(a later update that gains one activates it automatically)
```

**装了、退出码 0、但不会被加载。** 而且这正是第五层 ECHO 的地基 ——
最要紧的两个，恰好是最装不上的两个。

★ **根因**（不是疏漏，是形状不同）：它们 `export default class ... extends BasicCompactionEngine` /
`extends ToolResultPruner`，**是引擎类的替代实现，不是 cordis 插件**。
标准插件是 `export const name` + `export function apply` + `export default { name, apply }`。

★ **⇒ 这两个包的 README 写着「用 `dsh plugin add` 装」，与实际形状矛盾。**
要么给它俩补一层薄壳插件（`cordis.patch.yml` + 一个 `apply()` 里去替换引擎），
要么把 README 改成「手动放到 profile 的 node_modules 并配 cordis.patch.yml 替换引擎」。
**这件事还没做完，下一个接手的人从这里开始。**

**三、`plugins/compaction` 目录里连 `cordis.patch.yml` 都没有。**

> ★★ **2026-10-22 已修，下面是历史记录。** 现在该目录有五个文件：
> `HOW-TO-TAKEOVER.md` / `README.md` / `cordis.patch.yml` / `index.js` / `package.json`。
> 当时确实**整个加载层缺了**；后来是连壳一起补的。

**当时**只有 `index.js` / `package.json` / `README.md` 三个文件。
对照 11 个有 bundle 的包，每个都带 `cordis.patch.yml`。**所以洞二不是「漏写字段」，是整个加载层缺了。**

---

## ★ 判据：装完怎么知道它活了

**「文件复制过去了」不是判据。** 每一行都该有自己的验法：

| 插件 | 验它活了 |
|---|---|
| `compaction` | 兜底压出来的 checkpoint 里**有没有 `log:<会话>#seq=<n>` 指针块** |
| `pruner` | 被裁掉的工具结果**有没有替换成指向原文的标记** |
| `memory` | 会话的 system prompt 里**有没有时钟 + 自我层** |
| `clock` | 同上，看末尾那段诊断 |
| 带 `client.js` 的 | 页面上**那块 UI 真渲染出来了**，不只是 Host 报 running |

★ 最后一条是踩过的坑：客户端半的 `exports.inject = ["slots"]` 漏了，
**Host 显示 running、控制台零报错、页面上什么都没有** —— 彻底静默失效。

---

## 来源

这部分在重构时从 `dsh-agent-organs` 迁入，原仓库保留作为开发源头。
迁入的是**源码**：不含 `node_modules`、不含演示视频、不含本机调试产物。
98 个文件的 SHA-256 与源逐一对得上。
