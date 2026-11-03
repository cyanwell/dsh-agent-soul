#!/usr/bin/env node
// heartbeat.mjs —— 单次检查（不是常驻循环）
// 由外部定时器调用（计划任务 / 插件 setInterval）；每次运行独立、可测、不占内存。
// MVP 阶段：只 observe，不执行任何真实动作。

import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, appendFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
import { decidePhase, decideCron } from './heartbeat-core.mjs';
import { idleMinutes } from './activity.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const HERE = dirname(fileURLToPath(import.meta.url));

// ★ 2026-11-04 修死路径：原来这里把记忆库位置写死在作者电脑上，换台电脑就全废。
//   现在从 DSH_HOME 往上推两级再拼 memory/hub；也知道 YQ_HUB 环境变量。
//   也允许用 YQ_HUB 环境变量直接指定（比如记忆库不在 DSH 旁边时）。
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const HUB = process.env.YQ_HUB || join(dirname(dirname(DSH_HOME)), 'memory', 'hub');
const SOUL = process.env.YQ_SOUL || join(dirname(dirname(DSH_HOME)), 'yanqing-soul');
const CFG = join(HERE, 'heartbeat.config.json');
const STATE = join(HERE, 'heartbeat.state.json');
const LOG = join(HERE, 'heartbeat.log.jsonl')
const REPORTS = join(HUB, 'heartbeat', 'reports')   // ★ 巡视报告目录（和 daily 自检分开）

// ★ 2026-11-03 加：手动触发
//   --manual : 由面板/命令行手动触发，不看 cron、不看静默（但看总开关）
//   --force  : 连总开关也不看（应急用，记录里会标 force）
const ARGV = process.argv.slice(2)
const MANUAL = ARGV.includes('--manual')
const FORCE = ARGV.includes('--force')

const now = Date.now();
// ★ 2026-11-04 加兜底：仓库里只放 heartbeat.config.example.json，真实配置由各人部署时生成。
//   以前这里裸读，缺文件就 ENOENT 崩 —— 也正是「clone 下来跑不起来」的一环。
//   缺 config 用内置默认（保守值：关着、不跑），缺 state 当全新开始。
const DEFAULT_CONFIG = {
  enabled: false,                       // ★ 默认关：没配置就别自己跑起来
  options: {
    idleThresholdMinutes: 15,
    checkIntervalMinutes: 10,
    schedule: { mode: 'cron', cron: '0 6,12 * * *', timezone: 'Asia/Shanghai' },
    catchUpMissed: false,
    budget: { maxRunsPerDay: 6, maxTokensPerRun: null },
    quietHours: null,
    auditLevel: 'normal',
    logLevel: 'full',
    toolsAllowlist: ['memindex', 'self', 'daily', 'doctor'],
    retry: { max: 1, delaySec: 5 },
    customSteps: [],
    audit: { tier: 1, enabled: true, humanPresentMinutes: 15, sandboxDirs: [HUB, join(SOUL, '20-档案'), join(SOUL, '50-日记'), HUB], irreversible: ['delete', 'push', 'trade'] },
  },
  ignoreSessionIds: [],
};
const config = existsSync(CFG) ? JSON.parse(readFileSync(CFG, 'utf8')) : DEFAULT_CONFIG;
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};

const idle = idleMinutes(config.ignoreSessionIds || []);
const phase = decidePhase({ now, state, config, idleMinutes: idle.ok ? idle.minutes : null });
const cron = decideCron({ now, config, lastRunAt: state.lastRunAt });

// ★ 今天该不该动：要同时满足「人在不在」和「到没到点」
//
// ★★ 2026-11-03 加手动触发（命题 4 能力层）：
//   手动 = 不看 cron、不看静默 —— 但**仍然看总开关**（FORCE 才绕过）。
//   ★ 这条约束不能省：否则面板上那个按钮就成了「绕过关掉自主」的后门。
const enabled = FORCE ? true : config.enabled
const shouldRunManually = MANUAL && enabled
const shouldRun = FORCE ? true : (shouldRunManually ? enabled : (phase.phase === 'autonomous' && cron.due))
const trigger = FORCE ? 'force' : (MANUAL ? 'manual' : 'cron')

