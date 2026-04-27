using PlcCopilot.TiaAgent.Core;
using PlcCopilot.TiaAgent.Core.Models;
using PlcCopilot.TiaAgent.Core.Utils;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.ExternalSources;

namespace PlcCopilot.TiaAgent.Services;

/// <summary>
/// Imports generated artifacts into the PLC software.
///
/// MVP contract:
///   - .scl files  -> ExternalSource + GenerateBlocksFromSource (covers FBs / UDTs / DBs).
///   - .csv files  -> skipped (CSV import to PLC tag table requires a separate TIA service
///                    that is not modelled consistently across V18/V19 and is out of scope).
///   - manifest.json -> skipped (informational only).
/// </summary>
public sealed class TiaImportService
{
    private readonly Logger _log;

    public TiaImportService(Logger log) => _log = log;

    public void ImportAll(PlcSoftware plc, ArtifactSet artifacts, AgentResult result)
    {
        foreach (var scl in artifacts.SclFiles)
            ImportSclSource(plc, scl, result);

        foreach (var csv in artifacts.CsvFiles)
            result.Skipped.Add(new SkippedArtifact(
                Path.GetFileName(csv),
                "csv_import_not_implemented"));

        if (artifacts.ManifestPath is not null)
        {
            result.Skipped.Add(new SkippedArtifact(
                Path.GetFileName(artifacts.ManifestPath),
                "manifest_informational_only"));
        }
    }

    private void ImportSclSource(PlcSoftware plc, string sclPath, AgentResult result)
    {
        var fileName = Path.GetFileName(sclPath);
        var sourceName = Path.GetFileNameWithoutExtension(sclPath);

        try
        {
            RemoveExistingSource(plc.ExternalSourceGroup, sourceName);

            ExternalSource created = plc.ExternalSourceGroup.ExternalSources
                .CreateFromFile(sourceName, sclPath);

            created.GenerateBlocksFromSource();

            _log.Info($"imported SCL source: {sourceName}");
            result.Imported.Add(new ImportedArtifact(fileName, "scl", "imported"));
        }
        catch (Exception ex)
        {
            result.Imported.Add(new ImportedArtifact(fileName, "scl", "failed"));
            throw new AgentException(
                AgentErrorCodes.ImportFailed,
                $"failed to import SCL '{fileName}': {ex.Message}",
                ex);
        }
    }

    private static void RemoveExistingSource(ExternalSourceSystemGroup group, string sourceName)
    {
        ExternalSource? existing = null;
        foreach (var s in group.ExternalSources)
        {
            if (string.Equals(s.Name, sourceName, StringComparison.Ordinal))
            {
                existing = s;
                break;
            }
        }
        existing?.Delete();
    }
}
