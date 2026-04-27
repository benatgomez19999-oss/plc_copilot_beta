using PlcCopilot.TiaAgent.Core;
using PlcCopilot.TiaAgent.Core.Services;
using PlcCopilot.TiaAgent.Core.Utils;
using Xunit;

namespace PlcCopilot.TiaAgent.Tests;

public sealed class ArtifactScannerTests : IDisposable
{
    private readonly string _dir;

    public ArtifactScannerTests()
    {
        _dir = Path.Combine(Path.GetTempPath(), "plccopilot-tia-agent-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_dir);
    }

    public void Dispose()
    {
        try { Directory.Delete(_dir, recursive: true); }
        catch { /* best-effort cleanup */ }
    }

    [Fact]
    public void Throws_ArtifactsNotFound_When_Directory_Missing()
    {
        var missing = Path.Combine(_dir, "does-not-exist");
        var scanner = new ArtifactScanner(new Logger(false));

        var ex = Assert.Throws<AgentException>(() => scanner.Scan(missing));
        Assert.Equal(AgentErrorCodes.ArtifactsNotFound, ex.Code);
    }

    [Fact]
    public void Throws_ArtifactsEmpty_When_No_Recognised_Files()
    {
        File.WriteAllText(Path.Combine(_dir, "readme.txt"), "nope");
        var scanner = new ArtifactScanner(new Logger(false));

        var ex = Assert.Throws<AgentException>(() => scanner.Scan(_dir));
        Assert.Equal(AgentErrorCodes.ArtifactsEmpty, ex.Code);
    }

    [Fact]
    public void Classifies_Scl_Csv_And_Manifest()
    {
        File.WriteAllText(Path.Combine(_dir, "FB_StLoad.scl"), "FUNCTION_BLOCK \"FB_StLoad\"\n");
        File.WriteAllText(Path.Combine(_dir, "UDT_MotorSimple.scl"), "TYPE \"UDT_MotorSimple\"\n");
        File.WriteAllText(Path.Combine(_dir, "Tags_Main.csv"), "Name;DataType;Address;Comment\n");
        File.WriteAllText(Path.Combine(_dir, "manifest.json"), "{}\n");
        File.WriteAllText(Path.Combine(_dir, "random.txt"), "ignored");

        var set = new ArtifactScanner(new Logger(false)).Scan(_dir);

        Assert.Equal(2, set.SclFiles.Count);
        Assert.Single(set.CsvFiles);
        Assert.NotNull(set.ManifestPath);
        Assert.Equal(4, set.Count);
    }

    [Fact]
    public void Emits_Stable_Alphabetical_Order_For_Scl()
    {
        File.WriteAllText(Path.Combine(_dir, "Z_last.scl"), "x");
        File.WriteAllText(Path.Combine(_dir, "A_first.scl"), "x");
        File.WriteAllText(Path.Combine(_dir, "M_middle.scl"), "x");

        var set = new ArtifactScanner(new Logger(false)).Scan(_dir);

        Assert.Collection(
            set.SclFiles,
            p => Assert.EndsWith("A_first.scl", p),
            p => Assert.EndsWith("M_middle.scl", p),
            p => Assert.EndsWith("Z_last.scl", p));
    }

    [Fact]
    public void Recurses_Subdirectories()
    {
        var nested = Path.Combine(_dir, "nested");
        Directory.CreateDirectory(nested);
        File.WriteAllText(Path.Combine(nested, "FB_Sub.scl"), "x");

        var set = new ArtifactScanner(new Logger(false)).Scan(_dir);

        Assert.Single(set.SclFiles);
        Assert.Contains("FB_Sub.scl", set.SclFiles[0]);
    }
}
