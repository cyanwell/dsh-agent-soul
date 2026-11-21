// AgentSoul 安装向导（1.0.2）—— WinForms 三页 + DPAPI 秘密 + 双协议
//
// ★ 为什么从控制台换成 WinForms（这一版的第一个硬要求）：
//   1.0.1 的安装器是控制台程序，用户看到的是一个黑窗口在刷日志 —— 而这一版必须收一把 API Key，
//   让用户在黑窗口里用 /ApiKey=xxx 输密码是**错的**：命令行参数会被进程列表、审计日志、脚本历史读走。
//   所以做成向导：三页（安装位置 / API 配置 / 安装完成），key 只在密码框里，进程内传给 SecretStore 的 stdin。
//
// ★ 三条不可协商的边界：
//   ① **秘密不进命令行**：SecretStore 的 key 走 stdin；本程序自己的 argv 永远没有 --key 这种参数。
//   ② **秘密不进 config.json**：只写 llm.apiKeyRef = dpapi:<providerId>。
//   ③ **秘密不进日志 / install-info.txt / 安装包**：日志里只出现「已保存」「provider 名字」「字节数」。
//
// ★ 静默模式（/S）保留给验收与自动化：不弹 UI、不碰秘密（没有 stdin 可靠通道就不收 key），
//   只做「解包 + 配置 + 快捷方式」，并把每一步写进 <安装根>/install-log.txt。
//
// ★ 语言级别 C# 5（csc /langversion:5）：不用插值字符串、?. 、out var、表达式体成员。
//   另外：**本文件里不出现反斜杠转义**（路径一律 Path.Combine），JSON 的引号与反斜杠用 (char)34 / (char)92 拼 ——
//   上一次改写就是被「模板里转义被吃掉一层」坑过一次，源码里少一个转义就少一个坑。

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Program
{
    const string RES = "payload.zip";
    const string PRODUCT = "AgentSoul";
    const int EXIT_OK = 0;
    const int EXIT_ARG = 2;
    const int EXIT_FAIL = 3;

    [DllImport("kernel32.dll")]
    static extern bool AttachConsole(int dwProcessId);

    [STAThread]
    static int Main(string[] args)
    {
        TryAttachConsole();
        try { Console.OutputEncoding = new UTF8Encoding(false); } catch { }

        Dictionary<string, string> op;
        try { op = ParseArgs(args); }
        catch (Exception ex) { Console.WriteLine("[arg] " + ex.Message); return EXIT_ARG; }

        if (op.ContainsKey("?") || op.ContainsKey("help")) { Console.WriteLine(Usage()); return EXIT_OK; }

        string target;
        try { target = op.ContainsKey("d") ? op["d"] : DefaultTarget(); }
        catch (Exception ex) { Console.WriteLine("[arg] " + ex.Message); return EXIT_ARG; }
        target = Path.GetFullPath(target);

        if (op.ContainsKey("uninstall")) return Uninstall(target, op);
        if (op.ContainsKey("rollback")) return Rollback(target, op);
        if (op.ContainsKey("s") || op.ContainsKey("silent")) return SilentInstall(target, op);

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        int code = EXIT_OK;
        using (Wizard w = new Wizard(op, target))
        {
            Application.Run(w);
            code = w.ExitCode;
        }
        return code;
    }

    // ── 参数 ────────────────────────────────────────────────────────────────
    static Dictionary<string, string> ParseArgs(string[] args)
    {
        Dictionary<string, string> d = new Dictionary<string, string>();
        foreach (string a in args)
        {
            if (string.IsNullOrEmpty(a)) continue;
            string s = a;
            while (s.Length > 0 && (s[0] == '/' || s[0] == '-')) s = s.Substring(1);
            if (s.Length == 0) continue;
            int eq = s.IndexOf('=');
            if (eq < 0) { d[s.ToLowerInvariant()] = "1"; continue; }
            string k = s.Substring(0, eq).ToLowerInvariant();
            string v = s.Substring(eq + 1).Trim().Trim('"');
            if (k == "d" || k == "dir" || k == "target")
            {
                if (v.Length == 0) throw new Exception("/D= 后面要跟目录");
                d["d"] = v;
            }
            else d[k] = v;
        }
        return d;
    }

    static string Usage()
    {
        StringBuilder sb = new StringBuilder();
        sb.AppendLine("AgentSoul Setup " + "(安装向导)");
        sb.AppendLine("  (no args)                     打开安装向导（推荐）");
        sb.AppendLine("  /D=<dir>                      安装根目录（默认 " + DefaultTarget() + "）");
        sb.AppendLine("  /StartMenuRoot=<dir>          开始菜单写到哪（验收用临时目录）");
        sb.AppendLine("  /NoShortcut                   不建快捷方式");
        sb.AppendLine("  /S                            静默安装（不弹界面；★ 不接受命令行传 key）");
        sb.AppendLine("  /Protocol=openai|anthropic    静默安装时写进配置的协议");
        sb.AppendLine("  /BaseUrl=<url>                静默安装时写进配置的地址（留空 = 官方默认）");
        sb.AppendLine("  /Model=<name>                 静默安装时写进配置的模型");
        sb.AppendLine("  /Provider=<id>                静默安装时写进配置的 provider id");
        sb.AppendLine("  /Uninstall [/Purge]           移除程序文件（data 与 config.json 默认保留；/Purge 连秘密一起删）");
        sb.AppendLine("  /Rollback=<version>           把 app/current.txt 指回已装版本");
        return sb.ToString();
    }

    static string DefaultTarget()
    {
        string lad = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(lad)) throw new Exception("拿不到 LOCALAPPDATA，请用 /D= 指定安装目录");
        return Path.Combine(Path.Combine(lad, "Programs"), PRODUCT);
    }

    static string DefaultStartMenu() { return Environment.GetFolderPath(Environment.SpecialFolder.Programs); }

    static void TryAttachConsole()
    {
        try
        {
            if (!AttachConsole(-1)) return;
            StreamWriter o = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
            o.AutoFlush = true;
            Console.SetOut(o);
            StreamWriter e = new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false));
            e.AutoFlush = true;
            Console.SetError(e);
        }
        catch { }
    }

    // ── 静默安装 / 卸载 / 回滚 ───────────────────────────────────────────────
    static int SilentInstall(string target, Dictionary<string, string> op)
    {
        InstallOptions o = new InstallOptions();
        o.Target = target;
        o.NoShortcut = op.ContainsKey("noshortcut");
        o.StartMenuRoot = op.ContainsKey("startmenuroot") ? Path.GetFullPath(op["startmenuroot"]) : DefaultStartMenu();
        o.ProviderId = op.ContainsKey("provider") ? op["provider"] : "deepseek-official";
        o.ProviderName = op.ContainsKey("providername") ? op["providername"] : "DeepSeek官方";
        o.Protocol = op.ContainsKey("protocol") ? op["protocol"] : "openai";
        o.BaseUrl = op.ContainsKey("baseurl") ? op["baseurl"] : "";
        o.Model = op.ContainsKey("model") ? op["model"] : "deepseek-chat";
        // ★ 2026-11-13：静默模式也要能选新/老用户 —— 否则自动化装出来的永远是「新用户」，
        //   老用户想批量部署就只能装完再手动改 config。参数名跟向导里的语义对齐。
        //     /UserMode=new|existing      默认 new
        //     /SoulRoot=<含 02-墨.jsonl 的那层>   只对 existing 有意义
        o.UserMode = op.ContainsKey("usermode") ? op["usermode"].Trim().ToLower() : "new";
        o.ExistingSoulRoot = op.ContainsKey("soulroot") ? op["soulroot"].Trim() : "";
        // ★ 静默模式**没有** key 这个参数 —— 故意的。要走秘密，用安装向导，或者直接跑
        //   <安装根>/runtime/SecretStore.exe set（key 从 stdin 进）。
        o.ConfigureLlm = op.ContainsKey("protocol") || op.ContainsKey("baseurl") || op.ContainsKey("model") || op.ContainsKey("provider");
        try
        {
            InstallCore(o);
            return EXIT_OK;
        }
        catch (Exception ex)
        {
            Console.WriteLine("[fail] " + ex.GetType().Name + ": " + ex.Message);
            return EXIT_FAIL;
        }
    }

    static int Rollback(string target, Dictionary<string, string> op)
    {
        string v = op["rollback"];
        string want = Path.Combine(Path.Combine(Path.Combine(target, "app"), v), Path.Combine("src", "index.mjs"));
        if (!File.Exists(want))
        {
            Console.WriteLine("[fail] 版本目录不存在：" + want);
            Console.WriteLine("       已装版本：" + Join(ListVersions(target)));
            return EXIT_FAIL;
        }
        File.WriteAllText(Path.Combine(Path.Combine(target, "app"), "current.txt"), v + Environment.NewLine, new UTF8Encoding(false));
        Console.WriteLine("current -> " + v);
        return EXIT_OK;
    }

    static int Uninstall(string target, Dictionary<string, string> op)
    {
        bool purge = op.ContainsKey("purge");
        string smRoot = op.ContainsKey("startmenuroot") ? Path.GetFullPath(op["startmenuroot"]) : DefaultStartMenu();
        string lnk = Path.Combine(Path.Combine(smRoot, PRODUCT), PRODUCT + ".lnk");
        try
        {
            if (File.Exists(lnk)) { File.Delete(lnk); Console.WriteLine("removed shortcut = " + lnk); }
            string folder = Path.GetDirectoryName(lnk);
            if (Directory.Exists(folder) && Directory.GetFileSystemEntries(folder).Length == 0) Directory.Delete(folder);
        }
        catch (Exception ex) { Console.WriteLine("[warn] shortcut: " + ex.Message); }

        if (!Directory.Exists(target)) { Console.WriteLine("nothing to remove at " + target); return EXIT_OK; }

        // ★ 秘密的判据只有一条：**只有 /Purge 才删**。普通卸载把 data/secrets 留着，
        //   因为「卸载程序」不等于「交出我的 API Key」。
        if (purge)
        {
            try
            {
                string ss = Path.Combine(Path.Combine(target, "runtime"), "SecretStore.exe");
                if (File.Exists(ss))
                {
                    Console.WriteLine("secret-wipe = " + RunSecretStoreCapture(ss, "wipe --root " + Quote(target)));
                }
                else
                {
                    string dir = Path.Combine(Path.Combine(target, "data"), "secrets");
                    if (Directory.Exists(dir))
                    {
                        int n = 0;
                        foreach (string f in Directory.GetFiles(dir, "*.dpapi")) { try { File.Delete(f); n++; } catch { } }
                        Console.WriteLine("secret-wipe = wiped " + n + " (fallback: 直接删文件)");
                    }
                }
            }
            catch (Exception ex) { Console.WriteLine("[warn] secret wipe: " + ex.Message); }
        }
        else
        {
            string dir = Path.Combine(Path.Combine(target, "data"), "secrets");
            if (Directory.Exists(dir)) Console.WriteLine("secret-kept = " + dir + "（普通卸载保留；要删加 /Purge）");
        }

        int removed = 0, kept = 0;
        PurgeDir(target, target, purge, ref removed, ref kept);
        Console.WriteLine("files-removed = " + removed);
        Console.WriteLine("user-files-kept = " + kept + (purge ? " (/Purge: data 仍保留，秘密已删)" : " (data 与 config.json 保留；要一并删加 /Purge)"));
        return EXIT_OK;
    }

    static void PurgeDir(string root, string dir, bool purge, ref int removed, ref int kept)
    {
        char sep = Path.DirectorySeparatorChar;
        foreach (string f in Directory.GetFiles(dir))
        {
            string rel = f.Substring(root.Length).TrimStart(sep);
            if (!purge && (rel == "config.json" || rel.StartsWith("data" + sep, StringComparison.OrdinalIgnoreCase) || rel == "install-info.txt" || rel == "install-log.txt"))
            { kept++; continue; }
            if (purge && rel.StartsWith("data" + sep, StringComparison.OrdinalIgnoreCase)) { kept++; continue; }
            try { File.Delete(f); removed++; } catch { kept++; }
        }
        foreach (string d in Directory.GetDirectories(dir))
        {
            PurgeDir(root, d, purge, ref removed, ref kept);
            try { if (Directory.GetFileSystemEntries(d).Length == 0) Directory.Delete(d); } catch { }
        }
    }

    // ── 工作区：新用户建骨架 / 老用户找已有的 ─────────────────────────────────
    //
    // ★ 2026-11-13（爀曦指出）：「新用户从零装配会有一个问题 —— 他们没有什么墨账本，
    //   连宪章都没有，空白的，这些是 agent soul v4 要读的，他们都没有。」
    //
    //   所以装的时候就分两条路：
    //     新用户 → 在 <安装目录>\workspace\ 建一份**空但合法**的骨架，v4 直接能读；
    //     老用户 → 去几个常见位置找已有的《墨》，找到就写进 config，找不到就明说。
    //
    //   ★ 空骨架为什么必须「合法」：02-墨.jsonl 是只追加账本，**空文件就是合法状态**
    //     （还没记任何事）。但如果这文件不存在，v4 的 leadFromLedger 会报「账本读不到」
    //     → 自主永远 fail-closed。差别只在「在不在」，不在「写了什么」。
    static string MakeWorkspaceSkeleton(string target)
    {
        string ws = Path.Combine(target, "workspace");
        Directory.CreateDirectory(ws);
        string[] dirs = { "10-宪章", "20-档案", "30-状态", "50-日记" };
        for (int i = 0; i < dirs.Length; i++) Directory.CreateDirectory(Path.Combine(ws, dirs[i]));

        string ledger = Path.Combine(ws, "02-墨.jsonl");
        if (!File.Exists(ledger))
        {
            // 只追加账本：空文件 = 「还没记任何事」，不是坏文件。
            File.WriteAllText(ledger, "", new UTF8Encoding(false));
            Console.WriteLine("workspace-init = 02-墨.jsonl（空账本）");
        }

        string charter = Path.Combine(Path.Combine(ws, "10-宪章"), "README.md");
        if (!File.Exists(charter))
        {
            StringBuilder cb = new StringBuilder();
            cb.AppendLine("# 宪章");
            cb.AppendLine();
            cb.AppendLine("这个目录放**你自己的规则** —— 什么该做、什么不该做、什么必须先问你。");
            cb.AppendLine("agent-soul 启动时会读它，把里面的约束带进每一轮判断。");
            cb.AppendLine();
            cb.AppendLine("留空也能跑 —— 但空着的宪章等于没有边界，建议至少写三条：");
            cb.AppendLine();
            cb.AppendLine("```");
            cb.AppendLine("1. 不要替我做决定，除非我明确说了「你定」");
            cb.AppendLine("2. 涉及钱、对外承诺、删数据 —— 一律先问我");
            cb.AppendLine("3. 不确定的事就说不知道，不要编");
            cb.AppendLine("```");
            cb.AppendLine();
            cb.AppendLine("★ 写在这里的东西，你自己下次打开还看得到；写进对话里的会被上下文冲掉。");
            File.WriteAllText(charter, cb.ToString(), new UTF8Encoding(false));
            Console.WriteLine("workspace-init = 10-宪章/README.md");
        }

        string persona = Path.Combine(Path.Combine(ws, "20-档案"), "人格.md");
        if (!File.Exists(persona))
        {
            StringBuilder pb = new StringBuilder();
            pb.AppendLine("# 人格");
            pb.AppendLine();
            pb.AppendLine("它是谁、怎么说话、什么脾气。**留空也能跑**，它会按默认方式说话。");
            pb.AppendLine();
            pb.AppendLine("想让它像某个人的话，可以填：");
            pb.AppendLine();
            pb.AppendLine("```");
            pb.AppendLine("名字：");
            pb.AppendLine("说话方式：直接给判断，不铺垫；不知道就说不知道");
            pb.AppendLine("不喜欢的：表演式关心、长篇免责声明");
            pb.AppendLine("```");
            pb.AppendLine();
            pb.AppendLine("★ 这一份是「它是谁」，不是「它知道什么」—— 后者在记忆里，不在这个文件。");
            File.WriteAllText(persona, pb.ToString(), new UTF8Encoding(false));
            Console.WriteLine("workspace-init = 20-档案/人格.md");
        }

        return ws;
    }

    /// 找已有的《墨》账本。返回 soul 根目录（含 02-墨.jsonl 的那层），找不到回 null。
    /// ★ 顺序 = 从「最可能是这次的」到「最可能是历史的」。
    static string FindExistingSoul(string hint)
    {
        List<string> cands = new List<string>();
        if (!string.IsNullOrEmpty(hint)) cands.Add(hint);
        string up = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (!string.IsNullOrEmpty(up)) cands.Add(Path.Combine(up, "yanqing-soul"));
        cands.Add("D:\\AI\\yanqing-soul");
        for (int i = 0; i < cands.Count; i++)
        {
            try
            {
                string root = cands[i];
                if (string.IsNullOrEmpty(root)) continue;
                string ledger = Path.Combine(root, "02-墨.jsonl");
                if (File.Exists(ledger))
                {
                    long size = new FileInfo(ledger).Length;
                    Console.WriteLine("  found ledger: " + ledger + " (" + size + " bytes)");
                    return root;
                }
            }
            catch { }
        }
        return null;
    }

    // ── 安装核心（向导与静默共用）────────────────────────────────────────────
    public static void InstallCore(InstallOptions o)
    {
        Directory.CreateDirectory(o.Target);
        LogLine(o.Target, "install-start target=" + o.Target + " configureLlm=" + o.ConfigureLlm + " newKey=" + o.HasNewKey);
        Console.WriteLine("install-root = " + o.Target);

        List<string> before = ListVersions(o.Target);
        Console.WriteLine("versions-before = " + (before.Count == 0 ? "(none)" : Join(before)));

        string tmpZip = Path.Combine(Path.GetTempPath(), "agentsoul-payload-" + Pid() + ".zip");
        try
        {
            WriteResource(tmpZip);
            Console.WriteLine("payload-bytes = " + new FileInfo(tmpZip).Length);
            int written = 0, kept = 0;
            Extract(tmpZip, o.Target, out written, out kept);
            Console.WriteLine("files-written = " + written);
            Console.WriteLine("user-files-kept = " + kept);
        }
        finally
        {
            try { if (File.Exists(tmpZip)) File.Delete(tmpZip); } catch { }
        }

        string verFile = Path.Combine(Path.Combine(o.Target, "app"), "current.txt");
        string version = File.Exists(verFile) ? File.ReadAllText(verFile).Trim() : "(unknown)";
        Console.WriteLine("version = " + version);

        // ① 先把「老配置里的明文 key」搬进 DPAPI（升级路径：用户不该因为换版本而丢 key，
        //    也不该继续把 key 明文留在 config.json 里）。
        if (!string.IsNullOrEmpty(o.ApiKey)) o.HasNewKey = true;
        if (!o.HasNewKey)
        {
            try { MigrateLegacyPlainKey(o); }
            catch (Exception ex) { Console.WriteLine("[warn] legacy-key migrate: " + ex.Message); }
        }

        // ② 新的 key（向导才有）：经 stdin 交给 SecretStore
        if (o.HasNewKey)
        {
            StoreSecret(o.Target, o.ProviderId, o.ApiKey);
            if (!VerifySecret(o.Target, o.ProviderId, o.ApiKey))
                throw new Exception("DPAPI 回读校验失败：秘密存进去了但读回来对不上（这次不写配置，避免配出一个解不开的引用）");
            Console.WriteLine("secret = dpapi:" + o.ProviderId + "  (已加密保存；当前用户；未写进 config.json)");
            LogLine(o.Target, "secret-stored provider=" + o.ProviderId + " （值不落日志）");
        }

        // ②-b 工作区：新用户建骨架 / 老用户扫已有
        // ★ 2026-11-13（爀曦指出）：v4 要读《墨》账本、宪章、人格 —— 新用户一样都没有。
        //   不处理的话，装完是个「能跑但空白」的软件：自主永远 fail-closed（账本读不到），
        //   而界面上看不出来。所以装的时候就得把这件事做掉。
        try
        {
            if (o.UserMode == "existing")
            {
                string found = FindExistingSoul(o.ExistingSoulRoot);
                if (found == null)
                {
                    Console.WriteLine("user-mode = existing");
                    Console.WriteLine("[warn] 没找到已有的《墨》账本 —— 会退回建空白骨架。");
                    Console.WriteLine("[warn] （找过：config 里的路径 / %USERPROFILE%\\yanqing-soul / D:\\AI\\yanqing-soul）");
                    MakeWorkspaceSkeleton(o.Target);
                }
                else
                {
                    Console.WriteLine("user-mode = existing");
                    Console.WriteLine("existing-soul = " + found);
                    o.ExistingSoulRoot = found;
                }
            }
            else
            {
                Console.WriteLine("user-mode = new");
                MakeWorkspaceSkeleton(o.Target);
            }
        }
        catch (Exception ex)
        {
            Console.WriteLine("[warn] workspace 准备失败（不影响安装本体）: " + ex.Message);
        }

        // ③ 配置
        if (o.ConfigureLlm) WriteConfig(o);
        WriteIntegrations(o);   // ★ 无条件：静默装也要有「书在哪里」

        // ④ 快捷方式
        if (!o.NoShortcut)
        {
            string lnk = MakeShortcut(o.StartMenuRoot, Path.Combine(o.Target, PRODUCT + ".exe"));
            Console.WriteLine("shortcut = " + lnk);
            Console.WriteLine("shortcut-target = " + ReadShortcutTarget(lnk));
        }
        else Console.WriteLine("shortcut = (skipped: /NoShortcut)");

        // ⑤ WebView2 探测（不随包）
        string wv = DetectWebView2();
        Console.WriteLine("webview2-runtime = " + wv);

        // ⑥ 记账（绝不含秘密）
        StringBuilder info = new StringBuilder();
        info.AppendLine("product = " + PRODUCT);
        info.AppendLine("version = " + version);
        info.AppendLine("installed-at = " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        info.AppendLine("install-root = " + o.Target);
        info.AppendLine("setup-exe = " + SafeExePath());
        info.AppendLine("versions = " + Join(ListVersions(o.Target)));
        info.AppendLine("startmenu-root = " + o.StartMenuRoot);
        info.AppendLine("webview2-runtime = " + wv);
        if (o.ConfigureLlm)
        {
            info.AppendLine("llm.protocol = " + NormalizeProtocol(o.Protocol));
            info.AppendLine("llm.provider = " + o.ProviderId);
            info.AppendLine("llm.providerName = " + o.ProviderName);
            info.AppendLine("llm.baseUrl = " + (String.IsNullOrEmpty(o.EffectiveBaseUrl) ? "(默认)" : o.EffectiveBaseUrl));
            info.AppendLine("llm.model = " + o.Model);
            info.AppendLine("llm.apiKeyRef = dpapi:" + o.ProviderId);
            info.AppendLine("llm.apiKey = (不写；秘密在 data/secrets/" + o.ProviderId + ".dpapi，DPAPI CurrentUser)");
        }
        info.AppendLine("");
        info.AppendLine("rollback = edit app" + Path.DirectorySeparatorChar + "current.txt back to an older version, or run:");
        info.AppendLine("           " + SafeExePath() + " /Rollback=<version> /D=" + o.Target);
        WriteAllTextSafe(Path.Combine(o.Target, "install-info.txt"), info.ToString());
        LogLine(o.Target, "install-done version=" + version + " llm=" + (o.ConfigureLlm ? (NormalizeProtocol(o.Protocol) + " " + o.ProviderId) : "未配置"));
        Console.WriteLine("done. launch: " + Path.Combine(o.Target, PRODUCT + ".exe"));
    }

    // ── 配置（JSON，保留用户已有键）─────────────────────────────────────────
    static void WriteConfig(InstallOptions o)
    {
        string file = Path.Combine(o.Target, "config.json");
        Dictionary<string, object> root = ReadJsonObject(file);
        Dictionary<string, object> llm = Child(root, "llm");
        string proto = NormalizeProtocol(o.Protocol);
        llm["protocol"] = proto;
        llm["provider"] = o.ProviderId;
        llm["providerName"] = o.ProviderName;
        llm["baseUrl"] = NormalizeBaseUrl(o.BaseUrl, proto);
        llm["apiKey"] = "";                        // ★ 明文永远为空
        llm["apiKeyRef"] = "dpapi:" + o.ProviderId; // ★ 只有引用
        if (!string.IsNullOrEmpty(o.Model)) llm["model"] = o.Model;
        o.EffectiveBaseUrl = DefaultBase(proto);

        WriteAllTextSafe(file, JsonPretty(root));
        Console.WriteLine("config = " + file);
        Console.WriteLine("config.llm.protocol = " + proto);
        Console.WriteLine("config.llm.baseUrl = " + (String.IsNullOrEmpty(DictionaryGetStr(llm, "baseUrl")) ? "(空 → 默认 " + DefaultBase(proto) + ")" : DictionaryGetStr(llm, "baseUrl")));
        LogLine(o.Target, "config-written protocol=" + proto + " provider=" + o.ProviderId + " baseUrl=" + DictionaryGetStr(llm, "baseUrl"));
    }

    /// ★ 2026-11-13：「书在哪里」必须**独立于 ConfigureLlm** 写进去。
    ///   为什么单独一个方法：静默安装（/S）不带 protocol/baseurl/model 任何一个参数，
    ///   于是 o.ConfigureLlm == false、WriteConfig 整个不被调用 —— 我第一版把这段塞在
    ///   WriteConfig 里，静默装出来的 config 就一条 integrations 都没有。
    ///   ★ 而「用向导装」和「用 /S 批量装」不该得到两种不同的产品。
    static void WriteIntegrations(InstallOptions o)
    {
        string file = Path.Combine(o.Target, "config.json");
        if (!File.Exists(file)) { Console.WriteLine("[warn] config.json 不存在，跳过 integrations"); return; }
        try
        {
            Dictionary<string, object> root = ReadJsonObject(file);
            Dictionary<string, object> integ = Child(root, "integrations");
            string led = null;
            if (o.UserMode == "existing" && !string.IsNullOrEmpty(o.ExistingSoulRoot))
                led = Path.Combine(o.ExistingSoulRoot, "02-墨.jsonl");
            else
            {
                string ws = Path.Combine(o.Target, "workspace");
                if (File.Exists(Path.Combine(ws, "02-墨.jsonl"))) led = Path.Combine(ws, "02-墨.jsonl");
            }
            if (led == null) { Console.WriteLine("integrations.ledgerFile = (未设置 —— 没有可用的账本)"); return; }
            integ["ledgerFile"] = led;
            integ["soulRoot"] = o.UserMode == "existing" && !string.IsNullOrEmpty(o.ExistingSoulRoot)
                ? o.ExistingSoulRoot : Path.Combine(o.Target, "workspace");
            WriteAllTextSafe(file, JsonPretty(root));
            Console.WriteLine("config.integrations.ledgerFile = " + led);
        }
        catch (Exception ex) { Console.WriteLine("[warn] integrations 写入失败: " + ex.Message); }
    }

    /** 协议 → 官方默认地址。与 src/llm/client.mjs 的 DEFAULT_BASE 必须一致（两边都改了才算改）。 */
    public static string DefaultBase(string protocol)
    {
        return NormalizeProtocol(protocol) == "anthropic" ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com";
    }

    public static string NormalizeProtocol(string p)
    {
        string s = (p ?? "").Trim().ToLowerInvariant();
        if (s == "anthropic" || s == "anthropic-messages" || s == "messages") return "anthropic";
        return "openai";
    }

    /** 地址规范化：去尾斜杠、去重复端点（与 client.mjs 的 normalizeBaseUrl 同规则） */
    public static string NormalizeBaseUrl(string url, string protocol)
    {
        string s = (url ?? "").Trim();
        if (s.Length == 0) return "";
        s = s.TrimEnd('/');
        if (NormalizeProtocol(protocol) == "anthropic")
        {
            s = StripSuffix(s, "/v1/messages");
            s = StripSuffix(s, "/messages");
            s = StripSuffix(s, "/v1");
        }
        else
        {
            s = StripSuffix(s, "/chat/completions");
        }
        return s.TrimEnd('/');
    }

    static string StripSuffix(string s, string suffix)
    {
        if (s.Length >= suffix.Length && String.Compare(s, s.Length - suffix.Length, suffix, 0, suffix.Length, StringComparison.OrdinalIgnoreCase) == 0)
            return s.Substring(0, s.Length - suffix.Length);
        return s;
    }

    // ── 秘密（DPAPI，经 stdin）───────────────────────────────────────────────
    static void StoreSecret(string root, string provider, string secret)
    {
        string exe = Path.Combine(Path.Combine(root, "runtime"), "SecretStore.exe");
        if (!File.Exists(exe)) throw new Exception("秘密组件缺失：" + exe + "（安装包应当带 runtime 目录）");
        ProcessStartInfo psi = SecretStartInfo(exe, "set --provider " + provider + " --root " + Quote(root));
        using (Process p = Process.Start(psi))
        {
            p.StandardInput.Write(secret);
            p.StandardInput.Close();
            string outTxt = p.StandardOutput.ReadToEnd();
            string errTxt = p.StandardError.ReadToEnd();
            if (!p.WaitForExit(20000)) { try { p.Kill(); } catch { } throw new Exception("SecretStore 超时"); }
            if (p.ExitCode != 0) throw new Exception("SecretStore 失败（exit " + p.ExitCode + "）：" + FirstLine(errTxt));
            Console.WriteLine("secret-store = " + FirstLine(outTxt));
        }
    }

    static bool VerifySecret(string root, string provider, string secret)
    {
        string exe = Path.Combine(Path.Combine(root, "runtime"), "SecretStore.exe");
        string got = RunSecretStoreCapture(exe, "get --provider " + provider + " --root " + Quote(root));
        return String.Equals(got, secret, StringComparison.Ordinal);
    }

    static string RunSecretStoreCapture(string exe, string args)
    {
        ProcessStartInfo psi = SecretStartInfo(exe, args);
        using (Process p = Process.Start(psi))
        {
            string o = p.StandardOutput.ReadToEnd();
            string e = p.StandardError.ReadToEnd();
            p.WaitForExit(20000);
            return p.ExitCode == 0 ? o : FirstLine(e);
        }
    }

    static ProcessStartInfo SecretStartInfo(string exe, string args)
    {
        ProcessStartInfo psi = new ProcessStartInfo(exe, args);
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        psi.StandardOutputEncoding = new UTF8Encoding(false);
        psi.StandardErrorEncoding = new UTF8Encoding(false);
        return psi;
    }

    /** 老配置里的明文 key → DPAPI（升级路径）。失败就保持原样，绝不删掉用户唯一的凭据。 */
    static void MigrateLegacyPlainKey(InstallOptions o)
    {
        string file = Path.Combine(o.Target, "config.json");
        if (!File.Exists(file)) return;
        Dictionary<string, object> root = ReadJsonObject(file);
        Dictionary<string, object> llm = Child(root, "llm");
        string plain = DictionaryGetStr(llm, "apiKey");
        if (string.IsNullOrEmpty(plain)) return;
        StoreSecret(o.Target, o.ProviderId, plain);
        if (!VerifySecret(o.Target, o.ProviderId, plain)) throw new Exception("回读校验失败，保留明文 key 不动");
        llm["apiKey"] = "";
        llm["apiKeyRef"] = "dpapi:" + o.ProviderId;
        WriteAllTextSafe(file, JsonPretty(root));
        Console.WriteLine("legacy-key = 已迁移到 dpapi:" + o.ProviderId + "（config.json 里的明文已清空）");
        LogLine(o.Target, "legacy-key-migrated provider=" + o.ProviderId + " 明文已清空");
    }

    // ── JSON（System.Web.Extensions 的 JavaScriptSerializer 只用来读，写用手写 pretty）──
    static Dictionary<string, object> ReadJsonObject(string file)
    {
        if (!File.Exists(file)) return new Dictionary<string, object>();
        try
        {
            string txt = File.ReadAllText(file, Encoding.UTF8);
            if (txt.Trim().Length == 0) return new Dictionary<string, object>();
            JavaScriptSerializer ser = new JavaScriptSerializer();
            ser.MaxJsonLength = 8 * 1024 * 1024;
            object o = ser.DeserializeObject(txt);
            Dictionary<string, object> d = o as Dictionary<string, object>;
            return d ?? new Dictionary<string, object>();
        }
        catch (Exception ex)
        {
            throw new Exception("config.json 解析失败（不敢覆盖它）：" + ex.Message);
        }
    }

    static Dictionary<string, object> Child(Dictionary<string, object> d, string key)
    {
        object v;
        if (d.TryGetValue(key, out v))
        {
            Dictionary<string, object> c = v as Dictionary<string, object>;
            if (c != null) return c;
        }
        Dictionary<string, object> n = new Dictionary<string, object>();
        d[key] = n;
        return n;
    }

    static string DictionaryGetStr(Dictionary<string, object> d, string key)
    {
        object v;
        if (d.TryGetValue(key, out v) && v != null) return Convert.ToString(v, CultureInfo.InvariantCulture);
        return "";
    }

    const char QT = (char)34;
    const char BS = (char)92;

    static string JsonPretty(Dictionary<string, object> root)
    {
        StringBuilder sb = new StringBuilder();
        WriteJson(sb, root, 0);
        sb.Append(Environment.NewLine);
        return sb.ToString();
    }

    static void WriteJson(StringBuilder sb, object v, int indent)
    {
        if (v == null) { sb.Append("null"); return; }
        string s = v as string;
        if (s != null) { WriteJsonString(sb, s); return; }
        if (v is bool) { sb.Append(((bool)v) ? "true" : "false"); return; }
        if (v is int || v is long) { sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture)); return; }
        if (v is double || v is float || v is decimal)
        {
            sb.Append(Convert.ToString(v, CultureInfo.InvariantCulture));
            return;
        }
        Dictionary<string, object> d = v as Dictionary<string, object>;
        if (d != null)
        {
            if (d.Count == 0) { sb.Append("{}"); return; }
            sb.Append("{").Append(Environment.NewLine);
            int i = 0;
            foreach (KeyValuePair<string, object> kv in d)
            {
                sb.Append(new string(' ', (indent + 1) * 2));
                WriteJsonString(sb, kv.Key);
                sb.Append(": ");
                WriteJson(sb, kv.Value, indent + 1);
                if (++i < d.Count) sb.Append(",");
                sb.Append(Environment.NewLine);
            }
            sb.Append(new string(' ', indent * 2)).Append("}");
            return;
        }
        object[] arr = v as object[];
        if (arr != null)
        {
            if (arr.Length == 0) { sb.Append("[]"); return; }
            sb.Append("[").Append(Environment.NewLine);
            for (int i = 0; i < arr.Length; i++)
            {
                sb.Append(new string(' ', (indent + 1) * 2));
                WriteJson(sb, arr[i], indent + 1);
                if (i + 1 < arr.Length) sb.Append(",");
                sb.Append(Environment.NewLine);
            }
            sb.Append(new string(' ', indent * 2)).Append("]");
            return;
        }
        WriteJsonString(sb, Convert.ToString(v, CultureInfo.InvariantCulture));
    }

    static void WriteJsonString(StringBuilder sb, string s)
    {
        sb.Append(QT);
        foreach (char c in s)
        {
            if (c == QT) { sb.Append(BS).Append(QT); }
            else if (c == BS) { sb.Append(BS).Append(BS); }
            else if (c == (char)10 || c == (char)13 || c == (char)9)
            {
                sb.Append(BS);
                sb.Append(c == (char)10 ? 'n' : (c == (char)13 ? 'r' : 't'));
            }
            else sb.Append(c);
        }
        sb.Append(QT);
    }

    // ── 解包 ────────────────────────────────────────────────────────────────
    static void Extract(string zipPath, string target, out int written, out int kept)
    {
        written = 0; kept = 0;
        char sep = Path.DirectorySeparatorChar;
        using (ZipArchive z = ZipFile.OpenRead(zipPath))
        {
            foreach (ZipArchiveEntry e in z.Entries)
            {
                string rel = e.FullName.Replace('/', sep);
                if (rel.Length == 0) continue;
                if (rel.IndexOf(".." + sep, StringComparison.Ordinal) >= 0 || rel.StartsWith("..", StringComparison.Ordinal))
                    continue;
                string dst = Path.Combine(target, rel);
                bool isDir = rel.EndsWith(sep.ToString(), StringComparison.Ordinal) || string.IsNullOrEmpty(e.Name);
                if (isDir) { Directory.CreateDirectory(dst); continue; }
                string dir = Path.GetDirectoryName(dst);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);

                // ★ 用户的东西不覆盖：config.json / workspace / data 是「用户的」，其余是「程序的」
                bool userFile = rel == "config.json"
                    || rel.StartsWith("workspace" + sep, StringComparison.OrdinalIgnoreCase)
                    || rel.StartsWith("data" + sep, StringComparison.OrdinalIgnoreCase);
                if (File.Exists(dst) && userFile) { kept++; continue; }
                using (Stream s = e.Open())
                using (FileStream o = new FileStream(dst, FileMode.Create, FileAccess.Write))
                {
                    s.CopyTo(o);
                }
                written++;
            }
        }
    }

    public static List<string> ListVersions(string target)
    {
        List<string> list = new List<string>();
        string appDir = Path.Combine(target, "app");
        if (!Directory.Exists(appDir)) return list;
        foreach (string d in Directory.GetDirectories(appDir))
        {
            if (File.Exists(Path.Combine(Path.Combine(d, "src"), "index.mjs")))
                list.Add(Path.GetFileName(d));
        }
        list.Sort(StringComparer.OrdinalIgnoreCase);
        return list;
    }

    // ── 快捷方式 ────────────────────────────────────────────────────────────
    static string MakeShortcut(string smRoot, string exePath)
    {
        string folder = Path.Combine(smRoot, PRODUCT);
        Directory.CreateDirectory(folder);
        string lnk = Path.Combine(folder, PRODUCT + ".lnk");
        string workDir = Path.GetDirectoryName(exePath);

        Type t = Type.GetTypeFromProgID("WScript.Shell");
        if (t == null) throw new Exception("WScript.Shell 不可用，无法创建快捷方式");
        object shell = Activator.CreateInstance(t);
        object sc = null;
        try
        {
            sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
            Type sct = sc.GetType();
            sct.InvokeMember("TargetPath", BindingFlags.SetProperty, null, sc, new object[] { exePath });
            sct.InvokeMember("WorkingDirectory", BindingFlags.SetProperty, null, sc, new object[] { workDir });
            sct.InvokeMember("IconLocation", BindingFlags.SetProperty, null, sc, new object[] { exePath + ",0" });
            sct.InvokeMember("Description", BindingFlags.SetProperty, null, sc, new object[] { "AgentSoul - soul layer runtime" });
            sct.InvokeMember("Save", BindingFlags.InvokeMethod, null, sc, new object[] { });
        }
        finally
        {
            if (sc != null) { try { Marshal.ReleaseComObject(sc); } catch { } }
            try { Marshal.ReleaseComObject(shell); } catch { }
        }
        return lnk;
    }

    static string ReadShortcutTarget(string lnk)
    {
        if (!File.Exists(lnk)) return "(missing)";
        Type t = Type.GetTypeFromProgID("WScript.Shell");
        if (t == null) return "(no WScript.Shell)";
        object shell = Activator.CreateInstance(t);
        object sc = null;
        try
        {
            sc = t.InvokeMember("CreateShortcut", BindingFlags.InvokeMethod, null, shell, new object[] { lnk });
            object v = sc.GetType().InvokeMember("TargetPath", BindingFlags.GetProperty, null, sc, new object[] { });
            return v == null ? "(null)" : v.ToString();
        }
        finally
        {
            if (sc != null) { try { Marshal.ReleaseComObject(sc); } catch { } }
            try { Marshal.ReleaseComObject(shell); } catch { }
        }
    }

    // ── WebView2 探测（只读目录名）──────────────────────────────────────────
    static string DetectWebView2()
    {
        string[] roots = new string[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "EdgeWebView", "Application"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "EdgeWebView", "Application")
        };
        foreach (string r in roots)
        {
            try
            {
                if (!Directory.Exists(r)) continue;
                string best = null;
                foreach (string d in Directory.GetDirectories(r))
                {
                    string name = Path.GetFileName(d);
                    if (!IsVersionLike(name)) continue;
                    if (best == null || CompareDotted(name, Path.GetFileName(best)) > 0) best = d;
                }
                if (best == null) continue;
                return Path.GetFileName(best) + " @ " + r;
            }
            catch { }
        }
        return "(not detected)";
    }

    static bool IsVersionLike(string s)
    {
        if (string.IsNullOrEmpty(s)) return false;
        string[] parts = s.Split('.');
        if (parts.Length < 2) return false;
        foreach (string p in parts)
        {
            if (p.Length == 0) return false;
            foreach (char c in p) if (c < '0' || c > '9') return false;
        }
        return true;
    }

    static int CompareDotted(string a, string b)
    {
        string[] pa = a.Split('.');
        string[] pb = b.Split('.');
        int n = Math.Min(pa.Length, pb.Length);
        for (int i = 0; i < n; i++)
        {
            long x = 0, y = 0;
            long.TryParse(pa[i], out x);
            long.TryParse(pb[i], out y);
            if (x != y) return x < y ? -1 : 1;
        }
        if (pa.Length == pb.Length) return 0;
        return pa.Length < pb.Length ? -1 : 1;
    }

    // ── 杂项 ────────────────────────────────────────────────────────────────
    static void WriteResource(string dst)
    {
        Assembly asm = Assembly.GetExecutingAssembly();
        using (Stream s = asm.GetManifestResourceStream(RES))
        {
            if (s == null)
            {
                string[] names = asm.GetManifestResourceNames();
                throw new Exception("嵌入资源 " + RES + " 找不到，实际资源：" + String.Join(", ", names));
            }
            using (FileStream o = new FileStream(dst, FileMode.Create, FileAccess.Write)) s.CopyTo(o);
        }
    }

    static void WriteAllTextSafe(string path, string text) { File.WriteAllText(path, text, new UTF8Encoding(false)); }

    static string Join(List<string> list) { return String.Join(", ", list.ToArray()); }

    static string Quote(string s) { return QT + s + QT; }

    static string FirstLine(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        string[] parts = s.Split(new char[] { (char)10, (char)13 }, StringSplitOptions.RemoveEmptyEntries);
        return parts.Length == 0 ? "" : parts[0].Trim();
    }

    static string Pid()
    {
        try { return Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture); }
        catch { return "0"; }
    }

    static string SafeExePath()
    {
        try { return Assembly.GetExecutingAssembly().Location; }
        catch { return "(unknown)"; }
    }

    /** 安装日志：只记动作与事实，**永不记秘密**。 */
    public static void LogLine(string target, string line)
    {
        try
        {
            if (string.IsNullOrEmpty(target) || !Directory.Exists(target)) return;
            string f = Path.Combine(target, "install-log.txt");
            File.AppendAllText(f, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + line + Environment.NewLine, new UTF8Encoding(false));
        }
        catch { }
    }
}

