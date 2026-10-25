# dsh-agent-clock

> 侧边栏底部一个时钟按钮：点开是当前时间。
> **小工具，但它和 `dsh-agent-memory` 是一对。**

---

## 它防的是什么

**「同一件事，两个位置，两个答案」。**

一个会话制的 agent 有个具体的形状：**只有人说话它才醒来**。
所以「现在几点、上一次说话隔了多久」这两件事，对它是**必须被推给它的信息** ——
它不会自己去看钟。

`dsh-agent-memory` 做的是把它推给 agent。

**但人在界面上也需要看时间。** 如果那两处各自算各自的：

```
✗ 提示里写着「距上轮 3 小时」（按 A 时区算）
✗ 侧边栏写着「14:20」（按 B 时区算，或者根本没刷新）
→ 于是两个人都以为自己在说同一件事，其实不是
```

> ### ★ 这个插件存在的理由，是让那个时钟**只有一份来源**。
> 它故意做得非常简单 —— **简单的部分不该有两种实现。**

---

## 它长什么样

```
侧边栏底部
  └─ 🕐  14:20     ← 点一下弹出面板
                 ├─ 当前时间（本地时区）
                 ├─ 日期与星期
                 └─ 与上一次会话的间隔
```

**`order = 60`** —— 侧边栏底部的按钮是有顺序的（数字小的靠下/靠前），
这个顺序值让它在几个已有按钮之后。

---

## 装

```bash
dsh plugin --profile <name> add <path-to-this-package>
```

**装完要重启 DSH**（宿主半只在启动时加载一次）。

★ **桌面端的 profile 不能用 CLI 安装** —— 那种情况手册里没写，
但经验是：桌面端 profile 的 `package.json` 与 bundle 清单要手工加两条。

---

## 面板为什么挂在 `document.body`（别改回去）

`position: fixed` **只有在祖先链上没有 `transform` / `filter` / `backdrop-filter` /
`contain` / `will-change` 时才相对视口**。DSH 侧栏那类毛玻璃容器恰好会创建包含块 ——
面板若还渲染在 `sidebar.footer.action` 的 React 子树里，fixed 就变成「相对那个
256×36 的小格子」，坐标算得再准也会跑到窗口外。

所以本实现有五条硬约束：

1. 面板用原生 DOM 建好后直接 `appendChild` 到 `document.body`（不依赖 `react-dom` 的
   portal —— 宿主不保证给）；
2. 先 `visibility:hidden` 挂上去、量真实 `offsetWidth/offsetHeight`，再算位置；
3. 定位后用 `getBoundingClientRect()` 回读校准：拿「目标视口坐标」与实测的差去修
   style 值、迭代到收敛 —— 即使 body 被皮肤插件加了 transform 也贴合视口；
4. 四边夹在视口内 8px，CSS 再兜 `max-width/max-height` + `overflow:auto`；
5. 打开期间每秒 tick 做一次漂移检测（按钮动了 / 视口变了 / 面板尺寸变了就重贴）。

垂直方向的基线是**面板底边与按钮底边对齐**（面板从按钮这一行往上长），不是
「底边 = 按钮顶 - 间距」—— 后者会把整块面板吊在按钮上方，看着像悬空。

## 自检

```bash
node render-test.mjs        # 契约：注册、注入、按钮、样式、宿主半
node verify-position.mjs    # 定位算法穷举：视口 × 按钮位置 × 面板尺寸（不需要浏览器）
node verify-browser.mjs     # 真 Chrome 里量真 DOM（可选；缺 playwright-core/Chrome 会自动跳过）
```

后两个是**可复跑的验收**，不是「你自己点点看」：

- `verify-position.mjs` 拿真 `client.js` 里的 `placeNear()`，穷举 6 种视口 × 9 个按钮位置 ×
  3 种面板高度，断言每一个组合下面板四边都留在视口内 8px；
- `verify-browser.mjs` 用 playwright-core 起真 Chrome，在「带 transform/backdrop-filter 的
  侧栏槽位」这个真实场景里跑三组：A 新实现、B 旧实现（`position:fixed` 挂在槽位内 + 估算高度）、
  C 新算法但挂错容器。B 组会复现旧版的跑偏（1440×900 下算出 top=1580，整体在窗口外）——
  那是根因的证据，不是期望它坏。

它检查的几件事里有一条值得单独说：**`order` 必须是数字。**
写字符串（`"60"`）时它可能在某些排序实现下**静默排到最后** ——
不是报错，只是位置不对，而**位置不对你很难发现**（你只会觉得「那个按钮怎么不见了」）。

---

## 边界

```
✗ 不做闹钟 / 提醒 —— 它就是「现在几点」
✗ 不写配置 —— 时区跟着系统走，它不替你改
✗ 不联网 —— 时间从本机取
```

---

## 配对

| | 给谁看 | 摆在哪 |
|---|---|---|
| `dsh-agent-memory` | **agent** | 每一步的提示里 |
| **`dsh-agent-clock`** | **人** | 侧边栏底部 |

**它们可以各自单独装** —— 但两个都装的时候，那个时钟才是同一个。

---

## License

MIT
