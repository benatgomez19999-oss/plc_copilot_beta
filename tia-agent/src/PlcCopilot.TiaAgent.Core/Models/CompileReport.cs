namespace PlcCopilot.TiaAgent.Core.Models;

public sealed class CompileReport
{
    public bool Success { get; set; }
    public string State { get; set; } = "unknown";
    public List<CompileIssue> Issues { get; set; } = new();
}
