namespace PlcCopilot.TiaAgent.Core.Models;

public sealed record CompileIssue(
    string Severity,
    string Message,
    string? Object,
    int? Line);
