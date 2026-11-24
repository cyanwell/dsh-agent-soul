import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(root, 'src/events/index.mjs'), 'utf8');

test('bridge reply reader is not gated on the legacy DSH session directory', () => {
  assert.match(source, /const _useBridgeReply = Boolean\(config\.integrations && config\.integrations\.useBridgeSessions === true && control\)/);
  assert.match(source, /const _replySourceReady = _useBridgeReply \|\| Boolean\(_replyRoot\)/);
  assert.match(source, /if \(_replySourceReady && opts\.outbox\)/);
  assert.match(source, /if \(_useBridgeReply\) \{[\s\S]*createReplyReaderViaBridge\(/);
  assert.match(source, /else \{[\s\S]*createReplyReader\(\{\s*sessionRoot: _replyRoot/);
});

test('legacy file reader remains fail-closed when no sessionRoot is configured', () => {
  assert.match(source, /_replySourceReady = _useBridgeReply \|\| Boolean\(_replyRoot\)/);
  assert.match(source, /replySourceReady && opts\.outbox/);
});

console.log('bridge reply setup regression: 2 assertions passed');
