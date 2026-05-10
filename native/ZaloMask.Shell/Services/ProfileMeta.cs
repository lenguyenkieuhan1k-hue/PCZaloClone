using System.Text.Json;

namespace ZaloMask.Shell.Services;

public static class ProfileMeta
{
    public static string ParseDisplayName(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("displayName", out var dn) && dn.ValueKind == JsonValueKind.String)
                return dn.GetString() ?? "";
            return "";
        }
        catch
        {
            return "(meta không hợp lệ)";
        }
    }

    public static string ParseLaunchMode(string json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("launchMode", out var lm) && lm.ValueKind == JsonValueKind.String)
                return lm.GetString() ?? "";
            return "";
        }
        catch
        {
            return "";
        }
    }
}
