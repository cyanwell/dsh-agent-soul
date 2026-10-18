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
