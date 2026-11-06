# 手机通道（src/chat/）

> 手机当砚青的声带 + 手机上的轻量聊天页。爀曦 2026-10-08 定的形态，2026-11-07 从老插件搬进这个软件。

## 它是什么

一个**独立监听**的 http 服务：绑 `0.0.0.0:8898`，递出 `src/web/phone.html`，读会话、发消息。

它不是主 server 的一条路由，理由是两条（老版立的，原样保留）：

1. **宿主 Web 只绑 127.0.0.1** —— 手机根本连不上。这不是配置疏忽，GUI 本来就只该本机看。
2. **宿主 Web 要鉴权，而那个 token 属于凭据** —— 不读、不复述、不交出。所以不能"借"它的门。

于是：**主 server 保持 127.0.0.1，手机通道单独绑 0.0.0.0。两个监听，两种暴露等级。**

## ★ 它会暴露什么（必须看完这段再用）

绑 0.0.0.0 = **同一个局域网里任何设备都能打开这一页，没有认证**。

| 能做 | 不能做（刻意不做，不是"还没做"） |
|---|---|
| 读当前会话最近的消息 | 文件读写 / 上传 / 下载 |
| 发一条消息（会叫醒 agent 循环，agent 有自己的工具） | 命令执行 |
| | 语音合成与音频 |
| | 改配置 / 列会话目录 |
| | 写指定会话以外的任何会话 |

老版有的 `/api/upload`、`/api/file`、`/api/audio`、`/api/tts`、`/api/probe` **全部不搬**。
它们会回 **410 Gone**（不是 404）—— 「刻意关掉」和「没这个路由」必须能分开。

### 怎么关

三种都行，重启后生效：

```json
// config.json
{ "chat": { "enabled": false } }
```

```
set AGENT_SOUL_CHAT=off
set AGENT_SOUL_CHAT_PORT=8899      # 只换端口
```

### 为什么不加口令

固定口令只会给「它安全了」的错觉 —— 口令要落进 config.json，转发一次配置截图就没了。
真要安全，是**绑回 127.0.0.1**，前面放反向代理 / 隧道去做 TLS。
所以这里选的是「把能力砍到最小」，而不是「给门挂一把假锁」。

唯一加的一道是 **CSRF 的 Origin 校验**：别的网页可以让你的浏览器往这里 POST（form 提交不需要同源，
只是读不到响应）。这条路由能叫醒 agent，是「动」不是「读」，所以挡一下。它挡不住 curl（本来就说明了没有认证）。

## 路由

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 手机页（每次请求重新读盘 ⇒ 改页面不用重启） |
| GET | `/api/recent` | `?limit=20` / `?after=<seq>` 增量 / `?before=<seq>` 往上翻 / `?session=<id>` / `?raw=1` 全类型 |
| POST | `/api/send` | body `{ "text": "..." }` → 存 USER 帧 + 叫醒 agent 循环 |
| GET | `/api/status` | 绑定地址、局域网入口、能做什么/不做什么、怎么关、统计 |

### /api/send 的返回要读清楚

```json
{ "ok": true, "stored": true, "turned": true, "turn": "started", "seq": 42, "session": "s_..." }
```

- `stored: true` —— 这条消息**真的写进会话文件了**
- `turned: true` —— 真的叫醒了 agent 循环；`turn` 可能是 `started`（跑了）或 `queued`（上一轮还在跑，排队）
- `turned: false` —— **只存了，没有人会回答**。没注入 loop 时就是这样，hint 里会写明

**没有 loop 的时候它不会假装投进去了。** 老版在这一步上栽过：一条非法消息被塞进运行中的会话，
返回 `undefined` 被当成成功，真正的代价是目标会话那一轮直接失败。

## 并发

同一个会话**同时只跑一个 turn**（`makeTurnQueue`）。理由：两个 turn 各自读「最近 N 帧」再各自 append，
帧序会交错成 user,user,assistant,assistant，两个答案互相看不见对方那半句上下文。手机连点两下就会踩到。

多出来的消息排队（上限 8 条）；队列满了**拒收并明说「这条没存」** —— 不能既没跑又让人以为跑了。

## 性能上的一个真决定：只读文件尾巴

