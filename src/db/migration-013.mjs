// migration-013.mjs — ECHO word dialogue/injection/other classification.
import { classifyEchoWordContent } from './echo-content-class.mjs';

export const MIGRATION_013_SQL = String.raw`
-- v13: add content classification without altering frame text, FTS rows, or pointers.
ALTER TABLE echo_words ADD COLUMN content_class TEXT NOT NULL DEFAULT 'other'
  CHECK (content_class IN ('dialogue', 'injection', 'other'));

CREATE INDEX idx_echo_words_content_class
  ON echo_words (content_class, echo_source_id, word_ord);
`;

export function backfillEchoContentClass(db) {
  const rows = db.prepare('SELECT rowid, text, role, truncated FROM echo_words ORDER BY rowid').all();
  const update = db.prepare('UPDATE echo_words SET content_class=? WHERE rowid=?');
  for (const row of rows) {
    const contentClass = classifyEchoWordContent({ text: row.text, role: row.role, truncated: Number(row.truncated) === 1 });
    update.run(contentClass, Number(row.rowid));
  }
  return { rows: rows.length };
}
