using PlcCopilot.TiaAgent.Core;
using PlcCopilot.TiaAgent.Core.Models;
using PlcCopilot.TiaAgent.Core.Services;
using PlcCopilot.TiaAgent.Core.Utils;
using PlcCopilot.TiaAgent.Services;

namespace PlcCopilot.TiaAgent;

public static class Program
{
    public static int Main(string[] args)
    {
        AssemblyResolver.Register();
        return Run(args);
    }

    private static int Run(string[] args)
    {
        if (args.Length == 0 || args.Any(a => a is "-h" or "--help"))
        {
            Console.WriteLine(CliOptions.HelpText);
            return args.Length == 0 ? 2 : 0;
        }

        CliOptions opts;
        try
        {
            opts = CliOptions.Parse(args);
        }
        catch (ArgumentException ex)
        {
            Console.Error.WriteLine($"[ERROR] invalid CLI: {ex.Message}");
            Console.Error.WriteLine();
            Console.Error.WriteLine(CliOptions.HelpText);
            return 2;
        }

        var log = new Logger(opts.Verbose);
        var result = new AgentResult
        {
            ProjectPath = opts.ProjectPath,
            ArtifactsPath = opts.ArtifactsPath,
        };

        int exitCode;
        try
        {
            if (AssemblyResolver.ResolvedPath() is null)
            {
                throw new AgentException(
                    AgentErrorCodes.OpennessAssemblyMissing,
                    "Siemens.Engineering.dll not found. Set TIA_OPENNESS_DLL or install TIA Portal V19 Openness.");
            }

            var scanner = new ArtifactScanner(log);
            ArtifactSet artifacts = scanner.Scan(opts.ArtifactsPath);
            log.Info(
                $"scanned {artifacts.SclFiles.Count} scl, {artifacts.CsvFiles.Count} csv, " +
                $"manifest={(artifacts.ManifestPath is null ? "no" : "yes")}");

            if (opts.CopyCsvTo is not null)
                CopyCsvArtifacts(artifacts, opts.CopyCsvTo, log);

            using var project = new TiaProjectService(log);
            project.Open(opts.ProjectPath);
            var plc = project.FindPrimaryPlcSoftware();

            new TiaImportService(log).ImportAll(plc, artifacts, result);
            new TiaCompileService(log).Compile(plc, result);

            project.Save();

            result.Ok = result.Compile?.Success == true && result.Error is null;
            exitCode = result.Ok ? 0 : 1;
        }
        catch (AgentException aex)
        {
            log.Error($"{aex.Code}: {aex.Message}");
            result.Error = new AgentError(aex.Code, aex.Message);
            result.Ok = false;
            exitCode = 1;
        }
        catch (Exception ex)
        {
            log.Error($"unexpected failure: {ex}");
            result.Error = new AgentError(AgentErrorCodes.Unexpected, ex.Message);
            result.Ok = false;
            exitCode = 1;
        }
        finally
        {
            try
            {
                ResultWriter.Write(opts.OutPath, result);
                log.Info($"wrote result to {opts.OutPath}");
            }
            catch (Exception ex)
            {
                log.Error($"failed to write result.json: {ex.Message}");
            }
        }

        return exitCode;
    }

    private static void CopyCsvArtifacts(ArtifactSet artifacts, string destDir, Logger log)
    {
        PathUtils.EnsureDirectory(destDir);
        foreach (var csv in artifacts.CsvFiles)
        {
            var target = Path.Combine(destDir, Path.GetFileName(csv));
            File.Copy(csv, target, overwrite: true);
            log.Info($"copied CSV -> {target}");
        }
    }
}
