using System.IO;
using System.Text;

namespace ZaloMask.Shell.Services;

/// <summary>
/// Cho phép bản native dùng cùng dữ liệu với Electron: profiles/ dưới userData packaged hoặc repo dev.
/// </summary>
public static class DataPaths
{
    /// <summary>File lưu đường dẫn profiles do user chọn (LocalApplicationData).</summary>
    public static readonly string ShellStateFile = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ZaloMask",
        "shell-preview",
        "profiles-path.txt");

    /// <summary>Giống Electron packaged: GET app.getPath('userData') ⇒ thường Roaming/ZaloMask.</summary>
    public static string ElectronStyleUserDataRoot()
    {
        var roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return Path.Combine(roaming, "ZaloMask");
    }

    public static bool TryResolveRepoRootFromEnv(out string repoRoot)
    {
        repoRoot = "";
        var env = Environment.GetEnvironmentVariable("ZALOMASK_REPO_ROOT");
        if (string.IsNullOrWhiteSpace(env)) return false;
        try
        {
            var p = Path.GetFullPath(env.Trim());
            if (Directory.Exists(p))
            {
                repoRoot = p;
                return true;
            }
        }
        catch { /* ignore invalid path chars */ }

        return false;
    }

    /// <returns>Đường dẫn tuyệt đối tới …/profiles</returns>
    public static string ResolveProfilesDirectory()
    {
        if (File.Exists(ShellStateFile))
        {
            try
            {
                var saved = File.ReadAllText(ShellStateFile).Trim().Trim('"');
                if (!string.IsNullOrEmpty(saved))
                {
                    var normalized = Path.GetFullPath(saved);
                    if (Directory.Exists(normalized)) return normalized;
                }
            }
            catch { /* ignore */ }
        }

        if (TryFindRepoAdjacentProfilesViaWalk(out var adjacent))
            return adjacent;

        if (TryResolveRepoRootFromEnv(out var repo))
            return Path.Combine(repo, "profiles");

        return Path.Combine(ElectronStyleUserDataRoot(), "profiles");
    }

    /// <summary>
    /// Khi debug <c>dotnet run</c> trong repo: đi ngược lên cây thư mục tìm <c>profiles/</c>
    /// có ít nhất một <c>meta.json</c> (tránh dính thư mục tên profiles ngẫu nhiên).
    /// </summary>
    internal static bool TryFindRepoAdjacentProfilesViaWalk(out string profilesDir)
    {
        profilesDir = "";
        try
        {
            var current = Path.GetFullPath(AppContext.BaseDirectory);
            for (var i = 0; i < 10 && !string.IsNullOrEmpty(current); i++)
            {
                var cand = Path.Combine(current, "profiles");
                if (LooksLikeZaloProfilesTree(cand))
                {
                    profilesDir = cand;
                    return true;
                }
                var parent = Directory.GetParent(current);
                current = parent?.FullName ?? "";
            }
        }
        catch { /* ignore */ }

        return false;
    }

    internal static bool LooksLikeZaloProfilesTree(string profilesPath)
    {
        try
        {
            if (!Directory.Exists(profilesPath)) return false;
            foreach (var sub in Directory.EnumerateDirectories(profilesPath))
            {
                if (File.Exists(Path.Combine(sub, "meta.json"))) return true;
            }
        }
        catch { /* ignore */ }

        return false;
    }

    public static void StoreCustomProfilesDirectory(string profilesDirFullPath)
    {
        var dir = Path.GetDirectoryName(ShellStateFile);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);
        File.WriteAllText(ShellStateFile, Path.GetFullPath(profilesDirFullPath), Encoding.UTF8);
    }
}