class InstallOptions
{
    // ★ 2026-11-13：用户类型。
    //   new      = 新用户 —— 装完在 workspace 下建空白骨架（墨账本 / 宪章 / 档案 / 状态）
    //   existing = 老用户 —— 扫已有文件，找到就写进 config 的 integrations.ledgerFile
    public string UserMode = "new";
    // 老用户指路（向导里手填；空 = 自动扫）
    public string ExistingSoulRoot = "";
    public string Target = "";
    public string StartMenuRoot = "";
    public string ProviderId = "deepseek-official";
    public string ProviderName = "DeepSeek官方";
    public string Protocol = "openai";
    public string BaseUrl = "";
    public string Model = "deepseek-chat";
    public string ApiKey = "";          // 只在内存里，不问不记
    public string EffectiveBaseUrl = "";
    public bool NoShortcut = false;
    public bool ConfigureLlm = true;
    public bool HasNewKey = false;
}

// ═══════════════════════════════════════════════════════════════════════
// 向导（三页）
//
// ★ 页面顺序就是用户的心智顺序：先决定装在哪，再决定拿什么去调模型，最后看结果。
// ★ 所有校验都在「点下一步/安装」那一刻做，错误就地显示（lblErr），不弹 MessageBox ——
//   弹窗会挡住截图，也会让 UIA 验收多一层要关的窗。
// ═══════════════════════════════════════════════════════════════════════
class Wizard : Form
{
    readonly Dictionary<string, string> op;
    readonly string defaultTarget;
    public int ExitCode = 0;

