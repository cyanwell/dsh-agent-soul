#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// 回声 ECHO v2 · P0-3「一致性检查」预演稿 —— ★★ 未接入，不实装 ★★
// ══════════════════════════════════════════════════════════════════════════════
//
// 状态：**预演稿。** 只读磁盘和账本，不写任何东西，也不被 echo-doctor.mjs 调用。
//       按爀曦 2026-10-09 10:54 的委托：「先预编写代码，暂时不应用进去，不实装」。
//
// ── 它解决什么 ────────────────────────────────────────────────────────
// 回声 v1 的全部力气都花在「这句话有没有出处」上（门牌 srcSeqs + audit 393/393）。
// 但**门牌能证明有出处，不能证明两处说法不冲突**。评论区两条实证：
//   @北目宁游戏（UP 主点赞）：「有些代码甚至和文档对不上」
//   @CastleKin            ：「文档漂移，得经常整理文档」
//
// ── ★★ 设计上最硬的一条约束：只做机械判据，不许上模型 ────────────────
// 这是它能不能守住「回声规矩 4（检索只回指针，不转述）」的关键。
// 一旦让模型判断「这两句冲不冲突」，它就开始**生产新的转述**，而转述正是污染源。
// 所以三条判据全部是**可复算的**：比时间、比值、比路径，不做语义理解。
//   ★ 代价：它只能抓到「能用数字说清」的冲突，抓不到「意思相反但措辞不同」的。
//     这个代价是**故意付的** —— 宁可漏，不可猜。
//
// ── 三条判据 ─────────────────────────────────────────────────────────
//   A · 文件过期：账本记过一个文件路径，但该文件在磁盘上的 mtime **晚于**最后一次记录
//       → 可能「记的是旧状态」。判据：mtime > 记录时间。
//   B · 同实体冲突：同一个实体名在账本里出现 ≥2 次，且关键字段值不同、时间跨度 > 30 天
//       → 可能「前后说法不一」。判据：同名 + 异值 + 时间远。
//   C · 沿革倒挂：书房里带「修订沿革」的文件，比它对应的读物文件**还旧**
//       → 沿革没跟上读物。判据：账本文件 mtime < 读物文件 mtime。
//
// ── 报了之后怎么办 ───────────────────────────────────────────────────
// ★ **不自动改，只列出来人工确认。** 我们不判断，只点数。
//
// ── 用法 ─────────────────────────────────────────────────────────────
//   node consistency-check.mjs                 # 跑三条判据，列全部命中
//   node consistency-check.mjs --only A        # 只跑判据 A
//   node consistency-check.mjs --json
//   node consistency-check.mjs --selftest      # ★ 正对照 + 负对照
//   node consistency-check.mjs --mo <path> --root <dir>   # 换账本/换书房（自测用）
//
// ── 验收判据（方案 P0-3 原文）────────────────────────────────────────
//   · 正对照：手工造三条已知冲突 → 必须全报出来
//   · ★ 负对照：手工造三条**不冲突**的（同一事实、时间接近、值相同）→ **不许误报**
//     「不许误报」和「必须报出」同等重要 —— 一个爱喊狼来了的检查器等于没有检查器。
//
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync, utimesSync } from 'node:fs';
import { join, basename } from 'node:path';
import * as CFG from "./echo-config.mjs";

const MO_DEFAULT = CFG.LEDGER;
const ROOT_DEFAULT = CFG.SOUL;
const DAY = 86400000;

const C = {
  d: s => `\x1b[2m${s}\x1b[0m`,
  b: s => `\x1b[1m${s}\x1b[0m`,
  y: s => `\x1b[33m${s}\x1b[0m`,
  g: s => `\x1b[32m${s}\x1b[0m`,
  r: s => `\x1b[31m${s}\x1b[0m`,
  c: s => `\x1b[36m${s}\x1b[0m`,
};

// ── 读账本（与 rejected-view.mjs 同一套兼容逻辑）──────────────────────
function readLedger(path) {
  if (!existsSync(path)) throw new Error(`账本不存在: ${path}`);
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const out = [];
  let bad = 0;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      o.__line = out.length + 1;
      o.__text = o['概要'] || o.text || '';
      out.push(o);
    } catch { bad++; }
  }
  return { entries: out, bad };
}

// ★ 取正文：兼容三种来源。
//   `__text` 由 readLedger 赋值；但自测时直接构造的对象只有 text/概要 ——
//   所以这里必须都认，否则「测试数据」和「正式数据」走的是两条路，
//   而这一次正是因此让两条正对照假失败（负对照全过、正对照全挂）。
const txt = e => e.__text || e['概要'] || e.text || '';

