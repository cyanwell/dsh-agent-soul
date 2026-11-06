// 日记 —— 把一个目录里的 markdown 递出去。
//
// ★ 为什么这个东西在新软件里还留着：
//   日记不是「某个插件给宿主加的面板」，它是**一手层的一部分** ——
//   和《墨》、和会话日志同级的原始材料。所以它该被这个软件自己的界面看见，
//   而不是靠某个宿主的插件槽位。
//
// ★★ 从老版搬过来的三条，每一条都是它踩过的坑：
//
//   ① 防目录穿越（safeName）—— 文件名要塞进 URL 查询串，
//      只接受「纯文件名 + .md」，不许带分隔符、不许 ..、不许绝对路径。
//
//   ② 标题从前 2KB 抠 —— 不必整篇读。一篇几十 KB 的日记，
//      为了一个标题全量读盘是浪费。
//
//   ③ 目录不存在时给一句**可执行的**提示，不静默返回空。
//      老版的原注释写着：「原来默认 join(process.cwd(), 'diary') —— 进程的 cwd 是安装目录，
//      那底下没有 diary/，于是 /api/list 静默返回 []，界面写「还没有日记。」
//      **装上、界面在、里面空的** —— 这正是要治的那个形状。」
//      ★ 这句话值得原样留着：**空列表和读不到是两件事**，界面上必须能分开。

import fs from 'node:fs';
import path from 'node:path';

export class Diary {
  /**
   * @param {string|null} dir 日记目录。null = 没配
   */
  constructor(dir, opts = {}) {
    this.dir = dir || null;
    this.maxSnippet = opts.maxSnippet || 200;
  }

  /**
   * 目录状态 —— 界面靠这个区分「没配」「配了但不存在」「读不了」「空的」「有东西」。
   * ★ 五种状态必须分得开，否则用户永远在猜「为什么是空的」。
   */
  state() {
    if (!this.dir) {
      return { ok: false, code: 'UNCONFIGURED', dir: null,
        hint: '还没配日记目录。在 config.json 里写 diary.dir = "<放 *.md 的目录>"，然后重启。' };
    }
    let st;
    try { st = fs.statSync(this.dir); }
    catch {
      return { ok: false, code: 'MISSING', dir: this.dir,
        hint: '配置里的目录不存在：' + this.dir + '。改 config.json 的 diary.dir，或把日记放进那个位置。' };
    }
    if (!st.isDirectory()) {
      return { ok: false, code: 'NOT_DIR', dir: this.dir, hint: '配置的路径是一个文件，不是目录：' + this.dir };
    }
    return { ok: true, code: 'OK', dir: this.dir };
  }

  /** 列目录。返回 { state, entries } —— 永远两个都给，界面自己决定怎么显示。 */
  list() {
    const s = this.state();
    if (!s.ok) return { state: s, entries: [] };

    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => /\.md$/i.test(n)); }
    catch (e) {
      return { state: { ...s, ok: false, code: 'UNREADABLE', hint: '目录读不了：' + (e && e.message) }, entries: [] };
    }

    const entries = [];
    for (const name of names) {
      const full = path.join(this.dir, name);
      let size = 0, mtime = 0, title = name.replace(/\.md$/i, '');
      try {
        const st = fs.statSync(full);
        size = st.size;
        mtime = st.mtimeMs;
        // ② 只读前 2KB 找标题
        const head = fs.readFileSync(full, 'utf8').slice(0, 2048);
        const m = head.match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m);
        if (m) title = m[1].trim();
      } catch { /* 单篇读不了就跳过它的标题，不让整次列目录失败 */ }
      entries.push({ name, title, size, mtime });
    }
    // 新的在前
    entries.sort((a, b) => b.mtime - a.mtime);
    return { state: s, entries };
  }

  /**
   * 读一篇。
   * ★ 返回值区分三种失败：没配 / 名字不合法 / 文件不存在。
   *   三种都要能说清，不能都变成「读不到」。
   */
  read(rawName) {
    const s = this.state();
    if (!s.ok) return { ok: false, code: s.code, hint: s.hint };

    const name = safeName(rawName);
    if (!name) {
      return { ok: false, code: 'BAD_NAME',
        hint: '文件名不合法：只接受「纯名字 + .md」，不许带路径分隔符或 ..（这是防目录穿越）' };
    }

    const full = path.join(this.dir, name);
    // 纵深防御：即使 safeName 被绕过，也只能落在日记目录里
    const rel = path.relative(this.dir, full);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      return { ok: false, code: 'ESCAPE', hint: '拒绝读取日记目录之外的路径' };
    }

    try {
      const text = fs.readFileSync(full, 'utf8');
      const st = fs.statSync(full);
      const m = text.slice(0, 2048).match(/^[ \t]*#[ \t]+(.+?)[ \t]*$/m);
      return { ok: true, name, title: m ? m[1].trim() : name.replace(/\.md$/i, ''), text, size: st.size, mtime: st.mtimeMs };
    } catch (e) {
      const code = (e && e.code) === 'ENOENT' ? 'NOT_FOUND' : 'READ_FAIL';
      return { ok: false, code, hint: code === 'NOT_FOUND' ? '这个文件不在日记目录里：' + name : '读取失败：' + (e && e.message) };
    }
  }
}

/** ① 防目录穿越。只收「纯文件名 + .md」。 */
export function safeName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  if (s.includes('/') || s.includes('\\') || s.includes('..')) return '';
  if (!/\.md$/i.test(s)) return '';
  // 再加一层：Windows 上还有 : 和通配符
  if (/[:*?"<>|]/.test(s)) return '';
  return s;
}
