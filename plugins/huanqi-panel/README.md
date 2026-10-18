# dsh-agent-huanqi-panel

> 给**换气**（`dsh-agent-huanqi`）配的一块设置面板：
> 在 DSH 的设置页里直接调它的参数，并看到实时的延续额度。

---

## 它防的是什么

**「改一个值，把整个文件弄乱」**

那份配置文件是 YAML，而 YAML **是有注释和缩进的**：

```yaml
- set:
    - id: huanqi
      config:
        maxThinkingSteps: 3        # ← 这个注释是写给人看的
        similarityThreshold: 0.8
```

**绝大多数「改配置」的实现是这样的**：

```
读 → parse 成对象 → 改一个字段 → 序列化写回
```

**于是**：

```
✗ 所有注释没了
✗ 引号风格变了（'x' → "x"，或者反过来）
✗ 缩进重排了（2 空格 → 4 空格）
✗ 键的顺序变了
✗ 于是 git diff 是一片红 —— 你改了一个数字，看起来像重写了整个文件
```

> ### ★ 这不是「格式不美观」，是**你把别人的文件改成了你的文件**。
> 下一次他想手动改点什么，要先看懂你的排版；而且**他再也 diff 不出自己改了什么**。

---

## 它怎么做：字节级编辑

**只替换那个值所在的字节区间，其余一个字节都不动。**

```
读原始文本  →  定位到 `maxThinkingSteps:` 后面那个 token  →  只换那一截  →  原样写回
```

**结果**：

```
✓ 注释还在
✓ 缩进还在
✓ 引号风格还是原来的
✓ 键的顺序没变
✓ git diff 只有一行
```

**代价**：它不能用 YAML 库，得自己按行找目标键 —— **所以它能改的字段是白名单式的**，不是「任意 YAML」。

★ 但那正是它该有的样子：**一个设置面板不该有能力重写你的任意配置文件。**

---

## 它长什么样

```
DSH 设置页
  └─ 换气
       ├─ maxThinkingSteps        连续几步只有推理 → 判定退化
       ├─ minReasoningChars       短于这个长度不算（避免误伤）
       ├─ similarityThreshold     相邻推理的相似度阈值
       ├─ escalate                第二次命中时的动作
       └─ ★ 实时额度              （只读）从额度账本读出来
```

**额度那一栏是只读的** —— 面板只显示，**不允许在这里改额度**。
理由见 `dsh-agent-huanqi` 的 README：**额度是体温计，不是配额**；
一个能手动充值体温计的面板，会让那个读数彻底失去意义。

---

## 装

```bash
dsh plugin --profile <name> add <path-to-this-package>
```

**装完要重启 DSH**（宿主半只在启动时加载一次）。

### 两个可配项

```bash
ECHO_* 不适用 —— 这个包用下面两个环境变量：
PANEL_LEDGER  额度账本 JSON 的路径（默认 ./state/dsh-huanqi.json）
PANEL_PROFILES 要操作的 profile 目录（默认 <DSH_HOME>/profiles）
```

**★ 它必须同时装 `dsh-agent-huanqi`。** 这个面板只是它的界面 ——
**没有换气，面板上没有东西可调。**

---

## 两个路由

```
GET  /agent-huanqi/api/state    读：当前配置 + 实时额度 + 文件路径
POST /agent-huanqi/api/config   写：{ profile, values: { 键: 值 } }
```

**写在哪个 profile 上要显式给** —— 面板不猜「你大概想改哪个」。

---

## 自检

```bash
node panel-credit-selftest.mjs
```

它打一次 `/api/credit`，**看返回的是不是真数字** —— 端到端地验一遍，
不用重启、不用打开浏览器。

---

## 边界

```
✗ 不改任意 YAML —— 只改白名单里的那几个键（安全边界，不是偷懒）
✗ 不改额度 —— 只读
✗ 不重启 DSH —— 改完提示你重启，重启是人的动作
✗ 不判断值合不合理 —— 但阈值那一栏旁边写着「它防的是什么」
```

---

## License

MIT
