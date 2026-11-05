// 抖音网页上的具体操作。数据都走抖音网页自己的接口（在页面里 fetch，签名由页面脚本自动加），
// 不读屏、不截图；点赞 / 评论在视频页上真点按钮，再等接口返回确认成没成功。

import { setTimeout as sleep } from 'node:timers/promises'

const HOME = 'https://www.douyin.com/'
export const videoLink = (id) => `https://www.douyin.com/video/${id}`

// 网页端接口的公共参数（和网页自己发的一样）
const BASE = { device_platform: 'webapp', aid: '6383', channel: 'channel_pc_web', pc_client_type: '1', version_code: '290100', version_name: '29.1.0', cookie_enabled: 'true', platform: 'PC', downlink: '10' }
// 这些业务码说明没登录
const NOT_LOGIN = new Set([8, 2190008])

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const clean = (t, max = 300) => [...String(t ?? '').replace(/\s+/g, ' ').trim()].slice(0, max).join('')

/** 编辑器可能把 emoji 显示成图片；比较可见文字时保留标点，不能把半句话当完整。 */
export function dmComparable(text) {
  return String(text || '').normalize('NFC').replace(/[\s\u00a0\u200b\u200d\ufe0f]|\p{Extended_Pictographic}|\p{Emoji_Modifier}/gu, '')
}

function dmEqual(actual, expected) {
  const target = dmComparable(expected)
  return target ? dmComparable(actual) === target : String(actual || '').trim() === String(expected || '').trim()
}

/** 从一段文字里认视频：完整链接 / modal_id / 图文 note / v.douyin.com 短链。 */
export function findAwemeId(text) {
  const s = String(text || '')
  const m = s.match(/douyin\.com\/(?:video|note)\/(\d{15,})/) || s.match(/[?&]modal_id=(\d{15,})/) || s.match(/iesdouyin\.com\/share\/(?:video|note)\/(\d{15,})/)
  if (m) return { awemeId: m[1] }
  const short = s.match(/https?:\/\/v\.douyin\.com\/[A-Za-z0-9_-]+\/?/)
  if (short) return { short: short[0] }
  if (/^\d{15,}$/.test(s.trim())) return { awemeId: s.trim() }
  return null
}

