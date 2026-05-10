using System.Collections.ObjectModel;
using System.IO;
using System.Windows;
using WpfMsg = System.Windows.MessageBox;
using WinFolder = System.Windows.Forms.FolderBrowserDialog;
using ZaloMask.Shell.Services;

namespace ZaloMask.Shell;

public partial class MainWindow : Window
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
        ReloadProfiles();
    }

    private void BtnPickRoot_OnClick(object sender, System.Windows.RoutedEventArgs e)
    {
        using var dlg = new WinFolder
        {
            Description = "Chọn thư mục chứa profiles (hoặc chọn chính thư mục profiles)",
            UseDescriptionForTitle = true,
            InitialDirectory = Directory.Exists(_profilesDir) ? Path.GetFullPath(Path.Combine(_profilesDir, "..")) : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        };
        if (dlg.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;

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
        ReloadProfiles();
    }

    private void BtnRefresh_OnClick(object sender, System.Windows.RoutedEventArgs e)
    {
        _profilesDir = DataPaths.ResolveProfilesDirectory();
        ProfilesPathBox.Text = _profilesDir;
        ReloadProfiles();
    }

    private void ReloadProfiles()
    {
        _rows.Clear();
        if (!Directory.Exists(_profilesDir))
        {
            WpfMsg.Show("Thư mục profiles không tồn tại:\n" + _profilesDir, "ZaloMask Shell",
                MessageBoxButton.OK, MessageBoxImage.Information);
            return;
        }

        foreach (var dir in Directory.EnumerateDirectories(_profilesDir))
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
                    var json = File.ReadAllText(metaPath);
                    display = ProfileMeta.ParseDisplayName(json);
                    mode = ProfileMeta.ParseLaunchMode(json);
                }
            }
            catch
            {
                display = "(meta lỗi)";
            }

            _rows.Add(new ProfileRow
            {
                FolderName = name,
                DisplayName = display,
                LaunchMode = mode,
            });
        }

        Title = $"ZaloMask Shell — Preview (.NET)  •  {_rows.Count} profile(s)";
    }
}
