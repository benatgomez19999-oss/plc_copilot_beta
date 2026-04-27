using PlcCopilot.TiaAgent.Core.Utils;

namespace PlcCopilot.TiaAgent.Core;

public sealed class CliOptions
{
    public required string ProjectPath { get; init; }
    public required string ArtifactsPath { get; init; }
    public required string OutPath { get; init; }
    public string? CopyCsvTo { get; init; }
    public bool Verbose { get; init; }

    public static string HelpText =>
        """
        plccopilot-tia-agent — MVP bridge between @plccopilot/codegen-siemens and TIA Portal V19.

        Usage:
          plccopilot-tia-agent --project <path.ap19> --artifacts <dir> --out <result.json>
                               [--copy-csv-to <dir>] [--verbose] [-h|--help]

        Options:
          --project       Path to an existing TIA Portal V19 project (.ap19).
          --artifacts     Directory containing generated artifacts (SCL / CSV / manifest.json).
          --out           Destination path for the agent's result.json.
          --copy-csv-to   Optional: copy CSV artifacts to this directory for manual import.
          --verbose, -v   Enable verbose logging.
          --help,    -h   Show this help.
        """;

    public static CliOptions Parse(string[] args)
    {
        string? project = null;
        string? artifacts = null;
        string? outPath = null;
        string? copyCsvTo = null;
        bool verbose = false;

        for (int i = 0; i < args.Length; i++)
        {
            string a = args[i];
            switch (a)
            {
                case "--project":
                    project = RequireValue(args, ref i, a);
                    break;
                case "--artifacts":
                    artifacts = RequireValue(args, ref i, a);
                    break;
                case "--out":
                    outPath = RequireValue(args, ref i, a);
                    break;
                case "--copy-csv-to":
                    copyCsvTo = RequireValue(args, ref i, a);
                    break;
                case "--verbose":
                case "-v":
                    verbose = true;
                    break;
                case "--help":
                case "-h":
                    throw new ArgumentException("help requested");
                default:
                    throw new ArgumentException($"unknown argument '{a}'");
            }
        }

        if (project is null) throw new ArgumentException("missing required --project");
        if (artifacts is null) throw new ArgumentException("missing required --artifacts");
        if (outPath is null) throw new ArgumentException("missing required --out");

        return new CliOptions
        {
            ProjectPath = PathUtils.Normalize(project),
            ArtifactsPath = PathUtils.Normalize(artifacts),
            OutPath = PathUtils.Normalize(outPath),
            CopyCsvTo = copyCsvTo is null ? null : PathUtils.Normalize(copyCsvTo),
            Verbose = verbose,
        };
    }

    private static string RequireValue(string[] args, ref int i, string flag)
    {
        if (i + 1 >= args.Length)
            throw new ArgumentException($"{flag} requires a value");
        return args[++i];
    }
}
