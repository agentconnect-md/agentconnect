// The Windows service, compiled at install by src/service-windows.ts: runs the daemon as SYSTEM in the console session, so it can answer UAC prompts.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.ServiceProcess;
using System.Text;
using System.Threading;

static class Native {
  public const uint TOKEN_ALL_ACCESS = 0xF01FF;
  public const int SecurityImpersonation = 2;
  public const int TokenPrimary = 1;
  public const int TokenSessionId = 12;
  public const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
  public const uint CREATE_NO_WINDOW = 0x08000000;
  public const uint CREATE_NEW_CONSOLE = 0x10;
  public const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
  public const int STARTF_USESTDHANDLES = 0x100;
  public const int STARTF_USESHOWWINDOW = 0x1;
  public const uint INFINITE = 0xFFFFFFFF;
  public const uint WAIT_OBJECT_0 = 0;
  public const int STD_INPUT_HANDLE = -10, STD_OUTPUT_HANDLE = -11, STD_ERROR_HANDLE = -12;
  public const int JobObjectExtendedLimitInformation = 9;
  public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
  public const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x800;
  public const uint FILE_APPEND_DATA = 0x4, GENERIC_READ = 0x80000000, FILE_SHARE_READ = 1, FILE_SHARE_WRITE = 2, OPEN_EXISTING = 3, OPEN_ALWAYS = 4;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [StructLayout(LayoutKind.Sequential)]
  public struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }

  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("wtsapi32.dll", SetLastError = true)] public static extern bool WTSQueryUserToken(uint session, out IntPtr token);
  [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentProcessId();
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool DuplicateTokenEx(IntPtr token, uint access, IntPtr attributes, int level, int type, out IntPtr duplicate);
  [DllImport("advapi32.dll", SetLastError = true)]
  public static extern bool SetTokenInformation(IntPtr token, int infoClass, ref uint info, int length);
  [DllImport("userenv.dll", SetLastError = true)] public static extern bool CreateEnvironmentBlock(out IntPtr env, IntPtr token, bool inherit);
  [DllImport("userenv.dll")] public static extern bool DestroyEnvironmentBlock(IntPtr env);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit,
    uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CreateFile(string name, uint access, uint share, ref SECURITY_ATTRIBUTES sa, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] public static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")] public static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] public static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll")]
  public static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int length);
  [DllImport("kernel32.dll")] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  public static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return arg;
    var sb = new StringBuilder("\"");
    for (int i = 0; i < arg.Length; i++) {
      int slashes = 0;
      while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }
      if (i == arg.Length) { sb.Append('\\', slashes * 2); break; }
      if (arg[i] == '"') sb.Append('\\', slashes * 2 + 1).Append('"');
      else sb.Append('\\', slashes).Append(arg[i]);
    }
    return sb.Append('"').ToString();
  }

  public static string CommandLine(IEnumerable<string> args) {
    var parts = new List<string>();
    foreach (var arg in args) parts.Add(Quote(arg));
    return string.Join(" ", parts);
  }

  // A job that kills every process in it when its last handle closes, with or without breakaway for user-launched apps.
  public static IntPtr KillOnCloseJob(bool breakawayOk) {
    var job = CreateJobObject(IntPtr.Zero, null);
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | (breakawayOk ? JOB_OBJECT_LIMIT_BREAKAWAY_OK : 0);
    SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(info));
    return job;
  }
}

class Options {
  public string Node, Entry, Home, Log;
  public static Options Parse(string[] args) {
    var o = new Options();
    for (int i = 0; i + 1 < args.Length; i += 2) {
      switch (args[i]) {
        case "--node": o.Node = args[i + 1]; break;
        case "--entry": o.Entry = args[i + 1]; break;
        case "--home": o.Home = args[i + 1]; break;
      }
    }
    if (o.Node == null || o.Entry == null || o.Home == null) throw new ArgumentException("usage: --node NODE --entry ENTRY --home DIR");
    o.Log = Path.Combine(o.Home, "daemon.log");
    return o;
  }
}

class ComputerService : ServiceBase {
  public const string Name = "AgentConnectComputer";
  // Set in the daemon's environment so it knows it runs under this service, and where this host is for run-as-user.
  const string ServiceEnv = "AGENTCONNECT_COMPUTER_WINDOWS_SERVICE";
  readonly Options options;
  readonly object gate = new object();
  readonly ManualResetEvent stopping = new ManualResetEvent(false);
  readonly AutoResetEvent wake = new AutoResetEvent(false);
  Thread loop;
  IntPtr job = IntPtr.Zero;
  IntPtr child = IntPtr.Zero;
  uint childSession = uint.MaxValue;
  // Exit 0 is the menu's Quit: the daemon stays stopped in that session until the next logon.
  uint quitSession = uint.MaxValue;
  int failures;

