#!/usr/bin/env node
// T-SNAP-1 selftest. Builds only synthetic trees under os.tmpdir(); it never reads the
// production index, DB, session logs, ledger, config, or any secret material.
// Run: node tools/echo-index-freeze-selftest.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runFreeze, computeSnapshotDigest, FORMAT, GLOBAL_FILES } from './echo-index-freeze.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// The suite must never create anything outside the real temp directory. If the environment
// hands os.tmpdir() a relative value (a stripped process does exactly that), stop instead of
// scattering synthetic trees under the working directory.
const TMP = os.tmpdir();
if (!path.isAbsolute(TMP) || !fs.existsSync(TMP)) {
  process.stderr.write(
    'ENV os.tmpdir() is not an absolute existing directory: ' + JSON.stringify(TMP) + '\n',
  );
  process.exit(2);
}
const TOOL = path.join(HERE, 'echo-index-freeze.mjs');
const CHILD_ENV = { ...process.env, TEMP: TMP, TMP: TMP };
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

let pass = 0;
const failures = [];
const skips = [];

function ok(name) {
  pass += 1;
  process.stdout.write(`PASS ${name}\n`);
}
function fail(name, detail) {
  failures.push(name + ': ' + detail);
  process.stdout.write(`FAIL ${name}: ${detail}\n`);
}
function skip(name, why) {
  skips.push(name + ': ' + why);
  process.stdout.write(`SKIP ${name}: ${why}\n`);
}
function check(name, cond, detail) {
  if (cond) ok(name);
  else fail(name, detail || 'assertion failed');
}

const roots = [];
function mkRoot(label) {
  const base = fs.mkdtempSync(path.join(TMP, 'echo-freeze-st-' + label + '-'));
  roots.push(base);
  return base;
}
function rmRoot(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    // leftover temp dirs are acceptable
  }
}
function writeTree(root, spec) {
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
}

// A source tree plus the files.jsonl bytes it declares. 'outsideFile' points at a path that
// does not exist: if the tool ever opened the session-log field, the run would fail.
function makeSource(label, opts = {}) {
  const root = mkRoot(label);
  const shards = opts.shards ?? [
    { name: 'shards/s1.sum.jsonl', body: '{"seq":1,"summary":"alpha"}\n' },
    { name: 'shards/s1.word.jsonl', body: '{"seq":1,"text":"beta"}\n{"seq":2,"text":"gamma"}\n' },
    { name: 'shards/s2.sum.jsonl', body: '{"seq":9,"summary":"delta"}\n' },
  ];
  const rows = shards.map((s, i) => ({
    file: 'Z:/definitely/not/a/readable/session-' + i + '.jsonl.zstd',
    key: '1000' + i + ':1',
    nextByte: 10 + i,
    ws: 'ws-' + i,
    sid: 'session-' + i,
    nSum: 1,
    nWord: 1,
    sumOut: path.join(root, s.name.replace(/\.sum\.jsonl$/, '.sum.jsonl')),
    wordOut: path.join(root, s.name.replace(/\.word\.jsonl$/, '.word.jsonl')),
  }));
  const filesBody = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const spec = {
    'files.jsonl': filesBody,
    'words.jsonl': '{"seq":1,"text":"one"}\n{"seq":2,"text":"two"}\n',
    'summaries.jsonl': '{"cmpId":"c1","summary":"one"}\n',
  };
  for (const s of shards) spec[s.name] = s.body;
  if (opts.extra) Object.assign(spec, opts.extra);
  writeTree(root, spec);
  return { root, filesSha: sha256(Buffer.from(filesBody)), shards };
}

function outDir(label) {
  const base = mkRoot('out-' + label);
  return path.join(base, 'snap');
}

