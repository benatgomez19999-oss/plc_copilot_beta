/// <reference lib="webworker" />
import { handleCompileRequest } from './handler.js';
import { isCompileWorkerRequest } from './protocol.js';

/**
 * Web Worker entry point. Vite bundles this when the main bundle does
 *
 *   new Worker(new URL('./compile-worker.ts', import.meta.url), { type: 'module' })
 *
 * Everything heavy (codegen pipeline, IR walks, renderer text output) runs
 * in this isolated thread so the React UI stays responsive even on large
 * PIR projects.
 *
 * The worker is single-purpose — every other operation (validate, serialize,
 * inspect) still runs on the main thread because they're cheap.
 */

const ctx: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;

ctx.addEventListener('message', (event: MessageEvent<unknown>) => {
  const data = event.data;
  if (!isCompileWorkerRequest(data)) return;
  const response = handleCompileRequest(data);
  ctx.postMessage(response);
});