/** 短链跳一下，拿到真实视频 id。 */
export async function resolveShort(url, fetchImpl = fetch) {
  let cur = url
  for (let i = 0; i < 4; i++) {
    const r = await fetchImpl(cur, { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36' }, signal: AbortSignal.timeout(10000) })
    const loc = r.headers.get('location')
    if (!loc) break
    cur = new URL(loc, cur).toString()
    const id = findAwemeId(cur)
    if (id?.awemeId) return id.awemeId
  }
  return ''
}

/** 接口里的一条视频整理成她看的样子；广告 / 直播 / 没 id 的返回 null。 */
export function normalizeAweme(raw) {
  const a = raw?.aweme_info || raw?.aweme_detail || raw
  if (!a || typeof a !== 'object') return null
  const id = String(a.aweme_id || '')
  if (!id || a.is_ads || a.cell_room || a.is_live || a.live_reason) return null
  const st = a.statistics || {}
  const au = a.author || {}
  const desc = clean(a.desc, 300)
  return {
    awemeId: id,
    title: clean(a.item_title, 80) || desc.replace(/#\S+/g, '').trim().slice(0, 80),
    desc,
    author: clean(au.nickname, 40),
    authorSecUid: String(au.sec_uid || ''),
    likes: num(st.digg_count),
    comments: num(st.comment_count),
    shares: num(st.share_count),
    collects: num(st.collect_count),
    duration: Math.round(num(a.video?.duration || a.duration) / 1000),
    tags: (a.text_extra || []).map((t) => t?.hashtag_name).filter(Boolean).slice(0, 8),
    category: (a.video_tag || []).map((t) => t?.tag_name).filter(Boolean),
    summary: clean(a.chapter_abstract, 600), // 抖音自己生成的内容摘要，长一点的视频常有
    chapters: (a.chapter_list || []).map((c) => clean([c.desc, c.detail].filter(Boolean).join('：'), 120)).filter(Boolean).slice(0, 8),
    music: a.music?.title ? clean(`${a.music.title}${a.music.author ? ' - ' + a.music.author : ''}`, 60) : '',
    isImages: Array.isArray(a.images) && a.images.length > 0,
    createdAt: num(a.create_time) * 1000,
  }
}

/** 评论接口 → 按赞数排的热评 [{name, text, likes}]。 */
export function parseComments(json, max = 8) {
  return (json?.comments || [])
    .map((c) => ({ name: clean(c.user?.nickname, 20), text: clean(c.text, 120), likes: num(c.digg_count) }))
    .filter((c) => c.text)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, max)
}

const wan = (n) => (n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + '万' : String(n))

/** 一个视频交给她看的样子：标题、作者、数据、分类、摘要 / 章节、文案、音乐、热评。 */
export function digestOf(v, comments = []) {
  return [
    `《${v.title || '（无标题）'}》 作者：${v.author || '?'}  赞 ${wan(v.likes)}  评论 ${wan(v.comments)}${v.duration ? '  ' + v.duration + ' 秒' : ''}${v.isImages ? '  图文' : ''}`,
    v.category.length ? `分类：${v.category.join(' / ')}` : '',
    v.summary ? `内容摘要：${v.summary}` : '',
    v.chapters.length ? '分段：\n' + v.chapters.map((c) => '  - ' + c).join('\n') : '',
    v.desc && v.desc !== v.title ? `文案：${v.desc}` : '',
    v.music ? `配乐：${v.music}` : '',
    comments.length ? '热评：\n' + comments.map((c) => `  ${c.name}：${c.text}（${wan(c.likes)} 赞）`).join('\n') : '',
  ].filter(Boolean).join('\n')
}

/** 页面上现在有没有看得见的验证码 / 滑块。每次现查，不留标记（以前查到一次就永久「要验证」）。 */
export const VERIFY_PROBE = `(() => {
  const big = (n) => { const r = n.getBoundingClientRect(); const s = getComputedStyle(n); return r.width > 200 && r.height > 150 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.1 }
  const nodes = [...document.querySelectorAll('#captcha_container, .captcha_verify_container, [id^=captcha], iframe[src*="verifycenter"], iframe[src*="captcha"]')]
  const hit = nodes.find(big)
  if (!hit) return ''
  const t = (hit.innerText || '').slice(0, 60)
  return t || '页面弹了验证码'
})()`

export function createSite({ browser, log }) {
  const b = browser

  /** 浏览器连上并停在抖音域名下（接口要同源才带登录态）。 */
  async function ensure() {
    const r = await b.open()
    if (!r.ok) return r
    const href = String(await b.evaluate('location.href').catch(() => ''))
    if (!/^https:\/\/www\.douyin\.com\//.test(href)) {
      await b.goto(HOME)
      await sleep(1500)
    }
    return { ok: true }
  }

  /** 在页面里调网页端 GET 接口。没登录 / 业务出错会抛带 code 的错。 */
  async function api(path, params = {}) {
    const u = new URL(path, HOME)
    for (const [k, v] of Object.entries({ ...BASE, ...params })) u.searchParams.set(k, String(v))
    const r = await b.evaluate(`fetch(${JSON.stringify(u.toString())}, { credentials: 'include' }).then(async (r) => ({ status: r.status, text: await r.text() }))`)
    if (!r || r.status !== 200) throw Object.assign(new Error(`抖音接口返回 ${r?.status || '空'}`), { code: r?.status })
    if (!r.text) throw Object.assign(new Error('抖音接口返回空内容（可能被风控了）'), { code: 'empty' })
    let json
    try { json = JSON.parse(r.text) } catch (error) { throw Object.assign(new Error('抖音接口返回的不是 JSON'), { code: 'bad' }) }
    const code = Number(json.status_code || 0)
    if (NOT_LOGIN.has(code)) throw Object.assign(new Error('抖音还没登录'), { code: 'login' })
    if (code) throw Object.assign(new Error(json.status_msg || `抖音接口出错（${code}）`), { code })
    return json
  }

  /** 当前登录的号；没登录返回 null。 */
  async function self() {
    try {
      const j = await api('/aweme/v1/web/user/profile/self/', { publish_video_strategy_type: 2, source: 'channel_pc_web', personal_center_strategy: 1 })
      const u = j.user || {}
      return u.sec_uid ? { secUid: String(u.sec_uid), nickname: clean(u.nickname, 40), uid: String(u.uid || '') } : null
    } catch (error) {
      if (error.code === 'login') return null
      throw error
    }
  }

  /** 推荐流一页。 */
  async function feed(refreshIndex = 1) {
    const j = await api('/aweme/v1/web/tab/feed/', { count: 10, refresh_index: refreshIndex, video_type_select: 1, aweme_pc_rec_raw_data: '{}', globalwid: '', pull_type: refreshIndex > 1 ? 2 : 0, min_window: 0, free_right: 0 })
    return (j.aweme_list || []).map(normalizeAweme).filter(Boolean)
  }

  async function detail(id) {
    const v = normalizeAweme((await api('/aweme/v1/web/aweme/detail/', { aweme_id: id })).aweme_detail)
    if (!v) throw new Error('这个视频打不开（删了、私密或者是直播）')
    return v
  }

  async function comments(id) {
    return parseComments(await api('/aweme/v1/web/comment/list/', { aweme_id: id, cursor: 0, count: 20, item_type: 0 }))
  }

  /** 现在有没有验证码；有就返回原因。 */
  const verify = () => b.evaluate(VERIFY_PROBE).catch(() => '')

  /**
   * 点赞 / 评论的接口回应：只有明确返回 status_code 0 才算成功。
   * 账号被要求身份验证时，抖音回 200 + 空内容，响应头里带 x-tt-verify-passport-decision（以前把这种当成了成功）。
   */
  function checkWrite(r, what) {
    if (!r) throw new Error(`${what}没发出去（没等到抖音的回应）`)
    const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]))
    if (h['x-tt-verify-passport-decision']) throw Object.assign(new Error(`抖音拦下了${what}并返回账号验证标记，网页不一定会显示验证码。请在手机抖音检查账号安全或实名状态，再在面板显示专用浏览器窗口核对；未确认前不要反复重试`), { code: 'verify' })
    if (!r.json) throw new Error(`${what}没发出去（抖音没返回结果）`)
    if (r.json.status_code !== 0) throw Object.assign(new Error(r.json.status_msg || `${what}失败（${r.json.status_code}）`), { code: r.json.status_code })
  }

  // 弹层播放器里正在播的那个视频（带着视频 id），点赞 / 评论按钮都只在它里面找，不会点到别的视频上
  const scope = (id) => `[data-e2e="feed-active-video"][data-e2e-vid="${id}"]`
  const EDITOR = '.comment-input-inner-container [contenteditable="true"]'

  /**
   * 用弹层播放器打开视频（和网页上点开一个视频一样；她真的在看，抖音那边也记成看过）。
   * 视频详情页那排按钮没有稳定的标记，弹层播放器的有。正在播的已经是它就不重开
   * （弹层开着「连播」，播完会自己跳到下一个，网址却不一定变，所以按正在播的视频判断）。
   */
  async function openVideo(id) {
    if (!/^\d{15,}$/.test(String(id))) throw new Error('视频 id 不对')
    if (!(await b.evaluate(`Boolean(document.querySelector(${JSON.stringify(scope(id))}))`).catch(() => false))) await b.goto(`${HOME}jingxuan?modal_id=${id}`)
    const why = await verify()
    if (why) throw Object.assign(new Error('要验证：' + why), { code: 'verify' })
    if (!(await b.waitFor(scope(id), 12000))) throw new Error('视频没打开（可能删了或者是私密的）')
  }

  /** 看一个视频 ms 毫秒（静音播放）。 */
  async function watch(id, ms) {
    await openVideo(id)
    await b.evaluate(`document.querySelectorAll(${JSON.stringify(scope(id) + ' video')}).forEach((v) => { v.muted = true; v.play && v.play().catch(() => {}) })`).catch(() => {})
    await sleep(ms)
  }

  /** 点赞：已经赞过就不点（再点会变成取消）；点完等接口确认。 */
  async function like(id) {
    await openVideo(id)
    const sel = `${scope(id)} [data-e2e="video-player-digg"]`
    const btn = await b.waitFor(sel, 10000)
    if (!btn) throw new Error('页面上找不到点赞按钮')
    if (/digged/.test(btn.state) && !/no-digged/.test(btn.state)) return { ok: true, already: true }
    const resp = b.waitResponse(/\/aweme\/v1\/web\/commit\/item\/digg\//, 10000)
    await b.press(sel)
    const r = await resp
    checkWrite(r, '点赞')
    return { ok: true }
  }

  /** 评论框里的文字；清空评论框。 */
  const editorText = () => b.evaluate(`(document.querySelector(${JSON.stringify(EDITOR)}) || {}).innerText || ''`).catch(() => '')
  const clearEditor = () => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(EDITOR)}); if (!e) return; e.focus(); document.execCommand('selectAll'); document.execCommand('delete') })()`).catch(() => {})

  /** 打开评论面板，把光标放进评论框（评论框空着时编辑器要点一下才出来）。 */
  async function focusEditor(id) {
    // 评论按钮是开 / 关切换：右边面板留在别的标签页时，第一下可能是把它关上，没出来就再点一下
    // （面板加载慢，等够了再点第二下，不然会把刚打开的又关上）
    for (let i = 0; i < 2 && !(await b.evaluate(`Boolean(document.querySelector('.comment-input-inner-container'))`)); i++) {
      if (!(await b.press(`${scope(id)} [data-e2e="feed-comment-icon"]`))) throw new Error('页面上找不到评论按钮')
      await b.waitFor('.comment-input-inner-container', 7000)
    }
    if (!(await b.evaluate(`Boolean(document.querySelector('.comment-input-inner-container'))`))) throw new Error('评论框没打开')
    for (let i = 0; i < 4; i++) {
      await b.press('.comment-input-inner-container')
      await sleep(300)
      const ok = await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(EDITOR)}); if (!e) return false; e.focus(); return document.activeElement === e })()`)
      if (ok) return
    }
    throw new Error('评论框点不进去')
  }

  /**
   * 在评论框里真·@一个人：打「@昵称」，从弹出的候选里按 sec_uid / uid 认出这个人点选，
   * 再确认编辑器里出现了抖音的提及标记（douyin_mention_word）。认不出就清空评论框，不发假 @。
   */
  async function mention(who) {
    await b.type('@' + who.nickname)
    const want = JSON.stringify({ secUid: who.secUid, uid: who.uid })
    let picked = null
    for (let i = 0; i < 12 && !picked?.ok; i++) {
      await sleep(500)
      picked = await b.evaluate(`(() => {
        const want = ${want}
        const of = (n) => {
          const k = Object.keys(n).find((x) => x.startsWith('__reactFiber$'))
          for (let f = k && n[k], j = 0; f && j < 4; f = f.return, j++) {
            const m = f.memoizedProps && f.memoizedProps.mention
            if (m && (m.secUid || m.sec_uid || m.uid)) return { sec: String(m.secUid || m.sec_uid || ''), uid: String(m.uid || '') }
          }
          return null
        }
        const box = document.querySelector('.atBox-inner-container')
        if (!box) return { ok: false }
        const hit = [...box.querySelectorAll('div')].reverse().find((n) => { const m = of(n); return m && ((want.secUid && m.sec === want.secUid) || (want.uid && m.uid === want.uid)) })
        if (!hit) return { ok: false, listed: true }
        for (const t of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) hit.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window, button: 0 }))
        return { ok: true }
      })()`).catch(() => null)
    }
    await sleep(400)
    const tagged = await b.evaluate(`[...document.querySelectorAll(${JSON.stringify(EDITOR + ' .douyin_mention_word')})].some((n) => n.innerText.trim() === ${JSON.stringify('@' + who.nickname)})`).catch(() => false)
    if (picked?.ok && tagged) return true
    await clearEditor()
    throw Object.assign(new Error(picked?.listed ? '@ 候选里没找到主人（可能互相没关注）' : '@ 候选没弹出来'), { code: 'mention' })
  }

  /**
   * 发评论：打开评论面板、点输入框，要 @ 人就先真·@，再像人一样打字、回车，等发评论接口返回成功。
   * at = { secUid, uid, nickname }：发出去以后再核对一遍，返回里被 @ 的确实是这个人。
   */
  async function comment(id, text, { at } = {}) {
    await openVideo(id)
    await focusEditor(id)
    if ((await editorText()).trim()) await clearEditor() // 上次没发出去的残留
    if (at) await mention(at)
    await b.type(text)
    await sleep(500 + Math.random() * 800)
    // 发送：点评论框右边的红色箭头（打了字才出现，是那一排图标里最右边的一个）。页面看不见时回车不管用，所以不靠回车
    const marked = await b.evaluate(`(() => {
      let bar = document.querySelector('.comment-input-inner-container')
      for (let i = 0; i < 3 && bar; i++) bar = bar.parentElement
      const icons = bar ? [...bar.querySelectorAll('span')].filter((n) => n.querySelector('svg') && n.getBoundingClientRect().width > 10) : []
      const send = icons.sort((x, y) => x.getBoundingClientRect().x - y.getBoundingClientRect().x).at(-1)
      if (send) send.setAttribute('data-aurabot', 'send')
      return Boolean(send)
    })()`).catch(() => false)
    const resp = b.waitResponse(/\/aweme\/v1\/web\/comment\/publish/, 12000)
    if (marked) await b.press('[data-aurabot="send"]')
    else await b.pressEnter()
    const r = await resp
    try {
      checkWrite(r, '评论')
    } catch (error) {
      // 没发出去的字别留在评论框里（下次会接在后面，或者被当成草稿）
      await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(EDITOR)}); e && e.focus() })()`).catch(() => {})
      await b.clearFocused().catch(() => {})
      throw error
    }
    const c = r.json?.comment || {}
    const atOwner = Boolean(at) && (c.text_extra || []).some((x) => (at.secUid && x.sec_uid === at.secUid) || (at.uid && String(x.user_id) === String(at.uid)))
    return { ok: true, cid: String(c.cid || ''), atOwner }
  }

  /**
   * 在抖音里把视频私信分享给一个人（视频卡片）：打开视频的「分享」面板，在「分享给朋友」里按 sec_uid 认出这个人
   * （最近联系人里没有就用面板的搜索框搜昵称），点他那一行的「分享」，等私信接口发送成功才算数。认不出就不发。
   * 这一页里分享过的，那一行按钮会变成「捎句话」，就不再点（换页面后这个状态会丢，去重靠 duty 自己记）。
   * 「捎句话」（在私信框里再打一句话）页面看不见时发不稳，暂时不做，想让主人看到她的话就同时发 QQ。
   * who = { secUid, nickname }；返回 { ok, already }
   */
  async function share(id, who) {
    await openVideo(id)
    // 找到这个人那一行，给它的按钮做个记号；分享过的按钮是「捎句话」
    const findRow = () => b.evaluate(`(() => {
      const want = ${JSON.stringify(who.secUid)}
      const secOf = (n) => {
        const k = Object.keys(n).find((x) => x.startsWith('__reactFiber$'))
        for (let f = k && n[k], j = 0; f && j < 6; f = f.return, j++) {
          for (const v of Object.values(f.memoizedProps || {})) if (v && typeof v === 'object' && (v.sec_uid || v.secUid)) return String(v.sec_uid || v.secUid)
        }
        return ''
      }
      const rows = [...document.querySelectorAll('div')].filter((n) => /(分享|捎句话)$/.test((n.innerText || '').trim()) && n.getBoundingClientRect().height > 30 && n.getBoundingClientRect().height < 90 && secOf(n))
      const row = rows.find((n) => secOf(n) === want)
      if (!row) return { found: false, listed: rows.length }
      const btn = [...row.querySelectorAll('*')].reverse().find((n) => ['分享', '捎句话'].includes((n.innerText || '').trim()))
      if (!btn) return { found: false, listed: rows.length }
      document.querySelectorAll('[data-aurabot="share-to"]').forEach((n) => n.removeAttribute('data-aurabot'))
      btn.setAttribute('data-aurabot', 'share-to')
      return { found: true, done: btn.innerText.trim() === '捎句话' }
    })()`).catch(() => ({ found: false }))
    // 分享按钮是开 / 关切换：面板已经开着就不点；点了等不到就再点一下
    let hit = await findRow()
    for (let tries = 0; tries < 2 && !hit?.found; tries++) {
      if (!(await b.press(`${scope(id)} [data-e2e="video-player-share"]`))) throw new Error('页面上找不到分享按钮')
      for (let i = 0; i < 16 && !hit?.found; i++) {
        await sleep(500)
        hit = await findRow()
      }
    }
    // 最近联系人里没有：用分享面板里的搜索框搜昵称（先清空，免得接在上次的字后面）
    if (!hit?.found && who.nickname) {
      const searched = await b.evaluate(`(() => {
        const box = [...document.querySelectorAll('input')].find((n) => n.getAttribute('placeholder') === '搜索' && n.getBoundingClientRect().width > 0)
        if (!box) return false
        box.focus()
        box.select()
        return true
      })()`).catch(() => false)
      if (searched) {
        await b.type(who.nickname)
        for (let i = 0; i < 10 && !hit?.found; i++) {
          await sleep(600)
          hit = await findRow()
        }
      }
    }
    if (!hit?.found) throw Object.assign(new Error('分享面板里没找到主人（可能互相没关注、私信不通）'), { code: 'share' })
    const sent = /\/v1\/message\/send/
    const already = Boolean(hit.done) // 这个视频之前就分享给他过了，不再重复分享
    if (!already) {
      const resp = b.waitResponse(sent, 12000)
      await b.press('[data-aurabot="share-to"]')
      const r = await resp
      if (!r) throw new Error('点了分享，但没等到抖音私信的回应')
      if (r.status !== 200) throw new Error(`抖音私信没发出去（HTTP ${r.status}）`)
    }
    return { ok: true, already }
  }

  // ---------- 私信（独立聊天页 douyin.com/chat） ----------
  const CHAT = `${HOME}chat?isPopup=1`
  const DM_EDIT = '[data-aurabot="dm-edit"]'

  /** 打开和某人的私信会话：会话 id 是「0:1:双方 uid」，按 uid 认人。页面在后台时列表要十几秒才出来。 */
  async function openChat(uid, { secUid = '' } = {}) {
    if (!String(await b.evaluate('location.href').catch(() => '')).startsWith(CHAT)) await b.goto(CHAT)
    let found = false
    for (let i = 0; i < 40 && !found; i++) {
      found = await b.evaluate(`(() => {
        const want = ${JSON.stringify(String(uid))}
        // 外层容器和里面那一行都能对上会话 id，点击要落在最里层那一行上才会打开会话
        let hit = null
        for (const n of document.querySelectorAll('div')) {
          const r = n.getBoundingClientRect()
          if (!(r.height > 40 && r.height < 120 && r.x < 450)) continue
          const k = Object.keys(n).find((x) => x.startsWith('__reactFiber$')); if (!k) continue
          let match = false
          for (let f = n[k], j = 0; f && j < 3 && !match; f = f.return, j++) {
            for (const v of Object.values(f.memoizedProps || {})) {
              if (!v || typeof v !== 'object') continue
              let id = ''
              try { id = String(v.conversationId || v.id || '') } catch (e) {}
              if (/^0:1:/.test(id) && id.split(':').includes(want)) { match = true; break }
            }
          }
          if (match && (!hit || hit.contains(n))) hit = n
        }
        if (!hit) return false
        document.querySelectorAll('[data-aurabot="conv"]').forEach((x) => x.removeAttribute('data-aurabot'))
        hit.setAttribute('data-aurabot', 'conv')
        return true
      })()`).catch(() => false)
      if (!found) await sleep(1000)
    }
    // 列表里没有：用主页的「私信」按钮开一个新会话（陌生人也能主动发起）
    if (!found && secUid) found = await openFromProfile(secUid)
    if (!found) throw Object.assign(new Error('私信列表里没找到这个人，主页也没有可用的「私信」入口（可能对方关闭了私信）'), { code: 'dm' })
    await b.press('[data-aurabot="conv"]')
    await sleep(1500)
  }

  /** 打开某人的主页，点「私信」发起会话（列表里还没有的陌生人）。只打开会话，不发消息。 */
  async function openFromProfile(secUid) {
    const id = String(secUid || '')
    if (!/^MS4w[\w-]+$/.test(id)) return false
    await b.goto(`https://www.douyin.com/user/${id}`)
    const marked = await (async () => {
      for (let i = 0; i < 25; i++) {
        const ok = await b.evaluate(`(() => {
          // 「私信」可能在 button 里，也可能是个 div / span；取可见元素里最小（最像按钮）的那个
          const nodes = [...document.querySelectorAll('button,[role="button"],div,span,a,[data-e2e]')]
            .filter((n) => (n.innerText || '').trim() === '私信')
            .filter((n) => { const r = n.getBoundingClientRect(); return r.width > 10 && r.height > 10 })
          if (!nodes.length) return false
          nodes.sort((a, c) => (a.getBoundingClientRect().width * a.getBoundingClientRect().height) - (c.getBoundingClientRect().width * c.getBoundingClientRect().height))
          const hit = nodes[0]
          document.querySelectorAll('[data-aurabot="dm-open"]').forEach((x) => x.removeAttribute('data-aurabot'))
          hit.setAttribute('data-aurabot', 'dm-open')
          return true
        })()`).catch(() => false)
        if (ok) return true
        await sleep(1000)
      }
      return false
    })()
    if (!marked) return false
    await b.press('[data-aurabot="dm-open"]')
    // 点完可能停在私信页，也可能弹出会话：等到输入框出现，再按 uid 核对一次会话
    for (let i = 0; i < 20; i++) {
      await sleep(1000)
      const href = String(await b.evaluate('location.href').catch(() => ''))
      // URL 可能不带 isPopup 参数，按域名 + 路径判断，再看输入框是否真的出现
      if (/^https:\/\/www\.douyin\.com\/chat/.test(href) && await b.evaluate(`Boolean(document.querySelector('.editor-kit-container[contenteditable="true"]'))`).catch(() => false)) return true
    }
    return false
  }

  /** 当前会话里的消息（从旧到新）：{ id, uid, text, at, card }；card = 分享的视频 { awemeId, title }。 */
  async function readChat() {
    const list = await b.evaluate(`(() => {
      const out = [], seen = new Set()
      for (const n of document.querySelectorAll('div')) {
        const k = Object.keys(n).find((x) => x.startsWith('__reactFiber$')); if (!k) continue
        let m = null
        for (let f = n[k], j = 0; f && j < 3 && !m; f = f.return, j++) { const v = f.memoizedProps && f.memoizedProps.message; if (v && typeof v === 'object' && 'isMyMessage' in v) m = v }
        if (!m) continue
        const id = String(m.serverId ?? '')
        if (!id || seen.has(id)) continue
        seen.add(id)
        const p = m.parsedContent || {}
        const at = m.createdAt instanceof Date ? m.createdAt.getTime() : Number(m.createdAt) || 0
        out.push({ id, uid: String(m.sender ?? ''), mine: m.isMyMessage === true, text: String(p.text || '').slice(0, 500), at, card: p.itemId ? { awemeId: String(p.itemId), title: String(p.content_title || '').slice(0, 80) } : null })
      }
      return out.sort((a, c) => a.at - c.at)
    })()`).catch(() => [])
    return Array.isArray(list) ? list : []
  }

  /** 和这个人的私信：打开会话、读最近的消息（页面在后台时消息要过一会儿才加载出来，等一等）。 */
  async function dms(uid, { secUid = '' } = {}) {
    await openChat(uid, { secUid })
    let list = []
    for (let i = 0; i < 15 && !list.length; i++) {
      list = await readChat()
      if (!list.length) await sleep(1000)
    }
    return list
  }

  /** 在当前打开的会话里发一条私信：清空输入框、打字、回车（页面在后台时按键照样送得到），等私信接口发送成功。 */
  async function sendDm(text) {
    const ok = await b.evaluate(`(() => {
      // 按输入框自己的样子认（占位文字「发送消息」），别按位置：窗口宽窄不同，会话列表的宽度也不同
      const e = document.querySelector('.editor-kit-container[contenteditable="true"]') || [...document.querySelectorAll('[contenteditable="true"]')].find((x) => /发送消息/.test(x.getAttribute('data-placeholder') || x.getAttribute('placeholder') || ''))
      if (!e) return false
      e.setAttribute('data-aurabot', 'dm-edit')
      e.focus()
      return document.activeElement === e
    })()`).catch(() => false)
    if (!ok) throw new Error('私信输入框点不进去')
    // 打完字先核对框里是不是完整的这句（遇到过只发出去半句的），不对就清掉重打一次
    const inBox = () => b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(DM_EDIT)}); return e ? e.innerText : '' })()`).catch(() => '')
    for (let tries = 0; ; tries++) {
      await b.clearFocused()
      await b.type(text)
      await sleep(400 + Math.random() * 600)
      const typed = await inBox()
      if (dmEqual(typed, text)) break
      if (tries >= 1) { await b.clearFocused().catch(() => {}); throw new Error('私信输入框里的字对不上，没发') }
    }
    const startedAt = Date.now()
    const sent = /\/v1\/message\/send/
    let resp = b.waitResponse(sent, 8000)
    await b.pressEnter()
    let r = await resp
    // 没等到回执不代表失败，不能再点一次发送（IM 可能自动重发）。
    // 只认本账号、发送开始之后的新消息；不能拿主人说过的同一句当成功。
    if (!r) {
      await sleep(1500)
      const mine = (await readChat()).some((m) => m.mine && m.at >= startedAt - 2000 && dmEqual(m.text, text))
      if (mine) return { ok: true }
      const remaining = await inBox()
      // 仍完整留在输入框，且没有新消息：回车没触发发送，可安全点击一次按钮。
      if (dmEqual(remaining, text)) {
        const marked = await b.evaluate(`(() => { const s = document.querySelector('[class*="publishBtn"]'); if (!s) return false; s.setAttribute('data-aurabot', 'dm-send'); return true })()`).catch(() => false)
        if (marked) {
          const response = b.waitResponse(sent, 8000)
          await b.press('[data-aurabot="dm-send"]')
          r = await response
          if (!r) {
            await sleep(1500)
            const confirmed = (await readChat()).some((m) => m.mine && m.at >= startedAt - 2000 && dmEqual(m.text, text))
            if (confirmed) return { ok: true }
          }
        }
      }
      if (!r) throw Object.assign(new Error('私信发送状态不确定，已暂停重试，避免重复发送'), { code: 'dm_uncertain' })
    }
    if (r.status !== 200) {
      await b.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(DM_EDIT)}); e && e.focus() })()`).catch(() => {})
      await b.clearFocused().catch(() => {}) // 没发出去的字别留在框里，免得下次接在后面
      throw new Error(`私信没发出去（HTTP ${r.status}）`)
    }
    return { ok: true }
  }

  /** 按 sec_uid 查一个人（@ 之前拿最新昵称；核对主人用）。 */
  async function user(secUid) {
    const u = (await api('/aweme/v1/web/user/profile/other/', { sec_user_id: secUid, source: 'channel_pc_web' })).user || {}
    if (!u.sec_uid) throw new Error('找不到这个抖音号')
    return { secUid: String(u.sec_uid), uid: String(u.uid || ''), nickname: clean(u.nickname, 40), douyinId: String(u.unique_id || u.short_id || '') }
  }

  /**
   * 认一个人：主页链接 / secUid 直接查；v.douyin.com 短链先在浏览器里跳一下取主页；
   * 其余当抖音号搜。找不到会抛错。
   */
  async function profileOf(link) {
    const s = String(link || '').trim()
    if (!s) throw new Error('没给抖音主页链接或抖音号')
    const direct = s.match(/douyin\.com\/user\/(MS4w[\w-]+)/)?.[1] || (/^MS4w[\w-]+$/.test(s) ? s : '')
    if (direct) return user(direct)
    if (/^https?:\/\//i.test(s)) {
      await b.goto(s)
      for (let i = 0; i < 10; i++) {
        const href = String(await b.evaluate('location.href').catch(() => ''))
        const sec = href.match(/douyin\.com\/user\/(MS4w[\w-]+)/)?.[1]
        if (sec) return user(sec)
        await sleep(1000)
      }
      throw new Error('这个链接不是抖音主页（或者没跳过去）')
    }
    return findByDouyinId(s.replace(/^@/, ''))
  }

  /** 按抖音号搜人，只认抖音号完全一样的。 */
  async function findByDouyinId(douyinId) {
    const j = await api('/aweme/v1/web/discover/search/', { keyword: douyinId, search_channel: 'aweme_user_web', search_source: 'normal_search', query_correct_type: 1, is_filter_search: 0, offset: 0, count: 10 })
    const hit = (j.user_list || []).map((x) => x.user_info || {}).find((u) => [u.unique_id, u.short_id].map(String).includes(String(douyinId)))
    if (!hit?.sec_uid) throw new Error('按抖音号没搜到这个人，换成主页链接试试')
    return user(hit.sec_uid)
  }

  /** 截登录弹窗（二维码、扫完待确认、二次验证都在里面）；弹窗不在就截整页。 */
  async function loginShot() {
    const box = await b.evaluate(`(() => {
      const n = document.querySelector('#login-panel-new') || document.querySelector('#douyin_login_comp_flat_panel')
      if (!n) return null
      const r = n.getBoundingClientRect()
      return r.width > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
    })()`).catch(() => null)
    return b.screenshot(box || undefined).catch(() => '')
  }

  /** 开始扫码登录：已登录直接返回；否则点右上角「登录」，等二维码出来。 */
  async function loginStart() {
    const ok = await ensure()
    if (!ok.ok) return ok
    const me = await self()
    if (me) return { ok: true, loggedIn: true, me }
    // 右上角「登录」：先做个记号再点（页面看不见时也点得到）
    const marked = await b.evaluate(`(() => {
      const all = [...document.querySelectorAll('button,div,span,a,p')].filter((n) => (n.innerText || '').trim() === '登录' && n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().top < 120)
      const n = all.sort((a, c) => a.getBoundingClientRect().width - c.getBoundingClientRect().width)[0]
      if (n) n.setAttribute('data-aurabot', 'login')
      return Boolean(n)
    })()`).catch(() => false)
    if (marked) await b.press('[data-aurabot="login"]')
    await b.waitFor('#douyin_login_comp_scan_code img, #douyin_login_comp_scan_code canvas', 12000)
    return { ok: true, loggedIn: false, shot: await loginShot() }
  }

  /** 扫码中途看一眼：登上了就返回号，没登上就给最新的弹窗截图。 */
  async function loginPoll() {
    if (!b.connected()) return { ok: true, loggedIn: false, shot: '' }
    const me = await self().catch(() => null)
    if (me) return { ok: true, loggedIn: true, me }
    return { ok: true, loggedIn: false, shot: await loginShot() }
  }

  return { ensure, self, user, profileOf, findByDouyinId, feed, detail, comments, verify, watch, like, comment, share, dms, sendDm, screenshot: () => b.screenshot().catch(() => ''), loginStart, loginPoll, show: (v) => b.show(v), connected: () => b.connected() }
}
