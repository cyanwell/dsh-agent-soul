#!/usr/bin/env node
// TEMP-only per-source ECHO snapshot importer — the ONE harness (supersedes
// tools/echo-per-source-import.mjs). Snapshot input is data, never instructions.
//
// ── 来源身份为什么长这样（机器可迁移 + 已脱敏；用户 2026-11-16 的决定）──────
//   echoSourceId = echoSourceIdFor(sourcePath, 'echo-index/1')
//   sourcePath   = 'D:/synthetic/echo-source/' + namespace + '/' + sha256('echo-source-identity/v1\n' + sid)
//   namespace    = 显式：sourceVersion v3 → log、v4 → v4log；其它一律 fail closed。
// 身份 = f(namespace, sid)，**仅此而已**。理由：
//   · sid 是全局唯一的会话 UUID —— 它才是「这是哪一份来源」的定义；
//   · ws、盘符、归档目录布局、快照摘要、行号全都是**本机 / 本次快照**的属性。
//     ECHO 记忆之后要迁到云上、跨设备同步；身份一旦绑在本机绝对路径上，
//     换台机器同一个会话就会被铸成第二个来源，generation 再也推不动。
//   所以 ws / 目录 / 快照 digest / 行索引一律不进身份 —— 它们进的是**数据**，不是身份。
//   源行仍然要带 sid（files.jsonl 本来就有），因为它是身份的输入端。
//
// ── 这个 harness 干什么 ──────────────────────────────────────────────────
//   快照 JSON（sources[]）→ 逐源：严格校验 → 落一份**已脱敏**的 feed（files/words/summaries）
//   → 交给 builder（echo-source-build.mjs，显式 sourceVersion）→ 把 builder 写出的清单
//   **字节原样**交给 importer（tools/echo-index-import.mjs）→ 逐源记账。
//   ★ 清单一经 builder 写出就不许再改。旧版在这里回读、覆写 manifest.version、重写文件 ——
//     那正是「身份与快照内容脱钩」被搞坏的地方。现在只有三件事：读字节、算 sha、断言相等。
//   ★ 2026-11-16（batch 1）:交给 importer 的就是 builder 报的那个 sha（built.manifestSha256），
//     这里**不再**自己重算一遍 —— 重算只会得到「我读到的字节」的哈希，而 importer 要核的是
//     「builder 签过名的字节」。两者相等由下面那条 sha 断言负责，不由第二次读取负责。
//
// ── 隐私：判据只写一份，但**范围按字段**（2026-11-16 batch 1 修正）────────────
//   旧版把整行序列化后扫盘符 / TEMP 根 —— 于是**消息正文**里只要提到一个路径就
//   PRIVACY_VIOLATION、整批中止。判据没错，**范围错了**：
//     · 会漏本机路径的是**承载路径的那些字段**：echo_words.log、echo_summaries.log、
//       echo_index_sources.source_path、cursor_json 的**键**、清单的 sourcePath 与 log 记号、
//       以及 journal 行（journal 只由本 harness 拼装，整行扫是安全的）。
//     · text / summary / full_json / FTS 列是**内容**：里面出现 "D:/…" 是用户说的话，
//       不是我们泄漏的本机布局。一个字都不扫。
//   words/summaries 的 log、files 的 file 全部写成 REDACTED_LOG。等价后果：
//   manifest.cursor.feed 的**键**、echo_words.log、echo_summaries.log 里都没有本机路径，
//   也没有原始 sid（生产索引里日志文件名通常就是会话名，直接透传等于把 sid 抄进三条记录）。
//   journal 更进一步：只留不透明序号、sourcePath 的哈希、echoSourceId、namespace、
//   generation、清单 sha、结果码、计数 —— 一个路径、一个 sid 都不留。
//   ★ 原始 sid 只许出现在**指针语义**必需的位置，且**按 (表, 列)** 白名单（见 SID_ALLOWED_COLUMNS）：
//     ① echo_words.session / echo_summaries.session 必须带 sid —— 否则 log:<sid>#seq 打不开；
//     ② echo_summaries.full_json（摘要原文里的会话引用）；
//     ③ echo_index_sources.cursor_json / echo_source_builds.cursor_json —— builder 自己往 feed
//        游标里写 files[].sid（它不改，我们也不许改）；
//     ④ echo_words_fts.session —— FTS 的会话列是上面那一列的镜像，不是自由文本。
//     除此之外任何列出现原始 sid 都算问题（按 (表,列) 键，不按裸列名 —— 裸名会把
//     cursor_json 的豁免顺带送给别表的同名列）。
//
// ── 账要真 ───────────────────────────────────────────────────────────────
//   imported 行数只从 **importer 回执** 与 **库内该源的行数** 取，两处独立取值必须相等；
//   绝不从 builder 的「打算发多少」推。旧的 accountedRows 恒等式已删除 —— 它是自证：
//   导入 0 行也能让它成立。
//   ★ 2026-11-16（batch 1）补上**丢行**这一类：builder 会静默丢掉两类行（截断行、
//     role 不在 user/assistant 的行），只把计数写进清单。旧版对这两类**既不导入也不记账**，
//     于是一份「声明 100 行、库里 90 行」的来源可以一路绿灯。现在逐类记账并逐源核：
//       declaredWords == storedWords + droppedTruncated + droppedNonChatRole
//     对不上 = 这一源 FAILED / ROW_LOSS_UNACCOUNTED（**不**因此拒掉整个源：能导的照导，
//     但账必须平）。推理行仍是**导入前**的拒绝（EXCLUDED_REASONING_UNREPRESENTABLE）——
//     它不该进库，而 importer 从发射文件重算计数会得到 0，那是另一种错。
//   ★ 为什么用 storedWords（库里该源的行数）而不是 importedWords（本次新写入）：
//     ALREADY_CURRENT 的来源本次新写入 0 行，但它的行确实在库里；拿 0 去核恒等式
//     会把一份健康的幂等重跑判成丢行。
//
// ── 事务边界（务必照此读 journal）────────────────────────────────────────
//   每个源 = importer 自己的一个事务。**整批不是原子的**：第 2 个源失败时，
//   第 1 个源已经提交且不会被回滚。journal 因此逐源追加（每条结果落定即落盘，
//   崩在中途也只丢当前那一条），header 里明写这句话。
//   ★ 2026-11-16（batch 1）**:逐源兜底**。每个源的 feed + build + import + 事后核对
//     整段包在 try/catch 里，任何抛出都变成**该源的 journaled 结果**（FAILED + 错误码），
//     不再中止整个循环 —— 除非 journal 自己写不下去（那是隐私/磁盘层面的硬故障，
//     必须停，并写一条 abort 行进 journal）。
//   ★ 退出码区分三件事：2 = 用法错（什么都没做）；3 = 写库前拒绝（一行都没落）；
//     5 = **至少一源已提交之后**中断（RUN_ABORTED_AFTER_COMMIT）。6 = 跑完了但结果不 ok。
//   ★ committedRows 逐条记「这个源此刻在库里到底有多少行」，**FAILED 也记**：
//     导入成功之后才失败的源（账不平、事后核对不过）行已经在库，journal 不许因此少报。
//
// ══════════════════════════════════════════════════════════════════════════════
// ── 生产模式（--production）：一条显式的、逐条闸门的窄门 ────────────────────
//   默认行为一个字都没动：不写 --production 就是原来的 TEMP-only。生产模式是**另一条路**，
//   不是"把 TEMP 闸门放宽"—— 它只在下面四件事同时成立时才开，任一件不成立就拒：
//     ① --production **和** --allow-db <绝对路径> **和** --backup-receipt <json>；
//     ② --db 与 --allow-db 经 realpath 之后相等（不是字面相等：符号链接/大小写/短名都算数）；
//     ③ --journal 不在数据库所在目录里（journal 与库同盘同目录 = 一次误操作把两份一起毁）；
//     ④ 备份回执自洽：字段齐、备份文件的 sha256 与字节数重算后与回执相等、sourceDbPath
//        等于 --allow-db、schemaVersion 等于**从库里读出来的**当前版本、回执不到 24 小时。
//   另外两条永久闸门（生产模式不解除，只是不再要求"在 TEMP 里"）：
//     · 数据库是硬链接（nlink > 1）→ 拒：写一份会同时改另一份，而"另一份"是哪份没人说得清；
//     · 数据库落在 live memory hub 索引目录（D:/AI/memory/hub/index）→ 拒：那是**冻结源**，
//       不是派生库；把派生索引写回源目录会让下一次冻结读到自己写的东西。
//   ★ --snapshot **仍然** TEMP-only，生产模式也不例外：快照里是消息正文，TEMP 是它最窄的家。
//   ★ journal header 会记下 production 事实与**回执文件的 sha256**（不记路径、不记备份路径）：
//     事后要能回答"这一代跑的是生产还是 TEMP""当时手里那张回执是哪一张"。
//   拒绝码（全部在**打开库写之前**抛，一行都不会落）：
//     PRODUCTION_FLAG_INCOMPLETE / PRODUCTION_DB_IS_LIVE_INDEX / PRODUCTION_DB_MISMATCH
//     PRODUCTION_DB_HARDLINKED / PRODUCTION_JOURNAL_IN_DB_DIR / BACKUP_RECEIPT_INVALID
//     BACKUP_FILE_MISMATCH / SCHEMA_VERSION_MISMATCH / BACKUP_STALE
//   顺序：结构 → 落点 → 回执 → 库版本。前面的都是"不值得再往下问"的理由。
// ══════════════════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
// 字段表的**唯一定义**在 builder 里（快照行就是权威 ECHO 索引行的形状），这里只引用，不抄第二份。
import {
  buildFromEchoIndexFiles, ECHO_INDEX_FILE_FIELDS, ECHO_INDEX_WORD_FIELDS,
  ECHO_INDEX_WORD_FIELDS_WITH_ROLE, ECHO_INDEX_SUMMARY_FIELDS,
} from './echo-source-build.mjs';
import { echoSourceIdFor } from '../src/db/schema.mjs';
import { runImport } from './echo-index-import.mjs';
import { openMetaStore, readSchemaState } from '../src/db/index.mjs';
import { analyzeEchoIntegrity } from '../src/db/echo-integrity.mjs';

