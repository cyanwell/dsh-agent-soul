// Compatibility CLI entry. Importing this module is inert.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkDirectMainPreflight } from './util/direct-main-preflight.mjs';

const isDirectMain = Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectMain) {
  const preflightRequested = process.env.AGENT_SOUL_PREFLIGHT !== undefined;
  if (!preflightRequested) {
    await import('./core-entry.mjs');
  } else {
    const preflight = await checkDirectMainPreflight();
    if (!preflight.ok) {
      console.error(`[agent-soul] direct-main preflight rejected: ${preflight.code}`);
      process.exitCode = 1;
    } else {
      process.env.AGENT_SOUL_PREFLIGHT_CONFIG = preflight.paths.configFile;
      process.env.AGENT_SOUL_PREFLIGHT_SYNC_ROOT = preflight.paths.syncSourceRoot;
      await import('./core-entry.mjs');
    }
  }
}
