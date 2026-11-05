# Aurabot · 住在 QQ 里的大肥鱼

DeepSeek Harness（DSH）插件。DSH 里的 AI 以独立 QQ 号「大肥鱼」的身份住进 QQ：有人格、心情和记忆，能看图、发语音、听语音、发和收表情包、用自己的声音翻唱、写 QQ 空间日记、逛空间回评论、刷 B 站发评论，还会主动找你聊天。

```
QQ ⇄ SnowLuma（OneBot v11，你自己安装）⇄ Aurabot 插件 ⇄ DSH 会话（Aurabot 自带的 preset + 人格）
```

- **入口**：DSH 左侧栏「自动化任务」下面的「Aurabot」。整页面板用标签分功能：概览、连接、人格、权限、聊天、模型、语音、表情包、生图、空间日记、主动搭话、心情与记忆、翻唱、B站、本地接口、扩展、日志。
- **开放**：每项本事都是模块，能关、能替换、能复制一份来改；自己写的模块放在数据目录 `modules/`，升级不覆盖、保存即生效。连群聊插话策略、交给她的提示词、回复怎么拆、最终发出去什么、用哪个模型都能用模块改。说明见 [src/modules/API.md](src/modules/API.md)，不会写就让 DSH 照着写。
- **会话**：每个 QQ 私聊或群各对应一个 DSH 会话，都放在侧栏的「Aurabot · QQ」工作区里，可以点开看她想了什么、调了什么工具，也可以直接插话。
- **安全默认**：总开关关、试运行开。不手动打开，一句都不会发到 QQ。

## 安装

需要：DeepSeek Harness、一个用来当机器人的 QQ 小号，以及一个让机器人号上线的 QQ 网关：Windows 上用插件帮你管的 SnowLuma 最省事；Linux / Docker 或者已经有 QQ 机器人的，接你自己的 OneBot v11 服务就行（见下面）。

Windows 桌面版：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:accomplish07zrh-eng/dsh-aurabot-qq
```

Linux / Docker：用 DSH 自己的命令行（把 `<profile>` 换成你在用的 profile；在容器里就进容器执行）：

```bash
dsh plugin --profile <profile> add github:accomplish07zrh-eng/dsh-aurabot-qq
```

装好后重启 DSH，打开左侧栏「自动化任务」下的 **Aurabot**，跟着设置向导走：

1. 填机器人 QQ 号（用小号）和你的 QQ 号
2. 选 QQ 网关：
   - **用 SnowLuma**（Windows）：自己下载并解压 [SnowLuma](https://github.com/SnowLuma/SnowLuma/releases)，启动，在面板里同意它的协议（控制台密码自动生成），登录机器人号后点「接入机器人号」
   - **接我已有的 OneBot 机器人**：NapCat、LLOneBot、Lagrange、Docker 里的 SnowLuma 等任何 OneBot v11 实现都行。让它登录机器人号，把正向 WebSocket 地址（和 token，有的话）填进向导；HTTP 地址可选。插件只连接，不启动、不注入任何东西，连上后先核对登录的是不是机器人号
3. 先试运行，或直接上线

### Linux / Docker 上要知道的

- **语音**：edge-tts 装在插件自己的 Python 虚拟环境里，要有能建虚拟环境的 Python（Debian / Ubuntu 装 `python3-venv`），或者装了 [uv](https://docs.astral.sh/uv/)。Windows 自带语音这个兜底在 Linux 上没有。
- **刷抖音**：需要 Chrome / Chromium / Edge，而且不能用无头模式（抖音会拦）。没有桌面的服务器上用 Xvfb 之类的虚拟显示跑，比如 `xvfb-run` 启动 DSH，或在容器里起一个 Xvfb 再设 `DISPLAY`。浏览器路径可以在面板里填，也可以设环境变量 `CHROME_PATH`。
- **翻唱（RVC）**：目前只支持 Windows。
- 容器里的 DSH 连宿主机或别的容器上的 OneBot 服务时，地址要用容器能访问到的主机名 / 端口（不是 `127.0.0.1`）。

## 升级

再跑一遍上面的安装命令（拉取 GitHub 上的最新版），然后重启 DSH。设置、人格、记忆都会保留；有新版本时面板里也会提示。Windows 桌面版：

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile desktop add github:accomplish07zrh-eng/dsh-aurabot-qq
```

## 设计要点

