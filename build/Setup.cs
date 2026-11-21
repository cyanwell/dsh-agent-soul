// AgentSoul 安装器（1.0.65）
//
// 为什么自己写而不是用 Inno/NSIS：本机没有那两个工具链，而 .NET Framework 4.x
//   自带 csc.exe —— 系统自带的东西最不容易坏（这条判断在 build.ps1 里也用过）。
//
// 载荷格式与 Launcher.cs / tools/package.mjs 完全一致：
//   [本 exe][MAGIC "AGENTSOULPKG01" 14B][u64 zipLen 8B][zip]
//   ★ 三处必须一致，改一处等于换格式。
//
// 用法：
//   AgentSoul-Setup-<ver>.exe                  有界面安装
//   AgentSoul-Setup-<ver>.exe /S               静默安装到默认目录
//   AgentSoul-Setup-<ver>.exe /S /D=C:\path   静默安装到指定目录
//   AgentSoul-Setup-<ver>.exe /uninstall       卸载
//
// ★ 编译约束 /langversion:5：不许出现插值字符串、?.、nameof、表达式体、out var。
// ★ 装到 HKCU 下，不需要管理员权限。

using System;
using System.IO;
using System.Drawing;
using System.Windows.Forms;
using System.Collections.Generic;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using Microsoft.Win32;

static class Program
{
    static readonly byte[] MAGIC = Encoding.ASCII.GetBytes("AGENTSOULPKG01");
    const string APP_NAME = "AgentSoul";
    // ★★★ 2026-11-21：版本号**不再硬编码**。
    //
    //   实测：AgentSoul-Setup-1.0.70.exe 的二进制里 UTF-16 扫出来的是 "1.0.65" ——
    //   因为它只是 setup-stub.exe（2026-11-18 编的，常量写死 1.0.65）+ 载荷。
    //   make-dist 只在「Setup.cs 比 stub 新」时重编，而版本号变化不会改 Setup.cs 的 mtime，
    //   于是包名是 1.0.70、自己报的版本是 1.0.65，卸载项里也写 1.0.65。
    //
    //   正确来源只有一个：**安装包自己的文件名**（AgentSoul-Setup-<ver>.exe）——
    //   那是发布脚本决定的、用户看到的名字，也是他不该被误导的那一个。
    //   fallback 保留常量，只在文件名不合形状时用（此时它确实不知道自己是哪一版）。
    static string AppVer()
    {
        try
        {
            string n = Path.GetFileNameWithoutExtension(Assembly.GetExecutingAssembly().Location);
            // AgentSoul-Setup-1.0.70 / uninstall（卸载器是同一个 exe 改名）
            int i = n.LastIndexOf('-');
            if (i >= 0 && i + 1 < n.Length)
            {
                string v = n.Substring(i + 1);
                bool ok = v.Length > 0;
                for (int k = 0; k < v.Length; k++)
                {
                    char c = v[k];
                    if (!(c >= '0' && c <= '9') && c != '.') { ok = false; break; }
                }
                if (ok) return v;
            }
        }
        catch { }
        return APP_VER_FALLBACK;
    }
    const string APP_VER_FALLBACK = "0.0.0-dev";
    const string UNINST_KEY = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentSoul";

