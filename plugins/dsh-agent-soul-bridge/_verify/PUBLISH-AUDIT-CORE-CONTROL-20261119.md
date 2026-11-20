# dsh-agent-soul-bridge 核心控制面发布审计

审计时间：2026-11-19
审计工作区：D:/AI/dsh-tools/dsh-agent-soul-bridge
审计方式：只读；未改源码、未 push、未联网、未安装、未重启。
审计对象：package.json、cordis.patch.yml、index.js、client.js、README.md，以及 _verify 下全部验证文件（含 .bak 历史证据）。

## 结论

**BLOCK：当前不具备发布/推送条件。**

阻塞不是因为 Host caps、协议回执或错误边界太多，这些是 AgentSoul v4 与 DSH 之间的核心控制面契约，不能删减来换取通过。当前阻塞来自四个独立问题：

1. Host 生效配置、DEFAULTS、README、测试断言没有同一套发布口径；当前 patch 明确保留 10 个 caps，但 pruner 仍应按未验能力保持 stub。
2. client.js 是真实浏览器 UI，却没有形成正确的包级 Client 契约：当前 package.json 既没有 dsh.client，也没有 exports[./client]。它不能被当作随 Host 包可达的 Client 半。
3. pruner 的适配器和回执边界已有离线、合成线上、独立源码复核，但生产桥挂载的真实 DSH 非生产会话能否拿到目标 pruner 实例仍未验；现有 live 测试不是生产宿主验收。
4. /agent-soul/start|stop|restart 是无额外鉴权的 GET；stop 使用 taskkill /IM <image> /F，存在跨来源触发与同镜像误杀风险。





Round94 rerun: executed the exact package.json scripts under Node v22.22.2 from package root: `npm run syntax` exit 0; `npm run selftest` 39 passed / 0 failed; `npm run packaging:smoke` PASS, version=0.1.4, files=7, host-only=true. No network/remote operation, install, DSH restart, real Host lifecycle, real AgentSoul process control, or browser/client UI was exercised. This closes the offline source/package validation check only. Publication remains BLOCK: no verifiable .git/HEAD or Git remote, no actual commit/push evidence, no DSH Cordis profile load, no real Host lifecycle test, client shape remains explicitly host-only, and pruner/huanqi remain truthful stubs.
## Round66 synthetic lifecycle probe supplement (2026-11-20)

Ran `node probe.mjs fake` under Node22.22.2 after confirming synthetic port 17310 was free. **PASS 17 / FAIL 0**: loopback fake ControlHub accepts bridge hello, sees all 10 declared caps, verifies the fake 482000 token watermark and `stubCaps=[huanqi,pruner]`, routes followup to the stub agent and returns source-kind receipt, refuses both stubs before dispatch, attaches per-turn state hook, stops/restarts fake server and observes automatic reconnect plus second hello. The probe closes its fake server; it does not contact production port 7310 or invoke management routes.

Limitations surfaced by the probe itself: the fake Cordis context intentionally has no `webServer`, so `拿不到 webServer 服务，/agent-soul/* 不会挂`; it has no `ctx.on()`, so session/event and immediate invalidation subscriptions are not present in this harness. Thus this is a protocol/lifecycle subset test, not a real Cordis load, not proof of production management endpoint reachability, not proof of all event/service/session capabilities, and not proof of restart/stop security. Production publish gate remains BLOCK until package identity/history is restored, running-patch configuration reconciled, management endpoint authorization/PID handling solved, Client product shape decided, and real-host validation completed.



## Round67 synthetic management-security regression (2026-11-20)

Ran only `node --test _verify/management-security.test.mjs` under Node22.22.2: **21 passed / 0 failed**, exit 0. The test uses fake request objects and fake health/spawn/inspect/terminate lifecycle functions; it does not call production management endpoints or start/stop a real AgentSoul process. Coverage includes exact GET/POST allowlists, origin/referer and local bearer validation, one-shot CSRF nonce, request body/size, exact PID identity, fail-closed identity mismatch, mutex/idempotent request ledger, restart stop-confirm-down-start, production lifecycle `identityAvailable:false`, and no image-wide taskkill. This is unit evidence for code paths only. It does not prove Cordis route mounting, actual webServer-origin integration, live PID inspection, bridge package/client reachability, or a real DSH load. Current publish status remains BLOCK.

## 当前事实基线

### 包与 Host

