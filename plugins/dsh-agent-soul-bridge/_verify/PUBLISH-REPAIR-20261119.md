# dsh-agent-soul-bridge 发布修复报告

日期：2026-11-19
范围：开发树 `D:/AI/dsh-tools/dsh-agent-soul-bridge`。
约束：本轮未 push、未联网、未安装、未重启、未修改生产 profile；start/stop/restart 管理端点实现未改。

## 结论

发布契约已按产品决策修复为纯 Host 包。Host 代码、patch、README、测试基线和包清单已经对齐；pruner 能力保留但默认关闭，并继续出现在 `stubCaps`。本报告不把真实 DSH 或外部 pruner 验收缺口包装成通过。

## 改动清单

- `package.json`：版本统一为 `0.1.4`；移除 `exports["./client"]`；移除 `dsh.client`；从 `files` 移除 `client.js`；删除重复 `index.js`；加入 `probe.mjs`；加入 `syntax`、`selftest`、`packaging:smoke` scripts。
- `index.js`：`VERSION` 统一为 `0.1.4`；保留 10 个 Host caps；恢复 `stubCaps: ['huanqi', 'pruner']`；恢复 `prunerLive: false`。管理端点和 start/stop/restart 行为未改。
- `cordis.patch.yml`：保留与 `DEFAULTS.caps` 一致的 10 caps；`stubCaps` 与源码一致；`prunerLive: false`，避免 patch 偷开 pruner。
- `README.md`：顶部标明 0.1.4 和纯 Host 边界；删除旧的可发布 client UI 暗示；同步 caps、stub、pruner 默认值；说明 `probe.mjs` 包含在清单；补充更新记录和管理端点权限后续门。
- `_verify/packaging-smoke.mjs`：新增无外部依赖的 package JSON、版本、client 发布边界、文件存在性、重复项、caps/patch/pruner 配置检查。
- `client.js`：保留源码，未删除；当前不随包发布，也不通过 package client contract 宣称可达。
- `_verify/PUBLISH-REPAIR-20261119.md`：本报告。

## 验证记录

| 命令 | 结果 | 说明 |
|---|---|---|
| `node --check index.js` | PASS | 语法通过。 |
| `node --check ws.js` | PASS | 语法通过。 |
| `node --check probe.mjs` | PASS | 语法通过。 |
| `node --check pruner-adapter.mjs` | PASS | 语法通过。 |
| `node --check context-surgeon.mjs` | PASS | 语法通过。 |
| package JSON parse | PASS | `JSON.parse` 通过。 |
| `npm run syntax` | PASS | 通过 Node 22 的 `--run` 执行；当前 PowerShell PATH 没有 `npm`，未修改脚本。 |
| `npm run selftest` | PASS | 16 条 pruner 离线测试 + 2 条 offline wire refusal 测试，合计 18 pass。 |
| `npm run packaging:smoke` | PASS | `version=0.1.4 files=7 host-only=true`。 |
| `node --test _verify/pruner-sync/adapter.test.mjs` | SKIP | 外部依赖缺失，见下。 |
| `node --test _verify/pruner-sync-independent/bridge.independent.test.mjs` | SKIP | 外部依赖缺失，见下。 |
| `node --test _verify/pruner-sync-independent/wire.live.test.mjs` | SKIP | 外部依赖缺失，见下。 |
| `node --test _verify/pruner-sync-fix/wire.stage.test.mjs` | SKIP | 外部依赖缺失，见下。 |

### 外部依赖跳过项

以下 4 个测试均在 import 阶段失败，未进行安装或联网重试：

`Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-compaction-tool-result-pruner' imported from D:\AI\dsh-tools\dsh-yanqing-pruner\index.js`

它们还依赖 `dsh-yanqing-pruner`、agent-soul 源码或真实 profile 数据。该缺口属于环境/外部能力前置，不改变本轮纯 Host 包契约修复的 PASS 结果；但 pruner 真实会话能力仍未验收，因此不能开启 `prunerLive` 或移除 `stubCaps.pruner`。

## 未解决项与后续门

1. **管理端点权限**：本轮没有修改 `/agent-soul/start`、`/agent-soul/stop`、`/agent-soul/restart` 行为。当前审计仍记录无额外鉴权、`stop` 按镜像名 taskkill、可能误杀同镜像进程等风险。后续需要受信来源、CSRF、PID 精确绑定、并发启停和误杀边界设计与验证。
2. **client UI 后续门**：`client.js` 源码保留但不发布。若未来要交付 UI，需另行决定 Host+Client 产品形态，恢复 `exports["./client"]` 与 `dsh.client`，补有效 `inject`，并完成启动后 `__DSH_BOOT__.entries` 和 DOM 尺寸验收；本轮不做这些动作。
3. **pruner 真能力验收**：仅允许在非生产会话完成真实目标 session/seq/opId 验证，确认 `ok:true`、整数 `framesAffected`、有效 `pointer`、无额外 append 后，另行讨论是否开启。
4. **生产 profile**：本轮没有读取后修改或重启生产 profile；未验证安装副本与源树一致性，不能把开发树修复描述为已部署。

## 发布判定

本开发树的发布契约修复项已完成并有本地证据。原审计中的管理端点权限和外部 pruner 依赖仍是独立后续工作，不应在本版本发布说明中被省略。