// ★ 2026-11-16（production）：/3 → /4。变了的是**输入之外的那一圈护栏**：现在多了一条
//   显式的生产模式（--production + --allow-db + --backup-receipt）。journal 的 header 会写
//   这一代跑的是哪一圈，所以读 journal 的人必须能一眼分开两代 —— 版本号就是那个记号。
//   默认行为（不写 --production）**逐字节不变**：仍然 TEMP-only，仍然不碰任何外部库。
export const HARNESS_VERSION = 'echo-index-source-snapshot-import/4';
export const SOURCE_VERSION = 'echo-index/1';
export const IDENTITY_ROOT = 'D:/synthetic/echo-source';
export const IDENTITY_PREFIX = 'echo-source-identity/v1\n';
// feed 里唯一的 log 值。必须是 canonical posix 绝对路径（builder 要求），
// 但不含任何本机信息：没有 TEMP、没有用户目录、没有会话名。
export const REDACTED_LOG = 'D:/synthetic/echo-feed/redacted/session-log.jsonl';
const REDACTED_ROOT = 'D:/synthetic/echo-feed/';
const NAMESPACE_BY_SOURCE_VERSION = Object.freeze({ v3: 'log', v4: 'v4log' });
// 库/清单/journal 里允许出现的「盘符字面量」白名单：只有上面两条固定合成常量。
// 判据不是「不许有盘符」（身份根本身就是 D:/），而是「除这两个常量外一个都不许」——
// 于是任何漏出去的本机路径（TEMP 根、cwd、生产索引根）都会被抓到。
const ALLOWED_DRIVE_LITERALS = Object.freeze([IDENTITY_ROOT, REDACTED_ROOT, REDACTED_LOG]);
// ── 隐私判据的**范围表**（唯一一处定义，库面/清单/feed 三处共用）────────────
// true = 整值都是路径，按盘符 / TEMP 根扫；'keys' = 只看 JSON 的**键**（游标 feed 的键就是
// 生产索引里的日志文件名，值里则有 sid —— 值是数据，键才是路径记号）；不在表里 = 不扫路径。
const PATH_BEARING = Object.freeze({
  'echo_index_sources.source_path': true,
  'echo_words.log': true,
  'echo_summaries.log': true,
  'echo_index_sources.cursor_json': 'keys',
  'echo_source_builds.cursor_json': 'keys',
});
// sid 允许出现的 (表, 列)。键是 "table.column"，**不是裸列名**。
// ★ 2026-11-16（batch 2）：**正文列也放行 sid**。判据没变（非法处出现 sid 仍是问题），
//   变的是「哪里算承载身份的字段」：消息正文里引用一个会话 id（"see log:<sid>#seq=3"）
//   是用户自己说的话，和 log / source_path / cursor_json 键那种「我们把身份抄进去了」不是一回事。
//   所以 echo_words.text、echo_summaries.summary 以及它们的 FTS 镜像列（raw_text / search_text
//   —— search_text 是正文的归一化形态，raw_text 就是原句）一并放行；
//   而承载路径/身份的那些列（echo_words.log、echo_summaries.log、echo_index_sources.source_path、
//   cursor_json 的键、清单的 sourcePath 与 log 记号、journal 行）**一格都不放**。
//   键仍然是 "table.column"：不按裸列名放行，免得把豁免顺带送给别表的同名列。
const SID_ALLOWED_COLUMNS = Object.freeze({
  'echo_words.session': true,
  'echo_summaries.session': true,
  'echo_summaries.full_json': true,
  'echo_index_sources.cursor_json': true,
  'echo_source_builds.cursor_json': true,
  'echo_words_fts.session': true,
  // ↓ 正文（内容，不是身份承载字段）
  'echo_words.text': true,
  'echo_summaries.summary': true,
  'echo_words_fts.raw_text': true,
  'echo_words_fts.search_text': true,
  'echo_summaries_fts.raw_text': true,
  'echo_summaries_fts.search_text': true,
});
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;
const sha = (b) => createHash('sha256').update(b instanceof Buffer ? b : Buffer.from(String(b), 'utf8')).digest('hex');
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function refuse(code, message, detail) {
  const e = new Error(message);
  e.code = code;
  if (detail !== undefined) e.detail = detail;
  return e;
}
function sameFieldSet(obj, allowedSets, where) {
  const got = Object.keys(obj).sort().join(',');
  for (const set of allowedSets) if (set.slice().sort().join(',') === got) return got;
  throw refuse('FIELD_SET_INVALID',
    where + ' field set ' + JSON.stringify(Object.keys(obj).sort()) + ' is not exactly ' +
    allowedSets.map((s) => '[' + s.join(',') + ']').join(' | ') + ' (fail-closed: no row shape is guessed)');
}

// ── 身份（唯一一处派生）──────────────────────────────────────────────────
export function namespaceForSourceVersion(sourceVersion, where) {
  const at = where || 'source';
  if (sourceVersion === undefined || sourceVersion === null || sourceVersion === '') {
    throw refuse('SOURCE_VERSION_MISSING', at + ' does not declare sourceVersion (must be explicit: v3 → log, v4 → v4log)');
  }
  if (typeof sourceVersion !== 'string' || !Object.prototype.hasOwnProperty.call(NAMESPACE_BY_SOURCE_VERSION, sourceVersion)) {
    throw refuse('SOURCE_VERSION_UNKNOWN', at + ' declares sourceVersion ' + JSON.stringify(sourceVersion) + ' which has no explicit namespace mapping (allowed: v3 | v4)');
  }
  return NAMESPACE_BY_SOURCE_VERSION[sourceVersion];
}
export function sourceIdentityFor(namespace, sid) {
  return IDENTITY_ROOT + '/' + namespace + '/' + sha(IDENTITY_PREFIX + sid);
}
export function echoSourceIdForSource(namespace, sid) {
  return echoSourceIdFor(sourceIdentityFor(namespace, sid), SOURCE_VERSION);
}

