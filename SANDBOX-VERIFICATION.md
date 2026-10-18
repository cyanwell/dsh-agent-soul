# 沙箱验证实录：一个新 DSH 能不能靠这套插件把自己长出来

> 2026-10-18，坐标 `D:\AI\dsh-demo`（沙箱，与灵魂目录隔开）。
> 这份文件记的是**验证过程**，不是说明书 —— 包括撞出来的坑、判错的判据、
> 和**到现在还没验成的那一条**。

---

## 一句话结论

**能装，能起，能跑，能画。** 12 个零件全部装进一个从零建起的 profile，
16 个 bundle 全部加载，页面上的「砚台 / 日记 / 回声」真的画出来了，
`agent_soul_*` 工具真的能调。

**但「压缩插件到底有没有接管」这一条，还没验成。**

---

## 一、装了什么

从 `/plugins` 装进 `agent-soul-demo` 这个 profile 的 12 个零件：

```
Ⅰ ECHO   compaction · pruner · memory · echo
Ⅱ VITAL  clock · model-statusbar · huanqi · huanqi-panel
Ⅲ 能力   mobile-adapt
Ⅳ 档案   riji · splash · yantai
Ⅴ 运维   gateway / ledger / self（脚本，不是 DSH 包）
```

★ 第 Ⅴ 层那三个**不能用 `dsh plugin add`** —— 它们是脚本，要按各自 README 手工放。

---

## 二、撞出来的七个洞

排在前面的更基础。**每一个都不是读源码读出来的，都是真装才现形的。**

### 洞一 · `pnpm` 不存在

`dsh plugin add` 内部转发 pnpm，本机没有。`corepack enable pnpm` 也失败
（要往 node 目录写 shim）。但 `corepack pnpm` 本身能用 → 造一个薄壳放进 PATH。

★ 坑：corepack 的入口是 `dist/corepack.js`，**不是 `.cjs`**。

### 洞二 · `declares no dsh.bundle`

13 个零件里 11 个有 `dsh.bundle`，只有 `compaction` 和 `pruner` 没有
→ **装了但不加载**，静默。

★ 根因不是疏漏，是**形状不同**：这两个是「class 替代实现」，不是 cordis 插件。
但 `compaction-basic` 本身也是 class 且有 bundle → 证明 class 可以带 bundle，
只是这两个包缺一层包装。

### 洞三 · 缺 `cordis.patch.yml`

`plugins/compaction` 只有 3 个文件，没有 patch。

### 洞四 · `cannot resolve profile bundle "dsh-agent-soul"`

装 pruner 时 pnpm 重整 `node_modules`，**手动复制进去的 `dsh-agent-soul` 被清掉**了
（它从不在 `dependencies` 里）。

★ 教训：**「手动复制法」和「CLI 安装法」不能混用。**

### 洞五 · patch 语法是扁平的，没有 `update`

读 `cordis-plugin-include/lib/index.js:68-104`：

```js
const { id, insert, name, ...overrides } = patch;
if (insert) { ...; continue; }
if (!id) { warn("patch: id is required for non-insert patches"); continue; }
const target = entryMap.get(id);
if (name && name !== target.name) { warn("name mismatch"); continue; }
for (const [key, value] of Object.entries(overrides)) target[key] = value;
```

三条：
① 形状是 `{ id, insert, name, ...overrides }` —— **没有 `update` 关键字**。
　写成 `- update: [...]` 会整个被当成 overrides 键，于是 `id` 为空。
② **`name` 不能改** —— 有一致性校验，不一致就 skip。
③ 能改的只有 `config` 之类的**字段**，不是「换成另一个包」。

### 洞六 · `path is not defined`（真 bug，已修）

`plugins/riji/index.js` 第 16 行 `import { join } from 'node:path'`，
第 21 行写 `path.join(...)` —— 抄的时候只抄了调用没抄 import，差一个字符。

```
Error: dsh: plugin tree failed to load
ReferenceError: path is not defined
    at .../node_modules/dsh-agent-riji/index.js:21:43
```

★ **为什么一直没被发现**：
  · `node --check` 查不出（语法完全合法，运行时才炸）
  · `dump-config` 查不出（只解析配置，不 import 模块）
  · **只有真把整个 profile 拉起来，才在 boot 阶段炸掉**

### 洞七 · cordis 的服务注册是**先到先得**

`tools/probe-service-order.mjs` 实测：

```
Builtin → Mine     ⇒ ctx.compaction.who() === "builtin"   ← 先注册的赢
Mine → Builtin     ⇒ ctx.compaction.who() === "mine"      ← 先注册的赢
```

**同名 Service 并存时，先注册的那个占住名字。后来的不报错、不警告，静默不生效。**

而 `dsh plugin add` 是往 `bundles` 末尾追加的 → 我们的包排在 `dsh-base` 后面 ⇒ 输。

★ 于是「用 patch 换掉内置实现」两条路都封死：`update` 不存在（洞五）、
`insert` 抢不到服务名（洞七）。

★ **出路**：profile 的 `bundles` 顺序**是手写的、DSH 尊重它**（实测 `--dump-config` 原样保留）。
把本包提前即可 —— 见 `plugins/compaction/HOW-TO-TAKEOVER.md`。

---

## 三、怎么验的（以及验不到的）

### `tools/verify-live.mjs` —— 一次命令给出体检

查五件事：层进没进 bundles、patch 文件在不在、patch 形状对不对、
源码与副本一致吗、pruner 的 marker 是哪个。

沙箱实测：**通过 30 / 需注意 1 / 失败 0**。

★ **写它的过程中它抓到我自己的一个 bug**：第一版只查 `<profile>/node_modules`，
于是 `@deepseek-ai/dsh-base` 和 `dsh-web-app` 全报「找不到」——
它们是共享安装的，住在 `profiles/node_modules`（**上一层**），由 Node 的模块解析往上爬找到。
**这不是包缺失，是我的判据漏了一层。**
→ 判据写错等于**假失败**，和假绿一样坏。

### UI 真画出来了

浏览器里读到的：

```
tab "对话"   tab "砚台"   tab "日记"   tab "回声"   tab "轨迹"
button "当前时间"
```

砚台 / 日记 / 回声 —— 三个客户端半真的渲染了。这是 `verify-live.mjs` 验不到的那一半：
**不是 Host 报 running，是页面上真有那个东西。**

### ★ 还没验成的那一条

**兜底压缩用的是不是本包的类。**

终极判据是：跑一次压缩，看 checkpoint 前面有没有 `log:<会话>#seq=<n>` 指针块。

- 有 → 全链路通了
- 没有 → 「顺序」这个解释也不对，得回头看 `summarize` 到底有没有被调到

要触发它得把上下文喂过阈值，这轮没做。**这一步欠着，不假装已经验过。**

---

## 四、这份实录最有用的三句话

1. **「装了」和「生效了」是两件事，中间隔着至少三道闸**：
   有没有 `dsh.bundle`（会不会被加载）、patch 形状对不对（能不能插进去）、
   层栈顺序（插进去之后谁占住服务名）。

2. **判据写错会给出假答案，比没有答案更糟。**
   `verify-live.mjs` 的假失败、探针第一版的 `undefined`（其实是异步没等）、
   以及「只在自己那半边找」—— 三次都是判据的问题，不是事实的问题。

3. **负结论也是结论。** 洞七说的是「这条路走不通」，它省掉了下一个人去撞同一面墙的时间。
   写下来比修好它更值钱 —— 因为修好只有一个人受益，写下来所有后来的人受益。
