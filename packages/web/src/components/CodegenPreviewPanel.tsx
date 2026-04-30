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
import {
  buildCodegenPreviewDiff,
  type CodegenPreviewArtifactDiff,
  type CodegenPreviewDiagnosticDiff,
  type CodegenPreviewDiffView,
  type CodegenPreviewTargetDiff,
} from '../utils/codegen-preview-diff.js';
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

/**
 * Sprint 90B — diff baseline state. Ephemeral React state only:
 *   - `previous` is the prior successful preview the operator saw
 *     in this React session.
 *   - `current` is the most recent successful preview.
 * Both are advanced atomically when a NEW successful preview lands;
 * a failed / blocked / unavailable refresh leaves the slots
 * untouched (the baseline does not regress on a bad refresh). Lost
 * on page reload — never persisted.
 */
interface DiffSlots {
  previous: CodegenPreviewView | null;
  current: CodegenPreviewView | null;
}

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
  const [diffSlots, setDiffSlots] = useState<DiffSlots>({
    previous: null,
    current: null,
  });
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
      // Sprint 90B — promote a *successful* preview into the diff
      // slots: the prior `current` becomes the new `previous`. A
      // failed / blocked / unavailable refresh leaves the slots
      // untouched so the operator's baseline does not regress on a
      // bad refresh. The downloadability gate is the same one the
      // Download bundle button uses, which keeps the two panels
      // honest about what counts as "successful".
      const successful = isPreviewDownloadable({ view, stale: false });
      if (successful) {
        setDiffSlots((slots) => ({
          previous: slots.current,
          current: view,
        }));
      }
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
          diffSlots={diffSlots}
        />
      )}
    </section>
  );
}

function PreviewBody({
  view,
  stale,
  diffSlots,
}: {
  view: CodegenPreviewView;
  stale: boolean;
  diffSlots: DiffSlots;
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
      <PreviewDiffSection
        view={view}
        stale={stale}
        diffSlots={diffSlots}
      />
    </>
  );
}

function PreviewDiffSection({
  view,
  stale,
  diffSlots,
}: {
  view: CodegenPreviewView;
  stale: boolean;
  diffSlots: DiffSlots;
}): JSX.Element | null {
  // Stale views deliberately do not recompute a diff — the
  // operator must refresh first. The text gives them an honest
  // pointer rather than silently disappearing.
  if (stale) {
    return (
      <section className="codegen-preview-diff" aria-label="Preview diff">
        <h4>Preview diff</h4>
        <p className="muted">
          Diff is paused while the preview is stale. Refresh the
          preview to re-compare against the previous successful run.
        </p>
      </section>
    );
  }

  // The diff helper compares against the *previous successful*
  // view. When the just-rendered view is itself blocked / failed /
  // unavailable, we hand the helper `null` for the current side so
  // it never invents artifact diffs on a failed run.
  const currentForDiff =
    isPreviewDownloadable({ view, stale: false }) ? view : null;
  const diff = buildCodegenPreviewDiff(
    diffSlots.previous,
    currentForDiff ?? diffSlots.current,
  );

  return (
    <section className="codegen-preview-diff" aria-label="Preview diff">
      <h4>Preview diff</h4>
      <p
        className={`codegen-preview-diff-summary codegen-preview-diff-state--${diff.state}`}
      >
        {diff.headline}
      </p>
      {!currentForDiff && diffSlots.current ? (
        <p className="muted">
          Current preview produced no successful target — comparing
          against the previous successful preview is not meaningful.
        </p>
      ) : null}
      {diff.state === 'changed' ? (
        <div className="codegen-preview-diff-targets">
          {diff.targets
            .filter((t) => t.status !== 'unchanged')
            .map((t) => (
              <PreviewDiffTargetRow key={`diff-${t.target}`} target={t} />
            ))}
        </div>
      ) : null}
    </section>
  );
}

