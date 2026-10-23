// index.mjs —— 索引构建器：把「能被搜到的东西」压成一份 json
//
// ★ 三分钟上手：
//   ① node index.mjs
//   ② ★ 验：同级出现 index.json，里面有几条记录
//
// ★ 为什么索引要单独一个程序（而不是查询时现扫）：
//   全量扫一遍工作区可能要几秒到几十秒，而**查询必须快**。
//   读和建分开 —— 建的时候慢一次，查的时候一直快。
//
// 配置（★ 前两个没有默认值 —— 见下面的报错）：
//   SOUL_HOME   工作区目录（必配，或用 LEDGER 直接指账本）
//   LEDGER      账本文件（默认 <SOUL_HOME>/02-墨.jsonl）
//   INDEX_FILE  索引输出（默认：同级 index.json）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV = (k) => String(process.env[k] || '').trim();

// ★★ 2026-10-23 修：原来默认 `HERE/../../soul` —— 在仓库布局下是 plugins/soul（不存在），
//   于是索引里 0 条，**它不报错、只是空**。工作区在哪只有使用者知道，猜不得。
//   候选：① SOUL_HOME（显式）；② 没配 SOUL_HOME 但配了 LEDGER 时仍可只建账本那一层；
//   ③ 两个都没配 → 明确报错并说清该指哪（见下面的 SOUL_MISSING）。
const SOUL = ENV('SOUL_HOME');
const LEDGER = ENV('LEDGER') || (SOUL ? path.join(SOUL, '02-墨.jsonl') : '');
const OUT = ENV('INDEX_FILE') || path.join(HERE, 'index.json');
const SOUL_MISSING = '未配置工作区：请设 SOUL_HOME=<你的工作区根目录>'
  + '（放 *.md 与账本的地方；账本默认取 <SOUL_HOME>/02-墨.jsonl），'
  + '或直接设 LEDGER=<账本文件完整路径>。';

/** 一行一行读账本；坏行跳过（账本是追加的，最后一行可能是半行） */
function readLedger() {
  if (!fs.existsSync(LEDGER)) return [];
  const rows = [];
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* 半行，跳过 */ }
  }
  return rows;
}

/** 递归收 markdown（跳过 .git / node_modules） */
function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// ★ 未配置就明确报错并给下一步，不产出「0 条的假索引」
if (!SOUL && !LEDGER) {
  console.error('✗ ' + SOUL_MISSING);
  process.exit(1);
}
if (SOUL && !fs.existsSync(SOUL)) {
  console.error('✗ SOUL_HOME 指向的目录不存在：' + SOUL);
  console.error('  ★ 检查 SOUL_HOME 是否指对（它应该是你放 *.md 与账本的那个根目录）。');
  process.exit(1);
}
if (LEDGER && !fs.existsSync(LEDGER)) {
  console.error('✗ 账本文件不存在：' + LEDGER);
  console.error('  ★ 设 LEDGER=<账本完整路径>，或设 SOUL_HOME 让账本默认取 <SOUL_HOME>/02-墨.jsonl。');
  process.exit(1);
}

const records = [];

// ① 账本 —— 每条都是可裁决的一手记录
for (const [i, r] of readLedger().entries()) {
  records.push({
    kind: 'ledger',
    // ★ 指针：能回到这一条（顺序号在追加账本里是稳定的）
    ptr: `ledger:${i}`,
    when: r.t || '',
    type: r.type || '',
    text: [r['概要'] || r.text || '', r.ref ? `（出处：${r.ref}）` : ''].join(''),
  });
}

// ② 工作区里的 markdown —— 一手层
for (const f of walk(SOUL)) {
  const rel = path.relative(SOUL, f).split(path.sep).join('/');
  let text = '';
  try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
  // 每 40 行切一段（段太大搜不准，太小会丢上下文）
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 40) {
    const chunk = lines.slice(i, i + 40).join('\n').trim();
    if (!chunk) continue;
    records.push({
      kind: 'file',
      ptr: `file:${rel}#L${i + 1}-${Math.min(i + 40, lines.length)}`,
      when: '',
      type: '',
      text: chunk,
    });
  }
}

fs.writeFileSync(OUT, JSON.stringify({ built: new Date().toISOString(), soul: SOUL, records }, null, 0));
const byKind = records.reduce((a, r) => (a[r.kind] = (a[r.kind] || 0) + 1, a), {});
console.log(`✓ 索引写好：${OUT}`);
console.log(`  账本 ${byKind.ledger || 0} 条 ｜ 工作区 ${byKind.file || 0} 段（来自 ${walk(SOUL).length} 个 md）`);
console.log(`  ★ 验：这个文件存在、里面有记录 —— 那就可以开始搜了`);
