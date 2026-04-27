import { serializeCompilerError } from '@plccopilot/codegen-core';
import { compilePir } from '../compiler/compile.js';
import type {
  CompileWorkerRequest,
  CompileWorkerResponse,
} from './protocol.js';

/**
 * Pure request → response transform. Lives in its own module so the
 * entry file (`compile-worker.ts`) stays a 5-line glue and this can
 * be unit-tested without instantiating a real Worker.
 *
 * Sprint 39 — error path now produces a `SerializedCompilerError`
 * via `serializeCompilerError`. The serializer extracts `code`,
 * `path`, `stationId`, `symbol`, `hint`, `cause` from `CodegenError`
 * instances; it falls back to `name + message` for plain `Error`
 * subclasses and to a best-effort string for non-Error throws. Stack
 * is intentionally suppressed in the default UX (`includeStack`
 * defaults to `false`); a future "show details" affordance in the
 * web UI could opt in.
 */
export function handleCompileRequest(
  request: CompileWorkerRequest,
): CompileWorkerResponse {
  try {
    const result = compilePir(request.project, request.backend, {
      ...(request.generatedAt !== undefined
        ? { generatedAt: request.generatedAt }
        : {}),
    });
    return { id: request.id, type: 'success', result };
  } catch (e) {
    return {
      id: request.id,
      type: 'error',
      error: serializeCompilerError(e, { includeStack: false }),
    };
  }
}