| 方面 | 做法 |
|---|---|
| 人格注入 | 插件在 `cordis.patch.yml` 里自带两个 agent preset：`aurabot-private`（主人私聊，完整工具）和 `aurabot-social`（群聊和其他人私聊，没有任何本地工具）。人格通过 `@deepseek-ai/dsh-persona` 放在系统提示词最前，文本来自插件注册的提示词变量 `{{aurabot_persona}}`，切换人格无需重建 preset。 |
| 每轮变化的内容 | 心情、记忆用 `agent.ctx.systemPrompt.context()`，追加在对话末尾，不破坏前缀缓存。 |
| 群聊上下文 | 群里停顿几秒算一段，她回上一段时新消息先攒着，看完整段再回（不会一条一回）；交给她的是这一段谁说了什么、之前在聊什么，新消息带编号，想专门接某一条时可以引用回复。合并转发会展开成里面的聊天记录再给她；有人戳她（拍一拍）当成对她说的话，她也能戳回去。被叫必回，没人叫时按话题相关度插话，加入话题后接着聊；有防刷屏的刹车。 |
| 记忆 | 本地索引记忆库（中文二元切词 + BM25，再按「关于当前说话人」「重要程度」和遗忘曲线加权，越常被想起的忘得越慢）。来源：她自己记的、每天两次从聊天和空间动态里整理出来的、她自己的经历（唱了什么、评论了谁）、空间日记、你手动加的。整理时新事实先和旧记忆比对：补充旧的就合并，说明旧的过时了就把旧的标成「已过时」（不删，能恢复）。每个人有一张常驻的「人物小档案」，每个人 / 群还有「相处经验」和「说话方式」。想起的记忆带时间；对方只说「嗯嗯」时连上一句一起想；面板能看到最近几轮想起了哪几条；可以导入旧档案。 |
| 心情 | 默认按关键词，可选每轮用模型判一次（有把握才算，分得清她主动找人时的心意）；被夸、被凶会推动心情，按半衰期回到平常；心情明显时每轮告诉她该怎么说话，并实际影响发表情 / 语音的概率、回复快慢、插话积极程度。 |
| B 站 | 定时从她的兴趣、记忆里主人喜欢的东西和面板关键词里挑方向搜视频（WBI 签名），读简介、字幕和热评，再按人格决定评论 / 私聊分享给主人 / 记住什么；定时看别人回她的评论并接着回。主人在 QQ 里发 B 站链接或分享卡片，她用 `bili_watch` 看完再聊。看过、评过、回过的都记成她的经历。不碰关注、私信。 |
| 刷抖音 | 专用浏览器（独立的登录资料目录，Edge / Chrome / Chromium，经 CDP 控制，窗口放在屏幕外）。数据都走抖音网页自己的接口（在页面里 fetch，签名由页面脚本自动加，不自己算 a_bogus），不读屏：标题、分类、抖音给的内容摘要和分段、热评。一个个点开看（真的播放、停留），再按人格决定点赞 / 评论 / 分享给主人（抖音私信分享视频卡片、QQ 私聊发她的话 + 链接，或两边都发）/ 记住什么；特别想让主人看的，会在评论里真·@主人（用抖音自己的 @ 选人，按 sec_uid 认人，认不出就不发）。点赞 / 评论在弹层播放器里按视频 id 找按钮，点完等接口回应才算成功；页面看不见（锁屏）时用页面内事件。扫一次码登录（面板里显示登录弹窗截图）。打开面板不启动浏览器；验证码每次现查，遇到就当天停手。每天上限、两次操作间隔、新号前几天减半；4 项权限默认仅主人；总开关默认关。主人在抖音私信她，她会回（只认核对过的主人）；评论被抖音要求身份验证拦下时能认出来。 |
| 改资料 | 听人的话改她自己的 QQ 昵称 / 签名 / 头像（`qq_set_nickname` / `qq_set_signature` / `qq_set_avatar`，走 SnowLuma 扩展动作），以及 B 站签名 / 头像（`bili_set_sign` 最多 70 字；`bili_set_avatar` 收图片网址或 `last`=刚才发的那张图，最大 2MB，走 `x/member/web/face/update`）。面板「权限」页每个操作单独设 关 / 仅主人私聊（默认）/ 所有人；执行前按最新设置再查一遍，试运行只回话不真改。 |
| 按聊天选模型 | 主人可以让不同聊天用不同模型。面板「模型」页的「按聊天选模型」：两个下拉框选「私聊默认模型」「群聊默认模型」，要给某个 QQ / 某个群单独指定，展开下面的小列表添加一行（再点「移除」删掉）。优先级：这个私聊（QQ 号）> 这个群（群号）> 所有私聊 / 所有群默认 > 全局模型（「聊天用的模型」或 DSH 默认）；没选或选的模型在 DSH 里找不到，就自动用下一级。存在 `config.json` 的 `chatModels`（`privateDefault`、`groupDefault`、`privates`、`groups`，每项 `{ provider, model, reasoningEffort? }`），重启不丢，换了从那个聊天的下一条消息起生效。只有主人能改，聊天里的人说什么都换不了；扩展模块的 `model` 挂钩仍在这之后运行。 |
| 模块 | 除了核心（配置、QQ 网关、聊天中枢、人格、权限、面板），每项本事都是模块（`src/modules/`）。内核（`src/core/modules.js`）负责开关、替换、热重载和出错隔离：模块注册的工具、上下文、规则、命令、事件、定时任务、接口都记在它名下，停下时一起撤掉；聊天中枢用到表情、语音、心情、记忆时，找的都是当时在跑的那个模块。用户模块放在数据目录 `modules/`（升级不碰），和内置模块同名就是替换。扩展接口版本化，说明见 `src/modules/API.md`、类型见 `src/modules/aurabot.d.ts`（每次启动复制到 `modules/`）。聊天主流程留了改写挂钩：群聊决定、提示词、回复拆条、最终发送、模型选择、人格和规则。自己写的模块按快照加载（多文件、npm 依赖都能热重载），面板「扩展」页有模拟测试（截获发送，不真发）。 |
| 本地接口 | 语音合成、生图、翻唱换声、语音识别都能换成自己电脑上的模型或服务：面板生成带示例的脚本（放在数据目录 local/，升级不覆盖、改完即生效），也可以「复制给 DSH 的话」让 DSH 照接口说明帮你改。 |
| QQ 命令 | 主人在 QQ 里直接发 `/silent` `/active` `/quiet` `/chatty` `/model` `/sing` `/remember` `/status` 等管她，总开关关着也能用。 |
| 工具 | 由各模块提供，按会话注册（`agent.ctx.tools.register`），只出现在 Aurabot 的会话里。群管在工具层校验这一轮有主人下令、对象不是主人、她在群里有管理权限；点歌、生图校验「这一轮说话的人全是主人」，不只靠人格约束。 |
| QQ 网关 | OneBot v11：WS 收事件（实时），HTTP 调接口（没填 HTTP 就都走 WS）。用 SnowLuma 时插件从它的配置文件自动读取端口和令牌；接自己的 OneBot 机器人（`gateway: "onebot"`）时只连你填的地址，不启动、不注入任何东西。不管哪种，连上后都先用 `get_login_info` 核对登录的是不是机器人号。 |
| SnowLuma 管理 | SnowLuma 的 EULA 第 5.4 条不允许「通过自动化脚本部署」，所以插件不下载，也不替你同意协议：协议全文显示在面板里，由你本人勾选同意。插件只启停你自己装好的那一份（后台运行，不弹窗口）；第一次启动时用 `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD` 设一个自己生成的控制台密码。注入前用 `/api/processes` 核对每个 QQ 进程登录的号，只注入机器人号（SnowLuma 认不出号时，只在唯一一个认不出号的进程上注入，连上后用 `get_login_info` 核对，不是机器人号就断开并撤销）；`hookAutoLoad` 永远关。 |
| 语音 | TTS 用 edge-tts（装在插件自己的 Python 虚拟环境里，Windows / Linux / macOS 都行），也可以接本地的 CosyVoice、GPT-SoVITS；Windows 上装不上时用 Windows 自带中文语音兜底。ASR 先用 QQ 自带的语音转文字（`fetch_ptt_text`），再试 DSH 的 `speechToText`。 |
| 表情包 | 只收真正的表情（`sub_type=1`、mface、带 `emoji_id` 的），再过尺寸、宽高比、体积、MD5 去重、每小时限额几道关。收下后 `add_custom_face`，视觉模型起备注后 `modify_custom_face`。商城表情按商城表情原样发；面板里能改表情的名字和标签；关掉表情包后回复里写的表情也不发。 |
| 空间 | 空间日记用 `send_qzone_msg`，在专用的后台会话里写，结合当天聊天流水。空间互动：定期看自己说说下的新评论和回复（按整串评论来回，一串只回一次），逛好友动态按概率点赞、评论；评论时结合说说内容和楼里已有的评论。 |
| 翻唱 | 点歌（`qq_song_cover` 工具或 `/sing`）→ 网易云下载（weapi，可填 Cookie 下会员歌）→ 先截要发的那一段 → audio-separator 分离人声和伴奏 → Applio（RVC，固定版本）换成她的音色 → ffmpeg 混音 → 发语音条。插件不带音色，用户在面板里导入自己有权使用的 .pth / zip。一键安装不依赖电脑上的 Python / git / uv，可以选装到哪个盘，进度可见，下载走系统代理并能断点续传。 |

