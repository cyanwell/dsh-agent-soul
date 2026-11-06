// 砚台自检 —— 重点不是「函数能跑」，是「四块都有值，而且值是从对的地方来的」。
//
// ★ 这一整份最怕的不是报错，是**静默变空**：页面在、骨架在、每一格是空的。
//   所以下面一半的断言是「值必须来自哪里」，而不只是「值不是 undefined」。
//
// ★ 用法：
//     node tools/yantai-selftest.mjs                # 跑全部（含最后一节：真实数据）
//     node tools/yantai-selftest.mjs --serve 7611   # 起一个只服务砚台的最小服务（截图 / 手看）
//   为什么要 --serve：真实路由在 src/web/server.mjs，由 Lead 统一接；本自检不碰那个文件，
//   所以自己起一个只服务两条路由的 http（页面 + /api/yantai）。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { loadConfig, ROOT } from '../src/config.mjs';
import { SessionStore } from '../src/session/store.mjs';
import { PersonaLayer } from '../src/persona/layer.mjs';
import { LedgerBase } from '../src/organs/ledger.mjs';
import { estimateTokens } from '../src/organs/context.mjs';
import {
  gather, readWater, readOpen, readRecent, buildGates, pickLedger, ledgerOf,
  normalizeRow, MOTTO, WATER_MAX_BYTES, OPEN_LIMIT, RECENT_LIMIT,
} from '../src/yantai/panel.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(ROOT || path.join(HERE, '..'));
const TMP = path.join(APP, 'data', '.yantai-selftest');

let pass = 0, fail = 0;
const t = (n, c, e) => {
  if (c) { pass++; console.log('  + ' + n + (e != null ? '  ' + e : '')); }
  else { fail++; console.log('  x ' + n + (e != null ? '  -> ' + e : '')); }
};

const fakePersona = (text, used, budget) => ({
  entries: [{ name: 'x', bytes: used }],
  render: () => ({ text, used, budget, dropped: [] }),
});

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ═══════════════════════════════════════════════════════════
console.log('\n① 水位 —— 口径（引擎那条规则），不是随便一个数');
{
  const store = new SessionStore(path.join(TMP, 'water'));
  store.create('D:/tmp', null, { id: 'w1' });
  store.append('w1', 'user', { text: 'abcd' });          // 1 token + 4 框架 = 5
  const persona = fakePersona('一二三四五', 15, 30);      // 5 token / 15B / 预算 30B
  const w = readWater({ store, config: { context: { windowTokens: 1000, maxFrames: 60 } }, persona });

  t('水位有值', w.ok === true);
  t('分母来自 config.context.windowTokens', w.window === 1000, w.window);
  t('人格 token 用 estimateTokens 算', w.personaTokens === 5, w.personaTokens);
  t('帧只算最近 maxFrames 帧，且跳过 session 头', w.frameCount === 1 && w.frameTokens === 5,
    '帧 ' + w.frameCount + ' 条 / ' + w.frameTokens + ' token');
  t('used = 人格 + 帧（与 loop 同一条规则）', w.used === 10, w.used);
  t('主位是余量', w.left === 990 && w.leftText === '990', w.leftText);
  t('人格层用自己的尺子：bytes / bytes', w.persona.pct === 0.5, w.persona.pct);
  t('没有把 bytes 除以 token（server.mjs 那一行没照抄）',
    Math.abs(w.persona.used / w.window - w.persona.pct) > 0.01,
    '旧算法会给 ' + (w.persona.used / w.window * 100).toFixed(2) + '%，实际是 5.0%');
  t('不到 45% -> level=ok', w.level === 'ok', w.level);
  t('不到线时文案是「不用管」，不是警告', /不用缩/.test(w.verdict), w.verdict);
  t('不到线时明说没到 45%', /45%/.test(w.mark), w.mark);
  t('口径里写明「不是服务商回传的 usage」', /不是服务商/.test(w.ruler), w.ruler.slice(0, 34) + '…');
  t('会话挑到了', w.session === 'w1', w.session);
  t('另一把尺子也在（全帧，只做对照）', typeof w.usedAll === 'number', w.usedAll);
}

