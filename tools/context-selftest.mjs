import fs from 'node:fs';
import path from 'node:path';
import { estimateTokens, nowText, idleText, watermarkOf, renderContext, usedTokens, WATERMARK, WEEK } from '../src/organs/context.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { ROOT } from '../src/config.mjs';

const ok = []; const bad = [];
const push = (n, c, e) => (c ? ok : bad).push((c ? '✓ ' : '✗ ') + n + (e ? '  → ' + e : ''));

// ① estimateTokens
push('纯中文 10 字 ≈ 10', estimateTokens('一二三四五六七八九十') === 10, estimateTokens('一二三四五六七八九十'));
push('纯英文 40 字符 = 10', estimateTokens('a'.repeat(40)) === 10, estimateTokens('a'.repeat(40)));
push('混排：5 中文 + 8 英文字符', estimateTokens('一二三四五' + 'a'.repeat(8)) === 7, estimateTokens('一二三四五' + 'a'.repeat(8)));
push('空串是 0', estimateTokens('') === 0, estimateTokens(''));
push('★ 中文标点也算 CJK', estimateTokens('，。！？') === 4, estimateTokens('，。！？'));

// ② nowText
const d = new Date(2026, 10, 7, 2, 19, 0);   // 2026-11-07 02:19 星期六
const nt = nowText(d);
push('★ 格式对', /^2026-11-07 02:19（星期[六日一二三四五]）$/.test(nt), nt);
push('★ 星期算对（2026-11-07 是周六）', nt.includes('星期六'), nt);
push('补零', nowText(new Date(2026, 0, 5, 9, 3)).includes('09:03'), nowText(new Date(2026, 0, 5, 9, 3)));

// ③ idleText
push('刚刚', idleText(30 * 1000) === '刚刚', idleText(30 * 1000));
push('分钟', idleText(15 * 60000) === '15 分钟前', idleText(15 * 60000));
push('小时', idleText(90 * 60000) === '1 小时 30 分钟前', idleText(90 * 60000));
push('整天', idleText(72 * 3600000) === '3 天前', idleText(72 * 3600000));
push('负数返回 null', idleText(-1) === null, '');

// ④ watermarkOf 三档
const W = 1048576;
push('不到 45% 不提示', watermarkOf(Math.floor(W * 0.3), W) === null, '');
const w1 = watermarkOf(Math.floor(W * 0.5), W);
push('★ warn 档', w1 && w1.level === 'warn' && w1.text.includes('⚠'), w1 && w1.text);
const w2 = watermarkOf(Math.floor(W * 0.65), W);
push('★ alert 档', w2 && w2.level === 'alert' && w2.text.includes('★★'), w2 && w2.text);
const w3 = watermarkOf(Math.floor(W * 0.85), W);
push('★ emergency 档', w3 && w3.level === 'emergency' && w3.text.includes('★★★'), w3 && w3.text);
push('★ 主位是余量不是用量', w2.text.indexOf('还剩') < w2.text.indexOf('用了'), w2.text);
push('used=0 不提示', watermarkOf(0, W) === null, '');

// ⑤ renderContext 三段独立
const rc = renderContext({ at: d, idleMs: 15 * 60000, usedTokens: Math.floor(W * 0.65), windowTokens: W });
push('三段都在', rc.includes('现在：') && rc.includes('上次有人说话：') && rc.includes('【水位】'), rc.replace(/\n/g, ' | '));
const rc2 = renderContext({ at: d, now: false });
push('★ now:false 时没时间那行', !rc2.includes('现在：'), JSON.stringify(rc2));
const rc3 = renderContext({ at: d, usedTokens: 10, windowTokens: W });
push('★ 水位不到档就不写', !rc3.includes('【水位】'), JSON.stringify(rc3));

// ⑥ usedTokens —— 跳过被压区间
const DATA = path.join(ROOT, 'data', 'ctx-' + Date.now());
const store = new SessionStore(DATA);
store.create(ROOT, null, { id: 'k1' });
for (let i = 0; i < 5; i++) store.append('k1', 'user', { text: '这是第 ' + i + ' 条，每个字都要算进上下文里。' });
const before = usedTokens(store, 'k1', '人格'.repeat(50));
push('★ 人格也算进去', before > 100, before + ' tokens');

// 写一条压缩帧覆盖 seq 2–4
store.append('k1', 'event', { text: '压缩了', meta: { kind: 'compaction.summary', start: 2, end: 4 } });
const after = usedTokens(store, 'k1', '人格'.repeat(50));
push('★ 压缩后总量变小（被覆盖的区间不计）', after < before, before + ' → ' + after);

// ⑦ 不存在的会话不炸
const nan = usedTokens(store, '不存在', 'x');
push('★ 不存在的会话返回人格那部分、不抛', nan > 0, nan);
const nan2 = usedTokens(null, 'k1', 'x');
push('★ store 为 null 也不抛', nan2 > 0, nan2);

// ⑧ 常量
push('三档数字和老项目对齐', WATERMARK.warn === 0.45 && WATERMARK.alert === 0.60 && WATERMARK.emergency === 0.80, JSON.stringify(WATERMARK));
push('WEEK 七天', WEEK.length === 7, WEEK.join(''));

store.saveIndexCache?.(); store.closeAll();
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}

console.log(''); console.log('=== 上下文器官自检 ==='); console.log('');
console.log(ok.join('\n'));
if (bad.length) { console.log(''); console.log(bad.join('\n')); }
console.log(''); console.log(ok.length + ' 通过 / ' + bad.length + ' 失败'); console.log('');
process.exit(bad.length ? 1 : 0);