## 目录

```
src/host.js            插件入口（宿主半边）：核心 + 面板接口 /aurabot/api/*
src/core/modules.js    模块内核：加载、开关、替换、热重载、出错隔离
src/modules/           12 个内置模块 + 扩展接口说明 API.md + 类型 aurabot.d.ts + 新模块模板
src/chat/              消息中枢、群聊策略、回复解析、白名单与权限
src/onebot/client.js   OneBot v11 客户端（HTTP + WS，自动重连）
src/snowluma/          SnowLuma 管理（检测、启停、只注入机器人号）
src/features/          表情包、空间日记和空间互动、心情、记忆、主动搭话、生图
src/song/              翻唱：网易云、安装器、分离 / 变声 / 混音流水线、音色导入
src/voice/             文字转语音、WAV 处理
src/tools/tools.js     工具的写法（defineTool）
src/persona/           人格卡与规则
client/client.js       网页半边：侧栏入口 + 面板
personas/dafeiyu.md    默认人格「大肥鱼」
cordis.patch.yml       插件与两个 preset 的挂载声明
test/                  单元测试 + 端到端测试（假 DSH 宿主 + 模拟 OneBot）
```

## 可选扩展

[逛贴吧（只读）](extensions/tieba-reader/README.md) 支持搜索、看帖、首页推荐／热门、配置贴吧定时浏览和给主人分享。以独立用户模块构建安装，自动浏览默认关闭，不提供发帖、回帖或点赞接口。

