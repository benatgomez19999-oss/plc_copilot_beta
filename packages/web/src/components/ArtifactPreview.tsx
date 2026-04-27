import { useEffect, useState } from 'react';
import type { GeneratedArtifact } from '@plccopilot/codegen-core';
import { downloadText } from '../utils/download.js';
import { detectArtifactLanguage } from '../utils/language.js';
import { copyText } from '../utils/clipboard.js';
import { hasContentChanged } from '../utils/artifact-diff.js';
import { MonacoReadonly } from './MonacoReadonly.js';
import { MonacoDiffReadonly } from './MonacoDiffReadonly.js';

export interface ArtifactPreviewProps {
  artifact: GeneratedArtifact | null;
  /**
   * Same-path artifact from the previous generation (when one exists).
   * Enables the "Show diff with previous" toggle. Computed by the parent
   * via `findPreviousArtifact(artifact.path, previousCompileResult.artifacts)`.
   */
  previousArtifact?: GeneratedArtifact | null;
}

type CopyState = 'idle' | 'ok' | 'fail';

function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(i + 1) : path;
}

export function ArtifactPreview({
  artifact,
  previousArtifact = null,
}: ArtifactPreviewProps): JSX.Element {
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const [showDiff, setShowDiff] = useState(false);

  // Reset diff toggle whenever the user picks a different artifact — diff
  // state is per-artifact and shouldn't leak across selections.
  useEffect(() => {
    setShowDiff(false);
  }, [artifact?.path]);

  if (!artifact) {
    return (
      <section className="card preview">
        <p className="muted">Select an artifact on the left to preview it.</p>
      </section>
    );
  }

  const language = detectArtifactLanguage(artifact.path, artifact.kind);
  const lineCount = artifact.content.split('\n').length;
  const charCount = artifact.content.length;

  const hasPrevious = previousArtifact !== null;
  const contentChanged = previousArtifact
    ? hasContentChanged(previousArtifact, artifact)
    : false;
  const canDiff = hasPrevious && contentChanged;

  async function handleCopy(): Promise<void> {
    if (!artifact) return;
    const ok = await copyText(artifact.content);
    setCopyState(ok ? 'ok' : 'fail');
    setTimeout(() => setCopyState('idle'), 2000);
  }

  return (
    <section className="card preview">
      <header className="panel-header">
        <div>
          <h2 className="path">{artifact.path}</h2>
          <p className="muted">
            kind: <code>{artifact.kind}</code> · lang:{' '}
            <code>{language}</code> · {lineCount} lines ·{' '}
            {charCount.toLocaleString()} chars
          </p>
        </div>
        <div className="preview-actions">
          {hasPrevious ? (
            <button
              type="button"
              className="btn"
              onClick={() => setShowDiff((s) => !s)}
              disabled={!canDiff}
              title={
                canDiff
                  ? 'Compare this artifact against the previous generation'
                  : 'No content changes from the previous generation'
              }
            >
              {showDiff ? 'Hide diff' : 'Show diff with previous'}
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={handleCopy}
            title="Copy the entire artifact content to clipboard"
          >
            {copyState === 'idle'
              ? 'Copy all'
              : copyState === 'ok'
                ? 'Copied ✓'
                : 'Copy failed'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              downloadText(basename(artifact.path), artifact.content)
            }
          >
            Download
          </button>
        </div>
      </header>

      {artifact.diagnostics && artifact.diagnostics.length > 0 ? (
        <details className="artifact-diags" open>
          <summary>
            {artifact.diagnostics.length} diagnostics on this artifact
          </summary>
          <ul>
            {artifact.diagnostics.map((d, i) => (
              <li key={i} className={`sev-${d.severity}`}>
                <span className={`badge sev-${d.severity}`}>{d.severity}</span>
                <code>{d.code}</code> — {d.message}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {hasPrevious && !contentChanged ? (
        <p className="muted small">
          No content changes from the previous generation.
        </p>
      ) : null}

      {showDiff && canDiff && previousArtifact ? (
        <MonacoDiffReadonly
          original={previousArtifact.content}
          modified={artifact.content}
          language={language}
          height="60vh"
          fallbackLabel="Diff editor unavailable — falling back to a side-by-side plain text view."
        />
      ) : (
        <MonacoReadonly
          value={artifact.content}
          language={language}
          height="60vh"
          fallbackLabel="Editor unavailable — falling back to plain text view."
        />
      )}
    </section>
  );
}
