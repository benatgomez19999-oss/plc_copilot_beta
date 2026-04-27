namespace PlcCopilot.TiaAgent.Core.Models;

public sealed class AgentResult
{
    public bool Ok { get; set; }
    public string ProjectPath { get; set; } = "";
    public string ArtifactsPath { get; set; } = "";
    public string AgentVersion { get; set; } = "0.1.0";
    public string GeneratedAt { get; set; } = DateTime.UtcNow.ToString("O");

    public List<ImportedArtifact> Imported { get; set; } = new();
    public List<SkippedArtifact> Skipped { get; set; } = new();
    public CompileReport? Compile { get; set; }
    public AgentError? Error { get; set; }
}
