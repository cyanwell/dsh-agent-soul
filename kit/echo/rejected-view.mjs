#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// 回声 ECHO v2 · P0-2「否决登记」预演稿 —— ★★ 未接入，不实装 ★★
// ══════════════════════════════════════════════════════════════════════════════
//
// 状态：**这是预演稿。** 它只读《墨》，不写任何东西，也不被 memq.mjs / mo.mjs 调用。
//       按爀曦 2026-10-09 10:54 的委托：「先预编写代码，暂时不应用进去，不实装」。
//
// 它解决什么（方案 P0-2，见 30-状态\回声ECHO-升级方案-v2.1.md）：
//   病：**重提已经否掉的方案**。评论区原话（@雁-离 2026-10-08 22:44）：
//       「我十分钟前否掉的跟昨天否掉的来回提怎么办」。
//   根因：**否决没有账本** —— 口头否掉的东西没进《墨》，下次想查也无从查起。
//   药：让「已否方案」的清单**机械可查**，而不是靠我记。
//
// ── 与正式版的差别（写清楚，免得以后误当成已完成）──────────────────
//   ✅ 本稿做了：读《墨》→ 筛 shelved → 按时间/域/关键词列出 → 自带正负对照自测
//   ❌ 本稿**没做**：写入侧（否决当场落一条 shelved）、memq 子命令注册、
//                    mo.mjs 的写入提示改造、域标签（那是 P0-1，还没做）
//   ★ 所以即使把它接进去，也只能「查账」，不能「记账」——
//     没有写入侧，账本就永远是空的，这一点必须在实装时一起解决。
//
// ── 用法 ────────────────────────────────────────────────────────────────
//   node rejected-view.mjs                     # 列出全部 shelved，按时间倒序
//   node rejected-view.mjs --since 2026-10-01  # 只看某天之后的
//   node rejected-view.mjs --grep 触发器        # 关键词过滤（大小写不敏感）
//   node rejected-view.mjs --limit 5           # 只看最近 5 条
//   node rejected-view.mjs --full              # 打出完整正文（默认截断）
//   node rejected-view.mjs --json              # 机器可读
//   node rejected-view.mjs --selftest          # ★ 跑正负对照自测
//   node rejected-view.mjs --mo <path>         # 指定别的账本（自测就用它）
//
// ── 验收判据（方案 P0-2 原文）──────────────────────────────────────────
//   · 手工造三条否决 → 能全部列出
//   · ★ 反向验证：造一条**没有** shelved 记录的「口头否决」→ 必须**查不到**
//     这条比第一条重要 —— 它证明这个视图是「查账」，不是「猜」
//   ★ `--selftest` 就是在跑这两条。**没有负对照的测试等于没测**（HttpOnly 假绿灯的教训）。
//
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as CFG from "./echo-config.mjs";

const MO_DEFAULT = CFG.LEDGER;

// ── 读账本 ────────────────────────────────────────────────────────────
// ★ 兼容两种 schema（2026-10-09 实地核对过）：
//   旧条目（约 2026-10-04 前）: { t, by, type, text, ref }
//   新条目:                     { t, by, type, 概要, feel, ref }
//   ★ 只认 概要、不认 text 会静默丢掉前面 360 多条 —— 这正是回声 v1 最怕的那种丢法。
function readLedger(path) {
  if (!existsSync(path)) throw new Error(`账本不存在: ${path}`);
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const out = [];
  let bad = 0;
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line);
      o.__line = i + 1;                       // ★ 行号 = 回原文的门牌（只追加，行号稳定）
      o.__text = o['概要'] || o.text || '';    // ★ 两种 schema 都取
      out.push(o);
    } catch { bad++; }
  }
  return { entries: out, bad, total: lines.length };
}

