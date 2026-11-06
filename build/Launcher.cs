// agent-soul 引导器 —— 一个 exe，双击就开
//
// ★ 为什么不走 Node SEA：
//   本机唯一的 node.exe（DSH 内置）资源表里没有 NODE_SEA_BLOB，
//   而 postject 要做的是**新增**一个 PE 资源条目 —— 那要重写整段 .rsrc、
//   修 3 个 data directory、重排偏移。能做，但脆，且本机没有 npm 装不了 postject。
//
// ★ 这条路用的是系统自带的东西：
//   csc.exe（.NET Framework 4.x 自带编译器）编译这个文件 → 一个真 exe。
//   应用（node.exe + src + web）作为**追加数据**贴在 exe 末尾，
//   带一个魔数标记。首次运行解压到 %LOCALAPPDATA%\agent-soul，之后直接用。
//   这和 7-Zip SFX 是同一个做法。

using System;
using System.IO;
using System.Collections.Generic;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

static class Program
{
    // 追加数据前的标记。改它等于换格式 —— 加载器和打包器必须一致。
    static readonly byte[] MAGIC = Encoding.ASCII.GetBytes("AGENTSOULPKG01");

    [STAThread]
    static int Main(string[] args)
    {
        try { return Run(args); }
        catch (Exception e)
        {
            Console.Error.WriteLine();
            Console.Error.WriteLine("启动失败：" + e.Message);
            Console.Error.WriteLine();
            Console.Error.WriteLine("按任意键关闭…");
            try { Console.ReadKey(true); } catch { }
            return 1;
        }
    }

    static int Run(string[] args)
    {
        string self = Assembly.GetExecutingAssembly().Location;
        bool dbg = Environment.GetEnvironmentVariable("AGENT_SOUL_DEBUG") == "1";
        if (dbg) Console.WriteLine("[dbg] self=" + self + "  exists=" + File.Exists(self) + "  len=" + (File.Exists(self) ? new FileInfo(self).Length.ToString() : "?"));
        long dataStart = FindPayloadStart(self);
        if (dbg) Console.WriteLine("[dbg] payload start=" + dataStart);

        string appDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "agent-soul");

        if (dataStart < 0)
        {
            // 没有载荷 —— 说明这是个「开发版」exe，直接当成入口，去找旁边的 src
            return RunDev(self, args);
        }

        string stampFile = Path.Combine(appDir, ".payload-version");
        string stamp = SelfVersion(self) + ":" + new FileInfo(self).Length;
        bool need = !File.Exists(stampFile) || File.ReadAllText(stampFile).Trim() != stamp;

