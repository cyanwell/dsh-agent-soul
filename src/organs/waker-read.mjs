// Waker read model — one normalizer/view calculation for every surface.
//
// Production supplies the live v4 Core Ledger instance, the same one used by
// soul_waker ingest/decide and /api/waker. Explicit file reads remain for offline
// diagnostics and pre-integration snapshots; they never replace the active ledger.
//
// The reader is read-only: it normalizes records, computes all five views and
// returns source/mtime provenance. It never writes either source.
//
// Field whitelist is defined once in organs/waker.mjs: key/t/title/from/tier/stage/
// wakeCount/wokenAt/decision/charter/charterNote/decidedAt/note/fromSession.

import fs from 'node:fs';
import { normalizeRecord, viewsOf, badgeOf, STAGES, DECISIONS, CHARTERS } from './waker.mjs';
import { wakerLedgerFileOf, wakerDeliveredFileOf } from '../config.mjs';

/** 单本台账的解析上限。真台账 45KB / 43 条；64MB 是给「异常文件」留的闸，不是常规路径。 */
const MAX_BYTES = 64 * 1024 * 1024;

function bump(obj, k) { obj[k] = (obj[k] || 0) + 1; }

/**
 * 读一本唤醒台账。
 * @param {{file?:string, config?:object}} opts  file 优先；只给 config 时走 wakerLedgerFileOf()
 */
export function readWakerLedger(opts) {
  const o = opts || {};
  const liveLedger = o.ledger && Array.isArray(o.ledger.events) ? o.ledger : null;
  const file = liveLedger ? String(liveLedger.file || '') : (o.file || (o.config ? wakerLedgerFileOf(o.config) : null));
  const out = {
    ok: false, source: liveLedger ? 'core-ledger' : 'file', file: file || null,
    exists: false, mtimeMs: null, bytes: null, updatedAt: null,
    total: 0, stages: {}, decisions: {}, charters: {}, unknownStage: 0,
    views: { act: [], done: [], audit: [], auto: [], blocked: [] }, counts: { act: 0, done: 0, audit: 0, auto: 0, blocked: 0 },
    badge: 0, duplicateKeys: 0, last: null, why: null,
  };
  if (!liveLedger && !file) { out.why = '没有台账路径（Core ledger 或 config.statusDir / soul.root 均未提供）'; return out; }

  let raw, j = null;
  if (liveLedger) {
    raw = liveLedger.events;
    out.exists = true;
    out.updatedAt = liveLedger.data && liveLedger.data.updatedAt || null;
    if (file) {
      try {
        const st = fs.statSync(file);
        out.mtimeMs = st.mtimeMs;
        out.bytes = st.size;
      } catch { /* live memory remains authoritative if stat is unavailable */ }
    }
  } else {
    let st;
    try { st = fs.statSync(file); } catch { out.why = '文件不存在：' + file; return out; }
    out.exists = true;
    out.mtimeMs = st.mtimeMs;
    out.bytes = st.size;
    if (st.size > MAX_BYTES) { out.why = '文件过大（' + st.size + ' B > ' + MAX_BYTES + '），拒绝解析 —— 不用截断冒充全量'; return out; }
    try { j = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { out.why = '解析失败：' + String((e && e.message) || e); return out; }
    raw = Array.isArray(j) ? j : (j && Array.isArray(j.events) ? j.events : null);
    if (!raw) { out.why = '没有 events 数组（格式不对）：' + file; return out; }
    out.updatedAt = (j && !Array.isArray(j) && j.updatedAt) ? j.updatedAt : null;
  }

  // Scan the complete current source; never infer completeness from a tail window.
  const seen = new Set();
  const events = [];
  for (const r of raw) {
    if (seen.has(r && r.key)) out.duplicateKeys++;
    if (r && r.key) seen.add(r.key);
    const rawStage = String((r && r.stage) || '(空)');
    bump(out.stages, rawStage);
    if (!STAGES.includes(rawStage)) out.unknownStage++;
    const n = normalizeRecord(r);
    bump(out.decisions, n.decision || '(未判)');
    bump(out.charters, n.charter);
    events.push(n);
  }
  out.total = raw.length;

  const v = viewsOf(events);
  out.views = v;
  out.counts = { act: v.act.length, done: v.done.length, audit: v.audit.length, auto: v.auto.length, blocked: v.blocked.length };
  out.badge = badgeOf(v);

  // 最近一条：按 t（ISO 串）取最大，而不是数组最后一项 —— 数组顺序不保证是写入顺序。
  let last = null;
  for (const ev of events) {
    if (!ev.t) continue;
    if (!last || String(ev.t) > String(last.t)) last = ev;
  }
  out.last = last ? { t: last.t, title: last.title, from: last.from, stage: last.stage, decision: last.decision, charter: last.charter } : null;

  out.ok = true;
  return out;
}

/** 投递账（只读）。★ 与台账分开 —— 它们回答两个问题。 */
export function readWakerDelivered(opts) {
  const o = opts || {};
  const file = o.file || (o.config ? wakerDeliveredFileOf(o.config) : null);
  const out = { ok: false, file, exists: false, mtimeMs: null, why: null, sent: 0, inflight: 0, maxWaitMs: 0, pollAgoMs: null, fails: 0, dayCount: null };
  if (!file) { out.why = '没有投递账路径'; return out; }
  let st;
  try { st = fs.statSync(file); } catch { out.why = '文件不存在：' + file; return out; }
  out.exists = true;
  out.mtimeMs = st.mtimeMs;
  let dl;
  try { dl = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { out.why = '解析失败：' + String((e && e.message) || e); return out; }
  const sent = dl && dl.sent && typeof dl.sent === 'object' ? Object.keys(dl.sent).length : 0;
  const inflight = dl && dl.downInflight && typeof dl.downInflight === 'object' ? Object.values(dl.downInflight) : [];
  out.sent = sent;
  out.inflight = inflight.length;
  out.maxWaitMs = inflight.length ? Math.max(...inflight.map((x) => Date.now() - Number((x && x.at) || 0))) : 0;
  out.pollAgoMs = dl && dl.lastPollAt ? Date.now() - Number(dl.lastPollAt) : null;
  out.fails = (dl && Array.isArray(dl.downFails) ? dl.downFails.length : 0);
  out.dayCount = dl ? dl.dayCount : null;
  out.ok = true;
  return out;
}

/** 器官卡（/api/organs 的 ③ 台账）。★ 与状态台共用 readWakerLedger —— 一处实现。 */
export function wakerCard(led) {
  const l = led || readWakerLedger({});
  if (!l.ok) {
    const where = l.file ? '（' + l.file + '）' : '';
    return { name: '台账', key: 'waker', value: '—', note: '无读数：' + (l.why || '读不到') + where, level: 'warn' };
  }
  const stamp = new Date(l.mtimeMs).toLocaleString('zh-CN', { hour12: false });
  return {
    name: '台账', key: 'waker',
    value: l.badge + ' 未处理',
    note: '要你执行 ' + l.counts.act + ' · 待审计 ' + l.counts.audit + ' · 已执行 ' + l.counts.done
      + ' · 自定 ' + l.counts.auto + ' · 全本 ' + l.total + ' 条（' + l.file + ' @ ' + stamp + '）',
    level: l.counts.audit > 0 ? 'warn' : 'ok',
  };
}

/** 状态机合法值 —— 转出去，调用方不必再 import 一次 waker.mjs。 */
export { STAGES, DECISIONS, CHARTERS };