console.log('\n② 水位 —— 过线之后只触发一个动作');
{
  const store = new SessionStore(path.join(TMP, 'water2'));
  store.create('D:/tmp', null, { id: 'w2' });
  store.append('w2', 'user', { text: 'x'.repeat(400) });   // 100 token
  const persona = fakePersona('', 0, 100);
  const w = readWater({ store, config: { context: { windowTokens: 100, maxFrames: 60 } }, persona });
  t('满窗 -> emergency', w.level === 'emergency', w.level + ' / ' + (w.pct * 100).toFixed(0) + '%');
  t('红灯的下一步是「落盘」，不是「缩」', /落盘/.test(w.verdict) && !/节省/.test(w.verdict), w.verdict);
  t('mark 里带三颗星', /★★★/.test(w.mark), w.mark);
  const w2 = readWater({ store, config: { context: { windowTokens: 200, maxFrames: 60 } }, persona });
  t('半窗 -> 进了 warn 或 alert 档', w2.level === 'warn' || w2.level === 'alert', w2.level);
}

console.log('\n③ 水位 —— 读不到就说读不到，不许冒充 0%');
{
  const emptyStore = { list: () => [], recent: () => [] };
  const w = readWater({ store: emptyStore, config: { context: { windowTokens: 1000 } }, persona: null });
  t('没东西可量 -> ok:false', w.ok === false);
  t('说清「不是 0%，是没东西可量」', /没东西可量/.test(w.hint || ''), w.hint);

  const fakeStore = {
    list: () => [
      { id: 'big', bytes: 100 * 1024 * 1024, mtime: Date.now() },
      { id: 'ok', bytes: 10, mtime: Date.now() - 1000 },
    ],
    recent: (id) => (id === 'ok' ? [{ seq: 1, type: 'user', text: 'ab' }] : []),
  };
  const w2 = readWater({ store: fakeStore, config: { context: { windowTokens: 1000 } }, persona: fakePersona('', 0, 10) });
  t('大会话被跳过，不是被整读', w2.skippedBig === 1 && w2.session === 'ok',
    '跳过 ' + w2.skippedBig + ' 个，选了 ' + w2.session);
  t('阈值常量就是 16MB', WATER_MAX_BYTES === 16 * 1024 * 1024, WATER_MAX_BYTES);
}

