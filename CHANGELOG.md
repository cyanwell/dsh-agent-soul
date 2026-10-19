# 更新记录

这份文件记的是**改动本身**：改了什么、为什么改、怎么验的。

★ 写法约定（2026-10-19 定）：

- **只追加，不改旧条目** —— 写错了就再加一条更正，让历史留着。
- **每条要能回答三个问题**：改之前是什么、为什么改、怎么确认改对了。
- **「为什么」优先于「改了什么」** —— 后者看 diff 就有，前者只有我能记。
- 日期用本地日期。★ 版本号暂时不跟语义化版本走，仓库还没发版。

---

## 2026-10-19 · 换气吸收空回合判据（四条判据共用一本账）

### 改之前是什么

`dsh-agent-huanqi` 只覆盖三种退化，而且**全部挂在 `llm/stream` 上**：

```
① 流内早杀    思考写到 silentReasoningChars 字、产出仍为零 → 就地截断
② 流末判定    reasoning-only 且连续停滞 → 续一轮
③ 输出重复    同一句刷屏 → 断流
```

它们的共同前提是「**有一次模型调用，而且流里有东西可看**」。

第四种退化落在这条缝外面：**整个回合结束了，一个字节都没吐** ——
只发 reasoning 块，然后直接 end-of-turn，没有 text、没有 tool-call。
引擎认为这一轮正常结束（`finish_reason: stop`、零工具调用），auto-continue 不管它，
会话就停在那儿等人手打「继续」。

此前靠独立插件 `dsh-stalled-turn-continue` 兜底。

### 为什么要改

两套判据各记一套账，**一轮会被续成两轮**：

| | 换气 | stalled-turn-continue |
|---|---|---|
| 计数 | `ledger`（跨会话共享） | `maxConsecutive: 3`（按会话） |
| 冷却 | `cooldownMs` 没有 | `cooldownMs: 20s` |
| 熔断 | 有（额度耗尽） | 没有（数到 3 就不管了） |

更麻烦的是**「额度」这个概念被劈成了两个**。额度应该是「还剩几次机会」的全局读数，
不是每个判据各算各的 —— 否则一次续命扣哪边的分、为什么扣，说不清。

### 改了什么

**判据 ④「空回合」并进换气，但不照搬那套账：**

- 判据挂在 `session/event` 的 `turn/end` 上（只有它知道「整轮结束」，流只知道「这次调用结束」）
- 命中后走换气自己的 `ledger`：`canContinue` → `spendContinuation` →
  `onContinuation`（异常窗口）→ `save`；耗尽则 `noteCircuitBreak` + 熔断文案
- 新增配置 `emptyTurnContinue`（默认 `true`），可单独关掉这一条
- **`dsh-stalled-turn-continue` 退休** —— 从 profile 的 `bundles` 里摘掉

**顺手补了两个洞**（都是原来的发布包缺的）：

- `package.json` 的 `files` 里写着 `README_EN.md` 和 `tools/analyze-session.mjs`，
  但实际文件不在包里 → 补上
- `tsconfig.json` 缺失 → 补上

**文档跟着改**：README 重写成「四条判据 + 三个动作」；package.json description、
`plugins/清单.md`、`echo-doctor.mjs`（两份）、`soul/05-doctor.md`、`client.js` 同步。

### 怎么确认改对了

**过程里抓到一个真 bug**（这个比结果重要）：

第一版写的是 `if (config.emptyTurnContinue && ...)`。
zod 的默认值 `true` **只在数据经过 schema 解析时才生效**；绕过解析的路径
（测试夹具、直接注入配置、从旧版本升级）拿到的是 `undefined`，真值判断当 `false`，
**整条监听压根不注册** —— 判据永远不工作，而且不报错、不留日志。

改成 `!== false`：只有显式写 `false` 才关。

**这个 bug 是被新测试抓出来的，不是被现有测试抓出来的。**
因为 `silent-cut.spec.mjs` 里的 `host()` 只注册 `llm/stream`，新加的 `session/event`
监听在原来那 185 个测试里**一次都没被触发过**。所以「185 个测试全过」当时是真的，
但它证明不了新功能。

**新增 `test/empty-turn.spec.mjs`（11 例）：**

```
✓ 空回合规续一轮（followup 被调用 + 额度 −1）
✓ no-visible-output 这个 kind 也认
✓ 有 text 的回合不续
✓ 有 tool-call 也算产出
✓ 同一轮先空转后产出 → 不续
✓ turn/start 会清零（上轮产出不算到本轮）
✓ error / interrupted / max-tokens → 不归它管
✓ 额度耗尽 → 不续，改成熔断
✓ emptyTurnContinue: false → 连监听都不注册
✓ maxContinuations: 0 → 同上
✓ 续过之后账本真的落盘，额度确实降了
```

**结果：196/196 全过。**

---

## 2026-10-17 · 再扫一遍旧口径

仓库文档里还留着「四个工具」「12 份知识文件」这类过期数字。
第二轮扩到 `.md/.json/.yml/.html/.js/.mjs/.ps1` 全类型，又挖出 15 处，全修。

★ 教训：**扫旧口径只扫 `.md` 会漏** —— 数字也活在代码注释和 HTML 里。

---

## 2026-10-17 · 裁判指出的三处硬伤

三个都属实：

1. `index.js` 的 doctor 文件清单漏了 `soul/12-ledger.md`，**而注释就在头上写着「漏了会漏检」**
   —— 检测法本身漏检。修法不是补一行，是**改成扫目录为准**（`readdirSoul()` + `FALLBACK` 兜底）。
2. `cordis.patch.yml` 写着「只加三个只读工具」，实际是 8 个。
3. GitHub README 旧版缓存 —— 本地已改并推送。

---

## 2026-10-14 · 换气放宽流内早杀阈值（3000 → 8000）

3000 会误杀约 7.9% 的正常长推理（全量 7533 步里，3000 字以上的正常步共 592 个），
当晚实测被误截断 4 次、全是正常思考，额度被误耗到 0 导致熔断。
放宽到 8000 后误杀率降到 0.37%。

★ 真正的主力是流末那层（`reasoning-only` + `stalledRun`）—— 全史 4 次循环全中、正常步零误报。
流内这层只负责「别等它自己停」。

---

## 2026-10-12 · 换气 v1.0

从 `dsh-loop-guard` fork，吸收 `dsh-reasoning-only-guard` 的空消息保护，
加上延续额度和熔断。三件套第一次凑齐：检测 → 续跑 → 熔断。

★ 额度定为「体温计」而不是「配额」：靠正常对话慢慢攒，异常时下降，最低 1 点。
理由是配额会让 agent 把注意力放在「我还有多少」上，而体温计只让它知道「我现在状态怎么样」。
