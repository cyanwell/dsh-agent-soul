// self.mjs —— 自我层（SELF）的装配与体检
//
// ★ 它解决什么：指令预算满了会【静默丢】，而且先丢的是最宽泛的那些 ——
//   恰恰是「我是谁」「不能做什么」这类总纲。所以把最不能丢的抽出来，
//   走另一条推送通道（那个由 dsh-agent-memory 插件负责每轮注入）。
//
// ★ 但装配本身太简单（拼几段字符串）。这个工具值钱的地方是【体检】：
//   盯着那一页别退化成一本手册。三条判据：
//     ① 不许有「详见某个文件」这种指向 —— 指向一个可能会静默消失的地方，等于没有指向
//     ② 不许超预算 —— 超了就会被截，而截了是无声的
//     ③ 活体段必须是【自动生成的】—— 时钟、未结这类每轮在变的东西不能手写
//
// ★ 三分钟上手：
//   ① node self.mjs --check    体检（★ 验：三条判据逐条给结论）
//   ② node self.mjs            打印装配好的整页（★ 验：活体段的时刻是「现在」）
//
// 配置：SELF_FILE（默认 ../../soul/SELF.md）｜LEDGER（默认 ../../soul/ledger.jsonl）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOUL = process.env.SOUL_HOME || path.join(HERE, '..', '..', 'soul');
const SELF_FILE = process.env.SELF_FILE || path.join(SOUL, 'SELF.md');
const LEDGER = process.env.LEDGER || path.join(SOUL, 'ledger.jsonl');
const BUDGET = Number(process.env.SELF_BUDGET || 12288);

const argv = process.argv.slice(2);
const check = argv.includes('--check');

if (!fs.existsSync(SELF_FILE)) {
  console.error(`✗ 没有这一页：${SELF_FILE}`);
  console.error('  ★ 先写一页「不变量」：我是谁 / 不能做什么 / 约束分几级 / 要查东西时去哪。');
  console.error('    这个工具不会替你写它 —— 那一页只能是你的。');
  process.exit(1);
}

const text = fs.readFileSync(SELF_FILE, 'utf8');
const bytes = Buffer.byteLength(text, 'utf8');

// ── 活体段：凡是在「## 活体」之后的内容，都是自动生成的，不许手写 ──
const LIVE_MARK = '## 活体';
const cut = text.indexOf(LIVE_MARK);
const bone = cut >= 0 ? text.slice(0, cut) : text;

function ledgerOpen() {
  if (!fs.existsSync(LEDGER)) return { n: 0, open: [] };
  const rows = [];
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 半行，跳过 */ }
  }
  return { n: rows.length, open: rows.filter((r) => r.type === 'promise' || r.type === 'shelved') };
}

function liveBlock() {
  const { n, open } = ledgerOpen();
  const now = new Date();
  const lines = [
    '',
    LIVE_MARK + '（自动生成 —— 手写这一段没有意义）',
    '',
    `- 装配时刻：**${now.toISOString()}**`,
    `- 账本：共 ${n} 条 ｜ 未结 ${open.length} 条`,
  ];
  if (open.length) {
    lines.push('- ★ 欠着的（最近 3 条）：');
    for (const r of open.slice(-3)) {
      lines.push(`  - ${r.t || ''} [${r.type}] ${(r['概要'] || r.text || '').slice(0, 80)}`);
    }
  } else {
    lines.push('- ★ 没有欠着的活。');
  }
  lines.push('');
  return lines.join('\n');
}

// ── 体检 ──────────────────────────────────────────────
if (check) {
  const problems = [];

  // ① 不许有外链指向
  const linkLike = [];
  for (const [i, line] of bone.split('\n').entries()) {
    if (/(详见|参见|见\s*`?[^`\s]+\.(md|json|txt)|参考\s*`?[^`\s]+\.(md|json))/.test(line)) {
      linkLike.push(`${i + 1}: ${line.trim().slice(0, 76)}`);
    }
  }
  if (linkLike.length) problems.push(['① 有「详见某某」的指向', linkLike]);
  else console.log('  ✅ ① 没有外链指向 —— 这一页自己站得住');

  // ② 预算
  const pct = Math.round((bytes / BUDGET) * 100);
  if (bytes > BUDGET) problems.push(['② 超预算（超了会被截，而且截得无声）', [`${bytes} / ${BUDGET} 字节（${pct}%）`]]);
  else console.log(`  ✅ ② 没超预算：${bytes} / ${BUDGET} 字节（${pct}%）`);

  // ③ 活体段必须是自动生成的
  if (cut < 0) {
    problems.push(['③ 没有「## 活体」段', ['时钟 / 未结这类每轮在变的东西必须自动生成，不能手写']]);
  } else {
    const live = text.slice(cut);
    if (!/自动生成/.test(live)) {
      problems.push(['③ 活体段没有标注「自动生成」', ['手写的那一段迟早会和事实不一致，而且不一致时你不会知道']]);
    } else {
      console.log('  ✅ ③ 活体段是自动生成的（标注在）');
    }
  }

  if (problems.length) {
    console.log('');
    for (const [title, rows] of problems) {
      console.log(`  ⚠ ${title}`);
      for (const r of rows) console.log(`       ${r}`);
    }
    console.log('');
    console.log('  ★ 这三条不是风格要求：它们各自对应一种「无声的坏」。');
    process.exit(1);
  }
  console.log('');
  console.log('  ★ 三条全过。这一页守住了它该守的东西。');
  process.exit(0);
}

// ── 打印装配好的整页 ──────────────────────────────────
process.stdout.write(bone);
process.stdout.write(liveBlock());
