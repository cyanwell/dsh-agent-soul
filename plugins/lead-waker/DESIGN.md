# lead-waker · 设计与状态机（2026-11-05 定）

> 定位（爀曦原话）：「这个插件的定位是主导会话（你）还有分会话的交流渠道，是要能双向沟通触发的……
> 每一个链路都要依赖这个插件。而且这个插件是要显式的，放在顶栏。
> 主界面要展示分会话挂起的信息，什么要你执行，什么你执行了，什么要审计但是我没有审计的，
> 什么你自己决定做的，通过宪章了吗，它不止是要做你们的沟通渠道，还要展示状态。」

## 一、边界（先划清，免得又变成一锅）

| 谁 | 写什么 | 不碰什么 |
|---|---|---|
| lead-relay（aurabot 模块） | `事件队列.jsonl` **append-only** | 不改已写行、不做状态判定 |
| **lead-waker（本插件）** | `台账.json`（状态机）、`下发.jsonl`（下行） | 不写事件队列 |
| 分会话 | 只写事件队列（经 lead-relay） | 不直接写台账 |
| 主导会话（lead） | 只写「判定」：resume / hold / audit + 宪章结论 | 不改事件原文 |

★ 队列与台账**分离**：队列是「说过什么」，台账是「这件事走到哪了」。JSONL 不能改字段，改就是重写文件 = 破坏写域。
★ 审计者读台账，不读队列。

## 二、状态机（台账每条事件的 `stage`）

```
pending  ──叫醒成功──▶ woken ──lead 判定──▶ decided ──┬─▶ done      执行完
   │                     │                          ├─▶ held      搁置（附理由）
   │                     │                          └─▶ auditing  送审（等爀曦）
   └──超过 3 次叫醒失败──▶ stuck（会被审计看见）
```

**字段**（每条一行）：
```json
{
  "key": "<事件 t>|<标题前 60 字>",
  "t": "2026-11-05T12:50:41.096Z",
  "title": "...", "from": "group:661580035", "tier": "act",
  "stage": "decided",
  "wakeCount": 1, "wokenAt": 1793884625828,
  "decision": "resume",            // resume | hold | audit
  "charter": "pass",               // pass | ask | block | unchecked
  "charterNote": "不涉四条硬线",     // 一句话，给人看的
  "decidedAt": 1793884700000,
  "note": "已推送 10d6968"
}
```

## 三、四类视图（主界面要展示的，就是爀曦点的四问）

| 视图 | 判据 | 他要看什么 |
|---|---|---|
| **要你执行** | `stage=woken` 且 `decision` 空 | 挂着没动的，最该先看 |
| **你已执行** | `decision=resume` | 我做完了什么，附 commit / 产物 |
| **要审计但没审** | `decision=audit` 或 `charter=ask` | 悬着等他拍板的 |
| **你自己决定做的** | `decision` 非空且 `charter=pass` | **我自己拿的主意**，必须能和送审的区分开 |

★ 每一条都要带 `charter` —— 「通过宪章了吗」是他明确问的，不能省。

## 四、双向（现在只有上行）

**下行**：lead 要给某个分会话下指令 → 写 `下发.jsonl`，lead-waker 轮询后找目标会话 `followup()`。
- 目标解析：`sessionId` 精确匹配，或 `chatId`（如 `group:661580035`）交给 aurabot 侧路由。
- 第一版只支持 `sessionId`（live registry 里能直接找到的），chatId 路由留口子。

## 五、UI（shell.overlay）

- **右上角徽章**：未处理数（`stage=woken` + `decision=audit` 之和），0 时淡出。
- **点开浮层**：四个分区，默认展开「要你执行」。
- 每条：标题 / 来源 / 时间 / tier / charter 徽标 / 一键判定按钮（执行·搁置·送审）。
- ★ 不占侧边栏、不占主区 tab；`shell.overlay` 是全局浮层，天然在顶栏位置。

## 六、宪章判定怎么写

不自动判定，**由 lead 判定后写进台账**（`charter` + `charterNote`）。
插件只做一件事：**判定为空时必须显示 unchecked** —— 不允许「没写就当通过」。


## 七、权限拦截（2026-11-05 爀曦定，与 UI 同等重要）

> 原话：「要拦截分会话自己干活，只能调用插件里面的功能来唤醒你，这样执行的权力才能真正掌握到主导会话手上。」
> 「只管被 aurabot 拉起来的会话，因为 aurabot 不止能桥接 QQ，还能桥接 B 站等。」
> 「可以读写记忆、写墨、基本的工具调用，但是更多的权力只能通过这个插件找你审批，你再决定放权。」

### 7.1 作用域：只拦 aurabot 拉起的会话

**判据（第一版）**：会话的 agent preset 名以 `yanqing-qq` 开头（含 `yanqing-qq` / `yanqing-qq-social`）。
扩展：配置项 `intercept.presetPrefixes: ["yanqing-qq"]`，以后接 B 站就加 `yanqing-bili`。
★ **永远不拦 lead 自己**（按《墨》最后一条 lead 的 by 判）。写坏拦截器不能把主导锁死。

### 7.2 白名单（按爀曦的定法）

| 类别 | 允许 | 理由 |
|---|---|---|
| 唤醒 | `wake_lead`（本插件提供） | 唯一通道 |
| 写墨 | `mo_append`（本插件提供） | 取代「跑 mo.mjs」——不给 shell |
| 读记忆 | `mcp__echo__echo_search` / `echo_open` / `echo_recall` | 只读 |
| 文件 | `read` / `write` / `edit` | 基本工具调用 |
| 检索 | `grep` / `glob` | 只读 |
| **拒绝** | `bash` `pwsh` `run_code` `subagent` `spawn_teammate*` `app_launch` 及一切部署/安装/网络执行类 | 见 7.3 |

### 7.3 为什么必须拦 shell 和 run_code

「允许写墨」和「允许跑 mo.mjs」是两件事：前者是**一个受控写操作**，后者是**任意代码执行**。
给了 shell，分会话就能改自己的 preset、改拦截配置、绕过这个插件——拦截器等于不存在。
**所以：能力按用途拆成工具，不按工具给能力。**

### 7.4 拦截动作

- 命中拒绝 → 返回一句明确的话：「这个动作需要主导会话授权。用 `wake_lead` 上报，说明你要做什么、为什么。」
- **每次拦截写台账**（type=block）→ 面板上能看见「分会话试图自己干活」。
  ★ 拦截必须可见 —— 静默拦截和静默失效一样坏。
- 逃生口：`intercept.enabled: false` 一键关。

### 7.5 待验证（实现前必须先查）

1. **DSH 有没有「工具调用前」的插件钩子**？候选：`dsh-agent-loop` 的策略钩子、`dsh-sandbox-policy` 的 guard 注册方式。
2. 若无通用钩子 → 退路：**不给工具**（preset 层只挂白名单工具）。代价是静态，但可靠。
3. 判定「当前会话 preset」从哪个上下文拿（agent 对象上有没有 preset 字段？）。
