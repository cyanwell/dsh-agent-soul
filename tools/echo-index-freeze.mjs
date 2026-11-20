#!/usr/bin/env node
// T-SNAP-1: read-only freeze of the ECHO index into a temp snapshot directory.
// Opens only: the declared source root's files.jsonl / words.jsonl / summaries.jsonl and the
// shard .jsonl files declared by files.jsonl inside that root. It never opens the DB
// (src/db), session logs, the ledger, config, or any secret material, and it never runs
// the builder or the importer. The 'file' field of files.jsonl (a session log path) is
// read as JSON but never opened.
//
// Usage:
//   node tools/echo-index-freeze.mjs --source-root <root> --out <dir> --expected-sha256 <hex>
//
// --source-root must be exactly the allowed root (D:/AI/memory/hub/index); --out must be a
// directory inside os.tmpdir() that is absent or empty; --expected-sha256 is the SHA256 of
// the source files.jsonl and must match byte-for-byte before anything is copied.
// Output: <out>/manifest.json (source-relative paths only) + copied .jsonl bytes.
// Exit codes: 0 ok, 2 usage, 3 refused/verification failure, 4 io failure.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

export const ALLOWED_SOURCE_ROOT = 'D:/AI/memory/hub/index';
export const FORMAT = 'echo-index-freeze/v1';
export const GLOBAL_FILES = [
  { rel: 'files.jsonl', role: 'files' },
  { rel: 'words.jsonl', role: 'words' },
  { rel: 'summaries.jsonl', role: 'summaries' },
];
const SHARD_FIELDS = ['sumOut', 'wordOut'];
const MAX_SOURCE_FILES = 20000;
const USAGE = 'usage: echo-index-freeze.mjs --source-root <root> --out <dir> --expected-sha256 <hex64>';
const SHA_RE = /^[0-9a-f]{64}$/;
const SHARD_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/;
const IS_WIN = process.platform === 'win32';

export class FreezeError extends Error {
  constructor(code, message, exitCode = 3) {
    super(message);
    this.name = 'FreezeError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
const ci = (s) => (IS_WIN ? s.toLowerCase() : s);

function insideStrict(childAbs, parentAbs) {
  const c = ci(norm(childAbs));
  const p = ci(norm(parentAbs));
  if (c === p) return false;
  return c.startsWith(p.endsWith('/') ? p : p + '/');
}

function realOf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const want = { 'source-root': 'sourceRoot', out: 'out', 'expected-sha256': 'expectedSha256' };
  const got = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new FreezeError('E_USAGE', USAGE, 2);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const key = want[name];
    if (!key) throw new FreezeError('E_UNKNOWN_ARG', `unknown argument: --${name}`, 2);
    let value;
    if (eq === -1) {
      if (i + 1 >= argv.length) throw new FreezeError('E_USAGE', `missing value for --${name}`, 2);
      value = argv[i + 1];
      i += 1;
    } else {
      value = arg.slice(eq + 1);
    }
    if (value === '') throw new FreezeError('E_USAGE', `empty value for --${name}`, 2);
    if (got[key] !== undefined) throw new FreezeError('E_USAGE', `duplicate --${name}`, 2);
    got[key] = value;
  }
  for (const key of Object.values(want)) {
    if (got[key] === undefined) throw new FreezeError('E_USAGE', `missing required argument (see ${USAGE})`, 2);
  }
  const expectedSha256 = String(got.expectedSha256).trim().toLowerCase();
  if (!SHA_RE.test(expectedSha256)) {
    throw new FreezeError('E_BAD_EXPECTED_HASH', '--expected-sha256 must be 64 lowercase hex characters', 2);
  }
  return { sourceRoot: got.sourceRoot, out: got.out, expectedSha256 };
}

function resolveSourceRoot(rawRoot, allowedRoot) {
  const given = norm(rawRoot);
  if (ci(given) !== ci(norm(allowedRoot))) {
    throw new FreezeError('E_SOURCE_ROOT_NOT_ALLOWED', `--source-root must be exactly ${norm(allowedRoot)}`);
  }
  let st;
  try {
    st = fs.statSync(given);
  } catch {
    throw new FreezeError('E_SOURCE_ROOT_MISSING', '--source-root does not exist');
  }
  if (!st.isDirectory()) throw new FreezeError('E_SOURCE_ROOT_NOT_DIR', '--source-root is not a directory');
  const real = realOf(given);
  if (real === null) throw new FreezeError('E_SOURCE_ROOT_MISSING', '--source-root is not readable');
  if (ci(norm(real)) !== ci(given)) {
    throw new FreezeError('E_SOURCE_ROOT_SYMLINK', '--source-root resolves through a symlink or junction');
  }
  return { abs: given, real };
}

