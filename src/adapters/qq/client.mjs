// adapters · QQ 只读客户端（两种出口，一个文件）
// ============================================================================
// ★ 为什么两种出口收在同一个文件里：
//   这批 8 个只读工具背后其实有**两条完全不同的网络路径** ——
//     · OneBot HTTP（3000/3001/3002）：状态 / 群列表 / 群成员。用 Bearer accessToken。
//     · SnowLuma 桥接控制台（默认 3100）：未读 / 最近消息 / 二代状态 / 轻记忆 / 黑话。
//       用 `x-agent-token`（**会话令牌**，每次唤醒由宿主提示词下发，不是网关 accessToken）。
//   两条路径的失败语义必须一致（四类失败都要**返回** { ok:false }，绝不抛），
//   所以判定写在一处：分散写就一定会有一条在超时时把调用它那一轮炸掉
//   —— adapters/outbox.mjs 已经为这个形状付过代价。
//
// ★ 为什么 httpUrl 默认是空串，而不是参考实现的 'http://127.0.0.1:3000'：
//   「读」也会真的连上活的 QQ 网关。给一个默认值 = 装上就会连生产。
//   所以默认 = 没接线：宁可工具回 QQ_UNCONFIGURED，也不许有任何一条路径
//   在没人显式配置的情况下自己碰到真网关。
//
// ★ token 三条铁律（与 adapters/outbox.mjs 同一条）：
//   ① 只认**环境变量的名字**（tokenEnv 是名字不是值），值只进授权头；
//   ② 不打印、不落盘、不进错误串、不进 view()；
//   ③ 所有往外递的字符串先过 redact() —— 网关的报错里常带着它自己回显的凭据。
// ============================================================================

import fs from 'node:fs';

export const QQ_CLIENT_PORT = Object.freeze({
  id: 'qq-read-client',
  v: 1,
  transports: ['onebot-http', 'bridge-console'],
  writes: 0,
  note: '两条出口都只有读动作；这个文件里没有 send_* 任何入口 —— 发送归 adapters/outbox.mjs。',
});

const DEFAULT_TIMEOUT_MS = 8000;
const ERROR_MAX = 200;

/**
 * 脱敏：只抹形状，不依赖「我知道那个 token 是什么」。
 * ★ 为什么不能只做 `text.split(token).join('***')`：网关/控制台回的错误正文
 *   经常是**它自己回显的**授权头（Bearer xxx），那串跟我们的 token 一模一样也可能不同名。
 */
function makeRedactor(secret) {
  const sec = String(secret || '');
  return function redact(text) {
    let out = String(text == null ? '' : text);
    if (sec.length >= 4) out = out.split(sec).join('***');
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{4,}/gi, '$1***');
    out = out.replace(/((?:x-agent-token|access_token|authorization|token)["']?\s*[:=]\s*["']?)([^\s"',;&]{4,})/gi, '$1***');
    return out.slice(0, ERROR_MAX);
  };
}

/** 四类失败共同的形状 —— 调用方只判一句 `r.ok`，不必分辨是哪一类。 */
function failure(code, error, extra) {
  return { ok: false, code, error: String(error == null ? '' : error).slice(0, ERROR_MAX), ...(extra || {}) };
}