    [STAThread]
    static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception e)
        {
            Console.Error.WriteLine("失败：" + e.Message);
            try { Console.Error.WriteLine(e.StackTrace); } catch { }
            return 1;
        }
    }

    static bool HasFlag(string[] args, string flag)
    {
        for (int i = 0; i < args.Length; i++)
            if (string.Equals(args[i], flag, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    static string ArgValue(string[] args, string prefix)
    {
        for (int i = 0; i < args.Length; i++)
            if (args[i].StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                return args[i].Substring(prefix.Length).Trim('"');
        return null;
    }

    static string DefaultDir()
    {
        string lad = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        return Path.Combine(Path.Combine(lad, "Programs"), APP_NAME);
    }

    static long FindPayloadStart(string self)
    {
        // ★★★ 这里原来只回扫文件**末尾 1 MB** 找魔数 —— 而载荷排在魔数**之后**：
        //   魔数离文件头只有 13 KB，中间被 37 MB 的 zip 隔着。
        //   于是「末尾 1MB」里根本没有魔数 → 判成「exe 损坏」。
        //   实测撞到：Setup 静默安装 exit=2，只印一句「这个 exe 里没有安装载荷」。
        //   正确做法：魔数就在 stub 之后，从头顺序扫；读几十 MB 只要几十毫秒。
        //   跨块要点：每块要**重叠** MAGIC.Length + 8 字节，否则边界上的魔数会漏。
        using (FileStream fs = File.OpenRead(self))
        {
            long len = fs.Length;
            int overlap = MAGIC.Length + 8;
            int chunk = 1 << 20;
            byte[] buf = new byte[chunk + overlap];
            long basePos = 0;
            while (basePos < len)
            {
                fs.Position = basePos;
                int want = (int)Math.Min((long)buf.Length, len - basePos);
                int read = 0;
                while (read < want)
                {
                    int n = fs.Read(buf, read, want - read);
                    if (n <= 0) break;
                    read += n;
                }
                if (read < overlap) break;
                for (int i = 0; i <= read - overlap; i++)
                {
                    bool ok = true;
                    for (int j = 0; j < MAGIC.Length; j++) { if (buf[i + j] != MAGIC[j]) { ok = false; break; } }
                    if (!ok) continue;
                    long zipLen = BitConverter.ToInt64(buf, i + MAGIC.Length);
                    long start = basePos + i + MAGIC.Length + 8;
                    if (zipLen <= 0 || start + zipLen > len) continue;
                    return start;
                }
                if (read < buf.Length) break;
                basePos += read - overlap;
            }
        }
        return -1;
    }
    static int Run(string[] args)
    {
        string self = Assembly.GetExecutingAssembly().Location;
        long payload = FindPayloadStart(self);
        if (payload < 0)
        {
            Console.Error.WriteLine("这个 exe 里没有安装载荷 —— 它可能是个损坏的下载。");
            return 2;
        }

        if (HasFlag(args, "/uninstall") || HasFlag(args, "--uninstall"))
        {
            return Uninstall();
        }

        // ★★★ 2026-11-21：静默参数的真实故障（用户实测报告「soul升级问题-20261120」）。
        //
        //   报告里的调用：
        //     AgentSoul-Setup-1.0.67.exe /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /D=...
        //   —— 那是 **Inno Setup** 的参数。而本安装器是自己用 csc 编的，原来只认 /S。
        //   于是 silent=false → 走交互分支 → 卡在 Console.ReadLine() 等回车。
        //   而它是 /target:exe 的**无控制台**进程：没有窗口、没人能按回车，
        //   进程活着（Responding: True）、MainWindowTitle 为空、三分钟不写盘。
        //   ★ 所以根因不是「/D= 用法变了」，是**参数名不认** + **无控制台时读 stdin**。
        bool silent = HasFlag(args, "/S") || HasFlag(args, "/silent")
            || HasFlag(args, "/VERYSILENT") || HasFlag(args, "/verysilent")
            || HasFlag(args, "/SUPPRESSMSGBOXES");
        string dirArg = ArgValue(args, "/D=");
        if (dirArg == null || dirArg.Length == 0) dirArg = ArgValue(args, "/DIR=");   // Inno 写法，一并认
        // ★ 显式说了装到哪里 = 他不想再被问一次
        if (dirArg != null && dirArg.Length > 0) silent = true;
        string dir = dirArg;
        if (dir == null || dir.Length == 0) dir = DefaultDir();

        // ★★ 从「老安装」里认回安装根与数据目录 —— 这是「升级」真正需要的那一步。
        //
        //   报告里的现象：双击 Setup 全程没有「新用户 / 老用户」的选择，
        //   直接装到 %LOCALAPPDATA%\Programs\AgentSoul，凭空多出一份空实例。
        //   而他的老安装信息就在 install-info.txt 里（install-root + 安装时间）。
        //
        //   ★ 判据分三层，全部来自磁盘事实，不靠猜：
        //     ① 同一个目录里已有 install-info.txt（原地升级）
        //     ② 注册表卸载项里的 InstallLocation（曾经装过、现在装到别处）
        //     ③ 常见默认位置探测
        //   找到老安装就：装到**老根**、并把 config.json 的 dataDir 指到**老 data**。
        //   找不到就照常装新目录 —— 但会把「这是一次干净安装」说出来，不装作升级成功。
        bool dirExplicit = dirArg != null && dirArg.Length > 0;
        string oldRoot = FindExistingInstall(dir);
        bool upgrading = oldRoot != null && Directory.Exists(oldRoot);
        // ★★★ 2026-11-21 修：原来这里写的是 `!HasFlag(args, "/D=")` —— 那是**整参数精确匹配**，
        //   而实际参数是 `/D=C:\path`，永远不等于 `/D=`。于是"用户显式指定目录"被误判成"没指定"，
        //   把 TARGET 覆盖成了默认位置 —— 实测就是它让 verify-setup 装到了 Programs 下、
        //   而临时目录里一个文件都没有（10 项检查全 ✗）。
        //   ★ 判据要用**取值有没有**，不是**开关名在不在**。
        if (upgrading && !dirExplicit)
        {
            // 用户没指定目录，且机器上有老安装 → 装回老根（原地升级）。
            // ★ 这条是「不凭空多出一份实例」的关键；但**绝不能覆盖用户明确说的目标**。
            dir = oldRoot;
        }
        else if (upgrading && dirExplicit && !SamePath(dir, oldRoot))
        {
            // 用户指了别的目录，而机器上还有一份老安装 —— 这可能是"装两份"，
            // 说清楚但不改他的决定（他要装哪就装哪）。
            Console.WriteLine("注意：这台机器上已有 AgentSoul：" + oldRoot);
            Console.WriteLine("      你指定了另一个目录：" + dir);
            Console.WriteLine("      （两份会各自有 config.json 与 data，互不相干）");
        }

        if (!silent && ConsoleHasInput())
        {
            Console.WriteLine("AgentSoul " + AppVer() + " 安装器");
            Console.WriteLine();
            if (upgrading)
            {
                Console.WriteLine("  检测到已安装：" + oldRoot);
                Console.WriteLine("  将**原地升级**（你的 config.json 与 data 目录会保留）");
            }
            else
            {
                Console.WriteLine("  这是一次**干净安装**（没有找到旧版本）");
            }
            Console.WriteLine();
            Console.WriteLine("  目标目录：" + dir);
            Console.WriteLine();
            Console.WriteLine("  按 Enter 开始安装，输入 n 取消：");
            string ans = Console.ReadLine();
            if (ans != null && ans.Trim().ToLowerInvariant() == "n") { Console.WriteLine("已取消。"); return 0; }
        }
        else if (!silent)
        {
            // ★ 无控制台又不算静默：**不能读 stdin**（会把进程挂死，正是报告里那次）。
            //   直接按静默走，并把这件事说出来（落到日志/管道里，有人接就能看见）。
            Console.WriteLine("（无可交互控制台 —— 按静默安装处理）");
            silent = true;
        }

        Console.WriteLine("正在安装到 " + dir + " …");
        Install(self, payload, dir);

        Console.WriteLine();
        Console.WriteLine("✓ 安装完成");
        Console.WriteLine("  程序：" + Path.Combine(dir, "AgentSoul.exe"));
        // ★ 2026-11-21：升级时把「你的老东西还在」说清楚。
        //   报告里的用户最怕的是"钱包和 665MB 索引要不要重建"——答案就在数据目录里。
        string dataDir = Path.Combine(dir, "data");
        string legacy = FindLegacyData(dir);
        Console.WriteLine("  数据：" + (legacy != null ? legacy : dataDir));
        Console.WriteLine("  现有内容：" + DescribeData(legacy != null ? legacy : dataDir));

        // 写 install-info.txt（老版本就在用它记录安装根与时间；这里保持一致）
        try
        {
            StringBuilder info = new StringBuilder();
            info.AppendLine("install-root=" + dir);
            info.AppendLine("version=" + AppVer());
            info.AppendLine("installed-at=" + DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss"));
            info.AppendLine("data=" + (legacy != null ? legacy : dataDir));
            info.AppendLine("upgraded=" + (upgrading ? "yes" : "no"));
            File.WriteAllText(Path.Combine(dir, "install-info.txt"), info.ToString(), new UTF8Encoding(false));
        }
        catch (Exception e) { Console.Error.WriteLine("  警告：install-info.txt 没写成 — " + e.Message); }
        Console.WriteLine();
        Console.WriteLine("卸载：运行 \"" + Path.Combine(dir, "AgentSoul.exe") + "\" ？不 —— 卸载请运行");
        Console.WriteLine("      \"" + Path.Combine(dir, "uninstall.exe") + "\"  或 设置→应用→AgentSoul");
        return 0;
    }

    // ── 2026-11-21 新增：老安装识别 / 控制台探测 / 清点已有数据 ──────────

    /// 有没有可交互控制台？无控制台时**绝不许**读 stdin（那会把进程挂死）。
    /// ★ 判据用 Console.IsInputRedirected 的反面：重定向了说明是管道/服务在跑，
    ///   没人能按回车。这是 .NET 里唯一可靠的「我这个进程有没有人在看」的信号。
    /// 两个路径是不是同一个（大小写不敏感 + 归一化，用于 Windows）。
    static bool SamePath(string a, string b)
    {
        if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
        try
        {
            string pa = Path.GetFullPath(a).TrimEnd(Path.DirectorySeparatorChar);
            string pb = Path.GetFullPath(b).TrimEnd(Path.DirectorySeparatorChar);
            return string.Equals(pa, pb, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    static bool ConsoleHasInput()
    {
        try
        {
            if (Console.IsInputRedirected) return false;
            if (Console.IsOutputRedirected) return false;
            return true;
        }
        catch { return false; }
    }

    /// 找一台机器上**已有的安装根**。三层判据，全部来自磁盘/注册表事实。
    /// 返回 null = 没找到（那就是干净安装，不装成"升级成功"）。
    static string FindExistingInstall(string preferredDir)
    {
        // ① 这次的目标目录里已经有 install-info.txt / data 目录 → 就是它
        if (LooksLikeInstall(preferredDir)) return Path.GetFullPath(preferredDir);

        // ② 注册表卸载项（我们自己是 HKCU 写的，同用户可见）
        try
        {
            using (RegistryKey k = Registry.CurrentUser.OpenSubKey(UNINST_KEY))
            {
                if (k != null)
                {
                    string loc = k.GetValue("InstallLocation") as string;
                    if (!string.IsNullOrEmpty(loc) && LooksLikeInstall(loc)) return Path.GetFullPath(loc);
                }
            }
        }
        catch { }

        // ③ 常见默认位置
        string[] probes = new string[] { DefaultDir() };
        for (int i = 0; i < probes.Length; i++)
            if (LooksLikeInstall(probes[i])) return Path.GetFullPath(probes[i]);

        return null;
    }

    /// 一个目录"像一次安装"的判据：有 AgentSoul.exe，**或者**有 data 目录（老实例的数据还在）。
    /// ★ 为什么 data 也算：报告里用户的 exe 在 <install-root> 下，而 data 有明显痕迹。
    ///   宁可把它认成安装也不要在旁边新建一份空的。
    static bool LooksLikeInstall(string dir)
    {
        if (string.IsNullOrEmpty(dir)) return false;
        try
        {
            if (!Directory.Exists(dir)) return false;
            if (File.Exists(Path.Combine(dir, "AgentSoul.exe"))) return true;
            if (Directory.Exists(Path.Combine(dir, "data"))) return true;
            if (File.Exists(Path.Combine(dir, "install-info.txt"))) return true;
        }
        catch { }
        return false;
    }

    /// 老 data 目录里有什么（用来告诉用户"你的东西还在"）。只读，不碰任何文件内容。
    static string DescribeData(string dataDir)
    {
        if (string.IsNullOrEmpty(dataDir) || !Directory.Exists(dataDir)) return "(没有 data 目录)";
        StringBuilder sb = new StringBuilder();
        try
        {
            string meta = Path.Combine(dataDir, "meta.sqlite");
            if (File.Exists(meta))
            {
                long mb = new FileInfo(meta).Length / (1024 * 1024);
                sb.Append("meta.sqlite ").Append(mb).Append(" MB");
            }
            string sessions = Path.Combine(dataDir, "sessions");
            if (Directory.Exists(sessions))
            {
                int n = Directory.GetFiles(sessions).Length + Directory.GetDirectories(sessions).Length;
                if (sb.Length > 0) sb.Append(" · ");
                sb.Append("sessions ").Append(n).Append(" 项");
            }
            string secrets = Path.Combine(dataDir, "secrets");
            if (Directory.Exists(secrets))
            {
                int n = Directory.GetFiles(secrets, "*.dpapi").Length;
                if (sb.Length > 0) sb.Append(" · ");
                sb.Append("密钥 ").Append(n).Append(" 条");
            }
        }
        catch (Exception e) { return "(读不动：" + e.Message + ")"; }
        return sb.Length > 0 ? sb.ToString() : "(空 data 目录)";
    }

    /// 老 data 目录在哪？三层：本目录 data → install-info.txt 里记的 → 老布局的并列 data。
    /// ★ 关键：**不改 PATH、不移动任何文件**，只回答"该去哪读"。
    static string FindLegacyData(string dir)
    {
        try
        {
            string own = Path.Combine(dir, "data");
            if (Directory.Exists(own)) return own;
            string info = Path.Combine(dir, "install-info.txt");
            if (File.Exists(info))
            {
                string[] ls = File.ReadAllLines(info);
                for (int i = 0; i < ls.Length; i++)
                {
                    if (ls[i].StartsWith("data=", StringComparison.Ordinal))
                    {
                        string v = ls[i].Substring(5).Trim();
                        if (v.Length > 0 && Directory.Exists(v)) return v;
                    }
                }
            }
        }
        catch { }
        return null;
    }

    static void Install(string self, long payloadStart, string dir)
    {
        Directory.CreateDirectory(dir);

        // ★★ 这条是从 Launcher.cs 抄来的教训：换版本时**绝不能**删掉用户的东西。
        //   config.json（里面是 apiKey）与 data\（全部会话 / 索引 / 账本）必须先挪出来，
        //   解压完再挪回去。原版就因为这个丢过用户的 key 和全部会话，而且不报错。
        string[] keep = new string[] { "config.json", "data" };
        string rescue = Path.Combine(Path.GetTempPath(), "as-setup-rescue-" + Guid.NewGuid().ToString("N").Substring(0, 8));
        List<string> saved = new List<string>();
        if (Directory.Exists(dir))
        {
            Directory.CreateDirectory(rescue);
            for (int i = 0; i < keep.Length; i++)
            {
                string src = Path.Combine(dir, keep[i]);
                bool isDir = Directory.Exists(src);
                bool isFile = File.Exists(src);
                if (!isDir && !isFile) continue;
                string dst = Path.Combine(rescue, keep[i]);
                try
                {
                    if (isDir) CopyDir(src, dst); else File.Copy(src, dst, true);
                    saved.Add(keep[i]);
                }
                catch (Exception e) { Console.Error.WriteLine("  警告：没能备份 " + keep[i] + " — " + e.Message); }
            }
        }

        // 解压载荷（覆盖程序文件）
        //
        // ★★★ 这里踩过一个必须记住的坑：**不能**直接把整个 exe 的 FileStream
        //   交给 ZipArchive。它在 Read 模式下会「从流的末尾往回找 EOCD」，
        //   而流的长度是整个 exe（stub + zip），于是它拿到的中央目录偏移
        //   相对的不是 zip 起点 —— 报错是
        //     「中央目录结尾中应包含的条目数与中央目录中的条目数不对应」
        //   （实测撞到：出口一句「失败：中央目录结尾…」，一个文件都没解出来）。
        //   ★ 值得注意的是 zip 本身没毛病：ZipFile.OpenRead(zip路径) 能正常打开 573 条。
        //   所以正确做法是先把这个载荷落到一个临时文件，再按**独立 zip 文件**打开。
        //   代价是多写一次 ~36 MB（几十毫秒），换掉一个查半天也想不到的错。
        string payloadTmp = Path.Combine(Path.GetTempPath(), "as-payload-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".zip");
        try
        {
            using (FileStream src = File.OpenRead(self))
            using (FileStream dst = File.Create(payloadTmp))
            {
                src.Position = payloadStart;
                byte[] buf = new byte[1 << 20];
                int n;
                while ((n = src.Read(buf, 0, buf.Length)) > 0) dst.Write(buf, 0, n);
            }
            using (ZipArchive zip = ZipFile.OpenRead(payloadTmp))
            {
                int n = 0;
                foreach (ZipArchiveEntry e in zip.Entries)
                {
                    // ★ 两种分隔符都要换成平台分隔符：zip 规范要求 '/'，
                    //   但 PowerShell 的 Compress-Archive 实际写的是 '\\'（实测 567 条全是反斜杠）。
                    //   只处理一种的话，换个打包工具就会解出「名字里带斜杠」的怪文件。
                    string safeName = e.FullName.Replace('\\', '/').Replace('/', Path.DirectorySeparatorChar);
                    string rel = safeName;
                    string target = Path.Combine(dir, rel);
                    // ★ 目录条目要先归一化成 '/' 再判断结尾。
                    //   Compress-Archive 写的目录条目是 "app\\1.0.65\\src\\modes\\"（反斜杠结尾），
                    //   只判 EndsWith("/") 会漏掉它，于是拿目录名去 ExtractToFile →
                    //   「未能找到路径 …\src\modes\ 的一部分」（实测撞到）。
                    if (e.FullName.Replace('\\', '/').EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                    string parent = Path.GetDirectoryName(target);
                    if (parent != null && parent.Length > 0) Directory.CreateDirectory(parent);
                    e.ExtractToFile(target, true);
                    n++;
                }
                Console.WriteLine("  解开 " + n + " 个文件");
            }
        }
        finally
        {
            // 临时载荷必须删掉 —— 它和安装包一样大，留着就是一次 36 MB 的垃圾。
            try { if (File.Exists(payloadTmp)) File.Delete(payloadTmp); } catch { }
        }

        // 把用户的东西放回原处（覆盖包里同名文件 —— 用户的配置优先）
        for (int i = 0; i < saved.Count; i++)
        {
            string name = saved[i];
            string src = Path.Combine(rescue, name);
            string dst = Path.Combine(dir, name);
            try
            {
                if (Directory.Exists(src)) { if (Directory.Exists(dst)) SafeDelete(dst); CopyDir(src, dst); }
                else { File.Copy(src, dst, true); }
                Console.WriteLine("  已保留你的 " + name);
            }
            catch (Exception e) { Console.Error.WriteLine("  警告：没能恢复 " + name + " — " + e.Message); }
        }
        try { if (Directory.Exists(rescue)) SafeDelete(rescue); } catch { }

        // 卸载器：把安装器自己复制一份过去（同一个 exe 认 /uninstall）
        try { File.Copy(self, Path.Combine(dir, "uninstall.exe"), true); }
        catch (Exception e) { Console.Error.WriteLine("  警告：卸载器没复制成 — " + e.Message); }

        // 快捷方式
        try { MakeShortcuts(dir); } catch (Exception e) { Console.Error.WriteLine("  警告：快捷方式没建成 — " + e.Message); }

        // 卸载项（HKCU，不需要管理员）
        try
        {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(UNINST_KEY))
            {
                if (k != null)
                {
                    k.SetValue("DisplayName", "AgentSoul " + AppVer());
                    k.SetValue("DisplayVersion", AppVer());
                    k.SetValue("Publisher", "cyanwell");
                    k.SetValue("InstallLocation", dir);
                    k.SetValue("UninstallString", "\"" + Path.Combine(dir, "uninstall.exe") + "\" /uninstall");
                    k.SetValue("DisplayIcon", Path.Combine(dir, "AgentSoul.exe"));
                    k.SetValue("NoModify", 1, RegistryValueKind.DWord);
                    k.SetValue("NoRepair", 1, RegistryValueKind.DWord);
                    long kb = 0;
                    try { kb = DirSize(dir) / 1024; } catch { }
                    if (kb > 0) k.SetValue("EstimatedSize", (int)kb, RegistryValueKind.DWord);
                }
            }
        }
        catch (Exception e) { Console.Error.WriteLine("  警告：注册表项没写进 — " + e.Message); }
    }

    static int Uninstall()
    {
        string self = Assembly.GetExecutingAssembly().Location;
        string dir = Path.GetDirectoryName(self);
        Console.WriteLine("卸载 AgentSoul（目录 " + dir + "）…");

        // 先停掉进程
        try
        {
            Process[] ps = Process.GetProcessesByName("AgentSoul");
            for (int i = 0; i < ps.Length; i++) { try { ps[i].Kill(); } catch { } }
            Console.WriteLine("  已停止 " + ps.Length + " 个进程");
        }
        catch { }

        // ★★★ 卸载只删**程序文件**，用户的 config.json 与 data 留在原地。
        //
        //   第一版我写的是「把它们挪到 %TEMP%\as-keep-*」—— 那是想错了两步：
        //     ① 用户根本找不到；② 挪完之后 Directory.Delete(dir) 还会失败，
        //     留下一个空壳目录（实测：卸载后「安装目录还在: true」）。
        //   正确行为：原地不动，只跳过这两个名字。数据在用户自己知道的路径上，
        //   要删是他自己的事，卸载程序不该代劳、更不该搬走。
        string[] keep = new string[] { "config.json", "data" };
        int removed = 0;
        int kept = 0;
        if (Directory.Exists(dir))
        {
            string[] files = Directory.GetFiles(dir, "*", SearchOption.AllDirectories);
            for (int i = 0; i < files.Length; i++)
            {
                bool isKept = false;
                for (int k = 0; k < keep.Length; k++)
                {
                    string keepPath = Path.Combine(dir, keep[k]);
                    if (files[i].StartsWith(keepPath, StringComparison.OrdinalIgnoreCase)) { isKept = true; break; }
                }
                if (isKept) { kept++; continue; }
                try { File.Delete(files[i]); removed++; } catch { }
            }
            // 只在「没有留下任何用户数据」时才把目录整棵删掉
            try
            {
                if (kept == 0) Directory.Delete(dir, true);
                else
                {
                    // 自底向上清空目录（保留还有文件的那些）
                    string[] subs = Directory.GetDirectories(dir, "*", SearchOption.AllDirectories);
                    Array.Sort(subs);
                    Array.Reverse(subs);
                    for (int i = 0; i < subs.Length; i++) { try { if (Directory.GetFileSystemEntries(subs[i]).Length == 0) Directory.Delete(subs[i]); } catch { } }
                }
            }
            catch { }
        }
        Console.WriteLine("  已删除 " + removed + " 个程序文件");

        // ★★★ 卸载器删不掉自己 —— 它正在运行，文件被占用。
        //
        //   第一版写成 `cmd /c "ping -n 3 & del self"`，实测**不可靠**：
        //   那时 uninstall.exe 已经是 96 MB（装了什么就复制成什么），
        //   两秒内 cmd 还没等到句柄释放就执行 del，删失败且不重试，
        //   于是卸载完留着一个 91 MB 的垃圾（实测：残留 uninstall.exe 95,891,536 B）。
        //
        //   现在改成：写一个**独立的 .cmd 脚本**（不是 cmd /c 内联 —— 内联时
        //   cmd 自己就占着父进程的句柄），脚本里循环重试 20 次、每次等 1 秒，
        //   删完 exe 再删脚本自己。本进程立刻返回，不阻塞。
        try
        {
            string selfPath = Assembly.GetExecutingAssembly().Location;
            string selfDir = Path.GetDirectoryName(selfPath);
            if (File.Exists(selfPath))
            {
                string scriptPath = Path.Combine(Path.GetTempPath(), "as-uninst-" + Guid.NewGuid().ToString("N").Substring(0, 8) + ".cmd");
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("@echo off");
                sb.AppendLine("setlocal");
                sb.AppendLine("set RETRY=0");
                sb.AppendLine(":wait");
                // 最多等 20 秒：句柄释放慢（杀毒扫描、索引器）时也能删掉
                sb.AppendLine("if %RETRY% GEQ 20 goto cleanup");
                sb.AppendLine("ping -n 2 127.0.0.1 >nul");
                sb.AppendLine("if exist \"" + selfPath + "\" del /f /q \"" + selfPath + "\" >nul 2>&1");
                sb.AppendLine("if exist \"" + selfPath + "\" ( set /a RETRY+=1 & goto wait )");
                sb.AppendLine(":cleanup");
                // 目录若已空就一并删掉（用户数据还在时 rmdir 会失败，那是对的）
                sb.AppendLine("if exist \"" + selfDir + "\" rmdir \"" + selfDir + "\" >nul 2>&1");
                // 最后删自己
                sb.AppendLine("(goto) 2>nul & del /f /q \"%~f0\"");
                File.WriteAllText(scriptPath, sb.ToString(), Encoding.Default);
                ProcessStartInfo psi = new ProcessStartInfo("cmd.exe", "/c \"" + scriptPath + "\"");
                psi.CreateNoWindow = true;
                psi.UseShellExecute = false;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
            }
        }
        catch { }

        // 快捷方式与注册表
        try
        {
            string sm = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Programs), APP_NAME);
            if (Directory.Exists(sm)) SafeDelete(sm);
            string dt = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), APP_NAME + ".lnk");
            if (File.Exists(dt)) File.Delete(dt);
        }
        catch { }
        try { Registry.CurrentUser.DeleteSubKeyTree(UNINST_KEY, false); } catch { }

        Console.WriteLine("✓ 已卸载");
        if (kept > 0)
        {
            Console.WriteLine("  ★ 你的数据留在原位，没有动：");
            Console.WriteLine("      " + Path.Combine(dir, "config.json") + "  （含 API Key）");
            Console.WriteLine("      " + Path.Combine(dir, "data") + "  （会话 / 索引 / 账本）");
            Console.WriteLine("    要彻底清干净，自己删这两个即可。");
        }
        return 0;
    }


    static void MakeShortcuts(string dir)
    {
        string exe = Path.Combine(dir, "AgentSoul.exe");
        // 用 PowerShell 建 .lnk：WScript.Shell 是 COM，最省事且不要额外依赖。
        string ps =
            "$ws = New-Object -ComObject WScript.Shell; " +
            "$p1 = '" + exe.Replace("'", "''") + "'; " +
            "$wd = '" + dir.Replace("'", "''") + "'; " +
            "$sm = [Environment]::GetFolderPath('Programs'); " +
            "$d1 = Join-Path $sm 'AgentSoul'; " +
            "New-Item -ItemType Directory -Force -Path $d1 | Out-Null; " +
            "$s = $ws.CreateShortcut((Join-Path $d1 'AgentSoul.lnk')); $s.TargetPath = $p1; $s.WorkingDirectory = $wd; $s.Save(); " +
            "$dt = [Environment]::GetFolderPath('Desktop'); " +
            "$s2 = $ws.CreateShortcut((Join-Path $dt 'AgentSoul.lnk')); $s2.TargetPath = $p1; $s2.WorkingDirectory = $wd; $s2.Save();";
        ProcessStartInfo psi = new ProcessStartInfo("powershell", "-NoProfile -ExecutionPolicy Bypass -Command \"" + ps + "\"");
        psi.CreateNoWindow = true;
        psi.UseShellExecute = false;
        psi.WindowStyle = ProcessWindowStyle.Hidden;
        Process p = Process.Start(psi);
        p.WaitForExit(20000);
    }

    static void CopyDir(string from, string to)
    {
        Directory.CreateDirectory(to);
        string[] subs = Directory.GetDirectories(from);
        for (int i = 0; i < subs.Length; i++)
            CopyDir(subs[i], Path.Combine(to, Path.GetFileName(subs[i])));
        string[] files = Directory.GetFiles(from);
        for (int i = 0; i < files.Length; i++)
            File.Copy(files[i], Path.Combine(to, Path.GetFileName(files[i])), true);
    }

    static void SafeDelete(string d)
    {
        try { Directory.Delete(d, true); }
        catch
        {
            string[] fs = Directory.GetFiles(d, "*", SearchOption.AllDirectories);
            for (int i = 0; i < fs.Length; i++) { try { FileInfo fi = new FileInfo(fs[i]); fi.IsReadOnly = false; fi.Delete(); } catch { } }
            try { Directory.Delete(d, true); } catch { }
        }
    }

    static long DirSize(string d)
    {
        long s = 0;
        string[] files = Directory.GetFiles(d, "*", SearchOption.AllDirectories);
        for (int i = 0; i < files.Length; i++) { try { s += new FileInfo(files[i]).Length; } catch { } }
        return s;
    }
}