// ── 筛选 ──────────────────────────────────────────────────────────────
function pickRejected(entries) {
  return entries
    .filter(e => e.type === 'shelved')
    .map(e => ({
      line: e.__line,
      t: e.t || '(无时间)',
      by: e.by || '(无署名)',
      text: e.__text,
      ref: e.ref || '',
      feel: e.feel || '',
      hasRef: !!e.ref,
      hasWhy: /为什么|因为|理由|原因|★|——|：/.test(e.__text),  // ★ 粗判「有没有写为什么」
    }))
    .sort((a, b) => String(b.t).localeCompare(String(a.t)));   // 时间倒序
}

// ── 渲染 ──────────────────────────────────────────────────────────────
const C = {
  d: s => `\x1b[2m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`,
  c: s => `\x1b[36m${s}\x1b[0m`,
};

function render(rows, { full = false, limit = 0 } = {}) {
  const shown = limit > 0 ? rows.slice(0, limit) : rows;
  const L = [];
  L.push('');
  L.push(C.b(`已否方案登记 · 共 ${rows.length} 条`) + (limit > 0 && rows.length > limit ? C.d(`（只显示最近 ${limit} 条）`) : ''));
  L.push(C.d('─'.repeat(72)));
  if (!rows.length) {
    L.push(C.y('  账本是空的。'));
    L.push(C.d('  ★ 这不是「没有否过方案」，是「否了但没记账」—— 两者不一样。'));
    return L.join('\n');
  }
  for (const r of shown) {
    const cut = full ? r.text : (r.text.length > 150 ? r.text.slice(0, 150) + '…' : r.text);
    L.push('');
    L.push(`  ${C.c(String(r.t).slice(0, 16))}  ${C.d('墨:' + r.line)}`);
    L.push(`  ${cut.replace(/\n/g, '\n  ')}`);
    const flags = [];
    if (!r.hasRef) flags.push(C.y('缺 ref（说不出依据）'));
    if (!r.hasWhy) flags.push(C.y('像是没写为什么'));
    if (flags.length) L.push('  ' + flags.join('  '));
  }
  L.push('');
  L.push(C.d(`  门牌格式：墨:<行号> —— 账本只追加，行号稳定，可直接回原文。`));
  return L.join('\n');
}

