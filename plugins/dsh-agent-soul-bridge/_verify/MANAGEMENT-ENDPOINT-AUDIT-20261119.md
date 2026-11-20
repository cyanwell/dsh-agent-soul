# 管理端点只读审计

审计日期：2026-11-19
审计轮次：第十四轮
工作区：D:/AI/dsh-tools/dsh-agent-soul-bridge

## 审计边界

本轮只读检查 index.js 的管理路由、webServer 注入、AgentSoul spawn/stop/keeper 实现，README.md、client.js、cordis.patch.yml 以及 _verify 下与 Cordis 和端点相关的测试。未修改源码、package.json、patch、README 或既有测试；未联网、未安装、未重启、未调用管理端点。唯一新增文件是本报告。

结论只描述当前代码事实；后面的修复设计不是本轮实现。

## 证据基线

- Host 插件导出 inject = ['webServer']（index.js:49-51），并在 apply 中通过 cx.inject(['webServer'], ...) 获取服务（index.js:1195-1203）。
- 路由通过 wsv.register({ kind: 'exact', path, handler }) 注册（index.js:1353-1361）。注册描述没有 method 字段；handler 形参为 (_q, s)，不读取请求 method、headers、origin、referer、cookie 或 CSRF 值（index.js:1373-1406）。因此从 bridge 源码本身无法证明只有 GET 会被接受；当前 client 和测试按 GET 使用，是调用约定，不是 Host 侧安全强制。
- webServer origin 仅用于向 agent-soul v4 的 hello 宣布 DSH 地址（index.js:1204-1227），没有用于管理请求的来源校验。
- v4 的 X-Soul-Token 只在 bridge 向 /api/session、/api/health 等内部 API 发请求时读取并发送（index.js:1242-1257、1405-1436）；它不是管理端点的入站鉴权。
- README 明确写出本版本没有修改启停行为，且后续仍需受信来源、CSRF、PID 精确绑定、并发启停和误杀边界设计（README.md:64-68）。

## 逐路由审计

| 路由 | 当前 HTTP method | 来源 | 入站鉴权 | CSRF | PID/path/startTime/instance marker | 并发 mutex/request id | 误杀风险 | 当前测试覆盖 |
|---|---|---|---|---|---|---|---|---|
| /agent-soul/status | 路由未声明 method；client/测试按 GET 调用 | DSH Host webServer exact route；浏览器 client 同源 fetch | 无 | 无 | 返回 v4 health.pid 与配置 plan.root/exe；无 startTime、无 instance marker | 无 request id；只读采样无启停锁 | 不直接杀进程；可能显示 v4 health 与 bridge 目标不一致 | selftest 200/JSON、字段检查；e2e 调用；未测方法/来源/鉴权 |
| /agent-soul/start | 路由未声明 method；client/测试按 GET 调用 | 同上 | 无 | 无 | spawn 返回 child.pid；使用配置 root 与 root/build/AgentSoul.exe；不记录 PID、startTime、marker | 无 mutex、无 request id；先 health 再 spawn 的检查与 spawn 非原子 | 并发 start 可在两个请求同时看到 down 后各自 spawn；keeper 也可同时 probe/spawn | selftest 调 start，在线时期望 already；spawnAgentSoul 错路径单测；e2e 调 start；未测并发、旁路进程或权限 |
| /agent-soul/stop | 路由未声明 method；client/测试按 GET 调用 | 同上 | 无 | 无 | 不使用 health.pid，也不使用 start 返回的 PID；按 plan.image 选择镜像名 | 无 mutex、无 request id；doStop 只包住 taskkill/wait | 高：taskkill /IM <image> /F 终止同镜像全部进程，不校验路径、父子关系、启动时间或实例归属 | 只验证路由注册；selftest/e2e 明确不调用，避免真杀 AgentSoul；没有安全行为测试 |
| /agent-soul/restart | 路由未声明 method；client 按 GET 调用 | 同上 | 无 | 无 | 继承 stop 的镜像级 kill；start 新 spawn 返回 child.pid，但不形成实例绑定 | 无 mutex、无 request id；无 stop 成功门槛，先 stop 后无条件 start | 高：先可能杀掉其他同镜像进程，再可能启动第二实例；stop 失败或仍存活时仍继续 start | 只验证路由注册；selftest/e2e 不调用；没有原子重启、失败回滚或并发测试 |
| /agent-soul/probe | 路由未声明 method；client/测试按 GET 调用 | 同上 | 无管理端点鉴权；它向 v4 内部 /api/session 使用 X-Soul-Token | 无 | 只读返回 health/control/bridge/caps 检查；不返回管理实例 marker | 无 request id；只读探测本身没有启停互斥 | 不直接杀进程；会触发健康采样与内部 API 读取 | selftest 检查四步骤；e2e 调用；未测方法/来源/鉴权/CSRF |

### 路由共同事实

五条路由都由同一个 route helper 以 kind: exact 注册（index.js:1353-1361）。helper 没有把 method、来源、认证策略或 CSRF 策略传给 webServer。五个 handler 的第一个请求参数统一命名为 _q 且未读取，因此当前 bridge 没有按 method 或请求元数据做拒绝。

