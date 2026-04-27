export type ArtifactKind = 'scl' | 'st' | 'csv' | 'json';

export interface ArtifactDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  stationId?: string;
  symbol?: string;
  hint?: string;
}

export interface GeneratedArtifact {
  path: string;
  kind: ArtifactKind;
  content: string;
  diagnostics?: ArtifactDiagnostic[];
}

export const CODEGEN_ERROR_CODES = [
  'NO_MACHINE',
  'EMPTY_STATION',
  'NO_INITIAL_STATE',
  'MULTIPLE_INITIAL_STATES',
  'UNKNOWN_STATE',
  'UNKNOWN_EQUIPMENT',
  'UNBOUND_ROLE',
  'UNKNOWN_IO',
  'UNRESOLVED_REF',
  'INVALID_REF',
  'INVALID_EXPR',
  'INVALID_ACTIVATION',
  'INVALID_FN',
  'UNKNOWN_FN',
  'UNKNOWN_KEYWORD',
  'UNSUPPORTED_EQUIPMENT',
  'UNSUPPORTED_ACTIVITY',
  'INTERLOCK_ROLE_UNRESOLVED',
  'TIMEOUT_RENDER_ERROR',
  'UNKNOWN_PARAMETER',
  // Surfaced from the expression / lowering pipeline (v0.2+)
  'UNKNOWN_REF',
  'UNKNOWN_MEMBER',
  'UNKNOWN_FUNCTION',
  'UNKNOWN_SYMBOL',
  'ARITY_MISMATCH',
  'TYPE_MISMATCH',
  'EXPECTED_BOOL',
  'EXPECTED_NUMERIC',
  'EXPECTED_COMPARABLE',
  'LEX_ERROR',
  'UNEXPECTED_TOKEN',
  'UNEXPECTED_EOF',
  'UNCLOSED_PAREN',
  'UNEXPECTED_CLOSE_PAREN',
  'EMPTY_EXPRESSION',
  'TRAILING_TOKENS',
  'INTERNAL_ERROR',
  // Info/warning codes surfaced by lowering passes
  'EDGE_LOWERED_AS_RISING',
  'TIMEOUT_NO_AUTO_TRANSITION',
  'EDGE_INSTANCE_COLLISION',
  'ALARMS_AS_LOOSE_TAGS',
] as const;

export type CodegenErrorCode = (typeof CODEGEN_ERROR_CODES)[number];

/**
 * Optional structured metadata attached to a `CodegenError`. Sprint 39
 * — these fields are surfaced by `serializeCompilerError` /
 * `formatSerializedCompilerError` so CLI and Web present the same
 * rich error UX.
 *
 *   - `path`       JSON-path of the offending field
 *   - `stationId`  PIR station id when the error is station-scoped
 *   - `symbol`     PIR symbol id when the error is symbol-scoped
 *   - `hint`       short mitigation / next-step text
 *   - `cause`      underlying error chained for traceability
 */
export interface CodegenErrorDetails {
  path?: string;
  stationId?: string;
  symbol?: string;
  hint?: string;
  cause?: unknown;
}

export class CodegenError extends Error {
  public readonly code: CodegenErrorCode;
  public readonly path?: string;
  public readonly stationId?: string;
  public readonly symbol?: string;
  public readonly hint?: string;
  // `Error.cause` is ES2022 native; we re-declare it for backwards
  // compatibility with consumers that compile under older lib targets.
  public override readonly cause?: unknown;

  /**
   * Sprint 39 — third arg accepts either the legacy `path` string OR
   * a `CodegenErrorDetails` bag. Both forms keep `new CodegenError(code,
   * message)` working unchanged.
   */
  constructor(
    code: CodegenErrorCode,
    message: string,
    pathOrDetails?: string | CodegenErrorDetails,
  ) {
    super(message);
    this.name = 'CodegenError';
    this.code = code;
    if (typeof pathOrDetails === 'string') {
      this.path = pathOrDetails;
    } else if (pathOrDetails) {
      this.path = pathOrDetails.path;
      this.stationId = pathOrDetails.stationId;
      this.symbol = pathOrDetails.symbol;
      this.hint = pathOrDetails.hint;
      if (pathOrDetails.cause !== undefined) {
        this.cause = pathOrDetails.cause;
      }
    }
  }
}
