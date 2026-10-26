// The Windows taskbar indicator (computer-use.md §6), macos/menubar.swift's protocol: draws the menu from stdin, reports clicks on stdout.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class TrayApp : ApplicationContext {
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  // A windowless process has no console to set encodings on, so the pipes are opened as UTF-8 directly.
  static readonly System.IO.StreamReader In = new System.IO.StreamReader(Console.OpenStandardInput(), new System.Text.UTF8Encoding(false));
  static readonly System.IO.StreamWriter Out = new System.IO.StreamWriter(Console.OpenStandardOutput(), new System.Text.UTF8Encoding(false)) { AutoFlush = true };
  readonly NotifyIcon icon = new NotifyIcon();
  readonly ContextMenuStrip menu = new ContextMenuStrip();
  readonly Control ui = new Control();
  readonly int size = SystemInformation.SmallIconSize.Width;
  string tone = "";

  public TrayApp() {
    ui.CreateControl();
    menu.Renderer = new MarkRenderer();
    menu.ShowCheckMargin = true;
    menu.ShowImageMargin = true;
    menu.Opening += (s, e) => Send("menu-open", null);
    icon.ContextMenuStrip = menu;
    icon.Text = "AgentConnect Computer";
    SetTone("unavailable", null);
    // Windows opens a tray menu on right-click only; a left-click shows the same menu.
    icon.MouseUp += (s, e) => {
      if (e.Button != MouseButtons.Left) return;
      var show = typeof(NotifyIcon).GetMethod("ShowContextMenu", BindingFlags.Instance | BindingFlags.NonPublic);
      if (show != null) show.Invoke(icon, null);
    };
    icon.Visible = true;
    new Thread(Read) { IsBackground = true }.Start();
  }

  void Read() {
    string line;
    while ((line = In.ReadLine()) != null) {
      Dictionary<string, object> update;
      try { update = Json.Deserialize<Dictionary<string, object>>(line); } catch { continue; }
      object m;
      if (update != null && update.TryGetValue("menu", out m)) {
        var next = m as Dictionary<string, object>;
        if (next != null) ui.BeginInvoke(new Action(() => Apply(next)));
      }
    }
    // The daemon closed stdin: it is stopping, so the icon goes too.
    ui.BeginInvoke(new Action(Quit));
  }

  void Quit() {
    icon.Visible = false;
    icon.Dispose();
    ExitThread();
  }

  static void Send(string action, string id) {
    var message = new Dictionary<string, string> { { "action", action } };
    if (id != null) message["id"] = id;
    lock (Out) Out.WriteLine(Json.Serialize(message));
  }

  static string Str(Dictionary<string, object> d, string key) {
    object v;
    return d.TryGetValue(key, out v) ? v as string : null;
  }

  static bool Flag(Dictionary<string, object> d, string key, bool fallback) {
    object v;
    return d.TryGetValue(key, out v) && v is bool ? (bool)v : fallback;
  }

  void Apply(Dictionary<string, object> next) {
    SetTone(Str(next, "tone") ?? "unavailable", Str(next, "badge"));
    var tooltip = Str(next, "tooltip") ?? "AgentConnect Computer";
    // NotifyIcon.Text throws past 63 characters.
    icon.Text = tooltip.Length > 63 ? tooltip.Substring(0, 62) + "…" : tooltip;
    menu.SuspendLayout();
    menu.Items.Clear();
    object raw;
    var items = next.TryGetValue("items", out raw) ? raw as ArrayList : null;
    foreach (var entry in items ?? new ArrayList()) {
      var row = Build(entry as Dictionary<string, object>);
      if (row != null) menu.Items.Add(row);
    }
    menu.ResumeLayout();
  }

  // One row, with its submenu when it has one.
  ToolStripItem Build(Dictionary<string, object> item) {
    if (item == null) return null;
    if (Flag(item, "separator", false)) return new ToolStripSeparator();
    var id = Str(item, "id");
    object raw;
    var children = item.TryGetValue("items", out raw) ? raw as ArrayList : null;
    var row = new ToolStripMenuItem(Str(item, "title") ?? "") {
      Checked = Flag(item, "checked", false),
      Enabled = (id != null || children != null) && Flag(item, "enabled", true)
    };
    var mark = Str(item, "mark");
    if (mark != null) row.Image = MarkImage(mark);
    if (children != null) {
      row.DropDown.Renderer = menu.Renderer;
      foreach (var child in children) {
        var built = Build(child as Dictionary<string, object>);
        if (built != null) row.DropDownItems.Add(built);
      }
    }
    object confirm;
    item.TryGetValue("confirm", out confirm);
    var ask = confirm as Dictionary<string, object>;
    if (id != null) row.Click += (s, e) => {
      if (ask != null && !Confirm(Str(ask, "title"), Str(ask, "message"), Str(ask, "button"))) return;
      Send("click", id);
    };
    return row;
  }

  static bool Confirm(string title, string message, string button) {
    using (var form = new Form {
      Text = title ?? "AgentConnect Computer", FormBorderStyle = FormBorderStyle.FixedDialog, StartPosition = FormStartPosition.CenterScreen,
      MaximizeBox = false, MinimizeBox = false, ShowInTaskbar = true, TopMost = true, AutoSize = true,
      AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(16), Font = SystemFonts.MessageBoxFont
    }) {
      var layout = new TableLayoutPanel { AutoSize = true, ColumnCount = 1, Dock = DockStyle.Fill };
      layout.Controls.Add(new Label { Text = message ?? "", AutoSize = true, MinimumSize = new Size(360, 0), MaximumSize = new Size(420, 0), Margin = new Padding(0, 0, 0, 16) });
      var buttons = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.RightToLeft, Dock = DockStyle.Fill };
      var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, AutoSize = true };
      var ok = new Button { Text = button ?? "OK", DialogResult = DialogResult.OK, AutoSize = true };
      buttons.Controls.Add(cancel);
      buttons.Controls.Add(ok);
      layout.Controls.Add(buttons);
      form.Controls.Add(layout);
      form.AcceptButton = ok;
      form.CancelButton = cancel;
      return form.ShowDialog() == DialogResult.OK;
    }
  }

  void SetTone(string next, string badge) {
    var key = next + "/" + badge;
    if (key == tone) return;
    tone = key;
    var old = icon.Icon;
    using (var bitmap = Mark(next, badge, size)) icon.Icon = Icon.FromHandle(bitmap.GetHicon());
    if (old != null) { DestroyIcon(old.Handle); old.Dispose(); }
  }

  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

  // The AgentConnect mark (packages/web/src/app/icon.svg), greyed without authority, with the daemon's badge as macos/menubar.swift draws it.
  static Bitmap Mark(string tone, string badgeName, int px) {
    var bitmap = new Bitmap(px, px);
    using (var g = Graphics.FromImage(bitmap)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.ScaleTransform(px / 18f, px / 18f);
      var quadrants = new[] {
        new { a = new PointF(9, 1), b = new PointF(17, 9), c = Color.FromArgb(242, 198, 74) },
        new { a = new PointF(17, 9), b = new PointF(9, 17), c = Color.FromArgb(244, 121, 58) },
        new { a = new PointF(9, 17), b = new PointF(1, 9), c = Color.FromArgb(124, 60, 162) },
        new { a = new PointF(1, 9), b = new PointF(9, 1), c = Color.FromArgb(216, 63, 150) }
      };
      foreach (var q in quadrants)
        using (var brush = new SolidBrush(tone == "unavailable" ? Color.Gray : q.c))
          g.FillPolygon(brush, new[] { q.a, q.b, new PointF(9, 9) });
      Color? badge = badgeName == "busy" ? Color.FromArgb(255, 149, 0) : badgeName == "paused" ? Color.FromArgb(142, 142, 147) : badgeName == "error" ? Color.FromArgb(255, 59, 48) : (Color?)null;
      if (badge.HasValue) {
        // A transparent ring cuts the badge out of the mark, readable on light and dark taskbars.
        g.CompositingMode = CompositingMode.SourceCopy;
        using (var clear = new SolidBrush(Color.Transparent)) g.FillEllipse(clear, 8.5f, 8.5f, 10, 10);
        g.CompositingMode = CompositingMode.SourceOver;
        using (var brush = new SolidBrush(badge.Value)) g.FillEllipse(brush, 10, 10, 8, 8);
        if (badgeName == "paused") {
          g.FillRectangle(Brushes.White, 12.3f, 11.9f, 1.2f, 4.2f);
          g.FillRectangle(Brushes.White, 14.5f, 11.9f, 1.2f, 4.2f);
        } else if (badgeName == "error") {
          g.FillRectangle(Brushes.White, 13.4f, 11.4f, 1.2f, 3.3f);
          g.FillRectangle(Brushes.White, 13.4f, 15.3f, 1.2f, 1.2f);
        }
      }
    }
    return bitmap;
  }

  static Image MarkImage(string mark) {
    int px = SystemInformation.SmallIconSize.Width;
    var bitmap = new Bitmap(px, px);
    using (var g = Graphics.FromImage(bitmap)) {
      g.SmoothingMode = SmoothingMode.AntiAlias;
      g.ScaleTransform(px / 16f, px / 16f);
      using (var white = new Pen(Color.White, 1.8f) { StartCap = LineCap.Round, EndCap = LineCap.Round }) {
        switch (mark) {
          case "ok":
            using (var b = new SolidBrush(Color.FromArgb(52, 199, 89))) g.FillEllipse(b, 1, 1, 14, 14);
            g.DrawLines(white, new[] { new PointF(4.5f, 8.2f), new PointF(7, 10.7f), new PointF(11.5f, 5.5f) });
            break;
          case "fail":
            using (var b = new SolidBrush(Color.FromArgb(255, 59, 48))) g.FillEllipse(b, 1, 1, 14, 14);
            g.DrawLine(white, 5.2f, 5.2f, 10.8f, 10.8f);
            g.DrawLine(white, 10.8f, 5.2f, 5.2f, 10.8f);
            break;
          case "warn":
            using (var b = new SolidBrush(Color.FromArgb(255, 149, 0))) g.FillPolygon(b, new[] { new PointF(8, 1.5f), new PointF(15, 14.5f), new PointF(1, 14.5f) });
            g.DrawLine(white, 8, 6, 8, 9.8f);
            g.DrawLine(white, 8, 12.3f, 8, 12.4f);
            break;
          default:
            using (var p = new Pen(Color.Gray, 1.8f)) g.DrawArc(p, 2.5f, 2.5f, 11, 11, 30, 300);
            break;
        }
      }
    }
    return bitmap;
  }
}

// Status rows are disabled but keep their colored marks, as in the macOS menu.
class MarkRenderer : ToolStripProfessionalRenderer {
  protected override void OnRenderItemImage(ToolStripItemImageRenderEventArgs e) {
    if (e.Image != null && !e.Item.Enabled) e.Graphics.DrawImage(e.Image, e.ImageRectangle);
    else base.OnRenderItemImage(e);
  }
}

static class Program {
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

  [STAThread]
  static void Main() {
    SetProcessDPIAware();
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Application.Run(new TrayApp());
  }
}
