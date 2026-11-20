# 管理端点安全修复设计

- 设计日期：2026-11-19
- 修复轮次：第十五轮
- 工作区：D:/AI/dsh-tools/dsh-agent-soul-bridge
- 范围：仅 bridge 管理端点 status、start、stop、restart、probe
- 保留：AgentSoul v4 Host caps、control WebSocket 协议、hello、exec/result 回执、state 上报、Host 调度及既有业务能力
- 本轮状态：仅读审计、Cordis API 确认与设计落盘；未改源码、未调用管理端点、未启动/停止/重启 AgentSoul、未联网

## 一、已确认事实

### Cordis webServer exact route API

已读取当前 DSH 安装中的 Cordis 类型目录。WebRoute 的声明只有：

- kind: WebRouteKind
- path: string
- handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>

WebRouteKind 只有 exact 和 prefix。register 的签名是 register(route: WebRoute): () => void。由此确认：exact route 注册描述不支持 method、methods 或 allowedMethods 字段；不能猜测或添加这些字段来实现 HTTP method 白名单。

正确做法是继续注册 { kind: 'exact', path, handler }，在 handler 第一层读取 req.method 并拒绝不允许的方法。当前 index.js 的 route helper 和五个 handler 没有传入或读取 method、headers、Origin、Referer、认证或 CSRF，这只是当前安全缺口，不是 Cordis 限制 GET/POST 的证据。

当前 stop 使用 taskkill /IM image /F，可能终止同镜像旁路进程；start、stop、restart 没有共享 mutex、instance record 或 request-id 幂等；restart 在 stop 未确认 down 时仍继续 start；keeper 也没有与手动生命周期操作共用锁。

## 二、最小可实现方案

### 1. 路由与 method

保留五个 path 和 exact 注册形状：

| 路由 | 允许 method | 失败响应 | 权限 |
|---|---|---|---|
| /agent-soul/status | GET | 其他方法 405，Allow: GET | local admin read |
| /agent-soul/probe | GET | 其他方法 405，Allow: GET | local admin read |
| /agent-soul/start | POST | 其他方法 405，Allow: POST | local admin write |
| /agent-soul/stop | POST | 其他方法 405，Allow: POST | local admin write |
| /agent-soul/restart | POST | 其他方法 405，Allow: POST | local admin write |

status/probe 保留 GET 和只读健康采样，但只读不等于无边界，仍经过 loopback、exact Origin 和 local admin auth。start、stop、restart 改为 POST；拒绝 GET、HEAD、PUT、DELETE、OPTIONS 等。

### 2. local admin auth、exact Origin、CSRF