// ═══════════════════════════════════════════════════════════
console.log('\n④ 未结的活 —— 只认 promise / shelved，别的类型不许混进来');
const LFILE = path.join(TMP, 'ledger.jsonl');
const at = (iso) => ({ now: () => new Date(iso) });
const LW = (iso) => new LedgerBase(LFILE, at(iso));
{
  // ★ 落笔顺序必须等于时间顺序 —— 只追加的账本靠这个，不许事后往回插旧日期的行。
  //   （第一版自检就是往回插了一条，然后「最近账本」的顺序断言挂了 —— 那是自检的错，不是代码的错。）
  LW('2026-08-01T09:00:00+08:00').write({ type: 'shelved', text: '很久以前搁置的', by: 'abcd1234' });
  // 闸门：promise 只有脑能写 —— 先署一条 lead
  t('先署 lead 成功（后面才有资格写 promise）', LW('2026-09-20T10:00:00+08:00')
    .write({ type: 'lead', text: '第 1 代 · 自检用', by: 'abcd1234' }).ok === true);
  LW('2026-10-20T10:00:00+08:00').write({ type: 'promise', text: '把四块搬进来', by: 'abcd1234', ref: 'docs/a.md' });
  LW('2026-10-21T10:00:00+08:00').write({ type: 'shelved', text: '先放下的那件事', by: 'abcd1234', feel: '有点舍不得' });
  LW('2026-10-22T10:00:00+08:00').write({ type: 'fact', text: '不是未结的活，不许出现', by: 'abcd1234' });
  LW('2026-10-23T10:00:00+08:00').write({ type: 'gain', text: '得，也不是未结', by: 'abcd1234' });

  const L = new LedgerBase(LFILE);
  const now = Date.parse('2026-10-24T00:00:00+08:00');
  const o = readOpen(L, { now });

  t('账本能读', o.ok === true);
  t('总数只算 promise + shelved', o.total === 3, o.total);
  t('promise / shelved 分开数', o.promise === 1 && o.shelved === 2, o.promise + ' / ' + o.shelved);
  t('fact / gain 一条都没混进来', !o.rows.some((r) => r.type === 'fact' || r.type === 'gain'));
  t('按时间倒序（最新的在最上面）', o.rows[0].t === '2026-10-21T10:00:00+08:00', o.rows[0].t);
  t('两种字段都认：概要 与 text',
    o.rows.some((r) => r.text === '把四块搬进来') && o.rows.some((r) => r.text === '很久以前搁置的'));
  t('feel 透传（一手感受）', o.rows.some((r) => r.feel === '有点舍不得'));
  t('ref 透传', o.rows.some((r) => r.ref === 'docs/a.md'));
  t('陈账单独数（>7 天的只有 08-01 那 1 条）', o.stale === 1, o.stale);
  t('最老那条能说出来', o.oldest && o.oldest.t === '2026-08-01T09:00:00+08:00', o.oldest && o.oldest.age);
  t('只摆 OPEN_LIMIT 条（一屏放得下）', o.rows.length <= OPEN_LIMIT, o.rows.length + ' 条 / 上限 ' + OPEN_LIMIT);

  const o2 = readOpen(null);
  t('没有账本 -> ok:false + 说明', o2.ok === false && /没找到账本/.test(o2.hint || ''), o2.hint);

  const emptyFile = path.join(TMP, 'empty.jsonl');
  fs.writeFileSync(emptyFile, '', 'utf8');
  const o3 = readOpen(new LedgerBase(emptyFile), { now });
  t('空账本 ≠ 读不到：ok:true、0 条、说清是空的',
    o3.ok === true && o3.total === 0 && /空/.test(o3.hint || ''), o3.hint);
}

console.log('\n⑤ 最近的账本 —— 条数、倒序、统计、主导');
{
  const L = new LedgerBase(LFILE);
  const r = readRecent(L, { limit: 4, now: Date.parse('2026-10-24T00:00:00+08:00') });
  t('拿得到行', r.ok === true && r.rows.length === 4, r.rows.length);
  t('倒序（最新在前）', String(r.rows[0].t) >= String(r.rows[3].t), r.rows[0].t);
  t('每条都带类型中文名', r.rows.every((x) => x.label && x.label !== '?'), r.rows.map((x) => x.label).join(','));
  t('带全账统计（6 条：搁置/主导/承诺/搁置/事实/得）', r.stats && r.stats.total === 6, r.stats && r.stats.total);
  t('带当前主导（最后一条 lead）', r.lead && r.lead.by === 'abcd1234', r.lead && r.lead.norm);
  const r1 = readRecent(null);
  t('没有账本 -> ok:false', r1.ok === false && r1.rows.length === 0);
}

