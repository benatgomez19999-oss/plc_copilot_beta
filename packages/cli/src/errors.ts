/**
 * CLI-level error with an exit code attached. Commands raise these via the
 * `fail()` helper; the dispatcher prints the message to stderr and exits
 * with the carried code.
 *
 * Exit-code conventions (mirrors curl/git):
 *   0  success
 *   1  unrecoverable error (file not found, invalid JSON, schema mismatch,
 *      generation threw, write failed, …)
 *   2  command succeeded but the report contains errors (validation errors,
 *      diagnostics with severity=error in generated artifacts)
 */
export class CliError extends Error {
  public readonly code: number;
  public override readonly cause?: unknown;

  constructor(message: string, code = 1, cause?: unknown) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Convenience to raise + bail; never returns. */
export function fail(message: string, code = 1, cause?: unknown): never {
  throw new CliError(message, code, cause);
}

import {
  formatSerializedCompilerError,
  serializeCompilerError,
  type SerializedCompilerError,
} from '@plccopilot/codegen-core';

/**
 * Best-effort error → string formatting suitable for stderr.
 *
 * Sprint 39 — for non-CliError throws (codegen errors, runtime
 * exceptions) we delegate to `serializeCompilerError` /
 * `formatSerializedCompilerError` so the CLI surfaces the same rich
 * shape (`[CODE] message (path: …) Hint: …`) as the web UI. Stack
 * traces are intentionally omitted from the default presentation;
 * a future `--debug` flag would set `includeStack: true`.
 *
 * `CliError` keeps its own format (`error: <message>`) because its
 * messages are already curated for terminal display, but its
 * `cause` chain is now rendered via the serializer too — that way a
 * `CliError(msg, cause: CodegenError)` inherits all the structured
 * metadata.
 */
export function formatError(e: unknown): string {
  if (e instanceof CliError) {
    if (e.cause === undefined) return `error: ${e.message}`;
    const inner = formatSerializedCompilerError(
      serializeCompilerError(e.cause),
    );
    return `error: ${e.message}\n  caused by: ${inner}`;
  }
  return formatSerializedCompilerError(serializeCompilerError(e));
}

/**
 * Sprint 45 — promote any thrown value to the
 * `SerializedCompilerError` wire shape used by every JSON-mode CLI
 * payload.
 *
 * `CliError` is unwrapped to its `cause` when present so a
 * `CliError(msg, cause: CodegenError)` surfaces the underlying
 * code/path/symbol/hint instead of a generic "CliError: msg"
 * envelope. When `cause` is absent (curated CliError messages like
 * "missing required flag --input"), the CliError itself is
 * serialised as a plain Error.
 *
 * `debug` controls `includeStack` so the default UX stays stack-free
 * and stacks only appear when the user passed `--debug`.
 */
export function serializeCliFailure(
  error: unknown,
  debug = false,
): SerializedCompilerError {
  if (error instanceof CliError && error.cause !== undefined) {
    return serializeCompilerError(error.cause, { includeStack: debug });
  }
  return serializeCompilerError(error, { includeStack: debug });
}
