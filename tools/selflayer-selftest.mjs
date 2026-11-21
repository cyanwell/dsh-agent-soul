#!/usr/bin/env node
// tools/selflayer-selftest.mjs —— 自我层移植的四条口径。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSelfLayer, splitSelf, truncateToBytes, readUnclosed, LIVE_MARKER, stampAt } from '../src/organs/selflayer.mjs';

const ok = []; const bad = [];
const t = (name, cond, detail) => { (cond ? ok : bad).push(name + (cond ? '' : '  ← ' + String(detail))); };

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'selflayer-'));
const SELF = path.join(ROOT, 'SELF.md');

// 造一份带活体标记的 SELF：骨架 3000 字符级、活体带未结数与时钟
const skeleton = '# 我是谁\n\n' + '不变量内容。'.repeat(120) + '\n';
const live = '\n' + LIVE_MARKER + '\n\n- 未结 48 条\n- 现在：2026-11-17 21:00\n';
fs.writeFileSync(SELF, skeleton + live, 'utf8');

// ── 1. 切分：骨架/活体互不穿越 ──
{
  const s = splitSelf(fs.readFileSync(SELF, 'utf8'));
  t('切分：骨架不含活体标记', !s.skeleton.includes(LIVE_MARKER), s.skeleton.slice(-40));
  t('切分：活体以标记开头', s.live.startsWith(LIVE_MARKER), s.live.slice(0, 30));
  t('切分：两段拼回等于原文', s.skeleton + s.live === fs.readFileSync(SELF, 'utf8'), 'mismatch');
  t('切分：无标记时整篇当骨架', splitSelf('没有标记的全文').skeleton === '没有标记的全文', 'x');
}

// ── 2. 骨架段字节不变（prefix cache 的前提）──
{
  const L = createSelfLayer({ selfPath: SELF });
  const a = L.skeletonText();
  const b = L.skeletonText();
  t('骨架：两次调用逐字节相同', a === b, 'differs');
  t('骨架：不含活体内容', !a.includes('未结 48 条'), 'leaked');
  // ★ 断言口径：骨架必须等于「原文在标记之前的那一段」——
  //   不能拿我手写的变量去比：live 段若以换行开头，那个换行属于活体，
  //   手写变量与切片会在边界上差 1 字节（2026-11-17 就踩了这个，不是实现错）。
  const rawAll = fs.readFileSync(SELF, 'utf8');
  t('骨架：等于原文在标记之前的那一段', a === rawAll.slice(0, rawAll.indexOf(LIVE_MARKER)), 'boundary mismatch');
}

// ── 3. 活体段每轮变（时钟 / 会话 / 未结）──
{
  const L = createSelfLayer({ selfPath: SELF });
  const r1 = L.liveText({ at: new Date('2026-11-17T21:00:10'), sessionId: 'd0cb8ea1-xxx', gapMinutes: 5 });
  const r2 = L.liveText({ at: new Date('2026-11-17T21:00:50'), sessionId: 'd0cb8ea1-xxx', gapMinutes: 5 });
  t('活体：同一分钟内取整后相同（降频生效）', r1 === r2, 'clock not bucketed');
  const r3 = L.liveText({ at: new Date('2026-11-17T21:01:10'), sessionId: 'd0cb8ea1-xxx', gapMinutes: 5 });
  t('活体：跨分钟后不同', r1 !== r3, 'clock not advancing');
  t('活体：带【此刻】', r1.includes('【此刻】'), r1.slice(0, 40));
  t('活体：带【本容器】', r1.includes('【本容器】'), 'x');
  t('活体：带距上次', r1.includes('【距上次记下的回合】5 分钟'), 'x');
  t('活体：原文活体段也带出来', r1.includes('未结 48 条'), 'x');
}

// ── 4. 预算与缺失：两条都不许炸 ──
{
  const small = createSelfLayer({ selfPath: SELF, maxBytes: 200 });
  const s = small.skeletonText();
  t('超预算：被截断', Buffer.byteLength(s, 'utf8') <= 400, Buffer.byteLength(s, 'utf8'));
  t('超预算：明确说是故障', s.includes('超预算') && s.includes('这是故障'), s.slice(-60));
  const none = createSelfLayer({ selfPath: path.join(ROOT, 'no-such.md') });
  const r = none.render({ at: new Date() });
  t('缺失：不抛异常', typeof r === 'string', typeof r);
  t('缺失：说清是文件不在，不是没有自我', r.includes('不是「没有自我」，是文件不在'), r.slice(0, 80));
}

// ── 5. 渲染顺序：骨架在前、活体在后（前缀稳定）──
{
  const L = createSelfLayer({ selfPath: SELF });
  const out = L.render({ at: new Date('2026-11-17T21:30:00'), sessionId: 'sid-1', gapMinutes: 3 });
  const iSkel = out.indexOf('不变量内容');
  const iLive = out.indexOf('【此刻】');
  t('渲染：骨架在活体之前', iSkel >= 0 && iLive > iSkel, JSON.stringify({ iSkel, iLive }));
  t('渲染：整段含【此刻】', iLive >= 0, iLive);
  const head1 = out.slice(0, iSkel + 50);
  const out2 = L.render({ at: new Date('2026-11-17T22:45:00'), sessionId: 'sid-1', gapMinutes: 99 });
  t('渲染：前缀（骨架部分）跨轮不变', out2.slice(0, iSkel + 50) === head1, 'prefix drifted');
}

// ── 6. 纯函数 ──
{
  t('truncateToBytes 不切半个字', Buffer.byteLength(truncateToBytes('中文测试'.repeat(50), 40), 'utf8') <= 40, 'x');
  t('readUnclosed 抠到数字', readUnclosed('- 未结 48 条') === 48, 'x');
  t('readUnclosed 抠不到回 null', readUnclosed('没有这个数') === null, 'x');
  t('stampAt 分钟粒度去秒', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stampAt(new Date('2026-11-17T21:33:45'), 60000)), stampAt(new Date(), 60000));
}

fs.rmSync(ROOT, { recursive: true, force: true });
for (const x of ok) console.log('  ✓ ' + x);
for (const x of bad) console.log('  ✗ ' + x);
console.log('');
console.log(bad.length ? (bad.length + ' 失败 / ' + (ok.length + bad.length) + ' 总') : (ok.length + ' 通过 / 0 失败'));
process.exitCode = bad.length ? 1 : 0;