const { useState, useEffect } = React;
return function Panel({ settings, draftSettings, setSettings, toast }) {
  const [state, setState] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState('');
  const cfg = draftSettings || settings;
  const dirty = Object.keys({ ...settings, ...cfg }).some(key => JSON.stringify(settings[key]) !== JSON.stringify(cfg[key]));
  const editable = typeof setSettings === 'function';
  const set = (key, value) => { if (editable) setSettings({ [key]: value }); else toast('请更新 Aurabot 面板以支持底部统一保存。'); };
  const enabled = cfg.enabled !== false;
  const loginPending = Boolean(state?.browser?.loginPending);
  const account = state?.browser?.account;
  const cookieGuide = state?.browser?.cookieGuide || result?.cookieGuide;
  const accountMessage = loginPending ? state.browser.lastLogin : account?.loggedIn === true ? '已登录：' + account.name : account?.message || '尚未检查登录';
  const refresh = async () => { try { setState(await call('/state')); } catch(e) { toast(e.message); } };
  useEffect(() => { refresh(); }, []);
  useEffect(() => { if (!loginPending && !busy && !state?.busy) return; const timer = setInterval(refresh, 2500); return () => clearInterval(timer); }, [loginPending, busy, state?.busy]);
  const run = async path => {
    if (dirty) { toast('请先点击底部“保存设置”，再执行登录检查或主动分享。'); return; }
    setBusy(path);
    try { const r = await call(path, ['/login', '/logout', '/share'].includes(path) ? {} : undefined); setResult({ path, ...r }); if (r.message) toast(r.message); await refresh(); }
    catch(e) { toast(e.message); }
    finally { setBusy(''); }
  };
  const number = (key, min, max) => h('input', { className: 'ab-input', type: 'number', min, max, step: 1, value: cfg[key] ?? '', onChange: e => set(key, e.target.value === '' ? '' : Number(e.target.value)), onBlur: e => set(key, Math.min(max, Math.max(min, Math.round(Number(e.target.value) || min)))), style: { width: 100 } });
  const locked = Boolean(busy);
  return h('div', { className: 'ab-grid' },
    !editable ? h('p', { className: 'ab-note' }, '当前 Aurabot 面板缺少草稿接口，请更新面板后使用底部统一保存。') : null,
    h(ui.Card, { title: '贴吧登录', right: h(ui.Switch, { on: enabled, disabled: !editable, title: '贴吧功能总开关；修改后点击底部保存设置', onChange: value => set('enabled', value) }),
      desc: '右上角为贴吧功能总开关，关闭后停止读帖和定时浏览，保留登录信息。自动检测已有内置浏览器，无需手动配置。' },
      h(ui.Row, { label: '登录状态', hint: '显示上次检查结果，不是实时在线状态；点击检查登录可重新确认。' }, h('span', { className: 'ab-note' }, accountMessage,
        !loginPending && account?.checkedAt ? h('small', { className: 'ab-muted', style: { display: 'block' } }, '最近检查：' + new Date(account.checkedAt).toLocaleTimeString('zh-CN', { hour12: false })) : null),
        h(ui.Btn, { small: true, disabled: locked, title: '刷新状态', onClick: refresh }, '↻')),
      h('div', { className: 'ab-flex' },
        h(ui.Btn, { disabled: locked || loginPending, onClick: () => run('/login') }, '登录／完成验证'),
        h(ui.Btn, { disabled: locked || loginPending, title: loginPending ? '确认登录后窗口会自动关闭，也可手动关闭' : '手动 Cookie：粘贴后点击底部保存设置，再点这里检查登录；无需另点登录按钮。', onClick: () => run('/account') }, '检查登录'),
        h(ui.Btn, { disabled: locked || loginPending || state?.busy, onClick: () => run('/logout') }, '退出扩展登录')),
      loginPending ? h('p', { className: 'ab-note' }, '正在等待登录或验证。确认成功后会自动保存并关闭窗口；也可用右上角 × 手动关闭。') : null,
      cookieGuide && (state?.browser?.available === false || result?.mode === 'external') ? h('div', { className: 'ab-note' },
        h('b', null, cookieGuide.title), h('ol', null, cookieGuide.steps.map((step, i) => h('li', { key: i, style: { marginBottom: 6 } }, step))),
        h('small', { className: 'ab-muted' }, cookieGuide.warning)) : null,
      h(ui.Row, { label: '手动 Cookie（可选）', hint: '填入后点击底部“保存设置”。只在本机保存，保存后不回显；留空不修改已有 Cookie。' },
        h('input', { className: 'ab-input wide', type: 'password', autoComplete: 'off', spellCheck: false, value: cfg.cookie || '', placeholder: state?.cookieSet || settings.cookieSet ? '已保存，不回显；留空不修改（新 Cookie 填入后底部保存设置）' : '粘贴 Cookie → 底部保存设置 → 检查登录；无需另点登录', onChange: e => set('cookie', e.target.value) })),
      ),
    h(ui.Card, { title: '贴吧配置', desc: '只搜索、看帖；有兴趣时分享给主人私聊。不发帖、不回帖、不点赞。' },
      h(ui.Row, { label: '浏览的贴吧', hint: '可选，每行一个或逗号分隔；留空从首页推荐、热门帖子中挑选。主动分享和定时浏览共用配置。' },
        h('textarea', { className: 'ab-textarea', value: cfg.bars || '', placeholder: '留空：首页推荐与热门\n也可指定：使命召唤、图拉丁', onChange: e => set('bars', e.target.value) })),
      h(ui.Row, { label: '兴趣偏好', hint: '留空时结合她的人格挑选。' }, h('textarea', { className: 'ab-textarea', value: cfg.interests || '', onChange: e => set('interests', e.target.value) })),
      h(ui.Row, { label: '定时自己去刷' }, h(ui.Switch, { on: Boolean(cfg.autoBrowse), onChange: value => set('autoBrowse', value) })),
      h(ui.Row, { label: '浏览间隔', hint: '10～1440 分钟' }, number('intervalMinutes', 10, 1440), ' 分钟'),
      h(ui.Row, { label: '每天最多分享', hint: '0 表示只浏览、不调用模型或分享；主动分享也遵守此上限。' }, number('maxSharesPerDay', 0, 10), ' 次'),
      h(ui.Row, { label: '定时浏览时段', hint: '北京时间，支持跨午夜；开始和结束相同表示全天。' }, number('startHour', 0, 23), ' 至 ', number('endHour', 0, 23), ' 时')),
    h(ui.Card, { title: '她刷过什么', right: h(ui.Btn, { small: true, kind: 'primary', disabled: locked || loginPending || state?.busy || !enabled,
      title: '按已保存配置立即浏览并尝试分享；不受定时时段和间隔限制，仍遵守总开关、试运行、静默和每日分享上限。', onClick: () => run('/share') },
      busy === '/share' || state?.busy ? h('span', null, h('i', { className: 'ab-spin' }), ' 正在刷…') : '现在刷一轮') },
      state ? h('div', { className: 'ab-muted ab-small', style: { marginBottom: 8 } }, `今天自动刷了 ${state.runs || 0} 轮 · 看了 ${state.views || 0} 帖 · 分享 ${state.shares || 0} 次（手动刷不占自动轮次，分享计入每日上限）`) : null,
      result?.path === '/share' ? h('div', { className: 'ab-note', style: { marginBottom: 8 } }, result.message || '本次执行结束') : state?.lastResult && state.lastResult !== '尚未浏览' ? h('div', { className: 'ab-note', style: { marginBottom: 8 } }, state.lastResult) : null,
      !state ? h(ui.Empty, { icon: '⏳', text: '加载中…' }) : !state.history?.length ? h(ui.Empty, { icon: '📺', text: '还没刷过。点「现在刷一轮」试试。' }) :
        h('div', { className: 'ab-list' }, state.history.map((item, i) => h('div', { key: i, className: 'ab-li' },
          h('div', { className: 'meta' }, new Date(item.at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }), h('br'), item.kind === 'read' ? '看了帖子' : '分享给主人'),
          h('div', { className: 'body' }, h('a', { href: item.url, target: '_blank', rel: 'noreferrer' }, '《' + item.title + '》'),
            item.bar || item.origin ? h('span', { className: 'ab-muted ab-small' }, ' · ' + (item.bar ? item.bar + '吧' : item.origin === 'indexed' ? '搜索收录' : item.origin === 'home' ? '贴吧首页' : '指定贴吧')) : null,
            item.text ? h('div', { className: 'ab-muted' }, item.text) : null))))));
};