  public ComputerService(Options options) {
    this.options = options;
    ServiceName = Name;
    CanStop = true;
    CanShutdown = true;
    CanHandleSessionChangeEvent = true;
  }

  protected override void OnStart(string[] args) {
    job = Native.KillOnCloseJob(true);
    loop = new Thread(Run) { IsBackground = true };
    loop.Start();
  }

  protected override void OnStop() { Shutdown(); }
  protected override void OnShutdown() { Shutdown(); }

  protected override void OnSessionChange(SessionChangeDescription change) {
    if (change.Reason == SessionChangeReason.SessionLogon) lock (gate) quitSession = uint.MaxValue;
    wake.Set();
  }

  // 128 (`sc control AgentConnectComputer 128`): start the daemon again after the menu's Quit.
  protected override void OnCustomCommand(int command) {
    if (command != 128) return;
    lock (gate) { quitSession = uint.MaxValue; failures = 0; }
    wake.Set();
  }

  void Shutdown() {
    stopping.Set();
    if (loop != null) loop.Join(15000);
    lock (gate) Kill("service stopping");
    if (job != IntPtr.Zero) Native.CloseHandle(job);
  }

  void Log(string line) {
    try {
      File.AppendAllText(options.Log, "[" + DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ") + "] service: " + line + Environment.NewLine);
    } catch { }
  }

  void Run() {
    Log("started");
    while (!stopping.WaitOne(0)) {
      try { Tick(); } catch (Exception e) { Log("error: " + e.Message); }
      WaitHandle.WaitAny(new WaitHandle[] { stopping, wake }, child == IntPtr.Zero ? Backoff() : 2000);
    }
  }

  int Backoff() { return Math.Min(60000, 2000 * (1 << Math.Min(failures, 5))); }

  void Tick() {
    lock (gate) {
      uint session = Native.WTSGetActiveConsoleSessionId();
      IntPtr userToken = IntPtr.Zero;
      bool loggedOn = session != 0xFFFFFFFF && Native.WTSQueryUserToken(session, out userToken);
      if (loggedOn) Native.CloseHandle(userToken);
      if (child != IntPtr.Zero) {
        if (Native.WaitForSingleObject(child, 0) == Native.WAIT_OBJECT_0) {
          uint code;
          Native.GetExitCodeProcess(child, out code);
          Native.CloseHandle(child);
          child = IntPtr.Zero;
          if (code == 0) { quitSession = childSession; failures = 0; Log("daemon quit; it starts again at the next logon"); }
          else { failures++; Log("daemon exited with code " + code + "; restarting"); }
        } else if (!loggedOn || session != childSession) {
          Kill(loggedOn ? "the console moved to session " + session : "nobody is logged on to the console");
        }
      }
      if (child == IntPtr.Zero && loggedOn && session != quitSession) Launch(session);
    }
  }

  void Kill(string reason) {
    if (child == IntPtr.Zero) return;
    Log("stopping the daemon: " + reason);
    Native.TerminateProcess(child, 1);
    Native.WaitForSingleObject(child, 10000);
    Native.CloseHandle(child);
    child = IntPtr.Zero;
  }

  void Launch(uint session) {
    IntPtr self, token;
    if (!Native.OpenProcessToken(Native.GetCurrentProcess(), Native.TOKEN_ALL_ACCESS, out self)) throw new Win32Exception();
    try {
      if (!Native.DuplicateTokenEx(self, Native.TOKEN_ALL_ACCESS, IntPtr.Zero, Native.SecurityImpersonation, Native.TokenPrimary, out token))
        throw new Win32Exception();
    } finally { Native.CloseHandle(self); }
    var sa = new Native.SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf(typeof(Native.SECURITY_ATTRIBUTES)), bInheritHandle = true };
    var log = Native.CreateFile(options.Log, Native.FILE_APPEND_DATA, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, ref sa, Native.OPEN_ALWAYS, 0, IntPtr.Zero);
    var nul = Native.CreateFile("NUL", Native.GENERIC_READ, Native.FILE_SHARE_READ | Native.FILE_SHARE_WRITE, ref sa, Native.OPEN_EXISTING, 0, IntPtr.Zero);
    try {
      // SYSTEM's own token moved into the console session: the daemon's driver can reach consent.exe's UAC prompt.
      if (!Native.SetTokenInformation(token, Native.TokenSessionId, ref session, 4)) throw new Win32Exception();
      var env = new StringBuilder();
      foreach (System.Collections.DictionaryEntry e in Environment.GetEnvironmentVariables()) {
        var key = (string)e.Key;
        if (key == "NODE_OPTIONS" || key == ServiceEnv || key == "AGENTCONNECT_COMPUTER_HOME") continue;
        env.Append(key).Append('=').Append(e.Value).Append('\0');
      }
      env.Append("AGENTCONNECT_COMPUTER_HOME=").Append(options.Home).Append('\0');
      env.Append(ServiceEnv).Append('=').Append(System.Reflection.Assembly.GetExecutingAssembly().Location).Append('\0');
      env.Append('\0');
      var si = new Native.STARTUPINFO {
        cb = Marshal.SizeOf(typeof(Native.STARTUPINFO)), lpDesktop = "winsta0\\default",
        dwFlags = Native.STARTF_USESTDHANDLES, hStdInput = nul, hStdOutput = log, hStdError = log
      };
      var cmd = new StringBuilder(Native.CommandLine(new[] { options.Node, options.Entry, "run" }));
      var block = Marshal.StringToHGlobalUni(env.ToString());
      Native.PROCESS_INFORMATION pi;
      try {
        if (!Native.CreateProcessAsUser(token, options.Node, cmd, IntPtr.Zero, IntPtr.Zero, true,
            Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_NO_WINDOW, block, options.Home, ref si, out pi))
          throw new Win32Exception();
      } finally { Marshal.FreeHGlobal(block); }
      Native.AssignProcessToJobObject(job, pi.hProcess);
      Native.CloseHandle(pi.hThread);
      child = pi.hProcess;
      childSession = session;
      Log("started the daemon (pid " + pi.dwProcessId + ") in session " + session);
    } finally {
      Native.CloseHandle(token);
      if (log != new IntPtr(-1)) Native.CloseHandle(log);
      if (nul != new IntPtr(-1)) Native.CloseHandle(nul);
    }
  }
}