    Panel p0, p1, p2, p3;
    RadioButton rbNew, rbOld;
    TextBox tbSoulRoot;
    Label lblStep, lblErr, lblAddrHint, lblPage3Head;
    Button btnBack, btnNext, btnCancel;
    TextBox tbDir;
    TextBox tbProvider, tbProviderName, tbBaseUrl, tbKey, tbModel;
    ComboBox cbProtocol;
    CheckBox ckShow;
    TextBox txtLog;
    ProgressBar bar;
    int step = 1;
    bool installing = false;
    string lastProtocolDefault = "https://api.deepseek.com";

    public Wizard(Dictionary<string, string> op, string target)
    {
        this.op = op;
        this.defaultTarget = target;
        Text = "AgentSoul 安装向导";
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(780, 640);
        Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
        BackColor = Color.FromArgb(247, 248, 250);
        BuildChrome();
        BuildPage0();
        BuildPage1();
        BuildPage2();
        BuildPage3();
        ShowStep(0);
    }

    // ── 外壳 ────────────────────────────────────────────────────────────────
    void BuildChrome()
    {
        Label title = new Label();
        title.Text = "AgentSoul 安装向导";
        title.Location = new Point(24, 14);
        title.Size = new Size(500, 32);
        title.Font = new Font("Microsoft YaHei UI", 15F, FontStyle.Bold);
        title.ForeColor = Color.FromArgb(32, 36, 42);
        Controls.Add(title);

        lblStep = new Label();
        lblStep.Text = "第 1 步 / 共 3 步 · 安装位置";
        lblStep.Location = new Point(24, 50);
        lblStep.Size = new Size(600, 20);
        lblStep.ForeColor = Color.FromArgb(110, 118, 128);
        Controls.Add(lblStep);

        Panel line = new Panel();
        line.Location = new Point(24, 80);
        line.Size = new Size(732, 1);
        line.BackColor = Color.FromArgb(214, 219, 226);
        Controls.Add(line);

        btnBack = new Button();
        btnBack.Text = "上一步";
        btnBack.Location = new Point(452, 588);
        btnBack.Size = new Size(96, 32);
        btnBack.Click += delegate { OnBack(); };
        Controls.Add(btnBack);

        btnNext = new Button();
        btnNext.Text = "下一步";
        btnNext.Location = new Point(556, 588);
        btnNext.Size = new Size(120, 32);
        btnNext.Click += delegate { OnNext(); };
        Controls.Add(btnNext);

        btnCancel = new Button();
        btnCancel.Text = "取消";
        btnCancel.Location = new Point(684, 588);
        btnCancel.Size = new Size(72, 32);
        btnCancel.Click += delegate { if (!installing) Close(); };
        Controls.Add(btnCancel);
    }

