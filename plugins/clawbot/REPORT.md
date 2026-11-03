# 上报接入点文档

本文档说明 dsh-clawbot「上报」功能的行为，以及你的服务器如何**接收、解析、处理**上报的数据。

---

## 1. 概述

当你在设置页「上报」区块配置了**服务器地址**，并满足上报条件时，插件会把微信发来的消息**原样**以 HTTP POST 推送到你的服务器。

上报触发条件（三选一命中即上报）：

| 条件 | 说明 |
|---|---|
| 「启用上报」开关**开启** + 已填地址 | 每条消息都上报 |
| 「启用上报」开关**关闭** + 已填地址 + 填了「前缀词」+ 消息以该前缀开头 | 仅该条消息单次上报（正文**去掉前缀词**后上报） |
| 唤醒词 / 关闭词 | 仅用于切换开关，**不触发上报** |

> 前置条件：总「监听」开关必须开启，插件才会轮询并收到消息。

---

## 2. 请求

| 项 | 值 |
|---|---|
| 方法 | `POST` |
| 地址 | 你在设置里填的「服务器地址」 |
| `Content-Type` | `application/json` |
| 请求体 | 收到消息的**原始 JSON**（与微信官方 ilink `getupdates` 的 `msgs[i]` 结构一致） |
| 超时 | 插件侧 10 秒 |

---

## 3. 数据格式

请求体是一个 JSON 对象，字段与 ilink 收消息结构一致：

```json
{
  "from_user_id": "o9cq...@im.wechat",
  "to_user_id": "739...@im.bot",
  "message_id": "1234567890",
  "create_time_ms": 1720000000000,
  "message_type": 1,
  "context_token": "AARz...",
  "item_list": [
    { "type": 1, "text_item": { "text": "消息文本" } }
  ]
}
```

### 3.1 字段说明

| 字段 | 类型 | 说明 |
|---|---|---|
| `from_user_id` | string | 发送者 id（绑定账号），形如 `o9cq...@im.wechat` |
| `to_user_id` | string | 接收者（bot）id，形如 `xxx@im.bot` |
| `message_id` | string/number | 消息 id，**可用于去重** |
| `create_time_ms` | number | 消息时间戳（毫秒） |
| `message_type` | number | `1`=用户消息；`2`=bot 自己发的（插件已过滤掉 `2`，你一般只会收到 `1`） |
| `context_token` | string | 回复凭证（敏感，见第 6 节） |
| `item_list` | array | 消息内容列表，见 3.2 |

> 以上为常见字段；插件是**原样转发**，实际还可能携带其它字段（如引用消息 `ref_msg` 等），解析时按需读取即可。

### 3.2 解析 item_list（消息内容）

`item_list` 是内容项数组，一条消息可含多个 item，按 `type` 区分：

| type | 含义 | 取内容方式 |
|---|---|---|
| `1` | 文本 | `item.text_item.text` |
| `2` | 图片 | `item.image_item.media`（媒体凭证），可能带 `item.image_item.aeskey` |
| `3` | 语音 | `item.voice_item.media`；`item.voice_item.text` 为**转写文本**（可能为空；为空时 media 是 SILK 音频，需自行转码） |
| `4` | 文件 | `item.file_item.media`、`item.file_item.file_name` |
| `5` | 视频 | `item.video_item.media` |

> 图片/文件/视频/语音的 `media` 是 **CDN 下载凭证**，需要按 ilink 协议下载，并按 `aes_key`（或图片的 `aeskey`）做 AES-128-ECB 解密后才能得到原始内容；`context_token` 是发送/下载时需要的凭证。

**提取纯文本**（插件内部也是这么做的）：

```js
function textOf(itemList) {
  const parts = [];
  for (const it of itemList || []) {
    if (!it) continue;
    if (it.type === 1 && it.text_item && typeof it.text_item.text === 'string') {
      parts.push(it.text_item.text);
    } else if (it.type === 3 && it.voice_item && it.voice_item.text) {
      parts.push(it.voice_item.text);
    }
  }
  return parts.join('\n');
}
```