// ── 抽出账本里提到的文件路径 ──────────────────────────────────────────
// ★ 只认**绝对路径**（以盘符开头），相对路径和文件名太容易误伤。
const PATH_RE = /[A-Za-z]:\\[^\s，。；、）)"'】\]]+/g;
function extractPaths(text) {
  const m = String(text).match(PATH_RE) || [];
  return [...new Set(m.map(p => p.replace(/[\\/]+$/, '')))];
}

// ── 判据 A：文件过期 ─────────────────────────────────────────────────
// ★ 2026-10-09 收紧过一次：第一版默认阈值 0 天、也不排除目录，
//   结果真《墨》上跑出 52 条命中 —— 几乎每个「还在被修改的路径」都中，
//   命中率高到没有信息量。**爱喊狼来了的检查器等于没有检查器。**
//   收紧两处：① 目录不算（目录 mtime 天然会变）；② 默认阈值 30 天。
function checkA(entries, { maxAgeDays = 30 } = {}) {
  const last = new Map();   // path → { t, line }
  for (const e of entries) {
    if (!e.t) continue;
    for (const p of extractPaths(txt(e))) {
      const prev = last.get(p);
      if (!prev || String(e.t) > String(prev.t)) last.set(p, { t: e.t, line: e.__line });
    }
  }
  const hits = [];
  for (const [p, rec] of last) {
    let st;
    try { st = statSync(p); } catch { continue; }        // 文件不在了 → 不是「过期」，是「不存在」，不报
    if (st.isDirectory()) continue;                      // ★ 目录 mtime 天然会变，不算不一致
    const recTime = Date.parse(rec.t);
    if (!Number.isFinite(recTime)) continue;
    const deltaDays = (st.mtimeMs - recTime) / DAY;
    // ★ 判据就是这一行：磁盘上的修改时间**晚于**账本里最后一次记录
    if (deltaDays > maxAgeDays) {
      hits.push({
        kind: 'A', path: p, line: rec.line, recordedAt: rec.t,
        mtime: new Date(st.mtimeMs).toISOString(),
        deltaDays: Math.round(deltaDays * 10) / 10,
        note: `账本最后一次记它是在 ${rec.t.slice(0, 10)}，但文件在那之后又被改过 —— 记的可能是旧状态`,
      });
    }
  }
  return hits.sort((a, b) => b.deltaDays - a.deltaDays);
}

// ── 判据 B：同实体冲突 ───────────────────────────────────────────────
// ★ 判据必须机械：取「名字 + 冒号后面的值」这种结构化的对，不比语义。
//   形如 `水位：680K` / `水位: 800K` → 同名不同值 = 可疑。
const KV_RE = /([\u4e00-\u9fa5A-Za-z_]{2,12})\s*[:：]\s*([^\s，。；、\n]{1,24})/g;
function checkB(entries, { minDays = 30 } = {}) {
  const seen = new Map();   // key: 名 → Map(值 → [{t,line}])
  for (const e of entries) {
    if (!e.t) continue;
    const text = txt(e);
    let m;
    KV_RE.lastIndex = 0;
    while ((m = KV_RE.exec(text)) !== null) {
      const k = m[1], v = m[2].trim();
      // 过滤明显不是「值」的东西
      if (/^[的了吗呢是在有和与及]$/.test(v)) continue;
      if (!seen.has(k)) seen.set(k, new Map());
      const vm = seen.get(k);
      if (!vm.has(v)) vm.set(v, []);
      vm.get(v).push({ t: e.t, line: e.__line });
    }
  }
  const hits = [];
  for (const [k, vm] of seen) {
    if (vm.size < 2) continue;                  // 只有一个值 → 不冲突
    const all = [...vm.entries()].flatMap(([v, arr]) => arr.map(a => ({ ...a, v })));
    all.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    const span = (Date.parse(all[all.length - 1].t) - Date.parse(all[0].t)) / DAY;
    // ★ 判据：同名 + 至少两个不同的值 + 时间跨度够大
    if (!(span > minDays)) continue;
    hits.push({
      kind: 'B', key: k, spanDays: Math.round(span),
      values: [...vm.entries()].map(([v, arr]) => ({ v, at: arr[0].t.slice(0, 10), line: arr[0].line })),
      note: `「${k}」在 ${Math.round(span)} 天里出现过 ${vm.size} 个不同的值 —— 可能是改了，也可能是两处写法不一致`,
    });
  }
  return hits.sort((a, b) => b.spanDays - a.spanDays);
}

