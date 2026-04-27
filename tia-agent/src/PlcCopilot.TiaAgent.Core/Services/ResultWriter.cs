using System.Text.Json;
using System.Text.Json.Serialization;
using PlcCopilot.TiaAgent.Core.Models;
using PlcCopilot.TiaAgent.Core.Utils;

namespace PlcCopilot.TiaAgent.Core.Services;

public static class ResultWriter
{
    public static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
        DictionaryKeyPolicy = JsonNamingPolicy.SnakeCaseLower,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    public static string Serialize(AgentResult result) =>
        JsonSerializer.Serialize(result, Options);

    public static void Write(string path, AgentResult result)
    {
        string? dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
            PathUtils.EnsureDirectory(dir);

        string json = Serialize(result);
        File.WriteAllText(path, json);
    }
}