    Label Mk(string text, int x, int y, int w, int h, bool bold)
    {
        Label l = new Label();
        l.Text = text;
        l.Location = new Point(x, y);
        l.Size = new Size(w, h);
        l.AutoSize = false;
        if (bold) l.Font = new Font("Microsoft YaHei UI", 10F, FontStyle.Bold);
        return l;
    }

    TextBox MkBox(int x, int y, int w)
    {
        TextBox t = new TextBox();
        t.Location = new Point(x, y);
        t.Size = new Size(w, 26);
        t.BorderStyle = BorderStyle.FixedSingle;
        return t;
    }

    // ── 第 0 页：新用户 / 老用户 ──────────────────────────────────────────────
    //
    // ★ 2026-11-13（爀曦）：这两类人装完之后面对的完全是两个世界 ——
    //   新用户手上没有《墨》账本、没有宪章、没有档案，而 v4 启动要读它们；
    //   老用户手上全都有，只是散在别的目录里。
    //   所以第一步不是问「装到哪」，而是问「你是哪一种」。
    void BuildPage0()
    {
        p0 = new Panel();
        p0.Location = new Point(0, 92);
        p0.Size = new Size(780, 480);
        Controls.Add(p0);

        p0.Controls.Add(Mk("你是第一次装 AgentSoul，还是从旧的全新迁过来？", 24, 12, 660, 24, true));
        p0.Controls.Add(Mk("这个问题决定装完之后帮你准备什么 —— 选错了不影响使用，之后可以在设置里改。", 24, 42, 700, 20, false));

        rbNew = new RadioButton();
        rbNew.Text = "我是新用户 —— 帮我建一份空白的书架";
        rbNew.Location = new Point(24, 86);
        rbNew.Size = new Size(640, 24);
        rbNew.Checked = true;
        p0.Controls.Add(rbNew);

        p0.Controls.Add(Mk("会在 <安装目录>\\workspace\\ 下建：《墨》账本（空）/ 10-宪章 / 20-档案 / 30-状态 / 50-日记。", 46, 112, 700, 20, false));
        p0.Controls.Add(Mk("空账本是**合法**的 —— 它表示「还没记任何事」，不是坏的。v4 能直接读。", 46, 132, 700, 20, false));

        rbOld = new RadioButton();
        rbOld.Text = "我是老用户 —— 我手上已经有《墨》和宪章";
        rbOld.Location = new Point(24, 176);
        rbOld.Size = new Size(640, 24);
        p0.Controls.Add(rbOld);

        p0.Controls.Add(Mk("装完会自动去找 02-墨.jsonl：先看下面这一栏，再找 %USERPROFILE%\\yanqing-soul，再找 D:\\AI\\yanqing-soul。", 46, 202, 700, 20, false));
        p0.Controls.Add(Mk("找不到会**明说**，不会假装找到了 —— 然后退回建空白骨架。", 46, 222, 700, 20, false));

        tbSoulRoot = MkBox(46, 254, 620);
        tbSoulRoot.Text = "";
        p0.Controls.Add(tbSoulRoot);
        p0.Controls.Add(Mk("（可选）已有的 soul 根目录 —— 就是含 02-墨.jsonl 的那一层，留空则自动找", 46, 284, 700, 20, false));

        p0.Controls.Add(Mk("★ 不确定就选第一个：新用户。它只会多建几个空文件，不会动你已有的东西。", 24, 330, 720, 20, false));
    }

