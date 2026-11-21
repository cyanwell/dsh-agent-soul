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
 * 这一行是不是**导入**来的历史行（不是本机写入的现在）。
 *
 * ★ 为什么账本里也要认这件事：导入（JSONL → SQLite / 反过来）搬的是**历史**。
 *   历史里当然有 lead，但「谁是当前主导」问的是现在 —— 一次导入不该换届。
 *   判据只认显式溯源标记，不从 by / t 猜：
 *     · import_batch_id / importBatchId —— 导入器写的批次号；
 *     · legacy_line          —— 源文件物理行号，只有导入行才有。
 *   两个都没有 = 本机写入的行，照旧参与判定。
 */
export function isImportedRow(row) {
  if (!row || typeof row !== 'object') return false;
  for (const key of ['import_batch_id', 'importBatchId']) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== null && row[key] !== undefined) return true;
  }
  for (const key of ['legacy_line', 'legacyLine']) {
    if (Object.prototype.hasOwnProperty.call(row, key) && row[key] !== null && row[key] !== undefined) return true;
  }
  return false;
}

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
    // ★★ 2026-11-17：墨的权威改到 SQLite（mo_ledger）。
    //   store 给了就走库，没给就还是读 JSONL —— **增量，不是替换**。
    //   为什么保留 JSONL 这一路：测试、导入器、以及「库还没建好」的启动早期
    //   都还在用文件；把它们一起改掉的风险远大于收益。
    //   ★ 降级必须留痕：走库失败时不会假装成功，而是写一行 warn 再抛给调用方。
    this.store = opts.store || null;
    // 走库时必须有完整会话 id（actor_session 不接受 8 位短 id）。
    this.sessionId = opts.sessionId || '';
    // 降级记录：和墨放同一个目录，只追加。过渡期结束随文件一起退役。
    this.degradeFile = opts.degradeFile || (file ? path.join(path.dirname(file), 'ledger-degrade.jsonl') : null);
    // 没给 onDegrade 也要留痕 —— 不许「配置没到位 = 这次失败就此消失」。
    this.onDegrade = typeof opts.onDegrade === 'function' ? opts.onDegrade : (detail) => {
      if (!this.degradeFile) return;
      try {
        fs.mkdirSync(path.dirname(this.degradeFile), { recursive: true });
        fs.appendFileSync(this.degradeFile, JSON.stringify({ at: new Date().toISOString(), ...detail }) + '\n', 'utf8');
      } catch { /* 留痕本身失败也不能让墨写不进去 */ }
    };
    this.lastReadBackend = null;
  }

  /** 库是否可能落后于文件（最近一次库写失败发生在库最新一行之后）。
   *  ★ 为什么要这个：过渡期是双写，库写失败时文件仍然成功。
   *    此时若照旧「读库」，那一行墨就凭空消失了 —— 而且没人会知道。
   *    判据只看时间顺序，不看数量：降级记录比库里最新一行更晚 ⇒ 库可能少行。
   */
  storeMayLag() {
    if (!this.store) return false;
    try {
      const last = this.store.listLedger({ limit: 1 });
      const lastT = last.length ? String(last[0].t || '') : '';
      const degrade = this.readLastDegrade();
      if (!degrade) return false;
      if (!lastT) return true;
      return String(degrade.at || '') >= lastT;
    } catch {
      // 连库都读不出来 —— 那就当它落后，走文件，别让墨读不出来。
      return true;
    }
  }

  /** 最后一条降级记录（没有就 null）。文件本身不存在也返回 null。 */
  readLastDegrade() {
    if (!this.degradeFile) return null;
    try {
      const raw = fs.readFileSync(this.degradeFile, 'utf8');
      const lines = raw.split('\n').filter((l) => l.trim());
      if (!lines.length) return null;
      return JSON.parse(lines[lines.length - 1]);
    } catch { return null; }
  }

  /** 库里的行 → 账本行形状（t/type/by/text/ref/feel），让消费方零改动。 */
  #fromStore(row) {
    const o = { t: row.t, type: row.type, by: row.by, text: row.text };
    if (row.ref != null) o.ref = row.ref;
    if (row.feel != null) o.feel = row.feel;
    if (row.by_user) o.byUser = true;
    if (row.importBatchId != null) o.importBatchId = row.importBatchId;
    if (row.legacyLine != null) o.legacyLine = row.legacyLine;
    return o;
  }

  /** 读全部记录。有 store 读库（权威）；库可能落后时退回文件（并告知调用方）。 */
  all() {
    if (this.store && !this.storeMayLag()) {
      // ★★ 必须显式要全量：listLedger 的默认 limit 是 50，
      //   照默认调会静默只读到最近 50 行 —— 于是 stats() 数出来是 50、
      //   currentLead() 会读到「50 行里最老的那条 lead」，把当前主导判成别人。
      //   （2026-11-17 实测：库里 787 行，默认调用只回 50 行，lead 被判成第 10 代。）
      //   这里用足够大的上限并断言拿全了；拿不全就说明库那边还有别的限制，不能当作读全。
      // ★ 必须走 listLedgerAll：面向界面的 listLedger 把 limit 钳在 500，
      //   拿它当「全部」会静默截断（787 行只读到 500 行，当前主导就判错了）。
      const rows = typeof this.store.listLedgerAll === 'function'
        ? this.store.listLedgerAll({})
        : this.store.listLedger({ limit: 500 });
      this.lastReadBackend = typeof this.store.listLedgerAll === 'function' ? 'sqlite' : 'sqlite-partial';
      return rows.map((r) => this.#fromStore(r));
    }
    if (this.store && this.storeMayLag()) {
      // ★ 库落后 → 走文件。这不是「降级到更差的东西」：
      //   过渡期两份都是真的，文件那份反而更全（它先写且从不失败）。
      this.lastReadBackend = 'jsonl-fallback';
    } else {
      this.lastReadBackend = 'jsonl';
    }
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
    // ★ 跳过导入行：历史里的 lead 是沿革，不是「现在」。见 isImportedRow()。
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].type !== 'lead') continue;
      if (isImportedRow(rows[i])) continue;
      return String(rows[i].by || '');
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

    // ★★★ 过渡期：**双写**（爀曦 2026-11-17 确认）。
    //   ① 文件先写 —— 它永远成功，是墨不丢的底线；
    //   ② 库随后写 —— 它现在是读的权威面，也是将来要留下的那一个。
    //   等库稳定跑过一段时间，再退役文件（届时它降级成只读档案）。
    //
    // ★ 三条不许：
    //   · 不许因为「库写失败」就返回失败 —— 那是拿墨的可用性换库的整洁，方向反了；
    //   · 不许偷偷只有一边成功却当成全成功 —— 必须留痕（onDegrade）；
    //   · 不许用 8 位 by 去凑 actor_session —— 凑出来的 identity 会让「谁是当前主导」比错。
    //     拿不到完整 sessionId 时，库这一路**跳过并记一笔**，文件照写。
    const writeFile = () => {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n', 'utf8');
      if (this.mem) this.mem = null;       // 失效缓存
    };

    if (!this.store) { writeFile(); return { ok: true, row, file: this.file, backend: 'jsonl' }; }

    // ★★ lead 的顺序是反的：**库先写、文件后写**。
    //   库对 lead 有三道闸门（完整 sessionId / 世代自述 / 必须带 ref），
    //   它们当场就能报错。若先写文件，用户会拿到「文件里有、库里没有」的分叉 ——
    //   而换届恰恰是最不能分叉的那种行。所以 lead 让库先判：
    //   库拒绝 = 整条拒绝，文件一个字都不落。
    const isLead = type === 'lead';
    const bySession = String(this.sessionId || '').trim();
    if (!bySession) {
      if (isLead) {
        return { ok: false, code: 'NO_SESSION', message: '换届必须能落库：缺完整会话 id（actor_session）。文件未写，避免两边分叉' };
      }
      writeFile();
      const detail = { code: 'NO_SESSION', message: '只有 8 位 by，无法写 actor_session：库这一路已跳过，文件已写入', row };
      if (this.onDegrade) this.onDegrade(detail);
      return { ok: true, row, file: this.file, backend: 'jsonl', storeSkipped: 'NO_SESSION' };
    }
    if (!isLead) writeFile();   // 非 lead：文件先落，底线优先
    try {
      const res = this.store.appendLedger(
        { type, text: body, t: row.t, ref: row.ref, feel: row.feel, byUser: true },
        { sessionId: bySession },
      );
      row.rowId = res.rowId;
      if (isLead) writeFile();   // lead：库成功了才补写文件
      return { ok: true, row, file: this.file, backend: 'sqlite+jsonl' };
    } catch (err) {
      const detail = {
        code: (err && err.code) || 'STORE_WRITE_FAILED',
        message: String((err && err.message) || err).slice(0, 300),
        row,
      };
      if (isLead) {
        // ★ lead：库拒绝就整条拒绝。文件没写过，两边不会分叉。
        if (this.onDegrade) this.onDegrade(detail);
        return { ok: false, code: detail.code, message: detail.message };
      }
      // 非 lead：文件那一路已经成功，所以这里**不是**失败；但必须让它看得见。
      if (this.onDegrade) this.onDegrade(detail);
      return { ok: true, row, file: this.file, backend: 'jsonl', storeError: detail.code + ': ' + detail.message };
    }
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