// ★ 2026-11-03 加：shouldRun 时**真执行**。
//   ★★ 2026-11-03 09:28 修：原来只跑 `heartbeat.mjs daily` —— 那是**第 3 步**，
//      而老 cmd 跑的是**完整四步**。直接替会丢掉索引重建和 SELF 装配。
//      现在照老 cmd 的步子跑全。
// ★ 2026-11-03：给每步加 id，让 config.toolsAllowlist 能当「步骤白名单」用。
//   原设计叫「可用工具集」（agent 巡视时能调哪些工具），但本架构里巡视跑的是**固定四步脚本**，
//   没有 agent 调工具这回事。所以语义改成「允许跑哪几步」—— 同样能控住巡视做什么，且立刻有落点。
const FOUR_STEPS = [
  ['memindex', 'memindex build', join(HUB, 'memindex.mjs'), ['build']],
  ['self', 'self assemble', join(HUB, 'self.mjs'), []],
  ['daily', 'heartbeat daily', join(HUB, 'heartbeat.mjs'), ['daily']],
  ['doctor', 'echo doctor', join(HUB, 'echo-doctor.mjs'), []],
]

// ★ 2026-11-03 加：自定义步骤（命题 4 能力层 ④）
//   让四步之外能加自己的巡视动作。
//   ★★ 安全约束（硬编码，不给配置项）：
//      ① 只允许跑**本机已存在的文件**，路径必须存在且是文件
//      ② 只允许 node 脚本（.mjs/.js）或 .cmd/.ps1 —— 不内联执行任意字符串
//      ③ 参数单独给数组，不从字符串拼
//   这条是硬线：巡视是**自动定时跑的东西**，它读的内容不受我控制，
//   如果允许内联 shell，等于给「外部内容」开了一个定时执行的入口。
function resolveCustomSteps () {
  const raw = config.options && config.options.customSteps
  if (!Array.isArray(raw) || !raw.length) return { steps: [], rejected: [] }
  const steps = []
  const rejected = []
  for (const s of raw) {
    if (!s || s.enabled === false) continue
    const id = String(s.id || '').trim()
    const file = String(s.script || '').trim()
    if (!id || !/^[a-zA-Z0-9_-]+$/.test(id)) { rejected.push({ id, why: 'id 为空或含非法字符' }); continue }
    if (!file) { rejected.push({ id, why: 'script 为空' }); continue }
    if (!/\.(mjs|js|cjs|cmd|ps1)$/i.test(file)) { rejected.push({ id, why: '只允许 .mjs/.js/.cjs/.cmd/.ps1' }); continue }
    if (!existsSync(file)) { rejected.push({ id, why: '文件不存在: ' + file }); continue }
    let isFile = false
    try { isFile = statSync(file).isFile() } catch (e) {}
    if (!isFile) { rejected.push({ id, why: '不是普通文件: ' + file }); continue }
    const args = Array.isArray(s.args) ? s.args.map(String) : []
    const timeoutSec = Number.isInteger(s.timeoutSec) ? Math.max(5, Math.min(s.timeoutSec, 600)) : 60
    steps.push({ id, name: s.name || id, file, args, timeoutSec })
  }
  return { steps, rejected }
}

// 按 toolsAllowlist 过滤要跑的步骤。空数组 = 全不跑（不是全跑）。
// ★★ 2026-11-03 修：原值是老的工具名（read/glob/grep/…），
//   而我把语义改成了步骤白名单（memindex/self/daily/doctor）。
//   如果直接按新语义过滤，老值会把四步全滤掉 —— **巡视变成什么都不做**。
//   所以：只要一个步骤 id 都没命中，就当作"没配置过"，全跑。
function allowedSteps() {
  const allow = config.options && config.options.toolsAllowlist
  const all = FOUR_STEPS
  if (!Array.isArray(allow) || allow.length === 0) return { steps: all, skipped: [], legacy: true }
  const ids = new Set(allow.map(String))
  const hit = all.filter(s => ids.has(s[0]))
  if (hit.length === 0) {
    // 老格式（工具名）或写错了 —— 不改变原有行为，全跑，并在记录里标一笔
    return { steps: all, skipped: [], legacy: true, raw: allow }
  }
  const skipped = all.filter(s => !ids.has(s[0])).map(s => s[0])
  return { steps: hit, skipped }
}

