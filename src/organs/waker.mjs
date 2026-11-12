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
// ★ 2026-11-10 第三轮（独立验收 P2）：台账是**落盘**的自由文本写入点 ——
//   key / title / charterNote / note 都是调用方可控的。脱敏放在 normalizeRecord
//   这个唯一收口上，新加的写入者不可能"忘记调"（调用点各写一遍才是漏的来源）。
//   ★ 方向：organ → organ，guard.mjs 不 import 任何东西，没有环。
import { redactBody } from './guard.mjs';

/** 状态机的合法取值。★ 严格校验的理由：台账是给人看的状态，
 *  一个拼错的 stage 会让这条事件在五个视图里全部消失 —— 消失比报错更坏。
 *
 *  ★ 2026-11-10 F1：**'blocked' 原本不在表里**，而 guard.deliverPanelNotice 早就在传
 *  stage:'blocked'。两道闸叠在一起把这条状态吃掉：
 *    ① ingest() 硬编码 stage:'pending'（连传都没传下来）；
 *    ② 就算传下来，normalizeRecord 也会因为 STAGES 里没有 'blocked' 把它回落成 pending。
 *  于是「被宪章拦下」在磁盘上永远写成「待处理」—— 而下面这两处**早就按 'blocked' 读了**：
 *    · src/web/server.mjs:807  const blocked = evs.filter(x => stage(x) === 'blocked')
 *    · src/web/dashboard.html  「被拦下 N 条 · 入账但不叫你」「被宪章拦下」
 *  也就是说仪表盘上那个计数一直是**死读数**（恒 0，并被算进「待处理」）。
 *  补进白名单不是新立一套语义，是让既有的读法终于读得到东西。 */
export const STAGES = ['pending', 'woken', 'decided', 'done', 'held', 'auditing', 'stuck', 'blocked'];
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
    // ★ 先脱敏、再截断（顺序反了截断点会把 JSON 切坏，反而绕过结构脱敏）。
    key: redactBody(String(r.key || '')),
    t: String(r.t || ''),
    title: redactBody(String(r.title || '')).slice(0, 200),
    from: String(r.from || ''),
    tier: String(r.tier || ''),
    stage: STAGES.includes(r.stage) ? r.stage : 'pending',
    wakeCount: Number.isFinite(r.wakeCount) ? Math.max(0, Math.floor(r.wakeCount)) : 0,
    wokenAt: Number.isFinite(r.wokenAt) ? r.wokenAt : null,
    decision: DECISIONS.includes(r.decision) ? r.decision : null,
    // ★★ 关键一行：不合法/缺失一律回落 unchecked，绝不回落 pass
    charter: CHARTERS.includes(r.charter) ? r.charter : 'unchecked',
    charterNote: redactBody(String(r.charterNote || '')).slice(0, 300),
    decidedAt: Number.isFinite(r.decidedAt) ? r.decidedAt : null,
    note: redactBody(String(r.note || '')).slice(0, 600),
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
  if (patch.charterNote !== undefined && patch.charterNote !== null) ev.charterNote = redactBody(String(patch.charterNote)).slice(0, 300);
  if (patch.note !== undefined && patch.note !== null) ev.note = redactBody(String(patch.note)).slice(0, 600);
  ev.decidedAt = Date.now();
  ev.stage = STAGE_BY_DECISION[decision];
  return { ok: true, event: ev };
}

/**
 * 五类视图。一条事件可以同时出现在两个视图里 ——
 * 「你已执行」问的是「做完了什么」，「你自己决定做的」问的是「谁拍的主意」，
 * 这是两个问题，重叠是设计，不是 bug。
 *
 * ★ 2026-11-10 F1 新增第五个视图 'blocked'（被宪章拦下、入账但不叫你）。
 *   **为什么不塞进 act / audit / done：**
 *     · act   = 「等你动手」，而 blocked 是**不用你动手**（guard 已经判完）；
 *     · audit = 「要审计但没审」，badge 会把它算成未处理 —— 等于**重新拿叫醒当催办**；
 *     · done  = 「你已执行 / 你拍的板」，blocked **没有人拍过板**，是 guard 拦的，
 *               混进去会让「已执行」这个数说谎（面板上那一行写的就是「已执行」）。
 *   所以给它自己的名字。它与 dashboard 上「被拦下」那条读数**同一个判据**
 *   （原始 stage），两处不会各漂各的。
 */
