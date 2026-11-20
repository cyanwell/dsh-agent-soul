// migration-011.mjs —— SQL 单独成文件。
// 理由很实际：这段 SQL 里到处是单引号与字符串字面量，直接塞进 schema.mjs 的数组里
// 会撞引号（我试过一次，构造器直接编不过）。放成模板字符串，一个引号都不用转。
export const MIGRATION_011_SQL = String.raw`
-- v11: 审计行不该随源消失（去掉 echo_source_builds 的 FK / CASCADE）。
--
-- 修的是一个设计矛盾（2026-11-17 实测撞到的）：
--   echo_source_builds 同时有
--     · FOREIGN KEY ... ON DELETE CASCADE（删源 → 连带删审计行）
--     · echo_source_builds_no_delete 触发器（不许删任何一行）
--   于是任何 echo 源都删不掉 —— 删源触发级联删除，级联又被触发器拒绝，整笔回滚
--   （ECHO_BUILD_APPEND_ONLY）。
--
-- 选哪边（爀曦 2026-11-17 授权我自己定）：去掉 CASCADE，保留只追加。
--   理由：审计行的价值恰恰是「源没了，历史还在」。跟着源一起消失，
--   它不是审计，只是一份会一起断的副本。
--   代价要写清：删掉源之后它的 builds 行成为孤儿（echo_source_id 指向已不存在的源），
--   这是被接受的 —— 审计本来就要能描述「曾经存在过什么」。
--   查审计时按 generation / 时间读，不指望 JOIN 回源表。
--
-- 12-step 重建：SQLite 改不了 FK，只能整表重建。行数极少（每源每代一行）。
CREATE TABLE echo_source_builds_v11 (
  build_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  echo_source_id  TEXT NOT NULL,
  generation      INTEGER NOT NULL CHECK (generation >= 1),
  source_sha256   TEXT NOT NULL CHECK (length(source_sha256) = 64),
  source_bytes    INTEGER NOT NULL CHECK (source_bytes >= 0),
  words_count     INTEGER NOT NULL CHECK (words_count >= 0),
  summaries_count INTEGER NOT NULL CHECK (summaries_count >= 0),
  src_seq_count   INTEGER NOT NULL CHECK (src_seq_count >= 0),
  cursor_seq      INTEGER NOT NULL CHECK (cursor_seq >= 0),
  cursor_json     TEXT NOT NULL,
  built_at        TEXT NOT NULL CHECK (length(built_at) > 0),
  imported_at     TEXT NOT NULL CHECK (length(imported_at) > 0),
  importer        TEXT NOT NULL CHECK (length(trim(importer)) > 0),
  UNIQUE (echo_source_id, generation)
);

INSERT INTO echo_source_builds_v11 (build_id, echo_source_id, generation, source_sha256, source_bytes, words_count, summaries_count, src_seq_count, cursor_seq, cursor_json, built_at, imported_at, importer)
  SELECT build_id, echo_source_id, generation, source_sha256, source_bytes, words_count, summaries_count, src_seq_count, cursor_seq, cursor_json, built_at, imported_at, importer FROM echo_source_builds;

DROP TABLE echo_source_builds;
ALTER TABLE echo_source_builds_v11 RENAME TO echo_source_builds;

-- 只追加的两把锁原样装回（DROP TABLE 会把它们一起带走）。
CREATE TRIGGER echo_source_builds_no_update BEFORE UPDATE ON echo_source_builds BEGIN SELECT RAISE(ABORT, 'ECHO_BUILD_APPEND_ONLY'); END;
CREATE TRIGGER echo_source_builds_no_delete BEFORE DELETE ON echo_source_builds BEGIN SELECT RAISE(ABORT, 'ECHO_BUILD_APPEND_ONLY'); END;
`;