function fingerprintTree(root) {
  const out = {};
  const walk = (dir, prefix) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, ent.name);
      const rel = prefix ? prefix + '/' + ent.name : ent.name;
      if (ent.isDirectory()) {
        out[rel + '/'] = 'dir';
        walk(abs, rel);
      } else {
        const st = fs.lstatSync(abs);
        out[rel] = sha256(fs.readFileSync(abs)) + ':' + st.size + ':' + Math.trunc(st.mtimeMs);
      }
    }
  };
  walk(root, '');
  return out;
}

function sameFingerprint(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i] || a[ka[i]] !== b[kb[i]]) return false;
  return true;
}

async function expectRefusal(name, args, expectedCode, opts = {}) {
  const lines = [];
  try {
    const result = await runFreeze({
      argv: args,
      log: (l) => lines.push(l),
      hooks: opts.hooks,
      allowedSourceRoot: opts.allowedSourceRoot,
    });
    fail(name, 'expected refusal but run succeeded: ' + JSON.stringify(result));
    return { lines };
  } catch (error) {
    if (error && error.code === expectedCode) {
      ok(name);
      return { lines, error };
    }
    fail(name, `expected ${expectedCode}, got ${error && error.code}: ${error && error.message}`);
    return { lines, error };
  }
}

// ---------------------------------------------------------------------------
// 0. static guard: the snapshotter must not import or touch forbidden surfaces
const staticSrc = fs.readFileSync(TOOL, 'utf8');
const codeOnly = staticSrc
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((l) => (l.trim().startsWith('//') ? '' : l))
  .join('\n');

const imports = [...codeOnly.matchAll(/^import[^;]*from\s+'([^']+)';/gm)].map((m) => m[1]);
const badImport = imports.filter((m) => !/^node:(fs|os|path|crypto|events|url)$/.test(m));
check('static/imports-node-only', badImport.length === 0, 'unexpected imports: ' + badImport.join(','));

const forbidden = [
  'child_process',
  'spawnSync',
  'execFile',
  'sqlite',
  'better-sqlite3',
  'src/db',
  'meta.sqlite',
  '02-\u58a8',
  'credentials',
  'config.json',
  'process.env',
  'fetch(',
  'net/',
  'echo-source-build',
  'echo-index-import',
  'rebuild-index',
];
const hits = forbidden.filter((f) => codeOnly.includes(f));
check('static/no-forbidden-calls', hits.length === 0, 'found: ' + hits.join(','));
check(
  'static/cli-pinned-to-allowed-root',
  /allowedRoot\s*=\s*options\.allowedSourceRoot\s*\?\?\s*ALLOWED_SOURCE_ROOT/.test(codeOnly) &&
    !/--source-root[^\n]*override/i.test(codeOnly),
  'CLI must not allow an external source-root override',
);
check('static/format-declared', FORMAT === 'echo-index-freeze/v1', 'unexpected format tag');
check(
  'static/globals-fixed',
  GLOBAL_FILES.map((g) => g.rel).join(',') === 'files.jsonl,words.jsonl,summaries.jsonl',
  'global file set changed',
);

// ---------------------------------------------------------------------------
// 1. usage refusals
{
  const src = makeSource('usage');
  await expectRefusal('usage/missing-args', [], 'E_USAGE');
  await expectRefusal(
    'usage/bad-hash',
    ['--source-root', src.root, '--out', outDir('u1'), '--expected-sha256', 'nothex'],
    'E_BAD_EXPECTED_HASH',
  );
  await expectRefusal(
    'usage/unknown-arg',
    ['--source-root', src.root, '--out', outDir('u2'), '--expected-sha256', src.filesSha, '--db', 'x'],
    'E_UNKNOWN_ARG',
  );
}

