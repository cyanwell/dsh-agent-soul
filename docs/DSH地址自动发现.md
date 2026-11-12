# DSH 地址自动发现（心跳问哪里）

> 2026-11-11。解决的具体故障：**DSH 一重启，自主投递与定点清理就静默失效**。
> 起因不是判定错了，是「向哪个端口问心跳」写死在了配置里 —— 而那个端口每次重启都变
> （本机实测 59174 → 57099 → 56207 → 49394）。

---

## 一、一句话

**「谁是当前 lead」只由心跳接口回答；这份代码只回答「心跳接口在哪」。**

- 显式配置（`integrations.heartbeatUrl` / `dshBaseUrl`）→ **最高优先**，配了就一次日志都不读；
- 没配 → 从本机**最新 DSH 启动记录**里发现 `http://127.0.0.1:<port>`；
- 发现不到 / 多源不一致 → **fail-closed**（不动，绝不猜一个端口）。

★ 这不新建第二套 lead 判定：`src/organs/lead-target.mjs` 仍然只解析 `GET /heartbeat/auto` 的响应。

---

## 二、生产默认：自动发现

新装 / 没配 `integrations.*` 的情况下，地址按下面两条来源自动发现，**每次 tick 现读，不缓存**：

| 序 | 来源 | 位置 | 说明 |
|---|---|---|---|
| ① | 启动日志 | `<DSH_HOME>\guard\logs\server-*.out.log` | 桌面「DSH服务」图标启动时写的。没配目录 → 依次看环境变量 `DSH_HOME`、开发机默认 `D:/AI/dsh/home` |
| ② | origin 文件 | `dsh-yanqing-heartbeat/dsh-origin.txt` | 心跳插件启动时写下的「我自己的 origin」 |

**两条来源是同一种记录**：谁最后写，谁代表最近一次启动。所以规则是：

1. 取 **mtime 最新**的记录；
2. 最新那条**还没打出 origin**（DSH 正在启动）→ **fail-closed**，不拿更老的日志把旧端口捞回来；
3. 两个来源都在 5 分钟内写过、却给出**不同** origin → **fail-closed（多源不一致）**，不替你选；
4. 一条有效记录 → 用它。

### 只认一种形状

`http://127.0.0.1:<port>`（port 1–65535）。`https` / `localhost` / `0.0.0.0` / 别的 host 一律不认。

### token 纪律（硬线）

DSH 的启动行长这样：

```
dsh web: http://127.0.0.1:<端口>/?token=<一次性 launch token>
```

解析用的正则**只捕获端口**，查询串根本不进捕获组 —— 「立即丢弃」是结构性的，不靠后续清洗。
因此 token 不会出现在：内存状态、日志行、错误串、面板、回执文件。**这个模块没有一行写盘代码。**

---

## 三、显式 URL 覆盖（新用户 / 想钉死的人）

DSH 若**不由那个写日志的脚本启动**（比如直接双击沙箱 exe），两条来源可能都不存在。
这时显式配一个地址就够，**而且它优先于自动发现**：

```json
{
  "integrations": {
    "heartbeatUrl": "http://127.0.0.1:49394/heartbeat/auto"
  }
}
```

或只给 origin：

```json
{ "integrations": { "dshBaseUrl": "http://127.0.0.1:49394" } }
```

优先级：`heartbeatUrl`（整条）＞ `dshBaseUrl`（拼 `/heartbeat/auto`）＞ 自动发现。

★ **配错了不会静默回退**：显式地址不合法 / 连不上就是失败，**不会**偷偷改用日志里的端口
（那样「我明明配了」和「它自己变了」会永远分不清）。

### 两个可选的定位参数

| 键 | 默认 | 什么时候改 |
|---|---|---|
| `integrations.dshLogDir` | `<DSH_HOME>/guard/logs`（开发机 `D:/AI/dsh/home/guard/logs`） | 启动日志写在别处 |
| `integrations.dshOriginFile` | 开发机默认 `D:/AI/dsh-tools/dsh-yanqing-heartbeat/dsh-origin.txt`（**文件存在才用**） | 插件装在别处 |

---

## 四、部署时怎么确认「现在问的是哪个 origin」

一条命令，输出里**只有 origin / 来源 / 文件名 / 布尔量**，可以直接贴进聊天记录：

```powershell
& 'D:\AI\dsh\node.exe' 'D:\AI\agent-soul\tools\dsh-origin-probe.mjs'
```

本机实测（2026-11-11）：

```
日志目录   D:\AI\dsh\home\guard\logs
origin文件 D:/AI/dsh-tools/dsh-yanqing-heartbeat/dsh-origin.txt
来源       dsh-origin-file / dsh-origin.txt
origin     http://127.0.0.1:49394
心跳地址   http://127.0.0.1:49394/heartbeat/auto
心跳       ok（enabled=true primaryFound=true 有primarySessionId=no）
```

退出码：`0` = 找到并能读到心跳；`2` = 发现不到（原因就打印在上面）。
★ 它**不会**打印 token，也不会打印 `primarySessionId`（只说有没有）。

---

## 五、失败了看哪

| 现象 | 意思 | 怎么办 |
|---|---|---|
| `既没有配心跳地址…也发现不到 DSH 的 origin：日志目录里没有 server-*.out.log` | DSH 不是由写日志的脚本启动的，也没有 origin 文件 | 配 `heartbeatUrl`，或让它按桌面图标启动 |
| `最新启动日志里还没有 http://127.0.0.1:<port> 形式的 origin（DSH 可能还在启动）` | 刚重启，约 40 秒后才打印 | 等下一个 tick |
| `最新启动日志不是 UTF-8 文本（UTF-16…）` | 写日志用了 `Tee-Object` | 换 `StreamWriter` + UTF8（见 skill `dsh-local-ops`） |
| `两个来源…origin 不一致…fail-closed` | 同时有两个 DSH 在写 | 关掉一个，或显式配地址钉死 |
| `读心跳失败：HTTP …` | 地址对、服务不对（端口已经换了 / 那个实例没起） | 跑第四节那条命令看当前 origin |

★ 所有错误串里**只有 origin**，永远没有 `?query`。

---

## 六、为什么不缓存端口

缓存过旧端口，正是这次要修的故障本身：它不报错，只是永远不再通，而从外面看起来
和「今天没人说话」一模一样。所以 `lead-target` 每一次 `refresh()` 都重新解析一次地址 ——
端口变了，**下一个 tick** 就用新 origin（自主与定点清理共用同一个 resolver）。

---

## 七、代码在哪

| 文件 | 职责 |
|---|---|
| `src/organs/dsh-origin.mjs` | 发现 origin / 解析「这一次问哪里」；无网络、无写盘 |
| `src/organs/lead-target.mjs` | 每 tick 先解析地址，再解析 `/heartbeat/auto` 的响应（lead 判定仍只有一处） |
| `tools/dsh-origin-probe.mjs` | 部署自检（第四节） |
| `tools/dsh-origin-selftest.mjs` | 临时日志目录 + 假 HTTP：A→B 换端口、fail-closed、token 不落盘 |
