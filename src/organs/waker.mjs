// 唤醒台账器官 —— 「有人找我 → 叫醒 → 记账 → 等人判定」
//
// ★ 从老 lead-waker（1,203 行）搬过来，改了形：
//   老版是「上行读事件队列 / 台账 / 下行轮询投递」三件事，因为它要跨会话；
//   我们这里只有一个常驻进程 + 一个 LLM，所以简化成：事件 → 台账 → 叫醒自己。
//
// ★★ 三条铁律（老版写在注释里的，不是文档里的）：
//   ① 【没写就当通过 —— 禁止】charter 的合法值只有 pass/ask/block/unchecked，
//      缺失或不合法一律回落 unchecked，**绝不回落 pass**。
//   ② 【队列与台账分开写】队列回答「说过什么」，台账回答「走到哪了」。
//      两个问题两份文件，两个写者 —— JSONL 改字段 = 重写文件 = 破坏写域。
//   ③ 【一行都不写别人的写域】我们只读事件总线，一个字都不往里写。

import fs from 'node:fs';
import path from 'node:path';

/** 状态机的合法取值。★ 严格校验的理由：台账是给人看的状态，
 *  一个拼错的 stage 会让这条事件在四个视图里全部消失 —— 消失比报错更坏。 */
export const STAGES = ['pending', 'woken', 'decided', 'done', 'held', 'auditing', 'stuck'];
export const DECISIONS = ['resume', 'hold', 'audit'];
export const CHARTERS = ['pass', 'ask', 'block', 'unchecked'];

/** decision → 终态。★ decided 是「过路态」：写判定的同一次事务里就穿过它。
 *  为什么不停在 decided：四视图的判据全读 decision，没有一个视图看 decided；
 *  停在 decided 只会让人以为「还有一步没做」，而实际上那一步就是判定本身。 */
export const STAGE_BY_DECISION = { resume: 'done', hold: 'held', audit: 'auditing' };

/** 一条记录的白名单化。★ 这里是所有不变量的落点。 */
export function normalizeRecord(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    key: String(r.key || ''),
    t: String(r.t || ''),
    title: String(r.title || '').slice(0, 200),
    from: String(r.from || ''),
    tier: String(r.tier || ''),
    stage: STAGES.includes(r.stage) ? r.stage : 'pending',
    wakeCount: Number.isFinite(r.wakeCount) ? Math.max(0, Math.floor(r.wakeCount)) : 0,
    wokenAt: Number.isFinite(r.wokenAt) ? r.wokenAt : null,
    decision: DECISIONS.includes(r.decision) ? r.decision : null,
    // ★★ 关键一行：不合法/缺失一律回落 unchecked，绝不回落 pass
    charter: CHARTERS.includes(r.charter) ? r.charter : 'unchecked',
    charterNote: String(r.charterNote || '').slice(0, 300),
    decidedAt: Number.isFinite(r.decidedAt) ? r.decidedAt : null,
    note: String(r.note || '').slice(0, 600),
    // ★ 回邮地址必须活着穿过白名单 —— 老版漏了这一行，
    //   wake 写进去了、normalize 又把它丢掉，于是判定时无址可寄。
    fromSession: String(r.fromSession || ''),
  };
}

/** 写一次判定。纯函数（就地改 events 里那一条），便于自测。
 *  ★ charter 不传就**保留原值** —— 不是「默认 pass」，而是「这次没表态，维持 unchecked」。 */
export function applyDecision(ledger, key, patch) {
  const ev = ledger.events.find(x => x.key === key);
  if (!ev) return { ok: false, err: '台账里没有这条 key' };

  const decision = String((patch && patch.decision) || '');
  if (!DECISIONS.includes(decision)) {
    return { ok: false, err: 'decision 只能是 resume / hold / audit' };
  }

  const charterRaw = patch && patch.charter;
  const charter = (charterRaw === undefined || charterRaw === null || charterRaw === '')
    ? ev.charter
    : String(charterRaw);
  if (!CHARTERS.includes(charter)) {
    return { ok: false, err: 'charter 只能是 pass / ask / block / unchecked' };
  }

  ev.decision = decision;
  ev.charter = charter;
  if (patch.charterNote !== undefined && patch.charterNote !== null) ev.charterNote = String(patch.charterNote).slice(0, 300);
  if (patch.note !== undefined && patch.note !== null) ev.note = String(patch.note).slice(0, 600);
  ev.decidedAt = Date.now();
  ev.stage = STAGE_BY_DECISION[decision];
  return { ok: true, event: ev };
}

/**
 * 四类视图。一条事件可以同时出现在两个视图里 ——
 * 「你已执行」问的是「做完了什么」，「你自己决定做的」问的是「谁拍的主意」，
 * 这是两个问题，重叠是设计，不是 bug。
 */
