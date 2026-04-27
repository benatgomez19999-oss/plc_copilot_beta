using PlcCopilot.TiaAgent.Core;
using Xunit;

namespace PlcCopilot.TiaAgent.Tests;

public sealed class CliOptionsTests
{
    [Fact]
    public void Parses_Required_Triplet()
    {
        var opts = CliOptions.Parse(new[]
        {
            "--project", @"C:\TIA\DemoProject.ap19",
            "--artifacts", @"C:\generated\siemens",
            "--out", @"C:\generated\result.json",
        });

        Assert.EndsWith("DemoProject.ap19", opts.ProjectPath);
        Assert.EndsWith("siemens", opts.ArtifactsPath);
        Assert.EndsWith("result.json", opts.OutPath);
        Assert.Null(opts.CopyCsvTo);
        Assert.False(opts.Verbose);
    }

    [Fact]
    public void Accepts_Optional_CopyCsvTo_And_Verbose()
    {
        var opts = CliOptions.Parse(new[]
        {
            "--project", "p.ap19",
            "--artifacts", "./a",
            "--out", "./r.json",
            "--copy-csv-to", "./csv",
            "--verbose",
        });

        Assert.True(opts.Verbose);
        Assert.NotNull(opts.CopyCsvTo);
        Assert.EndsWith("csv", opts.CopyCsvTo);
    }

    [Fact]
    public void Throws_When_Project_Missing()
    {
        var ex = Assert.Throws<ArgumentException>(() =>
            CliOptions.Parse(new[] { "--artifacts", "a", "--out", "b" }));
        Assert.Contains("--project", ex.Message);
    }

    [Fact]
    public void Throws_When_Artifacts_Missing()
    {
        var ex = Assert.Throws<ArgumentException>(() =>
            CliOptions.Parse(new[] { "--project", "p", "--out", "b" }));
        Assert.Contains("--artifacts", ex.Message);
    }

    [Fact]
    public void Throws_When_Out_Missing()
    {
        var ex = Assert.Throws<ArgumentException>(() =>
            CliOptions.Parse(new[] { "--project", "p", "--artifacts", "a" }));
        Assert.Contains("--out", ex.Message);
    }

    [Fact]
    public void Throws_When_Flag_Value_Missing()
    {
        var ex = Assert.Throws<ArgumentException>(() =>
            CliOptions.Parse(new[] { "--project" }));
        Assert.Contains("requires a value", ex.Message);
    }

    [Fact]
    public void Throws_On_Unknown_Argument()
    {
        var ex = Assert.Throws<ArgumentException>(() => CliOptions.Parse(new[]
        {
            "--project", "p", "--artifacts", "a", "--out", "o", "--nope",
        }));
        Assert.Contains("--nope", ex.Message);
    }

    [Fact]
    public void Help_Flag_Throws_Special_Signal()
    {
        var ex = Assert.Throws<ArgumentException>(() =>
            CliOptions.Parse(new[] { "--help" }));
        Assert.Equal("help requested", ex.Message);
    }
}
