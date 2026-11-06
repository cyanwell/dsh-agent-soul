# agent-soul

从 DSH 解耦出来的灵魂层运行时。**会话 / 事件 / 记忆 / 人格，自带。**

## 它是什么

不是插件，不是壳 —— 是一个能独立跑的 agent runtime。
五个必须自己有的能力，全部在一两千行里实现：

| 能力 | 在哪个文件 | 状态 |
|---|---|---|
| 会话存储（写入即索引） | `src/session/` | ✅ |
| LLM 客户端（SSE + 工具调用） | `src/llm/client.mjs` | ✅ |
| 工具注册表 + 单调守卫 | `src/tools/registry.mjs` | ✅ |
| 回合驱动 | `src/agent/loop.mjs` | ✅ |
| 五个槽位的前端壳 | `src/web/shell.html` | ✅ |

## 与 DSH 的三个根本区别

1. **索引在写入时产生** —— 写一帧，同时写一条索引。压缩不再是索引的前提，压缩层整块不存在。
2. **会话是裸 JSONL** —— `frames.jsonl` + `index.jsonl`，不压缩、可读、可 grep。
3. **工具守卫是单调的** —— 只允许否决，不提供 allow。所以注册顺序不影响结果（照抄 DSH 的 `ToolGuard` 契约）。

## 起法

```bash
# 1. 填 key（二选一）
#    a) 编辑 config.json 的 llm.apiKey
#    b) set AGENT_SOUL_KEY=sk-xxx

# 2. 起
node src/index.mjs
```

默认 http://127.0.0.1:7310

## 自检

```bash
node tools/selftest.mjs
```

9 项：建会话 / 写帧即索引 / 检索 / 工具注册 / 执行 / 越界拒绝 / 守卫否决 / HTTP 与五槽位 / 无 key 不崩。

## 五个槽位

壳按接口 spec 实现，DOM 上带 `data-slot` 标记：

| 槽位 | DOM |
|---|---|
| `main` | `#main[data-slot]` 顶栏 |
| `sidebar.panellist` | `#sidebar[data-slot]` 会话列表 |
| `conversation.view` | `#msgs[data-slot]` 对话区 |
| `shell.overlay` | `#overlay[data-slot]` 全局浮层 |
| `settings.section` | 设置里的每个 `.sect[data-slot]` |

## 目录

```
src/
  index.mjs            入口
  config.mjs           配置（JSON + 环境变量）
  session/frame.mjs    帧定义 + 可检索文本抽取
  session/store.mjs    会话存储（写入即索引）
  llm/client.mjs       LLM 客户端
  tools/registry.mjs   工具注册表 + 单调守卫
  tools/builtin.mjs    内置工具（读/写/列目录/跑命令）
  agent/loop.mjs       回合驱动
  web/server.mjs       HTTP + SSE
  web/shell.html       前端壳（五槽位）
data/sessions/<id>/
  frames.jsonl         每行一帧
  index.jsonl          每行一条索引
tools/selftest.mjs     自检
```

## 还没做（下一版）

见 `STATUS.md`。缺事件层、器官迁移、真机挂载验证。
