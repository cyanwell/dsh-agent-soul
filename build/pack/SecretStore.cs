// AgentSoul SecretStore —— 用 Windows DPAPI（CurrentUser）收一把 API Key
//
// ★ 为什么要有这个独立小 exe，而不是把 DPAPI 写进安装器/主程序：
//   ① 安装器只跑一次，而 key 在运行期每次启动都要解一遍 —— 两边必须用**同一个**实现，
//      否则「装进去时能解、运行时解不出来」这种错会出现在用户机上而不是我的机器上。
//   ② 它是一个只有五个动作的小程序，容易被单独验证（set/get/has/delete/wipe 各有退出码）。
//   ③ helper 的路径由**安装根**推（<安装根>/runtime/SecretStore.exe），不写任何开发机路径。
//
// ★ 秘密只走 stdin：命令行参数会被别的进程看见（进程列表 / 审计日志），
//   所以 set 从标准输入读、get 往标准输出写，argv 里从头到尾没有 key。
//
// ★ 文件位置：<安装根>/data/secrets/<providerId>.dpapi —— data 是「用户数据」，
//   升级不覆盖；卸载默认保留；只有 /Purge 才删（判据在安装器里，这里提供 wipe）。
//
// 用法（C# 5 / csc /langversion:5）：
//   SecretStore.exe set    --provider deepseek-official [--root <安装根>]   < key.txt
//   SecretStore.exe get    --provider deepseek-official [--root <安装根>]
//   SecretStore.exe has    --provider deepseek-official [--root <安装根>]
//   SecretStore.exe delete --provider deepseek-official [--root <安装根>]
//   SecretStore.exe wipe   [--root <安装根>]
//
// 退出码：0 成功 / 2 用法错误 / 3 没有这条秘密 / 4 加解密失败

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class SecretStore
{
    const int EXIT_OK = 0;
    const int EXIT_USAGE = 2;
    const int EXIT_NOTFOUND = 3;
    const int EXIT_CRYPTO = 4;

    // DPAPI 的附加熵：把密文和「哪个 provider」绑在一起 ——
    // 同一个用户把 A 的密文文件改名成 B 也解不开，那是故意的。
    const string ENTROPY_PREFIX = "AgentSoul/SecretStore/v1/";

    const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    [StructLayout(LayoutKind.Sequential)]
    struct DATA_BLOB { public int cbData; public IntPtr pbData; }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptProtectData(ref DATA_BLOB pDataIn, string szDataDescr, ref DATA_BLOB pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr ppszDataDescr, ref DATA_BLOB pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr hMem);

    static int Main(string[] args)
    {
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }

        Dictionary<string, string> op;
        try { op = ParseArgs(args); }
        catch (Exception ex) { return Fail(EXIT_USAGE, ex.Message); }

        if (op.Count == 0 || op.ContainsKey("help") || op.ContainsKey("?"))
        {
            Console.Error.WriteLine(Usage());
            return op.Count == 0 ? EXIT_USAGE : EXIT_OK;
        }

        string root = ResolveRoot(op);
        string provider = op.ContainsKey("provider") ? SanitizeProvider(op["provider"]) : null;

        try
        {
            // ★ 命令是**第一个裸参数**（set/get/has/delete/wipe），不是 --flag。
            //   第一版把它写成了 op.ContainsKey("set")，于是每条命令都落到「不认识」分支 ——
            //   退出码 2 把这个错说得很清楚，别在这里做「猜一个」的兜底。
            string cmd = op.ContainsKey("cmd") ? op["cmd"] : "";
            if (cmd == "wipe") return Wipe(root);
            if (provider == null) return Fail(EXIT_USAGE, "--provider 是必填的（例：--provider deepseek-official）");

            string file = SecretPath(root, provider);
            if (cmd == "set") return Set(file, provider);
            if (cmd == "get") return Get(file, provider);
            if (cmd == "has") return HasSecret(file);
            if (cmd == "delete") return Delete(file);
            return Fail(EXIT_USAGE, "不认识的命令。可用：set / get / has / delete / wipe");
        }
        catch (Exception ex)
        {
            return Fail(EXIT_CRYPTO, ex.GetType().Name + ": " + ex.Message);
        }
    }

    // ── 命令 ────────────────────────────────────────────────────────────────
    static Dictionary<string, string> ParseArgs(string[] args)
    {
        Dictionary<string, string> d = new Dictionary<string, string>();
        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            if (string.IsNullOrEmpty(a)) continue;
            if (a[0] == '-' || a[0] == '/')
            {
                string k = a.TrimStart('-', '/').ToLowerInvariant();
                if (k.Length == 0) continue;
                int eq = k.IndexOf('=');
                if (eq >= 0) { d[k.Substring(0, eq)] = k.Substring(eq + 1); continue; }
                if (k == "provider" || k == "root")
                {
                    if (i + 1 < args.Length && !(args[i + 1].Length > 0 && (args[i + 1][0] == '-' || args[i + 1][0] == '/')))
                    { d[k] = args[++i]; continue; }
                }
                d[k] = "1";
            }
            else
            {
                d["cmd"] = a.ToLowerInvariant();
            }
        }
        return d;
    }

    static string Usage()
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("AgentSoul SecretStore —— DPAPI (CurrentUser) 秘密存取");
        sb.AppendLine("  set     --provider <id> [--root <dir>]   从 stdin 读秘密并加密保存");
        sb.AppendLine("  get     --provider <id> [--root <dir>]   解密后写到 stdout（无换行）");
        sb.AppendLine("  has     --provider <id> [--root <dir>]   有=yes 没有=no");
        sb.AppendLine("  delete  --provider <id> [--root <dir>]   删除这一条");
        sb.AppendLine("  wipe    [--root <dir>]                   删除本安装根下的全部秘密");
        return sb.ToString();
    }

    /** 安装根：--root > AGENT_SOUL_HOME > exe 所在目录的上一级（runtime 的父）。 */
    static string ResolveRoot(Dictionary<string, string> op)
    {
        if (op.ContainsKey("root") && op["root"].Trim().Length > 0) return Path.GetFullPath(op["root"].Trim());
        string env = Environment.GetEnvironmentVariable("AGENT_SOUL_HOME");
        if (!string.IsNullOrEmpty(env)) return Path.GetFullPath(env);
        string exe = System.Reflection.Assembly.GetExecutingAssembly().Location;
        string dir = Path.GetDirectoryName(exe);
        // exe 在 <安装根>/runtime 下 → 上一级就是安装根；否则用 exe 自己那一级
        if (string.Equals(Path.GetFileName(dir), "runtime", StringComparison.OrdinalIgnoreCase))
            return Path.GetDirectoryName(dir);
        return dir;
    }

    static string SanitizeProvider(string s)
    {
        string t = (s ?? "").Trim();
        if (t.Length == 0) throw new Exception("provider 为空");
        if (t.Length > 64) throw new Exception("provider 太长（最多 64 字符）");
        foreach (char c in t)
        {
            bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.';
            if (!ok) throw new Exception("provider 只能含字母、数字、- _ .（收到：" + t + "）");
        }
        return t;
    }

    static string SecretsDir(string root) { return Path.Combine(Path.Combine(root, "data"), "secrets"); }
    static string SecretPath(string root, string provider) { return Path.Combine(SecretsDir(root), provider + ".dpapi"); }

    static int Set(string file, string provider)
    {
        string secret = ReadAllStdin().Replace(((char)13).ToString(), "").TrimEnd((char)10);
        if (secret.Length == 0) return Fail(EXIT_USAGE, "stdin 是空的 —— 没有秘密可存");
        if (secret.Length > 4096) return Fail(EXIT_USAGE, "秘密太长（>4096 字符），这不像一把 API Key");
        if (secret.IndexOf((char)10) >= 0) return Fail(EXIT_USAGE, "秘密里不能有换行");
        byte[] blob = Protect(Encoding.UTF8.GetBytes(secret), Entropy(provider));
        Directory.CreateDirectory(Path.GetDirectoryName(file));
        File.WriteAllBytes(file, blob);
        // ★ 只回事实，不回秘密本身
        Console.WriteLine("stored provider=" + provider + " bytes=" + blob.Length);
        return EXIT_OK;
    }

    static int Get(string file, string provider)
    {
        if (!File.Exists(file)) return Fail(EXIT_NOTFOUND, "没有这条秘密：" + provider);
        byte[] plain = Unprotect(File.ReadAllBytes(file), Entropy(provider));
        // ★ 原样写字节，不加换行 —— 调用方拿到什么就是什么
        using (Stream o = Console.OpenStandardOutput())
        {
            o.Write(plain, 0, plain.Length);
            o.Flush();
        }
        return EXIT_OK;
    }

    static int HasSecret(string file)
    {
        Console.WriteLine(File.Exists(file) ? "yes" : "no");
        return EXIT_OK;
    }

    static int Delete(string file)
    {
        if (!File.Exists(file)) { Console.WriteLine("none"); return EXIT_OK; }
        File.Delete(file);
        Console.WriteLine("deleted");
        return EXIT_OK;
    }

    static int Wipe(string root)
    {
        string dir = SecretsDir(root);
        if (!Directory.Exists(dir)) { Console.WriteLine("wiped 0"); return EXIT_OK; }
        int n = 0;
        foreach (string f in Directory.GetFiles(dir, "*.dpapi")) { try { File.Delete(f); n++; } catch { } }
        try { if (Directory.GetFileSystemEntries(dir).Length == 0) Directory.Delete(dir); } catch { }
        Console.WriteLine("wiped " + n);
        return EXIT_OK;
    }

    // ── DPAPI ───────────────────────────────────────────────────────────────
    static byte[] Entropy(string provider) { return Encoding.UTF8.GetBytes(ENTROPY_PREFIX + provider); }

    static byte[] Protect(byte[] data, byte[] entropy)
    {
        DATA_BLOB inBlob = new DATA_BLOB();
        DATA_BLOB entBlob = new DATA_BLOB();
        DATA_BLOB outBlob = new DATA_BLOB();
        IntPtr pIn = IntPtr.Zero, pEnt = IntPtr.Zero;
        try
        {
            pIn = Marshal.AllocHGlobal(data.Length);
            Marshal.Copy(data, 0, pIn, data.Length);
            inBlob.cbData = data.Length; inBlob.pbData = pIn;

            pEnt = Marshal.AllocHGlobal(entropy.Length);
            Marshal.Copy(entropy, 0, pEnt, entropy.Length);
            entBlob.cbData = entropy.Length; entBlob.pbData = pEnt;

            if (!CryptProtectData(ref inBlob, "AgentSoul API Key", ref entBlob, IntPtr.Zero, IntPtr.Zero,
                    CRYPTPROTECT_UI_FORBIDDEN, ref outBlob))
                throw new Exception("CryptProtectData 失败，Win32=" + Marshal.GetLastWin32Error());

            byte[] outBytes = new byte[outBlob.cbData];
            Marshal.Copy(outBlob.pbData, outBytes, 0, outBlob.cbData);
            return outBytes;
        }
        finally
        {
            if (pIn != IntPtr.Zero) Marshal.FreeHGlobal(pIn);
            if (pEnt != IntPtr.Zero) Marshal.FreeHGlobal(pEnt);
            if (outBlob.pbData != IntPtr.Zero) LocalFree(outBlob.pbData);
        }
    }

    static byte[] Unprotect(byte[] blob, byte[] entropy)
    {
        DATA_BLOB inBlob = new DATA_BLOB();
        DATA_BLOB entBlob = new DATA_BLOB();
        DATA_BLOB outBlob = new DATA_BLOB();
        IntPtr pIn = IntPtr.Zero, pEnt = IntPtr.Zero;
        try
        {
            pIn = Marshal.AllocHGlobal(blob.Length);
            Marshal.Copy(blob, 0, pIn, blob.Length);
            inBlob.cbData = blob.Length; inBlob.pbData = pIn;

            pEnt = Marshal.AllocHGlobal(entropy.Length);
            Marshal.Copy(entropy, 0, pEnt, entropy.Length);
            entBlob.cbData = entropy.Length; entBlob.pbData = pEnt;

            if (!CryptUnprotectData(ref inBlob, IntPtr.Zero, ref entBlob, IntPtr.Zero, IntPtr.Zero,
                    CRYPTPROTECT_UI_FORBIDDEN, ref outBlob))
                throw new Exception("CryptUnprotectData 失败，Win32=" + Marshal.GetLastWin32Error());

            byte[] outBytes = new byte[outBlob.cbData];
            Marshal.Copy(outBlob.pbData, outBytes, 0, outBlob.cbData);
            return outBytes;
        }
        finally
        {
            if (pIn != IntPtr.Zero) Marshal.FreeHGlobal(pIn);
            if (pEnt != IntPtr.Zero) Marshal.FreeHGlobal(pEnt);
            if (outBlob.pbData != IntPtr.Zero) LocalFree(outBlob.pbData);
        }
    }

    // ── 杂项 ────────────────────────────────────────────────────────────────
    static string ReadAllStdin()
    {
        using (Stream s = Console.OpenStandardInput())
        using (StreamReader r = new StreamReader(s, new UTF8Encoding(false)))
        {
            return r.ReadToEnd();
        }
    }

    static int Fail(int code, string msg)
    {
        try { Console.Error.WriteLine("[SecretStore] " + msg); } catch { }
        return code;
    }
}