    // ── 第 1 页：安装位置 ────────────────────────────────────────────────────
    void BuildPage1()
    {
        p1 = new Panel();
        p1.Location = new Point(0, 92);
        p1.Size = new Size(780, 480);
        Controls.Add(p1);

        p1.Controls.Add(Mk("安装到哪个目录", 24, 16, 400, 24, true));

        tbDir = MkBox(24, 48, 560);
        tbDir.Text = defaultTarget;
        p1.Controls.Add(tbDir);

        Button browse = new Button();
        browse.Text = "浏览…";
        browse.Location = new Point(594, 46);
        browse.Size = new Size(120, 28);
        browse.Click += delegate
        {
            FolderBrowserDialog dlg = new FolderBrowserDialog();
            dlg.Description = "选择 AgentSoul 的安装位置";
            dlg.SelectedPath = tbDir.Text;
            if (dlg.ShowDialog(this) == DialogResult.OK) tbDir.Text = dlg.SelectedPath;
        };
        p1.Controls.Add(browse);

        Label hint = Mk("默认装在当前用户的 LOCALAPPDATA 下 —— 用户目录，不需要管理员权限，也不写 HKLM。", 24, 92, 700, 24, false);
        hint.ForeColor = Color.FromArgb(110, 118, 128);
        p1.Controls.Add(hint);

        Label hint2 = Mk("旧版本不会被删除：升级只在 app 目录下新增版本子目录；回切 = 把 app 目录里的 current.txt 改回旧版本号。", 24, 118, 700, 24, false);
        hint2.ForeColor = Color.FromArgb(110, 118, 128);
        p1.Controls.Add(hint2);

        Label hint3 = Mk("config.json、data 与 workspace 都在安装根目录里，升级与回滚都不会动它们。", 24, 144, 700, 24, false);
        hint3.ForeColor = Color.FromArgb(110, 118, 128);
        p1.Controls.Add(hint3);
    }

