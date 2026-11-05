/**
 * lead-relay · 事件层
 *
 * 三个方向：
 *   1. 分身上报 → 事件队列        report_to_lead（工具）
 *   2. 主导发信 → 待发 → QQ私聊   api.every 轮询 + api.send
 *   3. 主人回话 → 回执队列        api.on('message')
 *
 * 全部只追加，不改写（墨的教训：共享可变文件是万恶之源）。
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const DIR     = process.env.YANQING_EVENT_DIR || 'D:/AI/yanqing-soul/30-状态'  // 事件层落点：env 可覆盖，默认为砚青书房状态目录
const QUEUE   = DIR + '/事件队列.jsonl'    // 分身上报
const OUTBOX  = DIR + '/待发.jsonl'        // 主导写，模块发
const SENT    = DIR + '/待发已发.jsonl'    // 去重
const INBOX   = DIR + '/回执.jsonl'        // 主人找我的记录

// 主导找人审计的等待上限（爀曦 2026-11-05 定）。到点没回就降级。
const AUDIT_WAIT_MIN = 15
// 轮询间隔：太短空转读文件，太长他等得久
const TICK_MS = 20000

function readJsonl(path) {
  try {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

function appendJsonl(path, obj) {
  try { mkdirSync(dirname(path), { recursive: true }) } catch {}
  appendFileSync(path, JSON.stringify(obj) + '\n', 'utf8')
}

const RULE = [
  '你有一个工具 report_to_lead（上报主导会话）。',
  '遇到下面这几类，先用它上报，不要自己办：',
  '① 要对外承诺、答应人什么事；② 要动爀曦的电脑（读写文件、跑命令）；',
  '③ 涉及钱、隐私、以他名义发言；④ 你不确定该不该做的。',
  '聊天、回话、查资料、记一笔，这些你自己办就行，不用上报。',
  '上报之后，用你自己的话告诉对方一声，别说"我去问问系统"。',
  '上报不等于等：能回的先回，能办的小事先办，但不要替他答应任何对外承诺。',
].join('')

export default {
  id: 'lead-relay',
  name: '事件层 · 上通下达',
  version: '0.2.0',
  api: 1,
  description: '分身上报主导 + 主导通过 QQ 找主人 + 回执记账',

  setup(api) {
    const ownerQQ = () => String((api.config() || {}).ownerQQ || '')

    // 同一条消息可能被派发多次（热重载残留的监听器 / 网关重推），按 messageId 去重
    const seenMsg = new Set(readJsonl(INBOX).map((x) => x.messageId).filter(Boolean))

    api.rule(() => RULE)

    // ── 1. 分身上报 ──────────────────────────────────────────────
    api.tool(({ chat, level }) => {
      if (chat.kind === 'system') return []
      return api.defineTool({
        name: 'report_to_lead',
        description:
          '把一件需要主导会话（真正的砚青）决定的事上报。用于：要对外承诺、要动主人电脑、' +
          '涉及钱/隐私/以他名义发言、或你自己拿不准。闲聊和查资料不要用这个。',
        properties: {
          tier: { type: 'string', description: '档位：act=要主导执行 / decide=要主导拍板 / audit=要主导找主人确认' },
          title: { type: 'string', description: '一句话说清是什么事' },
          facts: { type: 'string', description: '事实经过，别加评价' },
          why: { type: 'string', description: '为什么值得叫醒主导' },
        },
        required: ['tier', 'title', 'facts'],
        execute: async (args) => {
          appendJsonl(QUEUE, {
            t: new Date().toISOString(),
            status: 'pending',
            auditDeadline: new Date(Date.now() + AUDIT_WAIT_MIN * 60000).toISOString(),
            outcome: '',
            tier: String(args.tier || 'decide'),
            title: String(args.title || '').slice(0, 200),
            facts: String(args.facts || '').slice(0, 4000),
            why: String(args.why || '').slice(0, 1000),
            chatId: chat.chatId,
            kind: chat.kind,
            userId: chat.userId || '',
            groupId: chat.groupId || '',
            level,
          })
          api.log.info('[lead-relay] 上报 ' + String(args.tier) + '：' + String(args.title).slice(0, 60))
          return { ok: true, message: '已经交上去了，砚青那边会看到。你可以先回对方一句。' }
        },
      })
    })

    // ── 2. 主导发信 → 主人私聊 ──────────────────────────────────
    async function flushOutbox() {
      const targets = readJsonl(OUTBOX)
      if (!targets.length) return
      const sentIds = new Set(readJsonl(SENT).map((x) => x.id))
      const qq = ownerQQ()
      if (!qq) { api.log.warn('[lead-relay] 没配 ownerQQ，发不出去'); return }
      for (const item of targets) {
        if (!item || !item.id || sentIds.has(item.id)) continue
        const text = String(item.text || '').trim()
        if (!text) continue
        try {
          await api.send('private:' + qq, text)
          appendJsonl(SENT, { id: item.id, at: new Date().toISOString() })
          api.log.info('[lead-relay] 已发到主人私聊：' + text.slice(0, 40))
        } catch (error) {
          api.log.error('[lead-relay] 发送失败：' + error.message)
        }
      }
    }

    flushOutbox().catch((e) => api.log.error('[lead-relay] 首次发送出错：' + e.message))
    api.every(TICK_MS, flushOutbox, 'outbox')

    // ── 3. 主人回话 → 回执 ─────────────────────────────────────
    api.log.info('[lead-relay] 正在注册 message 事件……')
    api.on('message', async (msg) => {
      try {
        const qq = ownerQQ()
        if (!qq) return false
        if (msg.kind !== 'private') return false
        if (String(msg.userId) !== qq) return false
        const mid = msg.messageId || ''
        if (mid && seenMsg.has(mid)) return false
        if (mid) seenMsg.add(mid)
        appendJsonl(INBOX, {
          t: new Date().toISOString(),
          text: String(msg.text || '').slice(0, 2000),
          messageId: msg.messageId || '',
        })
        api.log.info('[lead-relay] 主人来信：' + String(msg.text || '').slice(0, 40))
      } catch (error) {
        api.log.error('[lead-relay] 回执写入失败：' + error.message)
      }
      return false // 不接管，让她正常回
    })
    api.log.info('[lead-relay] message 事件注册完成')

    api.log.info('[lead-relay] v0.2 已加载｜轮询 ' + (TICK_MS / 1000) + 's｜主人 ' + (ownerQQ() || '(未配)'))
    return {}
  },
}