- package.json 当前版本是 0.1.4；main 和根 exports 指向 index.js；dsh.bundle.patch 指向 ./cordis.patch.yml。
- package.json 的 files 包含 index.js、ws.js、pruner-adapter.mjs、context-surgeon.mjs、probe.mjs、cordis.patch.yml、README.md；当前不包含 client.js。
- index.js 当前 VERSION 是 0.1.4，DEFAULTS.caps 为 10 项：followup、session、sessions、workspaces、agent、events、service、huanqi、pruner、context。
- index.js 当前 DEFAULTS 是 stubCaps=[huanqi,pruner]、prunerLive=false、agentSoulAutoStart=false；这与未验收状态一致。
- cordis.patch.yml 当前同样声明 10 个 caps、stubCaps=[huanqi,pruner]、prunerLive=false、agentSoulAutoStart=false。该 patch 会覆盖 DEFAULTS，是实际运行配置，必须作为发布单一真相的一部分验收。
- Host 入口保留 hello 自报能力、每个 exec 必回 result、state 水位不编造、错误 stage/脱敏、断线退避和事件/服务转发。这些不能因发布阻塞被删减。

### Client

- client.js 不是空壳：它注册 conversation.session.header.utilities，提供 status/probe/start/stop/restart UI，并声明 exports.inject=[slots]。
- 但 package.json 当前没有 dsh.client 声明，也没有 exports[./client]。因此文件存在不等于 Client 半会被拾取，当前不能宣称 UI 随包发布可达。
- README 当前标题和主体把包描述为 Host 端，未给出 Client 包是否发布、如何验 __DSH_BOOT__.entries 与 DOM 尺寸的明确契约。

### pruner / huanqi

- huanqi 仍是 stub；当前没有证据支持将其从 stubCaps 移除。
- pruner 的 Host cap 可以继续出现在 caps，但在真实能力验收完成前必须同时留在 stubCaps，并保持 prunerLive=false。这不是删除 Host 能力，而是诚实地区分能力名可识别和当前宿主可执行。
- pruner-adapter 只应负责请求校验、显式 session/seq/opId、目标 agent/pruner 解析、调用宿主 applyDrops 和翻译真实回执；不能在 bridge 内复制 surface 改写。
- _verify/pruner-eval/EVALUATION.md 记录的原始阻断仍有效：通用 toolResultPruner.pruneSession 是按字符预算整会话扫描，不接受 seq/opId；SurfaceOp 没有 remove/drop；已有 drop 层原本由 agent/pre-step 异步触发。
- 后续本地实现增加了同步 applyDrops 薄适配路径，合成测试能验证回执形状和幂等语义，但这没有证明 profile 根层的 bridge 在真实 DSH realm 中能拿到目标会话的 pruner 实例。

## 四类判定

### A · Host 调度核心：必须保留并验收

**判定：保留；不是删减发布阻塞，而是核心验收面。**

必须保留的内容：

- 10 个 Host caps：followup、session、sessions、workspaces、agent、events、service、huanqi、pruner、context。它们对应 v4 到 DSH 的会话投递、工作区注册、工具转发、事件回流、服务数据、上下文手术和清理能力；不能用缩减 caps 掩盖配置或测试问题。
- hello 的 caps/stubs 元数据。hub 会按 hello.meta.stubs 在派活前拒绝桩能力；这是防止未验能力被当成可执行能力的协议边界。
- 每个 exec 的 result 回执，包括 ok=false、结构化 stage、错误脱敏与限长、目标和 opId 校验，以及不伪造 framesAffected 的失败语义。
- state 上报的真实水位边界：读不到就 null 加 reason；surfaceTokens 不能冒充 contextTokens。
- events 的 session/event、handle/revoked、host/state、resumeFrom 补帧；service 的纯数据转发；agent 的 invoke 转发；这些是控制面的双向可观测性，不是可选装饰。
- reconnect/backoff、心跳、销毁 disposer、Host 端点 apply receipt。这些应该进入发布验收，而不是被绕开。

验收门槛：

1. 用真实 DSH/Cordis 装载当前包，确认 patch 覆盖后的 hello caps/stubs 与批准清单完全一致。
2. 对 followup/session/sessions/workspaces/agent/events/service/context 做至少一条成功和一条边界失败验证；记录原始 result/event 帧。
3. 对所有拒绝路径验证 result 必达、stage 可解析、凭据键值不出现在正文、失败不带成功数据字段。
4. 对断线重连、停止/更新/销毁验证没有悬挂 timer、路由或 ws。
5. 将这些结果纳入可复现 verify，不能只引用旧 README 的 PASS 数字。

### B · Client UI：独立包契约决策

**判定：必须先做产品决策；不能靠保留 client.js 假装两半都发布。**

推荐决策是：若这个包确实要提供顶部 agent-soul 控制面板，就把它明确做成 Host+Client 包：

