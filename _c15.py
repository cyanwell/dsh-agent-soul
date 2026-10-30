import subprocess

def run(cmd, label=None):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    out = ((r.stdout or '') + (r.stderr or '')).strip()
    print('  $', label or cmd[1], '->', r.returncode)
    for line in out.split('\n')[-4:]:
        if line.strip(): print('    ' + line[:150])
    return r.returncode == 0

run(['git', 'add', '-A'])
ok = run(['git', '-c', 'user.name=cyanwell', '-c', 'user.email=cyanwell@users.noreply.github.com',
          'commit', '-m',
          'merge: 采用小鱼的 #15（安装路径 7 个坑 + verify-install-traps 自动检查）\n\n'
          '* 她写了 264 行 tools/verify-install-traps.mjs，把四种静默失败变成断言\n'
          '* 并进来后抓到一处：我们的「两套命名」约定没写进判据 —— 已补\n'
          '  （仓库名 dsh-agent-<x> / 部署名 dsh-yanqing-<x>，install.js 装时替换）\n'
          '* 顺带发现两个自检判据相反：verify-packaging 要求 name==包名，\n'
          '  verify-install-traps 认部署名。已统一成「接受仓库名或部署名」\n'
          '* 自检：verify-packaging 122/123、verify-install-traps 23/0'])
if ok:
    print('\n=== 结果 ===')
    run(['git', 'log', '--graph', '--oneline', '-4'], 'log')
    print()
    run(['git', 'log', '-1', '--format=提交者: %an <%ae>'], 'committer')
