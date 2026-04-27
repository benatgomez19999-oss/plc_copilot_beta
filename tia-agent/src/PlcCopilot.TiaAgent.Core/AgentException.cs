namespace PlcCopilot.TiaAgent.Core;

public sealed class AgentException : Exception
{
    public string Code { get; }

    public AgentException(string code, string message) : base(message)
    {
        Code = code;
    }

    public AgentException(string code, string message, Exception inner) : base(message, inner)
    {
        Code = code;
    }
}

public static class AgentErrorCodes
{
    public const string ProjectNotFound = "PROJECT_NOT_FOUND";
    public const string ProjectOpenFailed = "PROJECT_OPEN_FAILED";
    public const string TiaVersionMismatch = "TIA_VERSION_MISMATCH";
    public const string ArtifactsNotFound = "ARTIFACTS_NOT_FOUND";
    public const string ArtifactsEmpty = "ARTIFACTS_EMPTY";
    public const string PlcSoftwareNotFound = "PLC_SOFTWARE_NOT_FOUND";
    public const string ImportFailed = "IMPORT_FAILED";
    public const string CompileNotAvailable = "COMPILE_NOT_AVAILABLE";
    public const string CompileFailed = "COMPILE_FAILED";
    public const string OpennessAssemblyMissing = "OPENNESS_ASSEMBLY_MISSING";
    public const string Unexpected = "UNEXPECTED";
    public const string InvalidCli = "INVALID_CLI";
}