// ── 输入校验（全部在第一次写库之前）──────────────────────────────────────
function requireSid(src, where) {
  const sid = src.sid;
  if (sid === undefined || sid === null || sid === '') {
    throw refuse('SID_MISSING', where + ' does not carry sid (the only identity input besides namespace)');
  }
  if (typeof sid !== 'string' || !SID_RE.test(sid)) {
    throw refuse('SID_MALFORMED', where + '.sid must be ptr-safe ([A-Za-z0-9._-]{1,128}) — log:<sid>#seq must stay resolvable');
  }
  return sid;
}
function checkDeclaredCounts(src, where) {
  let declaredWords = 0;
  let declaredSummaries = 0;
  for (let i = 0; i < src.files.length; i++) {
    const f = src.files[i];
    if (!isPlainObject(f)) throw refuse('SOURCE_ROW_INVALID', where + '.files[' + i + '] must be an object');
    sameFieldSet(f, [ECHO_INDEX_FILE_FIELDS], where + '.files[' + i + ']');
    if (typeof f.sid !== 'string' || f.sid !== src.sid) {
      throw refuse('SESSION_MISMATCH', where + '.files[' + i + '].sid must equal the source sid (one source row declares exactly one session log); refusing to merge sessions under one identity');
    }
    declaredWords += f.nWord;
    declaredSummaries += f.nSum;
  }
  if (declaredWords !== src.words.length) {
    throw refuse('COUNT_MISMATCH', where + ' declares nWord ' + declaredWords + ' but carries ' + src.words.length + ' word rows', { field: 'nWord', declared: declaredWords, actual: src.words.length });
  }
  if (declaredSummaries !== src.summaries.length) {
    throw refuse('COUNT_MISMATCH', where + ' declares nSum ' + declaredSummaries + ' but carries ' + src.summaries.length + ' summary rows', { field: 'nSum', declared: declaredSummaries, actual: src.summaries.length });
  }
}
function validateRows(src, where) {
  for (let i = 0; i < src.words.length; i++) {
    const w = src.words[i];
    if (!isPlainObject(w)) throw refuse('SOURCE_ROW_INVALID', where + '.words[' + i + '] must be an object');
    sameFieldSet(w, [ECHO_INDEX_WORD_FIELDS, ECHO_INDEX_WORD_FIELDS_WITH_ROLE], where + '.words[' + i + ']');
    if (w.session !== src.sid) throw refuse('SESSION_MISMATCH', where + '.words[' + i + '].session must equal the source sid');
    if (w.log !== null && typeof w.log !== 'string') throw refuse('SOURCE_ROW_INVALID', where + '.words[' + i + '].log must be a string or null');
  }
  for (let i = 0; i < src.summaries.length; i++) {
    const s = src.summaries[i];
    if (!isPlainObject(s)) throw refuse('SOURCE_ROW_INVALID', where + '.summaries[' + i + '] must be an object');
    sameFieldSet(s, [ECHO_INDEX_SUMMARY_FIELDS], where + '.summaries[' + i + ']');
    if (s.session !== src.sid) throw refuse('SESSION_MISMATCH', where + '.summaries[' + i + '].session must equal the source sid');
    if (s.log !== null && typeof s.log !== 'string') throw refuse('SOURCE_ROW_INVALID', where + '.summaries[' + i + '].log must be a string or null');
  }
  // builder 要求 files[].ws 与每一行 ws 一致（它按文件把行归到源上）。
  // 一个源行里出现两种 ws = 它混了两个工作区 → 拒，不替它挑一个。
  if (src.words.length > 0) {
    const ws = src.files[0].ws;
    for (let i = 0; i < src.words.length; i++) {
      const w = src.words[i];
      if (ws !== null && w.ws !== null && w.ws !== ws) {
        throw refuse('WORKSPACE_MIXED', where + '.words[' + i + '].ws contradicts files[].ws; one source row must declare one workspace');
      }
      if (ws === null && i > 0 && w.ws !== src.words[0].ws) {
        throw refuse('WORKSPACE_MIXED', where + ' mixes more than one ws while files[].ws is null');
      }
    }
  }
}
// 批级预检：失败 = 整批不写（连临时目录都不建）。
export function preflight(sources) {
  if (!Array.isArray(sources)) throw refuse('SNAPSHOT_INVALID', 'snapshot.sources must be an array');
  const seenIdentity = new Map();
  const cmpOwners = new Map();
  const wordOwners = new Map();
  const identities = [];
  const risks = { cmpIdAmbiguityIds: 0, cmpIdAmbiguityRows: 0, identicalWordKeysAcrossSources: 0, differingWordKeysAcrossSources: 0, wordKeysRefused: 0 };
  const counts = { sources: sources.length, words: 0, summaries: 0, emptyZeroZero: 0, summaryOnly: 0 };
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i];
    const where = 'sources[' + i + ']';
    if (!isPlainObject(src)) throw refuse('SOURCE_ROW_INVALID', where + ' must be an object');
    const namespace = namespaceForSourceVersion(src.sourceVersion, where);
    if (src.namespace !== undefined && src.namespace !== namespace) {
      throw refuse('NAMESPACE_MISMATCH', where + ' claims namespace ' + JSON.stringify(src.namespace) + ' but sourceVersion ' + src.sourceVersion + ' must map to ' + namespace);
    }
    const sid = requireSid(src, where);
    for (const k of ['files', 'words', 'summaries']) {
      if (!Array.isArray(src[k])) throw refuse('SOURCE_ROW_INVALID', where + '.' + k + ' must be an array');
    }
    if (src.words.length > 0 && src.files.length === 0) {
      throw refuse('SOURCE_ROW_INVALID', where + ' carries words but no files[] row to pin their log');
    }
    const sourcePath = sourceIdentityFor(namespace, sid);
    // ★ 重复身份**不在这里**判：先让「跨源同键」把话说清楚（它更具体、也更坏 ——
    //   重复身份顶多一行盖另一行，而同键会让 log:<sid>#seq 直接有两个答案）。
    checkDeclaredCounts(src, where);
    validateRows(src, where);
    identities.push({ index: i, namespace, sid, sourceVersion: src.sourceVersion, sourcePath, echoSourceId: echoSourceIdFor(sourcePath, SOURCE_VERSION) });
    counts.words += src.words.length;
    counts.summaries += src.summaries.length;
    if (src.words.length === 0 && src.summaries.length === 0) counts.emptyZeroZero++;
    if (src.words.length === 0 && src.summaries.length > 0) counts.summaryOnly++;
    const inSource = new Map();
    for (let k = 0; k < src.words.length; k++) {
      const key = src.words[k].session + '\u0000' + src.words[k].seq;
      if (inSource.has(key)) {
        throw refuse('WORD_KEY_DUPLICATE_IN_SOURCE', where + ' declares ' + src.words[k].session + '#' + src.words[k].seq + ' twice (words[' + inSource.get(key) + '] and words[' + k + '])');
      }
      inSource.set(key, k);
    }
    if (src.words.length === 0) continue; // 空源/只有摘要的源不会进库，不参与歧义统计
    for (const w of src.words) {
      const key = namespace + '\u0000' + w.session + '\u0000' + w.seq;
      // 相同 / 不同分开数，但**都**算歧义：相同的话更坏（静默留两份，谁也看不出重了）。
      const payload = JSON.stringify(Object.assign({}, w, { log: null }));
      const prior = wordOwners.get(key);
      if (prior === undefined) wordOwners.set(key, { payload, index: i });
      else if (prior.payload === payload) { risks.identicalWordKeysAcrossSources++; risks.wordKeysRefused++; }
      else { risks.differingWordKeysAcrossSources++; risks.wordKeysRefused++; }
    }
    for (const s of src.summaries) {
      const owners = cmpOwners.get(s.id) || new Set();
      owners.add(i);
      cmpOwners.set(s.id, owners);
    }
  }
  // ① 跨源同键：同一 namespace 下两个来源共享同一个 (session, seq)，无论字节是否相同，
  //   都会让 log:<sid>#seq 有两个答案（相同的话更坏：静默留两份，谁也看不出重了）。
  if (risks.wordKeysRefused > 0) {
    throw refuse('WORD_KEY_AMBIGUOUS_ACROSS_SOURCES',
      'preflight blocked: ' + risks.identicalWordKeysAcrossSources + ' identical and ' + risks.differingWordKeysAcrossSources +
      ' differing word keys are shared by two sources in the same namespace; log:<sid>#seq must keep exactly one answer per namespace',
      { risks });
  }
  // ② 重复身份：两行落到同一个 (namespace, sid)。同键已经拦在上面了，所以到这里的
  //   是「同一个会话被拆成两行、行集不重叠」—— 一样会互相覆盖，一样得拒。
  for (const info of identities) {
    if (seenIdentity.has(info.sourcePath)) {
      throw refuse('DUPLICATE_SOURCE_IDENTITY',
        'sources[' + seenIdentity.get(info.sourcePath) + '] and sources[' + info.index + '] resolve to the same identity (same namespace + sid); one would silently overwrite the other',
        { firstIndex: seenIdentity.get(info.sourcePath), secondIndex: info.index });
    }
    seenIdentity.set(info.sourcePath, info.index);
  }
  // ③ 跨源重复 cmpId 是**允许**的（它是 idx 指针的合法歧义，由 echoSourceId 选择器裁决），
  //   只计数上报，不拒。
  for (const owners of cmpOwners.values()) {
    if (owners.size > 1) { risks.cmpIdAmbiguityIds++; risks.cmpIdAmbiguityRows += owners.size - 1; }
  }
  return { identities, risks, counts };
}

// ── 脱敏 feed ────────────────────────────────────────────────────────────
const jsonlBytes = (rows) => Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
// 一个源行 → 一份 feed。log 全部换成 REDACTED_LOG；session/ws/seq/turn 原样（指针要用）。
function feedFor(src) {
  const sid = src.sid;
  const ws = src.files.length ? src.files[0].ws : null;
  const words = src.words.map((w) => Object.assign({}, w, { log: REDACTED_LOG }));
  const summaries = src.summaries.map((s) => Object.assign({}, s, { log: REDACTED_LOG }));
  // files 折成一行：身份是 (namespace, sid)，一个源行就是一份会话日志。
  // key 由「与路径无关的指纹」派生（sid / ws / nextByte 之和 / 行数），不掺任何路径。
  const key = sha(['files-collapsed/v1', sid, String(ws), src.files.map((f) => nextByteOf(f)).join(','), String(src.words.length), String(src.summaries.length)].join('\n'));
  const nextByte = src.files.reduce((a, f) => a + nextByteOf(f), 0);
  const files = [{
    file: REDACTED_LOG, key, nextByte, ws, sid,
    nSum: src.summaries.length, nWord: src.words.length,
    sumOut: REDACTED_LOG, wordOut: REDACTED_LOG,
  }];
  return { files, words, summaries };
}
const nextByteOf = (f) => (Number.isSafeInteger(f && f.nextByte) ? f.nextByte : 0);

