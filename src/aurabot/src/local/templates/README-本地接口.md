# Aurabot 本地接口

这个文件夹里的脚本可以接管大肥鱼的几项能力，换成你电脑上自己的模型或服务。
插件升级不会动这个文件夹。脚本改完保存就生效，不用重启 DSH。

| 文件 | 接管什么 | 什么时候用 |
|---|---|---|
| `tts.mjs` | 语音合成（她发的语音条） | 每次她要发语音 |
| `image.mjs` | 生图 | 她调用画图工具时 |
| `song-convert.mjs` | 翻唱里「人声 → 她的声音」这一步 | 每次翻唱（下载、分离、混音、发送还是插件做） |
| `asr.mjs` | 别人发来的语音条转文字 | 收到语音条时最先试 |

每个文件要在面板「本地接口」页**打开开关**才会用；文件不存在或开关关着，就用插件内置的方式。

## 写法约定

- 是 Node.js 的 ES 模块（`.mjs`），`export default async function (参数) { ... }`。
- 可以用 Node 自带的一切：`fetch`、`node:fs`、`node:child_process`（调你的 Python 项目）……不能 `npm install` 第三方包。
- 出错就 `throw new Error('原因')`：语音、识别会退回内置方式；生图、翻唱会让她告诉对方没成功和原因。
- 用参数里的 `log.info()` / `log.warn()` 打日志，会出现在面板「日志」页。
- 超时：语音 60 秒、识别 60 秒、生图 5 分钟、翻唱换声 20 分钟。

## 各脚本的参数和返回值

### tts.mjs
- 参数：`{ text, outDir, log }`
- 返回：音频文件路径（wav / mp3 / silk），或 `{ file }`

### image.mjs
- 参数：`{ prompt, size, outDir, log }`（`size` 形如 `"1024x1024"`，`prompt` 已带上面板里的固定风格）
- 返回：图片 `Buffer`，或 `{ buffer }` / `{ file }` / `{ base64 }` / `{ url }`

### song-convert.mjs
- 参数：`{ input, output, pitch, voice, voiceFile, indexFile, log }`
  - `input`：分离出来的人声 wav；`output`：要写出的 wav 路径
  - `pitch`：变调半音；`voice`：面板里选的音色名；`voiceFile` / `indexFile`：导入过的 .pth / .index 路径（可能为空）
- 返回：换好声音的 wav 路径（一般就是 `output`）
- 开了这个之后，翻唱不再需要内置的 Applio 和音色模型（人声分离环境还是要装）

### asr.mjs
- 参数：`{ file, log }`（`file` 是 16kHz 单声道 wav）
- 返回：识别出的文字，或 `{ text }`；听不清返回空字符串

## 让 DSH 帮你改

在面板「本地接口」页点「复制给 DSH 的话」，粘给 DSH，再补一句你用的是什么服务、地址和关键参数，它会读这份说明、帮你把脚本改好。
