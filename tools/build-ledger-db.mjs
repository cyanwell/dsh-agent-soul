// build-ledger-db —— 在 00-记忆库里建真正的账本库（不是内存库）
// ============================================================================
// 爀曦 2026-11-12 指出：ledger.sql 现在只在内存库验过，生产还没建表。
//
// ★ 这一步只做「建表」，**不迁移任何旧数据**（他定：新记忆入库、旧的原地不动）。
//   02-墨.jsonl 一条不动 —— 它继续是权威，直到统合真正完成。
//
// ★ 幂等：全部 CREATE ... IF NOT EXISTS，跑几次都一样。
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const LIB = 'D:/AI/yanqing-soul/00-记忆库'
const DB = path.join(LIB, 'ledger.sqlite')
const SQL = 'D:/AI/agent-soul/sql/ledger.sql'

const sql = fs.readFileSync(SQL, 'utf8')
const existed = fs.existsSync(DB)
const db = new DatabaseSync(DB)
db.exec(sql)

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()
const trigs = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()
const cols = db.prepare('PRAGMA table_info(ledger)').all()

console.log('库 =', DB, existed ? '（已存在）' : '（新建）')
console.log('表 =', tables.map((t) => t.name).join(', ') || '(无)')
console.log('列 =', cols.map((c) => c.name).join(', '))
console.log('触发器 =', trigs.map((t) => t.name).join(', ') || '(无)')

// ★ 建完立刻验一次闸门（不是只相信 CREATE 成功）
let pass = 0, fail = 0
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✓ ' + n + (d ? '  ' + d : '')) } else { fail++; console.log('  ✗ ' + n + (d ? '  ' + d : '')) } }
const ins = db.prepare('INSERT INTO ledger (t,type,text,by) VALUES (?,?,?,?)')

// ★ 整段测试包在事务里，最后 ROLLBACK —— 生产库不许留测试行。
db.exec('BEGIN')

try { ins.run('2026-11-12T10:35:00','promise','生产库的第一个测试承诺','session-TEST'); ok('无 lead 时写 promise 被拒', false) }
catch (e) { ok('无 lead 时写 promise 被拒', true, String(e.message).slice(0,40)) }
try { ins.run('2026-11-12T10:35:01','lead','第 12 代 · 接手于 2026-11-12 · 上一代做了：闭环归 v4','session-TEST'); ok('写 lead', true) }
catch (e) { ok('写 lead', false, String(e.message).slice(0,50)) }
try { ins.run('2026-11-12T10:35:02','promise','生产库闸门测试','session-OTHER'); ok('器官写 promise 被拒', false) }
catch (e) { ok('器官写 promise 被拒', true, String(e.message).slice(0,40)) }

// ★★ 测试数据怎么清 —— 这里踩了一个坑，值得写下来。
//
//   第一版我写 db.exec("DELETE FROM ledger") 想清掉测试行，**结果被自己的触发器拒了**，
//   脚本当场崩 —— 而那是触发器**做对了**。
//
//   ★ 只追加的账本**没有"删掉重来"这条路**。所以验收必须在写之前就想清楚：
//     要么在事务里写、最后 ROLLBACK；要么用一次性临时库。
//   这里是生产库，所以用 ROLLBACK。
//
//   ★ 更狠的一条：我第一次跑已经把 3 行测试数据**永久留在这个库里**了。
//     DELETE 拦住了我，DELETE 也拦住了"清理"。
//     **只追加的代价不是"不能改历史"，是"连自己的测试垃圾也清不掉"。**
//     所以我把这个库整个删掉重建（它还没上线，没有真实数据）。
db.exec('ROLLBACK')

db.close()
console.log('')
console.log((fail === 0 ? 'ALL PASS' : 'FAILED') + ' · ' + pass + ' 通过 / ' + fail + ' 失败')
console.log('库大小 = ' + Math.round(fs.statSync(DB).size / 1024) + 'KB')