console.log('\n⑥ 几扇门 —— 路径必须来自 config，没有就明说，不许拼假路径');
{
  const cfg = {
    soul: { root: 'D:/AI/yanqing-soul' },
    diary: { dir: null },
    dataDir: 'D:/AI/agent-soul/data',
    port: 7611,
  };
  const info = { file: LFILE, source: 'test', exists: true, tried: [LFILE] };
  const g = buildGates({ config: cfg, root: APP }, info);
  const by = (id) => g.rows.find((x) => x.id === id);

  t('七扇门都在', g.rows.length === 7, g.rows.length);
  t('书房根来自 config.soul.root', by('soul').ready && by('soul').cmd === 'D:/AI/yanqing-soul', by('soul').cmd);
  t('会话数据来自 config.dataDir', by('data').ready && by('data').cmd === 'D:/AI/agent-soul/data');
  t('没配日记目录 -> ready:false，且 why 点名 config.diary.dir',
    by('diary').ready === false && /config\.diary\.dir/.test(by('diary').why), by('diary').why);
  t('没配的那扇门不塞假路径', by('diary').cmd === '', JSON.stringify(by('diary').cmd));
  t('账本门指着真文件', by('ledger').ready === true && by('ledger').cmd === LFILE);
  t('命令里的 node 就是当前这个 node', by('selftest').cmd.includes(process.execPath), by('selftest').cmd.slice(0, 60));
  t('起服务那条带端口', /AGENT_SOUL_PORT=7611/.test(by('serve').cmd), 'ok');
  t('这一页那条是 URL', by('page').cmd === 'http://127.0.0.1:7611/yantai');

  const info2 = { file: 'D:/nope/ledger.jsonl', source: 'x', exists: false, tried: ['D:/a/02-墨.jsonl', 'D:/b/ledger.jsonl'] };
  const g2 = buildGates({ config: cfg, root: APP }, info2);
  const lg = g2.rows.find((x) => x.id === 'ledger');
  t('账本不存在 -> ready:false，且把找过哪儿列出来',
    lg.ready === false && /02-墨/.test(lg.why) && /ledger\.jsonl/.test(lg.why), lg.why);
}

console.log('\n⑦ 页面 —— 那句话必须在屏幕上，不在注释里');
{
  const f = path.join(APP, 'src', 'web', 'yantai.html');
  t('页面文件在', fs.existsSync(f), path.relative(APP, f));
  const html = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';

  t('★ 静态写着「水位是安全网，不是考核」', html.includes('水位是安全网，不是考核'));
  t('★ 静态写着「过线只该触发一个动作」', html.includes('过线只该触发一个动作'));
  t('★ 静态写着「禁止第二个 —— 缩」', html.includes('禁止第二个'));
  t('这句话不依赖 JS（在 motto 块里，不在 script 里）',
    /<div class='motto'[\s\S]*?<\/div>/.test(html) && html.indexOf('水位是安全网') < html.indexOf('<script>'));
  t('MOTTO 常量逐字对得上', MOTTO === '水位是安全网，不是考核。过线只该触发一个动作 —— 落盘；禁止第二个 —— 缩。', MOTTO.length + ' 字');
  t('四块的锚点都在', ['id=\'water\'', 'id=\'open\'', 'id=\'recent\'', 'id=\'gates\''].every((s) => html.includes(s)));
  t('nav 里砚台是当前页', /<a href='\/yantai' class='on'>/.test(html));
  t('nav 带着别的五页', ['/', '/organs', '/diary', '/params', '/settings', '/chat'].every((h) => html.includes("href='" + h + "'")));
  t('接口没接上时给的是可执行的下一步（不是转圈）', /\/api\/yantai/.test(html) && /server\.mjs/.test(html));
}

