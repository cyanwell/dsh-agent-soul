// agent-soul 桌面壳 —— M0（2026-11-09）
//
// 它做四件事，顺序是死的：
//   ① 单实例（Local\ 互斥量）—— 第二份双击不再起第二个 core，只是把已有窗口叫到前面；
//   ② 起 core：node src\index.mjs，环境变量 AGENT_SOUL_CHAT=off（只开主面板，8901 不监听）；
//   ③ 轮询 /api/health，并且**验明正身**（2026-11-10 加）：
//      应答里的 pid 必须等于**自己刚起的那个子进程**，才允许导航。
//      只认 "ok":true 是不够的 —— 会把占着端口的外人当成 core，导航到人家的页面。
//      对不上 → 报 foreign-core / 端口占用，**不导航**，不把对方的 body 当应用显示；
//   ④ 关窗时先 POST /api/shutdown 让 core **自己优雅退出**（冲索引缓存、写 shutdown.log），
//      等它退出（最长 60 秒），再 Dispose WebView2，最后自己退；等不到才强杀，日志记 graceful:false。
//
//   ★ 2026-11-10 起，④ 不再由「点 X」触发 —— 见 ⑤。
//
//   ⑤ 关窗分两种，**必须分开**（2026-11-10 定案，见 ShouldHideOnClose）：
//      · UserClosing（点 X / Alt+F4 —— 用户手边最近的那个按钮）→ 收进托盘：
//        窗口隐藏、core 继续跑、托盘图标留着，首次给一次短提示；
//      · TaskManagerClosing（任务管理器「结束任务」/ 任务栏右键「关闭窗口」/
//        一切进程外 WM_CLOSE）→ **真退出**，走 ④。
//        ★ 理由是「必须留一个按了就走的出口」：这条分支如果也收托盘，
//          用户在任务管理器里结束任务会变成静默无效（系统稍后强杀），
//          那就没有一个可预测的退出了。可预测性 > 少退一次。
//      · 托盘菜单「退出」也走 ④，判据是 exitRequested（不是 CloseReason ——
//        退出菜单调的也是 Close()，它报的同样是 UserClosing）。
//      托盘菜单：打开 AgentSoul（恢复窗口）/ 状态台（恢复窗口并导航 /status）/ 退出。
//   ⑥ 二次双击不新起进程：单实例互斥量照旧；已有窗口哪怕是**隐藏**的也要能找回来
//      （FindByTitlePrefix 因此不再只认可见窗口），恢复 + 置前 + 取消托盘隐藏态。
//
// ★ 为什么 ③ 要验 pid（2026-11-10 的事故，现场留在 data\_bench\fake-core*.log）：
//   7310 上还挂着一个慢 core（fake-slow-core），壳起的真 core 因 EADDRINUSE 退出；
//   而壳看到 200 + {"ok":true} 就认定「起来了」，导航过去拿到的是那个外人的 404 页面
//   —— 用户看到白页 "nope"，日志里却一切正常。
//   「有人在听」和「听的人是我起的」是两件事，判据只能落在后者。
//
// ★ 为什么先起 core 再等健康、而不是直接导航：
//   直接导航会在 core 还没 listen 时拿到 ERR_CONNECTION_REFUSED ——
//   用户看到的是 WebView2 自己的错误页（英文、带一堆按钮、看着像崩了）。
//   「界面出来之前，得先有人应答」这一条是壳的责任，不是页面的责任。
//
// ★ 为什么日志写 %LOCALAPPDATA%\AgentSoul\ 而不是 exe 旁边：
//   Program Files 下不可写；而且 exe 旁边是**安装目录**，用户没道理去那里找日志。
//
// ★ 编译约束：/langversion:5 —— 禁插值字符串、禁 ?.、禁 nameof、禁表达式体、禁 out var。
//   这个文件里所有拼串都用 + 或 string.Format，所有可空判断都写成显式 if。

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

// ═══════════════════════════════════════════════════════════════════════════
// 日志：两个文件
//   shell.log —— 壳自己的时间线（带相对启动的毫秒数，读起来像录屏）
//   core.log  —— core 的 stdout/stderr 原样转发（诊断要看它，不能丢）
// ═══════════════════════════════════════════════════════════════════════════
static class SLog
{
    static object _lock = new object();
    // ★ 2026-11-10（跨进程日志覆盖）：同名互斥量，所有 AgentSoul 壳共用一把；见 W 的注释。
    static Mutex _logMutex;
    static bool _logMutexTried;
    static string _shellPath = "";
    static string _corePath = "";
    static Stopwatch _sw = Stopwatch.StartNew();

    public static string ShellPath { get { return _shellPath; } }
    public static string CorePath { get { return _corePath; } }

    public static void Init(string dir)
    {
        try { if (!Directory.Exists(dir)) Directory.CreateDirectory(dir); } catch { }
        _shellPath = Path.Combine(dir, "shell.log");
        _corePath = Path.Combine(dir, "core.log");
        // 每次启动写一行分隔，不然上上次的尾巴会把这次的开头吃掉
        W("");
        W("══════════════════════════════════════════════════════════════");
        // 自证：这一行用来在日志里直接看出串行化到底有没有装上（测试与排查都读它）
        W("log: 跨进程写串行化 = " + (LogMutex() == null
            ? "不可用（互斥量创建失败，退化为无锁追加）"
            : "已启用 Local\\AgentSoul.ShellLog（每次 append 持锁、打开即关）"));
    }

    // ★ 拿那把跨进程日志锁（create-once）。作用域 Local\ = 本登录会话，
    //   和单实例互斥量同一档；全局 \ 前缀要跨会话权限，这里不需要。
    //   只在两处被调：Init（启动，单线程）与 W（已持 _lock 进程内锁）。
    static Mutex LogMutex()
    {
        if (_logMutexTried) return _logMutex;
        _logMutexTried = true;
        try { _logMutex = new Mutex(false, @"Local\AgentSoul.ShellLog"); }
        catch { _logMutex = null; }
        return _logMutex;
    }

    public static void W(string msg)
    {
        lock (_lock)
        {
            string line = string.Format("[{0:HH:mm:ss.fff}] [+{1} ms] pid={2} {3}",
                DateTime.Now, _sw.ElapsedMilliseconds, Process.GetCurrentProcess().Id, msg);
            // ★ 2026-11-10（第二轮：跨进程**覆盖**，不是丢行）：
            //   上一版用 FileMode.Append + FileShare.ReadWrite，只解决了「撞车丢行」，
            //   没解决「覆盖」—— Append 流的写入偏移是**打开那一刻的 EOF**，
            //   两个进程各开一条流，后写的一方从同一个偏移落笔，把先写的那行按字节盖掉。
            //   实测现场：C2 的「instance-2: 已发出 activate 事件（第 1 次尝试）」
            //   只剩尾巴「…尝试）」（前面几个字节被覆盖成乱码）——行为是对的，取证行被吃了。
            //   现在的协议：① 先拿跨进程命名互斥量 Local\AgentSoul.ShellLog，
            //   ② 再 File.AppendAllText **打开即关**（每次写都以当前 EOF 重新打开）。
            //   串行化之后只有一份写者、只有一个偏移，不存在盖掉别人这回事。
            //   ★ 拿不到锁（2 s 超时 / 互斥量创建失败）也照写 —— 退回旧的弱语义。
            //     日志绝不许挡住程序；锁是加固，不是前提。异常路径在 finally 里释放。
            Mutex mu = LogMutex();
            bool held = false;
            try
            {
                if (mu != null)
                {
                    try { held = mu.WaitOne(2000); }
                    catch (AbandonedMutexException) { held = true; }   // 上一个持有者崩了，锁已归我
                    catch { held = false; }
                }
                for (int attempt = 0; attempt < 3; attempt++)
                {
                    try
                    {
                        File.AppendAllText(_shellPath, line + "\r\n", new UTF8Encoding(false));
                        return;
                    }
                    catch
                    {
                        try { Thread.Sleep(5); } catch { }
                    }
                }
            }
            finally
            {
                if (held) { try { mu.ReleaseMutex(); } catch { } }
            }
        }
    }

    public static void Core(string msg)
    {
        lock (_lock)
        {
            try
            {
                string line = string.Format("[{0:HH:mm:ss.fff}] [{1} ms] {2}",
                    DateTime.Now, _sw.ElapsedMilliseconds, msg);
                // core.log 只有「持有单实例互斥量的那个壳」会写（core 是它起的），
                // 不存在第二个写者 —— 所以这里**不**加跨进程锁，省掉每行一次内核等待。
                File.AppendAllText(_corePath, line + "\r\n", new UTF8Encoding(false));
            }
            catch { }
        }
    }

    public static long Ms { get { return _sw.ElapsedMilliseconds; } }
}

