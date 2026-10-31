# compact-region · 只压那一段

## 它解决什么

> ★★★ **2026-10-31 现状：本包已不是换气的 region 主路径。**
> 换气现在先走「LLM 诊断 + `surfaceOp` 定点清除」（表面替换，不需要 open turn）；
> 本包（`/compact-region`）降为 **fallback** —— 定点清除没有候选、或全部失败时才落回它。
> 原因：`/compact-region` 要求「turn 还开着」且「摘要期间整面静止」，而换气只能在 turn 外行动 —— 这两个条件不能同时满足（六次尝试全败）。
> **本包仍然可用**（手动执行 `/compact-region <start> <end>`），只是不再是自动路径。

换气（`huanqi`）有三档治疗，第二档是**范围压缩**：累计截断 N 次之后，只压走最近那一段脏历史，然后继续对话 —— 区别于熔断时那种「整段压掉、不再延续」的全量压缩。

它够不到 `compaction` 服务。那个服务被 preset 的 `isolate: { compaction: true }` 关在 realm 里，根层的插件从 `agent.ctx` / `agent.session.ctx` / 根 `ctx` 三条路都取不到；而删掉 `isolate` 会让所有会话 `resume failed`：

```
RemoteError: Preset services require isolate realms: compaction (gateway/internal)
```

唯一的门是 `commands` 服务（根层可达）。于是借道：

```
huanqi → ctx.get('commands').execute(agent, '/compact-region <start> <end>')
```

而官方的 `/compact` 命令**不接受参数、只做全量**。这个包补上「带范围」的那一条 ——**但换气已不再用它做默认路径**（见文首说明）。

## 装法

★ **不能当 bundle 插到顶层**（那样注册出来的命令调不到 `compactRegion`）。必须写进 preset 的 compaction group：

```yaml
- id: compaction
  name: cordis:group
  isolate:
    compaction: true        # ★ 硬约束，删不得
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: 'dsh-agent-compaction'
      config:
        thresholdRatio: 0.88
    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'
    - id: command-compact-region      # ← 本零件
      name: 'dsh-agent-compact-region'
    - id: tool-result-pruner
      name: 'dsh-agent-pruner'
```

装完重启生效。

## 怎么验它真的通了

一次范围压缩之后，会话事件流里应当依次出现：

```
command/run    name=compact-region args="<start> <end>"
compaction/start
compaction/summary   shadowedRange={start,end}  shadowedSeqs=[...n]  shadowedTokenCount=<tok>
user/message        source={"kind":"compact-checkpoint"}
compaction/end
command/done        sourceEventSeq=<那条 summary 的 seq>
```

最后那行是关键：**前端靠 `command/done.sourceEventSeq` 找回对应的 `compaction/summary`**，才渲染出「· compact · 已压缩 N 条历史记录（约 X tokens）」。少了它，压缩成功但界面上一个字都不显示。

## 参数

```
/compact-region <start> <end>
```

两个正整数 seq。`start <= 0` 或 `end < start` 会被命令自己在门口挡掉 —— **零副作用**，所以可以拿 `/compact-region 0 0` 当探针，用来判断这条命令到底注册上没有。

## License

MIT