        if (need)
        {
            Console.WriteLine("首次启动，正在展开…");
            Console.WriteLine("  → " + appDir);
            // ★★ 2026-11-07 修的一个会吃掉用户数据的 bug。
            //
            //   原来这里直接 SafeDelete(appDir) —— 而 appDir 里装着
            //   **config.json（用户填的 apiKey）** 和 **data\（全部会话+索引+账本）**。
            //   于是：换一个新版 exe，版本戳变了 → 整个目录删掉 → key 和会话一起没了。
            //   **而且它不报错** —— 用户只会觉得「怎么又要我填一遍」，跑到第三次就不用了。
            //
            //   修法：解压前把「用户的东西」挪出去，解压完挪回来。
            //   只挪两样，别多挪 —— 代码是包里的，本来就要用新的覆盖。
            string[] keepNames = new string[] { "config.json", "data" };
            string rescue = Path.Combine(Path.GetTempPath(), "as-rescue-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            List<string> saved = new List<string>();
            if (Directory.Exists(appDir))
            {
                Directory.CreateDirectory(rescue);
                foreach (string nm in keepNames)
                {
                    string src = Path.Combine(appDir, nm);
                    if (!Directory.Exists(src) && !File.Exists(src)) continue;
                    string dst = Path.Combine(rescue, nm);
                    try
                    {
                        if (Directory.Exists(src)) CopyDir(src, dst);
                        else File.Copy(src, dst, true);
                        saved.Add(nm);
                    }
                    catch { }
                }
            }

            if (Directory.Exists(appDir)) SafeDelete(appDir);
            Directory.CreateDirectory(appDir);
            try { ExtractPayload(self, dataStart, appDir); }
            catch (Exception ex) { throw new Exception("解压失败（载荷起点 " + dataStart + "）：" + ex.Message + "\n内部：" + ex.GetType().Name); }

            // 把用户的东西放回去（**后放**，覆盖包里那份默认 config.json）
            foreach (string nm in saved)
            {
                string src = Path.Combine(rescue, nm);
                string dst = Path.Combine(appDir, nm);
                try
                {
                    if (Directory.Exists(src)) { if (Directory.Exists(dst)) SafeDelete(dst); CopyDir(src, dst); }
                    else File.Copy(src, dst, true);
                    Console.WriteLine("  ✓ 保留了你原来的 " + nm);
                }
                catch (Exception ex) { Console.WriteLine("  ⚠ 没能恢复 " + nm + "：" + ex.Message); }
            }
            try { if (Directory.Exists(rescue)) SafeDelete(rescue); } catch { }

            File.WriteAllText(stampFile, stamp);
        }

        string node = Path.Combine(appDir, "runtime", "node.exe");
        string entry = Path.Combine(appDir, "src", "index.mjs");
        if (!File.Exists(node)) throw new Exception("包里没有 runtime\\node.exe");
        if (!File.Exists(entry)) throw new Exception("包里没有 src\\index.mjs");

        // 端口：优先环境变量，其次取一个空着的
        int port = PickPort();
        Console.WriteLine();
        Console.WriteLine("  agent-soul");
        Console.WriteLine("  ─────────────────────");
        Console.WriteLine("  界面   http://127.0.0.1:" + port);
        Console.WriteLine("  MCP    http://127.0.0.1:" + port + "/mcp");
        Console.WriteLine("  目录   " + appDir);
        Console.WriteLine();

        var psi = new ProcessStartInfo(node, "\"" + entry + "\"");
        psi.WorkingDirectory = appDir;
        psi.UseShellExecute = false;
        psi.EnvironmentVariables["AGENT_SOUL_PORT"] = port.ToString();
        psi.EnvironmentVariables["AGENT_SOUL_HOME"] = appDir;
        // ★ 把自己的 PID 传过去，让 node 自己看着 —— 见 src/util/parent-watchdog.mjs。
        //   Job Object 那条路试过，实测没效果；这条更笨但可测。
        psi.EnvironmentVariables["AGENT_SOUL_PARENT"] = Process.GetCurrentProcess().Id.ToString();

        // ★ 先建作业，再起进程。作业句柄一关，里面所有进程全死 ——
        //   这条不依赖启动器「优雅退出」，它依赖的是内核关句柄的行为，**强杀也生效**。
        IntPtr job = MakeKillOnCloseJob();
        Process p = Process.Start(psi);
        bool guarded = PutInJob(job, p);
        // ★ 装没装进去必须能看见 —— 不然「修了」和「没修」长得一模一样。
        if (!guarded) Console.Error.WriteLine("  [job] 装入作业对象失败 err=" + Marshal.GetLastWin32Error() + (job == IntPtr.Zero ? "（作业都没建起来）" : ""));

        // 等它起来再开浏览器（最多 30 秒）
        string url = "http://127.0.0.1:" + port + "/";
        for (int i = 0; i < 60; i++)
        {
            Thread.Sleep(500);
            if (p.HasExited) { Console.Error.WriteLine("服务退出了（退出码 " + p.ExitCode + "）"); return p.ExitCode; }
            if (PortAlive(port)) break;
        }
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }

        if (args.Length > 0 && args[0] == "--headless")
        {
            // ★ --headless 是给自动化测试用的：起完就退，不等。
            //   但它**必须**在退之前把 job 关掉 —— 否则这套机制在测试路径上等于没装，
            //   而测试路径恰恰是用来**证明这套机制有效**的那条路。
            if (job != IntPtr.Zero) CloseHandle(job);
            return 0;
        }

