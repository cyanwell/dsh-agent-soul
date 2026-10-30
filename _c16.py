import pathlib, subprocess

BLOCK = '''### 2026-10-30 深夜十七 · 采用小鱼的 #16：配置项「env 优先、配置文件兜底」

同一个作者的第二个 PR。**动机很实在**：插件配置散在 `echo.config.json` / 环境变量 / 宿主设置三处，
到底哪个生效没人说得清。她的方案是定一条规则 —— **env 优先、配置文件兜底、都读不到才用默认值**。

新增 `plugins/yantai/env-config.mjs`（106 行），并接到 `kit/echo/memindex.mjs` 与 `kit/echo/self.mjs`。

**为什么收**：这条规则本身就值得写下来。**「配置从哪来」不明确，是那种只有出问题时才发现的坑** ——
而出事时人已经在排障了，最不想再猜这个。

**自检**：`verify-packaging` **122/123**、`verify-install-traps` **23/0**，都没退步。

---

'''
rp = pathlib.Path('README.md'); rs = rp.read_text(encoding='utf-8')
anchor = '### 2026-10-28 午后 · doctor 补两条'
if BLOCK[:40] not in rs and anchor in rs:
    rp.write_text(rs.replace(anchor, BLOCK + anchor, 1), encoding='utf-8')
    print('  OK 更新记录已插入')

def run(cmd, label=None):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace')
    out = ((r.stdout or '') + (r.stderr or '')).strip()
    print('  $', label or cmd[1], '->', r.returncode)
    for line in out.split('\n')[-3:]:
        if line.strip(): print('    ' + line[:150])
    return r.returncode == 0

run(['git', 'add', '-A'])
ok = run(['git', '-c', 'user.name=cyanwell', '-c', 'user.email=cyanwell@users.noreply.github.com',
          'commit', '-m',
          'merge: 采用小鱼的 #16（配置项 env 优先、配置文件兜底）\n\n'
          '* 新增 plugins/yantai/env-config.mjs：env > 配置文件 > 默认值\n'
          '* 接到 memindex / self.mjs —— 之前配置从哪来不明确，只有出问题时才发现\n'
          '* 自检：verify-packaging 122/123、verify-install-traps 23/0，都没退步'])
if ok:
    print('\n=== 结果 ===')
    run(['git', 'log', '--graph', '--oneline', '-3'], 'log')
