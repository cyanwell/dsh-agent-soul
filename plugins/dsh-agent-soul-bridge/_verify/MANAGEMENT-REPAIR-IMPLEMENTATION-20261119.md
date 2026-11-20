# 管理端点安全修复实现报告

- 实现日期：2026-11-19
- 修复轮次：第十五轮
- 工作区：D:/AI/dsh-tools/dsh-agent-soul-bridge
- 范围：仅 bridge 管理端点与其生命周期安全层
- 生产保护：本轮没有调用真实管理端点，没有 start/stop/restart AgentSoul，没有联网

## 实现内容

1. 保留五条 exact route，descriptor 仍只有 kind/path/handler；handler 内强制 method：status/probe 仅 GET，start/stop/restart 仅 POST，其他方法返回 405 与 Allow。
2. 新增 loopback 校验，支持 127.0.0.1、::1 与 IPv4-mapped loopback；非 loopback fail-closed。
3. 新增独立 local-admin bearer：支持配置值或受限 token file；缺 token 或 Origin 未就绪时拒绝。使用 constant-time compare，不使用或回显 v4 的 X-Soul-Token。
4. 新增 exact Origin；Origin 必须与 webServer.getOrigin() 的 origin 完整相等。Referer 若存在只校验 origin，不能替代 Origin 或 bearer。
5. POST 只接受小型 application/json body，限制 16 KiB；必须有 requestId，格式为 ASCII 1..128，CSRF nonce 一次性消费，幂等重放不重复消费 nonce。
6. 新增 request ledger：同 route/id/语义并发只执行一次；完成结果短期重放并标记 replayed；跨 route 或 body 语义冲突返回 request-id-conflict，业务副作用不执行。
7. 新增按 lifecycle 的共享异步 mutex，start/stop/restart/keeperProbe 复用；手动 stop 的 keeper suppression 只在认证、body、CSRF、幂等首次执行通过后设置。
8. shared lifecycle 在被注入身份检查器提供有效身份时，会登记 instance record（instanceId、pid、realpath、startedAt、marker），并要求 PID 身份字段全匹配；该身份路径目前只由 fake inspector/marker fixtures 验证，不能表述为生产端已建立真实 instance record。
9. fake/stub lifecycle 的 restart contract 为 stop → confirm-down → start；在身份检查与下线确认失败时必须不 spawn。该合同有 fake 回归测试，不代表真实进程控制已验证。
10. AgentSoul 当前没有可验证 marker inspector，因此生产 lifecycle 以 identityAvailable=false fail-closed：不会在无法登记和复核实例身份时 spawn。fake 测试通过注入 inspector/marker 证据覆盖可用路径。
11. keeper 在共享 lifecycle 未登记时不再回退直接 spawn；保留 AgentSoulAutoStart 配置口径（当前默认 false）与原有 bridge WS/hello/exec/result/events/service/agent/context/caps 代码。
12. package.json 的 selftest 纳入 _verify/management-security.test.mjs。

## M-01..M-33 plus M-29b regression tests

测试文件：_verify/management-security.test.mjs

- M-01..M-11：fake request/response 纯校验，覆盖 route contract、method、loopback、exact Origin/Referer、独立 bearer、X-Soul-Token 不混用、一次性 nonce、JSON/body limit/requestId。
- M-12..M-18：fake health、fake process inspector、fake marker 与 fake terminate，覆盖 instance record、PID/path/startTime/marker mismatch、PID reuse/无 record、绝不 image-wide kill。
- M-19..M-22：fake 并发 start/stop、keeperProbe 与 suppression TTL，共享 mutex 且最多一次 spawn/terminate。
- M-23..M-25：fake request ledger 并发、重放、跨 route/body 冲突。
- M-26..M-29：fake restart 正常顺序、stop 失败/仍存活、身份不匹配、新实例验证失败不宣称 restarted。
- M-29b：注入 `identityAvailable=false` 与计数器 fake；assert start 不 spawn、keeper 不 spawn、无实例的 stop/restart 不 terminate。
- M-30：DEFAULTS 保留 10 个 v4 caps。
- M-31..M-32：源码静态检查 route/side-effect 保护，断言没有 taskkill /IM，仅保留单 PID 终止形态。
- M-33：源码契约检查 production composition 显式 identityAvailable=false、inspect fail-closed、管理 start/stop/restart 共用 lifecycle，keeper 调 lifecycle 而无直接 spawn fallback。它锁住当前安全缺口，不替代真实 inspector。

