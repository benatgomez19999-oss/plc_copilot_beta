using System.Reflection;
using System.Runtime.Loader;

namespace PlcCopilot.TiaAgent;

/// <summary>
/// Redirects Siemens.Engineering loads to the installed TIA Portal V19 Openness DLL.
/// Must be registered before any code path that touches Siemens.Engineering types.
/// </summary>
internal static class AssemblyResolver
{
    private const string OpennessAssemblyName = "Siemens.Engineering";

    private static readonly string[] DefaultProbes =
    {
        @"C:\Program Files\Siemens\Automation\Portal V19\PublicAPI\V19\Siemens.Engineering.dll",
        @"C:\Program Files\Siemens\Automation\Portal V19\PublicAPI\V18\Siemens.Engineering.dll",
    };

    private static bool _registered;

    public static void Register()
    {
        if (_registered) return;
        _registered = true;

        AssemblyLoadContext.Default.Resolving += OnResolving;
    }

    private static Assembly? OnResolving(AssemblyLoadContext ctx, AssemblyName requested)
    {
        if (!string.Equals(requested.Name, OpennessAssemblyName, StringComparison.Ordinal))
            return null;

        foreach (var candidate in CandidatePaths())
        {
            if (File.Exists(candidate))
                return ctx.LoadFromAssemblyPath(candidate);
        }

        return null;
    }

    public static string? ResolvedPath()
    {
        foreach (var c in CandidatePaths())
            if (File.Exists(c)) return c;
        return null;
    }

    private static IEnumerable<string> CandidatePaths()
    {
        var fromEnv = Environment.GetEnvironmentVariable("TIA_OPENNESS_DLL");
        if (!string.IsNullOrWhiteSpace(fromEnv))
            yield return fromEnv!;

        foreach (var p in DefaultProbes)
            yield return p;
    }
}
