// Thin shim for backward compatibility — the canonical diagnostics module
// now lives at `compiler/diagnostics.ts`. Kept so existing call sites inside
// compiler/expressions/* continue to import from './diagnostics.js'.

export {
  diag,
  firstError,
  formatDiagnostic,
  hasErrors,
  makeDiagnostic,
  type Diagnostic,
  type DiagnosticCode,
  type DiagnosticSeverity,
  type DiagnosticSeverity as Severity,
  type Span,
} from '../diagnostics.js';
