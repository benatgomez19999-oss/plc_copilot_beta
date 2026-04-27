namespace PlcCopilot.TiaAgent.Core.Utils;

public static class PathUtils
{
    public static string Normalize(string path)
    {
        string trimmed = path.Trim().Trim('"');
        return Path.GetFullPath(trimmed);
    }

    public static void EnsureDirectory(string path)
    {
        if (!Directory.Exists(path))
            Directory.CreateDirectory(path);
    }
}