## 测试

```
npm test
```

## 数据位置

`%USERPROFILE%\.dsh\plugins-data\aurabot\`：配置、人格、表情库、日记、记忆、日志，还有自己写的模块（`modules/`）和本地接口脚本（`local/`）。重装、升级插件都不会丢。

## 联系我们

- **协作 / 交流 QQ 群**：**554850395**（项目维护和想法讨论都在这里；装不上、报错了也可以进来问，尽量先带上面板「日志」里的报错和版本号）
- **GitHub**：[issue](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/issues) 报 bug / 提需求，[PR](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq/pulls) 提代码；提之前先翻一下有没有重复。贡献者名单见版本说明和 PR 记录。

## 致谢

参考了 [Yuuyuko-uu](https://github.com/Yuuyuko-uu) 的 dsh-qq-bridge、dsh-speak-up、dsh-feiyu-mood、dsh-fish-memory 等插件（MIT）在 DSH 插件机制上踩过的坑，具体是：注销器是函数而不是 `.off()`；`followup` 必须 await；心情别每轮都提。没有复制它们的代码。

---

## 本 fork 的改造（砚青 / agent-soul）

上游：[`accomplish07zrh-eng/dsh-aurabot-qq`](https://github.com/accomplish07zrh-eng/dsh-aurabot-qq)（MIT）。
本 fork 只做一件事：让 QQ 侧的「她」使用 agent-soul 定义的 agent preset，而不是插件自带的 preset。

| 改动 | 位置 | 说明 |
|---|---|---|
| `presetFor()` 分级 | `src/chat/access.js` | 主人私聊 → 本体 preset；群聊/陌生人 → 受限 preset |
| 事件层模块 | 不在本仓 | 见 `cyanwell/dsh-agent-soul` 的 `aurabot-modules/lead-relay` |

### 用你自己的 preset

默认值指向 agent-soul 提供的 `yanqing-qq` / `yanqing-qq-social`。
**没有这两个 preset 时，请改成插件自带的**（见 `cordis.patch.yml` 的 `preset-aurabot-*`），
在 `$DSH_HOME/plugins-data/aurabot/config.json` 里加：

```json
"presets": { "private": "aurabot-private", "social": "aurabot-social" }
```

改完需重启，preset 在新建会话时读取。