`/api/recent` **不调用** `store.load()` / `store.recent()` —— 它们把整个 `frames.jsonl` 读进内存并缓存。
本机实测有一个 **308MB** 的会话文件；手机每 5 秒刷新一次，那等于每 5 秒往堆里灌 308MB。

所以 `tailFrames()` 只读最后 `chat.tailBytes`（默认 512KB）：
- 从中间开始读时**知道头部被截了**（返回 `truncatedHead: true`，页面上能看出"还有更早的"）
- 第一行可能是半截的 —— 丢掉它，不静默假装完整

## 怎么接进主进程

这一版**没有改 `src/index.mjs`**（那不在这次的写域里）。要接上，加两处：

```js
// src/index.mjs 顶部
import { startMobileChat } from './chat/mobile.mjs';

// createServer(...) 之后
const chat = await startMobileChat({ store, loop, config, log: (m) => console.log('[chat] ' + m) })
  .catch((e) => ({ started: false, reason: e.message }));
if (chat.started) console.log('[chat] 手机 http://' + chat.urls[0]);
else console.log('[chat] 没起：' + chat.reason);
```

**注意**：接上之后 `node src/index.mjs` 就会把对话暴露到局域网（默认 `chat.enabled = true`，沿用老版"装上就活"）。
不想要就设 `AGENT_SOUL_CHAT=off`。

## 单独起

```
node src/chat/mobile.mjs                 # 默认 0.0.0.0:8898
node src/chat/mobile.mjs --port 8899
AGENT_SOUL_CHAT=off node src/chat/mobile.mjs    # 不起
```

★ 主进程如果在跑、两边又写同一个会话，会出现帧序交错（`store` 的 stamp 检测只能发现"变了"，不能仲裁"谁先"）。
**要么接进主进程，要么单独起，别两个都写同一会话。**

## 配置项（★ 设置面板里看不见）

| 键 | 默认 | 说明 |
|---|---|---|
| `chat.enabled` | `true` | 关掉整个通道 |
| `chat.host` | `0.0.0.0` | ★ 这个默认值就是整个模块的目的 |
| `chat.port` | `8898` | 老插件用的也是这个，两个同时对会 EADDRINUSE |
| `chat.session` | `null` | 留空 = 用最近说过话的那个会话 |
| `chat.recentLimit` | `40` | 一次回多少条 |
| `chat.maxTextChars` | `8000` | 单条进页面的上限（超出标 truncated） |
| `chat.maxBodyBytes` | `65536` | 请求体上限，超了 413 |
| `chat.tailBytes` | `524288` | 只读 frames.jsonl 的尾部这么多字节 |

**这八项在 `/settings` 页面里看不见** —— `CFG_GROUPS`（`src/web/server.mjs`）里没有登记 chat 组，
而那个文件不在本次写域。默认值写在 `src/chat/mobile.mjs` 的 `CHAT_DEFAULTS` 里；
`config.json` 里手写 `chat` 组会正常生效（`loadConfig` 是 deepMerge，未知键原样保留）。

## ★ Windows 上的一个真坑：两个进程能绑同一个端口号

实测（2026-11-07 本机）：8898 被老版 chat 插件（DSH 进程内，绑 `0.0.0.0`）占着，
8899 被老版 TTS 服务（绑 `127.0.0.1`）占着。

**Windows 允许 `0.0.0.0:P` 和 `127.0.0.1:P` 同时 bind，而更具体的那个先接走本机连接。**
于是会出现最难查的现象：**手机连得上（走局域网 IP → 我的 0.0.0.0），电脑上打开却是别人的页面（走 127.0.0.1 → 别人的）**。
而且 `listen()` 不会报 EADDRINUSE —— 它真的成功了。

所以 `startMobileChat()` 在绑完之后会**用 127.0.0.1 打自己一刀**（`verifyMyself`），
应答里没有 `service: "agent-soul mobile chat"` 就返回 `warning` 说清楚。**只警告不阻断**：
手机那条路确实是通的，硬失败等于把能用的东西一起关掉。

换端口最省事：`config.chat.port` 或 `AGENT_SOUL_CHAT_PORT`。

## 自检

```
node tools/chat-selftest.mjs
```

35 条断言，真的起服务、真的发请求、真的读磁盘。**连不上 / 端口被占 / 空会话 / 没 loop / 超大 body / 跨源 POST**
都有自己的断言 —— 这些是这一层最容易假装成功的地方。