// ---------------------------------------------------------------------------
// 2. happy path: exact hash, copied bytes, manifest shape, digest
{
  const src = makeSource('happy');
  const before = fingerprintTree(src.root);
  const out = outDir('happy');
  const lines = [];
  const result = await runFreeze({
    argv: ['--source-root', src.root, '--out', out, '--expected-sha256', src.filesSha],
    allowedSourceRoot: src.root,
    log: (l) => lines.push(l),
  });
  check('happy/exit-ok', result.ok === true && result.exitCode === 0, 'run did not succeed');
  check('happy/out-created', fs.existsSync(out), 'snapshot dir missing');
  const manifestPath = path.join(out, 'manifest.json');
  check('happy/manifest-exists', fs.existsSync(manifestPath), 'manifest.json missing');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  check('happy/format', manifest.format === FORMAT, 'bad format tag');
  check('happy/complete-flag-absent-but-counted', manifest.fileCount === manifest.files.length, 'fileCount mismatch');

  // every copied file must be byte-identical to its source
  let bytesOk = true;
  let hashOk = true;
  for (const f of manifest.files) {
    const srcAbs = path.join(src.root, f.path);
    const outAbs = path.join(out, f.path);
    if (!fs.existsSync(outAbs)) {
      bytesOk = false;
      continue;
    }
    const srcBuf = fs.readFileSync(srcAbs);
    const outBuf = fs.readFileSync(outAbs);
    if (!srcBuf.equals(outBuf)) bytesOk = false;
    if (sha256(outBuf) !== f.sha256) hashOk = false;
    if (outBuf.length !== f.bytes) bytesOk = false;
    if (!Number.isInteger(f.mtimeMs) || typeof f.mtime !== 'string') hashOk = false;
  }
  check('happy/copied-shard-bytes-identical', bytesOk, 'copied bytes differ from source');
  check('happy/per-file-sha256-and-mtime', hashOk, 'manifest hash/byte/mtime mismatch');

  check(
    'happy/files-jsonl-hash-matches-expected',
    manifest.files.some((f) => f.path === 'files.jsonl' && f.sha256 === src.filesSha),
    'files.jsonl hash not recorded as expected',
  );

  const rels = manifest.files.map((f) => f.path);
  check(
    'happy/paths-relative-posix-and-sorted',
    rels.every((r) => !path.isAbsolute(r) && !r.includes('\\') && !r.startsWith('../') && !r.includes(':')) &&
      rels.join(',') === [...rels].sort().join(','),
    'manifest paths are not sorted posix-relative: ' + rels.join(','),
  );
  check(
    'happy/all-declared-shards-copied',
    src.shards.every((s) => rels.includes(s.name.replace(/\\/g, '/'))),
    'a declared shard was not copied',
  );
  check('happy/digest-recomputes', computeSnapshotDigest(manifest.files) === manifest.snapshotDigest, 'digest mismatch');
  check('happy/digest-matches-run', result.digest === manifest.snapshotDigest, 'run digest differs from manifest');

  const logText = lines.join('\n');
  const leaksAbsSource = logText.includes(src.root) || logText.includes(src.root.replace(/\\/g, '/'));
  check('happy/logs-avoid-absolute-source-paths', !leaksAbsSource, 'stdout leaked the absolute source root');
  check('happy/logs-no-raw-content', !/alpha|beta|gamma|delta/.test(logText), 'stdout leaked file content');
  check('happy/source-tree-unchanged', sameFingerprint(before, fingerprintTree(src.root)), 'source tree mutated');
}

// ---------------------------------------------------------------------------
// 3. wrong expected hash: refuse before creating anything
{
  const src = makeSource('badhash');
  const out = outDir('badhash');
  await expectRefusal(
    'hash/mismatch-refused',
    ['--source-root', src.root, '--out', out, '--expected-sha256', 'f'.repeat(64)],
    'E_EXPECTED_HASH_MISMATCH',
    { allowedSourceRoot: src.root },
  );
  check('hash/no-output-created', !fs.existsSync(out), 'snapshot dir created despite hash mismatch');
}