// ── 隐私扫描（判据只写一份；**范围按字段**）──────────────────────────────
// pathScan = 只找「不该出现的本机路径」。它**只**用于承载路径的字段（见 PATH_BEARING）、
// 清单里的 sourcePath / log 记号、以及 journal 行。内容字段（text / summary / full_json /
// FTS）永远不进这里 —— 那些字段里出现 "D:/…" 是用户说的话，不是本机泄漏。
function pathScan(text, needles) {
  const n = needles || {};
  const s = String(text);
  const lower = s.toLowerCase();
  const hits = { tempRoot: 0, driveLiterals: 0, rawPaths: 0, offenders: [] };
  if (n.tempRoot && lower.indexOf(String(n.tempRoot).toLowerCase()) !== -1) { hits.tempRoot++; hits.offenders.push('tempRoot'); }
  const re = /[A-Za-z]:[\\/]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const at = m.index;
    const allowed = ALLOWED_DRIVE_LITERALS.some((l) => lower.startsWith(l.toLowerCase(), at));
    if (!allowed) { hits.driveLiterals++; hits.offenders.push('driveLiteral'); }
  }
  for (const secret of n.secrets || []) {
    if (secret && s.indexOf(String(secret)) !== -1) { hits.rawPaths++; hits.offenders.push('rawPath'); }
  }
  return hits;
}
function sidNeedles(needles) {
  const n = needles || {};
  const out = [];
  if (n.sid !== undefined && n.sid !== null && n.sid !== '') out.push(String(n.sid));
  for (const sid of n.sids || []) if (typeof sid === 'string' && sid && out.indexOf(sid) === -1) out.push(sid);
  return out;
}
// 返回命中的 sid 个数（**不回 sid 本身**：命中详情要能进 journal）。
function sidScan(text, needles) {
  const s = String(text);
  let n = 0;
  for (const sid of sidNeedles(needles)) if (s.indexOf(sid) !== -1) n++;
  return n;
}
// 旧签名保留（既有断言按这个形状读）：路径三计数 + 可选的单个 sid。
export function privacyScan(text, needles) {
  const hits = pathScan(text, needles);
  const n = sidScan(text, needles);
  hits.sid = n;
  if (n > 0 && hits.offenders.indexOf('sid') === -1) hits.offenders.push('sid');
  return hits;
}
function kindsOf(hits) {
  return [...new Set(hits.offenders)].join(',');
}
// journal 行由本 harness 自己拼装（没有正文），所以整行扫是安全的，也是该扫的。
function assertClean(label, text, needles) {
  const hits = privacyScan(text, needles);
  if (hits.tempRoot || hits.driveLiterals || hits.sid || hits.rawPaths) {
    throw refuse('PRIVACY_VIOLATION', label + ' carries a local path or a raw sid: ' + kindsOf(hits));
  }
}
// 单个「承载路径的字段」。非字符串（undefined / null）跳过：没有路径就没有可漏的路径。
function assertPathField(label, value, needles) {
  if (typeof value !== 'string') return;
  const hits = pathScan(value, needles);
  if (hits.tempRoot || hits.driveLiterals || hits.rawPaths) {
    throw refuse('PRIVACY_VIOLATION', label + ' carries a local path: ' + kindsOf(hits));
  }
}
// 清单里承载路径的只有两处：sourcePath、以及每一个 log 记号（含 cursor.feed 的键）。
function manifestPathTokens(parsed) {
  const out = [];
  if (parsed && typeof parsed.sourcePath === 'string') out.push(parsed.sourcePath);
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    for (const k of Object.keys(v)) {
      const val = v[k];
      if (k === 'log' && typeof val === 'string') out.push(val);
      else walk(val);
    }
  };
  walk(parsed);
  const files = parsed && parsed.cursor && parsed.cursor.feed && parsed.cursor.feed.files;
  if (files && typeof files === 'object') for (const k of Object.keys(files)) out.push(k);
  return out;
}
// 清单：路径只扫上面那些记号；sid 只许出现在 cursor.feed（builder 写的 files[].sid）。
function assertManifestClean(bytes, needles) {
  const text = bytes.toString('utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw refuse('MANIFEST_INVALID', 'manifest is not JSON: ' + String((e && e.message) || e).slice(0, 200)); }
  const tokens = manifestPathTokens(parsed);
  for (let i = 0; i < tokens.length; i++) assertPathField('manifest path token[' + i + ']', tokens[i], needles);
  const withoutFeed = JSON.parse(text);
  if (withoutFeed && withoutFeed.cursor && withoutFeed.cursor.feed !== undefined) withoutFeed.cursor.feed = null;
  const sidHits = sidScan(JSON.stringify(withoutFeed), needles);
  if (sidHits > 0) throw refuse('PRIVACY_VIOLATION', 'manifest (outside cursor.feed) carries ' + sidHits + ' raw sid(s): sid');
}

const ECHO_TABLES = Object.freeze([
  'echo_index_sources', 'echo_words', 'echo_summaries', 'echo_summary_src_seqs',
  'echo_words_fts', 'echo_summaries_fts', 'echo_source_builds',
]);
function echoRowCounts(db, echoSourceId) {
  const out = {};
  for (const t of ECHO_TABLES) {
    out[t] = Number(db.prepare('SELECT COUNT(*) AS n FROM ' + t + ' WHERE echo_source_id = ?').get(echoSourceId).n);
  }
  return out;
}
// 库面隐私扫描：逐列取值，但**范围按列分类**（PATH_BEARING / SID_ALLOWED_COLUMNS）。
// · 路径式判据只落在承载路径的列上；cursor_json 只看**键**（值是数据：sid / ws / 计数）。
// · sid 判据反过来：除白名单 (表,列) 外，任何列出现原始 sid 就算问题。
// · 一律只对本批的 echoSourceIds 生效 —— TEMP 库里灌着别人的数据时，那些数据不该由本批背账。
// ★ 命中详情只记「哪表哪列 + 类别 + 个数」，绝不回显命中文本：那段文本本身可能带路径/sid，
//   而它要被写进 journal。
function dbPrivacyFindings(db, needles, scopedIds) {
  const found = [];
  if (!Array.isArray(scopedIds) || scopedIds.length === 0) return found;
  const ph = scopedIds.map(() => '?').join(',');
  const tables = ['echo_index_sources', 'echo_words', 'echo_summaries', 'echo_source_builds'];
  for (const t of tables) {
    const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
    for (const col of cols) {
      const key = t + '.' + col;
      const rows = db.prepare('SELECT ' + col + ' AS v FROM ' + t + ' WHERE echo_source_id IN (' + ph + ')').all(...scopedIds);
      for (const row of rows) {
        const v = row.v;
        if (typeof v !== 'string') continue;
        const mode = PATH_BEARING[key];
        if (mode === true) {
          const hits = pathScan(v, needles);
          if (hits.tempRoot || hits.driveLiterals || hits.rawPaths) found.push({ table: t, column: col, kind: 'path:' + kindsOf(hits) });
        } else if (mode === 'keys') {
          const bad = cursorKeyPathHits(v, needles);
          if (bad > 0) found.push({ table: t, column: col, kind: 'path-keys:' + bad });
        }
        if (!SID_ALLOWED_COLUMNS[key]) {
          const n = sidScan(v, needles);
          if (n > 0) found.push({ table: t, column: col, kind: 'sid', matches: n });
        }
      }
    }
  }
  // FTS：内容是正文（raw_text = 原句），路径一个字都不扫；但 sid 仍按白名单查。
  for (const t of ['echo_words_fts', 'echo_summaries_fts']) {
    const cols = db.prepare('PRAGMA table_info(' + t + ')').all().map((c) => c.name);
    for (const col of cols) {
      if (SID_ALLOWED_COLUMNS[t + '.' + col]) continue;
      const rows = db.prepare('SELECT ' + col + ' AS v FROM ' + t + ' WHERE echo_source_id IN (' + ph + ')').all(...scopedIds);
      for (const row of rows) {
        if (typeof row.v !== 'string') continue;
        const n = sidScan(row.v, needles);
        if (n > 0) found.push({ table: t, column: col, kind: 'sid', matches: n });
      }
    }
  }
  return found;
}
// 游标 json 的**键**就是生产索引里的日志文件名 —— 只它的键受路径判据约束。
function cursorKeyPathHits(text, needles) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return 1; }
  const files = parsed && parsed.files;
  if (!files || typeof files !== 'object') return 0;
  let bad = 0;
  for (const k of Object.keys(files)) {
    const hits = pathScan(k, needles);
    if (hits.tempRoot || hits.driveLiterals || hits.rawPaths) bad++;
  }
  return bad;
}

// 回执白名单：只留这几项，别的一律不进 journal。
export function sanitizeReceipt(receipt) {
  if (!isPlainObject(receipt)) return null;
  const out = {};
  for (const k of ['ok', 'code', 'wrote', 'generation']) if (receipt[k] !== undefined) out[k] = receipt[k];
  if (isPlainObject(receipt.counts)) {
    out.counts = {};
    for (const k of ['words', 'summaries', 'srcSeqs', 'excludedReasoning']) if (receipt.counts[k] !== undefined) out.counts[k] = receipt.counts[k];
  }
  const id = receipt.source && receipt.source.echoSourceId;
  if (typeof id === 'string') out.source = { echoSourceId: id };
  return out;
}

