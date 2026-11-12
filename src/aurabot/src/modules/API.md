# Aurabot 扩展接口说明（插件 v{{VERSION}} · 扩展接口 v{{API}}）

> 这个文件由插件维护，每次启动都会更新成当前版本，**别改它**（改了也会被覆盖）。
> 你自己写的模块放在和它同一个文件夹（`modules/`）里，插件升级不会动。

大肥鱼的每项本事都是一个**模块**：表情包、语音、心情、记忆、空间日记、B 站、翻唱、生图……
你可以：

- **加新模块**：给她新本事（查天气、接智能家居、关键词回复、对接自己的服务……）
- **关掉内置模块**：面板「扩展」页一个开关
- **替换内置模块**：写一个**同名**的模块，内置的就不加载了，用你的
- **复制内置模块来改**：面板「扩展」页点「复制一份来改」，内置模块的源码会复制到 `modules/<id>/`，改完保存就生效

## 目录

1. [最小的模块](#最小的模块)
2. [模块定义](#模块定义)
3. [api：模块能用的东西](#api模块能用的东西)
4. [事件](#事件)
5. [工具](#工具)
6. [面板](#面板)
7. [内置模块和它们导出的东西](#内置模块和它们导出的东西)
8. [替换内置模块](#替换内置模块)
9. [测试](#测试)
10. [内部源码](#内部源码)
11. [升级会不会坏](#升级会不会坏)
12. [排查问题](#排查问题)

## 最小的模块

`modules/hello/index.mjs`：

```js
/** @type {import('../aurabot').AurabotModule} */   // 有这一行，编辑器就有补全（类型在 modules/aurabot.d.ts）
export default {
  id: 'hello',          // 和文件夹名一样
  name: '打招呼',
  api: 1,
  setup(api) {
    api.on('message', async (msg) => {
      if (msg.text !== '你好') return false
      await api.send(msg.chatId, '你好呀～')
      return true        // 这条我处理了，她不再回
    })
  },
}
```

保存后几秒内自动加载，不用重启。面板「扩展」页能看到它在不在跑、有没有报错。

- 入口文件叫 `index.mjs`（或 `index.js`，但要是 ES 模块写法）
- 文件夹名以 `_` 或 `.` 开头的不加载（可以拿来放草稿）
- **可以拆成多个文件**：`import { x } from './util.mjs'`、子文件夹都行。模块文件夹里**任何文件**改了、加了、删了，几秒内整个模块重新加载
  （插件每次把文件夹拍一份快照到 `modules/<id>/.aurabot-cache/` 再加载；这个文件夹别动，也别往里写东西）
- 读模块自带的数据文件用 `join(api.dir, 'data.json')`（`api.dir` 是模块文件夹；`import.meta.url` 指向的是快照）。要写的数据放 `api.dataDir()`

### 用 npm 包

在模块文件夹里装，和普通 Node 项目一样：

```powershell
cd "$env:USERPROFILE\.dsh\plugins-data\aurabot\modules\weather"
npm init -y
npm install cheerio
```

然后 `import * as cheerio from 'cheerio'` 就能用（`node_modules` 不会被拍进快照，但快照在模块文件夹里面，Node 往上找得到）。
Node 自带的 `fetch`、`node:fs` 这些直接用，不用装。

## 模块定义

```js
export default {
  id: 'weather',              // 必填：小写字母开头，小写字母 / 数字 / -，2~40 个字；和文件夹名一样
  name: '查天气',             // 面板上显示的名字
  version: '0.1.0',           // 你自己的版本号，随便写
  api: 1,                     // 按哪一版扩展接口写的（现在是 {{API}}）
  description: '一句话说明',
  defaults: { city: '北京' }, // 设置的默认值
  settings: [                 // 面板自动生成设置表单（见「面板」）
    { key: 'city', label: '城市', type: 'text' },
  ],
  panel: 'panel.js',          // 可选：自己画面板（见「面板」）
  tab: 'song',                // 可选：设置和面板放进哪个内置标签页（不写就单独一页，见「面板」）
  setup(api) {                // 必填：启动时调用一次，可以是 async
    // 在这里注册事件、工具、命令、定时任务……
    return { /* 导出给别的模块用的东西 */ }
  },
}
```

`setup` 返回的对象就是这个模块的**导出**。别的模块 `api.use('weather')` 拿到它。
导出里有 `dispose()` 的话，模块停下时会调用。

## api：模块能用的东西

另外 `api.id`（模块 id）、`api.source`（`builtin` / `user`）、`api.version`（插件版本）、`api.apiVersion`（扩展接口版本）可以直接读。

**配置**

| | |
|---|---|
| `api.config()` | 插件的整份配置（只读，看 `~/.dsh/plugins-data/aurabot/config.json`） |
| `api.setConfig(patch)` | 改配置：传对象就深合并，传函数 `(cfg) => 新cfg` 就整个换 |
| `api.settings()` | 这个模块的设置（`defaults` + 面板里填的） |
| `api.saveSettings(patch)` | 改这个模块的设置 |
| `api.dir` | 模块自己的文件夹（读自带的数据文件用） |
| `api.dataDir(...路径)` | 这个模块专用的数据文件夹（`plugins-data/aurabot/modules-data/<id>/`），自动建好 |
| `api.log.info / warn / error / debug(...)` | 写日志（面板「日志」页能看，自动脱敏） |

**发消息**（总开关、试运行照常管着：关着 / 试运行时只写日志）

| | |
|---|---|
| `api.send(chatId, text)` | 用她平时的方式发：会拆条，能带 `<voice>…</voice>`、`<sticker:名字>`、`<poke>`，会经过 `reply` 事件 |
| `api.sendText(chatId, text)` | 原样发一条文字 |
| `api.reply(msg, text)` | **回某一条消息**：群里以「引用回复」发出（大家能看出在回谁），私聊直接发 |
| `api.sendImage(chatId, 图片路径或网址)` | 发图 |
| `api.sendFile(chatId, 文件路径或网址, 文件名?)` | 把文件（文档、压缩包、音频、视频……）当文件发过去。要先在面板「聊天」页打开「发文件」；本机文件给**绝对路径**，而且只能在 QQ 工作区或主人在面板里加的目录里；单个文件有大小上限（默认 50 MB）。网关在别的机器 / 容器里看不到本机路径时，小文件会自动改用 base64 再试一次 |
| `api.sendVoiceFile(chatId, 音频文件, 日志备注?)` | 把本机一个音频文件当语音条发出去（不走「念文字」） |
| `api.sendSegments(chatId, [OneBot 消息段], 日志备注)` | 发任意 OneBot 消息段 |
| `api.onebot(action, params)` | 直接调 OneBot（SnowLuma）的任意 API，比如 `api.onebot('get_group_member_list', { group_id: 123 })` |

`chatId` 的格式：`private:QQ号`、`group:群号`（她后台自己想事情用的会话是 `system:名字`，工具生成函数里可能见到，发不了消息）。

判断是不是主人：`api.isOwner(msg.userId)`。

**用模型**

| | |
|---|---|
| `api.ask({ system, text, maxTokens })` 或 `api.ask('一句话')` | 直接问一次模型（不带人格、不进会话），返回文字 |
| `api.think(prompt, { title, timeoutMs })` | 让**她**（带人格、记忆）想一想，返回她的回答（不会自动发出去；默认最多等 3 分钟） |

**联网**：直接用 Node 自带的 `fetch`（会走系统代理），记得加超时：`fetch(url, { signal: AbortSignal.timeout(8000) })`。插件不另外提供代理设置。

**往插件里加东西**（模块停下时自动撤掉，都返回一个「撤掉」函数）

| | |
|---|---|
| `api.on(事件, fn)` | 听事件（见下一节） |
| `api.emit(事件, ...参数)` | 发事件给别的模块 |
| `api.tool(fn 或 工具)` | 给她加工具（见「工具」） |
| `api.defineTool({ name, description, properties, required, execute })` | 做一个工具 |
| `api.context(({ chat, sessionId }) => '文字')` | 每轮聊天前塞进她上下文的话（比如「现在北京 20 度」）；返回空串就不塞 |
| `api.rule((kind, cfg) => '一条规则')` | 补一条她的规则（会放进系统提示词；kind 是 `private` 主人私聊 / `social` 群聊和别人）。告诉她「你会查天气，用 xxx 工具」就写在这里。可以直接给字符串、也可以返回多条（数组）；函数**每一轮都会重新调用**，所以里面可以拼当前设置 |
| `api.command({ name, aliases, desc, run(arg, msg) })` | 主人在 QQ 里发 `/name 参数` 时调用，`run` 返回的文字直接回到**发命令的那个聊天**（群里发就回群里）。名字可以是中文（`name: '天气'`），中文命令后面可以不加空格（`/天气北京`）；`arg` 是命令名后面剩下的全部文字，已经去掉首尾空格。**只认主人**：别人发 `/xxx` 当普通消息处理。和内置命令同名时你的优先 |
| `api.every(毫秒, fn, 名字?)` | 定时任务（名字用在出错日志里） |
| `api.later(毫秒, fn)` | 过一会儿做一次 |
| `api.route('/路径', async (req, res) => 返回值)` | 加一个网页接口：地址是 `/aurabot/api/ext/<id>/路径`；返回对象就当 JSON 回；要自己回（比如图片）就用 `api.core.http.send(res, 200, buf, 'image/png')` |
| `api.onDispose(fn)` | 模块停下时要做的收尾 |

**别的模块和插件内部**（全开放）

| | |
|---|---|
| `api.use('memory')` | 拿到某个模块**现在**的导出；模块没在跑返回 `null`。不要在 setup 里拿了存着，用的时候再拿（对方可能被关掉、被替换） |
| `api.lazy('memory')` | 一个代理，每次访问都去找当时在跑的那个模块：`const memory = api.lazy('memory'); memory.add?.({...})`（模块没在跑时属性是 undefined，所以用 `?.`） |
| `api.has('memory')` | 某个模块在不在跑 |
| `api.core` | 插件核心，见下 |
| `api.dsh` | DSH 给插件的 `ctx`：`api.dsh.get('服务名')` 能拿到 DSH 的任何服务（`llm`、`speechToText`、`tools`……） |
| `api.lib('features/memory.js')` | 插件里任何一个源码文件导出的全部东西（见「内部源码」） |

`api.core` 里有：

| | |
|---|---|
| `hub` | 聊天中枢：`deliver(chatId, text)` `sendText` `sendVoice(chatId, 文字)` `sendVoiceFile(chatId, 音频文件)` `sendImage` `sendSticker(chatId, 名字)` `sendSegments` `runSystemTurn(名字, 标题, 提示词)` `pushToSession(...)` `resetChat(chatId)` `groupName(群号)` `turnHasOwner(sessionId)` `chatOfSession(sessionId)` `stats()` `sessions()` `chatLogOf(日期)` `lastChatAt` `lastOwnerChatAt` …… |
| `onebot` | QQ 网关：`call(action, params, { timeoutMs })`、`state` |
| `snowluma` | SnowLuma 管理：`running()` `start()` `stop()` `detect()` …… |
| `local` | 本地接口（「本地接口」页那四项）：`active(slot)` `call(slot, 参数)` |
| `groupRoles` | 她在各群的身份：`get(群号)` `canManage(role)` `label(role)` |
| `mutes` | 闭嘴状态：`muted(chatId)` `set(chatId, 分钟)` `clear(chatId)` |
| `ask(opts)` | 同 `api.ask` |
| `listModels()` / `defaultModel()` | DSH 里的模型 |
| `http` | 写接口用的小工具：`body(req)` 读 JSON、`raw(req, 最大字节)` 读原始内容、`query(req)` 读网址参数、`send(res, 状态码, 内容, 类型)` |
| `personas` | 人格：`list()` `read(id)` `current()` |
| `modules` | 模块内核本身（`status()` `reload(id)` ……） |
| `getConfig()` / `setConfig(cfg)` | 同 `api.config` / 整份替换配置 |
| `logger` | 插件的日志器（`logger.child('名字')` 拿一个分类） |
| `root` | 插件自己的安装目录 |

## 事件

`api.on(名字, fn)`：

| 事件 | 参数 | 说明 |
|---|---|---|
| `message` | `msg` | 收到一条**她会处理的**消息（白名单内、不是主人命令、总开关开着、没闭嘴）。**群里每一条都会来，在「回不回」的决定之前**——所以没人 @ 她的消息你也能接管。**返回 true = 你接管了**，她不再处理；返回 false 或不返回 = 不管；多个模块按加载顺序问，第一个返回 true 的接管 |
| `poke` | 原始戳一戳事件 | 有人戳她。返回 true = 你接管了 |
| `reply` | `text, { chatId, userText }` | 她要发一段话之前。**返回新文字 = 改写**；返回 `null` = 这次不发；不返回 = 不改 |

**改她怎么想、怎么说**（下面这些都是「改写」：返回新值就换掉，返回 `null` 就拦下，不返回就不改；多个模块按顺序一个接一个改）：

| 事件 | 参数 | 改的是什么 |
|---|---|---|
| `group/decide` | `decision, { msg, policy, recentTexts, memScore }` | 群里这条消息（没被 `message` 接管的）她**回不回、怎么回**。返回 `null` 在这里无效（等于不改）。`decision` 是 `{ reply, mode, reason }`，mode 是 `must`（被叫到）/ `engaged`（正在参与话题）/ `interject`（插话）。返回 `{ reply: true, mode: 'must' }` 就让她必回，`{ reply: false }` 就让她不理。想整套换掉插话策略就在这里写 |
| `prompt` | `content, { chat, senderId, queryText }` | **交给她的内容**：`[{ type: 'text', text }, { type: 'image', … }]`。可以加背景信息、改格式、去掉图片；返回 `null` 这次不交给她 |
| `reply/items` | `items, { chatId, text, userText }` | 她的回复**拆好之后**（哪条发语音、配不配表情都已经决定了）：每条 `{ kind: 'text' \| 'voice' \| 'sticker' \| 'poke' \| 'image', value, replyTo }`。可以改顺序、全部变语音、去掉表情、加图片 |
| `send` | `message, { chatId, note, force }` | **最终发给 QQ 的消息段**（OneBot 格式）。所有发出去的消息都经过这里：她的回复、命令回复、模块发的。加签名、过滤词、抄送到别处都在这里 |
| `model` | `selection, chat` | **这个聊天用哪个模型**（同步，不能 async）：返回 `{ provider, model, reasoningEffort }`。比如群里用便宜的、私聊用好的。`selection` 是面板选的（没选时是 DSH 默认，拿不到时是 `null`），主人在面板里「按聊天选模型」设过的话，已经按那个聊天算好了；模块在它之后还可以再改。换了之后从这个聊天的下一条消息起生效 |
| `persona` | `text` | **她的人格**全文（同步）：返回新文字就换掉 |
| `rules` | `text, kind` | **她的规则**全文（同步，kind 是 `private` / `social`） |

例子：群里只在被 @ 时说话，私聊用另一个模型，所有回复末尾加个尾巴：

```js
api.on('group/decide', (d, { msg }) => (msg.mentioned ? { reply: true, mode: 'must' } : { reply: false, reason: '只在被 @ 时说话' }))
api.on('model', (sel, chat) => (chat.kind === 'private' ? { provider: 'deepseek', model: 'deepseek-chat' } : undefined))
api.on('reply/items', (items) => [...items, { kind: 'text', value: '—— 大肥鱼' }])
```

**只看不改的**：

| 事件 | 参数 | 说明 |
|---|---|---|
| `activity` | `{ kind: 'in' \| 'out', chatId, userId, nickname, text, reply, direct, owner }` | 收到的消息 / 她发出去的话（只看不拦） |
| `onebot` | 原始 OneBot 事件 | **所有**事件：消息、加群、退群、撤回、好友申请、戳一戳……（只看不拦；不管白名单） |
| `onebot/state` | `'connected'` 等 | QQ 网关连上 / 断开 |
| `config` | `新配置, 旧配置` | 配置改了 |
| `module/start` / `module/stop` | 模块 id | 有模块启动 / 停下 |
| `song/sung` | `{ title, chatId }` | 翻唱模块唱完一首 |
| 你自己 `api.emit` 的 | 随你 | 模块之间互相通知 |

`msg` 长这样（`text` 是纯文字：@ 她的那段去掉了，@ 别人的写成「@昵称」，图片 / 表情 / 文件写成「[图片]」这类占位；引用的那条消息的文字**不在**里面，要的话用 `replyId` 去 `api.onebot('get_msg', { message_id })` 拿）：

```js
{
  kind: 'private' | 'group',
  chatId: 'private:123' | 'group:456',
  userId: '123', groupId: '456', nickname: '昵称（群名片优先）', role: 'owner' | 'admin' | 'member' | '' /* 在群里的身份 */
  text: '纯文字内容', messageId: '…', mentioned: true /* @了她 */, replyId: '…' /* 引用的消息 */,
  images: [...], stickers: [...], records: [...] /* 语音 */, forwards: [...] /* 合并转发 */,
  raw: { /* 原始 OneBot 事件 */ },
}
```

## 工具

工具是**她自己决定什么时候用**的能力（和命令不同，命令是主人手动发）。

```js
api.tool(({ chat, level, sessionId }) => {
  // chat：当前聊天 { chatId, kind: 'private' | 'group' | 'system', userId, groupId }
  // level：'full' 主人私聊（完整权限）/ 'social' 群聊和别人 / 'chat'（没有工具）
  if (chat.kind === 'system') return []         // 不给就返回 []
  return api.defineTool({
    name: 'weather_now',                         // 字母、数字、_，别和别的工具重名
    description: '查某个城市现在的天气。别人问天气时用。',
    properties: { city: { type: 'string', description: '城市名' } },
    required: ['city'],
    execute: async ({ city }) => {
      // 返回 { ok, message }：message 是给她看的结果
      return { ok: true, message: `${city} 晴 20 度` }
    },
  })
})
```

- 可以返回一个工具或一组工具；不给就返回 `[]`（`null` 也行）
- `required` 不写就是都可选；`execute` 的第二个参数是 DSH 传来的执行信息（一般用不到）
- 返回 `{ ok: false, message: '原因' }` 时，她会看到失败原因，通常会用自己的话告诉对方没成功；抛出的错误也会变成这样
- 工具的生成函数每次挂工具时调用（会话第一次用到、工具清单变化时），不是每次调用工具都调
- 只想给主人用：在 `execute` 里判断 `api.core.hub.turnHasOwner(sessionId)`
- 工具的名字和描述尽量别经常改：改一次，DeepSeek 的缓存就失效一次
- 想让她**知道**自己有这个本事，再加一条 `api.rule(() => '你会查天气：别人问天气时用 weather_now')`

## 面板

**自动表单**：写了 `settings`，面板会多一个这个模块的标签页，自动生成设置表单，用户改完点保存。
定义里写了 `tab: '内置标签页'`（`voice` `stickers` `imagegen` `diary` `speakup` `mood` `song` `bili` `douyin` `local` `group` `model` `persona` `access` `connect` `overview`），设置和面板就放进那一页的最下面，不单独占一页。比如给翻唱加功能的模块写 `tab: 'song'`。

```js
settings: [
  { key: 'city', label: '城市', type: 'text', hint: '下面的小字说明', placeholder: '北京' },
  { key: 'times', label: '每天几次', type: 'number', min: 0, max: 10, step: 1 },
  { key: 'on', label: '开关', type: 'switch' },
  { key: 'mode', label: '模式', type: 'select', options: [{ value: 'a', label: '模式 A' }, { value: 'b', label: '模式 B' }] },   // 也可以直接 ['a', 'b']
  { key: 'list', label: '多行', type: 'textarea' },
  { key: 'apiKey', label: 'API Key', type: 'password' },   // 密码：面板不回显，日志里自动打码
]
```

存下来的类型：`number` 是数字、`switch` 是 `true / false`，其余是字符串。改了设置**不用重载模块**，`api.settings()` 每次读的都是最新的（别在 setup 里读一次存着）。

**自己画面板**：模块文件夹里放 `panel.js`，定义里写 `panel: 'panel.js'`（写 `true` 也是找 `panel.js`；不写就没有自定义面板）。它是一段函数体，面板会这样执行：

```js
// panel.js —— 拿到 React、h（React.createElement）、ui（面板自带的组件）、call（调你的接口）
// 最后 return 一个 React 组件
const { useState } = React
return function Panel({ settings, save, toast }) {
  const [n, setN] = useState(0)
  return h(ui.Card, { title: '我的面板' },
    h('p', null, '城市：' + settings.city),
    h(ui.Btn, { onClick: async () => { const r = await call('/hi'); toast(r.message || 'ok') } }, '调一下接口'))
}
```

- `call(路径, 请求体?)`：调你用 `api.route` 加的接口（不带请求体就是 GET）
- `settings` 是当前设置，`save(patch)` 保存设置，`toast(文字)` 弹提示
  - `draftSettings` 是页面尚未保存的设置；`setSettings(patch)` 只更新当前模块的页面草稿，不立即写入。使用这两个属性可与原生表单共用底部“保存设置”、撤销和离开提醒。`settings` 与 `save` 仍保留原行为，兼容已有面板。
- `ui` 里有：`Card` `Btn` `Switch` `Row` `Empty` `Select`；样式类名可以用面板的 `ab-input` `ab-note` `ab-muted` `ab-small` 等
- 改了 panel.js 回到面板切一下标签页就是新的

## 内置模块和它们导出的东西

| id | 名字 | 导出（`api.use(id)` 拿到的） |
|---|---|---|
| `stickers` | 表情包 | `library()` `match(名字)` `pickForReply(文字)` `collect(消息段, chatId)` `addFromBuffer(buf, { name, tags })` `rename(md5, 名字, 标签)` `remove(md5)` `segmentFor(item)` |
| `voice` | 语音 | `speak(文字) → { file, engine }` |
| `mood` | 心情 | `state()` `label()` `nudge(变化量, 原因)` `effects()` `contextLine()` |
| `memory` | 记忆 | `add({ text, about, aboutName, importance, tags, source })` `addEvent({ text, about, tags, importance })` `recall(查询, { about, limit })` `list(查询)` `remove(id)` `update(id, 改动)` `contextFor(chat, sessionId)` `topicScore(文字)` `profiles()` `consolidate()` …… |
| `qq-tools` | 基础 QQ 工具 | （只有工具：`qq_chat_history`、`qq_send_message`、`qq_send_file`） |
| `group-admin` | 群管 | （只有工具：`qq_group_admin`） |
| `imagegen` | 生图 | `enabled()` `generate(描述) → Buffer` |
| `diary` | 空间日记 | `writeDiary()` `post(正文, { images, visibility })` `remove(tid)` `history()` `nextTime()` |
| `qzone-social` | 空间互动 | `run({ force })` `state()` |
| `speakup` | 主动搭话 | `fire(原因)` `state()` |
| `bili` | B 站 | `watch(链接)` `comment(链接, 文字)` `run()` `checkReplies()` `account()` `state()` |
| `douyin` | 刷抖音 | `run` `browse` `watch` `likeVideo` `commentVideo` `confirmOwner` `account` `loginStep` `showWindow` `state`；工具 `douyin_watch` / `douyin_browse` / `douyin_like` / `douyin_comment` |
| `song` | 翻唱 | `request({ song, pitch, chatId })` `search(关键词)` `status()` `install()` |

聊天中枢需要的时候会去找 `stickers`（发表情、偷表情）、`voice`（发语音）、`mood`（心情影响表情 / 语音频率）、`memory`（群聊插话判断）。
这几个被关掉，对应的事就不做（想发语音时改发文字）；被替换，就用你的——所以替换时**导出的函数名要和上表一样**。

## 替换内置模块

1. 面板「扩展」页，在要替换的内置模块那一行点「复制一份来改」
2. `modules/<id>/` 里出现 `index.mjs` 和它用到的实现文件（比如 `qzone.js`），开头注释写着从哪个版本复制的
3. 改，保存。几秒内面板显示「用的是你的版本」
4. 想临时用回内置的：那一行的「用内置的」开关；想彻底不要了：删掉文件夹

复制出来的文件里，原来指向插件其他文件的 `import`，改成了 `const { … } = __lib('core/store.js')` 的写法（`globalThis.aurabot.lib`），所以放在 `modules/` 里也能找到插件的源码。

**你的版本加载失败时，会先自动用回内置的**（面板上能看到报错），所以写坏了不会让她突然少一项本事。

## 测试

不用上 QQ 也能试：面板「扩展」页的「模拟测试」——

- **模拟一条消息**：选你是主人还是别人、私聊还是群聊，写一句话，看它会被哪个模块接管、命令回了什么；再写一句「她的回复」，看经过各个模块改写后最后会发出去什么
- 你的模块加的 `/命令` 在模拟里**会执行**（看 `run` 回了什么）
- **调用工具**：选一个工具、填参数（JSON），直接调用，看返回值
- 这期间**发出去的消息只截下来显示，不会真发到 QQ**。但模块直接调 `api.onebot(...)` 的操作（禁言、发空间……）不在此列，是真的会执行的
- 内置命令（`/off` 这些会改设置的）模拟里不执行

## 内部源码

`api.lib('路径')` 能拿到下面任何一个文件导出的全部东西（路径相对插件的 `src/`）：

{{LIB}}

这些是插件内部的实现，**全开放，但不保证**：升级时函数名、参数可能变。
写模块尽量用 `api.*` 和内置模块的导出（上面的表），那些会尽量保持不变。

## 升级会不会坏

- **你的文件**：`modules/` 里的东西插件升级不碰
- **`api.*` 和内置模块导出表**：同一个扩展接口版本（现在是 v{{API}}）里**只加不改**。哪天不得不改，接口版本升到 2，更新说明里写清楚怎么迁移；插件会拒绝加载版本对不上的模块，并在面板上告诉你原因，不会默默出错
- **`api.core`、`api.lib`、`api.dsh`**：插件内部和 DSH 的东西，全开放但可能随版本变。用了它们的模块，升级后留意面板「扩展」页的报错
- **复制出来改的内置模块**：是你的分叉。内置的版本更新了，面板会提示「内置版本更新了」，你可以对照着把新改动合进去，或者删掉文件夹用回内置的

## 排查问题

- 面板「扩展」页：每个模块在不在跑、用的是内置的还是你的、启动报错、运行中最近的报错
- 面板「日志」页：模块的日志按模块 id 分类
- **安全模式**：「扩展」页打开后，你写的模块一个都不加载，内置的全部恢复。用来判断「是我的模块的问题还是插件的问题」
- 不会写？在「扩展」页点「复制给 DSH 的话」，粘给 DSH，写上你想要什么，它会读这份说明帮你写
