using System.IO;

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

    /// <summary>Giống Electron packaged: GET app.getPath('userData') ⇒ thường Roaming/ZaloMask</summary>
    public static string ElectronStyleUserDataRoot()
    {
        var roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        return Path.Combine(roaming, "ZaloMask");
    }

    public static bool TryResolveRepoRootFromEnv(out string repoRoot)
    {
        repoRoot = "";
        var env = Environment.GetEnvironmentVariable("ZALOMASK_REPO_ROOT");
        if (!string.IsNullOrWhiteSpace(env))
        {
            var p = Path.GetFullPath(env.Trim());
            if (Directory.Exists(p))
            {
                repoRoot = p;
                return true;
            }
        }
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
                if (!string.IsNullOrEmpty(saved) && Directory.Exists(saved))
                    return Path.GetFullPath(saved);
            }
            catch { /* ignore */ }
        }

        if (TryResolveRepoRootFromEnv(out var repo))
            return Path.Combine(repo, "profiles");

        return Path.Combine(ElectronStyleUserDataRoot(), "profiles");
    }

    public static void StoreCustomProfilesDirectory(string profilesDirFullPath)
    {
        var dir = Path.GetDirectoryName(ShellStateFile);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);
        File.WriteAllText(ShellStateFile, Path.GetFullPath(profilesDirFullPath));
    }
}