// ── 路径守卫 ─────────────────────────────────────────────────────────────
function inside(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
}
function requireTempPath(value, label, mustExist = true) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw refuse('PATH_INVALID', label + ' must be an explicit absolute path');
  const abs = path.resolve(value);
  const root = fs.realpathSync(os.tmpdir());
  if (mustExist && !fs.existsSync(abs)) throw refuse('PATH_INVALID', label + ' does not exist');
  let real;
  if (mustExist) real = fs.realpathSync(abs);
  else {
    const parent = path.dirname(abs);
    if (!fs.existsSync(parent)) throw refuse('PATH_INVALID', label + ' parent directory must already exist');
    real = path.join(fs.realpathSync(parent), path.basename(abs));
  }
  if (!inside(root, real)) throw refuse('TEMP_ONLY', label + ' must resolve under os.tmpdir()');
  return real;
}
// ── 生产模式的闸门（唯一一处定义）────────────────────────────────────────
// ★ 这个函数**只做判断，不做写入**，也不打开库写：它抛错时一行都还没落。
export const LIVE_MEMORY_INDEX_ROOT = 'D:/AI/memory/hub/index';
export const RECEIPT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// 回执的六个字段：**恰好**这些（多一个少一个都拒 —— 回执是别人给的，形状不猜）。
export const BACKUP_RECEIPT_FIELDS = Object.freeze(['backupPath', 'sha256', 'bytes', 'schemaVersion', 'takenAt', 'sourceDbPath']);
const posixAbs = (p) => path.resolve(p).split(path.sep).join('/');
const insideOrEqual = (child, parent) => {
  const c = posixAbs(child).toLowerCase();
  const p = posixAbs(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith('/') ? p : p + '/');
};
function readBackupReceipt(receiptPath) {
  let bytes;
  try {
    bytes = fs.readFileSync(receiptPath);
  } catch {
    throw refuse('BACKUP_RECEIPT_INVALID', '--backup-receipt is not readable');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (e) {
    throw refuse('BACKUP_RECEIPT_INVALID', '--backup-receipt is not valid JSON: ' + String((e && e.message) || e).slice(0, 160));
  }
  if (!isPlainObject(parsed)) throw refuse('BACKUP_RECEIPT_INVALID', '--backup-receipt must be a JSON object');
  const got = Object.keys(parsed).sort().join(',');
  if (got !== BACKUP_RECEIPT_FIELDS.slice().sort().join(',')) {
    throw refuse('BACKUP_RECEIPT_INVALID', '--backup-receipt field set ' + JSON.stringify(Object.keys(parsed).sort()) + ' is not exactly [' + BACKUP_RECEIPT_FIELDS.join(',') + '] (fail-closed: a receipt shape is never guessed)');
  }
  for (const k of ['backupPath', 'sourceDbPath']) {
    if (typeof parsed[k] !== 'string' || parsed[k] === '' || !path.isAbsolute(parsed[k])) {
      throw refuse('BACKUP_RECEIPT_INVALID', '--backup-receipt.' + k + ' must be an absolute path');
    }
  }
  if (typeof parsed.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(parsed.sha256)) {
    throw refuse('BACKUP_RECEIPT_INVALID', '--backup-receipt.sha256 must be 64 lowercase hex chars');
  }
  if (!Number.isSafeInteger(parsed.bytes) || parsed.bytes < 0) {
    throw refuse('BACKUP_RECEIPT_INVALID', '--backup-receipt.bytes must be a non-negative safe integer');
  }
  if (!Number.isInteger(parsed.schemaVersion) || parsed.schemaVersion < 1) {
    throw refuse('BACKUP_RECEIPT_INVALID', '--backup-receipt.schemaVersion must be a positive integer');
  }
  if (typeof parsed.takenAt !== 'string' || !Number.isFinite(Date.parse(parsed.takenAt))) {
    throw refuse('BACKUP_RECEIPT_INVALID', '--backup-receipt.takenAt must be an ISO timestamp');
  }
  return { receipt: parsed, fileSha256: sha(bytes), bytes: bytes.length };
}
// 生产模式的完整判据。返回给调用方的只有"可以写"所需的最小事实（全部无路径）。
export function assertProductionGate(dbPath, journalPath, options) {
  const o = options || {};
  // ① 结构：三样必须同时给（--production 是入口，另外两个是它的条件）
  if (typeof o.allowDb !== 'string' || o.allowDb === '') {
    throw refuse('PRODUCTION_FLAG_INCOMPLETE', 'production mode requires --allow-db <absolute path>; --production alone is never enough');
  }
  if (typeof o.backupReceipt !== 'string' || o.backupReceipt === '') {
    throw refuse('PRODUCTION_FLAG_INCOMPLETE', 'production mode requires --backup-receipt <json file>; --production alone is never enough');
  }
  if (typeof dbPath !== 'string' || dbPath === '' || !path.isAbsolute(dbPath)) {
    throw refuse('PRODUCTION_FLAG_INCOMPLETE', 'production mode requires --db to be an explicit absolute path');
  }
  if (typeof journalPath !== 'string' || journalPath === '' || !path.isAbsolute(journalPath)) {
    throw refuse('PRODUCTION_FLAG_INCOMPLETE', 'production mode requires --journal to be an explicit absolute path');
  }
  if (!path.isAbsolute(o.allowDb)) {
    throw refuse('PRODUCTION_DB_MISMATCH', '--allow-db must be an absolute path (a relative allow-list entry pins nothing)');
  }
  // ② live 索引目录：**先按字符串判**，判完就拒 —— 于是"把它当参数传进来"这件事本身
  //    连一次 stat 都不会发生。冻结源不是派生库。
  if (insideOrEqual(dbPath, LIVE_MEMORY_INDEX_ROOT) || insideOrEqual(o.allowDb, LIVE_MEMORY_INDEX_ROOT)) {
    throw refuse('PRODUCTION_DB_IS_LIVE_INDEX', 'the database path is inside the live memory hub index directory (' + LIVE_MEMORY_INDEX_ROOT + '); that is the freeze source, never a derived index target');
  }
  // ③ --db 与 --allow-db 必须指向**同一个文件**（realpath 之后）。字面相等不算数：
  //    短名 / 大小写 / 符号链接都让两份不同的字面量指向同一个 inode。
  let dbReal;
  try {
    dbReal = fs.realpathSync(path.resolve(dbPath));
  } catch {
    throw refuse('PRODUCTION_DB_MISMATCH', '--db does not exist or is not readable');
  }
  let allowReal;
  try {
    allowReal = fs.realpathSync(path.resolve(o.allowDb));
  } catch {
    throw refuse('PRODUCTION_DB_MISMATCH', '--allow-db does not exist or is not readable');
  }
  if (dbReal.toLowerCase() !== allowReal.toLowerCase()) {
    throw refuse('PRODUCTION_DB_MISMATCH', '--db does not resolve to the same file as --allow-db (realpath mismatch); refusing to write a database that was not the one explicitly allowed');
  }
  const dbStat = fs.statSync(dbReal);
  if (!dbStat.isFile()) throw refuse('PRODUCTION_DB_MISMATCH', '--db must be a regular file');
  // ④ 硬链接：写一份等于同时改另一份，而"另一份"是哪份没人说得清。
  if (Number(dbStat.nlink) > 1) {
    throw refuse('PRODUCTION_DB_HARDLINKED', 'the database has more than one hard link (nlink=' + dbStat.nlink + '); writing it would silently change every other name that points at the same bytes');
  }
  // ⑤ journal 不许落在库所在目录（含其子目录）
  const dbDir = path.dirname(dbReal);
  const journalAbs = path.resolve(journalPath);
  const journalParent = fs.existsSync(path.dirname(journalAbs)) ? fs.realpathSync(path.dirname(journalAbs)) : null;
  if (journalParent === null) throw refuse('PRODUCTION_JOURNAL_IN_DB_DIR', '--journal parent directory must already exist');
  const journalReal = path.join(journalParent, path.basename(journalAbs));
  if (insideOrEqual(journalReal, dbDir)) {
    throw refuse('PRODUCTION_JOURNAL_IN_DB_DIR', '--journal must not live in (or under) the database directory; one accident must not be able to destroy the database and its only record of the run together');
  }
  if (insideOrEqual(journalReal, LIVE_MEMORY_INDEX_ROOT)) {
    throw refuse('PRODUCTION_JOURNAL_IN_DB_DIR', '--journal must not live inside the live memory hub index directory');
  }
  // ⑥ 回执：形状 → 备份文件字节 → 它描述的是不是这个库 → 库版本 → 新鲜度
  const receiptLoaded = readBackupReceipt(path.resolve(o.backupReceipt));
  const receipt = receiptLoaded.receipt;
  // ★ readFileSync 对 > 2 GiB 文件有硬性 Buffer 限制（kMaxLength ≈ 2.147 GiB）；
  //   改用 openSync + readSync 分块读，语义完全等价（大小 + sha256），不占整文件内存。
  let backupActualBytes;
  let backupActualSha;
  try {
    const backupAbsPath = path.resolve(receipt.backupPath);
    const stat = fs.statSync(backupAbsPath);
    backupActualBytes = stat.size;
    const hasher = createHash('sha256');
    const CHUNK = 4 * 1024 * 1024; // 4 MiB
    const buf = Buffer.allocUnsafe(CHUNK);
    const fd = fs.openSync(backupAbsPath, 'r');
    try {
      let pos = 0;
      while (pos < backupActualBytes) {
        const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, backupActualBytes - pos), pos);
        if (n <= 0) break;
        hasher.update(n === CHUNK ? buf : buf.subarray(0, n));
        pos += n;
      }
    } finally {
      fs.closeSync(fd);
    }
    backupActualSha = hasher.digest('hex');
  } catch (e) {
    throw refuse('BACKUP_FILE_MISMATCH', 'the backup file named by the receipt is not readable: ' + String((e && e.message) || e).slice(0, 160));
  }
  if (backupActualBytes !== receipt.bytes || backupActualSha !== receipt.sha256) {
    throw refuse('BACKUP_FILE_MISMATCH', 'the backup file does not match the receipt (size or sha256 differs); a receipt that describes a different file is worse than no receipt', {
      declaredBytes: receipt.bytes, actualBytes: backupActualBytes,
    });
  }
  let receiptDbReal;
  try {
    receiptDbReal = fs.realpathSync(path.resolve(receipt.sourceDbPath));
  } catch {
    throw refuse('PRODUCTION_DB_MISMATCH', 'the receipt sourceDbPath does not exist; it must name the database being written');
  }
  if (receiptDbReal.toLowerCase() !== dbReal.toLowerCase()) {
    throw refuse('PRODUCTION_DB_MISMATCH', 'the receipt was taken from a different database (sourceDbPath does not resolve to --allow-db)');
  }
  // ⑦ 库的**当前**版本从库里读（不是从代码常量）：回执写的版本必须是这次要写的那个库的版本。
  const store = openReadOnly(dbReal);
  let liveSchema;
  try {
    liveSchema = readSchemaState(store.db).current;
  } finally {
    store.close();
  }
  if (receipt.schemaVersion !== liveSchema) {
    throw refuse('SCHEMA_VERSION_MISMATCH', 'the receipt records schemaVersion ' + receipt.schemaVersion + ' but the live database is at ' + liveSchema + '; a backup from another schema generation cannot vouch for this one', {
      receiptSchemaVersion: receipt.schemaVersion, liveSchemaVersion: liveSchema,
    });
  }
  // ⑧ 新鲜度：24 小时内，且不许来自未来（未来的时间戳同样不可信）
  const takenMs = Date.parse(receipt.takenAt);
  const ageMs = Date.now() - takenMs;
  if (ageMs > RECEIPT_MAX_AGE_MS) {
    throw refuse('BACKUP_STALE', 'the backup receipt is older than 24 hours', { ageHours: Math.round(ageMs / 3600000) });
  }
  if (ageMs < -5 * 60 * 1000) {
    throw refuse('BACKUP_STALE', 'the backup receipt claims a time in the future; a timestamp that has not happened cannot vouch for anything', { skewMinutes: Math.round(-ageMs / 60000) });
  }
  return {
    dbAbs: dbReal,
    journalAbs,
    // 只回"事实"，不回路径：这些会被写进 journal header。
    receiptFileSha256: receiptLoaded.fileSha256,
    backupSha256: receipt.sha256,
    backupBytes: receipt.bytes,
    schemaVersion: liveSchema,
    backupTakenAt: new Date(takenMs).toISOString(),
    backupAgeMs: ageMs,
  };
}