/** 把 URL 拼好（控制台那条的 query 是对象，别让调用方手拼 —— 手拼就会有一次忘了 encode）。 */
function withQuery(base, pathname, query) {
  const u = new URL(base + (pathname.startsWith('/') ? pathname : '/' + pathname));
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * OneBot HTTP 客户端。
 * createQqClient({ httpUrl, tokenEnv, env, timeoutMs }) → { call(action, params), view() }
 *
 * ★ 只有 call() 一个出口：不提供通用「任意 URL」的方法 —— 那样这层就会变成
 *   一条可以打到任何地方的隧道，而它本来只该说 OneBot 的 action 名。
 */
export function createQqClient(opts = {}) {
  const httpUrl = String(opts.httpUrl || '').trim().replace(/\/+$/, '');
  const env = opts.env || process.env;
  const tokenEnv = String(opts.tokenEnv || '').trim();
  const token = tokenEnv ? String(env[tokenEnv] == null ? '' : env[tokenEnv]).trim() : '';
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const fetchImpl = typeof opts.fetchImpl === 'function'
    ? opts.fetchImpl
    : (url, init) => globalThis.fetch(url, init);
  const redact = makeRedactor(token);
  const counters = { calls: 0, ok: 0, failed: 0, lastAt: null };
  const iso = (ms) => new Date(ms).toISOString();

  async function call(action, params = {}) {
    const act = String(action == null ? '' : action).trim();
    if (!act) return failure('QQ_BAD_ARG', 'call() 要给 OneBot action 名');

    // ★ 没接线就**不发请求**：把「没配」和「连不上」分成两个 code，
    //   否则排障时会去查网关，而问题其实在没人填地址。
    if (!httpUrl) {
      return failure('QQ_UNCONFIGURED', '没有配置 OneBot httpUrl —— 这条客户端没接线，一个请求都没发');
    }

    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params && typeof params === 'object' ? params : {}),
    };
    if (token) init.headers.authorization = 'Bearer ' + token;

    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* 已结束 */ } }, timeoutMs);
    counters.calls += 1;
    counters.lastAt = iso(now());

    let res;
    try {
      res = await fetchImpl(httpUrl + '/' + act, { ...init, signal: ctrl.signal });
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'));
      const cause = e && e.cause && (e.cause.code || e.cause.message);
      counters.failed += 1;
      // ★ 超时和网络错必须分开报：两者的处置完全不同（一个查慢，一个查通）。
      return aborted
        ? failure('QQ_TIMEOUT', '网关 ' + timeoutMs + 'ms 内没回（' + act + '）')
        : failure('QQ_NETWORK', '网络错误：' + String((e && e.message) || e) + (cause ? '（' + String(cause) + '）' : '') + '（' + act + '）');
    } finally {
      clearTimeout(timer);
    }

    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }

    const retcode = body && body.retcode != null && Number.isFinite(Number(body.retcode)) ? Number(body.retcode) : null;
    const wording = body && (body.wording || body.msg || body.message) ? String(body.wording || body.msg || body.message) : '';

    if (!res.ok) {
      counters.failed += 1;
      return failure('QQ_HTTP', 'HTTP ' + res.status + (wording ? '：' + redact(wording) : ''), { httpStatus: res.status, retcode });
    }
    if (!body || typeof body !== 'object') {
      counters.failed += 1;
      return failure('QQ_BAD_BODY', '网关回的不是 JSON（' + act + '）');
    }
    // ★ HTTP 200 但业务失败是 OneBot 的常态（风控 / 未登录），
    //   只判 res.ok 会把这类当成成功 —— 这正是最容易被误读的那一格。
    if (body.status !== 'ok' || retcode !== 0) {
      counters.failed += 1;
      return failure('QQ_RETCODE', 'OneBot ' + act + ' 失败：retcode=' + String(retcode) + (wording ? ' ' + redact(wording) : ''), { retcode });
    }

    counters.ok += 1;
    return { ok: true, action: act, data: body.data };
  }

  /** 只读视图。★ 逐字检查过：这里没有任何一格能装下 token。 */
  function view() {
    return {
      mode: httpUrl ? 'on' : 'off',
      configured: Boolean(httpUrl),
      tokenSet: Boolean(token),
      httpUrl,
      lastAt: counters.lastAt,
      calls: counters.calls,
      ok: counters.ok,
      failed: counters.failed,
    };
  }

  return { call, view, config: Object.freeze({ httpUrl, tokenEnv, timeoutMs }) };
}

/**
 * SnowLuma 桥接控制台客户端（会话令牌那条路）。
 * createQqConsoleClient({ baseUrl, tokenEnv, env, timeoutMs }) → { get(path, opts), view() }
 *
 * ★ 为什么只有 get()：这 5 个工具全是只读；mark-read / memory-append / set-wake-config
 *   那些写动作**一条都没搬** —— 在这一层就不留口子，比靠上层记得不调更可靠。
 * ★ 为什么不缓存调用方递进来的 token：会话令牌按唤醒轮换，把它记在内存里
 *   等于把一个**这一轮**的凭据留到下一轮用 —— 那会造出「用旧令牌读新状态」的静默错。
 */
