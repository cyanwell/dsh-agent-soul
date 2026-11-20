# pruner 能不能接成「定点清理」——评估与阻断证据（2026-11-10）

> 一句话结论：**接不成，保持桩。** 不是没找，是三条路各自被协议挡死：
> 唯一的裁剪服务**没有按 seq 范围点名**的入口；surface 协议**没有 remove**；
> 本机唯一真能「点名剪某条」的实现是**异步**的（下一次 pre-step 才执行）。
> 把这三条绕过去的唯一办法是**在桥里自己拼 surface 改写**——那等于把 pruner 的策略
> 抄一份到桥里（门牌、影子定价、tool-pair 平衡、replay 语义全要跟着漂）。不做。
>
> 本文把判据、最小缺口、推荐接点、以及「这次改了什么/没改什么」都写在这里，
> 下次不必从头查一遍。

---

## 一、v4 那边的契约（这次要对齐的东西）

出处 `D:AIagent-soulsrcorganscleanup.mjs`：

| 项 | 内容 | 行号 |
|---|---|---|
| cap / action | `pruner` / `targeted-cleanup` | :46-47 |
| args | `{ sessionId, targetSession, opId, startSeq, endSeq, reason? }`（sessionId 与 targetSession 同值，两个都送） | :17-22 / :333-340 |
| 成功回执必填 | `targetSession, opId, startSeq, endSeq, framesAffected`（整数 ≥0） | :128-160 |
| 可选 | `bytesAffected`（量不出就别填，**不补 0**）、`at` | :162-176 |
| 失败判据 | target 不匹配 → `target-mismatch`；opId 不匹配 → `opid-mismatch`；seq 不匹配 → `seq-mismatch`；缺字段 → `bad-receipt` | :137-160 |

★ 关键：**成功必须来自宿主回执**，v4 明确禁止内部 fallback（它连 loop/compaction 都不 import，结构上就走不了那条路）。
★ 还有一个决定性的前置事实（`probe.mjs:141-158` 的实测注释，源头 `agent-soul/src/control/hub.mjs:92-103`）：
**hub 会在派活前按 `hello.meta.stubs` 直接拒**（`hint='stub_declared'`）。
也就是说——只要桥还把 pruner 声明成桩，**v4 根本不会把 exec 发过来**。
所以「桥这边多写点 pruner 逻辑」在产出上是零；要么真能清理，要么老实声明桩。

---

## 二、三条真实可调用能力（全部用 cordis_inspect 读的，不是猜的）

### ① `toolResultPruner`（Host Service）

```
readonly config: ResolvedConfig
measureContent(blocks: readonly ContentBlock[]): number
pruneContent(blocks: readonly ContentBlock[]): ContentBlock[] | null
pruneSession(session: Session): PruneResult
```

- 出处：`@deepseek-ai/dsh-compaction-tool-result-pruner` **0.1.5-rc.2**，`lib/types/index.d.ts:19-51`；实现 `lib/index.js:137-180`。
- `PruneResult = { pruned: PrunedEntry[], charsRemoved }`；`PrunedEntry = { originalSeq, replacementSeq, callId, charsBefore, charsAfter }`。
- **选目标的规则是字符预算**：候选 = `session.surface.nodes` 里所有 `tool/result`，谁超过阈值裁谁。
  → **不接受 seq 范围、不接受点名列表、不接受 opId**。
- 它会写两份东西（replay-safe 的来源）：`compaction/prune` 影子定价事件 + 一条 `tool/result` 替换（`surfaceOp:{op:'replace',startSeq:seq,endSeq:seq}`、`sourceEventSeqs:[seq]`）。

### ② `compaction.compactRegion(start, end, agent, signal?)`

- 签名与语义（inspect 原文）：把一段 surface 节点**压成一条 LLM 摘要节点**；start/end 是**表面位置**不是数值序（替换后可见 seq 可能非单调）；两端必须 tool-pair 平衡；正在压缩时拒。
- 返回 `{ shadowedSeqs, shadowedTokenCount, summarySeq, ... }`（判据：`dsh-yanqing-compact-region/index.js:190-198` 实取这三个字段）。
- **三个硬条件**：要活着的 Agent（`agent.session`）、要模型调用、**服务在 preset 的隔离组里**。
  隔离证据：`D:AIdshhome.agent-presetsyanqingagent.cordis.yml:138-142`（`group: true` + `isolate: {compaction: true}`）；
  根层看不见它的实测记录：`dsh-yanqing-compact-region/index.js:6-18`（`agent.ctx → agent.session.ctx → 根 ctx` 三级探测全落空）。
