using System.Text.Json;
using PlcCopilot.TiaAgent.Core.Models;
using PlcCopilot.TiaAgent.Core.Services;
using Xunit;

namespace PlcCopilot.TiaAgent.Tests;

public sealed class ResultWriterTests
{
    [Fact]
    public void Serializes_Required_Fields_In_SnakeCase()
    {
        var result = new AgentResult
        {
            Ok = false,
            ProjectPath = @"C:\TIA\DemoProject.ap19",
            ArtifactsPath = @"C:\generated\siemens",
            GeneratedAt = "2026-04-23T00:00:00Z",
        };
        result.Imported.Add(new ImportedArtifact("FB_StLoad.scl", "scl", "imported"));
        result.Skipped.Add(new SkippedArtifact("Tags_Main.csv", "csv_import_not_implemented"));
        result.Compile = new CompileReport
        {
            Success = false,
            State = "error",
            Issues =
            {
                new CompileIssue("error", "Unknown tag foo", "FB_StLoad", null),
            },
        };

        string json = ResultWriter.Serialize(result);
        using var doc = JsonDocument.Parse(json);
        var root = doc.RootElement;

        Assert.False(root.GetProperty("ok").GetBoolean());
        Assert.Equal(@"C:\TIA\DemoProject.ap19", root.GetProperty("project_path").GetString());
        Assert.Equal(@"C:\generated\siemens", root.GetProperty("artifacts_path").GetString());
        Assert.Equal("2026-04-23T00:00:00Z", root.GetProperty("generated_at").GetString());

        var imported = root.GetProperty("imported");
        Assert.Equal(1, imported.GetArrayLength());
        Assert.Equal("FB_StLoad.scl", imported[0].GetProperty("path").GetString());
        Assert.Equal("scl", imported[0].GetProperty("kind").GetString());
        Assert.Equal("imported", imported[0].GetProperty("status").GetString());

        var skipped = root.GetProperty("skipped");
        Assert.Equal("csv_import_not_implemented", skipped[0].GetProperty("reason").GetString());

        var compile = root.GetProperty("compile");
        Assert.False(compile.GetProperty("success").GetBoolean());
        Assert.Equal("error", compile.GetProperty("state").GetString());
        var issues = compile.GetProperty("issues");
        Assert.Equal(1, issues.GetArrayLength());
        Assert.Equal("FB_StLoad", issues[0].GetProperty("object").GetString());
    }

    [Fact]
    public void Omits_Null_Properties()
    {
        var result = new AgentResult
        {
            Ok = true,
            ProjectPath = "x",
            ArtifactsPath = "y",
        };

        string json = ResultWriter.Serialize(result);
        Assert.DoesNotContain("\"error\"", json);
        Assert.DoesNotContain("\"compile\"", json);
    }

    [Fact]
    public void Write_Creates_Missing_Parent_Directory()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "plccopilot-writer-" + Guid.NewGuid().ToString("N"));
        var outPath = Path.Combine(tempRoot, "nested", "result.json");

        try
        {
            var result = new AgentResult { Ok = true, ProjectPath = "p", ArtifactsPath = "a" };
            ResultWriter.Write(outPath, result);

            Assert.True(File.Exists(outPath));
            using var doc = JsonDocument.Parse(File.ReadAllText(outPath));
            Assert.True(doc.RootElement.GetProperty("ok").GetBoolean());
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void Serialization_Is_Deterministic_For_Same_Input()
    {
        var r1 = MakeStable();
        var r2 = MakeStable();
        Assert.Equal(ResultWriter.Serialize(r1), ResultWriter.Serialize(r2));
    }

    private static AgentResult MakeStable() => new()
    {
        Ok = true,
        ProjectPath = "p",
        ArtifactsPath = "a",
        GeneratedAt = "2026-04-23T00:00:00Z",
        AgentVersion = "0.1.0",
    };
}