---

## 4. 响应约定

- 插件**只看 HTTP 状态码**：`2xx` 视为成功（微信通知「✅ 上报成功」），其它视为失败（通知「⚠️ 上报失败: HTTP xxx」）。
- 响应体内容插件不解析，可返回任意内容，建议返回 `{"ok":true}`。
- **尽快返回**：先收下、再异步处理，避免超过 10 秒被插件判为失败。

---

## 5. 接入示例

### 5.1 Node.js（原生 http，零依赖）

```js
const http = require('http');

function textOf(itemList) {
  const parts = [];
  for (const it of itemList || []) {
    if (!it) continue;
    if (it.type === 1 && it.text_item && typeof it.text_item.text === 'string') {
      parts.push(it.text_item.text);
    } else if (it.type === 3 && it.voice_item && it.voice_item.text) {
      parts.push(it.voice_item.text);
    }
  }
  return parts.join('\n');
}

function handle(msg) {
  const text = textOf(msg.item_list);
  console.log(`[${new Date(msg.create_time_ms).toISOString()}] ${msg.from_user_id} -> ${text}`);
  // 在这里写你的业务处理
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/hook')) {
    res.writeHead(404); res.end();
    return;
  }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    // 先 ack，再处理
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    try {
      handle(JSON.parse(body));
    } catch (e) {
      console.error('parse failed:', e);
    }
  });
});

server.listen(3000, () => console.log('listening on :3000'));
```

### 5.2 Python（Flask）

```python
from flask import Flask, request, jsonify

app = Flask(__name__)

def text_of(item_list):
    parts = []
    for it in item_list or []:
        if not it:
            continue
        if it.get('type') == 1 and it.get('text_item', {}).get('text'):
            parts.append(it['text_item']['text'])
        elif it.get('type') == 3 and it.get('voice_item', {}).get('text'):
            parts.append(it['voice_item']['text'])
    return '\n'.join(parts)

@app.post('/hook')
def hook():
    msg = request.get_json(force=True, silent=True) or {}
    text = text_of(msg.get('item_list'))
    print(f"[{msg.get('from_user_id')}] -> {text}")
    # 建议：入队后立即返回，异步处理
    return jsonify(ok=True), 200
```

### 5.3 其它框架

任意能接收 HTTP POST + JSON 的服务都可以（Express、FastAPI、Spring、云函数等），核心逻辑一样：**读 JSON → 按 `item_list` 取文本 → 返回 2xx**。

---

## 6. 安全与注意事项

1. **鉴权**：目前插件**不签名、不带额外 token**。建议给上报地址加一个只有你知道的 path/query，例如 `https://your-server.com/hook?token=<随机串>`，或用防火墙/白名单限制来源。
2. **`context_token` 是敏感凭证**：不要写进日志、不要对外公开、不要存明文日志；只用于（可选地）通过 ilink 网关回复用户，你的服务器一般用不到它。
3. **去重**：网络异常或重试可能导致同一条消息多次投递，用 `message_id`（配合 `create_time_ms`）去重。
4. **先 ack 再处理**：收到即返回 2xx，重活放队列/异步，避免 10 秒超时被判定失败。
5. **限流**：插件不做限流；若你的服务器承受不住，需自行做限流/削峰。

---

## 7. 常见问题

| 问题 | 原因 / 处理 |
|---|---|
| 收不到上报 | 地址是否公网可达；是否返回 2xx；是否 10 秒内响应；总「监听」开关是否开启 |
| 收到重复消息 | 用 `message_id` 去重 |
| 语音消息没有文本 | `voice_item.text` 为空时是 SILK 音频，需要转码（silk 转 wav/mp3） |
| 消息类型不是文本 | `item_list` 里 `type` 可能是 2/3/4/5，按 3.2 处理 |
