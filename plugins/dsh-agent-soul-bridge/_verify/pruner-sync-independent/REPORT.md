# 桥侧 pruner 薄适配 · 独立复核（2026-11-11）

> 复核者未参与实现。**结论：源码级 PASS**，附 1 条建议改文案的发现 + 3 条部署前必验。
>
> ★ **2026-11-11 上线前修正**：F1 **已修并复跑全绿**（桥 8 + 18 + 7 + 线上 1 + 新增 5）。
> 失败帧现在带 `[stage:<code>] ` 前缀 + `stage` 字段；v4 `stageOfError()` 已认前缀
> （闭环测试 `_verify/pruner-sync-fix/wire.stage.test.mjs`）。pruner 侧的 F3/F5 见
> `dsh-yanqing-pruner/_verify/sync-apply-drops-fix/REPORT.md`。U1–U3 **没动**。
> 完整判据、帧级读数、17 条断言在 pruner 那边：
> D:\AI\dsh-tools\dsh-yanqing-pruner\_verify\sync-apply-drops-independent\REPORT.md

## 复跑读数

| # | 命令（工作目录 = 本包） | 结果 | exit |
|---|---|---|---|
| S3 | node --import "file:///D:/AI/dsh-tools/dsh-yanqing-pruner/test/register.mjs" --test _verify/pruner-sync/adapter.test.mjs | 8 / pass 8 / fail 0 | 0 |
| S4 | 同上 --test _verify/pruner-eval/pruner-stub.test.mjs _verify/pruner-eval/wire-refusal.test.mjs | 18 / pass 18 / fail 0 | 0 |
| S6 | 同上 --test _verify/pruner-sync-independent/bridge.independent.test.mjs | 7 / pass 7 / fail 0 | 0 |
| S7 | 同上 --test _verify/pruner-sync-independent/wire.live.test.mjs | 1 / pass 1 / fail 0 | 0 |

## 我另造的 8 条（S6 + S7）

| 用例 | 结论 |
|---|---|
| B1 | DEFAULTS.prunerLive === false；caps 含 pruner 而 **stubCaps 仍含 pruner**；桩文案单行、回显请求、说清缺口 |
| B2 | 通道 a + 真 applyDrops：回执来自真实改写；v4 真 judgeCleanupReceipt 认（pointer/coverage/atSource=host）；bytesAffected 键不出现 |
| B3 | 通道 b（ctx.toolResultPruner）与 c（agent.ctx）各自都能被找到并执行；tried 的四条 why 齐全 |
| B4 | 三条通道全空 → no-pruner，会话零写入，**不自己拼 surface 改写** |
| B5 | no-target / target-mismatch / bad-request 三 stage 在进程内可分；整轮零写入 |
| B6 | applyDrops 回 ok:false → 原样带 code；返回 null 或 {} → apply-failed；**不包装成成功** |
| B7 | 真链路两轮 + 重放；生产回执内容 hash 前后相同；活实例表摘干净 |
| **B8（线上）** | prunerLive=true 时 exec 真的穿到适配器：framesAffected=2 / pointer / 无 bytesAffected；线上重放零新增 append；no-target 与不明 action 均拒绝且不动会话 |

★ B8 覆盖 exec → handleExec → runExec → 适配器 → 真 applyDrops → result 帧；
而且它是在**模块通道必然失败**的环境下跑的（本包源码目录没有 node_modules），
所以顺带证明：通道 a 拿不到时通道 c 仍能让活干完。

## 发现（非阻断）

**F1（唯一建议改）**：线上 result 帧只带 error 字符串，**stage 丢在进程内**。
sendResult(id,false,payload) 只做 String(payload)，所以 v4 看到的是
「目标会话 session-nope 不在活的 agent 里」——里面没有 no-target 这个词；
v4 的 stageOfError() 只认 timeout 与「宿主不在/没有能力」，其余一律记 transport-error。
建议把 stage 前缀进 message（如 [no-target] …），或协议加 stage 字段。纯文案，不影响安全。

**★ 已修（2026-11-11）**：根因是 `handleExec` 的 `.catch(e => String(e.message))` ——
把 Error 对象压成字符串时 `e.stage` 就没了。现在把异常对象交给 `sendResult`，
失败帧固定 `error:'[stage:<code>] …'` + `stage:'<code>'`；正文单行、隐去凭据键值对、限长 500。
v4 的 `stageOfError()` 加了前缀解析（机器可读优先于人话正则）。
测试：`_verify/pruner-sync-fix/wire.stage.test.mjs`（含 no-target / no-pruner / stub /
opid-reused / timeout / 不泄密 / v4 真 stageOfError 闭环）。

其余与 pruner 侧同源（幂等依赖回执文件、超集区间重放、dryRun 对已用 opId 变重放、getLivePruner 兜底到最后一个实例），见 pruner 报告 §6。

## 未验（不能读成已验证）

- U1 **生产桥上能否拿到活 pruner 实例**：静态只到「从部署位置解析 dsh-yanqing-pruner 得到 profiles/desktop/node_modules 那份真文件（size 44820 = 旧版、没有 getLivePruner）」。宿主按哪个 base 加载 preset 里那一行，只有真起 DSH 才知道。
- U2 真实 DSH Session（freezeMessage / 持久化 / 事件校验）没跑过。
- U3 并发无锁。

## 上生产前三件事

1. prunerLive=true + stubCaps 保留 pruner，对**非生产会话**手工 exec 一次，看 tried 与回执（决定通道成不成立）。
2. 真实会话上 dryRun → 1–2 帧真跑，核对 framesAffected/区间外不变/门牌可回取。
3. 确认调用落在目标 agent 不在写会话的窗口，并观察一次同 opId 重放：replayed:true 且零新增 append。
