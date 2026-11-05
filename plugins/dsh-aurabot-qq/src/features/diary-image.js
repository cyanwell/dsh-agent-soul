// 空间日记的配图：优先用今天她自己画的图，其次用今天收进表情库的表情包。
// 只从本机数据目录里挑，不接受外部输入；找不到就返回空串（日记照常只发文字）。

import { listPaintings, paintingPath } from './paintings.js'
import { loadLibrary, stickerPath } from './stickers.js'

const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

/** 给一篇日记挑一张配图（本地文件路径）；没有合适的返回 ''。 */
export function pickDiaryImage ({ now = new Date() } = {}) {
  const t0 = startOfDay(now)
  // 1) 今天她画的图：最新一张（自己画的图最贴合「她今天干了什么」）
  try {
    const paintings = listPaintings({ limit: 20 }).items.filter((p) => Number(p.at) >= t0)
    if (paintings.length) {
      const p = paintingPath(paintings[0].file)
      if (p) return p
    }
  } catch (error) {}
  // 2) 今天收进表情库的表情包：最新一张（表情库只有表情，不会把大照片带上空间）
  try {
    const items = loadLibrary().items.filter((i) => Number(i.at) >= t0)
    if (items.length) {
      const p = stickerPath(items[items.length - 1])
      if (p) return p
    }
  } catch (error) {}
  return ''
}