client.js 的 call 是无 method 的 fetch(path, { cache: no-store })，浏览器默认产生 GET（client.js:111-116）；它只证明现有 UI 的调用方式，不构成权限边界。client 的 status 轮询也是无鉴权同源 GET（client.js:80-90）。README 目前把 client.js 明确排除在发布包之外，但管理端点仍在 Host 中注册。

## spawn、stop、keeper 细节

### spawn

agentSoulPlan 从配置取 root，拼出 <root>/build/AgentSoul.exe，并以 exe 文件名得到 image（index.js:1119-1129）。spawnAgentSoul 仅检查路径存在，然后使用 spawn(p.exe, [], { cwd: p.root, detached: true, stdio: ignore, windowsHide: true })，unref 后返回 child.pid（index.js:1132-1148）。它没有写 PID 文件或状态记录，没有启动时间快照，没有随机 instance marker，也没有校验 child.pid 对应的真实路径。

### stop

killAll 动态导入 execFileSync 并执行 taskkill /IM plan.image /F（index.js:1306-1311）。doStop 随后最多等待 5 秒，并用 v4 health 判断是否 down；最终返回 killed、down、stillAlive、health（index.js:1324-1331、1346-1351）。返回的 down 只表示 health 不再应答，不证明被杀的是 bridge 自己启动的实例。

### restart

restart 直接 await doStop(); await doStart()，没有在 stop 未确认 down 时中止，也没有 request id、幂等键或恢复策略（index.js:1394-1398）。

### keeper

keeper 使用全局 Symbol 防止同一进程重复创建 keeper（index.js:3147-3156），每 30 秒探测一次 7310 health；连续两次无应答、超过 spawn gap 且开启 autoStart 才调用同一个 spawnAgentSoul（index.js:3164-3197）。这个全局对象不是管理请求 mutex：它不与 doStart、doStop 共享锁，也不记录或验证实例 PID。当前配置和 patch 都是 agentSoulAutoStart: false，但后续启用时，keeper 与手动 start 的竞态仍需单独防护。

## 来源、认证与 CSRF 判定

1. 来源：代码只保证路由挂在 DSH 的 webServer 上，并缓存形如 http://127.0.0.1:<port> 的 origin 用于 hello。没有比较入站 Origin 或 Referer，也没有固定管理来源 allowlist。不能把同源 UI 当成只有 UI 能调用。
2. 鉴权：没有入站 bearer、token、session 校验。readToken 读取的是 agent-soul 本体的 token 文件，作用是 bridge 作为客户端访问 v4 API；status、start、stop、restart、probe handler 不读取浏览器提供的凭据。probe 的内部 X-Soul-Token 不保护外层管理路由。
3. CSRF：没有 nonce、CSRF token、Origin 或 Referer 校验，也没有 SameSite cookie 约束可依赖。特别是 start、stop、restart 当前按 GET 调用，若管理 webServer 可被浏览器访问，破坏性动作具有 GET 或跨站触发风险。
4. 路径与 PID：配置路径只用于 spawn 和展示；stop 没有使用 health.pid 或 spawn 返回的 child.pid。startTime 与唯一 instance marker 在当前实现不存在。

## 当前测试覆盖与空白

已读测试给出的真实覆盖：

- _verify/selftest.mjs:47-70 验证真 Cordis apply 不抛、5 路由注册、status/probe 响应、start 在线时 already、agentSoulPlan 与错误路径的 spawnAgentSoul。
- _verify/e2e-harness.mjs:1-6、47-56 调 status/probe/start；stop/restart 只记录“故意不调：会真杀 AgentSoul.exe”。
- _verify/cordis-harness.mjs 与 _verify/apply-harness.mjs 主要验证真实 Cordis 注入、apply 不抛、五条路由和 disposer/receipt 路径；没有验证管理安全属性。
- pruner 相关测试覆盖的是控制通道回执、stub、stage、脱敏和真实 pruner 适配，不覆盖这五个 HTTP 管理端点。

明确没有覆盖的安全断言：请求 method 白名单；Origin 或 Referer；认证缺失或错误 token；CSRF；跨站触发；PID 精确绑定；路径、父子关系、startTime、instance marker；同镜像旁路进程；PID 复用；并发 start、stop、restart；keeper 与手动动作竞态；stop 超时后的 restart 行为；审计 request id。

## 最小安全修复设计（保留 Host 调度）

本节只给设计，不在本轮改实现。

### 1. 端点与方法

- status、probe 保留只读 GET；明确拒绝其他 method。它们可以继续由 Client 面板轮询，但仍应走同一套本地管理认证或来源策略，至少不能把只读误读成无边界。
- start、stop、restart 改为 POST；拒绝 GET、HEAD 等会产生副作用的调用。请求 body 至少包含一次性 request id 或 nonce，避免浏览器预取或跨站简单请求直接触发。
- Client 后续应改为对应 POST，并携带受保护的管理授权和 CSRF proof；UI 调用不是授权本身。

### 2. local admin auth 与来源

