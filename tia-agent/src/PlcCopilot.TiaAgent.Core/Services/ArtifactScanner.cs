using PlcCopilot.TiaAgent.Core.Models;
using PlcCopilot.TiaAgent.Core.Utils;

namespace PlcCopilot.TiaAgent.Core.Services;

public sealed class ArtifactScanner
{
    private readonly Logger _log;

    public ArtifactScanner(Logger log) => _log = log;

    public ArtifactSet Scan(string directory)
    {
        if (!Directory.Exists(directory))
        {
            throw new AgentException(
                AgentErrorCodes.ArtifactsNotFound,
                $"artifacts directory not found: {directory}");
        }

        var scls = new List<string>();
        var csvs = new List<string>();
        string? manifest = null;

        var all = Directory
            .EnumerateFiles(directory, "*", SearchOption.AllDirectories)
            .OrderBy(f => f, StringComparer.OrdinalIgnoreCase);

        foreach (var f in all)
        {
            var name = Path.GetFileName(f);
            if (f.EndsWith(".scl", StringComparison.OrdinalIgnoreCase))
                scls.Add(f);
            else if (f.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
                csvs.Add(f);
            else if (string.Equals(name, "manifest.json", StringComparison.OrdinalIgnoreCase))
                manifest = f;
            else
                _log.Debug($"scanner: ignoring unrecognised file {name}");
        }

        if (scls.Count == 0 && csvs.Count == 0 && manifest is null)
        {
            throw new AgentException(
                AgentErrorCodes.ArtifactsEmpty,
                $"no recognisable artifacts (scl/csv/manifest.json) in {directory}");
        }

        return new ArtifactSet(directory, scls, csvs, manifest);
    }
}