// ---------------------------------------------------------------------------
// 4. concurrent mutation between copy and re-verify (hook seam)
{
  const src = makeSource('mutation');
  const before = fingerprintTree(src.root);
  const out = outDir('mutation');
  const lines = [];
  const res = await expectRefusal(
    'mutation/detected-and-refused',
    ['--source-root', src.root, '--out', out, '--expected-sha256', src.filesSha],
    'E_SOURCE_CHANGED_CONTENT',
    {
      allowedSourceRoot: src.root,
      hooks: {
        beforeRehash: () => {
          fs.appendFileSync(path.join(src.root, 'shards/s2.sum.jsonl'), '{"seq":10,"summary":"late"}\n');
        },
      },
    },
  );
  check('mutation/snapshot-deleted', !fs.existsSync(out), 'snapshot not removed after mutation');
  check('mutation/logs-present-before-failure', res.lines.length > 0, 'nothing logged before failure');

  // same seam, but mutating the global words file and restoring content only (mtime moves)
  const src2 = makeSource('mutation-mtime');
  const out2 = outDir('mutation-mtime');
  await expectRefusal(
    'mutation/mtime-only-change-refused',
    ['--source-root', src2.root, '--out', out2, '--expected-sha256', src2.filesSha],
    'E_SOURCE_CHANGED_MTIME',
    {
      allowedSourceRoot: src2.root,
      hooks: {
        beforeRehash: () => {
          const target = path.join(src2.root, 'words.jsonl');
          const buf = fs.readFileSync(target);
          fs.writeFileSync(target, buf);
          const future = new Date(Date.now() + 5000);
          fs.utimesSync(target, future, future);
        },
      },
    },
  );
  check('mutation/mtime-snapshot-deleted', !fs.existsSync(out2), 'snapshot not removed after mtime change');
  void before;
}

// ---------------------------------------------------------------------------
// 5. non-empty output rejected, existing content untouched
{
  const src = makeSource('nonempty');
  const out = outDir('nonempty');
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'keep.txt'), 'keep');
  await expectRefusal(
    'out/non-empty-refused',
    ['--source-root', src.root, '--out', out, '--expected-sha256', src.filesSha],
    'E_OUT_NOT_EMPTY',
    { allowedSourceRoot: src.root },
  );
  check(
    'out/non-empty-content-untouched',
    fs.readFileSync(path.join(out, 'keep.txt'), 'utf8') === 'keep' && fs.readdirSync(out).length === 1,
    'pre-existing output content was modified',
  );
}

// ---------------------------------------------------------------------------
// 6. output outside os.tmpdir rejected
{
  const src = makeSource('outside');
  const home = os.homedir();
  const escapeTmp = path.join(home, 'echo-freeze-should-not-exist');
  await expectRefusal(
    'out/outside-tmp-refused',
    ['--source-root', src.root, '--out', escapeTmp, '--expected-sha256', src.filesSha],
    'E_OUT_OUTSIDE_TMP',
    { allowedSourceRoot: src.root },
  );
  check('out/outside-tmp-not-created', !fs.existsSync(escapeTmp), 'refused output path was created');

  // traversal out of tmp
  const traversal = path.join(TMP, 'echo-freeze-st-out', '..', '..', 'echo-freeze-escape');
  await expectRefusal(
    'out/traversal-refused',
    ['--source-root', src.root, '--out', traversal, '--expected-sha256', src.filesSha],
    'E_OUT_OUTSIDE_TMP',
    { allowedSourceRoot: src.root },
  );
}

// ---------------------------------------------------------------------------
// 7. output inside the source root rejected
{
  const src = makeSource('inside');
  await expectRefusal(
    'out/inside-source-refused',
    ['--source-root', src.root, '--out', path.join(src.root, 'snap'), '--expected-sha256', src.filesSha],
    'E_OUT_INSIDE_SOURCE',
    { allowedSourceRoot: src.root },
  );
  check('out/inside-source-not-created', !fs.existsSync(path.join(src.root, 'snap')), 'in-source snapshot created');
}

