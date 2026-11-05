export const cookieGuide = {
  title: '默认浏览器登录后，需要手动导入 Cookie',
  steps: [
    '在打开的默认浏览器中登录 tieba.baidu.com，并完成需要的安全验证。',
    '按 F12（笔记本可能需要 Fn＋F12，或右键选择“检查”），打开“网络 / Network”，然后按 F5 刷新贴吧页面。',
    '在网络列表中选择 tieba.baidu.com 的页面请求（通常为“文档 / Document”），打开“标头 / Headers”→“请求标头 / Request Headers”，复制 Cookie 这一项的完整值。不要复制“响应标头”里的 Set-Cookie；也不要只复制其中一小段。找不到 Cookie 时，确认已登录，并选中了贴吧域名的请求。',
    '回到扩展，将内容粘贴到“手动 Cookie”，点击页面底部“保存设置”，再点“检查登录”。无需再点“登录／完成验证”。',
  ],
  warning: 'Cookie 等同登录凭据，只填在本机面板，不要发到聊天、截图或 PR 中。默认浏览器会保存自己的登录，但扩展不能自动读取它的 Cookie、确认登录或关闭该窗口。',
};
