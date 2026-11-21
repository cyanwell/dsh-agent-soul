// migration-012.mjs —— 句子级窗口向量（第二套）。SQL 单独成文件，理由见 migration-011.mjs 头注释。
export const MIGRATION_012_SQL = String.raw`
-- v12: 句子级窗口向量（第二套），与长文本向量（echo_word_vectors）并存。
--
-- ★ 为什么要两套（爀曦 2026-11-18 定）：
--   「改成两套，一套是长文本、一套是句子级窗口……长文本的向量语义适合做结论提炼，
--     句子级窗口可以用来做快速检索的语义」
--
--   长文本一套（已有 echo_word_vectors）：一个词 = 一个向量。
--     它的用途是「这一段在讲什么」—— 适合结论提炼、话题归类。
--     代价：一个 3,895 字的段落压成 512 维，语义被摊平成「平均话题」，
--     拿它做精确检索必然召回到一大片泛泛相关的东西。
--   句子级一套（本表）：一句话（或几个短句组成的窗口）= 一个向量。
--     它的用途是「哪一句真的说了这件事」—— 适合快速精确定位。
--
-- ★ 为什么不塞进 echo_word_vectors（加个 granularity 列就够了吗？不够）：
--   那张表的主键是 (echo_source_id, word_ord, model_key) —— 一个词只能有一行。
--   句子级一个词会产生 N 个窗口，主键直接撞死。
--   硬塞就得改主键，而改主键要重建表 + 迁移既有向量 —— 代价远大于新建一张表。
--
-- ★★ 冷事实（2026-11-18 实测，写在这里免得下次又算一遍）：
--   echo_words 里 122,630 行 / 455.5 MB，其中 **67,509 行 / 412.4 MB（90.5% 字符）是注入块**
--   （system-reminder / Current runtime context / Instructions from / Image-gen workbench）。
--   真正的人话只有 55,121 行 / 43.1 MB。
--   给注入块建窗口向量 = 用 90% 的算力给同一段模板建几万份近乎相同的向量，
--   而且检索时它们会淹没真实结果。所以本表的 writer **默认跳过注入块**，
--   是否收录由调用方显式决定（详见 tools/echo-window-vectorize.mjs 的 --include-injected）。
--
-- ★ 陈旧检测的口径（与 echo_word_vectors 一致，别另发明一套）：
--   source_content_hash 记的是「建向量时那个 word 的 content_hash」。
--   它和 echo_words.content_hash 不一致 = 词被改过 = 向量作废，必须拒用。

CREATE TABLE echo_word_windows (
  echo_source_id      TEXT NOT NULL,
  word_ord            INTEGER NOT NULL CHECK (word_ord >= 0),
  window_ord          INTEGER NOT NULL CHECK (window_ord >= 0),
  model_key           TEXT NOT NULL,
  -- 窗口在原文里的字符位置（含头不含尾）。★ 有它才能「命中哪一句」→ 回原文那一段。
  char_start          INTEGER NOT NULL CHECK (char_start >= 0),
  char_end            INTEGER NOT NULL CHECK (char_end > char_start),
  -- 窗口文本自身的指纹：同一段文字重复出现时不重复算（也可能用来跨 word 去重）。
  window_text_sha256  TEXT NOT NULL CHECK (length(window_text_sha256) = 64),
  -- 建向量时那个 word 的内容指纹（陈旧检测用）。
  source_content_hash TEXT NOT NULL CHECK (length(source_content_hash) = 64),
  vector_dimension    INTEGER NOT NULL CHECK (vector_dimension > 0),
  vector_blob         BLOB NOT NULL,
  vector_sha256       TEXT NOT NULL CHECK (length(vector_sha256) = 64),
  created_at          TEXT NOT NULL,
  PRIMARY KEY (echo_source_id, word_ord, window_ord, model_key),
  FOREIGN KEY (echo_source_id) REFERENCES echo_index_sources(echo_source_id) ON DELETE CASCADE
);

-- 按 source + model 扫窗口（检索主路径：先取该源该模型的全部窗口再算余弦）。
CREATE INDEX echo_word_windows_by_source_model
  ON echo_word_windows (echo_source_id, model_key, word_ord, window_ord);

-- ★ 不建 echo_word_windows 的 FTS：窗口的「词面检索」由 echo_words_fts 承担
--   （同一段文字，只是切法不同）。给同一批文本再建一张 FTS = 存两遍 + 两条真相。
`;