function prepareOut(rawOut, sourceRootAbs) {
  const outAbs = norm(rawOut);
  const tmpRaw = os.tmpdir();
  // os.tmpdir() is derived from TEMP/TMP: in a stripped-down process it can come back as a
  // RELATIVE string, which would silently turn "inside the temp dir" into "inside the cwd".
  // Fail closed instead of guessing.
  if (!path.isAbsolute(tmpRaw)) {
    throw new FreezeError('E_NO_TMPDIR', 'os.tmpdir() is not an absolute path; refusing to guess', 4);
  }
  const tmpReal = realOf(tmpRaw);
  if (tmpReal === null) throw new FreezeError('E_NO_TMPDIR', 'os.tmpdir() is not readable', 4);
  if (!insideStrict(outAbs, tmpReal)) {
    throw new FreezeError('E_OUT_OUTSIDE_TMP', '--out must be a directory strictly inside os.tmpdir()', 2);
  }
  if (insideStrict(outAbs, sourceRootAbs)) {
    throw new FreezeError('E_OUT_INSIDE_SOURCE', '--out must not be inside --source-root', 2);
  }
  const base = path.basename(outAbs);
  if (base === '' || base === '.' || base === '..') {
    throw new FreezeError('E_BAD_OUT', '--out must name a directory', 2);
  }
  const parentReal = realOf(path.dirname(outAbs));
  if (parentReal === null) throw new FreezeError('E_OUT_PARENT_MISSING', '--out parent directory does not exist', 2);
  if (!insideStrict(parentReal, tmpReal) && ci(norm(parentReal)) !== ci(norm(tmpReal))) {
    throw new FreezeError('E_OUT_OUTSIDE_TMP', '--out resolves outside os.tmpdir()', 2);
  }
  let existed = false;
  try {
    const st = fs.lstatSync(outAbs);
    if (st.isSymbolicLink()) throw new FreezeError('E_OUT_SYMLINK', '--out is a symlink', 2);
    if (!st.isDirectory()) throw new FreezeError('E_OUT_NOT_DIR', '--out exists and is not a directory', 2);
    const entries = fs.readdirSync(outAbs);
    if (entries.length > 0) throw new FreezeError('E_OUT_NOT_EMPTY', '--out exists and is not empty', 3);
    existed = true;
  } catch (error) {
    if (error instanceof FreezeError) throw error;
    if (error && error.code === 'ENOENT') {
      existed = false;
    } else {
      throw new FreezeError('E_OUT_UNREADABLE', '--out could not be inspected', 4);
    }
  }
  return { abs: outAbs, preexisting: existed };
}

function readDeclaredShards(filesBuf, rootAbs) {
  const text = filesBuf.toString('utf8');
  const lines = text.split('\n');
  const rels = new Map();
  let declarations = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new FreezeError('E_BAD_FILES_JSONL', `files.jsonl line ${i + 1} is not valid JSON`);
    }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new FreezeError('E_BAD_FILES_JSONL', `files.jsonl line ${i + 1} is not an object`);
    }
    for (const field of SHARD_FIELDS) {
      const declared = entry[field];
      if (declared === undefined || declared === null) continue;
      if (typeof declared !== 'string' || declared === '') {
        throw new FreezeError('E_BAD_SHARD_PATH', `files.jsonl line ${i + 1} has a non-string ${field}`);
      }
      declarations += 1;
      const abs = norm(path.isAbsolute(declared) ? declared : path.join(rootAbs, declared));
      if (!insideStrict(abs, rootAbs)) {
        throw new FreezeError('E_SHARD_OUTSIDE_ROOT', `files.jsonl line ${i + 1} declares a ${field} outside the source root`);
      }
      const rel = path.relative(rootAbs, abs).replace(/\\/g, '/');
      const name = path.basename(rel);
      if (!SHARD_NAME_RE.test(name)) {
        throw new FreezeError('E_BAD_SHARD_PATH', `files.jsonl line ${i + 1} declares an unusable ${field} file name`);
      }
      if (!rels.has(rel)) rels.set(rel, { rel, role: 'shard', field });
      if (rels.size > MAX_SOURCE_FILES) {
        throw new FreezeError('E_TOO_MANY_FILES', `more than ${MAX_SOURCE_FILES} declared source files`);
      }
    }
  }
  return { rels: [...rels.values()], declarations };
}

