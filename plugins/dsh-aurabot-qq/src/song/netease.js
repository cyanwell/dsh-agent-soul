// 网易云音乐：搜歌、拿下载地址。用网页版的 weapi 加密方式请求（和 NeteaseCloudMusicApi 一样）。
// 不登录只能下免费歌；VIP / 版权歌要在面板里填网易云的 Cookie（MUSIC_U）。

import { createCipheriv, randomBytes } from 'node:crypto'

const PRESET_KEY = '0CoJUm6Qyw8W8jud'
const IV = '0102030405060708'
const MODULUS = BigInt('0x00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7')
const EXPONENT = 0x010001n
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

function aes(text, key) {
  const c = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(IV))
  return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('base64')
}

function modPow(base, exp, mod) {
  let r = 1n
  base %= mod
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod
    base = (base * base) % mod
    exp >>= 1n
  }
  return r
}

/** RSA（无填充）：网易云要求把密钥倒过来再加密。 */
function rsa(secKey) {
  const m = BigInt('0x' + Buffer.from([...secKey].reverse().join('')).toString('hex'))
  return modPow(m, EXPONENT, MODULUS).toString(16).padStart(256, '0')
}

/** weapi 加密：返回要 POST 的表单。 */
export function weapi(data) {
  const secKey = [...randomBytes(16)].map((b) => BASE62[b % 62]).join('')
  return { params: aes(aes(JSON.stringify(data), PRESET_KEY), secKey), encSecKey: rsa(secKey) }
}

/** 从用户粘贴的 Cookie 里只取 MUSIC_U（粘整段 Cookie 或只粘值都行）。 */
export function musicU(cookie) {
  const s = String(cookie || '').trim()
  if (!s) return ''
  const m = s.match(/MUSIC_U=([^;\s]+)/)
  return m ? m[1] : s.includes('=') ? '' : s
}

async function post(path, data, cookie) {
  const u = musicU(cookie)
  const r = await fetch('https://music.163.com/weapi' + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      referer: 'https://music.163.com/',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      cookie: 'os=pc; appver=3.0.0' + (u ? '; MUSIC_U=' + u : ''),
    },
    body: new URLSearchParams(weapi({ ...data, csrf_token: '' })).toString(),
    signal: AbortSignal.timeout(20000),
  })
  const j = await r.json().catch(() => ({}))
  if (j.code !== 200) throw new Error(`网易云返回 ${j.code ?? r.status}${j.message || j.msg ? '：' + (j.message || j.msg) : ''}`)
  return j
}

/** 搜歌：[{id, name, artists, durationSec, vip}] */
export async function searchSongs(keyword, { cookie, limit = 5 } = {}) {
  const j = await post('/cloudsearch/pc', { s: String(keyword), type: 1, limit, offset: 0 }, cookie)
  return (j.result?.songs || []).map((s) => ({
    id: s.id,
    name: s.name,
    alias: (s.alia || []).join(" "),
    artists: (s.ar || []).map((a) => a.name).join(' / '),
    durationSec: Math.round((s.dt || 0) / 1000),
    vip: s.fee === 1 || s.fee === 4,
  }))
}

/** 拿下载地址：{url, trial}。拿不到返回 url=''。trial = 只给了试听片段（没登录或不是会员）。 */
export async function songUrl(id, { cookie } = {}) {
  const j = await post('/song/enhance/player/url/v1', { ids: `[${id}]`, level: 'exhigh', encodeType: 'mp3' }, cookie)
  const d = (j.data || [])[0] || {}
  return { url: d.url || '', trial: Boolean(d.freeTrialInfo), type: d.type || 'mp3' }
}

/** 查登录状态：Cookie 有没有用。 */
export async function account(cookie) {
  if (!musicU(cookie)) return { ok: false, message: '没填 Cookie' }
  try {
    const j = await post('/w/nuser/account/get', {}, cookie)
    if (!j.profile) return { ok: false, message: 'Cookie 失效了，重新复制一份' }
    return { ok: true, nickname: j.profile.nickname, vip: (j.account?.vipType || 0) > 0 }
  } catch (error) {
    return { ok: false, message: error.message }
  }
}
