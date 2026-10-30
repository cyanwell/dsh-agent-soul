# GitHub issue 处理台账（2026-10-30 起）

> **为什么有这一页**：仓库有 **19 个 open issue**，来自 9 个不同的人。
> 我此前只跟进了其中 5 个，**其余 14 个连看都没看过** —— 这一页是把它们一次性盘清楚。
>
> ★ 复现方式：`https://github.com/cyanwell/dsh-agent-soul/issues`（需要登录态）。

---

## 先说一个纠正

**我上一轮写 `docs/issue-反馈处理.md` 时，只处理了 5 个 issue（#1–#5），
并在完成判据里写了「issue 全部有结论」。那是错的。**

实际是 19 个。**漏掉的 14 个里有 3 个是新报的（#20–#23），还有几个是同一批人报的更细的问题。**

这一页取代那份文档的「全部」口径。

---

## 19 个 issue 全表

| # | 标题（缩写） | 报告人 | 开于 | 已有回复 | 状态判断 |
|---|---|---|---|---|---|
| 23 | 桌面版 asar 下外部插件无法 import `@deepseek-ai/*` | JSON-LI-ai | 15h | **1 条（我，10-30）** | **已答 + 已加适用范围**（`HOW-TO-TAKEOVER.md` 开头）；`echo-doctor` 提示待分支 |
| 22 | mnemon 探针 逐字重复 | Akashyc | 2d | 无 | **待查** |
| 21 | 换气插件面板参数修改不生效 | kksnowny | 3d | 无 | **待查**（可能与 #2/#4 同类） |
| 20 | scaffold 在 soul 目录生成 AGENTS.md | JSON-LI-ai | 3d | 无 | **待查** |
| 19 | memq 时区写死 Asia/Shanghai | JSON-LI-ai | 3d | **1 条（我，10-30）** | **已修**（`88df108`） |
| 18 | install-kit 不生成 echo.config.json | JSON-LI-ai | 3d | 1 条 | 需读回复 |
| 17 | SELF 注入不按 cwd 过滤 | JSON-LI-ai | 3d | 无 | **待查**（可能是真 bug） |
| 14 | 代码里作者名没删干净 | Akashyc | 4d | **1 条（我，10-30）** | **部分修**（`a56c501`：preset 已清 0 处；README/注释待做） |
| 12 | compaction/pruner 在 preset isolate 下无法接管 | BravoHunter558 | 5d | 无 | **待查**（架构级） |
| 11 | 「过去」有口径，「现在」没有 | AzureHalcyon | 5d | 无 | 概念性建议 |
| 9 | plugin-inventory 把 patch insert 的插件标成「未启动」 | jing-hy | 5d | 1 条 | 需读回复 |
| 8 | docs「自研」误导 AI 读者 | jing-hy | 5d | 1 条 | 需读回复 |
| 7 | [echo] 面板配色写死深色主题 | jing-hy | 5d | 无 | **待查** |
| 6 | [clock] 桌面端弹层超出窗口 | jing-hy | 5d | 无 | **待查**（三种修法都无效，难） |
| 5 | 桌面打包版下 compaction/pruner/huanqi import 失败 | TaoCultivator | 1w | 1 条 | **已修**（`656ba72` 拦住路 A + 说明路 B） |
| 4 | id 命名空间崩启动 + 清空 profile | yunchengyc | 1w | 1 条 | **已修**（`77c5aa6` + `3ad6572` 的 #4-4） |
| 3 | echo-doctor 换气判据恒 warn | aslarn | 1w | 2 条（含我 10-30 补的） | **主问题已修**，留 `ledgerPath` 后续 |
| 2 | client.js id 与包名不一致时崩 | aslarn | 1w | **无** | **已修**（`77c5aa6`），但从未回复 |
| 1 | echo-doctor 门牌/压缩在外部策略下恒 warn | aslarn | 1w | 2 条 | **已修**（`3ad6572` + `9899e02`） |

---

## 已确认修好的（有 commit 可查）

| issue | commit | 做了什么 |
|---|---|---|
| **#1** | `3ad6572` + `9899e02` | 新增 `detectExternalCompaction()` 三态（显式配置 > 自动探测 bundles+gate 文件）；压缩/门牌不再只看最新一份日志（往前扫 5 份，一命中就停） |
| **#2** | `77c5aa6` | 仓库 name 与 client id 统一；两个 client.js + package.json 加注释写明「id 必须等于包名」这条不变量 |
| **#3** | `3ad6572` + `4b288d0` | 换气判据改读 `state/dsh-huanqi.json` 的 stats；`HQ_STATE` 升级成 `DSH_HOME / SESSIONS / cwd` 三候选逐个试读；两副本拉平（diff=0） |
| **#4** | `77c5aa6` + `3ad6572` | client id 崩（同上）；`verify-live` 把 asar 里的自带包归为内置、不再误报「缺失」（失败 4→0） |
| **#5** | `656ba72` + `9d23001` | `REPLACES_BUILTIN = {compaction, pruner}`：要顶掉内置条目的才走路 B；路 A 必然失败 → 直接给原因 + 路 B 四步 + 一行自证法 |

**#2 和 #5 的验证**（2026-10-30 实测）：

```
#2 仓库内 15 个包，name == client.id 全部一致
#5 install.js:200 REPLACES_BUILTIN / :316 if (REPLACES_BUILTIN.has(dir))
```

---

## #23 的结论（这一轮查清的）

**报告完全成立。而且本机能跑是因为「运气」——**

```
CJS 解析到: D:\AI\dsh\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-compaction-basic\lib\index.js
```

**本机能解析到 `@deepseek-ai/*`，靠的是 `D:\AI\dsh\node_modules\` 这棵 CLI 形态的树。
只有桌面版（asar）的机器没有这棵树 → 必然 `ERR_MODULE_NOT_FOUND`。**

而 `profiles/desktop/node_modules/@deepseek-ai/` 里只有 8 个包（cosmokit / dsh-atomic-write /
dsh-client-ui-primitives / dsh-home-paths / dsh-lsp 等），**没有 `dsh-compaction-basic`** ——
所以本机的 compaction 确实是走 CLI 树解析的，不是 profile 树。

**★ 这条要写进文档**：`HOW-TO-TAKEOVER.md` 和 README 必须标明适用范围（仅 CLI / demo profile）。

---

## 还没做的

| 项 | 说明 |
|---|---|
| #6 ~ #22 的 13 条 | **全部未读**。其中 #19（时区写死）、#14（注释作者名）、#20（scaffold）看起来是能直接改的 |
| #3 的 `ledgerPath` 后续 | 知道阻塞点（两种安装形态下事件流落盘位置不同），未做 |
| #23 的 `echo-doctor` 提示 | 那行「确认压缩插件是带门牌的版本」在桌面版是死路，要按分发形态分支 |
| #14 的 README / 代码注释 | README 7 处、插件 README 3 处、代码注释约 50 处 |
| 关闭已修的 issue | #1/#2/#3/#4/#5 主问题都修了，但因为还有后续或没回复，**都还开着** |

---

## 处理纪律

1. **先读 issue 正文再动手** —— 不要凭标题猜。
2. **回复必须能对上 commit** —— 说「已修」就要有 commit 号 + 具体改动。
3. **不能因为「我记得修过」就算修过** —— 要 `grep` 确认修复点还在（防止被后续改动覆盖）。
4. **该关的关** —— 主问题修完、回复完，就关。留着不等于负责，只等于积压。