        Console.WriteLine("  正在运行。关闭这个窗口 = 停止服务。");
        try { p.WaitForExit(); } finally { if (job != IntPtr.Zero) CloseHandle(job); }
        return p.ExitCode;
    }


    // ── Job Object：让子进程跟着启动器一起死 ──────────────────────────────
    //
    // ★ 2026-11-07 修的一个真 bug。现象：
    //   关掉命令行窗口（或用 taskkill 杀 agent-soul.exe）之后，node 服务进程**还活着**，
    //   而且它把整个解压目录锁住 —— 再双击就报
    //   「解压失败：文件 runtime\node.exe 正由另一进程使用」，
    //   而那个文件用户根本没碰过。
    //
    // ★ 根因：Process.Start 起的是**子进程**。启动器退出 ≠ 子进程退出 ——
    //   Windows 上默认不连带。
    //
    // ★ 解法：把它装进一个 Job Object，并设 KILL_ON_JOB_CLOSE。
    //   内核在进程退出时会关掉它的所有句柄 —— **包括被强杀**。
    //   Job 的最后一个句柄一关，里面所有进程全死。
    //   所以这条不依赖启动器「优雅退出」，它依赖的是内核行为。
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int infoClass, IntPtr lpInfo, uint cbInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    // 建一个「句柄一关就杀光」的作业。返回 IntPtr.Zero 表示失败（不致命，只是退回旧行为）。
    static IntPtr MakeKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return IntPtr.Zero;
        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int len = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
        IntPtr p = Marshal.AllocHGlobal(len);
        try
        {
            Marshal.StructureToPtr(info, p, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, p, (uint)len))
            {
                CloseHandle(job);
                return IntPtr.Zero;
            }
        }
        finally { Marshal.FreeHGlobal(p); }
        return job;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);

    // ★ 把子进程放进作业。必须在它**还没退出**时调用 —— 否则拿不到句柄。
    //   返回 true 才算真的管住了；false 时退回旧行为（不假装成功）。
    static bool PutInJob(IntPtr job, Process p)
    {
        if (job == IntPtr.Zero) return false;
        try { return AssignProcessToJobObject(job, p.Handle); }
        catch { return false; }
    }

    static int RunDev(string self, string[] args)
    {
        string dir = Path.GetDirectoryName(self);
        while (dir != null && !File.Exists(Path.Combine(dir, "src", "index.mjs")))
            dir = Path.GetDirectoryName(dir);
        if (dir == null) throw new Exception("找不到 src\\index.mjs —— 这个 exe 旁边没有源码");
        string node = Path.Combine(dir, "runtime", "node.exe");
        if (!File.Exists(node)) node = "node";
        var psi = new ProcessStartInfo(node, "\"" + Path.Combine(dir, "src", "index.mjs") + "\"");
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        IntPtr job = MakeKillOnCloseJob();
        Process p = Process.Start(psi);
        PutInJob(job, p);
        try { p.WaitForExit(); } finally { if (job != IntPtr.Zero) CloseHandle(job); }
        return p.ExitCode;
    }

    static string SelfVersion(string self)
    {
        try { return File.GetLastWriteTimeUtc(self).Ticks.ToString(); } catch { return "0"; }
    }

    // 扫魔数；找到就返回载荷起点。
    //
    // ★ 2026-11-07 这里踩过一次：原来从**文件尾**往回扫 1MB —— 但载荷结构是
    //     [exe][MAGIC][size][zip]，魔数紧跟在 exe 主体之后、离文件头只有几十 KB，
    //     而 zip 有 34MB。从末尾扫永远扫不到，于是每次都判「没有载荷」，
    //     然后走开发分支去找旁边的 src —— 报「系统找不到指定的文件」。
    //   改成分块从头扫全文件。
    static long FindPayloadStart(string file)
    {
        const int CHUNK = 1 << 20;
        using (var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            if (fs.Length < MAGIC.Length + 8) return -1;
            byte[] buf = new byte[CHUNK + MAGIC.Length];
            int carry = 0;
            long pos = 0;
            while (pos < fs.Length)
            {
                int n = fs.Read(buf, carry, CHUNK);
                if (n <= 0) break;
                int avail = carry + n;
                int last = Math.Min(avail, CHUNK);
                for (int i = 0; i + MAGIC.Length <= avail; i++)
                {
                    if (i > last) break;
                    bool ok = true;
                    for (int j = 0; j < MAGIC.Length; j++)
                        if (buf[i + j] != MAGIC[j]) { ok = false; break; }
                    if (!ok) continue;
                    long mantissa = pos - carry + i + MAGIC.Length + 8;
                    if (mantissa >= 0 && mantissa <= fs.Length) return mantissa;
                }
                // 把尾部 carry 个字节挪到前面，处理跨块匹配
                carry = Math.Min(MAGIC.Length - 1, avail);
                for (int k = 0; k < carry; k++) buf[k] = buf[avail - carry + k];
                pos += n;
            }
        }
        return -1;
    }

    // ★ 2026-11-07 踩过的坑，写在这里免得再犯：
    //   ZipArchive 里中央目录记的偏移是**相对流的起点（位置 0）**的。
    //   直接在原 FileStream 上 Seek 到载荷起点再 new ZipArchive(fs) —— 它会拿
    //   「offset=N」去流的第 N 字节找 local header，而那里是 exe 的 PE 头，
    //   于是抛 InvalidDataException「归档中的条目结尾不应出现其他条目」。
    //   正确做法：把载荷**整段读进内存流**，让 zip 从位置 0 开始。
    static void ExtractPayload(string self, long start, string dest)
    {
        byte[] bytes;
        using (var fs = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            long len = fs.Length - start;
            if (len <= 0 || len > int.MaxValue) throw new Exception("载荷长度异常: " + len);
            bytes = new byte[len];
            fs.Seek(start, SeekOrigin.Begin);
            int read = 0;
            while (read < bytes.Length)
            {
                int n = fs.Read(bytes, read, bytes.Length - read);
                if (n <= 0) break;
                read += n;
            }
        }
        using (var ms = new MemoryStream(bytes))
        using (var z = new ZipArchive(ms, ZipArchiveMode.Read))
        {
                foreach (var e in z.Entries)
                {
                    string target = Path.Combine(dest, e.FullName.Replace('/', Path.DirectorySeparatorChar));
                    if (e.FullName.EndsWith("/")) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (var src = e.Open())
                    using (var dst = File.Create(target)) src.CopyTo(dst);
                }
        }
    }

    static void CopyDir(string src, string dst)

    {

        Directory.CreateDirectory(dst);

        foreach (string f in Directory.GetFiles(src)) File.Copy(f, Path.Combine(dst, Path.GetFileName(f)), true);

        foreach (string d in Directory.GetDirectories(src)) CopyDir(d, Path.Combine(dst, Path.GetFileName(d)));

    }


    static void SafeDelete(string dir)
    {
        try { Directory.Delete(dir, true); }
        catch { Thread.Sleep(300); try { Directory.Delete(dir, true); } catch { } }
    }

    static int PickPort()
    {
        string env = Environment.GetEnvironmentVariable("AGENT_SOUL_PORT");
        int e;
        if (!string.IsNullOrEmpty(env) && int.TryParse(env, out e)) return e;
        for (int p = 7310; p < 7400; p++) if (!PortAlive(p)) return p;
        return 7310;
    }

    static bool PortAlive(int port)
    {
        try
        {
            using (var c = new System.Net.Sockets.TcpClient())
            {
                var ar = c.BeginConnect("127.0.0.1", port, null, null);
                if (!ar.AsyncWaitHandle.WaitOne(120)) return false;
                c.EndConnect(ar);
                return true;
            }
        }
        catch { return false; }
    }
}