// ═══════════════════════════════════════════════════════════════════════════
// Win32：单实例要「把已有窗口叫到前面」，这件事 Win Forms 自己做不到
// ═══════════════════════════════════════════════════════════════════════════
static class Native
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int dwProcessId);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);

    public const int SW_RESTORE = 9;

    public static string TitleOf(IntPtr h)
    {
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 2);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    // ★ 2026-11-10：不再只认**可见**窗口。
    //   窗口收进托盘后 IsWindowVisible=false，而「二次双击」必须还能把它找回来 ——
    //   否则第二实例只能靠事件唤起，AllowSetForegroundWindow 拿不到 pid，前台锁会让窗口停在后面。
    //   取法：先找可见的（正常情况），找不到再接受隐藏的（托盘里）。
    public static IntPtr FindByTitlePrefix(string prefix, out int pid)
    {
        IntPtr found = IntPtr.Zero;
        int fpid = 0;
        IntPtr hiddenHit = IntPtr.Zero;
        int hiddenPid = 0;
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            string t = TitleOf(h);
            if (t == null || !t.StartsWith(prefix, StringComparison.Ordinal)) return true;
            uint p;
            GetWindowThreadProcessId(h, out p);
            if (IsWindowVisible(h))
            {
                found = h;
                fpid = (int)p;
                return false;
            }
            if (hiddenHit == IntPtr.Zero)
            {
                hiddenHit = h;
                hiddenPid = (int)p;
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero)
        {
            found = hiddenHit;
            fpid = hiddenPid;
        }
        pid = fpid;
        return found;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 健康检查的**身份判定结果**（不是布尔的「起来没起来」）
//
// ★ 为什么要一个结构体而不是 "ok" / "core-exit:7" 这样的字符串：
//   现在有四种结局（ok / core-exit / foreign-core / timeout），而 foreign-core 还要带
//   「对方自报的 pid、service、状态码、片段」才能给出可行动的提示。
//   用字符串前缀拼这些字段，调用方就得 substring + 猜 —— 那是上一次误判的同一种写法。
// ═══════════════════════════════════════════════════════════════════════════
class HealthVerdict
{
    public string Kind = "timeout";   // ok | core-exit | foreign-core | timeout
    public int ExpectPid = 0;         // 本壳启动的子进程 pid（判据的唯一锚点）
    public int CoreExitCode = -1;
    public bool CoreExited = false;
    public int Tries = 0;
    public long Ms = 0;
    public string Service = "";       // 采信时对方自报的 service（只作日志）
    public int ForeignStatus = 0;     // 外人：HTTP 状态码（0 = 没见过外人）
    public string ForeignPid = "";
    public string ForeignService = "";
    public int ForeignBytes = 0;
    public string ForeignSnippet = "";
    public long ForeignSeenMs = -1;
}

// ═══════════════════════════════════════════════════════════════════════════
// 从 /api/health 的 body 里抠两个字段 —— **这不是 JSON 解析器**
//
// ★ 为什么不引 JSON 库：C#5 编译、不许加 NuGet，System.Web.Extensions 在 winexe 下
//   还得额外引程序集；而契约只有两个扁平字段（pid / service）。
//   写一个通用 JSON 解析器是过度设计，也是一个新的出错面。
// ★ 为什么要按「引号 + 冒号」定位：只用 IndexOf("pid") 会命中 "apids" 或字符串值里的
//   同名子串。这里要求前面带引号、后面跟冒号，且值按 "字符串 / 数字" 两种扫。
//   ★ 若将来 health 长出嵌套结构，这里必须换成真解析器 —— 到那时改这里，别打补丁。
// ═══════════════════════════════════════════════════════════════════════════
static class HIdent
{
    public static string JsonRaw(string body, string name)
    {
        if (body == null) return null;
        string needle = "\"" + name + "\"";
        int i = body.IndexOf(needle, StringComparison.Ordinal);
        if (i < 0) return null;
        int j = i + needle.Length;
        while (j < body.Length && char.IsWhiteSpace(body[j])) j++;
        if (j >= body.Length || body[j] != ':') return null;
        j++;
        while (j < body.Length && char.IsWhiteSpace(body[j])) j++;
        if (j >= body.Length) return null;

        if (body[j] == '"')
        {
            j++;
            StringBuilder sb = new StringBuilder();
            while (j < body.Length && body[j] != '"')
            {
                if (body[j] == '\\' && j + 1 < body.Length) { j++; }
                sb.Append(body[j]);
                j++;
            }
            return sb.ToString();
        }
        int k = j;
        while (k < body.Length && (char.IsDigit(body[k]) || body[k] == '-' || body[k] == '+'
            || body[k] == '.' || body[k] == 'e' || body[k] == 'E')) k++;
        if (k == j) return null;
        return body.Substring(j, k - j);
    }

    public static int JsonInt(string body, string name, int dflt)
    {
        string raw = JsonRaw(body, name);
        if (raw == null) return dflt;
        int n;
        if (int.TryParse(raw, out n)) return n;
        return dflt;
    }

    /// 把对方的 body 压成一行、删掉控制字符、截断 —— 它只进日志和错误页的「诊断片段」，
    /// **绝不渲染**（那个页面是别人的，不是应用）。
    public static string Snip(string s, int max)
    {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder();
        bool pendingSpace = false;
        bool cut = false;
        for (int i = 0; i < s.Length; i++)
        {
            if (sb.Length >= max) { cut = true; break; }
            char c = s[i];
            if (c == ' ' || c == '\r' || c == '\n' || c == '\t') { pendingSpace = true; continue; }
            if (char.IsControl(c)) continue;
            if (pendingSpace && sb.Length > 0) sb.Append(' ');
            pendingSpace = false;
            sb.Append(c);
        }
        string r = sb.ToString();
        if (cut) r = r + " …";
        return r;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 设置：默认值全在这里，环境变量只用来测试（不改变真实路径的行为）
// ═══════════════════════════════════════════════════════════════════════════
class ShellSettings
{
    public int Port = 7310;
    public string HubUrl = "http://127.0.0.1:7310";
    public string NodeExe = "";
    public string CoreScript = "";
    public string CoreDir = "";
    public bool TestMode = false;
    public int HealthTimeoutMs = 40000;
    // ★ 2026-11-10：10 秒 → 60 秒。理由见 ShutdownFlow 里的注释：
    //   10 秒是「core 已经空闲」时的数字，而真实场景是「core 正在建索引，事件循环被占住」。
    public int CoreExitWaitMs = 60000;
    public string UdfDir = "";
    public string BaseDir = "";
    // ★ 2026-11-10（M1）：是否走「分发版」布局（exe 目录\app\<版本>\src）。
    //   true 时 core 的 AGENT_SOUL_HOME 指向**安装根**，于是 config.json / data / workspace
    //   都留在安装根、被所有版本共用；升级只换 app\<版本>，用户设置与数据不会跟着版本走。
    //   false（开发布局）时一个字都不变 —— 生产那份 config.json 照旧。
    public bool DistLayout = false;
    public string InstallRoot = "";
    // ★ 2026-11-10：AGENT_SOUL_START_HIDDEN=1 —— 启动即把主窗收进托盘，托盘照常可用。
    //   只给隔离测试用；**不改变正常双击的默认行为**（正常双击照旧显示窗口）。
    public bool StartHidden = false;

    static int IntEnv(string name, int dflt)
    {
        string v = Environment.GetEnvironmentVariable(name);
        int n;
        if (!string.IsNullOrEmpty(v) && int.TryParse(v, out n) && n > 0) return n;
        return dflt;
    }

    public static ShellSettings Resolve(string baseDir)
    {
        ShellSettings s = new ShellSettings();
        s.BaseDir = baseDir;
        s.UdfDir = Path.Combine(baseDir, "WebView2");

        string envPort = Environment.GetEnvironmentVariable("AGENT_SOUL_HUB_PORT");
        int p;
        if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out p) && p > 0) s.Port = p;
        s.HubUrl = "http://127.0.0.1:" + s.Port;

        s.HealthTimeoutMs = IntEnv("AGENT_SOUL_HEALTH_TIMEOUT_MS", 40000);
        s.CoreExitWaitMs = IntEnv("AGENT_SOUL_CORE_EXIT_WAIT_MS", 60000);

        string hidden = Environment.GetEnvironmentVariable("AGENT_SOUL_START_HIDDEN");
        if (!string.IsNullOrEmpty(hidden))
        {
            string h = hidden.Trim().ToLowerInvariant();
            s.StartHidden = (h == "1" || h == "true" || h == "yes");
        }

        // ── core 脚本：三种布局，判据都只在这一个函数里 ──
        //   ① 环境变量 AGENT_SOUL_CORE_SCRIPT（测试）
        //   ② 分发版：exe 目录\app\<版本>\src\index.mjs —— 选哪个版本看 app\current.txt
        //   ③ 开发版：从 exe 所在目录往上找 src\index.mjs
        // ★ 2026-11-10（M1）：壳与业务负载分离。壳=启动链，app\<版本>=业务负载。
        //   ② 排在 ③ 前面是刻意的：分发目录放在哪里都只认 app\，不会被上层的开发目录抢走。
        string envCore = Environment.GetEnvironmentVariable("AGENT_SOUL_CORE_SCRIPT");
        if (!string.IsNullOrEmpty(envCore) && File.Exists(envCore))
        {
            s.CoreScript = Path.GetFullPath(envCore);
            s.CoreDir = Path.GetDirectoryName(s.CoreScript);
            s.TestMode = true;
        }
        else
        {
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            string appProbe = ProbeAppPayload(exeDir);
            if (appProbe != null)
            {
                s.CoreScript = appProbe;
                s.CoreDir = Path.GetDirectoryName(Path.GetDirectoryName(appProbe));
                s.DistLayout = true;
                s.InstallRoot = exeDir;
            }
            else
            {
                string dir = exeDir;
                string probe = null;
                int up = 0;
                while (dir != null && up < 6)
                {
                    string cand = Path.Combine(dir, "src", "index.mjs");
                    if (File.Exists(cand)) { probe = cand; break; }
                    dir = Path.GetDirectoryName(dir);
                    up++;
                }
                if (probe == null) throw new Exception("找不到 src\\index.mjs。\r\n\r\n"
                    + "· 分发版：应该有 app\\<版本>\\src\\index.mjs，并在 app\\current.txt 里写一行版本号（如 1.0.0）；\r\n"
                    + "· 开发版：AgentSoul.exe 应放在 agent-soul 目录下（或它的任意子目录）。\r\n\r\n"
                    + "搜索起点：" + (exeDir == null ? "(空)" : exeDir));
                s.CoreScript = probe;
                s.CoreDir = Path.GetDirectoryName(Path.GetDirectoryName(probe));
            }
        }

        // ── node：环境变量 → 自己目录下的 runtime\node.exe → PATH → 本机已知路径 ──
        string envNode = Environment.GetEnvironmentVariable("AGENT_SOUL_NODE");
        if (!string.IsNullOrEmpty(envNode) && File.Exists(envNode)) s.NodeExe = envNode;
        if (string.IsNullOrEmpty(s.NodeExe))
        {
            string cand = Path.Combine(s.CoreDir, "runtime", "node.exe");
            if (File.Exists(cand)) s.NodeExe = cand;
        }
        if (string.IsNullOrEmpty(s.NodeExe))
        {
            // ★ 2026-11-10（M1）：分发版把 node 放在**安装根**（exe 所在目录）的 runtime\ 下，
            //   与 app\<版本>\ 分开 —— 升级只换一个版本目录，不用再带一遍 87MB 的 node.exe。
            //   ★ baseDir 是壳的日志目录（%LOCALAPPDATA%\AgentSoul），不是 exe 目录，
            //     所以这一条必须单独写；写在 baseDir 那条里会永远找不到分发版的 node。
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            string cand = Path.Combine(exeDir, "runtime", "node.exe");
            if (File.Exists(cand)) s.NodeExe = cand;
        }
        if (string.IsNullOrEmpty(s.NodeExe))
        {
            string cand = Path.Combine(baseDir, "runtime", "node.exe");
            if (File.Exists(cand)) s.NodeExe = cand;
        }
        if (string.IsNullOrEmpty(s.NodeExe))
        {
            // ★ 本机 PATH 上没有 node（DSH 用的是内置的）—— 兜底路径必须显式写出来，
            //   否则「双击没反应」这句话会被当成壳的 bug。
            string[] fallbacks = new string[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".workbuddy\\binaries\\node\\versions\\22.22.2-3\\node.exe"),
            };
            foreach (string f in fallbacks) if (File.Exists(f)) { s.NodeExe = f; break; }
        }
        if (string.IsNullOrEmpty(s.NodeExe)) s.NodeExe = "node";   // 交给 PATH —— 失败时会在错误页说清

        return s;
    }

    // ── 版本化负载目录（M1）────────────────────────────────────────────────
    //   布局：<exe 目录>\app\current.txt（一行版本号）+ app\<版本>\src\index.mjs
    //   回切：把 current.txt 改回旧版本号（或删掉它 → 退回「最高版本」，仍然能启动）
    //   ★ 只有这里决定「跑哪个版本」，别处不许再判一次 —— 两处判据各写一遍必然分叉。
    public static string ProbeAppPayload(string exeDir)
    {
        if (string.IsNullOrEmpty(exeDir)) return null;
        string appRoot = Path.Combine(exeDir, "app");
        if (!Directory.Exists(appRoot)) return null;

        string cur = null;
        try
        {
            string ptr = Path.Combine(appRoot, "current.txt");
            if (File.Exists(ptr)) cur = File.ReadAllText(ptr).Trim();
        }
        catch { cur = null; }
        if (!string.IsNullOrEmpty(cur))
        {
            string c = Path.Combine(appRoot, cur, "src", "index.mjs");
            if (File.Exists(c)) return c;
        }

        // current.txt 缺失 / 指向不存在的版本 → 退回最高版本：能启动总是好过白屏
        string best = null;
        try
        {
            string[] dirs = Directory.GetDirectories(appRoot);
            foreach (string d in dirs)
            {
                if (!File.Exists(Path.Combine(d, "src", "index.mjs"))) continue;
                if (best == null || CompareVersion(Path.GetFileName(d), Path.GetFileName(best)) > 0) best = d;
            }
        }
        catch { return null; }
        if (best == null) return null;
        return Path.Combine(best, "src", "index.mjs");
    }

    // 版本号比较：按 . - _ 切段；两段都是数字时比数值，否则按忽略大小写的字符串
    static int CompareVersion(string a, string b)
    {
        if (a == null) a = "";
        if (b == null) b = "";
        char[] seps = new char[] { '.', '-', '_' };
        string[] pa = a.Split(seps);
        string[] pb = b.Split(seps);
        int n = Math.Min(pa.Length, pb.Length);
        int i;
        for (i = 0; i < n; i++)
        {
            long x, y;
            bool nx = long.TryParse(pa[i], out x);
            bool ny = long.TryParse(pb[i], out y);
            if (nx && ny)
            {
                if (x != y) return x < y ? -1 : 1;
            }
            else
            {
                int c = string.Compare(pa[i], pb[i], StringComparison.OrdinalIgnoreCase);
                if (c != 0) return c < 0 ? -1 : 1;
            }
        }
        if (pa.Length == pb.Length) return 0;
        return pa.Length < pb.Length ? -1 : 1;
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// 窗口
// ═══════════════════════════════════════════════════════════════════════════
class ShellForm : Form
{
    const string TITLE_BASE = "AgentSoul";
    const string MUTEX_NAME = @"Local\AgentSoul.SingleInstance";
    const string EVENT_NAME = @"Local\AgentSoul.Activate";

    ShellSettings S;
    WebView2 web;
    Panel errPanel;
    Label lblTitle;
    Label lblBody;
    Label lblStatus;   // 底部状态栏：关窗期间显示「正在收尾…」，免得用户以为卡死再去强杀
    TextBox txtLog;
    Process core;
    Thread activateWatcher;
    EventWaitHandle activateEvent;
    volatile bool shuttingDown;
    volatile bool ready;
    int baselineWebViewProcs;

    // ── 托盘（2026-11-10）──────────────────────────────────────────────────
    NotifyIcon tray;
    ContextMenuStrip trayMenu;
    Icon iconTray;              // 16px：托盘
    Icon iconWindow;            // 32px：窗口 / 任务栏
    bool exitRequested;         // ★ 唯一判据：用户真的要退出（只有托盘「退出」会置位）
    bool hiddenToTray;          // 窗口现在收在托盘里（Hide 过）
    bool startHidden;           // AGENT_SOUL_START_HIDDEN=1（隔离测试）
    bool tipShown;              // 首次收进托盘的小提示只发一次
    EventWaitHandle exitHook;   // 测试钩子（AGENT_SOUL_TEST_EXIT_EVENT）→ 等价托盘「退出」
    Thread exitHookThread;
    EventWaitHandle userCloseHook; // 测试钩子（AGENT_SOUL_TEST_USERCLOSE_EVENT）→ 等价「点 X」(UserClosing)

    public ShellForm(ShellSettings s)
    {
        S = s;
        Text = TITLE_BASE + " — 启动中…";
        Width = 1200;
        Height = 820;
        MinimumSize = new Size(760, 520);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(22, 24, 28);

        web = new WebView2();
        web.Dock = DockStyle.Fill;
        web.Visible = false;
        Controls.Add(web);

        errPanel = BuildErrorPanel();
        errPanel.Visible = false;
        Controls.Add(errPanel);

        // ★ 底部状态栏（2026-11-10）：关窗时在这里写「正在收尾…」。
        //   为什么必须有：等待时间从 10 秒提到 60 秒 —— 如果界面一点反应都没有，
        //   用户的判断一定是「卡死了」然后去任务管理器强杀，而那正是要避免的那一步。
        //   ★ BringToFront 是为了让它在 Dock 顺序里先占住底边，Fill 的 WebView2 再吃剩下的。
        lblStatus = new Label();
        lblStatus.Dock = DockStyle.Bottom;
        lblStatus.Height = 26;
        lblStatus.TextAlign = ContentAlignment.MiddleLeft;
        lblStatus.Padding = new Padding(14, 0, 14, 0);
        lblStatus.Font = new Font("Microsoft YaHei", 9F);
        lblStatus.ForeColor = Color.FromArgb(198, 208, 220);
        lblStatus.BackColor = Color.FromArgb(30, 33, 38);
        lblStatus.Text = "";
        // ★ 2026-11-11：平时不显示。它原本 Height=26 一直占着一条深灰空白，
        //   而内容为空 —— 用户在 /chat 底部看到的那条「灰色条」就是它，
        //   把右栏最后一行（运行时长）切掉了一半。
        //   只在关窗/出错时才 Visible=true（ApplyClosingStatus 里会打开）。
        lblStatus.Visible = false;
        Controls.Add(lblStatus);
        lblStatus.BringToFront();

        Shown += new EventHandler(OnShown);
        FormClosing += new FormClosingEventHandler(OnClosing);

        // ★ 图标与托盘要在消息循环起来之前就位 —— 窗口一出现就该带着自己的脸。
        startHidden = S.StartHidden;
        if (startHidden) { WindowState = FormWindowState.Minimized; ShowInTaskbar = false; }
        LoadIcons();
        BuildTray();
    }

    // ── 错误页：一定要能看懂、能复制日志路径 ────────────────────────────────
    Panel BuildErrorPanel()
    {
        Panel p = new Panel();
        p.Dock = DockStyle.Fill;
        p.BackColor = Color.FromArgb(22, 24, 28);

        TableLayoutPanel t = new TableLayoutPanel();
        t.Dock = DockStyle.Fill;
        t.ColumnCount = 1;
        t.RowCount = 3;
        t.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100F));
        t.RowStyles.Add(new RowStyle(SizeType.Absolute, 78F));
        t.RowStyles.Add(new RowStyle(SizeType.Percent, 100F));
        t.RowStyles.Add(new RowStyle(SizeType.Absolute, 156F));

        lblTitle = new Label();
        lblTitle.Dock = DockStyle.Fill;
        lblTitle.AutoSize = false;
        lblTitle.TextAlign = ContentAlignment.MiddleLeft;
        lblTitle.Font = new Font("Microsoft YaHei", 18F, FontStyle.Bold);
        lblTitle.ForeColor = Color.FromArgb(255, 126, 116);
        lblTitle.Padding = new Padding(28, 0, 28, 0);
        lblTitle.Text = "启动失败";
        t.Controls.Add(lblTitle, 0, 0);

        lblBody = new Label();
        lblBody.Dock = DockStyle.Fill;
        lblBody.AutoSize = false;
        lblBody.Font = new Font("Microsoft YaHei", 10.5F);
        lblBody.ForeColor = Color.FromArgb(198, 208, 220);
        lblBody.Padding = new Padding(28, 4, 28, 8);
        lblBody.Text = "";
        t.Controls.Add(lblBody, 0, 1);

        Panel bottom = new Panel();
        bottom.Dock = DockStyle.Fill;
        bottom.Padding = new Padding(28, 0, 28, 16);

        Label cap = new Label();
        cap.Dock = DockStyle.Top;
        cap.Height = 24;
        cap.Text = "日志文件（可选中复制，直接贴给我就能定位）";
        cap.ForeColor = Color.FromArgb(150, 160, 172);
        cap.Font = new Font("Microsoft YaHei", 9F);

        txtLog = new TextBox();
        txtLog.Dock = DockStyle.Top;
        txtLog.ReadOnly = true;
        txtLog.Height = 26;
        txtLog.BorderStyle = BorderStyle.FixedSingle;
        txtLog.BackColor = Color.FromArgb(16, 18, 22);
        txtLog.ForeColor = Color.FromArgb(140, 205, 255);
        txtLog.Font = new Font("Consolas", 10F);
        txtLog.Text = SLog.ShellPath;

        Button btn = new Button();
        btn.Dock = DockStyle.Top;
        btn.Height = 32;
        btn.Text = "打开日志所在文件夹";
        btn.FlatStyle = FlatStyle.Flat;
        btn.ForeColor = Color.FromArgb(210, 220, 232);
        btn.BackColor = Color.FromArgb(38, 42, 50);
        btn.Click += delegate(object sender, EventArgs e)
        {
            try { Process.Start("explorer.exe", "/select,\"" + SLog.ShellPath + "\""); }
            catch { }
        };

        // Dock=Top 的堆叠顺序 = 添加顺序的逆序，所以倒着加
        bottom.Controls.Add(txtLog);
        bottom.Controls.Add(cap);
        bottom.Controls.Add(btn);
        t.Controls.Add(bottom, 0, 2);

        p.Controls.Add(t);
        return p;
    }

    void ShowError(string title, string detail)
    {
        SLog.W("error: " + title + " | " + detail.Replace("\r\n", " / ").Replace("\n", " / "));
        try
        {
            if (InvokeRequired) { BeginInvoke(new MethodInvoker(delegate() { ShowError(title, detail); })); return; }
        }
        catch { return; }

        // ★ 窗口在托盘里时不要把它强行弹出来（否则「最小化到托盘」会被一个错误页顶掉）。
        //   改成托盘提示：用户双击托盘时才看到完整错误页与日志路径。
        if (hiddenToTray && tray != null)
        {
            try
            {
                tray.Text = "AgentSoul — 出错了（双击查看）";
                tray.ShowBalloonTip(6000, title, "AgentSoul 出错了，双击托盘图标查看详情与日志路径。", ToolTipIcon.Warning);
            }
            catch { }
            return;
        }

        lblTitle.Text = title;
        lblBody.Text = detail;
        txtLog.Text = SLog.ShellPath;
        errPanel.Visible = true;
        errPanel.BringToFront();
        web.Visible = false;
        Text = TITLE_BASE + " — 启动失败";
        Show();
        Activate();
    }

    // ── 错误页正文（三种结局各一份）────────────────────────────────────────
    //
    // ★ 规矩：每一条都要能回答三个问题 —— 出了什么、凭什么这么判断、我现在能做什么。
    //   旧版只回答第一个（「core 没有按期启动」），用户能做的只有「再试一次」。

    string DetailForeign(HealthVerdict v)
    {
        string fpid = (v.ForeignPid.Length == 0) ? "(未自报)" : v.ForeignPid;
        string fsvc = (v.ForeignService.Length == 0) ? "(未自报)" : v.ForeignService;
        StringBuilder sb = new StringBuilder();
        sb.Append("本壳启动的 core：pid=" + v.ExpectPid + "，脚本 " + S.CoreScript + "\r\n");
        sb.Append("端口 127.0.0.1:" + S.Port + " 上的应答：HTTP " + v.ForeignStatus + "、" + v.ForeignBytes + " 字节，"
            + "pid=" + fpid + "，service=" + fsvc + "\r\n");
        sb.Append("\r\n★ 壳没有把它当成应用显示，也不会。它属于另一个进程，内容不可信。\r\n");
        if (v.ForeignService.IndexOf("agent-soul", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            sb.Append("\r\n判断：那是**另一个 agent-soul core**（不是本壳启动的这一个）。");
            sb.Append("\r\n最常见的原因：上一个窗口没退干净。\r\n");
            sb.Append("→ 打开任务管理器，结束 node.exe（pid=" + fpid + "），再启动一次。\r\n");
        }
        else
        {
            sb.Append("\r\n判断：那**不是 agent-soul**。");
            sb.Append("\r\n端口是契约端口（总体方案 §二.6），壳不自动换端口 —— 所以请先腾出 " + S.Port + "。\r\n");
            sb.Append("→ 用「资源监视器 → 网络 → 侦听端口」查 " + S.Port + " 属于哪个程序，关掉它再启动。\r\n");
        }
        if (v.CoreExited)
            sb.Append("\r\n本壳的 core 也已退出（退出码 " + v.CoreExitCode + "）—— 端口被占（EADDRINUSE）是最常见的原因。\r\n");
        else
            sb.Append("\r\n本壳的 core 现在还没退，它会以 EADDRINUSE 退出（原因记在同目录的 core.log）。\r\n");
        sb.Append("\r\n对方响应片段（仅作诊断，**未渲染**）：" + v.ForeignSnippet + "\r\n");
        sb.Append("\r\n日志：" + SLog.ShellPath + "（core 的输出在同目录 core.log）");
        return sb.ToString();
    }

    string DetailCoreExit(HealthVerdict v)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("core 进程在健康检查完成前就退出了（退出码 " + v.CoreExitCode + "）。\r\n\r\n");
        if (v.ForeignStatus != 0)
        {
            string fpid = (v.ForeignPid.Length == 0) ? "(未自报)" : v.ForeignPid;
            string fsvc = (v.ForeignService.Length == 0) ? "(未自报)" : v.ForeignService;
            sb.Append("★★ 端口 " + S.Port + " 上已经有别的进程在应答（pid=" + fpid + "，service=" + fsvc + "）——\r\n");
            sb.Append("   这就是它退出的最常见原因：EADDRINUSE（端口被占）。壳不会把那个进程当成自己的 core。\r\n\r\n");
            sb.Append("→ 先腾出端口（结束 pid=" + fpid + " 那个进程），再启动一次。\r\n");
            sb.Append("→ 若那是上一个 agent-soul 的残留 core，结束它即可；不要在它还在跑时再开一个窗口。\r\n");
        }
        else
        {
            sb.Append("可能原因：node 路径不对、config.json 有语法错、端口被占用、或者 core 自己抛了异常。\r\n\r\n");
        }
        sb.Append("\r\n请把下面的日志（以及同目录的 core.log）发给我 —— 里面一定有退出原因。");
        return sb.ToString();
    }

    string DetailTimeout(HealthVerdict v)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append(S.HubUrl + "/api/health 一直没有给出「本壳启动的那个 core」的应答。\r\n\r\n");
        sb.Append("core 进程可能还活着，但没有进入可服务状态：首次建索引、配置文件指向了不存在的路径，");
        sb.Append("或者被别的东西挡住了回环端口。\r\n");
        if (v.ForeignStatus != 0)
            sb.Append("\r\n★ 期间端口上有过可疑应答（pid=" + v.ForeignPid + "）—— 见 shell.log 里的「可疑应答」几行。\r\n");
        sb.Append("\r\n壳保持打开：你可以先看日志，也可以直接关掉这个窗口");
        sb.Append("（关窗时会尽力把 core 停掉，不会留后台进程）。");
        return sb.ToString();
    }

    // ── 启动 ───────────────────────────────────────────────────────────────
    async void OnShown(object sender, EventArgs e)
    {
        try
        {
            // ★ AGENT_SOUL_START_HIDDEN=1：窗口一显示就收回去（不给「闪一下」的时间）。
            //   正常双击不会走到这里，所以默认行为一个字都没变。
            if (S.StartHidden)
            {
                hiddenToTray = true;
                ShowInTaskbar = false;
                Hide();
                SLog.W("tray: AGENT_SOUL_START_HIDDEN=1 → 主窗已隐藏（托盘保留，可由托盘恢复）");
            }

            SLog.W("run: exe=" + Application.ExecutablePath);
            SLog.W("run: 端口=" + S.Port + "  hub=" + S.HubUrl);
            SLog.W("run: node=" + S.NodeExe);
            SLog.W("run: core=" + S.CoreScript);
            SLog.W("run: cwd=" + S.CoreDir);
            SLog.W("run: udf=" + S.UdfDir);
            SLog.W("run: 布局=" + (S.DistLayout ? "分发版（app\\<版本>，INSTALL_ROOT=" + S.InstallRoot + "）" : "开发版（向上找 src）"));
            SLog.W("run: 健康检查 超时=" + S.HealthTimeoutMs + "ms 间隔=300ms 单次=500ms" + (S.TestMode ? " ★测试模式（core 脚本被环境变量改写）" : ""));

            // 状态栏几何 —— 启动日志里留一行，免得以后要「肉眼猜它到底在不在」
            try { SLog.W("ui: 状态栏 bounds=" + lblStatus.Bounds.ToString() + " 客户区=" + ClientSize.ToString()); } catch { }

            baselineWebViewProcs = Process.GetProcessesByName("msedgewebview2").Length;
            SLog.W("run: baseline msedgewebview2 进程数=" + baselineWebViewProcs);

            StartActivateWatcher();
            StartTestExitHook();
            StartTestUserCloseHook();
            if (!StartCore()) return;

            bool webOk = await InitWebView();
            if (!webOk) return;

            // ★ 起 core 和起 WebView2 是**并行**的：core 要几秒，WebView2 也要一两秒，
            //   串着做等于把两个等待相加。这里 WebView2 已经好了，再去等健康。
            HealthVerdict v = await Task.Run(delegate() { return WaitHealthy(); });
            SLog.W("health: 判定=" + v.Kind + "（启动后 " + SLog.Ms + " ms，尝试 " + v.Tries + " 次）");

            if (v.Kind == "ok")
            {
                SLog.W("nav: 开始导航 " + S.HubUrl + "/");
                web.Visible = true;
                Text = TITLE_BASE;
                web.CoreWebView2.Navigate(S.HubUrl + "/");
                // ★ 2026-11-11：核起来之后才开始看它。启动阶段由 WaitHealthy 负责 ——
                //   两套监控同时开，会在「启动失败」时各报一次、把错误页刷两次。
                StartCoreWatch();
            }
            else if (v.Kind == "foreign-core")
            {
                // ★ 这里**不导航**：端口上的应答不是本壳启动的那个进程。
                //   导航过去等于把别人的页面当应用显示（事故里那屏白页 "nope" 就是这么来的）。
                ShowError("端口 " + S.Port + " 被别的程序占着（不是本壳启动的 core）", DetailForeign(v));
            }
            else if (v.Kind == "core-exit")
            {
                ShowError("core 启动失败（进程已退出，退出码 " + v.CoreExitCode + "）", DetailCoreExit(v));
            }
            else
            {
                ShowError("core 没有按期启动（等了 " + (S.HealthTimeoutMs / 1000) + " 秒）", DetailTimeout(v));
            }
        }
        catch (Exception ex)
        {
            SLog.W("run: 异常 " + ex.GetType().Name + ": " + ex.Message);
            ShowError("壳自己出错了", ex.GetType().Name + ": " + ex.Message
                + "\r\n\r\n" + (ex.StackTrace == null ? "" : ex.StackTrace));
        }
    }

    void StartActivateWatcher()
    {
        // ★ 第二实例靠这个事件把第一实例叫到前面 —— 它比「找窗口 + SetForegroundWindow」可靠，
        //   因为 SetForegroundWindow 在 Windows 上有前台锁，常常返回 true 但没真的到前面。
        try { activateEvent = new EventWaitHandle(false, EventResetMode.AutoReset, EVENT_NAME); }
        catch (Exception ex) { SLog.W("activate: 建事件失败 " + ex.Message); return; }
        activateWatcher = new Thread(WatcherLoop);
        activateWatcher.IsBackground = true;
        activateWatcher.Start();
        SLog.W("activate: 事件已建 " + EVENT_NAME);
    }

    void WatcherLoop()
    {
        while (!shuttingDown)
        {
            bool got = false;
            try { got = activateEvent.WaitOne(500); } catch { return; }
            if (!got) continue;
            SLog.W("activate: 收到第二实例的唤起信号");
            try { BeginInvoke(new MethodInvoker(ActivateSelf)); } catch { }
        }
    }

    public void ActivateSelf()
    {
        if (hiddenToTray)
        {
            hiddenToTray = false;
            ShowInTaskbar = true;      // ★ 必须显式加回来：收进托盘时它是 false
            SLog.W("tray: 从托盘恢复窗口（ShowInTaskbar=true）");
        }
        if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
        Show();
        Native.ShowWindow(Handle, Native.SW_RESTORE);
        TopMost = true;
        TopMost = false;
        bool fg = Native.SetForegroundWindow(Handle);
        SLog.W("activate: SetForegroundWindow=" + fg + " IsIconic=" + Native.IsIconic(Handle)
            + " hiddenToTray=" + hiddenToTray);
    }

    // ── 图标：先读嵌入资源，读不到才退 ─────────────────────────────────────
    //
    // 为什么要嵌资源、而不是 Image.FromFile(build\assets\agentsoul.ico)：
    //   安装目录可能被挪走 / 只读 / 只拷 exe；托盘图标是**运行期一直在用**的东西，
    //   不能依赖「那个 ico 文件还在原地」。构建脚本也因此把 /win32icon 与 /resource 一起打进去。
    void LoadIcons()
    {
        try
        {
            Assembly asm = Assembly.GetExecutingAssembly();
            Stream st = asm.GetManifestResourceStream("AgentSoul.app.ico");
            if (st != null)
            {
                byte[] buf;
                using (st)
                {
                    using (MemoryStream ms = new MemoryStream())
                    {
                        byte[] tmp = new byte[8192];
                        int n;
                        while ((n = st.Read(tmp, 0, tmp.Length)) > 0) ms.Write(tmp, 0, n);
                        buf = ms.ToArray();
                    }
                }
                iconTray = new Icon(new MemoryStream(buf), 16, 16);
                iconWindow = new Icon(new MemoryStream(buf), 32, 32);
                SLog.W("icon: 已从嵌入资源载入 AgentSoul.app.ico（" + buf.Length + " 字节，16px/32px 两档）");
            }
            else SLog.W("icon: 嵌入资源 AgentSoul.app.ico 不存在 —— 退到 exe 图标");
        }
        catch (Exception ex)
        {
            SLog.W("icon: 读嵌入资源失败 " + ex.GetType().Name + ": " + ex.Message + " —— 退到 exe 图标");
        }

        if (iconWindow == null)
        {
            try { iconWindow = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        }
        if (iconTray == null)
        {
            if (iconWindow != null) { try { iconTray = new Icon(iconWindow, 16, 16); } catch { } }
            if (iconTray == null) iconTray = SystemIcons.Application;
        }
        if (iconWindow == null) iconWindow = SystemIcons.Application;
        try { Icon = iconWindow; } catch { }
    }

    // ── 托盘 ───────────────────────────────────────────────────────────────
    void BuildTray()
    {
        trayMenu = new ContextMenuStrip();
        trayMenu.ShowImageMargin = false;
        trayMenu.Font = new Font("Microsoft YaHei", 9.5F);

        ToolStripMenuItem miOpen = new ToolStripMenuItem("打开 AgentSoul");
        miOpen.Font = new Font("Microsoft YaHei", 9.5F, FontStyle.Bold);
        miOpen.Click += delegate(object sender, EventArgs e) { ActivateSelf(); };

        ToolStripMenuItem miStatus = new ToolStripMenuItem("状态台");
        miStatus.Click += delegate(object sender, EventArgs e) { ShowStatus(); };

        ToolStripMenuItem miExit = new ToolStripMenuItem("退出");
        miExit.Click += delegate(object sender, EventArgs e) { RequestExit(); };

        trayMenu.Items.Add(miOpen);
        trayMenu.Items.Add(miStatus);
        trayMenu.Items.Add(new ToolStripSeparator());
        trayMenu.Items.Add(miExit);

        tray = new NotifyIcon();
        tray.Icon = iconTray;
        tray.Text = "AgentSoul";
        tray.ContextMenuStrip = trayMenu;
        tray.Visible = true;                       // ★ 先可见，气泡提示才有地方落
        tray.DoubleClick += delegate(object sender, EventArgs e) { ActivateSelf(); };

        // ★ 日志里列出**真实的菜单项**（从 Items 里读，不是照抄一遍字面量）——
        //   测试据此判断三项都在，不是靠「我记得加过」。
        StringBuilder mb = new StringBuilder();
        foreach (ToolStripItem it in trayMenu.Items)
        {
            if (mb.Length > 0) mb.Append(", ");
            mb.Append(it is ToolStripSeparator ? "-" : it.Text);
        }
        SLog.W("tray: NotifyIcon 已就位（双击=打开 · 菜单=" + mb.ToString() + "）");
    }

    // 关窗 → 收进托盘。core 不动，优雅关闭一次都不该发生。
    void HideToTray()
    {
        hiddenToTray = true;
        Hide();
        // ★ ShowInTaskbar 放下之后：这个属性会**重建窗口句柄**（WS_EX_TOOLWINDOW），
        //   所以它一定要在 Hide() 之后、且只能从消息循环的下一拍调用（见 OnClosing）。
        ShowInTaskbar = false;
        SLog.W("tray: 关窗 → 已收进托盘（窗口隐藏，core 继续运行，壳 pid=" + Process.GetCurrentProcess().Id + "）");
        if (tray == null) return;
        tray.Text = "AgentSoul — 运行中（双击打开）";
        if (tipShown) return;
        tipShown = true;
        try
        {
            tray.ShowBalloonTip(4000, "AgentSoul 还在运行",
                "已收进托盘。双击图标回来；要彻底退出请右键图标 → 退出。", ToolTipIcon.Info);
            SLog.W("tray: 首次托盘提示已发出");
        }
        catch (Exception ex) { SLog.W("tray: 首次提示失败 " + ex.GetType().Name + ": " + ex.Message); }
    }

    // ★ 只有这里会把 exitRequested 置位 —— 判据只有一个来源，别处不许「顺手」退出。
    void RequestExit()
    {
        SLog.W("tray: 菜单「退出」被触发 → 走原有优雅关闭（POST /api/shutdown）");
        exitRequested = true;
        Close();     // FormClosing 里看到 exitRequested 才进 ShutdownFlow
    }

    void ShowStatus()
    {
        ActivateSelf();
        try
        {
            if (web != null && web.CoreWebView2 != null)
            {
                SLog.W("tray: 菜单「状态台」→ 导航 " + S.HubUrl + "/status");
                web.CoreWebView2.Navigate(S.HubUrl + "/status");
            }
            else SLog.W("tray: 菜单「状态台」—— WebView2 还没就绪，只把窗口叫到前面");
        }
        catch (Exception ex)
        {
            SLog.W("tray: 「状态台」导航异常 " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    // 测试钩子：给隔离测试一个「点菜单里的退出」的等价入口。
    // ★ 它调用的是**同一个 RequestExit()**，所以测到的是真退出路径；
    //   但它**不是**鼠标点击 —— 菜单项本身的点击接线只能靠代码审阅，报告里照实写。
    void StartTestExitHook()
    {
        string name = Environment.GetEnvironmentVariable("AGENT_SOUL_TEST_EXIT_EVENT");
        if (string.IsNullOrEmpty(name)) return;
        try { exitHook = new EventWaitHandle(false, EventResetMode.AutoReset, name); }
        catch (Exception ex) { SLog.W("tray: 测试钩子建事件失败 " + ex.Message); return; }
        exitHookThread = new Thread(delegate()
        {
            while (!shuttingDown)
            {
                bool got = false;
                try { got = exitHook.WaitOne(500); } catch { return; }
                if (!got) continue;
                SLog.W("tray: 测试钩子收到退出信号（调用与菜单「退出」相同的 RequestExit）");
                try { BeginInvoke(new MethodInvoker(RequestExit)); } catch { }
            }
        });
        exitHookThread.IsBackground = true;
        exitHookThread.Start();
        SLog.W("tray: 测试退出钩子已建（事件 " + name + "）—— 只有测试脚本会置位");
    }

    // 测试钩子：「点 X」的等价入口（2026-11-10 加）。
    // ★ 为什么不直接发 WM_CLOSE：那在 WinForms 眼里**永远是 TaskManagerClosing**
    //   （2026-11-10 实测，见 ShouldHideOnClose 的注释）——拿它测「点 X」等于测错了分支。
    //   所以这里不伪造消息，而是直接进**同一个 OnClosing**，只把 reason 换成 UserClosing。
    // ★ 它测到的是「判定 + 收进托盘」这条真实代码路径；
    //   没测到的是「鼠标点 X 会让 WinForms 报 UserClosing」—— 那一条是 WinForms 的既定语义，
    //   不属于本文件。报告里照实写这一句。
    void SimulateUserClose()
    {
        FormClosingEventArgs e = new FormClosingEventArgs(CloseReason.UserClosing, false);
        OnClosing(this, e);
        SLog.W("tray: 模拟点 X 完成（reason=UserClosing，cancel=" + e.Cancel + "）—— 由测试钩子发起，不是鼠标");
    }

    void StartTestUserCloseHook()
    {
        string name = Environment.GetEnvironmentVariable("AGENT_SOUL_TEST_USERCLOSE_EVENT");
        if (string.IsNullOrEmpty(name)) return;
        try { userCloseHook = new EventWaitHandle(false, EventResetMode.AutoReset, name); }
        catch (Exception ex) { SLog.W("tray: 模拟点 X 钩子建事件失败 " + ex.Message); return; }
        Thread t = new Thread(delegate()
        {
            while (!shuttingDown)
            {
                bool got = false;
                try { got = userCloseHook.WaitOne(500); } catch { return; }
                if (!got) continue;
                SLog.W("tray: 测试钩子收到「模拟点 X」信号（进同一个 OnClosing，reason=UserClosing）");
                // ★ 必须在 UI 线程上调用：OnClosing 里会 BeginInvoke(HideToTray)，
                //   而 HideToTray 改窗口属性 —— 从后台线程直接调会重建别的线程的句柄。
                try { BeginInvoke(new MethodInvoker(SimulateUserClose)); } catch { }
            }
        });
        t.IsBackground = true;
        t.Start();
        SLog.W("tray: 模拟点 X 钩子已建（事件 " + name + "）—— 只有测试脚本会置位");
    }

    // 真退出时把托盘 / 菜单 / 图标句柄一起还回去：
    // ★ NotifyIcon 不 Dispose 的话，进程走了图标还可能赖在通知区域，点它没有任何反应。
    void DisposeTray()
    {
        try
        {
            try { Icon = null; } catch { }
            if (tray != null)
            {
                tray.Visible = false;
                tray.ContextMenuStrip = null;
                tray.Dispose();
                tray = null;
            }
            if (trayMenu != null) { trayMenu.Dispose(); trayMenu = null; }
            if (iconTray != null && !object.ReferenceEquals(iconTray, SystemIcons.Application)) iconTray.Dispose();
            iconTray = null;
            if (iconWindow != null && !object.ReferenceEquals(iconWindow, SystemIcons.Application)) iconWindow.Dispose();
            iconWindow = null;
            SLog.W("tray: 已释放（NotifyIcon.Visible=false → Dispose，菜单与 2 个 Icon 句柄一并回收）");
        }
        catch (Exception ex)
        {
            SLog.W("tray: 释放异常 " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    // ── 起 core ────────────────────────────────────────────────────────────
    // ── 核的心跳监控（2026-11-11）──────────────────────────────────────────
    // ★ 缺口（实测两次）：核退出后壳不重启它、自己也不退。用户看到的是一个还开着的窗口，
    //   但 /api/health 再无应答 —— 「看起来在跑」和「真的在跑」分家了。
    // ★ 判据：每 2 秒看一眼 core.HasExited；真退出了且不是主动关闭（shuttingDown），
    //   就重启核并重新导航。
    // ★ 为什么限 3 次：崩溃循环不该无限重试（会把日志刷爆、磁盘写满），
    //   但一两次偶发崩溃值得救 —— 重启比把用户丢给一个错误页更接近他想要的结果。
    // ★ 语法限制：本文件 /langversion:5，不许插值字符串、不许 ?. 、不许表达式体。
    System.Windows.Forms.Timer coreWatch = null;
    int coreRestarts = 0;

    void StartCoreWatch()
    {
        coreRestarts = 0;
        coreWatch = new System.Windows.Forms.Timer();
        coreWatch.Interval = 2000;
        coreWatch.Tick += new EventHandler(OnCoreWatch);
        coreWatch.Start();
        SLog.W("watch: 已启动（每 2 秒，最多重启 3 次）");
    }

    /// 读 shutdown.log 最后一条，看那次退出是不是 graceful。
    /// ★ 为什么用文件而不是「问核」：核已经没了，问不到。它是唯一留下的证据。
    /// ★ 读不到就返回 false —— 宁可多重启一次，也不要因为读不到日志就假装"用户想关"。
    bool LastShutdownWasGraceful()
    {
        try
        {
            // ★★ 2026-11-11 第三次修：**这是判据一直失灵的真因**。
            //   `S.CoreDir` 在分发版里是 `app\<版本>`（CoreDir = CoreScript 的上两级），
            //   而 data/ 在**安装根**下（AGENT_SOUL_HOME 钉的就是它）。
            //   拿 CoreDir 拼 data → 一个永远不存在的路径 → File.Exists 恒 false →
            //   每一版「优雅退出」判定都返回 false，于是核被一遍遍拉回来。
            //   现在按「安装根优先、CoreDir 兜底」两个候选找，都不在才认 false。
            string p = null;
            if (!string.IsNullOrEmpty(S.InstallRoot))
            {
                string c1 = System.IO.Path.Combine(S.InstallRoot, "data", "shutdown.log");
                if (File.Exists(c1)) p = c1;
            }
            if (p == null && !string.IsNullOrEmpty(S.CoreDir))
            {
                string c2 = System.IO.Path.Combine(S.CoreDir, "data", "shutdown.log");
                if (File.Exists(c2)) p = c2;
            }
            if (p == null) return false;
            // 只看「刚刚」写过的那一份：旧记录里的 graceful:true 不代表这一次。
            DateTime mt = File.GetLastWriteTimeUtc(p);
            if ((DateTime.UtcNow - mt).TotalSeconds > 10.0) return false;
            string[] lines = File.ReadAllLines(p);
            for (int i = lines.Length - 1; i >= 0; i--)
            {
                string l = lines[i];
                if (l == null || l.Length == 0) continue;
                return l.IndexOf("\"graceful\":true") >= 0;
            }
        }
        catch { }
        return false;
    }

    void OnCoreWatch(object sender, EventArgs e)
    {
        if (shuttingDown) return;
        bool exited = false;
        try { if (core == null) exited = true; else exited = core.HasExited; }
        catch { exited = true; }
        if (!exited) return;

        try { coreWatch.Stop(); } catch { }
        int code = -1;
        try { code = core.ExitCode; } catch { }

        // ★★ 2026-11-11：先分清「核是自己优雅退出的」和「核崩了」。
        //   实测踩到：`POST /api/shutdown` 让核优雅退出（graceful:true, exit 0），
        //   而监控 2 秒后看到 HasExited 就把它**又拉起来了** —— 关闭等于失效。
        //   判据：退出码 0 + shutdown.log 最后一条 graceful:true。
        //   命中就说明「有人在有意关它」，壳跟着退，不再重启。
        // ★ 2026-11-11 修（第一版判据没生效）：原来要求 `core.ExitCode == 0`，
        //   但实测这颗 Process 的 ExitCode 常常取不到（流没读完 / 已 Dispose），code 停 -1，
        //   于是「优雅退出」永远判不出来 → 又把核拉起来了。
        //   **现在的判据只看证据，不看那个取不到的码**：shutdown.log 最后一条 graceful:true
        //   且文件在 10 秒内被写过 —— 那就是刚有人让它退的。
        bool gracefulExit = false;
        try { gracefulExit = LastShutdownWasGraceful(); } catch { }
        if (gracefulExit)
        {
            SLog.W("watch: 核是优雅退出的（/api/shutdown），壳跟着退，不再重启");
            // ★ 2026-11-11 第四次修：光调 Close() 不够 —— OnClosing 会按 ShouldHideOnClose
            //   把它判成「用户点了 X」→ 收进托盘，壳照样活着（实测 shell=1、core=0）。
            //   真正要退，必须先把 exitRequested 立起来，那才是「不是藏起来，是结束」。
            try { exitRequested = true; } catch { }
            try { BeginInvoke(new MethodInvoker(delegate() { Close(); })); } catch { }
            return;
        }

        if (coreRestarts >= 3)
        {
            SLog.W("watch: core 连续退出，已重启 3 次，停止重试（最后退出码 " + code + "）");
            ShowError("核心进程反复退出（已自动重启 3 次）",
                "最后一次退出码：" + code
                + "\r\n\r\n这通常意味着端口被占、或配置有问题。"
                + "\r\n详细日志：" + SLog.ShellPath);
            return;
        }

        coreRestarts++;
        SLog.W("watch: core 已退出（退出码 " + code + "），第 " + coreRestarts + " 次重启");
        if (!StartCore()) { SLog.W("watch: 重启 StartCore 返回 false"); return; }

        System.Threading.Tasks.Task.Run(delegate()
        {
            HealthVerdict v2 = WaitHealthy();
            SLog.W("watch: 重启后 health=" + v2.Kind);
            try
            {
                BeginInvoke(new MethodInvoker(delegate()
                {
                    if (v2.Kind == "ok")
                    {
                        try { Text = TITLE_BASE + " — 已自动重启核心（第 " + coreRestarts + " 次）"; } catch { }
                        try { if (web != null && web.CoreWebView2 != null) web.CoreWebView2.Navigate(S.HubUrl + "/"); } catch { }
                        try { coreWatch.Start(); } catch { }
                    }
                    else
                    {
                        ShowError("核心重启失败（" + v2.Kind + "）", DetailCoreExit(v2));
                    }
                }));
            }
            catch { }
        });
    }

    bool StartCore()
    {
        if (!File.Exists(S.CoreScript))
        {
            ShowError("找不到 core 脚本", S.CoreScript + " 不存在。\r\n\r\nAgentSoul.exe 必须放在 agent-soul 目录（或其子目录）里。");
            return false;
        }
        try
        {
            ProcessStartInfo psi = new ProcessStartInfo(S.NodeExe, "\"" + S.CoreScript + "\"");
            psi.WorkingDirectory = S.CoreDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            // ★ 只开主面板：手机通道（8901）不监听。
            //   这条是安全红线 —— 8901 绑的是 0.0.0.0，等于同一局域网谁都能读到对话。
            psi.EnvironmentVariables["AGENT_SOUL_CHAT"] = "off";
            // 端口必须和壳轮询的一致（core 读 config.port，环境变量优先）
            psi.EnvironmentVariables["AGENT_SOUL_PORT"] = S.Port.ToString();
            // ★ 父进程看门狗：壳被强杀时，core 自己会跟着退（见 src/util/parent-watchdog.mjs）
            psi.EnvironmentVariables["AGENT_SOUL_PARENT"] = Process.GetCurrentProcess().Id.ToString();
            // ★ 分发版：把「应用根」钉在安装根，而不是 app\<版本>。
            //   否则 config.json / data / workspace 会跟着版本走 —— 换个版本就等于换一台机器（设置没了、数据另起一份）。
            //   开发布局不设这一条：那时 appRoot() 就是仓库根，行为和以前完全一样。
            if (S.DistLayout && !string.IsNullOrEmpty(S.InstallRoot))
                psi.EnvironmentVariables["AGENT_SOUL_HOME"] = S.InstallRoot;

            core = Process.Start(psi);
            SLog.W("core: 已启动 pid=" + core.Id + " AGENT_SOUL_CHAT=off AGENT_SOUL_PORT=" + S.Port);

            Thread so = new Thread(delegate() { PumpCoreOutput(core.StandardOutput, "out"); });
            so.IsBackground = true;
            so.Start();
            Thread se = new Thread(delegate() { PumpCoreOutput(core.StandardError, "err"); });
            se.IsBackground = true;
            se.Start();
            return true;
        }
        catch (Exception ex)
        {
            ShowError("起不来 core 进程", "命令：" + S.NodeExe + " \"" + S.CoreScript + "\""
                + "\r\n\r\n" + ex.GetType().Name + ": " + ex.Message
                + "\r\n\r\n最常见的原因是 node 不存在（本机 PATH 上没有 node）。");
            return false;
        }
    }

    void PumpCoreOutput(StreamReader r, string tag)
    {
        try
        {
            while (true)
            {
                string line = r.ReadLine();
                if (line == null) break;
                SLog.Core("[" + tag + "] " + line);
            }
        }
        catch { }
    }

    // ── WebView2（显式 user data folder —— 这条是 ShellProbe2 验证过的做法）────
    async System.Threading.Tasks.Task<bool> InitWebView()
    {
        // ★ 2026-11-10（M1）：先**显式**问一次「本机有没有 WebView2 Runtime」。
        //   分发包**不随带**这个运行时（它由 Edge 分发，一百多 MB，随包等于和系统的抢版本）。
        //   所以缺了必须给一句能照着做的话，而不是把 EnsureCoreWebView2Async 的原始异常
        //   直接抛给用户 —— 那个异常名（WebView2RuntimeNotFoundException）对谁都不算提示。
        string wvVer = null;
        try { wvVer = CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch (Exception ex) { SLog.W("webview2: 运行时探测异常 " + ex.GetType().Name + ": " + ex.Message); }
        SLog.W("webview2: 本机 WebView2 Runtime 版本=" + (wvVer == null ? "(未检测到)" : wvVer));
        if (string.IsNullOrEmpty(wvVer))
        {
            ShowError("这台电脑缺少 WebView2 运行时", "AgentSoul 的界面靠 Microsoft Edge WebView2 Runtime 显示。"
                + "\r\n\r\n本安装包**不随带**这个运行时（它由微软通过 Edge 分发；随包会与系统的版本打架）。"
                + "\r\n\r\n怎么办：装一次「WebView2 Runtime Evergreen（x64）」—— 微软官网 / Edge 的下载页搜这个名字，"
                + "装完直接重开 AgentSoul，**不用重装本程序**。"
                + "\r\n\r\n日志：" + SLog.ShellPath + "（前一行写着「本机 WebView2 Runtime 版本=」，便于核对）");
            return false;
        }
        try
        {
            Directory.CreateDirectory(S.UdfDir);
            CoreWebView2EnvironmentOptions opt = new CoreWebView2EnvironmentOptions();
            CoreWebView2Environment env = await CoreWebView2Environment.CreateAsync(null, S.UdfDir, opt);
            SLog.W("webview2: CreateAsync 完成, BrowserVersion=" + env.BrowserVersionString);

            await web.EnsureCoreWebView2Async(env);
            SLog.W("webview2: EnsureCoreWebView2Async 完成, UserDataFolder=" + web.CoreWebView2.Environment.UserDataFolder);
            SLog.W("webview2: msedgewebview2 进程数=" + Process.GetProcessesByName("msedgewebview2").Length);

            web.CoreWebView2.NavigationCompleted += new EventHandler<CoreWebView2NavigationCompletedEventArgs>(OnNav);
            web.CoreWebView2.ProcessFailed += new EventHandler<CoreWebView2ProcessFailedEventArgs>(OnProcFailed);
            return true;
        }
        catch (Exception ex)
        {
            string detail = ex.GetType().Name + ": " + ex.Message;
            if (ex.InnerException != null) detail += "\r\n" + ex.InnerException.GetType().Name + ": " + ex.InnerException.Message;
            ShowError("WebView2 起不来", "浏览器组件没能初始化（页面没法显示）。"
                + "\r\n\r\n" + detail
                + "\r\n\r\n本机需要 WebView2 Runtime（Edge 自带的那份）。如果刚重装过系统，装一次 Evergreen Runtime 即可。");
            return false;
        }
    }

    void OnProcFailed(object sender, CoreWebView2ProcessFailedEventArgs e)
    {
        SLog.W("webview2: 进程失败 " + e.ProcessFailedKind.ToString());
    }

    async void OnNav(object sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        string url = "";
        try { url = web.CoreWebView2.Source; } catch { }
        if (url == null || url.Length == 0) url = S.HubUrl + "/";
        try
        {
            string status = e.IsSuccess ? "ok" : ("fail " + e.WebErrorStatus.ToString());
            SLog.W("nav: " + status + " url=" + url);

            if (e.IsSuccess)
            {
                string script = "(function(){return document.title || '(无标题)';})()";
                object raw = await web.CoreWebView2.ExecuteScriptAsync(script);
                string t = (raw == null) ? "" : raw.ToString();
                SLog.W("nav: document.title=" + t);
                ready = true;
                Text = TITLE_BASE + " — 就绪";
                SLog.W("nav: 界面已就绪（启动后 " + SLog.Ms + " ms）");
                return;
            }

            // ★ 2026-11-10：导航失败不许再「只改标题」。
            //   旧行为是留一个 WebView2 自己的错误页（英文、一堆按钮），或者干脆什么都不换
            //   —— 上一版那次事故里，用户看到的就是那个假 core 的 "nope" 白页。
            //   现在：URL + WebErrorStatus + 可行动的下一步，并且 ShowError 里会把 WebView 藏起来
            //   （一屏白页的来源被从根上掐掉）。
            ShowNavError(url, e.WebErrorStatus);
        }
        catch (Exception ex)
        {
            SLog.W("nav: 异常 " + ex.GetType().Name + ": " + ex.Message);
        }
    }

    void ShowNavError(string url, CoreWebView2WebErrorStatus st)
    {
        StringBuilder sb = new StringBuilder();
        sb.Append("地址：" + url + "\r\n");
        sb.Append("WebErrorStatus：" + st.ToString() + "（枚举 " + ((int)st) + "）\r\n\r\n");
        sb.Append("健康检查过了（应答的 pid 与本壳启动的 core 一致），但浏览器没能把这个地址加载出来。\r\n\r\n");
        sb.Append("常见原因：\r\n");
        sb.Append("· core 在应答健康检查之后退出了 —— 看下面日志里 core 的尾巴（若是 EADDRINUSE/端口被占，先腾出端口）；\r\n");
        sb.Append("· 端口上那一刻换了别的进程 —— 那么健康检查的结论已经过期；\r\n");
        sb.Append("· 页面自己返回了渲染不出来的东西。\r\n\r\n");
        sb.Append("可以这样做：\r\n");
        sb.Append("· 关掉这个窗口，再启动一次；\r\n");
        sb.Append("· 仍然不行，把 shell.log 和 core.log（同一个目录）发我。\r\n\r\n");
        sb.Append("日志：" + SLog.ShellPath + "（core 的输出在同目录 core.log）");
        ShowError("页面加载失败（" + st.ToString() + "）", sb.ToString());
    }

    // ── 健康检查（500ms 超时 / 300ms 间隔）—— 判据是「答话的就是我起的那个进程」──
    //
    // 契约（src/web/server.mjs 的 /api/health）：
    //   { ok:true, service:"agent-soul-core", pid:<进程号>, port:<端口>, ... }
    //
    // 判据三层：
    //   ① HTTP 200 且 body 里有 "ok":true —— 必要不充分（旧判据只到这里，所以会认错人）；
    //   ② body.pid == core.Id —— 充分。core.Id 是 Process.Start 拿到的**子进程句柄**，
    //      不是从命令行/窗口标题猜的，所以它回答的正是「这个应答者是不是我起的那个」；
    //   ③ 采信前再确认子进程没退 —— 应答可能在退出前的一瞬发出，那时导航必失。
    //
    // ★ 为什么只认 pid，不认 service、不认 fake 标志：
    //   测试模式下 AGENT_SOUL_CORE_SCRIPT 会被换成假 core（build\test\fake-*.mjs、
    //   data\_bench\fake-*.mjs），它们自报 pid 但不会自报 service:agent-soul-core。
    //   按「像不像真 core」去拒绝，会把既有的慢启动/关窗测试一起打死；
    //   而 pid 匹配**与真假无关** —— 它只回答「是不是我起的」，那才是这里要问的。
    //   service 只用来把话说清楚（是「另一个 agent-soul」还是「完全不相干的程序」）。
    //
    // ★ 为什么要 grace（3 秒）：旧事故的另一半是竞速 —— 外人先答 200，真 core
    //   晚一步才因 EADDRINUSE 退出。若一看到外人就立刻下结论，
    //   报错里就只剩「别人的 pid」，丢掉了「我的 core 为什么死」这条更关键的信息。
    //   所以先记下外人，再等 grace，把退出码一起收齐；超时窗口本身仍是硬上限。
    HealthVerdict WaitHealthy()
    {
        HealthVerdict v = new HealthVerdict();
        // ★ pid 只在这里取一次：它是整个等待期间**唯一的锚点**。
        //   每次循环重新读 core.Id 看起来更「新鲜」，实际是给「pid 在等待期间变了」留后门
        //   —— 那不可能发生（Process 对象句柄绑的是进程），而重读会让人怀疑判据不稳。
        try { if (core != null) v.ExpectPid = core.Id; }
        catch { }
        SLog.W("health: 期望 core pid=" + v.ExpectPid + "（身份契约 service+pid；只认这个 pid，不认 \"ok\":true）");

        const long FOREIGN_GRACE_MS = 3000;
        Stopwatch sw = Stopwatch.StartNew();
        long firstForeignMs = -1;

        while (sw.ElapsedMilliseconds < S.HealthTimeoutMs)
        {
            // ① 子进程先判死：它死了，再等也没有意义
            if (core != null)
            {
                bool exited = false;
                try { exited = core.HasExited; }
                catch { exited = true; }
                if (exited) return FillExit(v, sw);
            }

            v.Tries++;
            int status = 0;
            string body = "";
            bool got = HttpGet(S.HubUrl + "/api/health", 500, out status, out body);

            if (got && body != null && body.IndexOf("\"ok\":true", StringComparison.Ordinal) >= 0)
            {
                int rp = HIdent.JsonInt(body, "pid", -1);
                string svc = HIdent.JsonRaw(body, "service");

                if (v.ExpectPid > 0 && rp == v.ExpectPid)
                {
                    bool gone = false;
                    try { gone = core.HasExited; }
                    catch { gone = true; }
                    if (!gone)
                    {
                        v.Kind = "ok";
                        v.Ms = sw.ElapsedMilliseconds;
                        v.Service = (svc == null) ? "" : svc;
                        SLog.W("health: 身份匹配 ★ pid=" + rp + " service=" + (svc == null ? "(未自报)" : svc)
                            + " 第 " + v.Tries + " 次尝试, 用时 " + v.Ms + " ms");
                        return v;
                    }
                    SLog.W("health: pid 对上了但子进程紧接着退出 —— 不能采信，按 core-exit 报");
                    return FillExit(v, sw);
                }

                // ② 有人在应答，但不是本壳的子进程 —— 先记下来，别急着下结论
                if (firstForeignMs < 0)
                {
                    firstForeignMs = sw.ElapsedMilliseconds;
                    SLog.W("health: ★ 可疑应答 —— 端口 " + S.Port + " 上答话的不是我启动的进程：pid="
                        + (rp > 0 ? rp.ToString() : "(未自报)") + " service=" + (svc == null ? "(未自报)" : svc)
                        + " status=" + status + " 字节=" + body.Length);
                }
                v.ForeignStatus = status;
                v.ForeignPid = (rp > 0) ? rp.ToString() : "";
                v.ForeignService = (svc == null) ? "" : svc;
                v.ForeignBytes = body.Length;
                v.ForeignSnippet = HIdent.Snip(body, 180);
                if (v.ForeignSeenMs < 0) v.ForeignSeenMs = firstForeignMs;
            }
            else if (v.Tries == 1 || v.Tries % 10 == 0)
            {
                SLog.W("health: 第 " + v.Tries + " 次未就绪（status=" + status + ", " + sw.ElapsedMilliseconds + "ms）");
            }

            // ③ 见过外人后给 grace 把退出码收齐，然后按 foreign-core 报（**不导航**）
            if (firstForeignMs >= 0 && sw.ElapsedMilliseconds - firstForeignMs >= FOREIGN_GRACE_MS)
            {
                v.Kind = "foreign-core";
                v.Ms = sw.ElapsedMilliseconds;
                return v;
            }
            Thread.Sleep(300);
        }

        v.Ms = sw.ElapsedMilliseconds;
        // 超时的说法没有「端口上有人、但不是我的」准确 —— 见过外人的话按 foreign-core 报
        if (v.ForeignStatus != 0) v.Kind = "foreign-core"; else v.Kind = "timeout";
        return v;
    }

    HealthVerdict FillExit(HealthVerdict v, Stopwatch sw)
    {
        int ec = -1;
        try { ec = core.ExitCode; } catch { }
        v.Kind = "core-exit";
        v.CoreExited = true;
        v.CoreExitCode = ec;
        v.Ms = sw.ElapsedMilliseconds;

        // ★ core 死了，但端口上**还站着谁**必须问清楚：只报「退出码 1」等于让用户
        //   自己去猜 EADDRINUSE。这里补一次单发探测（500ms 上限、不循环）——
        //   有应答就把「占着端口的是谁」一并写进错误页；没应答就什么都不写。
        if (v.ForeignStatus == 0)
        {
            int st = 0;
            string b = "";
            bool got = HttpGet(S.HubUrl + "/api/health", 500, out st, out b);
            if (st != 0)
            {
                v.ForeignStatus = st;
                v.ForeignBytes = (b == null) ? 0 : b.Length;
                string fp = HIdent.JsonRaw(b, "pid");
                string fs = HIdent.JsonRaw(b, "service");
                v.ForeignPid = (fp == null) ? "" : fp;
                v.ForeignService = (fs == null) ? "" : fs;
                v.ForeignSnippet = HIdent.Snip(b, 180);
                SLog.W("health: core 已退出，但端口 " + S.Port + " 上仍有应答：status=" + st
                    + " pid=" + (fp == null ? "(未自报)" : fp) + " service=" + (fs == null ? "(未自报)" : fs)
                    + "（ok=" + got + "）");
            }
        }
        return v;
    }

    static bool HttpGet(string url, int timeoutMs, out int status, out string body)
    {
        status = 0;
        body = "";
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "GET";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.KeepAlive = false;
            req.Proxy = null;
            req.AllowAutoRedirect = false;
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            {
                status = (int)res.StatusCode;
                using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    body = sr.ReadToEnd();
            }
            return status == 200;
        }
        catch (WebException we)
        {
            HttpWebResponse r = we.Response as HttpWebResponse;
            if (r != null) { status = (int)r.StatusCode; try { r.Close(); } catch { } }
            return false;
        }
        catch { return false; }
    }

    static bool HttpPostEmpty(string url, int timeoutMs, out int status, out string body)
    {
        status = 0;
        body = "";
        try
        {
            HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.KeepAlive = false;
            req.Proxy = null;
            req.ContentLength = 0;
            req.ContentType = "application/json";
            using (HttpWebResponse res = (HttpWebResponse)req.GetResponse())
            {
                status = (int)res.StatusCode;
                using (StreamReader sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    body = sr.ReadToEnd();
            }
            return status >= 200 && status < 300;
        }
        catch (WebException we)
        {
            HttpWebResponse r = we.Response as HttpWebResponse;
            if (r != null) { status = (int)r.StatusCode; try { r.Close(); } catch { } }
            return false;
        }
        catch { return false; }
    }

    /// 只数**我们自己的** msedgewebview2 进程（按 --user-data-dir 里那个 udf 路径认）。
    ///
    /// ★ 为什么不能数全体：本机同时跑着别的 WebView2 应用（实测启动时就有 13 个），
    ///   拿「总数回到基线」当判据，等于让别人的进程决定我们退不退 ——
    ///   那既会多等，也会在别人开关窗口时给出假读数。
    static int CountOurWebViews(string udf)
    {
        int n = 0;
        try
        {
            using (ManagementObjectSearcher se = new ManagementObjectSearcher(
                "SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='msedgewebview2.exe'"))
            {
                foreach (ManagementObject o in se.Get())
                {
                    object cl = null;
                    try { cl = o["CommandLine"]; } catch { }
                    string s = (cl == null) ? "" : cl.ToString();
                    if (s.IndexOf(udf, StringComparison.OrdinalIgnoreCase) >= 0) n++;
                }
            }
        }
        catch { }
        return n;
    }

    // ── 关闭原因的分派（2026-11-10 · lead 定案）────────────────────────────
    // ★ 这段就是「关窗」和「退出」的全部判据，只此一处。
    //   CloseReason 的来历不是猜的：2026-11-10 用 closereason-probe 实测过 ——
    //   进程外 PostMessage(WM_CLOSE) 到 WinForms 窗口，报的**一律**是 TaskManagerClosing，
    //   报不出 UserClosing（SC_CLOSE 那条消息则根本关不掉窗口）。
    //   所以现实是：**自动化造不出 UserClosing**，它只属于「用户点了那个 X / 按了 Alt+F4」。
    //
    //   · UserClosing                      → 收进托盘（用户最近的那个按钮，不该杀掉正在跑的 core）
    //   · TaskManagerClosing               → 真退出（任务管理器/pstree/taskkill/任务栏右键「关闭窗口」）
    //   · ApplicationExitCall / ShutDown / None → 真退出
    //   · exitRequested（托盘「退出」）    → 真退出，优先于一切判据
    //
    // ★ 为什么 TaskManagerClosing 选真退出（而不是也收托盘）：
    //   它是**别人替用户按的 X** —— 没有「我还在用它」的含义。
    //   如果这里也收进托盘，用户在任务管理器里「结束任务」会变成静默无效
    //   （窗口只是藏了，系统稍后才会强杀），于是这个程序就**没有任何一个可预测的退出出口**。
    //   ★ 代价照实写：任务栏右键「关闭窗口」也走这条分支，它同样会真退出。
    //     接受这个代价 —— 用户按了「关闭」，得到一个真的关闭，比得到一个「看着关了其实还在跑」更可靠。
    //     想留着继续跑：点窗口右上角 X，或者别按关闭。
    static bool ShouldHideOnClose(CloseReason reason, bool exitRequested)
    {
        if (exitRequested) return false;                 // 托盘「退出」调的也是 Close()，reason 同样是 UserClosing
        return reason == CloseReason.UserClosing;        // ★ 只有 UserClosing 收托盘，其余一律真退出
    }

    // ── 关窗 ───────────────────────────────────────────────────────────────
    void OnClosing(object sender, FormClosingEventArgs e)
    {
        if (shuttingDown) return;

        if (ShouldHideOnClose(e.CloseReason, exitRequested))
        {
            e.Cancel = true;
            SLog.W("tray: 关窗分派 -> 收进托盘（原因=" + e.CloseReason + "，exitRequested=" + exitRequested + "）");
            // ★ 收进托盘必须放到消息循环的下一拍：HideToTray 会改 ShowInTaskbar，
            //   而那个属性会重建窗口句柄 —— 不能在正在处理 WM_CLOSE 的栈上重建它。
            try { BeginInvoke(new MethodInvoker(HideToTray)); }
            catch { HideToTray(); }
            return;
        }

        e.Cancel = true;          // 先拦住，等关闭流程真的做完再退出
        shuttingDown = true;
        // ★ 2026-11-11：主动关闭时停掉核监控 —— 否则它会看到「核退出了」然后去重启一个
        //   我们正在有意关掉的核，等于自己跟自己打架。
        try { if (coreWatch != null) coreWatch.Stop(); } catch { }
        SLog.W("shutdown: 真退出（原因=" + e.CloseReason + "，exitRequested=" + exitRequested + "）");
        Thread t = new Thread(ShutdownFlow);
        t.IsBackground = false;   // ★ 不设 false 的话，主线程一退它就跟着没了 —— 恰恰是这时候不能没
        t.Start();
    }

    // ── 关窗期间的状态显示 ─────────────────────────────────────────────────
    // ★ 从后台线程改 UI 必须回到 UI 线程：BeginInvoke 不阻塞（Invoke 会阻塞到 UI 处理完，
    //   而离线的 Invoke 在这条路径上会把 ShutdownFlow 自己吊住）。
    void SetClosingStatus(string s)
    {
        try
        {
            if (IsDisposed) return;
            if (InvokeRequired)
            {
                try { BeginInvoke(new MethodInvoker(delegate() { ApplyClosingStatus(s); })); }
                catch { }
            }
            else ApplyClosingStatus(s);
        }
        catch { }
    }

    void ApplyClosingStatus(string s)
    {
        try { Text = TITLE_BASE + " — " + s; } catch { }
        try { if (lblStatus != null) { lblStatus.Text = s; lblStatus.Visible = true; } } catch { }
    }

    void ShutdownFlow()
    {
        Stopwatch sw = Stopwatch.StartNew();
        SLog.W("shutdown: 收到关窗请求（界面是否已就绪=" + ready + "，exitRequested=" + exitRequested + "）");
        SetClosingStatus("正在收尾…（正在请 core 落盘索引缓存）");

        // ★★ 2026-11-10：这一整段改了两件事，对应 data/shutdown.log 里那条
        //     {"reason":"shell:timeout","graceful":false,"httpDrained":false}
        //
        //   ① POST 改成**每秒重试**，直到成功或总预算（CoreExitWaitMs，默认 60 秒）用完。
        //      为什么必须重试：启动期 core 的事件循环可能正被同步建索引占住 3–40 秒，
        //      单次 2 秒超时根本连不上 —— 而以前的逻辑是「失败一次就转去等退出 → 强杀」。
        //      「连不上」在这里的含义是**它还没空理我**，不是**它不认这个端点**。
        //      后一种情况壳会在 60 秒后照常强杀，日志里会写明重试了几次。
        //   ② 等待预算 10 秒 → 60 秒，并在窗口标题/状态栏写「正在收尾…」。
        //      等待变长之后，界面必须给出反馈 —— 否则用户以为卡死，去任务管理器强杀，
        //      那就回到了「缓存没写 → 下次还是全量重建」的老路。
        //
        //   ★ 为什么要重试而不是「一次等 60 秒」：单次 HTTP 超时给 60 秒的话，
        //     第一秒 core 就空闲了也没人来问；而每秒一次的重试，core 一空出来就在 1 秒内被叫到。
        long deadline = S.CoreExitWaitMs;   // 整个「请它退 + 等它退」共用一个预算

        // ① 先让 core 自己退（它要冲索引缓存、写 shutdown.log）
        int status = 0;
        string body = "";
        long postMs = -1;
        int postTries = 0;
        bool accepted = false;
        if (core != null)
        {
            Stopwatch psw = Stopwatch.StartNew();
            while (true)
            {
                bool exited = false;
                try { exited = core.HasExited; } catch { exited = true; }
                if (exited)
                {
                    int ec = -1;
                    try { ec = core.ExitCode; } catch { }
                    SLog.W("shutdown: core 已经退出（退出码 " + ec + "），不必再 POST");
                    break;
                }
                if (psw.ElapsedMilliseconds >= deadline) break;

                postTries++;
                status = 0;
                body = "";
                bool ok = false;
                try { ok = HttpPostEmpty(S.HubUrl + "/api/shutdown", 2000, out status, out body); }
                catch (Exception ex) { SLog.W("shutdown: POST 异常 " + ex.GetType().Name + ": " + ex.Message); }
                accepted = ok && status >= 200 && status < 300;
                SLog.W("shutdown: POST /api/shutdown 第 " + postTries + " 次 -> ok=" + ok
                    + " status=" + status + " 累计=" + psw.ElapsedMilliseconds + "ms body=" + body);
                if (accepted) break;

                // 没连上：多半是它的事件循环还忙着（建索引 / 冲缓存）
                SetClosingStatus("正在收尾…（core 忙，已重试 " + postTries + " 次，最多等 "
                    + (S.CoreExitWaitMs / 1000) + " 秒）");
                if (psw.ElapsedMilliseconds + 1000 >= deadline) break;
                Thread.Sleep(1000);
            }
            postMs = psw.ElapsedMilliseconds;
        }

        // ② 等子进程退出（预算共享：POST 花掉的时间要从等待里扣掉）
        bool coreExited = true;
        long waited = 0;
        int seen = 0;
        if (core != null)
        {
            Stopwatch wsw = Stopwatch.StartNew();
            coreExited = false;
            while (wsw.ElapsedMilliseconds < deadline)
            {
                try { if (core.HasExited) { coreExited = true; break; } }
                catch { coreExited = true; break; }
                seen++;
                if (seen % 2 == 0)
                {
                    SetClosingStatus("正在收尾…（还在写索引缓存，已等 "
                        + ((postMs + wsw.ElapsedMilliseconds) / 1000) + " 秒 / 最多 "
                        + (S.CoreExitWaitMs / 1000) + " 秒）");
                }
                Thread.Sleep(50);
            }
            waited = wsw.ElapsedMilliseconds;
        }
        long coreCode = -1;
        if (core != null && coreExited) { try { coreCode = core.ExitCode; } catch { } }
        SLog.W("shutdown: POST 共 " + postTries + " 次 接受=" + accepted + " 用时=" + postMs
            + "ms；core 退出=" + coreExited + " 等了 " + waited + "ms 退出码=" + coreCode);

        // ③ 等不到就强杀 —— 并且**必须记下 graceful:false**，
        //    因为 data/shutdown.log 里那一行 graceful 是判断「这次到底优雅没优雅」的唯一凭据。
        if (!coreExited && core != null)
        {
            SLog.W("shutdown: graceful:false 强杀 core pid=" + core.Id);
            try { core.Kill(); } catch (Exception ex) { SLog.W("shutdown: 强杀失败 " + ex.Message); }
            try { core.WaitForExit(2000); } catch { }
        }
        else
        {
            SLog.W("shutdown: graceful:true");
        }

        // ④ 关 WebView2（要在 UI 线程上做）
        int before = CountOurWebViews(S.UdfDir);
        try
        {
            Invoke(new MethodInvoker(delegate()
            {
                try { if (web != null) { web.Dispose(); } }
                catch (Exception ex) { SLog.W("shutdown: dispose 异常 " + ex.GetType().Name + ": " + ex.Message); }
            }));
        }
        catch (Exception ex) { SLog.W("shutdown: invoke 异常 " + ex.GetType().Name + ": " + ex.Message); }
        SLog.W("shutdown: WebView2 Dispose 返回，耗时 " + sw.ElapsedMilliseconds + "ms，我们自己的 msedgewebview2 " + before + " → " + CountOurWebViews(S.UdfDir));

        // 浏览器进程通常比窗口晚一点消失（Dispose 只是放手，它自己还要收尾）。
        // ★ 最多等 2 秒 —— 关窗后进程赖着不走，用户体感比「浏览器晚半秒退出」糟得多。
        //   等不到也照退：剩下的会被 Windows 连同窗口一起收走（实测 Disposable 后基本 1s 内归零）。
        int settle = 0;
        while (settle < 2000)
        {
            if (CountOurWebViews(S.UdfDir) == 0) break;
            Thread.Sleep(100);
            settle += 100;
        }

        SLog.W("shutdown: 结束 关窗→进程消失 " + sw.ElapsedMilliseconds + "ms（POST " + postMs + "ms · 等 core " + waited + "ms · 浏览器归零 " + settle + "ms）");
        DisposeTray();
        Environment.Exit(0);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
static class Program
{
    // ★ 2026-11-10（托盘测试暴露的真 bug）：互斥量必须有人**一直持有**。
    //   原来它是 Main 里的局部变量 —— JIT 可以在最后一次使用之后就把引用判死，
    //   GC 一收，Mutex 的句柄被关，单实例立刻失效：第二份双击会另起一个 core，
    //   然后因为端口被占而显示「启动失败」。这不是理论问题，是 tray-icon-tests 的 C 用例抓到的。
    static Mutex _instanceMutex;

    [STAThread]
    static int Main(string[] args)
    {
        // ★ 2026-11-10：隔离测试要一套独立的 shell.log / WebView2 profile，
        //   否则测试会写进用户的真实日志里。默认路径一个字都不变。
        string baseDir = Environment.GetEnvironmentVariable("AGENT_SOUL_SHELL_HOME");
        if (string.IsNullOrEmpty(baseDir))
        {
            baseDir = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "AgentSoul");
        }
        try { SLog.Init(baseDir); } catch { }
        SLog.W("=== AgentSoul 壳启动 M0 ===");
        SLog.W("shell-home=" + baseDir);
        SLog.W("args=" + string.Join(" ", args));
        SLog.W("os=" + Environment.OSVersion.VersionString + " clr=" + Environment.Version.ToString() + " 64bit=" + Environment.Is64BitProcess);

        // ── 单实例 ──────────────────────────────────────────────────────────
        bool createdNew = false;
        Mutex mutex = new Mutex(true, ShellSettings_ResolveMutexName(), out createdNew);
        _instanceMutex = mutex;      // ★ 静态字段持有：进程活多久，它就活多久
        if (!createdNew)
        {
            SLog.W("instance-2: 已有实例在跑 —— 唤起它，然后自己退出");
            int pid1 = 0;
            IntPtr h = Native.FindByTitlePrefix("AgentSoul", out pid1);
            SLog.W("instance-2: 找到窗口 hwnd=" + h.ToInt64() + " pid=" + pid1 + " title=" + Native.TitleOf(h));
            if (h != IntPtr.Zero)
            {
                bool allow = Native.AllowSetForegroundWindow(pid1);
                bool show = Native.ShowWindow(h, Native.SW_RESTORE);
                bool fg = Native.SetForegroundWindow(h);
                SLog.W("instance-2: Allow=" + allow + " Show=" + show + " SetForeground=" + fg);
            }
            int tries = 0;
            while (tries < 40)
            {
                try
                {
                    EventWaitHandle ev = EventWaitHandle.OpenExisting(@"Local\AgentSoul.Activate");
                    ev.Set();
                    ev.Close();
                    SLog.W("instance-2: 已发出 activate 事件（第 " + (tries + 1) + " 次尝试）");
                    break;
                }
                catch { Thread.Sleep(50); tries++; }
            }
            SLog.W("instance-2: 退出（存活 " + SLog.Ms + " ms）");
            return 0;
        }
        SLog.W("instance-1: 获得单实例互斥量（Local\\ 作用域）");

        ShellSettings settings;
        try { settings = ShellSettings.Resolve(baseDir); }
        catch (Exception ex)
        {
            SLog.W("settings: 失败 " + ex.Message);
            MessageBox.Show(ex.Message, "AgentSoul 启动失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 2;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new ShellForm(settings));
        SLog.W("main: 消息循环已返回");
        return 0;
    }

    // ★ 互斥量名只写一次，避免「判据两处各写一遍」那类错
    static string ShellSettings_ResolveMutexName()
    {
        return @"Local\AgentSoul.SingleInstance";
    }
}
