# bridge 真实生命周期：**已跑通**（2026-11-20 21:2x 复核更新）

## 一句话（改写：缺口已闭合）

**三条半边已经在生产上跑通并实测通过。** 之前卡住的那一环（壳不认识 manager 协议）是**旧二进制**的问题 ——
`build\Shell.cs` 早就改对了，只是没重编。2026-11-20 21:03 用 `build\build.ps1` 重编后，
把新壳换上、带 marker 启动，`/api/manager-proof` 回 200，inspect 三向全通。

| 时间 | 动作 | 结果 |
|---|---|---|
| 21:03 | `build.ps1` 重编 | 152,064 B，sha256 `B58708B1…586AD`，旧壳备份到 `data\_backup\exe\20261120-210345\` |
| 21:04 | UTF-16 逐字节复扫 | 新壳 **marker=True shellPid=True**；旧壳（133,632 B）**全 False** |
| 21:05 | 换壳 + 带 marker 启动 | core pid 11340；`/api/manager-proof` **200**，identity={corePid:11340, shellPid:20788, startedAt, markerHash:dd17e55e…a499} |
| 21:20 | `_verify/inspect-live.mjs` 三向 | **正向 ok:true**；坏 marker → `proof-marker-mismatch`；错 pid → `process-path-mismatch` |

---

## 一、这次真的做了什么（不是又加一层判断）

`lifecycle-inspect.mjs` + `index.js` 接线：

| 半边 | 实现 | 拿不到时的行为 |
|---|---|---|
| ① 进程本体 | `process-inspector.mjs` 走 PowerShell CIM 查 ProcessId/ParentProcessId/ExecutablePath/CreationDate，路径 realpath 归一 | `process-not-found` / `process-path-mismatch` / `process-metadata-incomplete` |
| ② 管理器证明 | `manager-proof-client.mjs` GET `/api/manager-proof`（打 X-Soul-Token，只认 loopback），core 只在**被这枚 marker 拉起**时才在 core.lock 里写 manager 段 | `proof-unavailable` / `proof-pid-mismatch` / `proof-marker-mismatch` |
| ③ 三者对齐 | sha256(marker) 与 proof 里的 markerHash 逐字节比、pid 与 /api/health 的 core pid 必须相等 | `proof-marker-mismatch` |

`makeAgentSoulLifecycle` 原来写死 `identityAvailable: false` + `inspect: async () => ({ ok:false, ... })`，
现在换成真的 `inspect`。**但仍然 fail-closed**：核不通就不许 start/stop/restart。

---

## 二、实测（现场证据）

### 1. 带 marker 启动生产壳

```
$env:AGENT_SOUL_MANAGER_MARKER = <48 chars base64url-safe>
Start-Process "C:\Users\pc\Desktop\deepseek harness\agent soul\AgentSoul.exe"
```

结果：壳进程起来了（pid 14316，标题「AgentSoul — 启动失败」），core 进程 27728 在健康检查完成前退出。

`%LOCALAPPDATA%\AgentSoul\core.log` 尾部一行，原文：

```
[20:54:14.208] [1750 ms] [err]   bridge 启动身份拒绝：manager-shell-pid-invalid
```

壳自己日志（`shell.log`）：

```
[20:54:14.965] health: 判定=core-exit（启动后 2507 ms，尝试 0 次）
[20:54:14.973] error: core 启动失败（进程已退出，退出码 12）
```

退出码 12 + `manager-shell-pid-invalid` = core 的 `readLaunchIdentity()` 看到了 marker、但
`AGENT_SOUL_MANAGER_SHELL_PID` 不存在 → 按它自己的规则返回 `{ ok:false, code:'manager-shell-pid-invalid' }` → 拒绝启动。

### 2. 二进制里到底有没有这串

用 UTF-16LE 扫两枚壳：

| 文件 | 大小 | 含 `AGENT_SOUL_MANAGER_MARKER` | 含 `AGENT_SOUL_MANAGER_SHELL_PID` |
|---|---|---|---|
| 生产 `agent soul\AgentSoul.exe`（2026-11-18） | 133,632 B | **False** | **False** |
| 开发 `agent-soul\build\AgentSoul.exe`（2026-11-18 14:54） | 152,064 B | **False** | **False** |

而源码 `build/Shell.cs`（140,751 B，2026-11-19 22:29）**有**这段：

```csharp
psi.EnvironmentVariables.Remove("AGENT_SOUL_MANAGER_MARKER");
psi.EnvironmentVariables.Remove("AGENT_SOUL_MANAGER_SHELL_PID");
string managerMarker = Environment.GetEnvironmentVariable("AGENT_SOUL_MANAGER_MARKER");
...
if (validManagerMarker) {
    psi.EnvironmentVariables["AGENT_SOUL_MANAGER_MARKER"] = managerMarker;
    psi.EnvironmentVariables["AGENT_SOUL_MANAGER_SHELL_PID"] = Process.GetCurrentProcess().Id.ToString();
}
```

⇒ **源码已改、二进制没重编**。这就是全部原因，不需要再猜。

### 3. 不带 marker 启动照常

恢复后：core pid 14588，`/api/health` 200，sessions 226。普通桌面启动不碰 manager 分支（`readLaunchIdentity` 直接回 `{ok:true, managed:false}`）。

### 4. /api/manager-proof 端点行为

无 token 请求 → **401 `missing-or-bad-token-header`**（不是 404、不是 500）——端点存在且鉴权正常；
有 token 但 core 不是被 marker 拉起 → 会走 `managerIdentityView` 的 `409 manager-identity-unavailable`。

---

## 三、缺口（明确不做假）

1. **壳需要一次带 manager 协议的重编** —— `build\Shell.cs` 的源码已经是对的，缺的是编译产物。
   重编之后：bridge 的 start 端点 → spawn 带 marker → 壳把 marker + 自己的 pid 递给 core →
   core 写 core.lock 的 manager 段 → bridge 用 token 读 /api/manager-proof → 三条半边对齐 → start 真正可验。
2. **pruner / huanqi 仍是桩**（未在这次动它们）：`stubCaps: ['huanqi','pruner']` 原样保留。
3. **agentSoulRoot 默认改成生产安装**（壳在根下 `AgentSoul.exe`），`agentSoulPlan` 现在两处都认
   （`<root>/build/AgentSoul.exe` 与 `<root>/AgentSoul.exe`）—— 之前只认前者，真实安装上会「找不到 exe」。

---

## 四、别重复试的事

- 不要再用 marker 去拉生产壳，然后期待它成功 —— 在重编之前**必然 exit 12**。
- 不要去猜「是不是 token 不对」——无 token 时端点回的是 401，token 不对也是 401，而 core 根本没进 manager 分支。
- 不要把 `identityAvailable: true` 打开来「让它通」—— 那会让 stop/restart 对着没验过的进程下手。