export function viewsOf(events) {
  const act = [], done = [], audit = [], auto = [], blocked = [];
  for (const ev of events) {
    if (ev.stage === 'woken' && !ev.decision) act.push(ev);
    if (ev.decision === 'resume') done.push(ev);
    // ★ stuck 归进「要审计但没审」：严格按判据它会在界面上彻底消失，
    //   而「叫不醒」恰恰是最不该消失的一种，所以显式收进来。
    if (ev.decision === 'audit' || ev.charter === 'ask' || ev.stage === 'stuck') audit.push(ev);
    if (ev.decision && ev.charter === 'pass') auto.push(ev);
    if (ev.stage === 'blocked') blocked.push(ev);
  }
  // 时间倒序（新的在前）。t 是 ISO 串，直接比字符串即可；空 t 沉底。
  const byT = (a, b) => String(b.t || '').localeCompare(String(a.t || ''));
  act.sort(byT); done.sort(byT); audit.sort(byT); auto.sort(byT); blocked.sort(byT);
  return { act, done, audit, auto, blocked };
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
  /**
   * @param {string} file
   * @param {{readOnly?:boolean}} [opts]
   *   ★ 2026-11-10（三项死读数修复之二）：`readOnly:true` 用来**只读地打开权威台账**
   *   （`<状态目录>/lead-waker-台账.json`）。读它是本次修复要求的；写它**不在**本次范围。
   *   没有这道闸，「读一遍真台账」和「顺手把真台账重写一遍」在代码上只差一次方法调用 ——
   *   而这个类的 #save() 会把整份文件按 normalizeRecord 重写（会丢掉白名单外的字段）。
   */
  constructor(file, opts) {
    this.file = file;
    this.readOnly = !!((opts || {}).readOnly);
    this.loadedAtMs = Date.now();
    this.data = { version: 1, updatedAt: new Date().toISOString(), events: [] };
    this.#load();
  }

  /** 只读实例的拒写出口。★ 拒得**响亮**，不静默失败。 */
  #refuse() { return { ok: false, err: '只读实例：这个 Ledger 用来读权威台账，不允许写（写路径要另选一份文件）' }; }

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
    if (this.readOnly) return false;   // 最后一道闸：任何路径都别想碰只读台账
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
   *
   * ★★ 2026-11-10 F1（独立验收留的真缺陷）：**以前这里只挑 7 个字段，
   *   并把 stage 硬编码成 'pending'。** guard.deliverPanelNotice 传下来的
   *   stage:'blocked' / charter:'block' / charterNote 三个**全被丢掉** ——
   *   磁盘写成 pending/unchecked，四视图里看不见，charterNote（脱敏后的理由）也没了。
   *   第九轮报告说「block 的台账 stage=blocked」，那是**假 waker 记的入参**，不是落盘值。
   *
   *   现在：**白名单内的状态字段原样收下**，校验仍只有 normalizeRecord 一处收口
   *   （枚举不合法 → pending / unchecked / null；长度截断；脱敏）。所以
   *   「任意调用方能不能伪造非法状态」的答案没变：**能进来的永远只是合法枚举值**。
   *   而能传这些字段的只有**进程内**调用者 —— soul_waker 的 ingest 分支只传
   *   key/t/title/from/tier（adapters/mcp-tools.mjs:719），外部入口拿不到这一层。
   *
   *   ★ 同源约束（随本次一并加上）：decision 与 stage 必须对得上（STAGE_BY_DECISION）。
   *   只给 decision 就按那张表补 stage；两个都给了却互相矛盾
   *   （例：stage:'blocked' + decision:'resume'）→ **拒收**，不落一条自相矛盾的账。
   *   理由：那种记录会同时掉进两个语义相反的视图 —— 消失比报错更坏，**自相矛盾更坏**。
   */
  ingest(ev) {
    if (this.readOnly) return this.#refuse();
    const e = ev && typeof ev === 'object' ? ev : {};
    const key = String(e.key || '');
    if (!key) return { ok: false, err: '缺 key' };
    if (this.find(key)) return { ok: false, err: '已经在台账里', dup: true };

    const decision = DECISIONS.includes(e.decision) ? e.decision : null;
    const stageGiven = STAGES.includes(e.stage) ? e.stage : null;
    const stageImplied = decision ? STAGE_BY_DECISION[decision] : null;
    if (decision && stageGiven && stageGiven !== stageImplied) {
      return { ok: false, err: 'stage 与 decision 对不上：' + stageGiven + ' / ' + decision + '（判定只能是 ' + stageImplied + '）' };
    }

    const rec = normalizeRecord({
      key,
      t: e.t || new Date().toISOString(),
      title: e.title || '',
      from: e.from || '',
      tier: e.tier || '',
      fromSession: e.fromSession || '',
      // ★ 缺省才回落：不给 stage → pending；不给 charter → unchecked（绝不 pass）。
      stage: stageGiven || stageImplied || 'pending',
      charter: e.charter,
      charterNote: e.charterNote,
      decision,
      decidedAt: e.decidedAt,
    });
    this.data.events.push(rec);
    this.#save();
    return { ok: true, record: rec };
  }

  /** 标记「已经叫过了」。★ wakeCount 到 3 判 stuck —— 老版：没有间隔会把 30 秒一 tick 的轮询
   *  在 1.5 分钟内推到 3、当场判死，那等于「开机就判死」，stuck 会失去意义。 */
  markWoken(key, maxWake) {
    if (this.readOnly) return this.#refuse();
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
    if (this.readOnly) return this.#refuse();
    const r = applyDecision(this.data, key, patch);
    if (r.ok) this.#save();
    return r;
  }

  /** 五视图 + 徽章（★ blocked 只出现在自己的视图里；badge 仍然只数 act ∪ audit） */
  views() {
    const v = viewsOf(this.data.events);
    return { ...v, badge: badgeOf(v) };
  }
}