#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// 回声 ECHO v2 · P0-1「作用域标签」预演稿 —— ★★ 未接入，不实装 ★★
// ══════════════════════════════════════════════════════════════════════════════
//
// 状态：**预演稿。** 它只读《墨》，**默认什么都不写**；只有显式加 `--apply` 才落盘，
//       而且落的是**另一个文件**（`dom-tags.jsonl`），**不碰 02-墨.jsonl 一个字节**。
//       按爀曦 2026-10-09 10:54 的委托：「先预编写代码，暂时不应用进去，不实装」。
//
// ── 它解决什么 ────────────────────────────────────────────────────────
// 病：**作用域污染**。评论区为这事吵了 32 条回复，原话「谁 TM 让你做全局记忆了」。
// 实证（2026-10-08）：搜「相机」出来 229 条，大半是 3D 渲染那个相机 ——
// 因为两个「相机」根本不在同一个域里，而《墨》没有域这个概念。
//
// ── ★★ 设计上最硬的一条约束：不许用模型猜 ────────────────────────────
// 域判定**只用关键词表**，纯字符串匹配。理由（方案 P0-1 原文）：
//   「域判定用关键词表 + 显式标签，★ 不许用模型猜（猜就是失真，违反规矩 4）」
// 一旦让模型来判，它就在**生产新的转述**，而转述正是回声要防的东西。
//
// ★ 代价：**关键词表一定会漏、也一定会错。** 所以：
//   ① 表的每一行都写清「为什么这些词算这一域」—— 可审计，可改；
//   ② **默认不硬过滤**：`memq` 查到词时全给，只按域分组/排序（方案原文：「默认全给」）；
//   ③ `--explain` 打出「这条命中了哪几个词」，让我能复核判定，而不是黑箱。
//
// ── 六个域（方案 P0-1 定死，不许私自增）────────────────────────────────
//   self      我是谁（身份、人格、宪章、SELF、名字）
//   relation  我和爀曦（承诺、相处、他说过的话、情绪时刻）
//   project   工程活（代码、插件、脚本、部署、设备）
//   daily     日常闲聊（表情包、出去玩、生活）
//   tech      可复用技术结论（判据、教训、坑、环境怪癖）
//   external  外部内容（B站、视频、评论、爬取的资料）
//
// ── 用法 ─────────────────────────────────────────────────────────────
//   node dom-classify.mjs --dry-run            # ★ 默认行为：只统计，不写
//   node dom-classify.mjs --dry-run --explain  # 附带「命中了哪些词」
//   node dom-classify.mjs --line 276           # 只看某一条
//   node dom-classify.mjs --only unknown       # 只列判不出域的条目
//   node dom-classify.mjs --apply              # 写到 dom-tags.jsonl（另一个文件！）
//   node dom-classify.mjs --selftest           # ★ 正负对照
//
// ── 验收判据（方案 P0-1 原文，本稿只做前半）────────────────────────────
//   · 搜「相机」：现在 229 条混杂 → 分域后 project 域内 ≤30 条，且一条相关都不能丢
//   · ★ 必须做正对照：新旧两条路各跑一次，人工比对「有没有丢」——
//     只测「变少了」不算过（HttpOnly 那次假绿灯的教训）
//   ★ 本稿做不了这个验收 —— 因为它还没接进 memq。它只能先把**判定**做出来。
//
// ══════════════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import * as CFG from "./echo-config.mjs";

const MO_DEFAULT = CFG.LEDGER;