// 读一次：字节、utf8 校验、解析、sha 都从这一份来（journal header 要记 sha 与字节数）。
function readSnapshot(file) {
  const bytes = fs.readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw refuse('SNAPSHOT_NOT_UTF8', 'snapshot is not valid UTF-8');
  let snapshot;
  try { snapshot = JSON.parse(text); } catch (e) { throw refuse('SNAPSHOT_INVALID_JSON', 'snapshot is invalid JSON: ' + e.message); }
  if (!isPlainObject(snapshot) || !Array.isArray(snapshot.sources)) throw refuse('SNAPSHOT_INVALID', 'snapshot must be an object with sources[]');
  return { snapshot, bytes, sha256: sha(bytes) };
}
const openReadOnly = (dbPath) => openMetaStore({ path: dbPath, mode: 'readonly' });

// 逐源事务的模型：每个源单独一次 runImport；失败只影响这一源在库里的行数。
// ★ manifestSha256 由调用方从 builder 的回执传进来：importer 核的是「builder 签过名的字节」，
//   这里再读一遍只会得到「我读到的字节」的哈希 —— 那是第二句彼此无关的断言。
function runOneImport(dbPath, manifestPath, generation, manifestSha256) {
  if (typeof manifestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(manifestSha256)) {
    return { manifestSha: manifestSha256 || null, receipt: null, code: 'MANIFEST_SHA_MISSING' };
  }
  let receipt = null;
  let code = null;
  try {
    receipt = runImport(['--manifest', manifestPath, '--sha256', manifestSha256, '--generation', String(generation), '--db', dbPath, '--json']);
  } catch (err) {
    code = (err && err.code) ? String(err.code) : 'IMPORT_THREW';
  }
  return { manifestSha: manifestSha256, receipt, code };
}
// builder 只按类计数地丢掉两类行（截断 / role 不在 user|assistant）。
// 这里把「非会话角色」那一类从 excludedByType 里挑出来（键形如 'kind:<kind>'）。
function droppedNonChatRole(excludedByType) {
  let n = 0;
  for (const k of Object.keys(excludedByType || {})) {
    if (k.indexOf('kind:') === 0) n += Number(excludedByType[k]) || 0;
  }
  return n;
}

