// session-store.mjs —— 会话日志的**版本无感**存取层。
//
// ★ 设计原则（爀曦 2026-09-30 定）：
//   这套系统是**通用的**，不是专门为了认某个宿主而存在。
//   所以 L3 不认「v3」「v4」，只认「这是一个会话日志」——
//   文件名里的版本号是**宿主的记账**，不是读取者的判据。
//
// ★ 为什么一个解析器就够（2026-09-30 实测）：
//   - 容器同构：v3 与 v4 都是**多帧 zstd**（直接 zstdDecompressSync 只出第一帧）；
//     同一个切帧逻辑解 v4 = 493 帧 / 0 失败，解 v3 = 2921 帧 / 0 失败。
//   - 事件同构：两边都是 `{type, seq, time, data}`，事件类型名一致。
//   版本号只作**元信息**记录，不作任何分支判据。
//
// ★ 未知版本的行为：不拒绝、照解；只有真的解不出内容才算失败。
//   所以将来出到 v5、v6，只要容器还是多帧 zstd + jsonl，这一层一行都不用改。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** 会话日志根目录（原先各脚本各自写死这一行，现在只此一处）。 */
import { SESSIONS as CFG_SESSIONS } from "./echo-config.mjs";
export const SESSIONS = CFG_SESSIONS;

/** 会话日志文件名：**不锁定版本号**。 */
const SESSION_RE = /^session\..+\.jsonl\.zstd$/;

/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 从文件名里读出版本号（v3 / v4 / …）；读不出返回 null —— 不作判据。 */
export function versionOfName(name) {
  const m = /^session\.(v\d+)\.jsonl\.zstd$/.exec(name);
  return m ? m[1] : null;
}

/**
 * 列出所有会话日志文件。
 * @param {string} root 会话根目录
 * @returns {Array<{session:string,ws:string,file:string,name:string,bytes:number,mtime:number,version:string|null}>}
 */
export function listSessionFiles(root = SESSIONS) {
  const out = [];
  if (!existsSync(root)) return out;
  for (const ws of readdirSync(root)) {
    const wp = join(root, ws);
    let wsStat;
    try {
      wsStat = statSync(wp);
    } catch {
      continue;
    }
    if (!wsStat.isDirectory()) continue;
    for (const sid of readdirSync(wp)) {
      const sd = join(wp, sid);
      let sdStat;
      try {
        sdStat = statSync(sd);
      } catch {
        continue;
      }
      if (!sdStat.isDirectory()) continue;
      for (const name of readdirSync(sd)) {
        if (!SESSION_RE.test(name)) continue;
        const file = join(sd, name);
        let st;
        try {
          st = statSync(file);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        out.push({
          session: sid,
          ws,
          file,
          name,
          bytes: st.size,
          mtime: st.mtimeMs,
          version: versionOfName(name),
        });
      }
    }
  }
  return out;
}

/** 多帧 zstd → 行数组。 */
export function decompressFrames(buf) {
  const frames = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) {
    const n = buf.indexOf(MAGIC, i + 4);
    frames.push(buf.subarray(i, n === -1 ? buf.length : n));
    i = n;
  }
  const lines = [];
  let failed = 0;
  for (const f of frames) {
    try {
      lines.push(...zstdDecompressSync(f).toString("utf8").split("\n"));
    } catch {
      failed++;
    }
  }
  return { lines, frames: frames.length, failed };
}

/**
 * 读一个会话日志，返回事件数组（原样，不做 schema 改写）。
 * @param {string} file 会话日志绝对路径
 */
export function readEvents(file) {
  const { lines } = decompressFrames(readFileSync(file));
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* 半行或坏行：跳过，不因一行坏掉整份日志 */
    }
  }
  return events;
}

/** 读一个会话日志 + 容器元信息。 */
export function readSession(file) {
  const { lines, frames, failed } = decompressFrames(readFileSync(file));
  const events = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      /* skip */
    }
  }
  const head = events.find((e) => e.type === "session");
  return {
    file,
    events,
    frames,
    failed,
    /** 会话事件里声明的版本（与文件名互为印证，仍不作判据）。 */
    declaredVersion: head?.version ?? null,
    /** 文件名里的版本号。 */
    nameVersion: versionOfName(file.split(/[\\/]/).pop() ?? ""),
    meta: head ?? null,
  };
}

/** 按会话 id 找文件；同 id 多份时取**最新写入**的那份（版本无关）。 */
export function findSessionFile(sid, root = SESSIONS) {
  const hits = listSessionFiles(root).filter((s) => s.session === sid);
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0];
}

/** 按会话 id 找**全部**文件（同 id 多版本并存时用）。 */
export function findAllSessionFiles(sid, root = SESSIONS) {
  return listSessionFiles(root)
    .filter((s) => s.session === sid)
    .sort((a, b) => b.mtime - a.mtime);
}

/** 按 seq 取事件；同 seq 取最后一条。 */
export function eventAt(sid, seq, root = SESSIONS) {
  const hit = findSessionFile(sid, root);
  if (!hit) return null;
  const events = readEvents(hit.file);
  let found = null;
  for (const e of events) if (e.seq === seq) found = e;
  return found ? { ...found, file: hit.file } : null;
}