export function createQqConsoleClient(opts = {}) {
  const baseUrl = String(opts.baseUrl || '').trim().replace(/\/+$/, '');
  const env = opts.env || process.env;
  const tokenEnv = String(opts.tokenEnv || '').trim();
  const envToken = tokenEnv ? String(env[tokenEnv] == null ? '' : env[tokenEnv]).trim() : '';
  // ★ 2026-11-11：第三个来源 —— **文件**。
  //   参考实现（qq-bridge 的 readConsoleToken）就是「先 config.consoleToken，再 state/console-token 文件」，
  //   而且每次请求都重读（令牌会轮换，缓存旧值 = 一直 401）。
  //   父会话判定「5 个控制台工具缺令牌来源」只说对了一半：来源存在，只是 v4 没接。
  const tokenFile = String(opts.tokenFile || '').trim();
  const readFileToken = () => {
    if (!tokenFile) return '';
    try { return fs.readFileSync(tokenFile, 'utf8').trim(); } catch { return ''; }
  };
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const fetchImpl = typeof opts.fetchImpl === 'function'
    ? opts.fetchImpl
    : (url, init) => globalThis.fetch(url, init);
  const redact = makeRedactor(envToken);
  const counters = { calls: 0, ok: 0, failed: 0, lastAt: null };
  const iso = (ms) => new Date(ms).toISOString();

  async function get(pathname, callOpts = {}) {
    const token = String(callOpts.token || envToken || readFileToken() || '').trim();
    // 每一轮都按**当轮真正用的那个 token** 重建脱敏器（文件来源会随令牌轮换变化）
    const redactNow = makeRedactor(token || envToken);
    if (!baseUrl) {
      return failure('QQ_CONSOLE_UNCONFIGURED', '没有配置桥接控制台 baseUrl —— 这条出口没接线，一个请求都没发');
    }
    if (!token) {
      return failure('QQ_CONSOLE_TOKEN_MISSING', '缺会话令牌：这一轮要由调用方传 token（唤醒提示里的【会话令牌】），或把变量名配进 QQ_CONSOLE_TOKEN_ENV');
    }

    const url = withQuery(baseUrl, pathname, callOpts.query);
    const init = { method: 'GET', headers: { 'x-agent-token': token } };
    const ctrl = new AbortController();
    const timeoutMsOfCall = Number(callOpts.timeoutMs) > 0 ? Number(callOpts.timeoutMs) : timeoutMs;
    const timer = setTimeout(() => { try { ctrl.abort(); } catch { /* 已结束 */ } }, timeoutMsOfCall);
    counters.calls += 1;
    counters.lastAt = iso(now());

    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      const aborted = ctrl.signal.aborted || (e && (e.name === 'AbortError' || e.code === 'ABORT_ERR'));
      counters.failed += 1;
      return aborted
        ? failure('QQ_TIMEOUT', '桥接控制台 ' + timeoutMsOfCall + 'ms 内没回（' + pathname + '）')
        : failure('QQ_NETWORK', '网络错误：' + String((e && e.message) || e) + '（' + pathname + '）');
    } finally {
      clearTimeout(timer);
    }

    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }

    if (!res.ok) {
      counters.failed += 1;
      const why = body && (body.error || body.message) ? String(body.error || body.message) : '';
      return failure('QQ_HTTP', '桥接控制台 HTTP ' + res.status + (why ? '：' + redactNow(why) : ''), { httpStatus: res.status });
    }
    if (!body || typeof body !== 'object') {
      counters.failed += 1;
      return failure('QQ_BAD_BODY', '桥接控制台回的不是 JSON（' + pathname + '）');
    }

    counters.ok += 1;
    return { ok: true, path: pathname, data: body };
  }

  /** ★ tokenSet 只反映**环境变量**里那一份 —— 调用方逐次递来的令牌不记、不留。 */
  function view() {
    return {
      mode: baseUrl ? 'on' : 'off',
      configured: Boolean(baseUrl),
      tokenSet: Boolean(envToken),
      baseUrl,
      lastAt: counters.lastAt,
      calls: counters.calls,
      ok: counters.ok,
      failed: counters.failed,
    };
  }

  return { get, view, config: Object.freeze({ baseUrl, tokenEnv, timeoutMs }) };
}