    // ── 第 2 页：API 配置 ────────────────────────────────────────────────────
    // ★ 版式是按实测调的：标签列 140px（"API Key（必填）"占 107px），输入列从 170 起，
    //   地址行下面那条提示要**单独占一段高度**（+46），否则它会压到下一行的输入框上 ——
    //   第一版就是这样，截图里 "显示" 复选框叠在密码框上。
    void BuildPage2()
    {
        p2 = new Panel();
        p2.Location = new Point(0, 92);
        p2.Size = new Size(780, 480);
        p2.Visible = false;
        Controls.Add(p2);

        Label note = Mk("此 Key 供 Agent Soul v4 内部 LLM 监控、判定与调度使用。", 24, 2, 700, 22, true);
        note.ForeColor = Color.FromArgb(178, 88, 24);
        p2.Controls.Add(note);
        Label note2 = Mk("Agent Soul 不是 DeepSeek Harness，也不是另一个通用 harness —— 它是本机的独立运行层，用这把 key 调模型。", 24, 24, 724, 36, false);
        note2.ForeColor = Color.FromArgb(90, 96, 104);
        p2.Controls.Add(note2);

        int y = 66;
        const int gap = 32;
        p2.Controls.Add(Mk("Provider ID", 24, y + 4, 140, 22, false));
        tbProvider = MkBox(170, y, 350);
        tbProvider.Text = "deepseek-official";
        p2.Controls.Add(tbProvider);
        y += gap;

        p2.Controls.Add(Mk("显示名称", 24, y + 4, 140, 22, false));
        tbProviderName = MkBox(170, y, 350);
        tbProviderName.Text = "DeepSeek官方";
        p2.Controls.Add(tbProviderName);
        y += gap;

        p2.Controls.Add(Mk("协议", 24, y + 4, 140, 22, false));
        cbProtocol = new ComboBox();
        cbProtocol.DropDownStyle = ComboBoxStyle.DropDownList;
        cbProtocol.Location = new Point(170, y);
        cbProtocol.Size = new Size(350, 26);
        cbProtocol.Items.Add("OpenAI Chat Completions");
        cbProtocol.Items.Add("Anthropic Messages");
        cbProtocol.SelectedIndex = 0;
        cbProtocol.SelectedIndexChanged += delegate { OnProtocolChanged(); };
        p2.Controls.Add(cbProtocol);
        y += gap;

        p2.Controls.Add(Mk("API 地址（可空）", 24, y + 4, 140, 22, false));
        tbBaseUrl = MkBox(170, y, 350);
        tbBaseUrl.Text = "";
        tbBaseUrl.TextChanged += delegate { UpdateAddrHint(); };
        p2.Controls.Add(tbBaseUrl);
        lblAddrHint = Mk("", 170, y + 26, 566, 18, false);
        lblAddrHint.Font = new Font("Microsoft YaHei UI", 8.25F, FontStyle.Regular, GraphicsUnit.Point);
        lblAddrHint.ForeColor = Color.FromArgb(30, 118, 80);
        p2.Controls.Add(lblAddrHint);
        y += 46;

        p2.Controls.Add(Mk("API Key（必填）", 24, y + 4, 140, 22, false));
        tbKey = MkBox(170, y, 300);
        tbKey.UseSystemPasswordChar = true;
        p2.Controls.Add(tbKey);
        ckShow = new CheckBox();
        ckShow.Text = "显示";
        ckShow.Location = new Point(480, y + 2);
        ckShow.Size = new Size(70, 24);
        ckShow.CheckedChanged += delegate { tbKey.UseSystemPasswordChar = !ckShow.Checked; };
        p2.Controls.Add(ckShow);
        y += gap;

        p2.Controls.Add(Mk("模型", 24, y + 4, 140, 22, false));
        tbModel = MkBox(170, y, 350);
        tbModel.Text = "deepseek-chat";
        p2.Controls.Add(tbModel);
        y += 32;

        p2.Controls.Add(Mk("填写教程", 24, y, 300, 22, true));
        TextBox tut = new TextBox();
        tut.Multiline = true;
        tut.ReadOnly = true;
        tut.ScrollBars = ScrollBars.Vertical;
        tut.Location = new Point(24, y + 22);
        tut.Size = new Size(700, 128);
        tut.BackColor = Color.White;
        tut.Font = new Font("Microsoft YaHei UI", 8.5F, FontStyle.Regular, GraphicsUnit.Point);
        tut.Text = TutorialText();
        p2.Controls.Add(tut);

        lblErr = Mk("", 24, y + 154, 700, 22, false);
        lblErr.ForeColor = Color.FromArgb(190, 40, 40);
        p2.Controls.Add(lblErr);

        UpdateAddrHint();
    }