管理 credential 必须独立于 v4 的 X-Soul-Token。后者仍只用于 bridge 访问 AgentSoul 的 /api/*，不作为管理端点入站凭据，也不回显。

最小入站策略：

1. 只接受 loopback 对端：127.0.0.1、::1 及规范化的 IPv4-mapped IPv6；非 loopback fail-closed。
2. 要求 Authorization: Bearer <local-admin-token>。token 从受限本地配置或受限 secret file 读取；缺少配置时管理面拒绝，不自动暴露新 token。比较使用常量时间比较。认证失败返回 401，不调用 health、spawn、terminate。
3. Origin 必须与 webServer.getOrigin() 捕获的完整字符串精确相等，包含 scheme、host、port；不接受 null、缺失、前缀匹配或任意 localhost 变体。错误来源返回 403。
4. 若存在 Referer，要求其 origin 也精确匹配；Referer 只能辅助校验，不能代替 Origin 或 bearer auth。
5. POST 要求独立的 X-DSH-CSRF nonce。nonce 由 bridge 进程随机生成并保存在进程内，或来自受保护配置；不通过 status/probe 返回。缺少、错误、重放 nonce 返回 403。
6. POST 只接受小型 JSON body，限制例如 16 KiB；必须包含 requestId。拒绝 form-urlencoded、text/plain、非法 JSON 和超长 body。不要增加任意来源 CORS。

校验顺序固定为 method、loopback、exact Origin/Referer、local admin auth、POST CSRF/body/requestId、幂等查找、业务操作。任何失败不能进入 v4 health、spawn 或 kill 路径。

### 3. instance record

按 AgentSoul root 的 canonical realpath 维护唯一受管实例记录，字段固定为：

{ instanceId, pid, realpath, startedAt, marker }

instanceId 和 marker 每次 start 随机生成。realpath 是启动 exe canonicalize 后的路径。startedAt 必须来自进程实际 creation/start time；Date.now() 只能作为 spawnedAt 审计时间，不能替代进程启动时间。

marker 必须可重新验证为目标进程身份。优先使用 AgentSoul 支持的启动参数、受保护 sidecar/lock 或 IPC marker，并能用只读检查读取。若 AgentSoul 当前不能提供可验证 marker，则安全方案不得宣称 stop 可用，不得退回 image-wide kill；start 可以返回 identity-verification-unavailable 或保持 pending。

start spawn 后先登记 pending，不报告 started。只有 waitUp 后确认 health.pid、PID 的 executable realpath、creation/start time 和 marker 全部一致，才提交 active record。health 只能作交叉证据，不能单独建立实例归属。

### 4. stop 精确 PID 身份校验

stop 必须在共享 mutex 内重新读取 record 和实时状态：

1. 没有 record 时只能在实时确认 down 后返回 already-down，不能猜同镜像进程。
2. PID 不存在时返回 already-down 并清理 stale record，不执行 kill。
3. 读取 PID 的 executable path，canonical realpath 必须等于 record.realpath。
4. 读取 PID creation/start time，必须与 record.startedAt 在系统精度误差内一致，否则视为 PID reuse。
5. 读取 marker，必须等于 record.marker；缺失、不可读或不等均拒绝。
6. 可用时交叉确认 health.pid 等于 record.pid，但不能以 health.pid 替代其他身份字段。

全部匹配后才允许按单一 PID 终止。禁止 taskkill /IM 作为默认或 fallback。path、startTime、marker 任一不匹配都返回 identity-mismatch/denied，旁路同镜像进程保持不动。终止后重新检查 PID、marker 和 health；只有明确 down 才返回 stopped。health 无应答本身不能描述为已杀对实例。

### 5. 共享 start、stop、restart、keeper mutex

建立按 canonical root 复用的模块级或 global Symbol registry：

controlState = { mutex, instanceRecord, pendingRequests, recentResults, keeperSuppressedUntil }

start、stop、restart 以及 keeper 的实际 spawn/terminate 决定全部走同一异步 mutex。锁内必须重新读取 record 和实时 health，不能使用锁外快照。keeper 的周期 probe 可在锁外运行，但发现需要拉起后必须进同一把锁并二次确认仍 down、autoStart 仍开启、没有 operator suppression。

手动 stop 在 autoStart 开启时设置带过期时间的 keeperSuppressedUntil，避免刚 stop 就被 keeper 复活；当前 cordis.patch.yml 的 agentSoulAutoStart: false 保持不变。mutex 只覆盖生命周期，不包住 control WebSocket、v4 exec/result、state 或 Host cap 调度，因此不会改变 v4 调度和回执时序。

### 6. request id 幂等

POST requestId 是幂等键，不是认证凭据：

- ASCII，长度 1 至 128，只允许 A-Z、a-z、0-9、点、下划线、冒号、短横线。
- 以 route + requestId 查 in-flight 和 recent results。相同 route、相同 id、相同请求语义的并发请求等待并返回同一结果，只执行一次 spawn/terminate。
- 相同 id 用于不同 route 或不同 body 语义时返回 409 request-id-conflict，不执行第二次操作。
- 已完成脱敏结果保留短 TTL，例如 10 分钟、最多 256 条 LRU；重放返回相同 requestId 和 replayed: true。
- 不缓存 Authorization、CSRF、X-Soul-Token、原始 body 或凭据。requestId 可进入审计事件。

### 7. restart 状态机

restart 必须在同一 mutex 内按以下顺序执行：

1. validate-request：method、loopback、Origin、auth、CSRF、body、requestId 全通过。
2. capture-target：读取受管 record；health up 但没有可验证 identity 时拒绝。
3. stop：按精确 PID 身份校验终止。
4. confirm-down：重复读取目标 PID、health 和状态，必须明确 down。
5. start：仅在 confirm-down 成功后 spawn，生成全新的 instanceId、startedAt、marker。
6. confirm-new-instance：确认新 PID、realpath、startTime、marker、health.pid 一致后提交新 record。
7. 返回 restarted；任何失败都返回 phase、reason、started: false，绝不无条件补拉。

stop 超时、仍存活、identity mismatch 或 unknown 都直接结束 restart；不能进入 start。keeper 不能旁路触发 restart 的 start。

## 三、不影响 v4 Host 调度的边界

- 保留源码和 patch 中全部 10 个 caps、stubCaps、prunerLive=false，不删 Host capability。
- 不改 control WebSocket 的 connect/reconnect、hello、exec/result 回执、state、events、service 或其他转发器。
- 保留五个管理 path 和 webServer 注入；route descriptor 继续严格只有 kind、path、handler。
- 管理 auth token 与 v4 X-Soul-Token 分离；不把入站 admin credential 发送给 AgentSoul。
- status/probe 继续使用现有 health、overview、session 检查，只在入口加 gate；不把管理 mutex 放进 WS 消息处理。
- keeper 仍是可选守护路径，当前 autoStart 配置不改变；仅让它复用生命周期状态机。
- Cordis effect/disposer 仍负责 route 回收；状态 registry 只清理本实例引用，不关闭其他 fiber 的 WS。

## 四、测试矩阵

测试全部使用 fake webServer、fake request/response、临时 stub executable、fake process inspector 和 fake health；不调用生产 AgentSoul.exe，不调用真实管理端点，不启动/停止/重启 DSH。

| ID | 类别 | 场景 | 期望 |
|---|---|---|---|
| M-01 | route | 五条注册 | 全部 exact；descriptor 只有 kind/path/handler；无 method 自定义字段；disposer 正常 |
| M-02 | method | status/probe GET | 200 JSON，进入只读采样 |
| M-03 | method | status/probe POST/PUT/DELETE/HEAD/OPTIONS | 405、Allow GET；不采样副作用 |
| M-04 | method | start/stop/restart POST | 进入 auth/body gate；未授权不 spawn/terminate |
| M-05 | method | 写路由 GET/HEAD/PUT/DELETE/OPTIONS | 405、Allow POST；spawn/terminate 计数为 0 |
| M-06 | origin | exact Origin | 继续 auth；完整 scheme/host/port 精确比较 |
| M-07 | origin | 缺失、null、错误端口、错误 scheme、前缀或其他 host | 403；业务调用计数为 0 |
| M-08 | auth | 缺 token、错误 token、错误 scheme | 401；不进入业务 |
| M-09 | auth | 正确 local token 与混用 X-Soul-Token | 仅 local token 通过；任何 secret 不出响应/receipt |
| M-10 | csrf | 缺、错、重放、过期 CSRF nonce | 403；不执行 |
| M-11 | body | 非 JSON、超长、缺/非法 requestId | 400 或 413；不执行 |
| M-12 | instance | start 成功 | record 含 instanceId/pid/realpath/startedAt/marker；全部核验后才 active |
| M-13 | instance | start 超时、health pid 不一致、marker 不可验证 | unknown 或 identity-verification-unavailable；不宣称 started |
| M-14 | stop | path/time/marker 全匹配 | 只终止受管 PID；旁路同镜像 PID 不受影响；确认 down 后 stopped |
| M-15 | stop | PID 已不存在 | already-down；清理 stale；不 image-wide kill |
| M-16 | stop | path 不匹配 | identity-mismatch/denied；不 kill |
| M-17 | stop | startTime 不匹配 | PID reuse 拒绝；不 kill |
| M-18 | stop | marker 缺失/不匹配 | denied；不 kill；不 fallback |
| M-19 | mutex | 并发 start | 最多一次 spawn；其余复用同一结果 |
| M-20 | mutex | 并发 stop | 最多一次 PID terminate；其余复用同一结果 |
| M-21 | mutex | keeper 与手动 start | 共享锁和二次检查；最多一个 spawn |
| M-22 | mutex | keeper 与手动 stop | 不交叉复活；suppressed TTL 可见；默认 autoStart=false 不变 |
| M-23 | idempotency | 同 route/id 并发 | 单一 in-flight 操作，返回同一结果 |
| M-24 | idempotency | 同 route/id 重放 | 返回脱敏缓存结果，replayed=true，不重复副作用 |
| M-25 | idempotency | 跨 route 或 body 冲突 | 409；不执行第二操作 |
| M-26 | restart | 正常重启 | stop、确认 down、再 start；新 instanceId/marker |
| M-27 | restart | stop 超时或仍 alive | timeout/partial，started=false，spawn=0 |
| M-28 | restart | stop identity mismatch | 拒绝；不 start；旁路不受影响 |
| M-29 | restart | 新实例身份不一致 | 不宣称 restarted；保留 phase/reason |
| M-30 | v4 回归 | caps、hello、exec/result、state | 现有 Host 协议和回执不变；WS 不受管理 mutex 影响 |
| M-31 | lifecycle | apply/disposer | 五路由注册/回收；registry 清理；WS disposer 不被误伤 |
| M-32 | 生产保护 | 静态与 fake subprocess 审计 | 不调用生产 stop/restart，不启动 AgentSoul.exe，不出现 taskkill /IM |

## 五、实现顺序与验收门

1. 先写 method、loopback、Origin、auth、CSRF、body、requestId 纯函数和脱敏错误测试。
2. 再接入 handler，并更新 fake webServer fixture；断言 Cordis route descriptor 不增加 method 字段。
3. 抽出 process inspector 和 instance record；先覆盖 path/startTime/marker/ PID reuse 拒绝，无法验证 marker 时保持 fail-closed。
4. 加按 root 的共享 mutex 和 request-id cache，让 keeper 与手动操作走统一状态机。
5. 最后实现 restart 的 stop-confirm-down-start，并证明任何 stop 未确认 down 分支都不调用 spawn。
6. 运行 syntax、纯测试、Cordis apply/disposer、Host caps/WS 回归；真实生产 e2e 只保留读路径并显式跳过 stop/restart。

验收必须同时满足：route contract 仍为 kind/path/handler；读写 method 白名单生效；local auth、exact Origin、POST CSRF 和 requestId 生效；stop 任一身份字段不匹配即拒绝且绝不 image-wide kill；四条生命周期路径共用 mutex；restart 仅在明确 down 后 start；caps、协议、回执和 Host 调度无删改。

## 六、本轮判定

最小修复不是给 webServer.register 猜 method 字段，而是在 handler 内建立 method/auth/Origin/CSRF gate，再把启停收束到 instance record、PID 身份校验、共享 mutex、request-id 幂等和 restart 状态机。若 AgentSoul 当前无法提供可验证 marker，应拒绝 stop，不得为了保留便利性退回按镜像全杀。该取舍只收紧管理端点，不影响 v4 Host 调度和控制协议。
