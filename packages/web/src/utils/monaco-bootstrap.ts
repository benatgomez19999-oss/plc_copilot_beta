/**
 * Heavy-imports module — loaded ONLY through a dynamic `import()` from
 * `monaco-loader.ts`. Vitest never evaluates it (tests interact with
 * `configureMonacoLoaderWith` instead), so the `monaco-editor` /
 * `?worker` imports live here in isolation.
 *
 * Self-host strategy:
 *   1. Import the editor and JSON workers via Vite's `?worker` syntax.
 *      Vite emits each as its own bundle and returns a Worker constructor.
 *   2. Wire `globalThis.MonacoEnvironment.getWorker` to those constructors
 *      BEFORE any Monaco code runs.
 *   3. Import the local `monaco-editor` namespace and feed it to
 *      `loader.config({ monaco })`. From this point onward `loader.init()`
 *      resolves with the local instance — no CDN fetch.
 *
 * After this module runs once, the app is fully offline-capable.
 */
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import { configureMonacoLoaderWith } from './monaco-loader.js';

interface MonacoEnvironmentLike {
  getWorker: (workerId: string, label: string) => Worker;
}

export async function runMonacoBootstrap(): Promise<void> {
  // Workers MUST be registered before monaco-editor evaluates — its top-level
  // code reads `MonacoEnvironment` to know how to spawn them.
  (globalThis as { MonacoEnvironment?: MonacoEnvironmentLike }).MonacoEnvironment =
    {
      getWorker(_workerId: string, label: string): Worker {
        if (label === 'json') return new JsonWorker();
        // Default: the generic editor worker. Sufficient for `scl`,
        // `structured-text`, `plaintext`, and any other language we don't
        // ship a dedicated worker for.
        return new EditorWorker();
      },
    };

  // Two parallel dynamic imports — Vite chunks them separately so the
  // empty-state app never downloads them.
  const [{ loader }, monaco] = await Promise.all([
    import('@monaco-editor/react'),
    import('monaco-editor'),
  ]);

  configureMonacoLoaderWith(loader, monaco);
}