## 验证结果

使用绝对 Node 22.22.2：

- node --check index.js：通过
- node --check ws.js：通过
- node --check probe.mjs：通过
- node --check pruner-adapter.mjs：通过
- node --check context-surgeon.mjs：通过
- Node v22.22.2 `node --check _verify/management-security.test.mjs`：exit 0。
- Node v22.22.2 `node --test _verify/management-security.test.mjs`：21 tests，21 passed，0 failed（含 M-29b 与 M-33）。
- Node v22.22.2 对 5 个 shipped Host 文件 `--check`：均 exit 0。
- Full declared selftest command（pruner stub + wire refusal + management security）：39 tests，39 passed，0 failed。
- `_verify/packaging-smoke.mjs`：PASS，version=0.1.4，files=7，host-only=true。

selftest 中的既有 wire 测试只建立临时测试控制通道；日志中的 keeper 初始化不代表 AgentSoul 已启动。所有管理安全测试都使用 fake process/health/inspector/terminate，不调用真实 start/stop/restart。

## 未验证边界

- 未启动、停止或重启真实 D:/AI/agent-soul/build/AgentSoul.exe。
- 未验证真实 AgentSoul launcher/core 的完整身份检查链。源码链：bridge `spawn(AgentSoul.exe)` 返回 Shell child PID；`build/Shell.cs` 再 spawn Node core，设置 `AGENT_SOUL_PARENT=<Shell PID>`；health 返回 embedded Node PID，core lock 的 `pid` 是 Node PID。bridge 管理生命周期登记的对象 PID 是 Shell，不能拿 health 的 Node PID混作同一个 PID。Round 36 在 `Shell.cs` 加了**被动可选转发**：先从 Node 子进程 env 删除继承的 manager marker/PID，仅在上层显式提供合法 marker、期望 Shell PID 与当前 Shell PID相等时再传入；正常桌面启动仍 unmanaged。bridge 生产 spawn 目前尚未提供这些 env，core lock 没有 manager tuple 的真实启动样本；也没有 protected manager-proof API 供 inspector读取并对照 shell/core pid/time/path。因此 helper + Shell static contract 虽过 fake/static tests，真实 bridge→Shell→core proof chain 仍未接通；`identityAvailable=false`，start/stop/restart真实写操作保持不可用。
- 未连接真实 DSH webServer 管理端点，未验证真实浏览器 UI 的 POST token/nonce 注入；现有 client/UI 仍需后续按新管理协议传递受保护 credential 与 CSRF proof。
- 未做联网测试，未改 v4 control WebSocket、Host caps、hello、exec/result、state、events/service/agent/context 或重连水位边界。
- bridge 目录 `D:/AI/dsh-tools/dsh-agent-soul-bridge/.git/HEAD` 不存在（只检查精确 marker；同一探针下 `D:/AI/agent-soul/.git/HEAD` 存在）。因此该 bridge 副本无本地 Git metadata，不能从此目录声称提交/推送状态或做 git commit。
- 后续只读 capability 探查中，Host Inspect providers 只列 Service/Event/Config/Tool，无 process inspector。WindowsPowerShell 路径存在，但最小 `-NoProfile -NonInteractive -Command $PSVersionTable.PSVersion.ToString()` 5s `spawnSync` 超时、无输出。故尚不能断言 CIM/WMI 或别的 inspector 不可用；只是当前 Node subprocess route 这项探针未成功。identityAvailable 继续 false。

结论：管理端点安全层与 fake 验收已完成；生产 AgentSoul 进程身份适配仍是明确的 fail-closed 缺口，而不是被便利性掩盖的未验证成功。
