// Sprint 89 — Codegen preview panel.
//
// A thin renderer over `buildCodegenPreviewView`. Lives next to
// `CodegenReadinessPanel` in App.tsx so the operator can:
//
//   1. See readiness (Sprint 87B panel — unchanged), then
//   2. Optionally click "Preview generated artifacts" to see a
//      capped, ephemeral, per-target preview of what Generate
//      would produce, BEFORE clicking Generate.
//
// Hard rules:
//   - Preview is explicit. No auto-trigger on project / target
//     change. Changing project or target invalidates the
//     previous preview and returns the panel to "idle".
//   - Snippets are ephemeral state — never persisted to
//     localStorage; never included in export bundles.
//   - Preview is not codegen certification: a green preview is
//     not a guarantee the generated code is operator-grade
//     safety-correct.
//
// The component is intentionally dumb:
//   - takes a `project` + `target` (or `'all'`),
//   - delegates everything to the pure helper on click,
//   - renders a small action button + per-target cards.

import { useEffect, useMemo, useState } from 'react';

import {
  buildCodegenPreviewView,
  type CodegenPreviewArtifactView,
  type CodegenPreviewDiagnostic,
  type CodegenPreviewStatus,
  type CodegenPreviewTarget,
  type CodegenPreviewTargetView,
  type CodegenPreviewView,
} from '../utils/codegen-preview-view.js';
import {
  buildCodegenPreviewBundle,
  isPreviewDownloadable,
  makeCodegenPreviewBundleFilename,
  serializeCodegenPreviewBundle,
} from '../utils/codegen-preview-download.js';
import { downloadText } from '../utils/download.js';
import type { Project } from '@plccopilot/pir';

export type CodegenPreviewPanelTarget = CodegenPreviewTarget | 'all';

export interface CodegenPreviewPanelProps {
  project: Project | null | undefined;
  target: CodegenPreviewPanelTarget;
  /**
   * Optional ISO timestamp embedded in each backend's manifest.
   * Defaults to the helper's deterministic placeholder so non-test
   * sessions don't accidentally pin a real wall clock.
   */
  generatedAt?: string;
}

const STATUS_LABEL: Record<CodegenPreviewStatus, string> = {
  unavailable: 'Unavailable',
  running: 'Running',
  ready: 'Ready',
  ready_with_warnings: 'Warnings',
  blocked: 'Blocked',
  failed: 'Failed',
};

type PanelPhase =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'has-result'; view: CodegenPreviewView; signature: string }
  | { kind: 'stale'; view: CodegenPreviewView };

function selectionSignature(
  project: Project | null | undefined,
  target: CodegenPreviewPanelTarget,
): string {
  if (!project) return `null|${target}`;
  // `Project.id` is stable per applied PIR; tying the signature
  // to the id keeps the panel idle/stale-detection deterministic
  // without pulling in a JSON.stringify on every render.
  return `${project.id}|${target}`;
}

export function CodegenPreviewPanel({
  project,
  target,
  generatedAt,
}: CodegenPreviewPanelProps): JSX.Element {
  const [phase, setPhase] = useState<PanelPhase>({ kind: 'idle' });
  const currentSignature = useMemo(
    () => selectionSignature(project, target),
    [project, target],
  );

  // Project / target changes invalidate any prior preview.
  useEffect(() => {
    setPhase((prev) => {
      if (prev.kind === 'has-result' && prev.signature !== currentSignature) {
        return { kind: 'stale', view: prev.view };
      }
      if (prev.kind === 'stale') {
        // Keep the stale marker so the operator sees they're
        // looking at the previous selection.
        return prev;
      }
      if (prev.kind === 'running') {
        // Discard a running preview if the selection changed under it.
        return { kind: 'idle' };
      }
      return prev;
    });
  }, [currentSignature]);

  const canPreview = !!project;

  const onDownloadBundle = (view: CodegenPreviewView): void => {
    // Pure helpers do all the work; this thin adapter is the only
    // DOM-touching bit. Bundle is built from current preview state —
    // never re-runs the vendor pipeline.
    const bundle = buildCodegenPreviewBundle(view);
    const text = serializeCodegenPreviewBundle(bundle);
    const filename = makeCodegenPreviewBundleFilename(view.selection);
    downloadText(filename, text, 'application/json');
  };

  const onPreview = (): void => {
    if (!project) return;
    setPhase({ kind: 'running' });
    // Preview generation is synchronous in-process; we still go
    // through `setTimeout(0)` so React can paint the "running"
    // state once before the work starts. This keeps the UX honest
    // for the (small) cost of running the vendor pipeline on the
    // main thread; the real Generate flow uses the worker.
    const startTarget = target;
    const startProjectId = project.id;
    setTimeout(() => {
      const view = buildCodegenPreviewView({
        project,
        selection: target,
        generatedAt,
      });
      setPhase((prev) => {
        // If the selection moved while we were running, drop the
        // stale result rather than overwriting newer state.
        if (prev.kind !== 'running') return prev;
        if (
          startProjectId !== (project ? project.id : null) ||
          startTarget !== target
        ) {
          return { kind: 'idle' };
        }
        return {
          kind: 'has-result',
          view,
          signature: currentSignature,
        };
      });
    }, 0);
  };

  return (
    <section
      className="codegen-preview-panel"
      aria-label="Codegen preview"
    >
      <header className="panel-header codegen-preview-header">
        <h3>Codegen preview</h3>
        <div className="codegen-preview-actions">
          <button
            type="button"
            className="btn"
            onClick={onPreview}
            disabled={!canPreview || phase.kind === 'running'}
            aria-label="Preview generated artifacts"
          >
            {phase.kind === 'running'
              ? 'Preparing preview…'
              : phase.kind === 'has-result' || phase.kind === 'stale'
                ? 'Refresh preview'
                : 'Preview generated artifacts'}
          </button>
          {phase.kind === 'has-result' &&
          isPreviewDownloadable({ view: phase.view, stale: false }) ? (
            <button
              type="button"
              className="btn"
              onClick={() => onDownloadBundle(phase.view)}
              aria-label="Download preview bundle"
            >
              Download preview bundle
            </button>
          ) : null}
        </div>
      </header>

      {!canPreview ? (
        <p className="muted">
          Build and apply a PIR before previewing generated code.
        </p>
      ) : phase.kind === 'idle' ? (
        <p className="muted">
          Click <em>Preview generated artifacts</em> to run the vendor
          pipeline in-browser and inspect a short, ephemeral snapshot
          of what Generate would produce. Preview is not codegen and
          does not download files.
        </p>
      ) : phase.kind === 'running' ? (
        <p className="muted">Preparing preview…</p>
      ) : (
        <PreviewBody
          view={phase.view}
          stale={phase.kind === 'stale'}
        />
      )}
    </section>
  );
}

