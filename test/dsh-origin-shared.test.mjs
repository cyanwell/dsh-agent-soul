// 单测：心跳地址两个路径 helper 搬家后行为一字未改（2026-11-16 · 第 3 批）
//
// ★ 为什么要有它：这两个函数从 organs/dsh-origin.mjs 搬到了 organs/dsh-origin-shared.mjs，
//   而 config.mjs 的注释直接点名承诺了 dshOriginFileOf()。搬家最容易出的两种事故：
//     ① 旧 import 路径断了（\`from .../dsh-origin.mjs\`）→ 启动即炸；
//     ② 搬家时手滑改了判据 → 不炸，只是「本机默认路径」悄悄变了。
//   两个都要钉住（尤其是 ②，它不会报错）。
//
// ★ 只读本机路径的**存在性**，不读任何 DSH 内容；显式配置那条腿用临时目录。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dshLogDirOf, dshOriginFileOf } from '../src/organs/dsh-origin-shared.mjs'
import * as viaOldPath from '../src/organs/dsh-origin.mjs'

const out = []
let failed = 0
const check = (label, ok, extra) => {
  out.push((ok ? '  ✓ ' : '  ✗ ') + label + (extra === undefined ? '' : '   [' + extra + ']'))
  if (!ok) failed += 1
}

// 1) 旧 import 路径仍然可用，而且是同一个函数
check('旧路径 re-export 得到 dshLogDirOf', typeof viaOldPath.dshLogDirOf === 'function')
check('旧路径 re-export 得到 dshOriginFileOf', typeof viaOldPath.dshOriginFileOf === 'function')
check('新旧是同一个实现（不是复制了一份）', viaOldPath.dshLogDirOf === dshLogDirOf && viaOldPath.dshOriginFileOf === dshOriginFileOf)

// 2) 显式配置优先（临时目录/文件，测完删）
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-origin-'))
  const logDir = path.join(dir, 'logs')
  fs.mkdirSync(logDir)
  const originFile = path.join(dir, 'dsh-origin.txt')
  fs.writeFileSync(originFile, 'http://127.0.0.1:65010\n', 'utf8')
  try {
    check('显式 dshLogDir 优先且原样返回',
      dshLogDirOf({ integrations: { dshLogDir: logDir } }) === logDir, dshLogDirOf({ integrations: { dshLogDir: logDir } }))
    check('显式 dshOriginFile 优先且原样返回',
      dshOriginFileOf({ integrations: { dshOriginFile: originFile } }) === originFile, dshOriginFileOf({ integrations: { dshOriginFile: originFile } }))
    check('空字符串的显式配置不等于显式（走默认）',
      dshLogDirOf({ integrations: { dshLogDir: '   ' } }) !== logDir, String(dshLogDirOf({ integrations: { dshLogDir: '   ' } })))
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ }
  }
  check('临时目录已清理', !fs.existsSync(dir))
}

// 3) 默认那条腿：本机开发默认路径存在就用它（这台机器上它是存在的）；
//    不存在时返回 null —— 两种都是合法结果，判据是「返回的类型对得上」。
{
  const d = dshLogDirOf({})
  check('默认日志目录：有就是字符串，没有就是 null', d === null || typeof d === 'string', String(d))
  const f = dshOriginFileOf({})
  check('默认 origin 文件：有就是字符串，没有就是 null', f === null || typeof f === 'string', String(f))
  if (f) check('返回的文件真的存在（文件存在才用）', fs.existsSync(f), f)
  if (d) check('返回的目录真的存在（目录存在才用）', fs.existsSync(d), d)
}

// 4) 环境变量那条腿：给了 DSH_HOME 且 <home>/guard/logs 存在 → 用它
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-dshhome-'))
  fs.mkdirSync(path.join(dir, 'guard', 'logs'), { recursive: true })
  const old = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = dir
    const got = dshLogDirOf({})
    check('DSH_HOME 的 guard/logs 存在时被采用',
      got === path.join(dir, 'guard', 'logs'), String(got))
    check('显式配置仍然压过 DSH_HOME',
      dshLogDirOf({ integrations: { dshLogDir: path.join(dir, 'x') } }) === path.join(dir, 'x'))
  } finally {
    if (old === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = old
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
}

console.log(out.join('\n'))
console.log(failed === 0 ? '\n★ 全部通过' : '\n★ 失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