function PreviewDiffTargetRow({
  target,
}: {
  target: CodegenPreviewTargetDiff;
}): JSX.Element {
  const c = target.counts;
  const artifactPart =
    c.artifactsAdded + c.artifactsRemoved + c.artifactsChanged > 0
      ? `${c.artifactsAdded} added, ${c.artifactsRemoved} removed, ${c.artifactsChanged} changed`
      : 'no artifact changes';
  const diagPart =
    c.diagnosticsAdded + c.diagnosticsRemoved > 0
      ? `${c.diagnosticsAdded + c.diagnosticsRemoved} diagnostic change${
          c.diagnosticsAdded + c.diagnosticsRemoved === 1 ? '' : 's'
        }`
      : 'no diagnostic changes';
  return (
    <article
      className={`codegen-preview-diff-row codegen-preview-diff-row--${target.status}`}
      aria-label={`Diff for ${target.target}`}
    >
      <header className="codegen-preview-diff-row-header">
        <code className="codegen-preview-target">{target.target}</code>
        <span className={`badge preview-diff-badge--${target.status}`}>
          {target.status.replace('_', ' ')}
        </span>
        {target.previousStatus && target.currentStatus &&
        target.previousStatus !== target.currentStatus ? (
          <span className="muted">
            {STATUS_LABEL[target.previousStatus]} →{' '}
            {STATUS_LABEL[target.currentStatus]}
          </span>
        ) : null}
      </header>
      <p className="muted">
        {artifactPart}; {diagPart}.
      </p>
      {target.artifacts.some((a) => a.status !== 'unchanged') ? (
        <details className="codegen-preview-diff-artifacts">
          <summary>Artifact changes</summary>
          <ul>
            {target.artifacts
              .filter((a) => a.status !== 'unchanged')
              .map((a) => (
                <PreviewDiffArtifactRow
                  key={`${target.target}-diff-${a.path}`}
                  artifact={a}
                />
              ))}
          </ul>
        </details>
      ) : null}
      {target.diagnostics.length > 0 ? (
        <details className="codegen-preview-diff-diagnostics">
          <summary>
            Diagnostic changes ({target.diagnostics.length})
          </summary>
          <ul>
            {target.diagnostics.map((d, i) => (
              <PreviewDiffDiagnosticRow
                key={`${target.target}-diff-d-${i}-${d.diagnostic.code}`}
                d={d}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function PreviewDiffArtifactRow({
  artifact,
}: {
  artifact: CodegenPreviewArtifactDiff;
}): JSX.Element {
  return (
    <li
      className={`codegen-preview-diff-artifact codegen-preview-diff-artifact--${artifact.status}`}
    >
      <header>
        <span className={`badge preview-diff-badge--${artifact.status}`}>
          {artifact.status}
        </span>{' '}
        <code className="codegen-preview-artifact-path">{artifact.path}</code>
      </header>
      {artifact.status === 'changed' && artifact.diff ? (
        <details>
          <summary>
            Show diff sample
            {artifact.diff.truncated ? ' (truncated)' : ''}
          </summary>
          <pre className="codegen-preview-diff-snippet">
            {artifact.diff.lines
              .map((l) => {
                const sigil =
                  l.status === 'added'
                    ? '+'
                    : l.status === 'removed'
                      ? '-'
                      : ' ';
                return `${sigil} ${l.text}`;
              })
              .join('\n')}
          </pre>
        </details>
      ) : null}
    </li>
  );
}

function PreviewDiffDiagnosticRow({
  d,
}: {
  d: CodegenPreviewDiagnosticDiff;
}): JSX.Element {
  return (
    <li className={`codegen-preview-diff-diagnostic preview-diff-${d.status}`}>
      <span className={`badge preview-diff-badge--${d.status}`}>
        {d.status}
      </span>{' '}
      <span className={`badge sev-${d.diagnostic.severity}`}>
        {d.diagnostic.severity}
      </span>{' '}
      <code>{d.diagnostic.code}</code>{' '}
      <span className="diag-message">{d.diagnostic.message}</span>
    </li>
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
