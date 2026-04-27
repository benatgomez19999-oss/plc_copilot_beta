namespace PlcCopilot.TiaAgent.Core.Models;

public sealed class ArtifactSet
{
    public string Root { get; }
    public IReadOnlyList<string> SclFiles { get; }
    public IReadOnlyList<string> CsvFiles { get; }
    public string? ManifestPath { get; }

    public ArtifactSet(
        string root,
        IReadOnlyList<string> sclFiles,
        IReadOnlyList<string> csvFiles,
        string? manifestPath)
    {
        Root = root;
        SclFiles = sclFiles;
        CsvFiles = csvFiles;
        ManifestPath = manifestPath;
    }

    public int Count => SclFiles.Count + CsvFiles.Count + (ManifestPath is null ? 0 : 1);
}