- → 语义是**压缩**（换成摘要），不是**裁剪**；拿它冒充 `targeted-cleanup` 就是把「压缩」报成「清理」。

### ③ `Session` 的 surface 写面

```ts
type SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```

- 出处：live inspect（Host `toolResultPruner` 的 referencedTypes，`SurfaceOp` / `SurfaceIntent` / `SessionEventMap`）。
- **没有 `remove` / `drop`。** 也就是说「把一段帧拿掉」在协议层不存在；能做的只有
  「用一条新的 surface 节点替换一段」，且必须是 `SurfaceEventType` 里的类型。
- 这直接判死了「薄适配」这条路：范围级清理**没有原语**可用。

---

## 三、本机确实有「点名剪某条」的真本事，但它是异步的

`dsh-yanqing-pruner`（preset 里 `tool-result-pruner` 那行，`yanqing/agent.cordis.yml:259-264`）已经有 drop 指令层：

| 事实 | 出处 |
|---|---|
| 指令来自**命令文件**，形态 `{id, action:'drop', session, seq, why}`（v2 起还要带 `expect.sha256`） | `dsh-yanqing-pruner/context-contract.mjs:43-44`、`index.js:241-263` |
| 执行时机 = **该 agent 下一次 `agent/pre-step`** | `index.js:480` |
| 点名的 seq **即使低于普通阈值也被真的剪掉**（离线已验） | `test/drop-slice.test.mjs:113-120`（①） |
| 真实落盘仍走父类：`super.pruneSession(session)`，回执按**真实返回值**写 `applied` | `index.js:787`、`:803-828` |
| 改写失败时的终态词：`applied/already/missed/rejected/stale/error` | `index.js:739-770` |

**为什么它不能被桥直接当同步能力用：**

1. 它不是 Service 方法（没有可调入口），触发点是宿主内部 hook；
2. 它**异步**：写了指令，要等那个会话下一轮才执行 —— 桥的回执要是「已清理 N 帧」，
   而实际那一刻什么都没动，那就是伪成功（v4 的 `framesAffected` 语义是「真的动了几帧」）；
3. 它按 **单条 seq**（不按范围），范围要拆成一串指令，且每条都要过 `expect` 复核。

---

## 四、最小缺口 + 推荐真实接点（按改造成本排序）

### 缺口（一句话）

> `toolResultPruner` 需要一个**按 seq 点名**的入口；现在只有「整会话按预算扫」。

### 接点 A（推荐，改本机自己的包，不依赖上游）

在 `dsh-yanqing-pruner` 里把已有的 drop 逻辑**开成一个同步方法**（它内部已经实现全套校验与回执）：

```js
// dsh-yanqing-pruner/index.js（示意，不是已实现）
applyDrops(session, seqs) → PruneResult
//   - 只接受 session 当下 surface 上存在、且 type==='tool/result' 的 seq
//   - 逐条过 expect 复核（已有 __yqVerifyExpect）
//   - 复用 super.pruneSession 的落盘路径（compaction/prune + surfaceOp.replace + sourceEventSeqs）
//   - 返回 { pruned: PrunedEntry[], charsRemoved }
```

桥这边就只剩**薄适配**（约 40 行，且**不写任何 surface 逻辑**）：

| 步 | 做什么 | 失败就回 ok:false |
|---|---|---|
| 1 | 要求显式 `sessionId`（禁止 defaultSessionId / roots[0]） | `缺 args.sessionId` |
| 2 | 校验 `startSeq/endSeq` 整数、`start<=end`、`opId` 非空 | 已在 `describePrunerRequest` 里做（本次已实现，可复用） |
| 3 | 解析目标：`agents.get(sessionId)` → 活着的 `agent.session` | `目标会话不在活的 agent 里` |
| 4 | 把 range 展开成 surface 上命中的 `tool/result` seq 列表；**空就回 0 帧、不许编** | `区间内没有可剪的 tool/result` |
| 5 | 调 `applyDrops(session, seqs)` | 原样带出异常原因 |
| 6 | 回执：`targetSession/opId/startSeq/endSeq` **原样回显**；`framesAffected`=返回的 pruned 条数（只数区间内命中）；`bytesAffected` **量不出就不填**；`at`=ISO | —— |

### 接点 B（上游）

给上游 `ToolResultPruner` 加 `pruneNodes(session, seqs)`（语义同 A）。好处是跨包通用、不用改 3 个 profile 副本；坏处是等版本。

