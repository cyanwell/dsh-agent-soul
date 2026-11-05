// 群里真 @：<at:QQ号>、<at:名字>、顺手打的「@名字」换成 @ 消息段；对不上或重名的不乱 @。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { expandMentions, hasMention } from '../src/chat/mentions.js'

const members = [
  { user_id: 10001, card: '张小明（摸鱼仔）', nickname: 'zyb' },
  { user_id: 10002, card: '', nickname: '小饭团' },
  { user_id: 10003, card: '小王', nickname: 'a' },
  { user_id: 10004, card: '小王', nickname: 'b' },
]
const text = (t) => [{ type: 'text', data: { text: t } }]

test('顺手打的 @名字 对上群名片（括号备注去掉也认）就变成真 @', () => {
  assert.deepEqual(expandMentions(text('@张小明 刚爬完楼'), members), [
    { type: 'at', data: { qq: '10001' } },
    { type: 'text', data: { text: ' 刚爬完楼' } },
  ])
  assert.deepEqual(expandMentions(text('嘿@小饭团别跑'), members), [
    { type: 'text', data: { text: '嘿' } },
    { type: 'at', data: { qq: '10002' } },
    { type: 'text', data: { text: ' 别跑' } },
  ], '不带空格也能认，@ 后补个空格')
})

test('<at:QQ号> 和 <at:名字> 都行；数字号直接信任，重名/不认识的名字原样留成文字', () => {
  assert.deepEqual(expandMentions(text('<at:10002> 在吗'), members)[0], { type: 'at', data: { qq: '10002' } })
  assert.deepEqual(expandMentions(text('<at:小饭团>'), members), [{ type: 'at', data: { qq: '10002' } }])
  assert.deepEqual(expandMentions(text('<at:99999> 在吗'), members), [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: ' 在吗' } }], '数字 QQ 直接信任：群成员列表拉不到/不全时也不能降级成文字（#77）')
  assert.deepEqual(expandMentions(text('@小王 在吗'), members), text('@小王 在吗'), '两个小王，不猜')
  assert.deepEqual(expandMentions(text('@路人甲 在吗'), members), text('@路人甲 在吗'))
})

test('别的段（表情、引用）原样保留；没有 @ 就不用拉群成员', () => {
  const segs = [{ type: 'reply', data: { id: '1' } }, ...text('@小饭团 '), { type: 'face', data: { id: '178' } }]
  assert.deepEqual(expandMentions(segs, members), [{ type: 'reply', data: { id: '1' } }, { type: 'at', data: { qq: '10002' } }, { type: 'text', data: { text: ' ' } }, { type: 'face', data: { id: '178' } }])
  assert.equal(hasMention('普通的话'), false)
  assert.equal(hasMention('<at:1>'), true)
})

test('没对上的 @ 记下来（让发消息的工具如实告诉她）', () => {
  const missed = []
  expandMentions(text('@张小明 别闷着 <at:99999> @小饭团'), members.slice(1), missed)
  assert.deepEqual(missed, ['张小明'], '数字 QQ 直接信任，不再记进没对上的列表（#77）')
})

test('名字带标点也能 @（「。Luna」），名字后面紧跟的标点不算进名字', () => {
  const ms = [{ user_id: 10005, card: '', nickname: '。Luna' }]
  assert.deepEqual(expandMentions(text('@。Luna，在吗'), ms), [{ type: 'at', data: { qq: '10005' } }, { type: 'text', data: { text: ' ，在吗' } }])
})
