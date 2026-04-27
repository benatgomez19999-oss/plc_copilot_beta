namespace PlcCopilot.TiaAgent.Core.Utils;

public sealed class Logger
{
    private readonly bool _verbose;

    public Logger(bool verbose) => _verbose = verbose;

    public void Info(string msg) => Console.WriteLine($"[INFO]  {msg}");
    public void Warn(string msg) => Console.WriteLine($"[WARN]  {msg}");
    public void Error(string msg) => Console.Error.WriteLine($"[ERROR] {msg}");
    public void Debug(string msg)
    {
        if (_verbose) Console.WriteLine($"[DEBUG] {msg}");
    }
}