export function importSnapshot(snapshotPath, dbPath, journalPath, options = {}) {
  const generation = options.generation;
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw refuse('OPTIONS_GENERATION_REQUIRED', 'generation must be an explicit positive safe integer (no default: a fabricated generation silently rewrites history)');
  }
  if (typeof options.builtAt !== 'string' || !Number.isFinite(Date.parse(options.builtAt))) {
    throw refuse('OPTIONS_BUILT_AT_REQUIRED', 'builtAt must be an explicit ISO timestamp (no fabricated timestamp: it lands in every manifest)');
  }
  // 快照永远 TEMP-only（生产模式也不放松）：里面是消息正文。
  const snapshotAbs = requireTempPath(snapshotPath, 'snapshot');
  // ★ 生产模式是**另一条路**，不是把 TEMP 闸门放宽：不写 --production 时下面这行与旧版
  //   逐字节相同。写了就必须过 assertProductionGate 的每一条（它在打开库写之前抛）。
  const production = options.production === true ? assertProductionGate(dbPath, journalPath, options) : null;
  const dbAbs = production ? production.dbAbs : requireTempPath(dbPath, 'db');
  const journalAbs = production ? production.journalAbs : requireTempPath(journalPath, 'journal', false);
  const loaded = readSnapshot(snapshotAbs);
  const snapshot = loaded.snapshot;
  const pre = preflight(snapshot.sources);
  const { identities } = pre;
  const sids = [...new Set(identities.map((x) => x.sid))];
  const scopedIds = identities.map((x) => x.echoSourceId);

  const needles = {
    tempRoot: fs.realpathSync(os.tmpdir()),
    secrets: [process.cwd(), dbAbs, snapshotAbs, journalAbs],
    sids,
  };

  // journal：header 第一行就落盘，之后逐源 append（每条结果落定即写）。
  fs.writeFileSync(journalAbs, JSON.stringify({
    type: 'header',
    harness: HARNESS_VERSION,
    sourceVersion: SOURCE_VERSION,
    generation,
    builtAt: options.builtAt,
    // 快照的字节与 sha：事后能核对「这次导的到底是哪份输入」，而不必再原路重算。
    snapshot: { sha256: loaded.sha256, bytes: loaded.bytes.length },
    sourceCount: snapshot.sources.length,
    preflight: pre.counts,
    ambiguityRisks: pre.risks,
    // ★ 事务边界：每个源 = 一个独立事务，整批**不**原子。崩在第 N 个源，
    //   前 N-1 个已经提交，谁都别指望回滚。
    atomicity: 'per-source transactions; the batch is NOT atomic — a crash keeps every source already committed',
    // ★ 这一代跑的是哪一圈护栏：TEMP 还是生产，以及"当时手里那张回执"是哪一张。
    //   只记哈希与版本事实，**不记路径**（journal 会被长时间保留，路径是机器本地的）。
    mode: production ? 'production' : 'temp-only',
    allowDanglingSrcSeq: production ? options.allowDanglingSrcSeq === true : false,
    production: production ? {
      allowDbSha256: sha(production.dbAbs.toLowerCase()),
      receiptFileSha256: production.receiptFileSha256,
      backupSha256: production.backupSha256,
      backupBytes: production.backupBytes,
      backupTakenAt: production.backupTakenAt,
      schemaVersionAtOpen: production.schemaVersion,
    } : null,
  }) + '\n', { flag: 'wx' });

  const tally = { imported: 0, alreadyCurrent: 0, skippedEmpty: 0, skippedSummaryOnly: 0, refused: 0, failed: 0 };
  const outcomes = [];
  // 库内实况（不区分成功/失败）：journal 永远不许比数据库少报行。
  const committed = { sources: 0, words: 0, summaries: 0 };
  const appendLine = (obj) => {
    const line = JSON.stringify(obj) + '\n';
    assertClean('journal line', line, needles);
    fs.appendFileSync(journalAbs, line);
  };

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-source-snapshot-'));
  const finish = (entry) => { outcomes.push(entry); appendLine(entry); };
  const dbRowsFor = (echoSourceId) => {
    const store = openReadOnly(dbAbs);
    try { return echoRowCounts(store.db, echoSourceId); } finally { store.close(); }
  };
  // 每个非跳过结果的「此刻库里有多少行」。只在这里 +1 计数，避免同一源被数两次。
  const settle = (entry, id) => {
    if (entry.settled === true) return entry.dbRows;
    const rows = dbRowsFor(id.echoSourceId);
    entry.dbRows = rows;
    entry.committedRows = rows.echo_words;
    entry.committedSummaries = rows.echo_summaries;
    committed.sources += 1;
    committed.words += rows.echo_words;
    committed.summaries += rows.echo_summaries;
    entry.settled = true;
    return rows;
  };

  // 逐源工作体：任何 return 都是该源的终态（finish 已调用）。
  const handleSource = (entry, src, id) => {
    if (src.words.length === 0) {
      entry.outcome = src.summaries.length ? 'SKIPPED_SUMMARY_ONLY' : 'SKIPPED_EMPTY';
      entry.code = entry.outcome;
      if (src.summaries.length) tally.skippedSummaryOnly++; else tally.skippedEmpty++;
      return finish(entry);
    }
    const dir = path.join(root, 'source-' + entry.index);
    fs.mkdirSync(dir, { recursive: true });
    const feed = feedFor(src);
    const filesPath = path.join(dir, 'files.jsonl');
    const wordsPath = path.join(dir, 'words.jsonl');
    const summariesPath = path.join(dir, 'summaries.jsonl');
    fs.writeFileSync(filesPath, jsonlBytes(feed.files), { flag: 'wx' });
    fs.writeFileSync(wordsPath, jsonlBytes(feed.words), { flag: 'wx' });
    fs.writeFileSync(summariesPath, jsonlBytes(feed.summaries), { flag: 'wx' });
    // feed 自己就得干净：写出去之后按字节再扫一遍（不只信内存里的对象）。
    // 但只扫**承载路径的字段** —— words 的 text / summaries 的 summary 是内容，不扫。
    assertFeedPathFields('feed files.jsonl', filesPath, ['file', 'sumOut', 'wordOut'], needles);
    assertFeedPathFields('feed words.jsonl', wordsPath, ['log'], needles);
    assertFeedPathFields('feed summaries.jsonl', summariesPath, ['log'], needles);

    let built;
    try {
      built = buildFromEchoIndexFiles({
        filesPath, wordsPath, summariesPath, outDir: path.join(dir, 'built'),
        sourcePath: id.sourcePath, namespace: id.namespace, generation,
        sourceVersion: SOURCE_VERSION, builtAt: options.builtAt,
        allowDanglingSrcSeq: production === null ? false : options.allowDanglingSrcSeq === true,
      });
    } catch (err) {
      entry.outcome = 'FAILED';
      entry.code = /no user\/assistant rows|empty generation/.test(String(err && err.message)) ? 'BUILD_EMPTY_GENERATION' : 'BUILD_REFUSED';
      entry.detail = journalSafeMessage(err, needles);
      const refs = err && err.srcSeqCounts;
      if (refs && Number.isSafeInteger(refs.refs) && Number.isSafeInteger(refs.resolved) && Number.isSafeInteger(refs.dangling)) {
        entry.counts.srcSeqRefs = refs.refs;
        entry.counts.srcSeqResolved = refs.resolved;
        entry.counts.srcSeqDangling = refs.dangling;
      }
      tally.failed++; return finish(entry);
    }
    entry.manifestSha256 = built.manifestSha256;
    entry.counts.emittedWords = built.counts.words;
    entry.counts.emittedSummaries = built.counts.summaries;
    entry.counts.srcSeqRefs = Number(built.counts.srcSeqs) || 0;
    entry.counts.srcSeqResolved = Number(built.counts.srcSeqResolved) || 0;
    entry.counts.srcSeqDangling = Number(built.counts.srcSeqDangling) || 0;
    // 丢行逐类记账（见文件头「账要真」）。推理行不属于这里 —— 它是导入前的拒绝。
    entry.counts.droppedTruncated = Number(built.counts.truncatedExcluded) || 0;
    entry.counts.droppedNonChatRole = droppedNonChatRole(built.counts.excludedByType);
    entry.counts.excludedReasoningDeclared = Number(built.counts.excludedReasoning) || 0;
    // ⑤ 推理行：builder 把它排除、却把计数写进清单；importer 从发射出来的文件重算会得到 0
    //    → MANIFEST_COUNTS_MISMATCH。所以在交给 importer **之前**就拒。
    if (entry.counts.excludedReasoningDeclared > 0) {
      entry.outcome = 'REFUSED';
      entry.code = 'EXCLUDED_REASONING_UNREPRESENTABLE';
      entry.counts.excludedReasoning = entry.counts.excludedReasoningDeclared;
      tally.refused++; return finish(entry);
    }
    // ② 清单不许再被改：字节 sha == builder 报的 sha；身份 == 本 harness 派生的身份。
    const manifestBytes = fs.readFileSync(built.manifestPath);
    if (sha(manifestBytes) !== built.manifestSha256) {
      entry.outcome = 'FAILED'; entry.code = 'MANIFEST_MUTATED_AFTER_BUILD';
      tally.failed++; return finish(entry);
    }
    if (!built.sourceIdentity || built.sourceIdentity.echoSourceId !== id.echoSourceId) {
      entry.outcome = 'FAILED'; entry.code = 'BUILDER_IDENTITY_MISMATCH';
      tally.failed++; return finish(entry);
    }
    assertManifestClean(manifestBytes, needles);

    const run = runOneImport(dbAbs, built.manifestPath, generation, built.manifestSha256);
    entry.receipt = sanitizeReceipt(run.receipt);
    if (run.code) {
      entry.outcome = 'FAILED';
      entry.code = run.code;
      settle(entry, id);
      tally.failed++; return finish(entry);
    }
    const receipt = run.receipt || {};
    const receiptId = receipt.source && receipt.source.echoSourceId;
    if (receiptId !== id.echoSourceId) {
      entry.outcome = 'FAILED'; entry.code = 'RECEIPT_IDENTITY_MISMATCH';
      settle(entry, id);
      tally.failed++; return finish(entry);
    }
    const store = openReadOnly(dbAbs);
    let storedRow = null;
    try {
      storedRow = store.db.prepare('SELECT source_path, source_version, namespace FROM echo_index_sources WHERE echo_source_id = ?').get(id.echoSourceId) || null;
    } finally { store.close(); }
    const dbRows = settle(entry, id);
    if (!storedRow || storedRow.source_path !== id.sourcePath || storedRow.source_version !== SOURCE_VERSION || storedRow.namespace !== id.namespace) {
      entry.outcome = 'FAILED';
      entry.code = 'STORED_IDENTITY_MISMATCH';
      entry.stored = storedRow ? { sourcePathHash: sha(storedRow.source_path), sourceVersion: storedRow.source_version, namespace: storedRow.namespace } : null;
      tally.failed++; return finish(entry);
    }
    // ④ 账：imported 行数 = 回执自报，且必须等于库里该源的行数。两处独立取值必须一致。
    const rc = (receipt.counts && Number(receipt.counts.words)) || 0;
    const rs = (receipt.counts && Number(receipt.counts.summaries)) || 0;
    const isCurrent = receipt.code === 'ALREADY_CURRENT';
    if (isCurrent) {
      entry.outcome = 'ALREADY_CURRENT';
      entry.code = 'ALREADY_CURRENT';
      if (dbRows.echo_words !== rc || dbRows.echo_summaries !== rs) {
        entry.outcome = 'FAILED'; entry.code = 'ACCOUNTING_MISMATCH';
        tally.failed++; return finish(entry);
      }
      if (!accountRows(entry, built.counts)) { entry.outcome = 'FAILED'; entry.code = 'ROW_LOSS_UNACCOUNTED'; tally.failed++; return finish(entry); }
      tally.alreadyCurrent++;
    } else {
      entry.outcome = 'IMPORTED';
      entry.code = receipt.code || 'IMPORTED';
      if (dbRows.echo_words !== rc || dbRows.echo_summaries !== rs) {
        entry.outcome = 'FAILED'; entry.code = 'ACCOUNTING_MISMATCH';
        tally.failed++; return finish(entry);
      }
      entry.counts.importedWords = rc;
      entry.counts.importedSummaries = rs;
      // ③ 丢行也必须平：declared == stored + truncated + non-chat-role。
      //   行已经在库里了 —— FAILED 也要记 committedRows（settle 已记）。
      if (!accountRows(entry, built.counts)) { entry.outcome = 'FAILED'; entry.code = 'ROW_LOSS_UNACCOUNTED'; tally.failed++; return finish(entry); }
      tally.imported++;
    }
    return finish(entry);
  };

  let frameIndexBefore;
  {
    const store = openReadOnly(dbAbs);
    try { frameIndexBefore = Number(store.db.prepare('SELECT COUNT(*) AS n FROM frame_index').get().n); } finally { store.close(); }
  }

  try {
    for (let i = 0; i < snapshot.sources.length; i++) {
      const src = snapshot.sources[i];
      const id = identities[i];
      const entry = {
        type: 'outcome',
        index: i,
        sourcePathHash: sha(id.sourcePath),
        echoSourceId: id.echoSourceId,
        namespace: id.namespace,
        generation,
        manifestSha256: null,
        outcome: null,
        code: null,
        committedRows: 0,
        counts: {
          declaredWords: src.words.length, declaredSummaries: src.summaries.length,
          emittedWords: 0, emittedSummaries: 0, importedWords: 0, importedSummaries: 0,
          srcSeqRefs: 0, srcSeqResolved: 0, srcSeqDangling: 0,
          droppedTruncated: 0, droppedNonChatRole: 0,
        },
      };
      // ★ 逐源兜底：feed / build / import / 事后核对里任何抛出，都变成这一源的 journaled
      //   结果，而不是整批的中断（第 2 个源炸掉不该让第 1 个源的结果没人记）。
      try {
        handleSource(entry, src, id);
      } catch (err) {
        entry.outcome = 'FAILED';
        entry.code = (err && err.code) ? String(err.code) : 'SOURCE_THREW';
        entry.detail = journalSafeMessage(err, needles);
        // 库里到底有多少行：settle 只算一次（导入已落地之后才失败的源，行已经在库）。
        if (entry.settled !== true) {
          try { settle(entry, id); } catch { entry.committedRows = Number(entry.committedRows) || 0; }
        }
        tally.failed++;
        finish(entry);
      }
    }
  } catch (err) {
    // 走到这里 = journal 自己写不下去（隐私/磁盘层的硬故障）或库打不开。
    // 能写就写一条 abort 行：至少说明「已提交几源、已处理几源」。
    const abort = {
      type: 'abort',
      code: (err && err.code) ? String(err.code) : 'RUN_ABORTED',
      committedSources: committed.sources,
      committedWords: committed.words,
      processedSources: outcomes.length,
      sourceCount: snapshot.sources.length,
    };
    let journaled = false;
    try { appendLine(abort); journaled = true; } catch { journaled = false; }
    if (err && typeof err === 'object') {
      err.committedSources = committed.sources;
      err.committedWords = committed.words;
      err.abortJournaled = journaled;
    }
    throw err;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ⑥ 完整性 + 帧表没被动过 + 库面隐私（**范围限定本批**）。
  const warnings = [];
  const problems = [];
  let integrity;
  let privacy;
  let frameIndexAfter;
  let integrityInScope;
  let foreignSources = 0;
  {
    const store = openReadOnly(dbAbs);
    try {
      integrity = analyzeEchoIntegrity(store.db);
      privacy = dbPrivacyFindings(store.db, needles, scopedIds);
      frameIndexAfter = Number(store.db.prepare('SELECT COUNT(*) AS n FROM frame_index').get().n);
      foreignSources = scopedIds.length === 0
        ? Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_index_sources').get().n)
        : Number(store.db.prepare('SELECT COUNT(*) AS n FROM echo_index_sources WHERE echo_source_id NOT IN (' +
          scopedIds.map(() => '?').join(',') + ')').get(...scopedIds).n);
    } finally { store.close(); }
  }
  // analyzeEchoIntegrity 是**全库**判据（它只吃一个 db 句柄，没有按来源过滤的口子）。
  // 库里混着别人的来源时，全库结论不能归给这一批 —— 降级为 warning，不改变 ok；
  // 只有本批自己的来源（库里没有外来行，也就是真实导入的常态）才当硬门。
  integrityInScope = foreignSources === 0;
  if (integrity.ok !== true) {
    if (integrityInScope) problems.push({ kind: 'echo-integrity', problems: integrity.problems || [] });
    else warnings.push({ kind: 'echo-integrity-whole-db', foreignSources, problems: integrity.problems || [] });
  }
  if (frameIndexAfter !== frameIndexBefore) problems.push({ kind: 'frame-index-touched', before: frameIndexBefore, after: frameIndexAfter });
  if (foreignSources > 0) warnings.push({ kind: 'foreign-sources-present', count: foreignSources, note: 'whole-DB judgments are reported as warnings; per-source rows above are this batch only' });
  if (privacy.length > 0) problems.push({ kind: 'privacy', findings: privacy });

  const counts = {
    importedWords: 0, importedSummaries: 0, alreadyCurrentWords: 0, alreadyCurrentSummaries: 0,
    skippedWords: 0, skippedSummaries: 0,
    droppedTruncated: 0, droppedNonChatRole: 0,
    committedWords: 0, committedSummaries: 0, failedCommittedWords: 0,
  };
  for (const e of outcomes) {
    if (e.counts) {
      counts.droppedTruncated += Number(e.counts.droppedTruncated) || 0;
      counts.droppedNonChatRole += Number(e.counts.droppedNonChatRole) || 0;
    }
    if (e.outcome !== 'SKIPPED_EMPTY' && e.outcome !== 'SKIPPED_SUMMARY_ONLY') {
      counts.committedWords += Number(e.committedRows) || 0;
      counts.committedSummaries += Number(e.committedSummaries) || 0;
      if (e.outcome === 'FAILED') counts.failedCommittedWords += Number(e.committedRows) || 0;
    }
    if (e.outcome === 'IMPORTED') { counts.importedWords += e.counts.importedWords; counts.importedSummaries += e.counts.importedSummaries; }
    if (e.outcome === 'ALREADY_CURRENT') {
      counts.alreadyCurrentWords += (e.receipt && e.receipt.counts ? Number(e.receipt.counts.words) || 0 : 0);
      counts.alreadyCurrentSummaries += (e.receipt && e.receipt.counts ? Number(e.receipt.counts.summaries) || 0 : 0);
    }
    if (e.outcome === 'SKIPPED_EMPTY' || e.outcome === 'SKIPPED_SUMMARY_ONLY') {
      counts.skippedWords += e.counts.declaredWords; counts.skippedSummaries += e.counts.declaredSummaries;
    }
  }
  const ok = tally.refused === 0 && tally.failed === 0 && problems.length === 0;
  const summary = {
    type: 'summary',
    ok,
    sourceCount: snapshot.sources.length,
    imported: tally.imported, alreadyCurrent: tally.alreadyCurrent,
    skippedEmpty: tally.skippedEmpty, skippedSummaryOnly: tally.skippedSummaryOnly,
    refused: tally.refused, failed: tally.failed,
    counts,
    integrity: { ok: integrity.ok === true, inScope: integrityInScope, foreignSources, problems: integrity.problems || [] },
    frameIndex: { before: frameIndexBefore, after: frameIndexAfter },
    problems,
    warnings,
  };
  assertClean('journal summary', JSON.stringify(summary), needles);
  fs.appendFileSync(journalAbs, JSON.stringify(summary) + '\n');
  return { ok, journal: journalAbs, ...summary, outcomes, preflight: pre.counts, risks: pre.risks };
}