    static string TutorialText()
    {
        string[] lines = new string[]
        {
            "① 到 platform.deepseek.com 注册，进「API Keys」新建一把，复制整串（通常以 sk- 开头）。",
            "② 原样粘贴：不要在前面加 Bearer，不要加引号，也不要带空格或换行。",
            "③ API 地址可以留空 —— 留空就用该协议的官方地址：",
            "      OpenAI 协议 → https://api.deepseek.com",
            "      Anthropic 协议 → https://api.deepseek.com/anthropic",
            "④ 地址只写到域名（或 /v1）这一段，不要带 /chat/completions，也不要带 /v1/messages —— 端点由程序自己接。",
            "⑤ 用自建网关：地址填你自己的域名或 IP（例如 https://gateway.example.com/v1），协议照旧选 OpenAI 或 Anthropic。",
            "⑥ 这把 Key 只存在本机，用 Windows DPAPI 以当前用户身份加密；config.json 里只有一行引用（dpapi:<providerId>）。",
            "⑦ 换 key：重新运行本安装向导，或在面板「设置」里改 —— 两种方式都不会把 key 写进 config.json。"
        };
        return String.Join(Environment.NewLine, lines);
    }

    string ProtocolValue()
    {
        return cbProtocol.SelectedIndex == 1 ? "anthropic" : "openai";
    }

    string ProtocolLabel()
    {
        return cbProtocol.SelectedIndex == 1 ? "Anthropic Messages" : "OpenAI Chat Completions";
    }

    void OnProtocolChanged()
    {
        string def = cbProtocol.SelectedIndex == 1 ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com";
        string cur = tbBaseUrl.Text.Trim();
        // ★ 只在「空」或「还是上一个协议的默认值」时替换 —— 用户自己填的网关不许被覆盖
        if (cur.Length == 0 || cur == lastProtocolDefault) tbBaseUrl.Text = def;
        lastProtocolDefault = def;
        UpdateAddrHint();
    }

    void UpdateAddrHint()
    {
        string def = cbProtocol.SelectedIndex == 1 ? "https://api.deepseek.com/anthropic" : "https://api.deepseek.com";
        string cur = tbBaseUrl.Text.Trim();
        string eff = cur.Length == 0 ? def : Program.NormalizeBaseUrl(cur, ProtocolValue());
        if (eff.Length == 0) eff = def;
        string ep = ProtocolValue() == "anthropic" ? "/v1/messages" : "/chat/completions";
        // ★ 这一行只放「结果」：会发到哪个地址、打哪个端点。留空就明说「用官方默认」。
        if (cur.Length == 0) lblAddrHint.Text = "地址留空 → 官方默认：" + eff + "  ·  POST " + ep;
        else lblAddrHint.Text = "将使用：" + eff + "  ·  POST " + ep;
    }

    // ── 第 3 页：安装 / 完成 ────────────────────────────────────────────────
    void BuildPage3()
    {
        p3 = new Panel();
        p3.Location = new Point(0, 92);
        p3.Size = new Size(780, 480);
        p3.Visible = false;
        Controls.Add(p3);

        lblPage3Head = Mk("正在安装…", 24, 12, 700, 24, true);
        p3.Controls.Add(lblPage3Head);

        txtLog = new TextBox();
        txtLog.Multiline = true;
        txtLog.ReadOnly = true;
        txtLog.ScrollBars = ScrollBars.Vertical;
        txtLog.Location = new Point(24, 44);
        txtLog.Size = new Size(730, 300);
        txtLog.BackColor = Color.White;
        txtLog.Font = new Font("Consolas", 9F, FontStyle.Regular, GraphicsUnit.Point);
        p3.Controls.Add(txtLog);

        bar = new ProgressBar();
        bar.Location = new Point(24, 356);
        bar.Size = new Size(730, 18);
        bar.Minimum = 0;
        bar.Maximum = 100;
        p3.Controls.Add(bar);
    }

