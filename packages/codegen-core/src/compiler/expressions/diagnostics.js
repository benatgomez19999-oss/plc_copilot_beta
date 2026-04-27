// Thin shim for backward compatibility — the canonical diagnostics module
// now lives at `compiler/diagnostics.ts`. Kept so existing call sites inside
// compiler/expressions/* continue to import from './diagnostics.js'.
export { diag, firstError, formatDiagnostic, hasErrors, makeDiagnostic, } from '../diagnostics.js';