static class RunAsUser {
  // `run-as-user [--detach] EXE [ARGS...]`: from the SYSTEM daemon, starts EXE as the person logged on to this session; it relays stdio and the exit code, or with --detach prints the pid.
  public static int Start(List<string> args) {
    bool detach = args.Count > 0 && args[0] == "--detach";
    if (detach) args.RemoveAt(0);
    if (args.Count == 0) { Console.Error.WriteLine("usage: run-as-user [--detach] EXE [ARGS...]"); return 2; }
    uint session;
    Native.ProcessIdToSessionId(Native.GetCurrentProcessId(), out session);
    IntPtr token, env;
    if (!Native.WTSQueryUserToken(session, out token)) {
      Console.Error.WriteLine("run-as-user: nobody is logged on to session " + session + " (" + new Win32Exception().Message + ")");
      return 3;
    }
    try {
      if (!Native.CreateEnvironmentBlock(out env, token, false)) throw new Win32Exception();
      var si = new Native.STARTUPINFO { cb = Marshal.SizeOf(typeof(Native.STARTUPINFO)), lpDesktop = "winsta0\\default" };
      if (!detach) {
        si.dwFlags = Native.STARTF_USESTDHANDLES;
        si.hStdInput = Native.GetStdHandle(Native.STD_INPUT_HANDLE);
        si.hStdOutput = Native.GetStdHandle(Native.STD_OUTPUT_HANDLE);
        si.hStdError = Native.GetStdHandle(Native.STD_ERROR_HANDLE);
      }
      var cmd = new StringBuilder(Native.CommandLine(args));
      Native.PROCESS_INFORMATION pi;
      // An app the person runs must outlive the daemon's job; the tray helper keeps relaying stdio and is waited for.
      uint flags = Native.CREATE_UNICODE_ENVIRONMENT | Native.CREATE_BREAKAWAY_FROM_JOB | (detach ? Native.CREATE_NEW_CONSOLE : Native.CREATE_NO_WINDOW);
      try {
        if (!Native.CreateProcessAsUser(token, null, cmd, IntPtr.Zero, IntPtr.Zero, !detach, flags, env,
            Environment.GetEnvironmentVariable("SystemDrive") + "\\", ref si, out pi))
          throw new Win32Exception();
      } finally { Native.DestroyEnvironmentBlock(env); }
      Native.CloseHandle(pi.hThread);
      if (detach) { Native.CloseHandle(pi.hProcess); Console.Out.WriteLine(pi.dwProcessId); return 0; }
      Native.WaitForSingleObject(pi.hProcess, Native.INFINITE);
      uint code;
      Native.GetExitCodeProcess(pi.hProcess, out code);
      Native.CloseHandle(pi.hProcess);
      return (int)code;
    } catch (Win32Exception e) {
      Console.Error.WriteLine("run-as-user: " + e.Message);
      return 4;
    } finally { Native.CloseHandle(token); }
  }
}

static class Program {
  static int Main(string[] args) {
    if (args.Length > 0 && args[0] == "run-as-user") {
      var rest = new List<string>(args);
      rest.RemoveAt(0);
      return RunAsUser.Start(rest);
    }
    ServiceBase.Run(new ComputerService(Options.Parse(args)));
    return 0;
  }
}