// ═══════════════════════════════════════════════════════════
console.log('\n⑧ 真实数据 —— 用真的 config / 真的会话目录 / 真的《墨》');
let real = null;
{
  const config = loadConfig();
  const store = new SessionStore(config.dataDir);
  const persona = new PersonaLayer({ budget: (config.persona && config.persona.budget) || 80000 });
  persona.load((config.persona && config.persona.files) || [], { root: APP });

  const t0 = Date.now();
  const d = await gather({ store, config, persona });
  const ms = Date.now() - t0;
  real = d;

  const sessions = store.list().length;
  t('会话目录里有东西', sessions > 0, sessions + ' 个会话');
  t('账本自动选中了书房里的《墨》', /02-墨\.jsonl$/.test(d.ledger.file) && d.ledger.exists === true, d.ledger.file);
  t('走的是自己构造的 LedgerBase（不是那个唤醒台账）', d.ledger.fromCtx === false);
  t('① 水位有值', d.water.ok === true,
    d.water.used + ' token / 窗口 ' + d.water.window + '（' + (d.water.pct * 100).toFixed(1) + '%）');
  t('② 未结的活有值', d.open.ok === true && d.open.total > 0,
    d.open.total + ' 条（承诺 ' + d.open.promise + ' / 搁置 ' + d.open.shelved + '，陈账 ' + d.open.stale + '）');
  t('③ 最近的账本有值', d.recent.ok === true && d.recent.rows.length === RECENT_LIMIT,
    d.recent.rows.length + ' 条，全账 ' + (d.recent.stats && d.recent.stats.total));
  t('④ 几扇门有值', d.gates.ok === true && d.gates.rows.length === 7,
    d.gates.ready + ' / ' + d.gates.total + ' 可用');
  t('一句话也随数据发出去了', d.motto.text === MOTTO);
  t('整屏算完没超过 2 秒', ms < 2000, ms + 'ms');
}

console.log('\n⑨ 四块互不拖累 —— 一块炸了，别的照常');
{
  const bad = {
    config: { dataDir: 'D:/nope', context: { windowTokens: 1000 } },
    store: { list: () => { throw new Error('磁盘没了'); } },
    persona: null,
    ledger: undefined,
  };
  const d = await gather(bad);
  t('水位炸了 -> ok:false，但不抛', d.water.ok === false || d.water.why != null, d.water.why);
  t('其它三块仍然是「结构完整」的（有 rows/字段，不是 undefined）',
    Array.isArray(d.open.rows) && Array.isArray(d.recent.rows) && Array.isArray(d.gates.rows));
  t('账本没找到时 ok:false 且 hint 里是「没找到账本」', d.open.ok === false && /没找到账本/.test(d.open.hint || ''));

  const given = { all: () => [], stats: () => ({}), list: () => [], file: 'x' };
  t('给了像 LedgerBase 的东西就直接用', ledgerOf({ ledger: given }, {}).fromCtx === true);
  const waker = { views: () => ({}) };
  t('唤醒台账（没 list/stats）不会被误当《墨》', ledgerOf({ ledger: waker }, { file: LFILE }).fromCtx === false);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (fail === 0 ? '全部通过' : '失败 ' + fail + ' 项') + '：' + pass + ' 通过 / ' + fail + ' 失败');

// ── --serve：只服务砚台两条路由（真实路由由 Lead 接进 server.mjs）──
const si = process.argv.indexOf('--serve');
if (si > -1) {
  const port = Number(process.argv[si + 1]) || 7611;
  const config = loadConfig();
  const store = new SessionStore(config.dataDir);
  const persona = new PersonaLayer({ budget: (config.persona && config.persona.budget) || 80000 });
  persona.load((config.persona && config.persona.files) || [], { root: APP });
  const page = fs.readFileSync(path.join(APP, 'src', 'web', 'yantai.html'));

  http.createServer(async (req, res) => {
    const p = String(req.url || '/').split('?')[0];
    try {
      if (p === '/yantai' || p === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length });
        return res.end(page);
      }
      if (p === '/api/yantai') {
        const d = await gather({ store, config, persona }, { root: APP });
        const buf = Buffer.from(JSON.stringify(d), 'utf8');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'cache-control': 'no-store' });
        return res.end(buf);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('只有 /yantai 和 /api/yantai');
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(String((e && e.message) || e));
    }
  }).listen(port, '127.0.0.1', () => {
    console.log('\n砚台试跑：http://127.0.0.1:' + port + '/yantai');
    console.log('  （只服务页面 + /api/yantai；真路由由 src/web/server.mjs 接）');
  });
} else if (fail) {
  process.exit(1);
}