// ── 自测：正对照 + 负对照 ──────────────────────────────────────────────
function selftest() {
  const results = [];
  const T = (name, ok, detail) => { results.push({ name, ok, detail }); };

  // 造一份**假账本**，绝不动真《墨》
  const FIXTURE = [
    // ① 三条「有记账的否决」—— 正对照，必须全部列出
    { t: '2026-10-01T10:00:00+08:00', by: 'session-A', type: 'shelved', text: '否掉了方案甲：因为成本太高', ref: '爀曦 2026-10-01 说不做' },
    { t: '2026-10-02T10:00:00+08:00', by: 'session-A', type: 'shelved', text: '否掉了方案乙：因为和现有架构冲突', ref: '爀曦 2026-10-02 叫停' },
    { t: '2026-10-03T10:00:00+08:00', by: 'session-A', type: 'shelved', 概要: '否掉了方案丙：因为验证不过', ref: '自测' },
    // ② ★ 一条「口头否决」—— 负对照，**必须查不到**
    //    它长得像否决，但 type 是 fact，不在账上。这正是病根所在。
    { t: '2026-10-04T10:00:00+08:00', by: 'session-A', type: 'fact', text: '讨论了方案丁，我说这个不行，当时没记' },
    // ③ 干扰项：其它类型的正常条目
    { t: '2026-10-05T10:00:00+08:00', by: 'session-A', type: 'fact', text: '一条普通的 fact' },
    { t: '2026-10-06T10:00:00+08:00', by: 'session-A', type: 'gain', 概要: '一条 gain' },
  ];
  const tmp = (process.env.TEMP || '/tmp') + '\\echo-rejected-selftest.jsonl';
  writeFileSync(tmp, FIXTURE.map(o => JSON.stringify(o)).join('\n') + '\n', 'utf8');

  const { entries, bad } = readLedger(tmp);
  T('能读假账本', entries.length === FIXTURE.length, `读到 ${entries.length}/${FIXTURE.length} 条，解析失败 ${bad}`);

  const rows = pickRejected(entries);

  // ── 正对照 ──
  T('★ 正对照：三条有记账的否决全部列出',
    rows.length === 3,
    `列出 ${rows.length} 条（应为 3）`);

  const texts = rows.map(r => r.text).join('|');
  T('★ 正对照：甲/乙/丙 一个不漏',
    texts.includes('方案甲') && texts.includes('方案乙') && texts.includes('方案丙'),
    texts.includes('方案甲') && texts.includes('方案乙') && texts.includes('方案丙') ? '三条都在' : '有遗漏');

  T('★ 新旧 schema 都能读（丙用的是「概要」字段）',
    texts.includes('方案丙'),
    texts.includes('方案丙') ? '概要字段读到了' : '概要字段没读到 ← 会静默丢条目');

  // ── 负对照（最重要）──
  T('★★ 负对照：口头否决（type=fact）必须查不到',
    !texts.includes('方案丁'),
    texts.includes('方案丁') ? '✗ 把它当否决列出来了 —— 说明这个视图在「猜」而不是「查账」' : '正确地没列出来');

  T('负对照：普通 fact / gain 不混进来',
    rows.every(r => r.text.includes('方案')),
    rows.length === 3 ? '只有那三条' : '有杂质');

  // ── 排序 ──
  const ts = rows.map(r => r.t);
  T('时间倒序（最近的在前）',
    ts.join() === [...ts].sort().reverse().join(),
    ts.join(' > '));

  // ── 带「为什么」的粗判 ──
  T('能标出「没写为什么」的条目',
    rows.filter(r => r.hasWhy).length === 3,
    `${rows.filter(r => r.hasWhy).length}/3 条被判定写了原因`);

  // ── 行号门牌 ──
  T('每条都带行号门牌（可回原文）',
    rows.every(r => Number.isInteger(r.line) && r.line > 0),
    rows.map(r => r.line).join(','));

  // ── 空账本：空文件应当静默返回 0 条，不炸 ──
  const emptyPath = tmp.replace('.jsonl', '-empty.jsonl');
  writeFileSync(emptyPath, '', 'utf8');
  const emptyRows = pickRejected(readLedger(emptyPath).entries);
  T('空账本静默返回 0 条（不炸、不误报）', emptyRows.length === 0, `返回 ${emptyRows.length} 条`);

  // ── 输出 ──
  console.log('');
  console.log(C.b('回声 v2 · P0-2 否决登记 · 自测'));
  console.log(C.d('─'.repeat(72)));
  let pass = 0;
  for (const r of results) {
    const mark = r.ok ? C.g('✓') : C.r('✗');
    if (r.ok) pass++;
    console.log(`  ${mark} ${r.name}`);
    console.log(C.d(`      ${r.detail}`));
  }
  console.log(C.d('─'.repeat(72)));
  const allOk = pass === results.length;
  console.log(`  ${allOk ? C.g('全部通过') : C.r('有失败项')}  ${pass}/${results.length}`);
  console.log('');
  if (!allOk) process.exitCode = 1;
  return allOk;
}

// ── CLI ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};

if (argv.includes('--selftest')) {
  selftest();
} else if (argv.includes('--help') || argv.includes('-h')) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(30, 45).join('\n'));
} else {
  const moPath = flag('--mo', MO_DEFAULT);
  const since = flag('--since');
  const grep = flag('--grep');
  const limit = Number(flag('--limit', 0)) || 0;
  const full = !!flag('--full', false);
  const asJson = !!flag('--json', false);

  const { entries, bad } = readLedger(moPath);
  let rows = pickRejected(entries);
  if (since) rows = rows.filter(r => String(r.t) >= String(since));
  if (grep) {
    const re = new RegExp(String(grep), 'i');
    rows = rows.filter(r => re.test(r.text) || re.test(r.ref));
  }

  if (asJson) {
    console.log(JSON.stringify({ total: rows.length, badLines: bad, rows }, null, 2));
  } else {
    console.log(render(rows, { full, limit }));
    if (bad) console.log(C.y(`  ⚠ 有 ${bad} 行解析失败（原样保留在账本里，没有被删）`));
    console.log('');
  }
}
