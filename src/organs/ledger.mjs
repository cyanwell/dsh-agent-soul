// 账本（墨）—— 只追加 + 代码级闸门
//
// ★ 为什么是**只追加**，不是一个共享可变文件：
//   多写者环境里，共享可变文件是万恶之源 —— 老项目实测踩过：
//   `edit` 用原子写入（写临时文件再改名）打断硬链接，于是「我改了源、副本没变，
//   而两个都叫我的名字」。同样的形状在多人同时编辑一个 JSON 上会重演。
//   **只追加的日志不需要锁**：各写各的行，读的时候按时间合并。
//   ★ 现成的证据：661 个会话各自往自己的 jsonl 追加，从来没有冲突过。
//
// ★★ 权限闸门写在代码里，不写在约定里：
//   `写 promise 需要先署过 lead，否则拒绝`。
//   设计意图：**不依赖「它记得不要写」，而依赖「它写不进去」。
//   约定会失效，闸门不会。**
//   ★ 老版是 `process.exit(3)`；新软件是库不是 CLI，所以返回 { ok:false, code:'NOT_BRAIN' }。
//     判据一致：**拒绝就是拒绝，调用方拿不到 content**。
//
// ★ 八类 + lead。为什么 `lead` 单独算一类：
//   它不记「发生了什么」，它记「**现在哪个容器持主导权**」。
//   只追加 ⇒ 凭据写进去就改不了；换届 = 新会话写一条 lead，旧的自然被盖过。

import fs from 'node:fs';
import path from 'node:path';

export const TYPES = ['lead', 'promise', 'fact', 'shelved', 'gain', 'loss', 'persona', 'container'];

export const LABEL = {
  lead: '主导', promise: '承诺', fact: '事实', shelved: '搁置',
  gain: '得', loss: '失', persona: '人格', container: '容器',
};

/** 只有主导会话（脑）能写的类型 */
export const BRAIN_ONLY = ['promise'];

/**
 * 会话 id 归一化。
 * ★ 老项目实测：**两种 id 格式并存** —— 主导会话是 `session-03ee7b55-…`（带前缀），
 *   子会话是 `9b8f7775-ca9a-42…`（**不带**）。要互相比较就必须先归一化。
 *   拿不到 8 位就原样返回，绝不返回空串冒充。
 */
export function normId(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return '';
  return (s.startsWith('session-') ? s.slice(8) : s).slice(0, 8);
}

/** 本地时间的 ISO（带 +08:00 这种偏移），不依赖 Intl 的时区库 */
export function localIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = p(Math.floor(Math.abs(off) / 60)), om = p(Math.abs(off) % 60);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + sign + oh + ':' + om;
}

export class LedgerBase {
  /**
   * @param {string} file ledger.jsonl 的路径
   * @param {{ now?: () => Date }} opts
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.now = opts.now || (() => new Date());
    this.mem = null;      // 读缓存：{ size, mtime, rows }
  }

  /** 读全部记录。文件变过就重读，没变就用缓存。 */
  all() {
    let st = null;
    try { st = fs.statSync(this.file); } catch { return []; }
    const key = st.size + ':' + st.mtimeMs;
    if (this.mem && this.mem.key === key) return this.mem.rows;
    const rows = [];
    const raw = fs.readFileSync(this.file, 'utf8');
    for (const line of raw.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { const o = JSON.parse(s); if (o && o.type) rows.push(o); } catch { /* 坏行跳过，不因此读不出别的 */ }
    }
    this.mem = { key, rows };
    return rows;
  }

  /**
   * 当前主导者 = **最后一条 `lead` 的 by**。
   * ★ 为什么不用令牌文件：那正是要被废掉的东西。账本是只追加的 ——
   *   凭据一旦写进去就改不了，比一个可以被随手编辑的 JSON 更硬。
   */
  currentLead() {
    const rows = this.all();
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].type === 'lead') return String(rows[i].by || '');
    }
    return '';
  }

  /** 本会话是不是脑。判据是纯代码，不靠会话自律。 */
  isBrain(sessionId) {
    const lead = normId(this.currentLead());
    const me = normId(sessionId);
    return Boolean(lead && me && lead === me);
  }

  /**
   * 写一条。
   * @returns {{ok:true, row:object, file:string} | {ok:false, code:string, message:string}}
   */
  write({ type, text, by, ref, feel }) {
    if (!TYPES.includes(type)) {
      return { ok: false, code: 'BAD_TYPE', message: '未知类型「' + type + '」，可选：' + TYPES.join(' / ') };
    }
    const body = String(text == null ? '' : text).trim();
    if (!body) return { ok: false, code: 'EMPTY', message: '内容不能为空' };

    const who = String(by == null ? '' : by).trim();
    if (!who) return { ok: false, code: 'NO_AUTHOR', message: '必须知道是谁写的（by 不能为空）' };

    // ★★ 闸门：promise 只有脑能写。
    //    判据用**归一化后**的 id 比较 —— 老项目就是因为两种 id 格式并存踩过。
    if (BRAIN_ONLY.includes(type) && !this.isBrain(who)) {
      const lead = this.currentLead();
      return {
        ok: false,
        code: 'NOT_BRAIN',
        message: '「' + LABEL[type] + '」只有主导会话能写。当前主导是 ' +
          (lead ? normId(lead) : '（还没有人写过 lead）') + '，你是 ' + normId(who) + '。',
      };
    }

    const row = {
      t: localIso(this.now()),
      type,
      by: who,
      text: body,
    };
    if (ref) row.ref = String(ref);
    if (feel) row.feel = String(feel);   // 一手：当时的感受，可缺省

    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf8');
    if (this.mem) this.mem = null;       // 失效缓存
    return { ok: true, row, file: this.file };
  }

  /** 读。默认倒序（最近的在前）。 */
  list({ type = null, limit = 20, since = null } = {}) {
    let rows = this.all();
    if (type) rows = rows.filter((r) => r.type === type);
    if (since) rows = rows.filter((r) => String(r.t) >= String(since));
    return rows.slice(-limit).reverse();
  }

  /** 按类型计数 + 未结的承诺与搁置 */
  stats() {
    const rows = this.all();
    const byType = {};
    for (const t of TYPES) byType[t] = 0;
    for (const r of rows) if (byType[r.type] !== undefined) byType[r.type]++;
    const lead = this.currentLead();
    return {
      total: rows.length,
      byType,
      lead: lead || null,
      leadNorm: lead ? normId(lead) : null,
      first: rows.length ? rows[0].t : null,
      last: rows.length ? rows[rows.length - 1].t : null,
    };
  }
}
