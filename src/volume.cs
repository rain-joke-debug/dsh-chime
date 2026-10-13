// dsh-chime volume - a one-window volume control for the chime player.
//
// Drag the slider, let go, and it plays the current chime at the new level.
// Save writes volume.txt next to impl.js, which the plugin re-reads before every
// chime, so the new level applies to the very next sound with no DSH restart.
//
// It only touches volume.txt. It never edits the profile patch, so a saved
// volume always beats the config value and nothing else changes.
//
// Layout note: tools/app.manifest declares this process DPI-aware, so Windows
// stops bitmap-stretching the window and the pixel bounds below become ours to
// scale. Fonts are given in points and already follow the display DPI; only the
// layout needs help, which is what UiScale/Px do. AutoScaleMode.Dpi was tried
// first and silently did nothing here, leaving the buttons too small for their
// own labels on a 150% display.
//
// C# 5 only: this is compiled by the csc.exe that ships with Windows.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Windows.Forms;

internal sealed class VolumeForm : Form
{
    private const int DefaultVolume = 100;
    private const int MaxVolume = 200;
    private const int LoudVolume = 130;

    private readonly string chimeExe;
    private readonly string volumeFile;
    private readonly bool hasPlayer;
    private readonly float uiScale;

    private readonly Label value = new Label();
    private readonly Label hint = new Label();
    private readonly TrackBar slider = new TrackBar();
    private readonly Button preview = new Button();
    private readonly Button save = new Button();
    private readonly Button cancel = new Button();
    private readonly Timer settle = new Timer();

    public VolumeForm()
    {
        string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
        string pluginDir = Path.GetDirectoryName(exeDir);
        chimeExe = Path.Combine(exeDir, "chime.exe");
        volumeFile = Path.Combine(pluginDir, "volume.txt");
        hasPlayer = File.Exists(chimeExe);
        uiScale = DetectScale();

        Text = "dsh-chime 音量";
        Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular, GraphicsUnit.Point);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        ShowIcon = false;
        StartPosition = FormStartPosition.CenterScreen;
        AutoScaleMode = AutoScaleMode.None;
        ClientSize = new Size(Px(400), Px(202));

        Label title = new Label();
        title.Text = "拖动滑块调音量，停手后会试听一次";
        title.SetBounds(Px(16), Px(12), Px(368), Px(18));
        title.ForeColor = Color.FromArgb(95, 95, 95);

        value.SetBounds(Px(16), Px(32), Px(368), Px(42));
        value.TextAlign = ContentAlignment.MiddleCenter;
        value.Font = new Font(Font.FontFamily, 20F, FontStyle.Bold);

        slider.SetBounds(Px(16), Px(78), Px(368), Px(45));
        slider.Minimum = 0;
        slider.Maximum = MaxVolume;
        slider.TickFrequency = 25;
        slider.SmallChange = 5;
        slider.LargeChange = 10;
        slider.Value = ReadVolume(volumeFile);

        preview.Text = "试听";
        preview.SetBounds(Px(16), Px(130), Px(100), Px(30));
        preview.Enabled = hasPlayer;

        save.Text = "保存";
        save.SetBounds(Px(188), Px(130), Px(100), Px(30));
        cancel.Text = "取消";
        cancel.SetBounds(Px(296), Px(130), Px(88), Px(30));

        hint.SetBounds(Px(16), Px(168), Px(368), Px(20));
        hint.ForeColor = Color.FromArgb(125, 125, 125);

        Controls.Add(title);
        Controls.Add(value);
        Controls.Add(slider);
        Controls.Add(preview);
        Controls.Add(save);
        Controls.Add(cancel);
        Controls.Add(hint);

        AcceptButton = save;
        CancelButton = cancel;

        settle.Interval = 450;
        settle.Tick += delegate { settle.Stop(); PlayPreview(); };
        slider.ValueChanged += delegate
        {
            Render();
            settle.Stop();
            if (hasPlayer) settle.Start();
        };
        preview.Click += delegate { PlayPreview(); };
        save.Click += delegate { Save(); };
        cancel.Click += delegate { Close(); };

        Render();
    }

    // One design pixel, in real pixels.
    private int Px(int design)
    {
        return (int)Math.Round(design * uiScale);
    }

    // System DPI, not per-monitor: the manifest asks for the system-aware mode,
    // so this is the ratio Windows would otherwise have stretched us by.
    private static float DetectScale()
    {
        float scale = 1f;
        try
        {
            using (Graphics screen = Graphics.FromHwnd(IntPtr.Zero))
            {
                scale = screen.DpiX / 96f;
            }
        }
        catch
        {
            // Any doubt: draw at 100% rather than at a guessed size.
        }
        if (scale < 1f) scale = 1f;
        if (scale > 4f) scale = 4f;
        return scale;
    }

    // The number is the whole point of the window, so it gets the big font.
    private void Render()
    {
        int current = slider.Value;
        value.Text = current.ToString(CultureInfo.InvariantCulture) + " %";
        if (current == 0) value.ForeColor = Color.FromArgb(155, 155, 155);
        else if (current > LoudVolume) value.ForeColor = Color.FromArgb(200, 85, 0);
        else value.ForeColor = Color.FromArgb(25, 25, 25);

        if (!hasPlayer) hint.Text = "找不到 chime.exe，只能保存";
        else if (current > LoudVolume) hint.Text = "超过 " + LoudVolume + "% 时最大声的地方会削顶";
        else if (File.Exists(volumeFile)) hint.Text = "volume.txt = " + current.ToString(CultureInfo.InvariantCulture);
        else hint.Text = "保存后下一声立刻生效，不用重启 DSH";
    }

    private void PlayPreview()
    {
        if (!hasPlayer) return;
        try
        {
            ProcessStartInfo info = new ProcessStartInfo(
                chimeExe, "ding " + slider.Value.ToString(CultureInfo.InvariantCulture));
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            Process.Start(info);
        }
        catch
        {
            // No audio device: the slider still saves.
        }
    }

    private void Save()
    {
        try
        {
            File.WriteAllText(
                volumeFile, slider.Value.ToString(CultureInfo.InvariantCulture) + Environment.NewLine);
            DialogResult = DialogResult.OK;
            Close();
        }
        catch (Exception error)
        {
            MessageBox.Show(
                this,
                "写不了 volume.txt：" + Environment.NewLine + error.Message,
                "dsh-chime",
                MessageBoxButtons.OK,
                MessageBoxIcon.Warning);
        }
    }

    // Same rules as impl.js: blanks and # comments are skipped, 0-200, and a
    // missing or broken file means the config default is still in charge.
    private static int ReadVolume(string path)
    {
        try
        {
            if (!File.Exists(path)) return DefaultVolume;
            string[] lines = File.ReadAllLines(path);
            for (int i = 0; i < lines.Length; i++)
            {
                string text = lines[i].Trim();
                if (text.Length == 0 || text.StartsWith("#")) continue;
                if (text.EndsWith("%")) text = text.Substring(0, text.Length - 1).Trim();
                double parsed;
                if (!double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed))
                {
                    continue;
                }
                if (parsed < 0) parsed = 0;
                if (parsed > MaxVolume) parsed = MaxVolume;
                return (int)Math.Round(parsed);
            }
        }
        catch
        {
            // Fall through to the default.
        }
        return DefaultVolume;
    }
}

internal static class VolumeApp
{
    [STAThread]
    private static void Main()
    {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new VolumeForm());
    }
}
