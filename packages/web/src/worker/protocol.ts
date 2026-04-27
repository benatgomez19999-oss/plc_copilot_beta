import type { Project } from '@plccopilot/pir';
import type { SerializedCompilerError } from '@plccopilot/codegen-core';
import type {
  BackendChoice,
  CompileResult,
} from '../compiler/compile.js';

// =============================================================================
// Wire types — the only things crossing the worker boundary.
// Both sides agree on these shapes; the request type is a narrow tagged union
// so future operations (validate-in-worker, serialize-in-worker, …) can be
// added without breaking existing consumers.
// =============================================================================

export interface CompileWorkerRequest {
  id: string;
  type: 'compile';
  project: Project;
  backend: BackendChoice;
  generatedAt?: string;
}

/**
 * Sprint 39 — error responses now carry the rich
 * `SerializedCompilerError` shape from `@plccopilot/codegen-core`
 * (code, path, station, symbol, hint, cause). The shape is a
 * superset of the legacy `{ message, stack? }` envelope, so any
 * pre-sprint-39 consumer that read `.message` / `.stack` keeps
 * working. New consumers can render the structured fields.
 */
export type CompileWorkerResponse =
  | {
      id: string;
      type: 'success';
      result: CompileResult;
    }
  | {
      id: string;
      type: 'error';
      error: SerializedCompilerError;
    };

// =============================================================================
// Pure helpers — fully unit-testable, no DOM, no Worker globals.
// =============================================================================

let _idCounter = 0;

/**
 * Monotonic request id, unique per process. We append a short timestamp so
 * collisions across module reloads (HMR) stay improbable.
 */
export function makeRequestId(): string {
  _idCounter += 1;
  return `req_${Date.now().toString(36)}_${_idCounter.toString(36)}`;
}

/**
 * @deprecated Sprint 39 — kept for backward compatibility with the
 * pre-sprint-39 wire shape (`{ message, stack? }`) and its test
 * suite. New code paths should use `serializeCompilerError` from
 * `@plccopilot/codegen-core` to obtain the rich
 * `SerializedCompilerError` shape (`code`, `path`, `station`,
 * `symbol`, `hint`, `cause`). This thin shim preserves the legacy
 * narrow shape some callers still expect.
 */
export function serializeError(e: unknown): {
  message: string;
  stack?: string;
} {
  if (e instanceof Error) {
    return e.stack
      ? { message: e.message, stack: e.stack }
      : { message: e.message };
  }
  if (typeof e === 'string') return { message: e };
  if (e !== null && typeof e === 'object') {
    const obj = e as { message?: unknown; stack?: unknown };
    if (typeof obj.message === 'string') {
      return typeof obj.stack === 'string'
        ? { message: obj.message, stack: obj.stack }
        : { message: obj.message };
    }
  }
  return { message: String(e) };
}

export function isCompileWorkerRequest(v: unknown): v is CompileWorkerRequest {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === 'string' && o.type === 'compile';
}

export function isCompileWorkerResponse(v: unknown): v is CompileWorkerResponse {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') return false;
  if (o.type === 'success') return 'result' in o;
  if (o.type === 'error') {
    if (typeof o.error !== 'object' || o.error === null) return false;
    const err = o.error as Record<string, unknown>;
    return typeof err.message === 'string';
  }
  return false;
}
