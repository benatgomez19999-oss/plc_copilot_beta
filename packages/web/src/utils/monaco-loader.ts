/**
 * Self-hosted Monaco loader configuration.
 *
 * Layered design so this file stays test-safe:
 *
 *   - `configureMonacoLoaderWith(loader, monaco)` is a pure, idempotent
 *     primitive. Tests inject a structural-mock loader; production passes
 *     the real `@monaco-editor/react` loader and a real `monaco-editor`
 *     namespace.
 *
 *   - `configureMonacoLoader()` is the public async façade. It defers the
 *     heavy `monaco-editor` and `?worker` imports to a separately-loaded
 *     bootstrap module so vitest (running in Node) never has to evaluate
 *     them. The first call performs the bootstrap; subsequent calls return
 *     the same Promise.
 *
 *   - `isMonacoLoaderConfigured()` and `_resetMonacoLoaderState()` exist
 *     for tests + HMR safety. Production code does not touch them.
 */

// Sprint 37 — declared with **method shorthand** so TypeScript checks
// the call signature with bivariance. The real `@monaco-editor/react`
// loader's `config` accepts `{ paths?, 'vs/nls'?, monaco?: editor.api }`
// where every field is optional; matching the **optional** shape of
// `monaco` here is what lets the strict editor-api type satisfy our
// `unknown` slot under bivariance. We never call `.config()` without
// `monaco` in practice, but tests treat `config` as a stub so an
// empty arg-list is also valid.
export interface MinimalLoader {
  config(cfg: { monaco?: unknown }): void;
}

let _configured = false;
let _bootstrapPromise: Promise<void> | null = null;

/**
 * Run the loader.config call once. Returns `true` if this call performed
 * the configuration, `false` if a previous call already did. Tests call
 * this directly with stubs.
 */
export function configureMonacoLoaderWith(
  loader: MinimalLoader,
  monaco: unknown,
): boolean {
  if (_configured) return false;
  loader.config({ monaco });
  _configured = true;
  return true;
}

export function isMonacoLoaderConfigured(): boolean {
  return _configured;
}

/**
 * Test-only state reset. Production code MUST NOT call this. Without it,
 * vitest reuses the same module instance across tests and the second
 * "first call" assertion would fail.
 */
export function _resetMonacoLoaderState(): void {
  _configured = false;
  _bootstrapPromise = null;
}

/**
 * Idempotent async configuration. Components call this in `useEffect`
 * before relying on Monaco. Safe to call from multiple components in any
 * order — the second caller awaits the same in-flight Promise.
 *
 * The first call dynamic-imports `./monaco-bootstrap.js` which in turn
 * dynamic-imports `monaco-editor` and the worker chunks. Vite splits each
 * dynamic import into its own bundle so the empty-state app stays small.
 */
export function configureMonacoLoader(): Promise<void> {
  if (_configured) return Promise.resolve();
  if (_bootstrapPromise) return _bootstrapPromise;
  _bootstrapPromise = (async () => {
    const mod = await import('./monaco-bootstrap.js');
    await mod.runMonacoBootstrap();
  })();
  return _bootstrapPromise;
}