// ③ 逐源的丢行恒等式。storedWords = 库里该源的实际行数（不是「本次新写入」）。
// 同时要求 builder 自己声明的丢行总数 = 我们挑出来的两类之和 —— 否则说明
// 有一类丢弃**没被命名**，那也是账不平（未来的 builder 改了丢法，这条会先响）。
function accountRows(entry, manifestCounts) {
  const c = entry.counts;
  const stored = entry.dbRows ? Number(entry.dbRows.echo_words) || 0 : 0;
  const truncated = Number(c.droppedTruncated) || 0;
  const nonChat = Number(c.droppedNonChatRole) || 0;
  const declared = Number(c.declaredWords) || 0;
  const expected = stored + truncated + nonChat;
  const declaredDrops = Math.max(0, (Number(manifestCounts && manifestCounts.excluded) || 0) - (Number(manifestCounts && manifestCounts.excludedReasoning) || 0));
  entry.rowAccount = {
    declaredWords: declared,
    storedWords: stored,
    droppedTruncated: truncated,
    droppedNonChatRole: nonChat,
    expectedTotal: expected,
    namedDrops: truncated + nonChat,
    declaredDrops,
    balanced: declared === expected && declaredDrops === truncated + nonChat,
  };
  return entry.rowAccount.balanced;
}
// feed 文件按字节回扫，但只扫承载路径的字段（text/summary 是内容）。
function assertFeedPathFields(label, file, fields, needles) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '') continue;
    let row;
    try { row = JSON.parse(lines[i]); } catch (e) { throw refuse('FEED_INVALID', label + ' line ' + (i + 1) + ' is not JSON'); }
    for (const f of fields) assertPathField(label + ' line ' + (i + 1) + ' field ' + f, row[f], needles);
  }
}
// 错误消息进 journal 前要过同一把尺子：带路径或 sid 的消息**不落盘**（只落码 + 标记）。
// 这不是「美化」—— 消息里常有 builder 拼进去的绝对路径。
function journalSafeMessage(err, needles) {
  const raw = err && err.message ? String(err.message) : '';
  if (!raw) return null;
  const hits = pathScan(raw, needles);
  if (hits.tempRoot || hits.driveLiterals || hits.rawPaths) return { redacted: 'path' };
  if (sidScan(raw, needles) > 0) return { redacted: 'sid' };
  return { message: raw.slice(0, 300) };
}

// ── CLI ─────────────────────────────────────────────────────────────────
// 2 = 用法错（什么都没做）；3 = 写库前拒绝（一行都没落）；
// 5 = 至少一源已提交之后中断；6 = 跑完了但结果不 ok。
export const EXIT = Object.freeze({ ok: 0, usage: 2, refused: 3, abortedAfterCommit: 5, unfinished: 6 });
const FLAGS = { '--snapshot': 'snapshot', '--db': 'db', '--journal': 'journal', '--generation': 'generation', '--built-at': 'builtAt', '--allow-db': 'allowDb', '--backup-receipt': 'backupReceipt' };
// 唯一一个**不带值**的开关：它只是一个入口，条件在 assertProductionGate 里逐条判。
const BOOL_FLAGS = { '--production': 'production', '--allow-dangling-srcseq': 'allowDanglingSrcSeq' };
export function main(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const k = String(argv[i]);
    if (Object.prototype.hasOwnProperty.call(BOOL_FLAGS, k)) {
      if (opts[BOOL_FLAGS[k]] !== undefined) throw refuse('USAGE_DUPLICATE_FLAG', 'duplicate argument: ' + k);
      opts[BOOL_FLAGS[k]] = true;
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(FLAGS, k)) throw refuse('USAGE_UNKNOWN_FLAG', 'unknown argument: ' + k);
    if (opts[FLAGS[k]] !== undefined) throw refuse('USAGE_DUPLICATE_FLAG', 'duplicate argument: ' + k);
    const v = argv[i + 1];
    if (v === undefined || String(v).startsWith('--')) throw refuse('USAGE_MISSING_ARG', 'missing value for ' + k);
    opts[FLAGS[k]] = String(v);
    i++;
  }
  for (const k of ['snapshot', 'db', 'journal', 'generation', 'builtAt']) {
    if (opts[k] === undefined) throw refuse('USAGE_MISSING_ARG', 'missing required argument: --' + k);
  }
  if (!/^[0-9]+$/.test(opts.generation)) throw refuse('USAGE_BAD_GENERATION', '--generation must be a positive integer');
  // ★ 条件与入口必须一起出现：单独给 --allow-db / --backup-receipt 是**说错了**，
  //   不是"顺手写多了一个"——静默忽略它们会让调用方以为自己跑在生产模式里。
  if (!opts.production) {
    if (opts.allowDanglingSrcSeq) {
      throw refuse('USAGE_UNKNOWN_FLAG', '--allow-dangling-srcseq is only meaningful together with --production; refusing to ignore it');
    }
    for (const k of ['allowDb', 'backupReceipt']) {
      if (opts[k] !== undefined) {
        throw refuse('USAGE_UNKNOWN_FLAG', '--' + (k === 'allowDb' ? 'allow-db' : 'backup-receipt') + ' is only meaningful together with --production; refusing to ignore it');
      }
    }
  }
  const result = importSnapshot(opts.snapshot, opts.db, opts.journal, {
    generation: Number(opts.generation), builtAt: opts.builtAt,
    production: opts.production === true, allowDb: opts.allowDb, backupReceipt: opts.backupReceipt,
    allowDanglingSrcSeq: opts.production === true && opts.allowDanglingSrcSeq === true,
  });
  // CLI 只回**脱敏摘要**：没有路径、没有 sid。
  console.log(JSON.stringify({
    ok: result.ok, sourceCount: result.sourceCount, imported: result.imported,
    alreadyCurrent: result.alreadyCurrent, skippedEmpty: result.skippedEmpty,
    skippedSummaryOnly: result.skippedSummaryOnly, refused: result.refused, failed: result.failed,
    counts: result.counts, integrityOk: result.integrity.ok, integrityInScope: result.integrity.inScope,
    warnings: (result.warnings || []).map((w) => w.kind),
  }));
  return result.ok ? EXIT.ok : EXIT.unfinished;
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) {
    const code = String((e && e.code) || 'SNAPSHOT_IMPORT_REFUSED');
    const committedSources = Number(e && e.committedSources) || 0;
    const exitCode = code.indexOf('USAGE_') === 0
      ? EXIT.usage
      : (committedSources > 0 ? EXIT.abortedAfterCommit : EXIT.refused);
    console.error(JSON.stringify({ ok: false, code, committedSources, exitCode }));
    process.exitCode = exitCode;
  }
}
