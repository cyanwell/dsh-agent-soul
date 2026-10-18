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
// 配置（都有默认值）：
//   SOUL_HOME   工作区目录（默认：脚本上一级的 soul/）      LEDGER  账本文件
//   INDEX_FILE  索引输出（默认：同级 index.json）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SOUL = process.env.SOUL_HOME || path.join(HERE, '..', '..', 'soul');
const LEDGER = process.env.LEDGER || path.join(SOUL, 'ledger.jsonl');
const OUT = process.env.INDEX_FILE || path.join(HERE, 'index.json');

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
