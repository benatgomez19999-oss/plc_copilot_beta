using PlcCopilot.TiaAgent.Core;
using PlcCopilot.TiaAgent.Core.Utils;
using Siemens.Engineering;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;

namespace PlcCopilot.TiaAgent.Services;

/// <summary>
/// Owns the TiaPortal + Project lifetime. Disposable — always wrap in <c>using</c>.
/// </summary>
public sealed class TiaProjectService : IDisposable
{
    private readonly Logger _log;
    private TiaPortal? _tia;
    private Project? _project;

    public TiaProjectService(Logger log) => _log = log;

    public Project Project =>
        _project ?? throw new InvalidOperationException("project not opened; call Open() first");

    public void Open(string projectPath)
    {
        var fi = new FileInfo(projectPath);
        if (!fi.Exists)
        {
            throw new AgentException(
                AgentErrorCodes.ProjectNotFound,
                $"TIA project file not found: {projectPath}");
        }

        if (!IsSupportedExtension(fi.Extension))
        {
            throw new AgentException(
                AgentErrorCodes.TiaVersionMismatch,
                $"unsupported project extension '{fi.Extension}' — this agent targets TIA Portal V19 (.ap19)");
        }

        try
        {
            _log.Info($"starting TIA Portal (headless)...");
            _tia = new TiaPortal(TiaPortalMode.WithoutUserInterface);

            _log.Info($"opening project: {fi.FullName}");
            _project = _tia.Projects.Open(fi);

            _log.Info($"project opened: {_project.Name}");
        }
        catch (AgentException)
        {
            throw;
        }
        catch (Exception ex)
        {
            throw new AgentException(
                AgentErrorCodes.ProjectOpenFailed,
                $"failed to open project: {ex.Message}",
                ex);
        }
    }

    public PlcSoftware FindPrimaryPlcSoftware()
    {
        var sw = FindInDevices(Project.Devices);
        if (sw is null)
        {
            throw new AgentException(
                AgentErrorCodes.PlcSoftwareNotFound,
                "no PlcSoftware container found in project devices");
        }
        _log.Info($"using PLC software: {sw.Name}");
        return sw;
    }

    public void Save()
    {
        if (_project is null) return;
        try
        {
            _project.Save();
            _log.Info("project saved");
        }
        catch (Exception ex)
        {
            _log.Warn($"project save failed (non-fatal): {ex.Message}");
        }
    }

    public void Dispose()
    {
        try { _project?.Close(); }
        catch (Exception ex) { _log.Warn($"project close failed: {ex.Message}"); }

        try { _tia?.Dispose(); }
        catch (Exception ex) { _log.Warn($"tia dispose failed: {ex.Message}"); }
    }

    private static bool IsSupportedExtension(string ext) =>
        string.Equals(ext, ".ap19", StringComparison.OrdinalIgnoreCase);

    private static PlcSoftware? FindInDevices(DeviceComposition devices)
    {
        foreach (Device d in devices)
        {
            var sw = FindInDeviceItems(d.DeviceItems);
            if (sw is not null) return sw;
        }
        return null;
    }

    private static PlcSoftware? FindInDeviceItems(DeviceItemComposition items)
    {
        foreach (DeviceItem it in items)
        {
            var container = it.GetService<SoftwareContainer>();
            if (container?.Software is PlcSoftware plc) return plc;

            var nested = FindInDeviceItems(it.DeviceItems);
            if (nested is not null) return nested;
        }
        return null;
    }
}
