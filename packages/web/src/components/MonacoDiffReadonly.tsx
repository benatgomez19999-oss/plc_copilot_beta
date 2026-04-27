import { useEffect, useState } from 'react';
import { DiffEditor, loader, type Monaco } from '@monaco-editor/react';
import { configureMonacoLoader } from '../utils/monaco-loader.js';
import { registerPlcLanguages } from '../utils/monaco-languages.js';

export interface MonacoDiffReadonlyProps {
  /** Left-hand pane content. */
  original: string;
  /** Right-hand pane content. */
  modified: string;
  /** Monaco language id (`'json'`, `'scl'`, `'structured-text'`, …). */
  language: string;
  /** CSS height for the diff host. Defaults to `60vh`. */
  height?: string;
  /** Optional sentence shown above the two-column `<pre>` fallback. */
  fallbackLabel?: string;
}

type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

const LOAD_TIMEOUT_MS = 8_000;

/**
 * Read-only Monaco DiffEditor with a graceful two-column `<pre>` fallback.
 * Mirrors `MonacoReadonly`'s lifecycle: lazy `configureMonacoLoader`, an
 * 8-second timeout safety net, `registerPlcLanguages` on `beforeMount`.
 *
 * Both panes are read-only (`originalEditable: false`); the diff is for
 * review, not in-place editing. To edit, the user toggles back to the
 * normal editor in the parent component.
 */
export function MonacoDiffReadonly({
  original,
  modified,
  language,
  height = '60vh',
  fallbackLabel,
}: MonacoDiffReadonlyProps): JSX.Element {
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
        <div className="diff-fallback">
          <div>
            <h4 className="muted small">Original</h4>
            <pre className="content">{original}</pre>
          </div>
          <div>
            <h4 className="muted small">Modified</h4>
            <pre className="content">{modified}</pre>
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="editor-container" style={{ minHeight: height }}>
      <DiffEditor
        height={height}
        language={language}
        original={original}
        modified={modified}
        theme="vs-dark"
        beforeMount={(monaco: Monaco) => {
          try {
            registerPlcLanguages(monaco);
          } catch {
            // Best-effort — failure here only downgrades SCL/ST highlighting.
          }
        }}
        onMount={() => setState('ready')}
        loading={
          <div className="diff-fallback">
            <div>
              <h4 className="muted small">Original</h4>
              <pre className="content content-loading">{original}</pre>
            </div>
            <div>
              <h4 className="muted small">Modified</h4>
              <pre className="content content-loading">{modified}</pre>
            </div>
          </div>
        }
        options={{
          readOnly: true,
          originalEditable: false,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          wordWrap: 'off',
          automaticLayout: true,
          fontSize: 13,
          renderSideBySide: true,
          ignoreTrimWhitespace: false,
          renderIndicators: true,
          enableSplitViewResizing: true,
        }}
      />
    </div>
  );
}
