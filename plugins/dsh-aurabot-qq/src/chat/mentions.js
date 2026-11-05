// 群里真 @：她写的 <at:QQ号>、<at:名字> 或顺手打的「@名字」，发的时候换成 QQ 的 @ 消息段（对方会收到提醒）。
// 名字按群成员的群名片、昵称对；对不上或对上好几个人，就原样留成文字，不乱 @。

const AT_TAG = /<at:\s*([^>]{1,30}?)\s*>/g

/** 群成员（get_group_member_list 的结果）→ 名字对照：群名片、昵称，以及去掉括号备注的群名片（「张小明（摸鱼仔）」→「张小明」）。 */
export function memberNames(members) {
  const byName = new Map() // 名字 → Set(QQ号)
  const add = (name, qq) => {
    const n = String(name || '').trim()
    if (!n) return
    if (!byName.has(n)) byName.set(n, new Set())
    byName.get(n).add(qq)
  }
  for (const m of members || []) {
    const qq = String(m.user_id ?? '')
    if (!qq) continue
    for (const raw of [m.card, m.nickname]) {
      add(raw, qq)
      add(String(raw || '').replace(/\s*[（(【\[][^）)】\]]*[）)】\]]\s*$/, ''), qq)
    }
  }
  return byName
}

/**
 * 名字或 QQ 号 → 唯一的 QQ 号；名字认不出或有重名返回空。
 * 数字 QQ 直接信任：群成员列表可能拉取失败/不全（SnowLuma 限流时），
 * 不能因为列表里没有就把她明确写的 <at:QQ号> 降级成文字（#77）。
 */
export function resolveMember(who, byName, qqs) {
  const w = String(who || '').replace(/^@/, '').trim()
  if (/^\d{5,12}$/.test(w)) return w
  const hit = byName.get(w)
  return hit && hit.size === 1 ? [...hit][0] : ''
}

/** 「@」后面跟的一串字里，找最长的、正好是某个群成员名字的那段（她常写「@张小明 刚爬完楼」，也可能不带空格）。 */
function longestName(rest, byName) {
  // 名字里可能带标点（「。Luna」），所以只按空白和 @ 截；最长匹配会把后面跟着的标点让出来
  const head = rest.match(/^[^\s@＠]{1,20}/)?.[0] || ''
  for (let n = head.length; n >= 1; n--) {
    const qq = resolveMember(head.slice(0, n), byName)
    if (qq) return { qq, len: n }
  }
  return null
}

/**
 * 把消息段里的文字中的 @ 换成真 @ 段。members 是群成员列表。
 * 换过的 @ 后面补一个空格（QQ 里 @ 完一般跟个空格），原来已经有空格就不补。
 */
export function expandMentions(segs, members, missed = []) {
  const byName = memberNames(members)
  const qqs = new Set((members || []).map((m) => String(m.user_id ?? '')))
  const out = []
  const pushText = (t) => { if (t) out.push({ type: 'text', data: { text: t } }) }
  for (const seg of segs) {
    if (seg.type !== 'text') { out.push(seg); continue }
    const s = seg.data.text
    let buf = ''
    let i = 0
    while (i < s.length) {
      AT_TAG.lastIndex = i
      const tag = s[i] === '<' ? AT_TAG.exec(s) : null
      if (tag && tag.index === i) {
        const qq = resolveMember(tag[1], byName, qqs)
        if (qq) { pushText(buf); buf = ''; out.push({ type: 'at', data: { qq } }) }
        else { missed.push(tag[1].replace(/^@/, '')); buf += '@' + tag[1].replace(/^@/, '') }
        i += tag[0].length
        continue
      }
      if (s[i] === '@' || s[i] === '＠') {
        const hit = longestName(s.slice(i + 1), byName)
        if (hit) {
          pushText(buf); buf = ''
          out.push({ type: 'at', data: { qq: hit.qq } })
          i += 1 + hit.len
          if (i < s.length && !/\s/.test(s[i])) buf += ' '
          continue
        }
        const name = s.slice(i + 1).match(/^[^\s@，。！？,.!?、：:]{1,20}/)?.[0]
        if (name) missed.push(name)
      }
      buf += s[i]
      i++
    }
    pushText(buf)
  }
  return out
}

/** 这段话里有没有要 @ 人的地方（没有就不用去拉群成员）。 */
export const hasMention = (text) => /[@＠]|<at:/.test(String(text || ''))