function statRegularJsonl(abs, rel, code, rootReal) {
  let lst;
  try {
    lst = fs.lstatSync(abs);
  } catch {
    throw new FreezeError(code, `missing source file: ${rel}`);
  }
  if (lst.isSymbolicLink()) throw new FreezeError('E_SOURCE_SYMLINK', `source file is a symlink or junction: ${rel}`);
  if (!lst.isFile()) throw new FreezeError('E_NOT_REGULAR_FILE', `source file is not a regular file: ${rel}`);
  if (!rel.toLowerCase().endsWith('.jsonl')) {
    throw new FreezeError('E_NOT_JSONL', `source file is not a .jsonl file: ${rel}`);
  }
  // The real path must stay inside the resolved root under exactly the same relative name:
  // catches symlinks, junctions, and links that merely point at another in-root file.
  const real = realOf(abs);
  if (real === null) throw new FreezeError(code, `source file is not readable: ${rel}`);
  if (!insideStrict(real, rootReal)) {
    throw new FreezeError('E_SOURCE_SYMLINK', `source path resolves outside the source root: ${rel}`);
  }
  const tail = path.relative(rootReal, real).replace(/\\/g, '/');
  if (ci(tail) !== ci(rel)) {
    throw new FreezeError('E_SOURCE_SYMLINK', `source path resolves through a link: ${rel}`);
  }
  return lst;
}

async function hashAndCopy(srcAbs, destAbs) {
  const hash = createHash('sha256');
  let bytes = 0;
  let closed = false;
  const out = fs.createWriteStream(destAbs, { flags: 'wx', mode: 0o600 });
  try {
    const input = fs.createReadStream(srcAbs, { highWaterMark: 1 << 20 });
    for await (const chunk of input) {
      hash.update(chunk);
      bytes += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
    }
    await new Promise((resolve, reject) => {
      out.end((error) => {
        closed = true;
        if (error) reject(error);
        else resolve();
      });
    });
  } finally {
    if (!closed) {
      await new Promise((resolve) => {
        out.once('close', resolve);
        out.destroy();
      });
    }
  }
  return { sha256: hash.digest('hex'), bytes };
}

function removeQuietly(target, opts) {
  try {
    fs.rmSync(target, opts);
  } catch {
    // best effort: a leftover temp directory is not a correctness problem
  }
}

function cleanup(outAbs, preexisting) {
  // Remove everything this run wrote. When the directory pre-existed (empty is a precondition),
  // recreate it empty so a retry sees the same state; the copied bytes are never kept.
  removeQuietly(outAbs, { recursive: true, force: true });
  if (preexisting) {
    try {
      fs.mkdirSync(outAbs, { recursive: true, mode: 0o700 });
    } catch {
      // best effort
    }
  }
}

export function computeSnapshotDigest(records) {
  const sorted = [...records].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const canonical = sorted.map((r) => `${r.path}\n${r.sha256}\n${r.bytes}\n`).join('');
  return sha256(Buffer.from(canonical, 'utf8'));
}

