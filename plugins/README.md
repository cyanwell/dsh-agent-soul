# DSH 侧的两个必需插件

agent-soul v4 是**独立进程**，但要用上「让宿主替我干活」那部分能力（投递回合、换气、宿主扫描），
需要在 DSH 侧装这两个插件。

```
dsh-agent-soul-bridge   控制通道 —— v4 → 宿主（推指令、收回执）
dsh-mcp-hub             MCP 托管 —— 让 echo 记忆中枢常驻
```

★ **不装也能跑**：v4 会退化成「自己起回合」的降级形态 ——
收帧、建索引、记账都正常，但没有「对话」可接，自主也 fail-closed。
判据：`GET /api/health` 的 `llmUsable` 和 `GET /api/autonomy` 的 `resolved`。

---

## 装法

### 1. 放到 DSH 能读到的地方

DSH 读插件的规矩是 `package.json` 的 `file:` 依赖，**不是** `node_modules` 里那份副本。

```
dsh-tools/
  dsh-agent-soul-bridge/    ← 把本目录的 dsh-agent-soul-bridge 拷到这
  dsh-mcp-hub/              ← 同上
```

### 2. 加进 profile 的 bundles

```json
// <DSH_HOME>/profiles/desktop/package.json
{
  "dependencies": {
    "dsh-agent-soul-bridge": "file:D:/AI/dsh-tools/dsh-agent-soul-bridge",
    "dsh-mcp-hub": "file:D:/AI/dsh-tools/dsh-mcp-hub"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "dsh-mcp-hub",
        "dsh-agent-soul-bridge",
        "...你原有的"
      ]
    }
  }
}
```

然后在 profile 目录跑 `pnpm install`。

### 3. 重启 DSH

**插件不会热加载。** 改完 `bundles` 必须重启。

---

## 判据（三条，缺一条就没接上）

```
① GET http://127.0.0.1:7310/api/health
     sessions 应该等于你的会话数
     llmReady / llmUsable 应该是 true

② GET http://127.0.0.1:7310/api/session
     应该有 host=dsh 且 caps 里含 'context'

③ GET http://127.0.0.1:7310/api/autonomy
     resolved 应该是 true
```

★★ **第三条最容易漏**：`resolved` 为 false 时 v4 不报错，只是**永远不动**。
   它判断「当前主导是谁」靠两条路：

```
① 读 DSH 心跳插件的 /heartbeat/auto（心跳插件已停用 → 这条路已经断了）
② 读《墨》里最后一条 lead 的署名（ledger:last-lead，现在走这条）
```

所以 `resolved: true` 且 `leadSource` 是 `ledger:last-lead` 才是**正常状态**。

---

## bridge 的能力清单

`caps` 决定 v4 能推什么指令。当前五项：

```
followup   投递一轮对话（v4 → 宿主会话）
session    会话操作（新建 / 送话）
huanqi     换气（读上下文、候选污染段）
pruner     上下文修剪（给 v3 时代留的）
context    上下文外科手术（原地替换一段，换气真清靠它）
```

★ **caps 有三层生效链**（今天绕了九圈才查清）：

```
① 代码 index.js 的 DEFAULTS.caps
② 目录 package.json 的 file: 依赖（指向哪个目录）
③ 配置包自己的 cordis.patch.yml 的 config.caps  ← **这个覆盖前两个**
```

**三层缺一不可。** 只改 `index.js` 等于白改。

判据：v4 的 `/api/session` 里看 `caps` 数组 —— 那是宿主**自报**的，不是 v4 猜的。

---

## 这两个包里的文件（白名单）

```
dsh-agent-soul-bridge/
  index.js              主入口（控制通道 + 指令分发）
  ws.js                 WebSocket 客户端
  pruner-adapter.mjs    v3 时代的修剪适配器
  context-surgeon.mjs   上下文外科手术（surfaceOp replace）
  cordis.patch.yml      插件的配置（caps 在这里）
  README.md             包的说明
  package.json

dsh-mcp-hub/
  index.js              MCP 服务托管
  client.js             客户端
  cordis.patch.yml      配置
  README.md
  package.json
```

★ **没有 `node_modules`** —— 两个包都是零第三方依赖（只用 node 内置）。
  也不需要 `index.js.bak-*` 那些备份：那是开发时的回退点，不属于发布内容。