- package.json 增加正确的 dsh.client 声明，声明 web 平台和 Client 入口；增加 exports[./client]，并把 client.js 纳入 files。
- 让 dsh.client 的注入声明与 client.js 的 exports.inject=[slots] 对齐；不能只写文件或只写 export。
- 在重启后的真实 DSH 中验 window.__DSH_BOOT__.entries 出现 dsh-agent-soul-bridge，再验按钮尺寸大于 0、status/probe 请求可达；Host running 不算 Client 成功。
- README 明确安装、重启、刷新时机、Client 入口图验收命令和 UI 依赖。

若产品决策是纯 Host，则应在一个独立且明确的拆包决策中排除 client.js，另建 dsh-agent-soul-bridge-client 或把 UI 移到明确的 Client 包；同时删除误导性的 Client 文件/export，不要让发布包带一个不可达半成品。

当前状态：**未决**。因此 B 单独阻塞，不应通过修改 Host caps 来掩盖。

### C · pruner/huanqi：实际能力与 stub/patch 语义

**判定：huanqi 明确 stub；pruner 仍是“有适配代码但未完成真实宿主验收”的 stub。**

当前正确语义：

- caps 表示 v4 能识别或询问该能力；stubCaps 表示当前 hello 不应把它当作可执行能力派发。
- patch 与 DEFAULTS 必须都保持 stubCaps 含 huanqi、pruner，prunerLive=false，直到真实非生产宿主验收通过。
- hub 在 stub 声明时提前拒绝是预期保护，不是 bridge 丢能力；绕过 hub 直发 exec 的测试也必须仍回 ok=false，且不得带 framesAffected 或成功 data。
- 真实开启 pruner 的条件不是源码有 applyDrops 或合成测试绿，而是：目标 session 明确、目标 agent 活跃、该 session 对应的 live pruner 可解析、回执来自宿主真实落盘、失败/重放/区间外不变均成立。

非生产宿主验证计划：

1. 建立独立 test profile/非生产 DSH 宿主，加载与生产相同的 bridge、patch 和 pruner 组合；不使用 lead 或生产 session。
2. 先保持 prunerLive=true 加 stubCaps，防止 hub 自动派活；由测试控制通道显式发一条合法 targeted-cleanup exec，验证 tried、目标实例解析和 bridge 到 pruner 可达性。
3. 用 dryRun 或等价只读预检锁定 1 至 2 个非生产 tool/result seq；再执行一次，要求 ok=true、targetSession/opId/startSeq/endSeq 原样、framesAffected 为整数、pointer 可回取，bytesAffected 不量出则不出现。
4. 复放同一 opId，要求幂等且不新增 append；给错 session、越界 seq、未知 action、目标不匹配、pruner 不可达，分别要求可解析 stage 和零写入。
5. 从真实 session surface/event 文件回读，确认区间外不变、门牌可由 v4 回取、重启后回执与幂等状态不伪造。
6. 只有以上通过，才同步 patch、DEFAULTS、README、测试断言，把 pruner 从 stubCaps 移除并开启 prunerLive。在此之前不得移除 stub。

### D · start/stop/restart：权限与误杀风险

**判定：当前阻塞。**

源码事实：

- start、stop、restart 均注册为 exact GET 路由，没有额外 token、origin、CSRF 或用户确认校验。
- stop 执行 taskkill /IM <plan.image> /F；默认镜像名来自 AgentSoul.exe，不是由本次 start 记录的 PID 精确绑定。
- restart 组合 stop 加 start；并发请求没有显示的互斥锁或 idempotency key。
- Client UI 的同源 fetch 能使正常面板使用方便，但同源不等于权限控制；只要同源页面或本地端口可访问，就可能触发破坏性动作。
- selftest/e2e-harness 避免调用 stop/restart，只证明测试没有主动杀进程，不证明生产管理面安全。

不降 Host 能力的精确限制方案：

1. 把 status、probe 作为只读端点；start、stop、restart 改成明确的管理动作入口，至少要求本机管理来源加受保护的短期管理授权，而不是无鉴权 GET。
2. 对请求方法做白名单：读操作可 GET；启停只接受带 body/nonce 的 POST，并校验 Origin/Referer 与一次性 CSRF token。若 DSH webServer 的认证能力不足，Host 端点应只绑定管理 loopback，或由已有受信管理服务代理。
3. stop 不再按镜像名全杀：start 时记录由 bridge 亲自 spawn 的 PID、root、exe、启动时间和唯一 instance marker；stop 只终止该记录且校验进程路径、父子关系和启动时间。无法精确识别时拒绝 stop，而不是扩大 kill 范围。
4. restart 使用 per-instance mutex 和 request id；stop 未确认 down 时不得 start，start 已有同一实例则返回 already；并发调用必须可重放且不产生第二实例。
5. 端点返回 accepted/started/stopped/already/denied 与 reason，记录审计事件但不回显 token；权限失败与进程不存在要可区分。
6. verify 必须覆盖跨来源请求、缺授权、错误 nonce、并发 start/stop/restart、同镜像旁路进程存在、PID 已复用、路径变化、停机超时和 keeper 交互。测试不得杀生产 AgentSoul，使用临时可执行 stub 或 test profile。

