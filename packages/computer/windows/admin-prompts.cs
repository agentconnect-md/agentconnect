// Watches for UAC prompts on the secure desktop and answers them for the SYSTEM daemon (computer-use.md §4.2.1), one JSON object per line.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

static class AdminPrompts {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static readonly System.IO.StreamReader In = new System.IO.StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
  static readonly System.IO.StreamWriter Out = new System.IO.StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
  // UIA work on the secure desktop runs one operation at a time.
  static readonly object Work = new object();
  const string DialogClass = "Credential Dialog Xaml Host";
  const int PollMs = 250;

  // The prompt last reported: its window and id.
  static IntPtr shown = IntPtr.Zero;
  static string shownId;
  static string shownKind;
  static int sequence;

  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desk);
  [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr desk);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int len, out int needed);
  delegate bool EnumProc(IntPtr hwnd, IntPtr lp);
  [DllImport("user32.dll")] static extern bool EnumDesktopWindows(IntPtr desk, EnumProc proc, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);

  const uint GENERIC_ALL = 0x10000000;

  static void Send(Dictionary<string, object> message) {
    lock (Out) Out.WriteLine(Json.Serialize(message));
  }

  static string lastProblem;

  // Each problem is reported once, and an empty one when it clears.
  static void Problem(string text) {
    if (text == lastProblem) return;
    lastProblem = text;
    Send(new Dictionary<string, object> { { "event", "problem" }, { "message", text } });
  }

  static string DesktopName(IntPtr desk) {
    var sb = new StringBuilder(256); int n;
    return GetUserObjectInformation(desk, 2, sb, 512, out n) ? sb.ToString() : "";
  }

  // The consent.exe dialog on the input desktop, if one shows; zero otherwise.
  static IntPtr FindDialog(IntPtr desk) {
    var found = IntPtr.Zero;
    EnumDesktopWindows(desk, (h, lp) => {
      if (!IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      if (cls.ToString() != DialogClass) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      try {
        if (Process.GetProcessById((int)pid).ProcessName.Equals("consent", StringComparison.OrdinalIgnoreCase)) { found = h; return false; }
      } catch { }
      return true;
    }, IntPtr.Zero);
    return found;
  }

  // Runs work on a fresh thread attached to the input desktop: a thread that owns windows cannot switch desktops.
  static T OnInputDesktop<T>(Func<IntPtr, T> work) {
    T result = default(T);
    Exception failure = null;
    var thread = new Thread(() => {
      var desk = OpenInputDesktop(0, false, GENERIC_ALL);
      if (desk == IntPtr.Zero) { failure = new Exception("cannot open the input desktop (error " + Marshal.GetLastWin32Error() + "); the daemon must run as SYSTEM"); return; }
      try {
        if (!SetThreadDesktop(desk)) throw new Exception("cannot attach to the " + DesktopName(desk) + " desktop (error " + Marshal.GetLastWin32Error() + ")");
        result = work(desk);
      } catch (Exception e) { failure = e; }
      finally { CloseDesktop(desk); }
    });
    thread.Start();
    thread.Join();
    if (failure != null) throw failure;
    return result;
  }

  static AutomationElement ById(AutomationElement root, string id) {
    return root.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.AutomationIdProperty, id));
  }

  static void Invoke(AutomationElement element) {
    object pattern;
    if (!element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern)) throw new Exception("the " + element.Current.AutomationId + " control cannot be invoked");
    ((InvokePattern)pattern).Invoke();
  }

  // What the dialog asks, read through UI Automation once its details (the program's command line) are shown.
  static Dictionary<string, object> Read(IntPtr dialog) {
    var root = AutomationElement.FromHandle(dialog);
    var details = ById(root, "ShowHideDetails");
    if (details != null) {
      try { Invoke(details); Thread.Sleep(400); } catch { }
    }
    var lines = new List<string>();
    var texts = new List<KeyValuePair<string, string>>();
    var walker = TreeWalker.RawViewWalker;
    var credentials = false;
    Action<AutomationElement> walk = null;
    walk = (element) => {
      for (var child = walker.GetFirstChild(element); child != null; child = walker.GetNextSibling(child)) {
        var c = child.Current;
        if (c.ControlType == ControlType.Edit) credentials = true;
        if (c.ControlType == ControlType.Text || c.ControlType == ControlType.Image) texts.Add(new KeyValuePair<string, string>(c.ControlType == ControlType.Image ? "image" : "text", c.Name ?? ""));
        if (c.ControlType != ControlType.Button && c.ControlType != ControlType.Hyperlink) walk(child);
      }
    };
    walk(root);
    string app = null, publisher = null, command = null;
    for (var i = 0; i < texts.Count; i++) {
      var text = texts[i].Value.Trim();
      if (texts[i].Key == "text" && text.Length > 0) lines.Add(text);
      // The app's name follows its icon, and the publisher line follows the name.
      if (texts[i].Key == "image" && app == null) {
        for (var j = i + 1; j < texts.Count; j++) {
          var next = texts[j].Value.Trim();
          if (texts[j].Key != "text" || next.Length == 0) continue;
          if (app == null) { app = next; continue; }
          publisher = next;
          break;
        }
      }
      // "Program location: "C:\...\cmd.exe" /c ...", whatever the label's language.
      var colon = text.IndexOf(": ", StringComparison.Ordinal);
      if (command == null && colon > 0) {
        var value = text.Substring(colon + 2).Trim();
        if (value.StartsWith("\"") || (value.Length > 2 && value[1] == ':' && value[2] == '\\') || value.StartsWith("\\\\")) command = value;
      }
    }
    var prompt = new Dictionary<string, object> { { "event", "prompt" }, { "kind", credentials ? "credentials" : "consent" }, { "lines", lines } };
    if (app != null) prompt["app"] = app;
    if (publisher != null) prompt["publisher"] = publisher;
    if (command != null) prompt["command"] = command;
    return prompt;
  }

  static void Poll() {
    for (;;) {
      try {
        lock (Work) {
          var dialog = OnInputDesktop(desk => DesktopName(desk) == "Winlogon" ? FindDialog(desk) : IntPtr.Zero);
          Problem("");
          if (dialog != shown) {
            if (shownId != null) Send(new Dictionary<string, object> { { "event", "gone" }, { "id", shownId } });
            shown = dialog;
            shownId = null;
            shownKind = null;
            if (dialog != IntPtr.Zero) {
              var prompt = OnInputDesktop(desk => Read(dialog));
              shownId = (++sequence).ToString();
              shownKind = (string)prompt["kind"];
              prompt["id"] = shownId;
              Send(prompt);
            }
          }
        }
      } catch (Exception e) {
        // The secure desktop comes and goes: a failure mid-switch is retried on the next poll.
        if (e.Message.StartsWith("cannot open the input desktop")) Problem(e.Message);
      }
      Thread.Sleep(PollMs);
    }
  }

  static void Answer(string id, string answer) {
    var reply = new Dictionary<string, object> { { "event", "answered" }, { "id", id ?? "" }, { "answer", answer ?? "" } };
    try {
      lock (Work) {
        if (shownId == null || id != shownId || !IsWindow(shown)) throw new Exception("that administrator prompt is no longer showing");
        if (answer != "approve" && answer != "deny") throw new Exception("answer must be approve or deny");
        if (answer == "approve" && shownKind == "credentials") throw new Exception("this prompt asks for an administrator's password, so only a person at the computer can approve it");
        var dialog = shown;
        OnInputDesktop(desk => {
          var button = ById(AutomationElement.FromHandle(dialog), answer == "approve" ? "OkButton" : "CancelButton");
          if (button == null) throw new Exception("the prompt has no " + (answer == "approve" ? "Yes" : "No") + " button");
          Invoke(button);
          return true;
        });
      }
      reply["ok"] = true;
    } catch (Exception e) {
      reply["ok"] = false;
      reply["error"] = e.Message;
    }
    Send(reply);
  }

  [STAThread]
  static void Main() {
    new Thread(Poll) { IsBackground = true }.Start();
    string line;
    while ((line = In.ReadLine()) != null) {
      Dictionary<string, object> request;
      try { request = Json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
      if (request == null) continue;
      object id, answer;
      request.TryGetValue("id", out id);
      request.TryGetValue("answer", out answer);
      Answer(id as string, answer as string);
    }
    // The daemon closed stdin: it is stopping.
  }
}
