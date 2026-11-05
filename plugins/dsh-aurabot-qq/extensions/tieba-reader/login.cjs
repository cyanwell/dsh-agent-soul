// Detect a confirmed account before closing; navigation or a saved cookie alone is insufficient.
async function waitForLogin({ probe, save, close, closed, pause = () => new Promise(resolve => setTimeout(resolve, 2000)) }) {
  let ended = false;
  const end = closed.then(() => { ended = true; return null; });
  while (!ended) {
    const account = await Promise.race([Promise.resolve().then(probe).catch(() => null), end]);
    if (account?.loggedIn === true && typeof account.name === 'string' && account.name.trim()) {
      await save();
      const autoClosed = !ended;
      if (autoClosed) close();
      return { loggedIn: true, name: account.name.trim().slice(0, 100), autoClosed, message: '已确认登录，会话已保存。' };
    }
    if (!ended) await Promise.race([pause(), end]);
  }
  await save();
  return { loggedIn: null, autoClosed: false, message: '登录窗口已手动关闭，会话已保存；尚未确认登录，可点击检查登录。' };
}
module.exports = { waitForLogin };
