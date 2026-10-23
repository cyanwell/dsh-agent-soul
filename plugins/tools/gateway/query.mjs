// query.mjs —— 门：一扇门搜全库，只回【指针 + 逐字片段】，不做转述
//
// ★ 三分钟上手：
//   ① node index.mjs        建索引（★ 验：出现 index.json）
//   ② node query.mjs now    现在什么样（★ 验：一行时钟 + 未结条数）
//   ③ node query.mjs 某个词  搜（★ 验：出来的是【指针 + 逐字片段】，不是转述）
//   ④ node query.mjs open <指针>   回原文（★ 验：打印那一段）
//
// ★★ 为什么「只回指针，不转述」：
//   转述是二手污染的来源。摘要说「他当时不同意」，
//   原文说「这个方向先放一放」—— 差的不是措辞，是事实。
//   所以每一条输出都带着【能回到原文的地址】。
//
// ★★ 一条纪律：拿不到精确地址时，写「未知」并给一个检索入口，绝不猜。
//   错的地址比没有地址危害更大 —— 它会返回错误内容，而且在形式上与正确结果无法区分。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = (k) => String(process.env[k] || '').trim();

// ★★ 2026-10-23 修（与 index.mjs 同一处形状）：原来默认 HERE/../../soul，在仓库布局下不存在，
//   于是 index.mjs 建出 0 条、query 自然什么都搜不到。工作区只能靠配置。
// 候选：① SOUL_HOME（显式）；② 只配 LEDGER 时仍可回账本那一层；③ 都没有 → 明确报错。
const SOUL = ENV('SOUL_HOME');
const INDEX = ENV('INDEX_FILE') || path.join(HERE, 'index.json');
const LEDGER = ENV('LEDGER') || (SOUL ? path.join(SOUL, '02-墨.jsonl') : '');
const SOUL_MISSING = '未配置工作区：请设 SOUL_HOME=<你的工作区根目录>'
  + '（账本默认取 <SOUL_HOME>/02-墨.jsonl），或直接设 LEDGER=<账本文件完整路径>。';

const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
const argv = process.argv.slice(2);
const cmd = argv[0];

function load() {
  if (!SOUL && !LEDGER) {
    console.error('✗ ' + SOUL_MISSING);
    console.error('  ★ 这是配置缺失，不是「没搜到」——先配好再跑 node index.mjs。');
    process.exit(1);
  }
  if (!fs.existsSync(INDEX)) {
    console.error('✗ 还没有索引。先跑：node index.mjs');
    console.error('  ★ 检索不到东西时，它必须说清「缺什么」，而不是回空。');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(INDEX, 'utf8'));
}

// ── now：现在是什么时候 / 有没有欠着的活 ─────────────
if (cmd === 'now' || !cmd) {
  const d = load();
  const now = new Date();
  const led = d.records.filter((r) => r.kind === 'ledger');
  const open = led.filter((r) => r.type === 'promise' || r.type === 'shelved');
  const last = led.length ? led[led.length - 1] : null;
  console.log(`现在：${now.toLocaleString('zh-CN')}`);
  console.log(`账本：共 ${led.length} 条 ｜ 未结 ${open.length} 条（promise / shelved）`);
  if (last) console.log(`最近一条：${last.when}  [${last.type}]  ${clip(last.text, 70)}`);
  console.log(`索引：建自 ${d.built}`);
  if (open.length) {
    console.log('── 欠着的（最近 3 条）──');
    for (const r of open.slice(-3)) console.log(`  ${r.when}  [${r.type}]  ${clip(r.text, 66)}`);
  }
  process.exit(0);
}

// ── open：指针 → 原文 ──────────────────────────────
if (cmd === 'open') {
  const ptr = argv[1] || '';
  const d = load();
  const hit = d.records.find((r) => r.ptr === ptr);
  if (!hit) {
    console.error(`✗ 没有这个指针：${ptr}`);
    console.error('  ★ 不猜。用 query.mjs <词> 重新搜一次拿地址。');
    process.exit(1);
  }
  console.log(`── ${hit.ptr} ──`);
  console.log(hit.text);
  process.exit(0);
}

// ── 搜：词 → 指针 + 逐字片段 ────────────────────────
const kw = argv.join(' ').toLowerCase();
if (!kw) {
  console.log('用法：node query.mjs <词>  ｜  now  ｜  open <指针>');
  process.exit(0);
}
const d = load();
const hits = d.records.map((r) => {
  const t = r.text.toLowerCase();
  const at = t.indexOf(kw);
  if (at < 0) return null;
  // ★ 命中位置前后各取一点，保证是【逐字片段】而不是我概括的
  const s = Math.max(0, at - 40);
  return { r, frag: r.text.slice(s, s + 130).replace(/\n/g, ' ').trim(), n: t.split(kw).length - 1 };
}).filter(Boolean).sort((a, b) => b.n - a.n).slice(0, 8);

if (!hits.length) {
  console.log(`✗ 没搜到「${kw}」`);
  // ★ 失败也要给入口，不留一个空
  console.log('  ★ 换个词再试；或者 node index.mjs 重建索引（新增的文件要重建才会进来）');
  process.exit(0);
}

console.log(`「${kw}」命中 ${hits.length} 处 —— 每题都带【能回到原文的地址】：\n`);
for (const h of hits) {
  const tag = h.r.kind === 'ledger' ? '一手·账本' : '一手·文件';
  console.log(`  [${tag}] ${h.r.ptr}`);
  if (h.r.when) console.log(`       ${h.r.when}  [${h.r.type}]`);
  console.log(`       …${h.frag}…`);
  console.log('');
}
console.log('★ 要看原文：node query.mjs open <上面那个地址>');