// ---------------------------------------------------------------------------
// 8. shard declared outside the root rejected
{
  const src = makeSource('escape');
  const outsideAbs = path.join(path.dirname(src.root), 'outside-shard.sum.jsonl');
  fs.writeFileSync(outsideAbs, '{"seq":1}\n');
  const rows = [
    {
      file: 'Z:/nope/session-x.jsonl.zstd',
      key: '1:1',
      nextByte: 1,
      ws: 'w',
      sid: 's',
      nSum: 1,
      nWord: 1,
      sumOut: outsideAbs,
      wordOut: path.join(src.root, 'shards/s1.word.jsonl'),
    },
  ];
  const body = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(path.join(src.root, 'files.jsonl'), body);
  const out = outDir('escape');
  await expectRefusal(
    'shard/outside-root-refused',
    ['--source-root', src.root, '--out', out, '--expected-sha256', sha256(Buffer.from(body))],
    'E_SHARD_OUTSIDE_ROOT',
    { allowedSourceRoot: src.root },
  );
  check('shard/outside-root-no-output', !fs.existsSync(out), 'snapshot created despite out-of-root shard');
  try {
    fs.rmSync(outsideAbs, { force: true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// 9. traversal shard name refused
{
  const src = makeSource('traversal');
  const body =
    JSON.stringify({
      file: 'Z:/nope/s.jsonl.zstd',
      key: '1:1',
      nextByte: 1,
      ws: 'w',
      sid: 's',
      nSum: 1,
      nWord: 1,
      sumOut: path.join(src.root, '..', 'escaped.sum.jsonl'),
      wordOut: path.join(src.root, 'shards/s1.word.jsonl'),
    }) + '\n';
  fs.writeFileSync(path.join(src.root, 'files.jsonl'), body);
  await expectRefusal(
    'shard/traversal-refused',
    ['--source-root', src.root, '--out', outDir('trav'), '--expected-sha256', sha256(Buffer.from(body))],
    'E_SHARD_OUTSIDE_ROOT',
    { allowedSourceRoot: src.root },
  );
}

// ---------------------------------------------------------------------------
// 10. missing declared shard refused
{
  const src = makeSource('missing');
  const ghost = path.join(src.root, 'shards', 'ghost.sum.jsonl');
  const body =
    JSON.stringify({
      file: 'Z:/nope/s.jsonl.zstd',
      key: '1:1',
      nextByte: 1,
      ws: 'w',
      sid: 's',
      nSum: 1,
      nWord: 1,
      sumOut: ghost,
      wordOut: path.join(src.root, 'shards/s1.word.jsonl'),
    }) + '\n';
  fs.writeFileSync(path.join(src.root, 'files.jsonl'), body);
  const out = outDir('missing');
  await expectRefusal(
    'shard/missing-refused',
    ['--source-root', src.root, '--out', out, '--expected-sha256', sha256(Buffer.from(body))],
    'E_SOURCE_MISSING',
    { allowedSourceRoot: src.root },
  );
  check('shard/missing-no-output', !fs.existsSync(out), 'snapshot created despite missing shard');
}

// ---------------------------------------------------------------------------
// 11. non-jsonl source refused
{
  const src = makeSource('ext');
  const body =
    JSON.stringify({
      file: 'Z:/nope/s.jsonl.zstd',
      key: '1:1',
      nextByte: 1,
      ws: 'w',
      sid: 's',
      nSum: 1,
      nWord: 1,
      sumOut: path.join(src.root, 'shards', 'evil.txt'),
      wordOut: path.join(src.root, 'shards/s1.word.jsonl'),
    }) + '\n';
  fs.writeFileSync(path.join(src.root, 'shards', 'evil.txt'), 'x');
  fs.writeFileSync(path.join(src.root, 'files.jsonl'), body);
  await expectRefusal(
    'shard/non-jsonl-refused',
    ['--source-root', src.root, '--out', outDir('ext'), '--expected-sha256', sha256(Buffer.from(body))],
    'E_BAD_SHARD_PATH',
    { allowedSourceRoot: src.root },
  );
}

// ---------------------------------------------------------------------------
// 12. link escape refused. A file symlink needs privilege on Windows; a directory
// junction does not, so at least one of the two always exercises the guard. If neither
// primitive exists the gap is reported as SKIP rather than silently skipped.
function declareSum(rootAbs, sumAbs) {
  const body =
    JSON.stringify({
      file: 'Z:/nope/s.jsonl.zstd',
      key: '1:1',
      nextByte: 1,
      ws: 'w',
      sid: 's',
      nSum: 1,
      nWord: 1,
      sumOut: sumAbs,
      wordOut: path.join(rootAbs, 'shards/s1.word.jsonl'),
    }) + '\n';
  fs.writeFileSync(path.join(rootAbs, 'files.jsonl'), body);
  return sha256(Buffer.from(body));
}

{
  const src = makeSource('link');
  const outsideDir = mkRoot('link-target');
  const outsideFile = path.join(outsideDir, 'linked.sum.jsonl');
  fs.writeFileSync(outsideFile, '{"seq":1}\n');
  const linkPath = path.join(src.root, 'shards', 'link.sum.jsonl');

  let mode = null;
  try {
    fs.symlinkSync(outsideFile, linkPath, 'file');
    mode = 'file-symlink';
  } catch {
    mode = null;
  }
  if (mode === null) {
    // Fall back to a directory junction that carries the escape one level up.
    const junction = path.join(src.root, 'linked');
    try {
      fs.symlinkSync(outsideDir, junction, 'junction');
      const viaJunction = path.join(junction, 'linked.sum.jsonl');
      const digest = declareSum(src.root, viaJunction);
      const outJ = outDir('link-junction');
      await expectRefusal(
        'shard/junction-escape-refused',
        ['--source-root', src.root, '--out', outJ, '--expected-sha256', digest],
        'E_SOURCE_SYMLINK',
        { allowedSourceRoot: src.root },
      );
      check('shard/junction-escape-no-output', !fs.existsSync(outJ), 'snapshot created through a junction escape');
      mode = 'junction';
    } catch (error) {
      skip(
        'shard/link-escape-refused',
        'neither file symlink nor directory junction could be created: ' + (error && error.code),
      );
    }
  }
  if (mode === 'file-symlink') {
    const digest = declareSum(src.root, linkPath);
    const outL = outDir('link');
    await expectRefusal(
      'shard/symlink-refused',
      ['--source-root', src.root, '--out', outL, '--expected-sha256', digest],
      'E_SOURCE_SYMLINK',
      { allowedSourceRoot: src.root },
    );
    check('shard/symlink-no-output', !fs.existsSync(outL), 'snapshot created through a symlink escape');
  }
}

// ---------------------------------------------------------------------------
// 13. source root pinning: a different root is refused
{
  const src = makeSource('pin');
  await expectRefusal(
    'root/other-root-refused',
    ['--source-root', src.root, '--out', outDir('pin'), '--expected-sha256', src.filesSha],
    'E_SOURCE_ROOT_NOT_ALLOWED',
    {},
  );
}

// ---------------------------------------------------------------------------
// 14. empty pre-existing output directory is accepted, and reused in place
{
  const src = makeSource('emptyout');
  const out = outDir('emptyout');
  fs.mkdirSync(out, { recursive: true });
  const result = await runFreeze({
    argv: ['--source-root', src.root, '--out', out, '--expected-sha256', src.filesSha],
    allowedSourceRoot: src.root,
    log: () => {},
  });
  check('out/empty-dir-accepted', result.ok === true, 'empty pre-existing out was rejected');
  check('out/empty-dir-now-has-manifest', fs.existsSync(path.join(out, 'manifest.json')), 'manifest missing');
}

// ---------------------------------------------------------------------------
// 15. real entry point: pinning, usage and help exit codes (no production reads)
{
  const src = makeSource('cli');
  const out = outDir('cli');
  const r1 = spawnSync(process.execPath, [TOOL, '--source-root', src.root, '--out', out, '--expected-sha256', src.filesSha], {
    encoding: 'utf8',
    env: CHILD_ENV,
  });
  check(
    'cli/pinned-root-refused-at-entrypoint',
    r1.status === 3 && /REFUSED E_SOURCE_ROOT_NOT_ALLOWED/.test(r1.stderr || '') && (r1.stdout || '') === '',
    `status=${r1.status} stdout=${JSON.stringify((r1.stdout || '').slice(0, 200))} stderr=${JSON.stringify((r1.stderr || '').slice(0, 200))}`,
  );
  check('cli/pinned-refusal-created-nothing', !fs.existsSync(out), 'entrypoint refusal created the output directory');

  const r2 = spawnSync(process.execPath, [TOOL], { encoding: 'utf8', env: CHILD_ENV });
  check(
    'cli/usage-exit-2',
    r2.status === 2 && /REFUSED E_USAGE/.test(r2.stderr || ''),
    `status=${r2.status} stderr=${JSON.stringify((r2.stderr || '').slice(0, 200))}`,
  );

  const r3 = spawnSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8', env: CHILD_ENV });
  check(
    'cli/help-exit-0',
    r3.status === 0 && /usage: echo-index-freeze\.mjs/.test(r3.stdout || ''),
    `status=${r3.status} stdout=${JSON.stringify((r3.stdout || '').slice(0, 200))}`,
  );
}

// ---------------------------------------------------------------------------
// 16. degraded environment: os.tmpdir() returns a relative path -> fail closed, write nothing
{
  const src = makeSource('reltmp');
  const probeDir = fs.mkdtempSync(path.join(TMP, 'echo-freeze-st-reltmp-'));
  roots.push(probeDir);
  const probe = path.join(probeDir, 'probe.mjs');
  const toolUrl = 'file:///' + TOOL.replace(/\\/g, '/');
  fs.writeFileSync(
    probe,
    `import { runFreeze } from '${toolUrl}';\n` +
      `const rootArg = process.argv[2];\n` +
      `const argv = process.argv.slice(3);\n` +
      `try {\n` +
      `  await runFreeze({ argv, allowedSourceRoot: rootArg, log: () => {} });\n` +
      `  process.stdout.write('NO_REFUSAL\\n');\n` +
      `  process.exitCode = 9;\n` +
      `} catch (error) {\n` +
      `  process.stdout.write('CODE ' + (error && error.code) + '\\n');\n` +
      `  process.exitCode = 0;\n` +
      `}\n`,
  );
  const out = path.join(probeDir, 'snap');
  const rel = spawnSync(
    process.execPath,
    [probe, src.root, '--source-root', src.root, '--out', out, '--expected-sha256', src.filesSha],
    { encoding: 'utf8', cwd: probeDir, env: { TEMP: 'reltemp', TMP: 'reltemp' } },
  );
  check(
    'env/relative-tmpdir-fails-closed',
    rel.status === 0 && /CODE E_NO_TMPDIR/.test(rel.stdout || ''),
    `status=${rel.status} stdout=${JSON.stringify((rel.stdout || '').slice(0, 200))} stderr=${JSON.stringify((rel.stderr || '').slice(0, 300))}`,
  );
  check(
    'env/relative-tmpdir-wrote-nothing',
    !fs.existsSync(out) && !fs.existsSync(path.join(probeDir, 'reltemp')),
    'a relative tmpdir caused output to be written relative to the working directory',
  );
}

// ---------------------------------------------------------------------------
for (const r of roots) rmRoot(r);

const summary =
  `T-SNAP-1 selftest: ${pass} passed, ${failures.length} failed, ${skips.length} skipped`;
process.stdout.write(summary + '\n');
for (const f of failures) process.stdout.write('  FAILED ' + f + '\n');
for (const s of skips) process.stdout.write('  SKIPPED ' + s + '\n');
process.exitCode = failures.length === 0 ? 0 : 1;