// ── 判据 C：沿革倒挂 ─────────────────────────────────────────────────
//   C1 · 时间戳：沿革的 mtime 比读物的 mtime 还旧。
//   C2 · 内容  ：读物里出现的最新日期 > 沿革里出现的最新日期。
//
// ★ 为什么非要有 C2（2026-10-09 加，起因是一次实测的负对照）：
//   C1 只比 mtime，而 **mtime 只要"改一下沿革"就会变新** —— 哪怕改的根本不是该补的那一处。
//   实测：造一个沿革，内容停在 09-27、读物里明明有 09-30 的补记，只把沿革 touch 一下，
//   C1 一条都不报。**也就是说 C1 会被"假装补过"骗过去。**
//   C2 看的是文件里的日期，**不碰内容它就不动** —— 两个一起用才兜得住。
//   ★ 定位没变：两条都是「可疑」，不是「错误」。
const DATE_RE = /20\d{2}-\d{2}-\d{2}/g;
function maxDateIn(text) {
  const m = String(text || '').match(DATE_RE);
  if (!m || !m.length) return null;
  return m.reduce((a, b) => (b > a ? b : a));   // ISO 日期串，字典序 = 时间序
}

function checkC(root) {
  const hits = [];
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = join(dir, it.name);
      if (it.isDirectory()) { walk(full, depth + 1); continue; }
      if (!it.name.endsWith('.md')) continue;
      if (!it.name.includes('修订沿革')) continue;
      // 对应的读物 = 去掉「-修订沿革」的那份
      const readName = it.name.replace(/-修订沿革\.md$/, '.md');
      const readPath = join(dir, readName);
      if (!existsSync(readPath)) continue;
      const mLedger = statSync(full).mtimeMs;
      const mRead = statSync(readPath).mtimeMs;
      const ledgerAt = new Date(mLedger).toISOString().slice(0, 10);
      const readAt = new Date(mRead).toISOString().slice(0, 10);

      // ── C1：时间戳 ──
      if (mLedger < mRead - 1000) {
        hits.push({
          kind: 'C', via: 'mtime', ledger: full, read: readPath, ledgerAt, readAt,
          note: `读物改于 ${readAt}，沿革最后改于 ${ledgerAt} —— 沿革没跟上`,
        });
      }

      // ── C2：内容里的日期（★ 不碰内容它就不动，touch 骗不过它）──
      let tRead = '', tLedger = '';
      try { tRead = readFileSync(readPath, 'utf8'); } catch { /* 读不到就跳过 C2 */ }
      try { tLedger = readFileSync(full, 'utf8'); } catch { /* 同上 */ }
      if (tRead && tLedger) {
        const dRead = maxDateIn(tRead);
        const dLedger = maxDateIn(tLedger);
        if (dRead && (!dLedger || dRead > dLedger)) {
          const led = dLedger || '一个日期都没有';
          hits.push({
            kind: 'C', via: 'content', ledger: full, read: readPath,
            ledgerAt: led, readAt: dRead,
            note: `读物里出现过 ${dRead}，而沿革里最新只到 ${led} —— ` +
                  `沿革的内容没跟上（与文件时间无关，改一下沿革的错别字骗不过这一条）`,
          });
        }
      }
    }
  };
  walk(root);
  return hits;
}

