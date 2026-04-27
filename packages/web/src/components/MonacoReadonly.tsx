import { useEffect, useState } from 'react';
import Editor, { loader, type Monaco } from '@monaco-editor/react';
import { configureMonacoLoader } from '../utils/monaco-loader.js';
import { registerPlcLanguages } from '../utils/monaco-languages.js';

export interface MonacoReadonlyProps {
  /** The text to display. */
  value: string;
  /** Monaco language id (e.g. `'json'`, `'scl'`, `'structured-text'`). */
  language: string;
  /** CSS height for the editor host. Defaults to `60vh`. */
  height?: string;
  /** Optional sentence shown above the `<pre>` fallback. */
  fallbackLabel?: string;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

const LOAD_TIMEOUT_MS = 8_000;

/**
 * Read-only Monaco viewer with a graceful `<pre>` fallback. Encapsulates
 * everything `ArtifactPreview` and `PirViewer` had in common:
 *
 *   - lazy `configureMonacoLoader()` (self-host — no CDN)
 *   - `loader.init().catch(...)` for explicit failure detection
 *   - 8-second timeout safety net
 *   - `registerPlcLanguages` on `beforeMount` so SCL / ST highlighting is
 *     ready before the model is created
 *   - a stable, opinionated set of read-only `IStandaloneEditorConstructionOptions`
 *
 * Failure modes folded into the same `state.failed` branch:
 *   - bootstrap rejected (chunk load failed in offline build)
 *   - `loader.init()` rejected
 *   - timeout exceeded
 */
export function MonacoReadonly({
  value,
  language,
  height = '60vh',
  fallbackLabel,
}: MonacoReadonlyProps): JSX.Element {
  const [state, setState] = useState<LoadState>('idle');

  useEffect(() => {
    if (state !== 'idle') return;
    setState('loading');
    let cancelled = false;

    const fail = (): void => {
      if (cancelled) return;
      setState((prev) => (prev === 'loading' ? 'failed' : prev));
    };

    configureMonacoLoader()
      .then(() => loader.init())
      .catch(fail);

    const timeoutId = setTimeout(fail, LOAD_TIMEOUT_MS);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
    };
  }, [state]);

  if (state === 'failed') {
    return (
      <>
        {fallbackLabel ? (
          <p className="muted small">{fallbackLabel}</p>
        ) : null}
        <pre className="content">{value}</pre>
      </>
    );
  }

  return (
    <div className="editor-container" style={{ minHeight: height }}>
      <Editor
        height={height}
        language={language}
        value={value}
        theme="vs-dark"
        beforeMount={(monaco: Monaco) => {
          // Best-effort — registering twice is safe (Monaco is idempotent
          // on registered ids), and a failure here only downgrades the SCL
          // / ST languages to plaintext rendering.
          try {
            registerPlcLanguages(monaco);
          } catch {
            // Swallow — defensive.
          }
        }}
        onMount={() => setState('ready')}
        loading={
          <pre className="content content-loading">{value}</pre>
        }
        options={{
          readOnly: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          automaticLayout: true,
          fontSize: 13,
          lineNumbers: 'on',
          renderWhitespace: 'selection',
          folding: true,
          smoothScrolling: true,
          contextmenu: true,
          scrollbar: {
            vertical: 'auto',
            horizontal: 'auto',
          },
        }}
      />
    </div>
  );
}