### 接点 C（不推荐，仅备）

借 `commands` 桥进 preset realm 做一条 `/cleanup-region <sid> <s> <e>`
（同 `dsh-yanqing-compact-region` 的形状）。缺点：必须有一个活 Agent（`commands.execute(agent, ...)`），
且 `compactRegion` 仍然只是压缩 —— 除非同时做 A/B，否则还是拿不到「裁剪」语义。

### 还有一个**未验**的前提（必须先弄清，否则 A 也白做）

桥挂在 **profile 根层**（`profiles/desktop/node_modules/dsh-agent-soul-bridge` + bundle patch），
而 pruner 注册在 **preset 组合内部**（`yanqing/agent.cordis.yml` 的 `compaction` 组里）。
所以桥的 `ctx.get('toolResultPruner')` **大概率返回 undefined**（同 `compact-region` 记下的
「根层看不见子 realm 服务」那一课）。可行的取法大概是
`agents.get(sessionId).ctx.get('toolResultPruner')` —— **这条没验过**，
要验就得往 profile 根层临时挂一个只读探针插件 = 改生产 profile + 重启 DSH。
**那是要爀曦点头的动作，这次没做。**

---

## 五、这次改了什么（只有这些）

| 文件 | 改动 |
|---|---|
| `index.js` | ① 头部「三条诚实纪律」第 ① 条补一句：评估过、结论是接不了；② 新增一节注释写清判据（①②③ 三条，带出处）；③ 导出 `PRUNER_CAP / PRUNER_ACTION / PRUNER_GAP / describePrunerRequest / prunerRefusalMessage`（纯函数，零 ctx）；④ `if (cap === 'pruner')` 分支改成 `throw new Error(prunerRefusalMessage(args, action))` —— **仍然 ok:false**，但回执里带请求原样回显（会话 / seq / opId）+ 缺什么 + 缺口在哪 |
| `_verify/pruner-eval/pruner-stub.test.mjs` | 新增：16 条离线测试（请求解析 9 条、悬崖 3 条、缺口可核 1 条、能力未升级 2 条、源码静态核对 1 条） |
| `_verify/pruner-eval/wire-refusal.test.mjs` | 新增：2 条**线上**测试（临时端口 + 假 ctx，直接对桥发 exec，验 result 帧真是 `ok:false`、单行、带请求回显、**不带 `framesAffected` / `data`**）。★ 绕过 hub 的桩拦截，覆盖「万一 `meta.stubs` 没被尊重」那条路 |
| `_verify/pruner-eval/wire-refusal.test.mjs` | 新增：2 条**线上**测试（临时端口 + 假 ctx，直接对桥发 exec，验 result 帧真的是 `ok:false`、单行、带请求回显、**不带 `framesAffected`/`data`**）。★ 这条绕过了 hub 的桩拦截，覆盖「万一 `meta.stubs` 没被尊重」那条路 |
| `_verify/pruner-eval/EVALUATION.md` | 本文 |
| `README.md` | 能力表那一行改成 `targeted-cleanup` 并链到本文；加一节「为什么 pruner 还是桩」 |
| `index.js.bak-pruner-eval-20261111-0000` / `README.md.bak-…` | 改前备份 |

**没改**：`caps`（仍是 `['followup','huanqi','pruner']`）、`stubCaps`（仍是 `['huanqi','pruner']`）、
`ws.js`、`probe.mjs`、`package.json`、`cordis.patch.yml`；没碰生产 profile / config / session；
没重启 DSH；没连 QQ；没读任何凭据。

---

## 六、验证（命令 + 结果）

```powershell
# 1a) 离线测试（纯函数 + 源码静态核对，不联网）
& "C:\Users\pc\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" `
  --test "D:\AI\dsh-tools\dsh-agent-soul-bridge\_verify\pruner-eval\pruner-stub.test.mjs"
# → # tests 16 / # pass 16 / # fail 0 / EXIT=0

# 1b) 线上测试（临时端口 + 假 ctx，验 result 帧本身）
& "C:\Users\pc\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" `
  --test "D:\AI\dsh-tools\dsh-agent-soul-bridge\_verify\pruner-eval\wire-refusal.test.mjs"
# → # tests 2 / # pass 2 / # fail 0 / EXIT=0

# 1b) 线上测试（临时端口 + 假 ctx，验 result 帧本身）
& "C:\Users\pc\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" `
  --test "D:\AI\dsh-tools\dsh-agent-soul-bridge\_verify\pruner-eval\wire-refusal.test.mjs"
