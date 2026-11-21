import fs from 'node:fs';

export function decideEchoLiveStart({ enabled, readOnly, sourceRoot, dbPath, dataDir }) {
  if (!enabled) return { start: false, reason: 'disabled' };
  if (readOnly) return { start: false, reason: 'read-only' };
  if (!sourceRoot) return { start: false, reason: 'source-unconfigured' };
  if (!fs.existsSync(sourceRoot)) return { start: false, reason: 'source-missing', path: sourceRoot };
  const targetDb = dbPath || (dataDir ? `${dataDir}/meta.sqlite` : '');
  if (!targetDb) return { start: false, reason: 'database-unconfigured' };
  if (!fs.existsSync(targetDb)) return { start: false, reason: 'database-missing', path: targetDb };
  return { start: true, sourceRoot, dbPath: targetDb };
}