// ── 渲染 ─────────────────────────────────────────────────────────────
function render(all) {
  const L = [];
  const sections = [
    ['A', '文件过期（账本记的和磁盘上的不一致）'],
    ['B', '同实体异值（同名不同值且时间跨度大）'],
    ['C', '沿革倒挂（修订沿革比读物还旧）'],
  ];
  L.push('');
  L.push(C.b(`回声 v2 · P0-3 一致性检查`) + C.d(`   共 ${all.length} 条命中`));
  L.push(C.d('─'.repeat(74)));
  if (!all.length) {
    L.push(C.g('  没有命中。'));
    L.push(C.d('  ★ 但「没命中」不等于「没问题」—— 三条判据都是机械的，只抓能用数字说清的冲突。'));
    return L.join('\n');
  }
  for (const [k, title] of sections) {
    const rows = all.filter(h => h.kind === k);
    if (!rows.length) continue;
    L.push('');
    L.push(C.b(`  【${k}】${title}`) + C.d(`  ${rows.length} 条`));
    for (const h of rows.slice(0, 12)) {
      L.push('');
      if (k === 'A') {
        L.push(`    ${C.c(h.path)}`);
        L.push(C.d(`      账本记于 ${h.recordedAt.slice(0, 10)}（墨:${h.line}）· 磁盘改于 ${h.mtime.slice(0, 10)} · 差 ${h.deltaDays} 天`));
      } else if (k === 'B') {
        L.push(`    ${C.c(h.key)}  ${C.d(`（跨 ${h.spanDays} 天）`)}`);
        for (const v of h.values) L.push(C.d(`      ${v.at}  墨:${v.line}  值 = ${v.v}`));
      } else {
        const tag = h.via === 'content' ? C.d('  ← 内容判据') : C.d('  ← 时间戳判据');
        L.push(`    ${C.c(basename(h.read))} 改于/内容最新 ${h.readAt}   但沿革只到 ${h.ledgerAt}${tag}`);
      }
      L.push(C.d(`      → ${h.note}`));
    }
    if (rows.length > 12) L.push(C.d(`    …还有 ${rows.length - 12} 条`));
  }
  L.push('');
  L.push(C.d('  ★ 这些只是「可疑」，不是「错误」。不自动改 —— 判断就是失真，所以只点数。'));
  L.push(C.d('  ★ C 有两条腿：时间戳（改一下沿革就变新，能被"假装补过"骗过）'));
  L.push(C.d('     和内容（读物里的日期 vs 沿革里的日期，不碰内容它不动）。两条都报才最可疑。'));
  return L.join('\n');
}

