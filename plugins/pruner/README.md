# dsh-agent-pruner

> 给**工具结果的裁剪**装上「门牌」——
> 把官方那句静态 marker 换成带位置信息的版本。

---

## 它防的是什么

`@deepseek-ai/dsh-compaction-tool-result-pruner` 会把**过大的工具结果**中间挖掉：
留 head 4096 + tail 1024 个 Unicode code point，中间换成一句固定文本：

```js
const PRUNE_MARKER = "\n\n[... tool result middle pruned ...]\n\n";
```

**★ 它其实已经做对了一半。**

`pruneSession` 在替换时留了**完整的回链**：

```js
session.append("compaction/prune", {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],                    // ← 记下了被遮蔽的 seq
    shadowedTokenCount: ...
});
const replacement = session.append("tool/result", { ... }, {
    surfaceOp: { op: "replace", startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq]                  // ← 替换节点指向原节点
});
```

原文永远在 append-only 日志里，`eventAt(seq)` 随时取得回来 —— 这就是 Replay-safe。

**缺口只有一个：那句 marker 是死文本。**

它告诉你「这里被挖了一块」，**但不告诉你那块在哪个 seq**。
于是你在正文里读到 `[... pruned ...]` 时，**知道有东西被删了，却不知道去哪儿找**。

**数据链是完整的。缺的是给人看的那半。**

---

## 它怎么做

**完全不碰裁剪逻辑**，只在输出里换掉那句 marker：

```
1. 覆盖 pruneSession —— 先按官方那两行筛选逻辑排出一个候选 seq 队列
2. 覆盖 pruneContent —— 先调 super 拿到裁好的 blocks，
                        再把官方 marker 替换成带 seq 的版本
```

**结果长这样：**

```
[... 中间被裁（会话 session-xxxx） · 原文在 append-only 会话日志 seq 4821，
     取回：用你自己的检索命令打开：log:session-xxxx#seq=4821 ...]
```

**★ 取回命令是可配的，不配就不给命令。** 见 `index.js` 里的 `MEMQ` 常量：

```
SOUL_MEMQ='node /path/to/memq.mjs'      # 或 MEMQ=...
```

- **配了** → 渲染成 `'<你的命令>' open log:<会话>#seq=<n>`，可以直接敲。
- **没配** → 只给指针（`log:<会话>#seq=<n>`）和一句「用你自己的检索命令打开」。

★ 为什么不给一个默认值：**假命令比没有命令更坏。** 写成 `<你的检索命令>` 那种字面占位符，
读的人会照着敲；敲不通之后可能反过来怀疑「门牌坏了」—— 而那恰好是这套机制最要紧的东西。
本包只负责【写指针】，不规定你用什么工具去【回取】。

---

## 两个安全阀（都很要紧）

```
① 换上去之后若超出 thresholdChars  → 退回官方 marker
   （官方的 resolveConfig 只保证 head + marker + tail <= thresholdChars，
     所以换上去的东西必须自己保证塞得进）

② 拿不到 seq 或会话号            → 原样返回，不猜
```

**第 ② 条是那条三级纪律的落地：**

```
① 能拿到精确位置 → 写精确位置
② 拿不到        → 写「位置未知」+ 容器标识 + 一个检索入口
③ 绝不猜        → 错的门牌比没有更坏
```

**为什么第 ③ 条单独列出来**：一个错的指针会让你**以为能找到，于是不去找**。
那比「找不到」坏得多 —— 找不到你还会想别的办法，以为找得到你就停下了。

---

## 长度预算

默认配置（`headChars 4096` / `tailChars 1024` / `thresholdChars 8192`）下，
marker **有约 3000 字符余量**。

但使用者的配置可能更紧 —— 所以安全阀 ① 不是可选项：
**它保证「加了门牌」永远只是更清楚，不会把一次成功的裁剪变成失败。**

---

## 装

```bash
dsh plugin --profile <name> add <path-to-this-package>
```

**装完要重启 DSH**（宿主半只在进程启动时加载一次）。

### 前置

它挂在一个 **peerDependency** 上：

```json
"peerDependencies": { "@deepseek-ai/dsh-compaction-tool-result-pruner": "*" }
```

**这是故意的** —— 它扩展那个包的行为，不是替代它。
被扩展的包必须由你的 DSH 安装提供。

**★ 判据**：装完之后，看被裁过的工具结果里**那句 marker 是不是带 seq 的版本**。
是 → 生效了。仍是 `[... tool result middle pruned ...]` → 没生效。

---

## 和 `dsh-agent-compaction` 的关系

**两个包，同一个纪律，两个不同的受害者。**

| | 被挖掉的是什么 | marker 长什么样 |
|---|---|---|
| `dsh-agent-compaction` | 早期上下文（整段） | 摘要最前面插一个指针块 |
| **`dsh-agent-pruner`** | **过大的工具结果（中间）** | **替换那句静态 marker** |

它们可以各自独立安装 —— 装一个也有用，只是那条路上仍然有暗的地方。

---

## 边界

```
✗ 不改裁剪逻辑（留多少 head / tail、怎么选 seq，全是官方的）
✗ 不改 compaction-tool-result-pruner 的任何文件
✗ 不会让裁剪失败 —— 塞不下就退回官方 marker，拿不到 seq 就原样返回
```

---

## License

MIT