    // ── 步骤切换 / 校验 ─────────────────────────────────────────────────────
    void ShowStep(int n)
    {
        step = n;
        p0.Visible = n == 0;
        p1.Visible = n == 1;
        p2.Visible = n == 2;
        p3.Visible = n == 3;
        btnBack.Enabled = n > 0 && !installing;
        if (n == 0)
        {
            lblStep.Text = "第 1 步 / 共 4 步 · 你是新用户还是老用户";
            btnNext.Text = "下一步";
            btnNext.Enabled = true;
            lblErr.Text = "";
        }
        if (n == 1)
        {
            lblStep.Text = "第 2 步 / 共 4 步 · 安装位置";
            btnNext.Text = "下一步";
            btnNext.Enabled = true;
        }
        if (n == 2)
        {
            lblStep.Text = "第 3 步 / 共 4 步 · API 配置";
            btnNext.Text = "安装";
            btnNext.Enabled = true;
            lblErr.Text = "";
        }
        if (n == 3)
        {
            lblStep.Text = "第 4 步 / 共 4 步 · 安装";
            btnNext.Text = "安装中…";
            btnNext.Enabled = false;
        }
    }

    void OnBack()
    {
        if (installing) return;
        if (step == 1) ShowStep(0);
        else if (step == 2) ShowStep(1);
        else if (step == 3) ShowStep(2);
    }

    void OnNext()
    {
        if (installing) return;
        if (step == 0)
        {
            if (!rbNew.Checked && !rbOld.Checked)
            {
                lblErr.Text = "请先选一个：新用户 / 老用户。";
                return;
            }
            ShowStep(1);
            return;
        }
        if (step == 1)
        {
            string t = tbDir.Text.Trim();
            if (t.Length == 0) { MessageBox.Show(this, "安装目录不能为空。", "AgentSoul"); return; }
            ShowStep(2);
            return;
        }
        if (step == 2)
        {
            string err = ValidatePage2();
            if (err != null) { lblErr.Text = err; return; }
            ShowStep(3);
            StartInstall();
            return;
        }
        Close();
    }

    string ValidatePage2()
    {
        string pid = tbProvider.Text.Trim();
        if (pid.Length == 0) return "Provider ID 不能为空（例：deepseek-official）。";
        if (pid.Length > 64) return "Provider ID 太长（最多 64 字符）。";
        // 1.0.3: keep the wizard inside the same alphabet the runtime accepts for
        //   apiKeyRef (dpapi:[a-z][a-z0-9_-]*). Otherwise a "legal" install could write
        //   a ref that the runtime refuses as invalid. The id is also the secret file name.
        if (!(pid[0] >= 'a' && pid[0] <= 'z'))
            return "Provider ID 要以小写字母开头（例：deepseek-official）。";
        foreach (char c in pid)
        {
            bool ok = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
            if (!ok) return "Provider ID 只能含小写字母、数字、- _（它会被用作秘密文件名和 apiKeyRef）。";
        }
        if (tbProviderName.Text.Trim().Length == 0) return "显示名称不能为空。";
        if (tbModel.Text.Trim().Length == 0) return "模型名不能为空（例：deepseek-chat）。";

        string url = tbBaseUrl.Text.Trim();
        if (url.Length > 0)
        {
            if (!(url.StartsWith("http://") || url.StartsWith("https://")))
                return "API 地址要么留空（用官方默认），要么以 http:// 或 https:// 开头。";
            if (url.IndexOf(' ') >= 0) return "API 地址里不能有空格。";
        }

        string key = tbKey.Text.Trim();
        if (key.Length == 0) return "API Key 不能为空 —— 这把 key 是 v4 内部 LLM 监控 / 判定 / 调度必需的支持。";
        if (key.Length > 512) return "API Key 太长（超过 512 字符），请确认没有把别的内容粘进来。";
        foreach (char c in key)
        {
            if (c == ' ' || c == (char)9 || c == (char)10 || c == (char)13)
                return "API Key 里不能有空格或换行（粘贴时容易带上，删掉即可）。";
        }
        return null;
    }

    // ── 安装（后台线程 + 日志回灌）──────────────────────────────────────────
    void StartInstall()
    {
        installing = true;
        btnBack.Enabled = false;
        btnNext.Enabled = false;
        btnCancel.Enabled = false;
        btnNext.Text = "安装中…";
        txtLog.Clear();
        bar.Style = ProgressBarStyle.Marquee;

        InstallOptions o = new InstallOptions();
        o.Target = tbDir.Text.Trim();
        o.StartMenuRoot = op.ContainsKey("startmenuroot")
            ? Path.GetFullPath(op["startmenuroot"])
            : Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        o.ProviderId = tbProvider.Text.Trim();
        o.ProviderName = tbProviderName.Text.Trim();
        o.Protocol = ProtocolValue();
        o.BaseUrl = tbBaseUrl.Text.Trim();
        o.Model = tbModel.Text.Trim();
        o.ApiKey = tbKey.Text.Trim();
        o.HasNewKey = true;   // ★ 向导收的 key 一定走 DPAPI，绝不写明文
        o.ConfigureLlm = true;
        o.NoShortcut = op.ContainsKey("noshortcut");
        // ★ 2026-11-13：把第 1 步的选择带下去（决定装完要不要建空白骨架）
        o.UserMode = (rbOld != null && rbOld.Checked) ? "existing" : "new";
        o.ExistingSoulRoot = (tbSoulRoot != null) ? tbSoulRoot.Text.Trim() : "";

        TextWriter old = Console.Out;
        Console.SetOut(new UiTextWriter(this));
        Thread t = new Thread(delegate()
        {
            string err = null;
            try { Program.InstallCore(o); }
            catch (Exception ex) { err = ex.GetType().Name + ": " + ex.Message; }
            try
            {
                BeginInvoke(new MethodInvoker(delegate() { OnInstallDone(o, err, old); }));
            }
            catch { }
        });
        t.IsBackground = true;
        t.Start();
    }

    void OnInstallDone(InstallOptions o, string err, TextWriter old)
    {
        try { Console.SetOut(old); } catch { }
        installing = false;
        bar.Style = ProgressBarStyle.Continuous;
        btnCancel.Enabled = true;
        btnCancel.Text = "关闭";

        if (err == null)
        {
            bar.Value = 100;
            lblPage3Head.Text = "安装完成";
            lblStep.Text = "第 3 步 / 共 3 步 · 完成";
            AppendLine("");
            AppendLine("──── 结果 ────");
            foreach (string s in Summary(o)) AppendLine(s);
            btnNext.Text = "完成";
            btnNext.Enabled = true;
            btnBack.Enabled = false;   // 装完了，退回改配置没有意义（要改就重跑向导）
            ExitCode = 0;
        }
        else
        {
            bar.Value = 0;
            lblPage3Head.Text = "安装失败";
            AppendLine("");
            AppendLine("[失败] " + err);
            AppendLine("");
            AppendLine("已装的文件不会被回滚；修好上面的问题后可以点「上一步」改配置再装一次。");
            btnBack.Enabled = true;
            btnNext.Text = "关闭";
            btnNext.Enabled = true;
            ExitCode = 3;
        }
    }

    List<string> Summary(InstallOptions o)
    {
        List<string> s = new List<string>();
        string verFile = Path.Combine(Path.Combine(o.Target, "app"), "current.txt");
        string ver = File.Exists(verFile) ? File.ReadAllText(verFile).Trim() : "(unknown)";
        s.Add("版本      " + ver);
        s.Add("安装根    " + o.Target);
        s.Add("协议      " + ProtocolLabel() + "  (" + ProtocolValue() + ")");
        s.Add("地址      " + (Program.NormalizeBaseUrl(o.BaseUrl, o.Protocol).Length == 0
            ? Program.DefaultBase(o.Protocol) + "（留空 = 官方默认）"
            : Program.NormalizeBaseUrl(o.BaseUrl, o.Protocol)));
        s.Add("模型      " + o.Model);
        s.Add("API Key   已用 Windows DPAPI（CurrentUser）加密保存；config.json 里只有 dpapi:" + o.ProviderId);
        s.Add("下一步    从开始菜单打开 AgentSoul（或直接运行安装根下的 AgentSoul.exe）");
        return s;
    }

    void AppendLine(string s) { AppendLog(s + Environment.NewLine); }

    /** 后台线程写日志 → 回到 UI 线程追加。控件只在自己线程里改。 */
    public void AppendLog(string s)
    {
        if (string.IsNullOrEmpty(s)) return;
        if (IsDisposed) return;
        if (InvokeRequired)
        {
            try { BeginInvoke(new MethodInvoker(delegate() { AppendLog(s); })); } catch { }
            return;
        }
        try { txtLog.AppendText(s); } catch { }
    }
}

/** Console.Out 的替身：把所有 Console.WriteLine 灌进向导的日志框。 */
class UiTextWriter : TextWriter
{
    private readonly Wizard w;
    public UiTextWriter(Wizard w) { this.w = w; }
    public override Encoding Encoding { get { return Encoding.UTF8; } }
    public override void Write(char value) { w.AppendLog(value.ToString()); }
    public override void Write(string value) { w.AppendLog(value); }
    public override void WriteLine(string value) { w.AppendLog(value + Environment.NewLine); }
}