// ── 自测：正对照 + 负对照 ────────────────────────────────────────────
function selftest() {
  const res = [];
  const T = (name, ok, detail) => res.push({ name, ok, detail });
  const tmpRoot = join(process.env.TEMP || '/tmp', 'echo-consistency-selftest');
  mkdirSync(tmpRoot, { recursive: true });

  const now = Date.now();
  const iso = ms => new Date(ms).toISOString();
  const mk = (name, content, mtimeMs) => {
    const p = join(tmpRoot, name);
    writeFileSync(p, content, 'utf8');
    // 用 utimes 造 mtime（比等真实时间快，而且能精确控制）
    utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    return p;
  };

  // ══ 判据 A ══
  // 正对照：账本记于 60 天前，文件 1 天前被改 → 必须报
  const fStale = mk('stale.txt', 'x', now - 1 * DAY);
  // 负对照①：账本记于现在，文件 100 天前 → 记录比文件新，**不该报**
  const fFresh = mk('fresh.txt', 'x', now - 100 * DAY);
  // 负对照②：文件根本不存在 → 不是「过期」，**不该报**
  const eA = [
    { t: iso(now - 60 * DAY), type: 'fact', text: `我改了 ${fStale}`, __line: 1 },
    { t: iso(now - 1 * DAY),  type: 'fact', text: `我改了 ${fFresh}`, __line: 2 },
    { t: iso(now - 5 * DAY),  type: 'fact', text: `我改了 ${join(tmpRoot, 'never-existed.txt')}`, __line: 3 },
  ];
  const a = checkA(eA);
  T('★ A 正对照：账本旧、文件新 → 报出来',
    a.some(h => h.path === fStale), a.length ? `报了 ${a.length} 条，含 stale=${a.some(h => h.path === fStale)}` : '一条没报');
  T('★ A 负对照：账本新、文件旧 → 不许报',
    !a.some(h => h.path === fFresh), a.some(h => h.path === fFresh) ? '✗ 误报' : '正确地没报');
  T('★ A 负对照：文件不存在 → 不许报',
    !a.some(h => String(h.path).includes('never-existed')), a.some(h => String(h.path).includes('never-existed')) ? '✗ 误报' : '正确地没报');

  // ══ 判据 B ══
  const eB = [
    // 正对照：同名不同值，跨 90 天 → 必须报
    { t: iso(now - 90 * DAY), type: 'fact', text: '水位阈值：680K', __line: 10 },
    { t: iso(now - 1 * DAY),  type: 'fact', text: '水位阈值：880K', __line: 11 },
    // 负对照①：同名同值，跨 90 天 → 不该报
    { t: iso(now - 90 * DAY), type: 'fact', text: '主色：蓝色', __line: 12 },
    { t: iso(now - 1 * DAY),  type: 'fact', text: '主色：蓝色', __line: 13 },
    // 负对照②：同名不同值但时间很近（10 天）→ 不该报
    { t: iso(now - 10 * DAY), type: 'fact', text: '临时端口：8080', __line: 14 },
    { t: iso(now - 9 * DAY),  type: 'fact', text: '临时端口：8090', __line: 15 },
  ];
  const b = checkB(eB);
  T('★ B 正对照：同名异值 + 跨 90 天 → 报出来',
    b.some(h => h.key === '水位阈值'), b.map(h => h.key).join(',') || '一条没报');
  T('★ B 负对照：同名同值 → 不许报',
    !b.some(h => h.key === '主色'), b.some(h => h.key === '主色') ? '✗ 误报' : '正确地没报');
  T('★ B 负对照：异值但只隔 10 天 → 不许报（阈值 30 天）',
    !b.some(h => h.key === '临时端口'), b.some(h => h.key === '临时端口') ? '✗ 误报' : '正确地没报');

  // ══ 判据 C ══
  // 正对照：沿革比读物旧 → 必须报
  mk('01-测试-修订沿革.md', 'ledger', now - 20 * DAY);
  mk('01-测试.md', 'read', now - 1 * DAY);
  // 负对照：沿革比读物新（正常）→ 不该报
  mk('02-正常-修订沿革.md', 'ledger', now - 1 * DAY);
  mk('02-正常.md', 'read', now - 20 * DAY);
  // ★★ 正对照②（2026-10-09 加）：**mtime 装新、内容根本没补** —— C1 会被骗过，只有 C2 抓得住。
  //    这一条就是从实测负对照来的：当时把沿革 touch 一下，C1 一条都不报。
  mk('03-假装补过-修订沿革.md', '| v3 | 2026-09-27 上午 |', now - 60 * 1000);
  mk('03-假装补过.md', '★★ 2026-09-30 凌晨补一段', now - 30 * DAY);
  // ★★ 负对照②：mtime 新 **而且内容真的补上了**（读物与沿革同日期）→ 不许报
  mk('04-真补过-修订沿革.md', '| v4 | 2026-09-30 凌晨 |', now - 60 * 1000);
  mk('04-真补过.md', '★★ 2026-09-30 凌晨补一段', now - 30 * DAY);
  const c = checkC(tmpRoot);
  const byName = (n, via) => c.some(h => h.ledger.includes(n) && (!via || h.via === via));
  T('★ C 正对照：沿革旧于读物 → 报出来',
    byName('01-测试'), c.map(h => basename(h.ledger)).join(',') || '一条没报');
  T('★★ C2 正对照：mtime 装新、内容没补 → 内容判据必须报（touch 骗不过的那条）',
    byName('03-假装补过', 'content'),
    byName('03-假装补过', 'content') ? '内容判据报出来了' : `没报 —— 当前命中：${c.map(h => basename(h.read) + '/' + h.via).join(',') || '无'}`);
  T('★★ C2 负对照：mtime 新且内容也补了 → 不许报',
    !byName('04-真补过'),
    byName('04-真补过') ? '✗ 误报' : '正确地没报');
  T('★ C 负对照：沿革新于读物（正常）→ 不许报',
    !c.some(h => h.ledger.includes('02-正常')), c.some(h => h.ledger.includes('02-正常')) ? '✗ 误报' : '正确地没报');

  console.log('');
  console.log(C.b('回声 v2 · P0-3 一致性检查 · 自测'));
  console.log(C.d('─'.repeat(74)));
  let pass = 0;
  for (const r of res) {
    if (r.ok) pass++;
    console.log(`  ${r.ok ? C.g('✓') : C.r('✗')} ${r.name}`);
    console.log(C.d(`      ${r.detail}`));
  }
  console.log(C.d('─'.repeat(74)));
  const allOk = pass === res.length;
  console.log(`  ${allOk ? C.g('全部通过') : C.r('有失败项')}  ${pass}/${res.length}`);
  console.log('');
  console.log(C.d('  ★ 负对照和正对照一样重要：一个爱喊狼来了的检查器等于没有检查器。'));
  console.log('');
  if (!allOk) process.exitCode = 1;
}

// ── CLI ───────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};

if (argv.includes('--selftest')) {
  selftest();
} else {
  const moPath = opt('--mo', MO_DEFAULT);
  const root = opt('--root', ROOT_DEFAULT);
  const only = opt('--only', null);

  const { entries, bad } = readLedger(moPath);
  let hits = [];
  if (!only || only === 'A') hits = hits.concat(checkA(entries));
  if (!only || only === 'B') hits = hits.concat(checkB(entries));
  if (!only || only === 'C') hits = hits.concat(checkC(root));

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ total: hits.length, badLines: bad, hits }, null, 2));
  } else {
    console.log(render(hits));
    if (bad) console.log(C.y(`  ⚠ 有 ${bad} 行解析失败`));
    console.log('');
  }
}
