using PlcCopilot.TiaAgent.Core;
using PlcCopilot.TiaAgent.Core.Models;
using PlcCopilot.TiaAgent.Core.Utils;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.SW;

namespace PlcCopilot.TiaAgent.Services;

public sealed class TiaCompileService
{
    private readonly Logger _log;

    public TiaCompileService(Logger log) => _log = log;

    public void Compile(PlcSoftware plc, AgentResult result)
    {
        var compilable = plc.GetService<ICompilable>();
        if (compilable is null)
        {
            throw new AgentException(
                AgentErrorCodes.CompileNotAvailable,
                "PlcSoftware does not expose ICompilable — cannot compile");
        }

        CompilerResult cr;
        try
        {
            _log.Info("compiling PLC software...");
            cr = compilable.Compile();
        }
        catch (Exception ex)
        {
            throw new AgentException(
                AgentErrorCodes.CompileFailed,
                $"compilation invocation threw: {ex.Message}",
                ex);
        }

        var report = new CompileReport
        {
            State = cr.State.ToString().ToLowerInvariant(),
        };

        FlattenMessages(cr.Messages, report.Issues, parentPath: null);

        bool hasError = cr.State == CompilerResultState.Error
                        || report.Issues.Any(i => i.Severity == "error");

        report.Success = !hasError;
        result.Compile = report;

        _log.Info(
            $"compile finished: state={report.State} success={report.Success} issues={report.Issues.Count}");
    }

    private static void FlattenMessages(
        CompilerResultMessageComposition msgs,
        List<CompileIssue> sink,
        string? parentPath)
    {
        foreach (CompilerResultMessage m in msgs)
        {
            string? obj = Combine(parentPath, m.Path);
            sink.Add(new CompileIssue(
                Severity: m.State.ToString().ToLowerInvariant(),
                Message: m.Description ?? "",
                Object: string.IsNullOrWhiteSpace(obj) ? null : obj,
                Line: null));

            FlattenMessages(m.Messages, sink, obj);
        }
    }

    private static string? Combine(string? parent, string? child)
    {
        if (string.IsNullOrWhiteSpace(parent)) return child;
        if (string.IsNullOrWhiteSpace(child)) return parent;
        return $"{parent}/{child}";
    }
}
