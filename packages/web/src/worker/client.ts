import type { Project } from '@plccopilot/pir';
import {
  formatSerializedCompilerError,
  serializeCompilerError,
  type SerializedCompilerError,
} from '@plccopilot/codegen-core';
import {
  compilePir,
  type BackendChoice,
  type CompilePirOptions,
  type CompileResult,
} from '../compiler/compile.js';
import {
  isCompileWorkerResponse,
  makeRequestId,
  type CompileWorkerRequest,
  type CompileWorkerResponse,
} from './protocol.js';

/**
 * Sprint 39 — `Error` subclass surfaced when a compile rejects with
 * a structured worker error. The standard `Error.message` carries the
 * formatted single-line representation (`[CODE] message …`) so
 * naive `String(err)` consumers still read sensibly; the
 * `serialized` property exposes the full structured shape (code,
 * path, hint, …) for components that want to render it richly.
 */
export class CompileClientError extends Error {
  public readonly serialized: SerializedCompilerError;

  constructor(serialized: SerializedCompilerError) {
    super(formatSerializedCompilerError(serialized));
    this.name = 'CompileClientError';
    this.serialized = serialized;
  }
}

// =============================================================================
// Worker abstraction — the shape we depend on. A real `Worker` satisfies this;
// tests pass a fake that records postMessages and exposes test helpers.
// =============================================================================

export interface WorkerLike {
  postMessage: (msg: unknown) => void;
  terminate: () => void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
}

export type CompileWorkerFactory = () => WorkerLike | null;
export type MainThreadFallback = (
  project: Project,
  backend: BackendChoice,
  opts?: CompilePirOptions,
) => CompileResult;

export interface CompileClientOptions {
  /**
   * Override the worker constructor. Default: real `new Worker(...)` with
   * Vite's URL pattern; tests pass a fake.
   */
  workerFactory?: CompileWorkerFactory;
  /**
   * Override the main-thread fallback. Default: the imported `compilePir`.
   */
  mainThreadFallback?: MainThreadFallback;
}

export interface CompileClient {
  /** True when a real Worker is in use; false in fallback mode. */
  readonly available: boolean;
  /** Reason populated when `available === false`. */
  readonly fallbackReason: string | null;
  /**
   * Schedule a compile. In worker mode this resolves when the worker posts
   * back; in fallback mode it resolves with the synchronous main-thread
   * compile wrapped in a Promise.
   */
  compile: (
    project: Project,
    backend: BackendChoice,
    opts?: CompilePirOptions,
  ) => Promise<CompileResult>;
  /**
   * Stop the worker and reject every pending request. Idempotent.
   */
  terminate: () => void;
}

// =============================================================================
// Default factory — wraps `new Worker(...)` so a SecurityError, missing
// constructor, or import-time failure becomes a graceful fallback rather than
// an unhandled exception.
// =============================================================================

const defaultFactory: CompileWorkerFactory = () => {
  if (typeof Worker === 'undefined') return null;
  try {
    return new Worker(
      new URL('./compile-worker.ts', import.meta.url),
      { type: 'module' },
    ) as unknown as WorkerLike;
  } catch {
    return null;
  }
};

// =============================================================================
// Client
// =============================================================================

interface PendingEntry {
  resolve: (r: CompileResult) => void;
  reject: (e: CompileClientError | Error) => void;
}

export function createCompileWorkerClient(
  options: CompileClientOptions = {},
): CompileClient {
  const factory = options.workerFactory ?? defaultFactory;
  const fallback = options.mainThreadFallback ?? compilePir;

  let worker: WorkerLike | null = null;
  let fallbackReason: string | null = null;
  const pending = new Map<string, PendingEntry>();

  try {
    worker = factory();
    if (!worker) {
      fallbackReason = 'Web Worker unavailable; compiling on main thread.';
    }
  } catch (e) {
    worker = null;
    fallbackReason =
      e instanceof Error
        ? `Web Worker initialisation failed (${e.message}); compiling on main thread.`
        : 'Web Worker initialisation failed; compiling on main thread.';
  }

  if (worker) {
    worker.onmessage = (event: { data: unknown }): void => {
      if (!isCompileWorkerResponse(event.data)) return;
      const response = event.data;
      const entry = pending.get(response.id);
      if (!entry) return;
      pending.delete(response.id);
      if (response.type === 'success') {
        entry.resolve(response.result);
      } else {
        // Sprint 39 — keep the structured error reachable by wrapping
        // it in `CompileClientError`. Components that only read
        // `.message` get the formatted single-line shape; components
        // that want code / path / hint can `instanceof
        // CompileClientError && err.serialized.code`.
        entry.reject(new CompileClientError(response.error));
      }
    };
    worker.onerror = (event: { message?: string }): void => {
      // The worker died — reject everything currently in flight.
      const message = event.message ?? 'worker error';
      for (const [, entry] of pending) entry.reject(new Error(message));
      pending.clear();
    };
  }

  function compileViaWorker(
    project: Project,
    backend: BackendChoice,
    opts: CompilePirOptions | undefined,
  ): Promise<CompileResult> {
    if (!worker) {
      return Promise.reject(new Error('worker not available'));
    }
    const id = makeRequestId();
    return new Promise<CompileResult>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const request: CompileWorkerRequest = {
        id,
        type: 'compile',
        project,
        backend,
        ...(opts?.generatedAt !== undefined
          ? { generatedAt: opts.generatedAt }
          : {}),
      };
      try {
        worker!.postMessage(request);
      } catch (e) {
        pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  function compileMainThread(
    project: Project,
    backend: BackendChoice,
    opts: CompilePirOptions | undefined,
  ): Promise<CompileResult> {
    try {
      return Promise.resolve(fallback(project, backend, opts));
    } catch (e) {
      // Sprint 39 — same structured shape as the worker path. Tests
      // and UI consumers can pattern-match on `CompileClientError`
      // regardless of whether compile ran via the worker or fell
      // back to the main thread.
      return Promise.reject(
        new CompileClientError(serializeCompilerError(e)),
      );
    }
  }

  return {
    get available(): boolean {
      return worker !== null;
    },
    get fallbackReason(): string | null {
      return fallbackReason;
    },
    compile(project, backend, opts): Promise<CompileResult> {
      if (worker) return compileViaWorker(project, backend, opts);
      return compileMainThread(project, backend, opts);
    },
    terminate(): void {
      if (worker) {
        try {
          worker.terminate();
        } catch {
          // Already torn down — ignore.
        }
        worker = null;
      }
      for (const [, entry] of pending) {
        entry.reject(new Error('compile client terminated'));
      }
      pending.clear();
    },
  };
}

// Re-export the response shape so `App.tsx` can keep its existing typing
// without reaching into the worker subdirectory.
export type { CompileWorkerResponse };
