using System.Collections.ObjectModel;
using System.Globalization;
using System.IO;
using System.Text;
using System.Windows;
using System.Windows.Forms;
using WpfMsg = System.Windows.MessageBox;
using WinFolder = System.Windows.Forms.FolderBrowserDialog;
using ZaloMask.Shell.Services;

namespace ZaloMask.Shell;

public partial class MainWindow : System.Windows.Window
{
    private string _profilesDir = "";

    private sealed class ProfileRow
    {
        public string FolderName { get; init; } = "";
        public string DisplayName { get; init; } = "";
        public string LaunchMode { get; init; } = "";
    }

    private readonly ObservableCollection<ProfileRow> _rows = new();

    public MainWindow()
    {
        InitializeComponent();
        ProfileList.ItemsSource = _rows;
        _profilesDir = DataPaths.ResolveProfilesDirectory();
        ProfilesPathBox.Text = _profilesDir;
        ReloadProfiles(showMissingPathDialog: false);
    }

    private static string SafeFolderBrowserInitialPath(string profilesDir)
    {
        try
        {
            if (!string.IsNullOrWhiteSpace(profilesDir))
            {
                var full = Path.GetFullPath(profilesDir.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar));
                if (Directory.Exists(full)) return full;
                var parent = Directory.GetParent(full)?.FullName;
                if (!string.IsNullOrEmpty(parent) && Directory.Exists(parent)) return parent;
            }
        }
        catch { /* ignore */ }

        return Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    }

    private void BtnPickRoot_OnClick(object sender, RoutedEventArgs e)
    {
        using var dlg = new WinFolder
        {
            Description = "Chọn thư mục chứa profiles (hoặc chọn chính thư mục profiles)",
            UseDescriptionForTitle = true,
            InitialDirectory = SafeFolderBrowserInitialPath(_profilesDir),
        };
        if (dlg.ShowDialog() != DialogResult.OK) return;

        var picked = dlg.SelectedPath.Trim();
        if (string.IsNullOrEmpty(picked)) return;

        if (Path.GetFileName(picked.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
                .Equals("profiles", StringComparison.OrdinalIgnoreCase))
            _profilesDir = picked;
        else if (Directory.Exists(Path.Combine(picked, "profiles")))
            _profilesDir = Path.Combine(picked, "profiles");
        else
        {
            WpfMsg.Show("Không thấy thư mục con 'profiles'. Chọn đúng thư mục profiles hoặc thư mục gốc repo.", "ZaloMask Shell",
                MessageBoxButton.OK, MessageBoxImage.Warning);
            return;
        }

        DataPaths.StoreCustomProfilesDirectory(_profilesDir);
        ProfilesPathBox.Text = _profilesDir;
        ReloadProfiles(showMissingPathDialog: false);
        if (!Directory.Exists(_profilesDir))
        {
            WpfMsg.Show("Đường dẫn profiles không khả dụng sau khi chọn.", "ZaloMask Shell",
                MessageBoxButton.OK, MessageBoxImage.Warning);
        }
    }

    private void BtnRefresh_OnClick(object sender, RoutedEventArgs e)
    {
        _profilesDir = DataPaths.ResolveProfilesDirectory();
        ProfilesPathBox.Text = _profilesDir;
        ReloadProfiles(showMissingPathDialog: true);
    }

    /// <summary>Đọc profile; chỉ báo popup khi thiếu thư mục nếu user bấm Làm mới (showMissingPathDialog).</summary>
    private void ReloadProfiles(bool showMissingPathDialog)
    {
        _rows.Clear();
        ProfileStatusHint.Text =
            $"Đường dẫn: {_profilesDir}\nĐọc thư mục con + meta.json (displayName, launchMode).\nĐang làm rỗng danh sách…";

        if (!Directory.Exists(_profilesDir))
        {
            ProfileStatusHint.Foreground = System.Windows.Media.Brushes.Firebrick;
            ProfileStatusHint.Text =
                $"Thư mục profiles chưa tồn tại:\n{_profilesDir}\n\n→ Bấm «Chọn gốc dữ liệu…» hoặc đặt ZALOMASK_REPO_ROOT.";
            Title = "ZaloMask Shell — Preview (.NET) • 0 profile";
            if (showMissingPathDialog)
            {
                WpfMsg.Show("Thư mục profiles không tồn tại:\n" + _profilesDir, "ZaloMask Shell",
                    MessageBoxButton.OK, MessageBoxImage.Information);
            }
            return;
        }

        ProfileStatusHint.Foreground = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromRgb(0x66, 0x66, 0x66));

        IEnumerable<string> dirs;
        try
        {
            dirs = Directory.GetDirectories(_profilesDir)
                .OrderBy(p => Path.GetFileName(p), StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception ex)
        {
            ProfileStatusHint.Foreground = System.Windows.Media.Brushes.Firebrick;
            ProfileStatusHint.Text = "Không đọc được thư mục profiles:\n" + ex.Message;
            if (showMissingPathDialog)
            {
                WpfMsg.Show(ProfileStatusHint.Text, "ZaloMask Shell", MessageBoxButton.OK, MessageBoxImage.Warning);
            }
            return;
        }

        foreach (var dir in dirs)
        {
            var name = Path.GetFileName(dir);
            if (string.IsNullOrWhiteSpace(name)) continue;

            var metaPath = Path.Combine(dir, "meta.json");
            var display = "(chưa đọc meta)";
            var mode = "";

            try
            {
                if (File.Exists(metaPath))
                {
                    var json = File.ReadAllText(metaPath, Encoding.UTF8);
                    display = ProfileMeta.ParseDisplayName(json);
                    mode = ProfileMeta.ParseLaunchMode(json);
                }
            }
            catch
            {
                display = "(meta lỗi)";
            }

            if (string.IsNullOrWhiteSpace(display) || display == "(meta không hợp lệ)") display = name;

            _rows.Add(new ProfileRow
            {
                FolderName = name,
                DisplayName = display,
                LaunchMode = mode,
            });
        }

        ProfileStatusHint.Text =
            $"Được {_rows.Count} profile — {DateTime.Now.ToString("HH:mm:ss", CultureInfo.CurrentCulture)}";
        Title = $"ZaloMask Shell — Preview (.NET) • {_rows.Count} profile";
    }
}