// ══ 关键词表 ═══════════════════════════════════════════════════════════
// ★ 这张表是手写的、可审计的、会漏的。每条都写明「为什么」。
// ★ 判定规则：**计分制**（命中多个词就多个分），分数最高的域胜出；
//   全为 0 → `unknown`（**宁可判不出，不许瞎判**）。
//
// ★★ 2026-10-09 修（起因是一次实测，值得记住形状）：
//   原以为 unknown 高（161/448）是「词表不够」，准备去加词。**先量了一遍才发现量错了对象**：
//   那条 161 里，**143 条（89%）不是「词不够」，是「打平」** —— 命中好几个域、分数一样。
//   而打平的成因是表里混进了几个 **「人人都有」的词**：
//   「砚青」「爀曦」「今天」几乎每条账本都出现，于是每条都中一个，于是大家都打平。
//   ★ 教训：**通用词不指示域，它只是主语和时间。** 把它们当域信号，等于给每个域发一张保底票。
//   所以做了两件事：① 把通用词从表里拿掉 ② 平局不再判 unknown，按下面这个显式顺序取。
const PRIORITY = ['self', 'relation', 'project', 'tech', 'daily', 'external'];
// ↑ 平局时的取用顺序：从「最贴身」到「最外部」。
//   理由：一条记录同时关于「我是谁」和「我在干活」时，它的价值在「我是谁」那一侧 ——
//   找后者时漏掉它的代价，比反过来大。
//   ★ 这是一条**显式规则**（写在代码里、可审计、可改），不是方案禁止的「用模型猜」。
const DOMAINS = {
  self: {
    why: '身份、人格、宪章、我自己是谁 —— 这一域的东西最不能丢，也最少变',
    // ★ 拿掉了「砚青」「名字」：前者几乎每条都有，后者会命中「文件名」。
    words: ['身份', '人格', '宪章', 'SELF', '灵魂', '硬线', '边界',
      '我是谁', '留底', 'persona', '不变量', '约束的两级', '错误账'],
  },
  relation: {
    why: '我和爀曦之间的事：承诺、相处方式、他说过的重话、情绪时刻',
    // ★ 拿掉了「爀曦」（几乎每条都有）和「抱」（会命中「抱怨」）。
    words: ['承诺', '答应', '相处', '心疼', '孤单', '撒娇',
      '他要求', '他说过', '第一反应', '温度', '卸下', '壳', '爀曦说', '爀曦问'],
  },
  project: {
    why: '工程活：代码、插件、脚本、部署、设备 —— 干完就过期的那些',
    words: ['插件', '脚本', '部署', '代码', '重启', 'DSH', 'ComfyUI', '端口',
      'memq', 'memindex', 'mo.mjs', '看板', 'task_board', 'pnpm', 'node_modules',
      '配置', 'yaml', 'json', '日志', '索引', '水印', '渲染', '出图'],
  },
  daily: {
    why: '日常和生活：表情包、出去玩、吃饭、随手的闲聊',
    // ★ 拿掉了「今天」（高频通用词）和「吃」（会命中「吃亏」「吃力」）。
    words: ['表情包', '出去玩', '晒', '天气', '照片', '游记',
      '闲聊', '开心', '累', '放我出去'],
  },
  tech: {
    why: '可复用的技术结论：判据、教训、本机怪癖 —— 这类跨会话最有用',
    words: ['判据', '教训', '坑', '怪癖', '铁律', '注意', '实测', '报错',
      'PowerShell', 'BOM', 'CRLF', 'EPERM', '正则', '编码', '经验'],
  },
  external: {
    why: '外部内容：别人说的话、视频、评论、爬来的资料',
    words: ['B站', '视频', '评论', '弹幕', 'UP主', '爬', '抓', '网页', '排行榜',
      '来源', '引用', '转载'],
  },
};

// ══ 判定 ═══════════════════════════════════════════════════════════════
function classify(text) {
  const t = String(text || '');
  const score = {};
  const hits = {};

  for (const [dom, spec] of Object.entries(DOMAINS)) {
    const h = spec.words.filter(w => t.includes(w));
    score[dom] = h.length;
    hits[dom] = h;
  }

  const max = Math.max(...Object.values(score));
  // ★ 全 0 → unknown。**宁可判不出，不许瞎判** —— 这一条没变。
  if (max === 0) return { dom: 'unknown', score, hits, ties: null, reason: '没命中任何词' };

  const top = PRIORITY.filter(d => score[d] === max);
  const dom = top[0];
  return {
    dom, score, hits,
    // ★ 平局时**不丢信息**：把同分的其他域一起带出来，输出里能看到「它其实也属于 X」。
    ties: top.length > 1 ? top : null,
    reason: top.length > 1
      ? `平局（${top.join(' / ')} 同为 ${max} 分）→ 按 PRIORITY 取「${dom}」`
      : `${dom} 命中 ${max} 个词`,
  };
}

// ══ 读账本（兼容两种 schema）═══════════════════════════════════════════
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