## 发布修复计划（不降 Host 能力）

### P0 · 先统一契约，禁止先改 Host 能力

- 以当前 package.json 0.1.4、10 caps、stubCaps=[huanqi,pruner]、prunerLive=false、agentSoulAutoStart=false 为暂定发布基线。
- 将 patch 与 DEFAULTS 的可覆盖字段抽成可校验的契约表或测试 fixture；测试解析 patch 后再断言实际生效配置，而不是只 import DEFAULTS。
- README 的 caps、stub、版本、package files、安装和验证命令全部改为当前基线；清除旧的 3-cap、pruner 默认关闭但 patch 开启、旧版本号叙述。保留历史评估报告，不把历史 PASS 当当前绿灯。
- 修正 package files、scripts 和验证入口：所有 README 引用的可发布文件必须在包内；packaging:smoke 当前引用 _verify/packaging-smoke.mjs，但该文件在本轮读取的工作区文件清单中不存在，必须补齐或删除该脚本声明。
- 每次发布前输出：包内容清单、解析后的实际 patch 配置、Host hello 快照、Client 入口图快照、全部 verify 结果和未验项。

### P1 · 明确 Client 包形态

- 由产品决定 Host+Client 单包或 Host/Client 拆包；不允许保持当前“有 UI 文件但无包入口声明”的第三种状态。
- Host+Client 方案按 B 节补 dsh.client、exports[./client]、files: client.js，并增加真实启动后 Client 可达验收。
- 拆包方案让核心包保持纯 Host，另包拥有自己的 package contract、Client inject、slot 验收和版本发布说明。

### P1 · 完成 D 管理权限护栏

- 先实现或确认本地管理面的认证、方法和 CSRF 语义，再保留 UI 调用；UI 只改变调用方式，不替代权限。
- 以 PID、路径和 instance marker 精确停止本实例，移除 image-wide taskkill 作为默认路径；无法精确停止时返回拒绝。
- 增加无副作用单元测试和临时进程集成测试，明确不触碰生产进程。

### P2 · 用非生产宿主验 pruner，再决定是否升级语义

- 按 C 节步骤复现真实 realm 可达性和真实 session 落盘；记录原始回执与 session 读回证据。
- 验收前维持 stub；验收后一次性同步 patch、DEFAULTS、README、tests，避免只改 index.js 再被 patch 覆盖。
- huanqi 单独保持 stub，不能因为 pruner 通过而连带升级。

## Verify 覆盖与可信度

本轮已读取 _verify 下全部文件，包括：

- pruner-eval：纯函数桩断言、绕过 hub 的线上拒绝断言、EVALUATION.md。
- pruner-sync：adapter 测试与 NOTES。
- pruner-sync-independent：独立 bridge、live wire、resolve probe、REPORT 及 .bak 历史文件。
- pruner-sync-fix：stage 回传、脱敏、桩态、超时和错误映射测试。
- apply-harness、cordis-harness、e2e-harness、selftest。
- 旧的 PUBLISH-AUDIT-20261119.md。

这些 verify 能证明：请求校验、stub 拒绝、合成 pruner 回执、stage/脱敏/幂等边界和部分 Cordis 注册逻辑；不能证明：

- 当前 package 发布后 Client 入口可达；
- 当前 patch 覆盖后的生产配置已被同一套测试验证；
- 生产 bridge 在真实 DSH realm 取得目标 pruner；
- 真实 DSH Session 的持久化和事件回读；
- 管理端点的授权、CSRF、PID 精确停止和误杀隔离。

另外，_verify 下若干报告是历史记录，且存在互相矛盾的旧数字（例如旧报告写 0.1.0/0.1.3、旧 3-cap 与当前 0.1.4/10-cap）。它们应保留为历史证据，但发布门禁必须以本报告的当前文件事实和重新执行的验证为准。

## 最终门禁

在 P0 至 P2 完成前，结论保持 **BLOCK**。不得通过删除 caps、缩短 result/error 边界、把 stub 改成假成功、或把管理端点从测试里排除来解决阻塞。

审计报告本身是本轮唯一新增产物；未修改旧报告、源码、patch、package 或验证脚本。
