-- 墨的统一账本 schema（统合：文件账本 → sqlite）
-- ============================================================================
-- ★ 爀曦 2026-11-12 定：**「统合」不是「退役」** —— 架构不变、底层换 sqlite。
--   而这条定调里有一件必须跟着搬的东西：**promise 的写入闸门**。
--
--   现在它在 JS 层（mo.mjs）：读「墨」最后一条 lead 的署名，不等于当前会话就 exit 3。
--   ★ 问题：**闸门在应用层，就只挡住"走应用层"的写。** 直接 sqlite insert 就绕过去了。
--     而统合之后账本就在 sqlite 里 —— 绕过它比绕过文件容易得多。
--
--   所以搬到 SQL 层：用**触发器**。数据库自己拒绝，不依赖任何调用方守规矩。
-- ============================================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 账本：只追加。**没有 UPDATE / DELETE 触发器，而是用 TRIGGER 直接禁止** ——
-- 因为"只追加"是这个账本的命脉（多写者环境下共享可变文件是万恶之源）。
CREATE TABLE IF NOT EXISTS ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  t          TEXT NOT NULL,                 -- 本地 ISO 时间
  type       TEXT NOT NULL,
  text       TEXT NOT NULL,
  by         TEXT NOT NULL,                 -- 署名会话 id
  ref        TEXT,
  feel       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (type IN ('lead','promise','fact','shelved','gain','loss','persona','container')),
  -- ★ 空署名一律拒：署成 unknown 看着像正常值，其实追溯线索断了
  CHECK (length(trim(by)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_ledger_type_t ON ledger(type, t);
CREATE INDEX IF NOT EXISTS idx_ledger_by       ON ledger(by);

-- ── 只追加：禁止改、禁止删 ──────────────────────────────────────
CREATE TRIGGER IF NOT EXISTS ledger_no_update
BEFORE UPDATE ON ledger
BEGIN
  SELECT RAISE(ABORT, '墨是只追加账本：不许 UPDATE');
END;

CREATE TRIGGER IF NOT EXISTS ledger_no_delete
BEFORE DELETE ON ledger
BEGIN
  SELECT RAISE(ABORT, '墨是只追加账本：不许 DELETE');
END;

-- ── ★★ promise 闸门（从 JS 层搬上来）──────────────────────────────
--
--   判据和 mo.mjs 完全一致：**当前写入者必须等于「最后一条 lead 的署名者」**。
--   ★ 顺序要有说明：先取"最后一条 lead"再比 —— 如果连一条 lead 都没有，
--     子查询返回 NULL，比较结果为 NULL（不是 TRUE），于是 **不拦**。
--     那是个洞：没有 lead 时任何器官都能写 promise。
--     所以要用 COALESCE + 显式判空，**没有 lead 就一律拒**。
CREATE TRIGGER IF NOT EXISTS ledger_promise_gate
BEFORE INSERT ON ledger
WHEN NEW.type = 'promise'
BEGIN
  SELECT RAISE(ABORT, 'promise 只有主导会话能写：账本里还没有任何 lead 记录，无法判定谁是脑')
  WHERE (SELECT COUNT(*) FROM ledger WHERE type = 'lead') = 0;

  SELECT RAISE(ABORT, 'promise 只有主导会话能写：本次署名不是最后一条 lead 的署名者')
  WHERE NEW.by <> (
    SELECT l.by FROM ledger l
    WHERE l.type = 'lead'
    ORDER BY l.t DESC, l.id DESC
    LIMIT 1
  );
END;

-- ── lead 必须自带世代自述（正文里要有「第 N 代」）────────────────
--   ★ 这条也是从约定搬成断言：文档里写着"必须"，但没东西拦着。
CREATE TRIGGER IF NOT EXISTS ledger_lead_needs_generation
BEFORE INSERT ON ledger
WHEN NEW.type = 'lead'
BEGIN
  SELECT RAISE(ABORT, 'lead 正文必须含「第 N 代 · 接手于 …」（世代自述）')
  WHERE NEW.text NOT LIKE '%代%';
END;