async function runFourSteps() {
  const t0 = Date.now()
  const steps = []
  const { steps: todo, skipped } = allowedSteps()

  // ★ 2026-11-03 加：失败重试（命题 4 能力层 ⑥）
  //   有些失败是瞬时的（文件被占用、临时 I/O 抖动），重试一次往往就过。
  //   ★★ 不无限重试 —— 次数可配、默认 1、上限 3；每一次尝试都留痕。
  const retryCfg = (config.options && config.options.retry) || {}
  const maxRetry = Number.isInteger(retryCfg.max) ? Math.max(0, Math.min(retryCfg.max, 3)) : 1
  const delayMs = Number.isInteger(retryCfg.delaySec) ? Math.max(0, retryCfg.delaySec) * 1000 : 5000
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  for (const [id, name, file, args] of todo) {
    const s0 = Date.now()
    let attempt = 0
    let lastErr = null
    let okNow = false
    const tries = []
    while (attempt <= maxRetry) {
      const a0 = Date.now()
      try {
        // ★ 不加 --dry：老 cmd 也不是 dry。要的就是真写。
        await execFileP(process.execPath, [file, ...args],
          { timeout: 180000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
        okNow = true
        tries.push({ attempt: attempt + 1, ok: true, ms: Date.now() - a0 })
        break
      } catch (e) {
        lastErr = String(e && e.message || e).slice(0, 160)
        tries.push({ attempt: attempt + 1, ok: false, ms: Date.now() - a0, why: lastErr })
        attempt++
        if (attempt <= maxRetry) await sleep(delayMs)
      }
    }
    const item = { step: name, ok: okNow, ms: Date.now() - s0 }
    if (!okNow) item.why = lastErr
    if (tries.length > 1) item.tries = tries   // 只有真重试过才带，避免臃肿
    steps.push(item)
  }
  // ★ 自定义步骤（四步之后按序跑）
  const custom = resolveCustomSteps()
  for (const cs of custom.steps) {
    const s0 = Date.now()
    let attempt = 0
    let lastErr = null
    let okNow = false
    const tries = []
    while (attempt <= maxRetry) {
      const a0 = Date.now()
      try {
        // ★ .cmd/.ps1 走系统 shell；.mjs/.js 走 node。参数都是数组，不拼字符串。
        if (/\.(cmd|ps1)$/i.test(cs.file)) {
          await execFileP('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cs.file, ...cs.args],
            { timeout: cs.timeoutSec * 1000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
        } else {
          await execFileP(process.execPath, [cs.file, ...cs.args],
            { timeout: cs.timeoutSec * 1000, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
        }
        okNow = true
        tries.push({ attempt: attempt + 1, ok: true, ms: Date.now() - a0 })
        break
      } catch (e) {
        lastErr = String(e && e.message || e).slice(0, 160)
        tries.push({ attempt: attempt + 1, ok: false, ms: Date.now() - a0, why: lastErr })
        attempt++
        if (attempt <= maxRetry) await sleep(delayMs)
      }
    }
    const item = { step: '[自定义] ' + cs.name, ok: okNow, ms: Date.now() - s0, custom: true }
    if (!okNow) item.why = lastErr
    if (tries.length > 1) item.tries = tries
    steps.push(item)
  }

  const r = { ok: steps.every((x) => x.ok), ms: Date.now() - t0, steps }
  if (skipped.length) r.skippedByAllowlist = skipped
  if (custom.rejected.length) r.rejectedCustom = custom.rejected
  return r
}
// ★ 2026-11-03 加：巡视报告（命题 4 能力层）
//   ★ 和 heartbeat daily 的区别：
//     daily    = 记忆完整性自检（索引/审计/留底库）—— 已有的
//     巡视报告 = **这次巡视本身做了什么的交代** —— 人读的
//   ★ 按已有 daily 的风格写（标题 / 读数 / 做了什么 / 能不能撤回），不自创格式。
// ★ 2026-11-03 加：发现问题后的动作（命题 4 能力层 ⑤）
//   ★★ 诚实取舍：脚本里调不到 notify_wechat（那是 agent 工具）。
//      所以这里做的是「记一笔 + 待处理队列」——
//      面板显示「N 条待处理」，由主导会话或人来看。
//      **不假装能主动发微信。**
const ALARMS = join(REPORTS, 'alarms.jsonl')

function recordAlarms (rec, reportFile) {
  try {
    if (!rec.executed) return []
    const bad = rec.executed.steps.filter((s) => !s.ok)
    const rejected = rec.executed.rejectedCustom || []
    const alarms = []
    for (const s of bad) {
      alarms.push({
        t: new Date(now).toISOString(),
        kind: 'step-failed',
        step: s.step,
        why: s.why || '（无错误信息）',
        retries: s.tries ? s.tries.length - 1 : 0,
        report: reportFile || null,
        acked: false,
      })
    }
    for (const r of rejected) {
      alarms.push({
        t: new Date(now).toISOString(),
        kind: 'custom-rejected',
        step: r.id,
        why: r.why,
        report: reportFile || null,
        acked: false,
      })
    }
    if (!alarms.length) return []
    if (!existsSync(REPORTS)) mkdirSync(REPORTS, { recursive: true })
    appendFileSync(ALARMS, alarms.map((a) => JSON.stringify(a)).join('\n') + '\n', 'utf8')
    return alarms
  } catch (e) {
    return []
  }
}

// ★ 2026-11-03 加：让心跳能主动喊人（C 项 · 自主运转的出口）
//   ★★ 为什么这样做：不碰凭据。脚本只调本机的 /clawbot/send，
//      token 在 clawbot 自己手里，脚本连 state.json 都不读。
//   ★ 端口从哪来：index.js 插件启动时把 getOrigin() 写进 dsh-origin.txt ——
//      因为脚本是被计划任务拉起的独立进程，它不可能知道 DSH 这次监听在哪。
//   ★★ 只在**真有问题**时发（有报警 / 有步骤失败）。没事不发 ——
//      否则「自主」就变成「骚扰」，那是命题 7 说的注意力预算被烧掉。
async function notifyWechat (text) {
  const t = String(text || '').trim()
  if (!t) return { ok: false, why: 'empty' }
  const originFile = join(SCRIPT_DIR, 'dsh-origin.txt')
  if (!existsSync(originFile)) return { ok: false, why: '没有 dsh-origin.txt（插件还没写过一次）' }
  let origin = ''
  try { origin = readFileSync(originFile, 'utf8').trim() } catch (e) { return { ok: false, why: 'origin 读不到' } }
  if (!origin || !/^https?:\/\//.test(origin)) return { ok: false, why: 'origin 内容不对: ' + origin.slice(0, 40) }
  try {
    // ★ 用 fetch（undici）—— 和 clawbot 一样。它的注释说 ilink 对裸 http/https 做 TLS 指纹，
    //   所以那条路本来就走不通；但这条是本地回环，fetch 就够。
    const url = `${origin}/clawbot/send?text=${encodeURIComponent(t)}`
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
    const j = await r.json().catch(() => null)
    if (j && j.ok) return { ok: true }
    return { ok: false, why: (j && (j.errmsg || j.error)) || ('HTTP ' + r.status) }
  } catch (e) {
    return { ok: false, why: String(e && e.message || e).slice(0, 120) }
  }
}

function writeReport (rec) {
  try {
    if (!existsSync(REPORTS)) mkdirSync(REPORTS, { recursive: true })
    const d = new Date(now)
    const p2 = (n) => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`
    const file = join(REPORTS, stamp + '.md')

    const trigText = rec.trigger === 'manual' ? '手动' : (rec.trigger === 'force' ? '强制（绕过开关）' : '定时')
    const ok = rec.executed ? rec.executed.ok : false
    const ms = rec.executed ? rec.executed.ms : 0

    const L = []
    L.push('# 心跳 · 巡视报告')
    L.push('')
    // ★ 2026-11-03 修：原来用 toISOString()，那是 UTC —— 12:39 会显示成 04:39。
    //   数字看着正常，只是差 8 小时 —— 这种错最容易被当成对。
    const localStamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
    L.push(`> 巡视 ｜ ${localStamp} ｜ 触发：${trigText} ｜ 由 \`dsh-yanqing-heartbeat\` 自动执行`)
    L.push('')
    L.push('## 这次做了什么')
    L.push('')
    if (rec.executed) {
      for (const s of rec.executed.steps) {
        const retryNote = s.tries ? ` ｜ 重试 ${s.tries.length - 1} 次` : ''
        L.push(`- ${s.ok ? '✓' : '✗'} **${s.step}** — ${(s.ms / 1000).toFixed(1)}s${retryNote}${s.why ? ' ｜ ' + s.why : ''}`)
      }
      if (rec.executed.skippedByAllowlist && rec.executed.skippedByAllowlist.length) {
        L.push(`- 按白名单跳过：${rec.executed.skippedByAllowlist.join(' / ')}`)
      }
    } else {
      L.push('- **没有执行** —— ' + (rec.manualNote || (rec.phaseReason || '判定为静息')))
    }
    L.push('')
    L.push('## 读数')
    L.push('')
    L.push(`- 判定：phase=${rec.phase}（${rec.phaseReason}）`)
    L.push(`- 定时：cronDue=${rec.cronDue}（${rec.cronReason}）`)
    L.push(`- 用户静默：${rec.idleMinutes === null ? '未知' : rec.idleMinutes + ' 分钟'}`)
    L.push(`- 总耗时：${(ms / 1000).toFixed(1)}s`)
    L.push('')
    L.push('## 异常')
    L.push('')
    const bad = rec.executed ? rec.executed.steps.filter((s) => !s.ok) : []
    if (!bad.length && ok) L.push('- 无。四步全过。')
    else if (!rec.executed) L.push('- 无执行，谈不上异常。' + (rec.manualNote ? '（' + rec.manualNote + '）' : ''))
    else for (const s of bad) L.push(`- **${s.step}** 失败：${s.why || '（无错误信息）'}`)
    L.push('')
    L.push('## 能不能撤回')
    L.push('')
    L.push('- 本报告**只增不改**；下一次巡视写的是另一个文件名')
    L.push('- 巡视跑的四步**只重建派生物**（索引 / 自我层 / 日检 / echo doctor），不动一手层')
    L.push('- 一手层（会话日志 / 《墨》 / 书房）巡视只读，不写')
    L.push('')
    L.push('---')
    L.push('')
    L.push(ok ? '**一句话：四步全过，没有需要处理的东西。**' : '**一句话：有步骤失败，看上面「异常」那节。**')
    L.push('')

    writeFileSync(file, L.join('\n'), 'utf8')
    return file
  } catch (e) {
    return null
  }
}

const record = {
  t: new Date(now).toISOString(),
  trigger,                    // ★ cron | manual | force
  phase: phase.phase,
  phaseReason: phase.reason,
  cronDue: cron.due,
  cronReason: cron.reason,
  shouldRun,
  mode: shouldRun ? 'execute' : 'observe',
  activity: (() => {
    const r = idleMinutes(config.ignoreSessionIds || []);
    return { ok: r.ok, lastAt: r.lastActivityAt, scanned: r.scanned, skipped: r.skipped };
  })(),
  wouldDo: shouldRun ? '跑四步日检（索引/自我层/日检/echo doctor）' : null,
  manualNote: MANUAL && !config.enabled && !FORCE ? '总开关关着，手动触发被拒（用 --force 才会跑）' : null,
  // ★ 2026-11-03 改：不再读 state.lastUserActivityAt（没人写它），改成扫会话日志 mtime。
  //   排除 ignore 列表里的会话 id —— 否则本会话每轮都在写，永远算成 0 分钟。
  idleMinutes: (() => {
    const r = idleMinutes(config.ignoreSessionIds || []);
    return r.ok ? r.minutes : null;
  })(),
};

// 更新状态（★ 绝不写 lastUserActivityAt —— 那是主导会话的事）
const today = new Date(now).toISOString().slice(0, 10);
const nextState = {
  ...state,
  lastHeartbeatAt: record.t,
  phase: phase.phase,
};
if (shouldRun) {
  nextState.lastRunAt = record.t;
  // lastRunResult 由真执行结果覆盖
  nextState.runsToday = state.runsTodayDate === today ? (state.runsToday || 0) + 1 : 1;
  nextState.runsTodayDate = today;
}

// ★ 真执行（只在 shouldRun 时）
if (shouldRun) {
  const r = await runFourSteps();
  record.executed = r;
  if (r.ok) {
    nextState.lastRunResult = 'executed-ok';
    console.log(`         executed: ok (${r.ms} ms)  四步全过`);
  } else {
    nextState.lastRunResult = 'executed-failed';
    for (const st of r.steps) console.log(`           ${st.ok ? '✓' : '✗'} ${st.step} (${st.ms} ms)${st.why ? '  ' + st.why : ''}`);
  }
  // ★ 写巡视报告（人读的）
  const rep = writeReport(record)
  if (rep) {
    record.reportFile = rep
    console.log(`         report: ${rep}`)
  }
  // ★ 记报警（只在真的有问题时写；没事不写，避免噪音）
  const alarms = recordAlarms(record, rep)
  if (alarms.length) {
    record.alarms = alarms.map((a) => ({ kind: a.kind, step: a.step, why: a.why }))
    console.log(`         alarms: ${alarms.length} 条（待处理）`)

    // ★ 2026-11-03 加：有报警才喊人（C 项 · 自主运转的出口）
    //   ★★ 只在**真有问题**时发。没事发一条「今天一切正常」—— 那不是汇报，那是骚扰。
    //      命题 7 说的「注意力预算」，就是被这种「一切正常」的通知烧掉的。
    if (config.options && config.options.notifyOnAlarm !== false) {
      const lines = ['⚠ 心跳巡视有问题', '']
      for (const a of alarms.slice(0, 3)) {
        lines.push(`· ${a.step}`)
        lines.push(`  ${String(a.why || '').split(String.fromCharCode(10))[0].slice(0, 100)}`)
      }
      if (alarms.length > 3) lines.push(`…还有 ${alarms.length - 3} 条`)
      if (rep) lines.push('', '报告：' + rep.split(String.fromCharCode(92)).pop())
      const n = await notifyWechat(lines.join(String.fromCharCode(10)))
      record.notify = n
      console.log(n.ok ? '         微信: 已发出' : `         微信: 没发出（${n.why}）`)
    }
  }
}

writeFileSync(STATE, JSON.stringify(nextState, null, 2), 'utf8');

// ★ 2026-11-03 补实现 logLevel（参数 8）
//   full   ：每次都记（现状）
//   errors ：只记「真的跑了但失败了」，静息/没到点的一律不记
const logLevel = (config.options && config.options.logLevel) || 'full'
const isError = shouldRun && record.executed && record.executed.ok === false
const shouldLog = logLevel === 'full' || (logLevel === 'errors' && isError)
if (shouldLog) {
  appendFileSync(LOG, JSON.stringify(record) + '\n', 'utf8')
} else {
  record._logSkipped = 'logLevel=' + logLevel
}

// 人读输出
const tag = shouldRun ? '★ 会动' : '·  静息'
const trigTag = trigger === 'force' ? '  [FORCE]' : (trigger === 'manual' ? '  [手动]' : '')
console.log(`[${record.t.slice(11, 19)}] ${tag}${trigTag}  phase=${phase.phase}  cron=${cron.due}`);
console.log(`         ${phase.reason}`);
console.log(`         ${cron.reason}`);
if (shouldRun) console.log(`         wouldDo: ${record.wouldDo}`);

process.exit(0);