# → # tests 2 / # pass 2 / # fail 0 / EXIT=0

# 2) 既有端到端探针（用 agent-soul 真实服务端代码起「假 v4」，不碰生产）
& "C:\Users\pc\.workbuddy\binaries\node\versions\22.22.2-3\node.exe" `
  "D:\AI\dsh-tools\dsh-agent-soul-bridge\probe.mjs" fake
# → PASS 17 / FAIL 0 / EXIT=0
#   （其中两条正好把结论钉住：
#     "pruner 桩在派活前就被拒（秒级，不是等 15 秒超时） — dsh 声明 pruner 是桩"）
```

---

## 七、剩下的步骤（都要人拍板 / 要重启，这次没做）

1. **弄清可达性**（改生产 profile + 重启）：往根层挂只读探针，验 `agents.get(sid).ctx.get('toolResultPruner')` 是否拿得到。
2. **做接点 A**（改 `dsh-yanqing-pruner` 源码 → 复制到 3 个 profile 副本 → 重启）。这是本机最省的一条。
3. **接桥**：实现 §四 的 6 步薄适配，然后用**一个非 lead 的真实会话**做一次真机定点清理验收
   （帧数、门牌 `log:<sid>#seq=<n>` 可回取、`bytesAffected` 有/无都记录）。
4. **只有第 3 步过了，才把 `pruner` 从 `DEFAULTS.stubCaps` 里拿掉**（并同步 README 能力表）。
   在那之前拿掉 = 让 v4 以为能清理 → 它会派活 → 桥回不出回执 → 15 秒超时。
5. 部署桥的本次改动（复制到 `profiles/desktop/node_modules/dsh-agent-soul-bridge` + 重启 DSH）。
   ★ 注意：即使部署了，**在 hub 拦住桩的前提下，本次改的文案在生产里也看不到**——
   它的价值是「万一 meta.stubs 没被尊重 / 有人直接发 exec，回执不会含糊」。

---

## 八、明确没做的事（免得被读成做过了）

- 没有把 `pruner` 报成「已实现」，也没有为了显得有产出而自己拼 `surfaceOp.replace`。
- 没有对**任何真实会话**执行清理（包括本容器、lead）。
- 没有改生产 profile / config / preset，没有重启 DSH。
- 没有动 `dsh-yanqing-pruner` / `dsh-yanqing-compact-region` 的源码。
- 独立复核由本次执行者自己做了一轮**只读代码核对**（见 §九）；没有第二个 agent 参与（本会话委派深度用尽）。

## 九、只读复核记录（2026-11-10，执行者自查）

逐条对回代码，不看记忆：

| 断言 | 核对方式 | 结果 |
|---|---|---|
| pruner 分支不可能回成功 | 读 `index.js` 的 runExec：pruner 分支只有一行 `throw`，无 `sendResult` | ✔ 同 `测试③/⑯` |
| 分支里没有会话兜底 | 该分支文本里无 `defaultSessionId` / `roots[0]` / `pickLiveAgent` | ✔ `测试③` |
| 能力没升级 | `DEFAULTS.caps` / `stubCaps` 未动 | ✔ `测试⑭`、`probe` 的 hello.meta.stubs 仍是 2 个 |
| 缺口描述可核 | `PRUNER_GAP` 带版本号与 `pruneSession` | ✔ `测试⑬` |
| 线上真的只回 ok:false | 假 ctx + 临时端口发 4 条 exec，逐条看 result 帧 | ✔ `wire-refusal` 2/2 |
| 失败回执不伪造影响帧数 | result 帧里没有 `data` / `framesAffected` | ✔ `wire-refusal` 第 2 条 |
| 没碰生产 | 生产 surfaces 的 SHA256 前后一致（见下） | ✔ |

生产基线（改动**前**取的，改动后复核一致）：
```
F359658D…B41013A5  profiles\desktop\node_modules\dsh-agent-soul-bridge\index.js
70FA9D21…A65EFB58  profiles\desktop\node_modules\dsh-agent-soul-bridge\package.json
C300DCF2…BA060768  profiles\desktop\cordis.yml
6E5F1C83…5041510C3  profiles\desktop\package.json
39B088DB…183F56A081  .agent-presets\yanqing\agent.cordis.yml
601688DE…21B51F1  profiles\web\node_modules\dsh-yanqing-pruner\index.js
7B0E817D…D00799186F  profiles\node_modules\dsh-yanqing-pruner\index.js
```