最小可行边界是本地管理面加明确授权，而不是只检查同源：

- 管理路由只允许 loopback webServer；拒绝非 loopback 绑定或把它标成不可用。若 webServer 本身可能被同源页面共享，加入独立 local-admin secret 或 token，存放在受限本地配置，不回显、不写普通 receipt。
- 入站校验管理授权；status、probe 可使用只读 scope，start、stop、restart 要求 admin scope。认证失败返回 401 或 403，不进入 health、spawn、kill。
- 对浏览器调用校验精确 Origin allowlist（当前实际 DSH origin），并校验 Referer 作为辅助信号；不要把 Referer 当唯一认证。
- 对有 cookie 或 session 的管理面增加 CSRF token；对 POST 要求自定义 header 或 nonce，使跨站表单不能满足校验。无 cookie 的 bearer 模式仍建议保留 Origin 校验，避免把本地网页访问能力误当作用户授权。

### 3. 精确实例身份与停止

- start 成功后建立受保护的 instance record：{ instanceId, pid, exeRealPath, rootRealPath, startedAt, marker, owner: bridge }。
- marker 应在 bridge 可验证的启动参数、受保护 sidecar 或 lock、或子进程关系中体现；不能只用 image 名。若 AgentSoul.exe 不支持 marker 参数，首选由 bridge 维护受保护的 PID、启动时间、realpath 记录，并在 stop 前重新核验所有字段；核验不通过就拒绝。
- stop 只允许终止 record 指向的 PID，并重新读取 PID 的 executable path、creation 或 start time、父子关系及 marker。PID 不存在视为 already-down；PID 已复用、路径变化、marker 缺失、记录不一致都返回 denied 或 identity-mismatch，绝不能扩大为 taskkill /IM。
- 移除 image-wide taskkill 作为默认路径。无法精确识别实例时宁可不杀，并把原因返回和记录。
- start 的 already 判定也应优先读取并校验受管 instance record；仅凭 v4 health.ok 不能证明那是 bridge 启动的实例。

### 4. mutex、request id 与 keeper 协调

- 为每个 instance 建单一异步 mutex，start、stop、restart、keeper spawn 共用；所有路径在锁内重新读取实例状态。
- request id 由调用者提供并由服务校验格式；服务返回相同 request id，短期保存已完成结果，重复请求返回同一结果而不重复 spawn 或 kill。不能把 request id 当认证。
- restart 必须是一个锁内状态机：确认目标实例身份，stop，确认 down，start，确认新实例 identity；stop 未确认 down 时禁止 start，返回 partial 或 timeout，不做无条件补拉。
- keeper 的定时 probe 继续保留，但只通过同一 start 状态机；手动 stop 若要阻止 keeper 立即复活，应记录带过期时间的 operator-suppressed 状态，或由明确的 stop policy 控制，而不是依靠时间竞态。

### 5. 返回与审计

- 明确返回 accepted、started、stopped、already、denied、timeout 等状态；不要把 health down 当成已杀对实例。
- 返回可安全展示的 instanceId、pid、realpath 摘要、startedAt 和 requestId；绝不回显 admin token、X-Soul-Token 或 token 文件内容。
- 记录结构化审计事件：requestId、route、method、source 或 origin 判定、actor scope、target instanceId、结果、reason、时间。记录应脱敏，且不能把 token 放入 receipt。

### 6. 必须新增的安全测试门

不在本轮实现，但后续验收至少要有：

1. GET status/probe 成功；非允许 method 失败；start、stop、restart 的 GET 失败。
2. 缺 token、错误 token、只读 scope 调写操作分别得到 401 或 403；允许 Origin 与跨来源 Origin 分开验证。
3. 缺 CSRF、错误 nonce、重复 nonce、跨站表单或简单请求均不触发 spawn 或 stop。
4. 并发 start 只产生一个 PID；并发 stop、restart 不交叉；重复 request id 幂等。
5. 同镜像旁路进程存在时 stop 只影响受管 PID；PID 复用、路径变化、startTime 不匹配、marker 缺失时拒绝。
6. stop 超时不进入 start；keeper 与手动 stop 或 start 共享锁并有可见结果。
7. 使用临时 stub executable 或 test profile，不调用生产 AgentSoul.exe；测试回读实际进程与审计事件。

## 本轮判定

管理端点当前可作为本地面板的便利入口，但不能被描述为已完成安全管理面。最严重问题是：破坏性动作使用无入站鉴权的 GET，stop 使用 image-wide taskkill /IM ... /F，且没有 PID、path、startTime、instance marker、mutex 或 request id。status、probe 的只读性质降低副作用，但不等于已经有来源和认证边界。

最小修复方向是：status、probe 只读 GET 加明确 method 白名单；start、stop、restart 改 POST 加 local admin auth 加 Origin 或 CSRF；所有启停共用精确实例记录、PID、path、startTime、marker 校验和 mutex、request id；无法精确识别时拒绝，不回退到镜像名全杀。Host 调度 caps、WS 控制通道和 Cordis 注入不需要因管理端点加固而削弱。