// options.argv: CLI arguments. options.hooks.beforeRehash(ctx) is a test seam only.
// options.allowedSourceRoot is a test seam; the CLI never passes it, so the executable is
// pinned to ALLOWED_SOURCE_ROOT.
export async function runFreeze(options = {}) {
  const argv = options.argv ?? [];
  const hooks = options.hooks ?? {};
  const allowedRoot = options.allowedSourceRoot ?? ALLOWED_SOURCE_ROOT;
  const log = options.log ?? ((line) => process.stdout.write(line + '\n'));

  const args = parseArgs(argv);
  if (args.help) {
    log(USAGE);
    return { ok: true, help: true, code: 'E_HELP', exitCode: 0 };
  }
  const source = resolveSourceRoot(args.sourceRoot, allowedRoot);

  // files.jsonl is read exactly once; the same bytes are hashed, verified and parsed.
  let filesBuf;
  try {
    filesBuf = fs.readFileSync(path.join(source.abs, 'files.jsonl'));
  } catch {
    throw new FreezeError('E_SOURCE_MISSING', 'source files.jsonl is not readable');
  }
  const filesSha = sha256(filesBuf);
  if (filesSha !== args.expectedSha256) {
    throw new FreezeError(
      'E_EXPECTED_HASH_MISMATCH',
      `source files.jsonl sha256 is ${filesSha}, not the expected value`,
    );
  }

  const declared = readDeclaredShards(filesBuf, source.abs);
  const plan = [...GLOBAL_FILES.map((g) => ({ rel: g.rel, role: g.role })), ...declared.rels];
  plan.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  const seen = new Set();
  for (const item of plan) {
    if (seen.has(item.rel)) throw new FreezeError('E_DUPLICATE_PLAN', `duplicate planned source file: ${item.rel}`);
    seen.add(item.rel);
    statRegularJsonl(path.join(source.abs, item.rel), item.rel, 'E_SOURCE_MISSING', source.real);
  }

  const staging = prepareOut(args.out, source.abs);
  const createdNow = !staging.preexisting;
  if (createdNow) {
    try {
      fs.mkdirSync(staging.abs, { recursive: true, mode: 0o700 });
    } catch {
      throw new FreezeError('E_OUT_CREATE_FAILED', 'snapshot directory could not be created', 4);
    }
  }
  const records = [];
  try {
    let totalBytes = 0;
    let shardBytes = 0;
    let shardCount = 0;
    for (const item of plan) {
      const srcAbs = path.join(source.abs, item.rel);
      const destAbs = path.join(staging.abs, item.rel);
      try {
        fs.mkdirSync(path.dirname(destAbs), { recursive: true, mode: 0o700 });
      } catch {
        throw new FreezeError('E_OUT_CREATE_FAILED', `snapshot subdirectory could not be created for ${item.rel}`, 4);
      }
      const before = statRegularJsonl(srcAbs, item.rel, 'E_SOURCE_MISSING', source.real);
      let copied;
      try {
        copied = await hashAndCopy(srcAbs, destAbs);
      } catch (error) {
        if (error instanceof FreezeError) throw error;
        throw new FreezeError('E_COPY_FAILED', `copy failed for ${item.rel}`, 4);
      }
      if (copied.bytes !== before.size) {
        throw new FreezeError('E_SOURCE_CHANGED_DURING_COPY', `source changed while copying: ${item.rel}`);
      }
      records.push({
        path: item.rel,
        role: item.role,
        sha256: copied.sha256,
        bytes: copied.bytes,
        mtimeMs: Math.trunc(before.mtimeMs),
        mtime: new Date(before.mtimeMs).toISOString(),
      });
      totalBytes += copied.bytes;
      if (item.role === 'shard') {
        shardBytes += copied.bytes;
        shardCount += 1;
      }
      if (item.role !== 'shard') {
        log(`COPY ${item.rel} sha256=${copied.sha256} bytes=${copied.bytes}`);
      }
    }
    log(`COPY-SHARDS count=${shardCount} bytes=${shardBytes}`);

    if (typeof hooks.beforeRehash === 'function') await hooks.beforeRehash({ records, plan, staging });

    for (const record of records) {
      const srcAbs = path.join(source.abs, record.path);
      let after;
      try {
        after = fs.lstatSync(srcAbs);
      } catch {
        throw new FreezeError('E_SOURCE_DISAPPEARED', `source disappeared after copy: ${record.path}`);
      }
      if (after.size !== record.bytes) {
        throw new FreezeError('E_SOURCE_CHANGED_CONTENT', `source size changed after copy: ${record.path}`);
      }
      if (Math.trunc(after.mtimeMs) !== record.mtimeMs) {
        throw new FreezeError('E_SOURCE_CHANGED_MTIME', `source mtime changed after copy: ${record.path}`);
      }
      let rehash;
      try {
        rehash = sha256(fs.readFileSync(srcAbs));
      } catch {
        throw new FreezeError('E_SOURCE_DISAPPEARED', `source disappeared after copy: ${record.path}`);
      }
      if (rehash !== record.sha256) {
        throw new FreezeError('E_SOURCE_CHANGED_CONTENT', `source content changed after copy: ${record.path}`);
      }
    }
    log(`VERIFY OK sources=${records.length}`);

    const snapshotDigest = computeSnapshotDigest(records);
    const manifest = {
      format: FORMAT,
      task: 'T-SNAP-1',
      createdAt: new Date().toISOString(),
      sourceRoot: norm(source.abs),
      sourceFingerprint: args.expectedSha256,
      filesDeclared: declared.declarations,
      snapshotDigest,
      snapshotDigestRule: 'sha256 of sorted "path\\nsha256\\nbytes\\n" concatenation (byte-ordered by path)',
      fileCount: records.length,
      totalBytes,
      files: records,
    };
    const manifestPath = path.join(staging.abs, 'manifest.json');
    const manifestTmp = manifestPath + '.tmp';
    try {
      fs.writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      fs.renameSync(manifestTmp, manifestPath);
    } catch {
      removeQuietly(manifestTmp, { force: true });
      throw new FreezeError('E_MANIFEST_WRITE_FAILED', 'manifest.json could not be written', 4);
    }
    log(
      `FREEZE OK files=${records.length} shards=${shardCount} bytes=${totalBytes} digest=${snapshotDigest}`,
    );
    log(`MANIFEST ${path.join(norm(staging.abs), 'manifest.json')}`);
    return { ok: true, exitCode: 0, digest: snapshotDigest, out: norm(staging.abs), files: records.length, bytes: totalBytes, manifest };
  } catch (error) {
    cleanup(staging.abs, staging.preexisting);
    throw error;
  }
}

async function main() {
  try {
    const result = await runFreeze({ argv: process.argv.slice(2) });
    process.exitCode = result.exitCode;
  } catch (error) {
    if (error instanceof FreezeError) {
      process.stderr.write(`REFUSED ${error.code}: ${error.message}\n`);
      process.exitCode = error.exitCode;
    } else {
      process.stderr.write(`REFUSED E_INTERNAL: ${(error && error.message) || 'unexpected failure'}\n`);
      process.exitCode = 4;
    }
  }
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsScript) await main();