export function viewsOf(events) {
  const act = [], done = [], audit = [], auto = [];
  for (const ev of events) {
    if (ev.stage === 'woken' && !ev.decision) act.push(ev);
    if (ev.decision === 'resume') done.push(ev);
    // ★ stuck 归进「要审计但没审」：严格按判据它会在界面上彻底消失，
    //   而「叫不醒」恰恰是最不该消失的一种，所以显式收进来。
    if (ev.decision === 'audit' || ev.charter === 'ask' || ev.stage === 'stuck') audit.push(ev);
    if (ev.decision && ev.charter === 'pass') auto.push(ev);
  }
  // 时间倒序（新的在前）。t 是 ISO 串，直接比字符串即可；空 t 沉底。
  const byT = (a, b) => String(b.t || '').localeCompare(String(a.t || ''));
  act.sort(byT); done.sort(byT); audit.sort(byT); auto.sort(byT);
  return { act, done, audit, auto };
}

/** 徽章 = 未处理数。「要你执行」+「要审计但没审」的并集（同一条可能两边都在，去重）。 */
export function badgeOf(views) {
  const s = new Set();
  for (const ev of views.act) s.add(ev.key);
  for (const ev of views.audit) s.add(ev.key);
  return s.size;
}

/** 叫醒文案。★ 台账 key 必须放进去 —— 回写判定时要能对上是哪一条。 */
export function buildWakeText(rec, extra) {
  const e = extra || {};
  return [
    '【事件层 · 有人找你】',
    '',
    '标题：' + (rec.title || '(无标题)'),
    '来自：' + (rec.from || '未知渠道') + '　层级：' + (e.level || '?') + '　类型：' + (e.kind || '?'),
    rec.tier === 'act' ? '★ 标了 act —— 上游判断这一条该由你动手。' : '',
    '',
    String(e.facts || '').slice(0, 3000),
    '',
    e.why ? '上游的判断：' + String(e.why).slice(0, 600) : '',
    '',
    '————————————————',
    '这是事件层转上来的，不是他本人刚说的话。',
    '自己判断要不要接手；做就做完，做完把结论落盘。',
    '台账 key：' + rec.key,
  ].filter(Boolean).join('\n');
}

/**
 * 台账 —— 一份独立文件。
 *
 * ★ 原子写：先写 .tmp 再 rename。中途崩掉留半截 JSON 等于把整本账读坏。
 * ★★ 但 Windows 上 rename 覆盖已存在的目标会偶发 EPERM（杀软扫描、文件句柄未放），
 *   不是每次都成功 —— 老版实测踩到过。所以留一条回退：直写。
 *   回退的代价是这一次不原子（极小概率留半截）；
 *   不回退的代价是台账**长时间停止更新**，而一个不更新的台账比一次非原子写坏得多。
 */
export class Ledger {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, updatedAt: new Date().toISOString(), events: [] };
    this.#load();
  }

  #load() {
    let raw;
    try { raw = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    let obj;
    try { obj = JSON.parse(raw); } catch { return; }
    const arr = Array.isArray(obj) ? obj : (obj && Array.isArray(obj.events) ? obj.events : []);
    this.data = {
      version: 1,
      updatedAt: (obj && obj.updatedAt) || new Date().toISOString(),
      events: arr.map(normalizeRecord),
    };
  }

  #save() {
    this.data.updatedAt = new Date().toISOString();
    const text = JSON.stringify(this.data, null, 1);
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      // ★ 回退：直写。见类注释。
      try { fs.writeFileSync(this.file, text, 'utf8'); return true; } catch { return false; }
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* 已经 rename 走了 */ }
    }
  }

  get events() { return this.data.events; }

  /** 按 key 查 */
  find(key) { return this.data.events.find(x => x.key === key) || null; }

  /**
   * 收一条事件进台账。
   * ★ 幂等：同一个 key 只收一次（事件队列可能重复投递）。
   */
  ingest(ev) {
    const key = String((ev && ev.key) || '');
    if (!key) return { ok: false, err: '缺 key' };
    if (this.find(key)) return { ok: false, err: '已经在台账里', dup: true };
    const rec = normalizeRecord({
      key,
      t: (ev && ev.t) || new Date().toISOString(),
      title: (ev && ev.title) || '',
      from: (ev && ev.from) || '',
      tier: (ev && ev.tier) || '',
      fromSession: (ev && ev.fromSession) || '',
      stage: 'pending',
    });
    this.data.events.push(rec);
    this.#save();
    return { ok: true, record: rec };
  }

  /** 标记「已经叫过了」。★ wakeCount 到 3 判 stuck —— 老版：没有间隔会把 30 秒一 tick 的轮询
   *  在 1.5 分钟内推到 3、当场判死，那等于「开机就判死」，stuck 会失去意义。 */
  markWoken(key, maxWake) {
    const ev = this.find(key);
    if (!ev) return { ok: false, err: '台账里没有这条 key' };
    ev.wakeCount++;
    ev.wokenAt = Date.now();
    ev.stage = ev.wakeCount >= (maxWake || 3) ? 'stuck' : 'woken';
    this.#save();
    return { ok: true, event: ev };
  }

  /** 写判定 */
  decide(key, patch) {
    const r = applyDecision(this.data, key, patch);
    if (r.ok) this.#save();
    return r;
  }

  /** 四视图 + 徽章 */
  views() {
    const v = viewsOf(this.data.events);
    return { ...v, badge: badgeOf(v) };
  }
}