function PreviewBody({
  view,
  stale,
}: {
  view: CodegenPreviewView;
  stale: boolean;
}): JSX.Element {
  return (
    <>
      {stale ? (
        <p className="codegen-preview-stale muted">
          Preview is stale — project or backend changed. Refresh to
          re-run.
        </p>
      ) : null}
      <p className="codegen-preview-summary">{view.summary}</p>
      {view.targets.length === 0 ? null : (
        <div className="codegen-preview-cards">
          {view.targets.map((t) => (
            <PreviewCard key={t.target} view={t} />
          ))}
        </div>
      )}
    </>
  );
}

function PreviewCard({
  view,
}: {
  view: CodegenPreviewTargetView;
}): JSX.Element {
  return (
    <article
      className={`codegen-preview-card preview-status--${view.status}`}
      aria-label={`Preview for ${view.target}`}
    >
      <header className="codegen-preview-card-header">
        <code className="codegen-preview-target">{view.target}</code>
        <span className={`badge preview-badge--${view.status}`}>
          {STATUS_LABEL[view.status]}
        </span>
      </header>
      <p className="codegen-preview-card-summary">{view.summary}</p>

      {view.error ? (
        <p className="codegen-preview-error">
          {view.error.code ? <code>{view.error.code}</code> : null}{' '}
          {view.error.message}
        </p>
      ) : null}

      {view.readinessGroups.length > 0 ? (
        <details className="codegen-preview-readiness">
          <summary>
            Readiness diagnostics ({view.readinessGroups.length} group
            {view.readinessGroups.length === 1 ? '' : 's'})
          </summary>
          <ul>
            {view.readinessGroups.map((g) => (
              <li
                key={`${view.target}-r-${g.code}`}
                className={`readiness-group--${g.severity}`}
              >
                <span className={`badge sev-${g.severity}`}>{g.severity}</span>{' '}
                <code>{g.code}</code>{' '}
                <span className="muted">
                  ({g.items.length} item{g.items.length === 1 ? '' : 's'})
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {view.manifestDiagnostics.length > 0 ? (
        <details className="codegen-preview-manifest">
          <summary>
            Manifest diagnostics ({view.manifestDiagnostics.length})
          </summary>
          <ul>
            {view.manifestDiagnostics.map((d, i) => (
              <ManifestDiagnosticRow
                key={`${view.target}-m-${i}-${d.code}`}
                d={d}
              />
            ))}
          </ul>
        </details>
      ) : null}

      {view.artifacts.length > 0 ? (
        <details className="codegen-preview-artifacts" open>
          <summary>
            {view.artifactCount} artifact{view.artifactCount === 1 ? '' : 's'}
          </summary>
          <ul className="codegen-preview-artifact-list">
            {view.artifacts.map((a) => (
              <ArtifactRow key={`${view.target}-a-${a.path}`} a={a} />
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function ManifestDiagnosticRow({
  d,
}: {
  d: CodegenPreviewDiagnostic;
}): JSX.Element {
  return (
    <li className={`manifest-diag-${d.severity}`}>
      <span className={`badge sev-${d.severity}`}>{d.severity}</span>{' '}
      <code>{d.code}</code>{' '}
      <span className="diag-message">{d.message}</span>
      {d.path ? (
        <p className="diag-path muted">
          path: <code>{d.path}</code>
        </p>
      ) : null}
      {d.hint ? <p className="diag-hint muted">Hint: {d.hint}</p> : null}
    </li>
  );
}

function ArtifactRow({
  a,
}: {
  a: CodegenPreviewArtifactView;
}): JSX.Element {
  return (
    <li className="codegen-preview-artifact-row">
      <header>
        <code className="codegen-preview-artifact-path">{a.path}</code>
        <span className="muted">
          ≈ {a.sizeBytes} bytes{a.truncated ? ' (truncated)' : ''}
        </span>
      </header>
      <details>
        <summary>Show preview</summary>
        <pre className="codegen-preview-snippet">{a.previewText}</pre>
      </details>
    </li>
  );
}