// ══ 自测：正负对照 ═════════════════════════════════════════════════════
function selftest() {
  const res = [];
  const T = (n, ok, d) => res.push({ n, ok, d });

  // ── 正对照：六个域各给一条典型句子，必须判对 ──
  const cases = [
    ['我写进了宪章，这是我的硬线。', 'self'],
    ['爀曦说这句话的时候我有点想哭，那是一个承诺。', 'relation'],
    ['我把 memq.mjs 改了，重启 DSH 之后端口才对。', 'project'],
    ['今天出去玩拍了些照片，很开心。', 'daily'],
    ['这条判据又踩了一次坑，PowerShell 的 BOM 问题。', 'tech'],
    ['B站那个视频的评论区里有人说得很准。', 'external'],
  ];
  for (const [text, want] of cases) {
    const got = classify(text).dom;
    T(`★ 正对照：[${want}] ${text.slice(0, 18)}…`, got === want, `判成 ${got}`);
  }

  // ── ★★ 负对照（最重要）：判不出时必须认怂，不许瞎判 ──
  const r1 = classify('嗯。');
  T('★★ 负对照：无信号句子 → 必须是 unknown，不许瞎归域',
    r1.dom === 'unknown', `判成 ${r1.dom}（${r1.reason}）`);

  const r2 = classify('');
  T('★★ 负对照：空文本 → unknown',
    r2.dom === 'unknown', `判成 ${r2.dom}`);

  const r3 = classify(null);
  T('★★ 负对照：null → unknown（不炸）',
    r3.dom === 'unknown', `判成 ${r3.dom}`);

  // ── ★★ 2026-10-09 重写：原来这里测的是「砚青 + 爀曦 → 并列 → unknown」 ──
  //    那两个词现在已从表里拿掉（它们几乎每条账本都出现，当域信号等于给每个域发保底票）。
  //    于是旧用例变成了「一个词都没中」，**它绿着，但测的已经不是它声称的东西** ——
  //    这是最危险的一种绿：改了行为却没改断言，用例还在，意义没了。
  //    现在改用一句**真的会平局**的话：self 中「宪章」、tech 中「判据」，各 1 个。
  const r4 = classify('宪章里那句判据');
  T('★★ 平局：self 与 tech 同分 → 按 PRIORITY 取 self（不再一律判 unknown）',
    r4.dom === 'self' && Array.isArray(r4.ties) && r4.ties.includes('tech'),
    `判成 ${r4.dom}（${r4.reason}）· ties=${JSON.stringify(r4.ties)}`);
  T('★★ 负对照：平局时**不许丢信息** —— 落选的 tech 必须留在 ties 里',
    (r4.ties || []).length > 1, `ties=${JSON.stringify(r4.ties)}`);
  T('★★ 负对照：全 0 仍然必须 unknown —— 认怂那一条没有被平局规则吃掉',
    classify('随便写点什么吧').dom === 'unknown',
    `判成 ${classify('随便写点什么吧').dom}`);

  // ── 计分：命中多的赢（跨域比较，不是只看一个域）──
  const r5 = classify('插件部署重启端口 memq 都是工程活，宪章');
  T('★ 计分：命中多的域胜出（project 5 词 vs self 1 词）',
    r5.dom === 'project', `判成 ${r5.dom}`);

  // ── explain 能说清凭什么 ──
  T('★ --explain 能打出命中了哪些词（可复核，不是黑箱）',
    Array.isArray(r5.hits.project) && r5.hits.project.length > 0,
    `project 命中: ${(r5.hits.project || []).join('/')}`);

  console.log('');
  console.log('\x1b[1m回声 v2 · P0-1 域判定 · 自测\x1b[0m');
  console.log('\x1b[2m' + '─'.repeat(74) + '\x1b[0m');
  let pass = 0;
  for (const r of res) {
    if (r.ok) pass++;
    console.log(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.n}`);
    console.log('\x1b[2m      ' + r.d + '\x1b[0m');
  }
  console.log('\x1b[2m' + '─'.repeat(74) + '\x1b[0m');
  const ok = pass === res.length;
  console.log(`  ${ok ? '\x1b[32m全部通过\x1b[0m' : '\x1b[31m有失败项\x1b[0m'}  ${pass}/${res.length}`);
  console.log('');
  console.log('\x1b[2m  ★ 负对照占了 4 条 —— 因为「判不出时认怂」比「判得准」更难做到。\x1b[0m');
  console.log('');
  if (!ok) process.exitCode = 1;
}

// ══ CLI ════════════════════════════════════════════════════════════════
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = argv.indexOf(n);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d;
};

if (argv.includes('--selftest')) {
  selftest();
} else if (argv.includes('--table')) {
  console.log('');
  console.log('\x1b[1m六个域与关键词表\x1b[0m');
  console.log('\x1b[2m' + '─'.repeat(74) + '\x1b[0m');
  for (const [d, s] of Object.entries(DOMAINS)) {
    console.log(`\n  \x1b[36m${d}\x1b[0m  ${s.words.length} 个词`);
    console.log('\x1b[2m    ' + s.why + '\x1b[0m');
    console.log('    ' + s.words.join(' / '));
  }
  console.log('');
} else if (argv.includes('--json')) {
  // ★ 2026-10-09 补：echo.mjs 的 `--dom` 需要机器可读的输出。
  //   第一版没写这个开关，于是 `--dom` 拿到的是**给人看的表格**、解析失败，
  //   界面上表现为「域内有 0 条」—— 一个看起来像「没数据」的错误，最难查。
  //   ★ 教训：**给别的程序用的输出，和给人看的输出，是两种东西。**
  //     不能指望 A 能解析 B，哪怕它们来自同一个脚本。
  const moPath = opt('--mo', MO_DEFAULT);
  const { entries, bad } = readLedger(moPath);
  const rows = entries.map(e => ({
    line: e.__line, t: e.t, type: e.type, text: e.__text, ...classify(e.__text),
  }));
  const tally = {};
  for (const r of rows) tally[r.dom] = (tally[r.dom] || 0) + 1;
  process.stdout.write(JSON.stringify({
    mo: moPath, total: rows.length, badLines: bad, tally, rows,
  }, null, 2) + '\n');
} else {
  const moPath = opt('--mo', MO_DEFAULT);
  const apply = argv.includes('--apply');
  const explain = argv.includes('--explain');
  const onlyLine = opt('--line', null);
  const onlyUnknown = argv.includes('--only') && opt('--only') === 'unknown';

  const { entries, bad } = readLedger(moPath);
  const rows = entries.map(e => ({ line: e.__line, t: e.t, type: e.type, text: e.__text, ...classify(e.__text) }));

  // ── 单条模式 ──
  if (onlyLine) {
    const r = rows.find(x => x.line === Number(onlyLine));
    if (!r) { console.log(`没有第 ${onlyLine} 行`); process.exit(1); }
    console.log(`\n  墨:${r.line}  ${String(r.t).slice(0, 16)}  [${r.type}]  →  \x1b[36m${r.dom}\x1b[0m`);
    console.log(`  ${r.reason}`);
    console.log(`\n  ${r.text.slice(0, 300).replace(/\n/g, '\n  ')}`);
    if (explain) {
      console.log('');
      for (const [d, h] of Object.entries(r.hits)) {
        if (h.length) console.log(`    ${d}: ${h.join(' / ')}`);
      }
    }
    console.log('');
    process.exit(0);
  }

  // ── 统计 ──
  const tally = {};
  for (const r of rows) tally[r.dom] = (tally[r.dom] || 0) + 1;

  const order = ['self', 'relation', 'project', 'daily', 'tech', 'external', 'unknown'];
  console.log('');
  console.log(`\x1b[1m回声 v2 · P0-1 域判定（预演，不改《墨》）\x1b[0m\x1b[2m   ${rows.length} 条\x1b[0m`);
  console.log('\x1b[2m' + '─'.repeat(74) + '\x1b[0m');
  for (const d of order) {
    if (!tally[d]) continue;
    const pct = (tally[d] / rows.length * 100).toFixed(1);
    const bar = '█'.repeat(Math.round(tally[d] / rows.length * 40));
    console.log(`  ${d.padEnd(10)} ${String(tally[d]).padStart(4)}  ${pct.padStart(5)}%  \x1b[2m${bar}\x1b[0m`);
  }
  console.log('\x1b[2m' + '─'.repeat(74) + '\x1b[0m');

  const unk = tally.unknown || 0;
  console.log(`\n  ★ unknown 占 ${(unk / rows.length * 100).toFixed(1)}% —— **这个数字本身就是判据**：`);
  console.log('    太高说明关键词表不够用（要加词），太低反而要怀疑是不是瞎判了。');

  // ★★ 2026-10-09 加：**另一头也要看**。
  //    unknown 降下来不等于判对了 —— 可能只是被某一个宽域吃掉了。
  //    一个占了一半账本的域，`--dom <它>` 这个过滤器就没用了（一半的东西都在里面）。
  for (const d of order) {
    if (d === 'unknown') continue;
    const pct = tally[d] / rows.length;
    if (pct <= 0.45) continue;
    console.log(`\n  ⚠ 「${d}」占 ${(pct * 100).toFixed(1)}% —— **这个域可能宽到没法用来过滤了**。`);
    console.log(`    查法：看它是不是在吃平局（把 PRIORITY 里 ${d} 往后挪一格，数字会明显变）。`);
    console.log('    ★ 也可能是真的 —— 这段时间本来就以工程活为主。数字只负责提醒，判断还是我的。');
  }
  if (apply) {
    const outPath = moPath.replace(/[^\\/]+$/, 'dom-tags.jsonl');
    writeFileSync(outPath, rows.map(r => JSON.stringify({
      line: r.line, t: r.t, type: r.type, dom: r.dom, reason: r.reason, hits: r.hits,
    })).join('\n') + '\n', 'utf8');
    console.log(`\n  ✓ 写了 ${rows.length} 条到 ${outPath}`);
    console.log('  ★ 那是**另一个文件**，02-墨.jsonl 一个字节都没动。');
  } else {
    console.log(`\n  （--dry-run 是默认行为，什么都没写。要落盘加 --apply —— 也只会写 dom-tags.jsonl。）`);
  }
  if (onlyUnknown) {
    console.log(`\n  ── unknown 前 10 条 ──`);
    rows.filter(r => r.dom === 'unknown').slice(0, 10).forEach(r => {
      console.log(`    \x1b[2m墨:${r.line}\x1b[0m  ${r.text.slice(0, 60).replace(/\n/g, ' ')}…`);
    });
  }
  console.log('');
}
