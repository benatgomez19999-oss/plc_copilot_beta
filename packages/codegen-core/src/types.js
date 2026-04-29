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
    // Sprint 86 — codegen readiness / preflight failure
    'READINESS_FAILED',
];
export class CodegenError extends Error {
    code;
    path;
    stationId;
    symbol;
    hint;
    // `Error.cause` is ES2022 native; we re-declare it for backwards
    // compatibility with consumers that compile under older lib targets.
    cause;
    /**
     * Sprint 39 — third arg accepts either the legacy `path` string OR
     * a `CodegenErrorDetails` bag. Both forms keep `new CodegenError(code,
     * message)` working unchanged.
     */
    constructor(code, message, pathOrDetails) {
        super(message);
        this.name = 'CodegenError';
        this.code = code;
        if (typeof pathOrDetails === 'string') {
            this.path = pathOrDetails;
        }
        else if (pathOrDetails) {
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
