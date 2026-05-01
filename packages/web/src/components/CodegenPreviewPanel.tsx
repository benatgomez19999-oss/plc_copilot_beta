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

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';

import {
  buildCodegenPreviewView,
  type CodegenPreviewArtifactView,
  type CodegenPreviewDiagnostic,
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
import {
  buildCodegenPreviewDiffBundle,
  createCodegenPreviewDiffFilename,
  isPreviewDiffDownloadable,
  serializeCodegenPreviewDiffBundle,
  type CodegenPreviewDiffBundle,
  type CodegenPreviewDiffBundleArtifactChange,
  type CodegenPreviewDiffBundleDiagnosticChange,
  type CodegenPreviewDiffBundleTarget,
} from '../utils/codegen-preview-diff-download.js';
import {
  parseCodegenPreviewDiffBundleText,
  type ImportedCodegenPreviewDiffView,
} from '../utils/codegen-preview-diff-import.js';
import {
  compareImportedDiffWithCurrentPreview,
  type ArchivedArtifactComparison,
  type ArchivedDiagnosticComparison,
  type ArchivedPreviewComparisonTarget,
  type ArchivedPreviewComparisonView,
} from '../utils/codegen-preview-archive-compare.js';
import {
  buildCodegenPreviewArchiveCompareBundle,
  codegenPreviewArchiveCompareFilename,
  isArchiveCompareDownloadable,
  serializeCodegenPreviewArchiveCompareBundle,
  type CodegenPreviewArchiveCompareBundle,
  type CodegenPreviewArchiveCompareBundleArtifactRow,
  type CodegenPreviewArchiveCompareBundleDiagnosticRow,
  type CodegenPreviewArchiveCompareBundleTarget,
} from '../utils/codegen-preview-archive-compare-download.js';
import {
  parseCodegenPreviewArchiveCompareBundleText,
  type ImportedCodegenPreviewArchiveCompareView,
} from '../utils/codegen-preview-archive-compare-import.js';
import {
  ARTIFACT_DIFF_STATUS_LABEL,
  IMPORTED_DIFF_READ_ONLY_NOTICE,
  PREVIEW_STATUS_LABEL,
  STALE_DIFF_NOTICE,
  STALE_PREVIEW_NOTICE,
  TARGET_DIFF_STATUS_LABEL,
  artifactDiffStatusPolishToken,
  diagnosticChangeStatusPolishToken,
  formatArchivedTargetOneLiner,
  formatArtifactChangesSummary,
  formatDiagnosticChangesSummary,
  formatDiagnosticChangesSummaryFromArtifactDiff,
  formatDiffSampleSummary,
  formatManifestDiagnosticSummary,
  formatPreviewSnippetSummary,
  formatReadinessGroupSummary,
  formatTargetDiffOneLiner,
  previewStatusPolishToken,
  severityPolishToken,
  statusBadgeClass,
  targetDiffStatusPolishToken,
} from '../utils/codegen-preview-panel-view.js';
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
  // Sprint 92 — imported diff bundle (read-only, ephemeral). Lives
  // entirely in React state. Refreshing the browser drops it.
  const [imported, setImported] = useState<ImportedCodegenPreviewDiffView>(
    () => parseCodegenPreviewDiffBundleText(''),
  );
  const [importedFilename, setImportedFilename] = useState<string | null>(
    null,
  );
  // Sprint 94 — archived-vs-current comparison snapshot. The view
  // is built read-only on operator click; the refs alongside let
  // the renderer detect when the underlying inputs have moved
  // since the snapshot was captured (so the section can mark
  // itself stale rather than silently lying).
  const [comparison, setComparison] = useState<{
    view: ArchivedPreviewComparisonView;
    archivedRef: unknown;
    currentRef: CodegenPreviewView;
  } | null>(null);
  // Sprint 96 — imported (read-only) archive-comparison bundle.
  // Lives entirely in React state. Refreshing the browser drops
  // it. Independent of the live comparison snapshot above; the
  // operator can hold both at once.
  const [importedComparison, setImportedComparison] =
    useState<ImportedCodegenPreviewArchiveCompareView>(() =>
      parseCodegenPreviewArchiveCompareBundleText(''),
    );
  const [importedComparisonFilename, setImportedComparisonFilename] =
    useState<string | null>(null);
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

  const onDownloadDiffBundle = (
    previousView: CodegenPreviewView,
    currentView: CodegenPreviewView,
  ): void => {
    // Sprint 91 — diff bundle is built from the already-computed
    // Sprint 90B diff. No vendor pipeline re-run, no full artifact
    // content copied. Same browser adapter as the preview bundle.
    const bundle = buildCodegenPreviewDiffBundle({
      previousView,
      currentView,
    });
    const text = serializeCodegenPreviewDiffBundle(bundle);
    const filename = createCodegenPreviewDiffFilename(bundle);
    downloadText(filename, text, 'application/json');
  };

  const onImportDiffBundle = (
    e: ChangeEvent<HTMLInputElement>,
  ): void => {
    // Sprint 92 — read-only import. The File API lives here in the
    // component; the parser is pure / DOM-free. Never re-runs the
    // vendor pipeline, never touches preview baseline / current,
    // never persists anywhere.
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const filename = file.name;
    file
      .text()
      .then((text) => {
        const view = parseCodegenPreviewDiffBundleText(text);
        setImported(view);
        setImportedFilename(view.status === 'loaded' ? filename : null);
      })
      .catch((err) => {
        // Total parser is the contract; this catch handles File API
        // read errors only (browser-level — disk fault, permissions).
        const message = err instanceof Error ? err.message : String(err);
        setImported({
          status: 'invalid',
          summary: `Could not read file: ${message}`,
          error: `Could not read file: ${message}`,
        });
        setImportedFilename(null);
      });
    // Reset the input so re-importing the same filename re-fires
    // onChange. Without this, picking the same file twice is a
    // no-op.
    e.target.value = '';
  };

  const onClearImportedDiff = (): void => {
    setImported(parseCodegenPreviewDiffBundleText(''));
    setImportedFilename(null);
    setComparison(null);
  };

  const onCompareArchiveWithCurrent = (): void => {
    // Sprint 94 — read-only meta-compare. Build only when the
    // panel actually has both an imported bundle and a successful
    // current preview; the renderer guards the button identically.
    if (imported.status !== 'loaded' || !imported.bundle) return;
    if (phase.kind !== 'has-result') return;
    if (!isPreviewDownloadable({ view: phase.view, stale: false })) return;
    const view = compareImportedDiffWithCurrentPreview({
      importedBundle: imported.bundle,
      currentView: phase.view,
    });
    setComparison({
      view,
      archivedRef: imported.bundle,
      currentRef: phase.view,
    });
  };

  const onClearComparison = (): void => {
    setComparison(null);
  };

  const onImportComparisonBundle = (
    e: ChangeEvent<HTMLInputElement>,
  ): void => {
    // Sprint 96 — read-only import. The File API lives here in
    // the component; the parser is pure / DOM-free. Never
    // re-runs codegen, never touches the live comparison snapshot
    // or any other panel state.
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const filename = file.name;
    file
      .text()
      .then((text) => {
        const view = parseCodegenPreviewArchiveCompareBundleText(text);
        setImportedComparison(view);
        setImportedComparisonFilename(
          view.status === 'loaded' ? filename : null,
        );
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        setImportedComparison({
          status: 'invalid',
          summary: `Could not read file: ${message}`,
          error: `Could not read file: ${message}`,
        });
        setImportedComparisonFilename(null);
      });
    // Reset so re-importing the same filename re-fires onChange.
    e.target.value = '';
  };

  const onClearImportedComparison = (): void => {
    setImportedComparison(parseCodegenPreviewArchiveCompareBundleText(''));
    setImportedComparisonFilename(null);
  };

  const onDownloadComparisonBundle = (
    view: ArchivedPreviewComparisonView,
  ): void => {
    // Sprint 95 — build the bundle from the snapshot the panel
    // already has in state. The vendor pipeline is never re-run,
    // and the comparison is never recomputed here. The wall-clock
    // `createdAt` is captured at click time and lives only inside
    // the JSON the operator saves locally.
    const bundle = buildCodegenPreviewArchiveCompareBundle({
      comparison: view,
      createdAt: new Date().toISOString(),
    });
    const text = serializeCodegenPreviewArchiveCompareBundle(bundle);
    const filename = codegenPreviewArchiveCompareFilename({});
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
          onDownloadDiffBundle={onDownloadDiffBundle}
        />
      )}

      <ImportedCodegenPreviewDiffSection
        imported={imported}
        filename={importedFilename}
        onImport={onImportDiffBundle}
        onClear={onClearImportedDiff}
        canCompare={
          imported.status === 'loaded' &&
          phase.kind === 'has-result' &&
          isPreviewDownloadable({ view: phase.view, stale: false })
        }
        onCompare={onCompareArchiveWithCurrent}
      />

      {comparison ? (
        <ArchivedComparisonSection
          view={comparison.view}
          stale={
            imported.status !== 'loaded' ||
            imported.bundle !== comparison.archivedRef ||
            phase.kind !== 'has-result' ||
            phase.view !== comparison.currentRef
          }
          onClear={onClearComparison}
          onDownload={onDownloadComparisonBundle}
        />
      ) : null}

      <ImportedArchiveComparisonSection
        imported={importedComparison}
        filename={importedComparisonFilename}
        onImport={onImportComparisonBundle}
        onClear={onClearImportedComparison}
      />
    </section>
  );
}

function PreviewBody({
  view,
  stale,
  diffSlots,
  onDownloadDiffBundle,
}: {
  view: CodegenPreviewView;
  stale: boolean;
  diffSlots: DiffSlots;
  onDownloadDiffBundle: (
    previousView: CodegenPreviewView,
    currentView: CodegenPreviewView,
  ) => void;
}): JSX.Element {
  return (
    <>
      {stale ? (
        <p className="codegen-preview-stale">{STALE_PREVIEW_NOTICE}</p>
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
        onDownloadDiffBundle={onDownloadDiffBundle}
      />
    </>
  );
}

function PreviewDiffSection({
  view,
  stale,
  diffSlots,
  onDownloadDiffBundle,
}: {
  view: CodegenPreviewView;
  stale: boolean;
  diffSlots: DiffSlots;
  onDownloadDiffBundle: (
    previousView: CodegenPreviewView,
    currentView: CodegenPreviewView,
  ) => void;
}): JSX.Element | null {
  // Stale views deliberately do not recompute a diff — the
  // operator must refresh first. The text gives them an honest
  // pointer rather than silently disappearing.
  if (stale) {
    return (
      <section className="codegen-preview-diff" aria-label="Live preview diff">
        <h4>Live diff</h4>
        <p className="muted">{STALE_DIFF_NOTICE}</p>
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

  const canDownloadDiff = isPreviewDiffDownloadable({
    previousView: diffSlots.previous,
    currentView: currentForDiff,
    stale: false,
  });

  // Sprint 93 — Expand all / Collapse all. `expandGen` keys the
  // target rows so a click re-mounts every <details> with the
  // requested initial state; afterwards the user can toggle each
  // one freely.
  const [liveExpandGen, setLiveExpandGen] = useState(0);
  const [liveDefaultOpen, setLiveDefaultOpen] = useState(false);
  const visibleTargets = diff.targets.filter((t) => t.status !== 'unchanged');
  const hasExpandableTargets = visibleTargets.length > 0;

  return (
    <section className="codegen-preview-diff" aria-label="Live preview diff">
      <header className="codegen-preview-diff-header">
        <h4>Live diff</h4>
        <div className="codegen-preview-actions">
          {hasExpandableTargets ? (
            <>
              <button
                type="button"
                className="btn btn-subtle"
                onClick={() => {
                  setLiveDefaultOpen(true);
                  setLiveExpandGen((g) => g + 1);
                }}
                aria-label="Expand all live diff target rows"
              >
                Expand all
              </button>
              <button
                type="button"
                className="btn btn-subtle"
                onClick={() => {
                  setLiveDefaultOpen(false);
                  setLiveExpandGen((g) => g + 1);
                }}
                aria-label="Collapse all live diff target rows"
              >
                Collapse all
              </button>
            </>
          ) : null}
          {canDownloadDiff && diffSlots.previous && currentForDiff ? (
            <button
              type="button"
              className="btn"
              onClick={() =>
                onDownloadDiffBundle(diffSlots.previous!, currentForDiff)
              }
              aria-label="Download diff bundle"
            >
              Download diff bundle
            </button>
          ) : null}
        </div>
      </header>
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
          {visibleTargets.map((t) => (
            <PreviewDiffTargetRow
              key={`diff-${t.target}-${liveExpandGen}`}
              target={t}
              defaultOpen={liveDefaultOpen}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function PreviewDiffTargetRow({
  target,
  defaultOpen,
}: {
  target: CodegenPreviewTargetDiff;
  defaultOpen: boolean;
}): JSX.Element {
  const oneLiner = formatTargetDiffOneLiner({
    artifactsAdded: target.counts.artifactsAdded,
    artifactsRemoved: target.counts.artifactsRemoved,
    artifactsChanged: target.counts.artifactsChanged,
    diagnosticsAdded: target.counts.diagnosticsAdded,
    diagnosticsRemoved: target.counts.diagnosticsRemoved,
  });
  const visibleArtifacts = target.artifacts.filter(
    (a) => a.status !== 'unchanged',
  );
  const [artifactsOpen, setArtifactsOpen] = useState(defaultOpen);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(defaultOpen);
  return (
    <article
      className={`codegen-preview-diff-row codegen-preview-diff-row--${target.status}`}
      aria-label={`Diff for ${target.target}`}
    >
      <header className="codegen-preview-diff-row-header">
        <code className="codegen-preview-target">{target.target}</code>
        <span
          className={`${statusBadgeClass(targetDiffStatusPolishToken(target.status))} preview-diff-badge--${target.status}`}
        >
          {TARGET_DIFF_STATUS_LABEL[target.status]}
        </span>
        {target.previousStatus && target.currentStatus &&
        target.previousStatus !== target.currentStatus ? (
          <span className="muted">
            {PREVIEW_STATUS_LABEL[target.previousStatus]} →{' '}
            {PREVIEW_STATUS_LABEL[target.currentStatus]}
          </span>
        ) : null}
      </header>
      <p className="muted">{oneLiner}</p>
      {visibleArtifacts.length > 0 ? (
        <details
          className="codegen-preview-diff-artifacts"
          open={artifactsOpen}
          onToggle={(e) =>
            setArtifactsOpen((e.target as HTMLDetailsElement).open)
          }
        >
          <summary>
            {formatArtifactChangesSummary({
              artifactsAdded: target.counts.artifactsAdded,
              artifactsRemoved: target.counts.artifactsRemoved,
              artifactsChanged: target.counts.artifactsChanged,
            })}
          </summary>
          <ul>
            {visibleArtifacts.map((a) => (
              <PreviewDiffArtifactRow
                key={`${target.target}-diff-${a.path}`}
                artifact={a}
              />
            ))}
          </ul>
        </details>
      ) : null}
      {target.diagnostics.length > 0 ? (
        <details
          className="codegen-preview-diff-diagnostics"
          open={diagnosticsOpen}
          onToggle={(e) =>
            setDiagnosticsOpen((e.target as HTMLDetailsElement).open)
          }
        >
          <summary>
            {formatDiagnosticChangesSummary(target.diagnostics.length)}
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
        <span
          className={`${statusBadgeClass(artifactDiffStatusPolishToken(artifact.status))} preview-diff-badge--${artifact.status}`}
        >
          {ARTIFACT_DIFF_STATUS_LABEL[artifact.status]}
        </span>{' '}
        <code className="codegen-preview-artifact-path">{artifact.path}</code>
      </header>
      {artifact.status === 'changed' && artifact.diff ? (
        <details>
          <summary>
            {formatDiffSampleSummary({
              path: artifact.path,
              truncated: artifact.diff.truncated,
            })}
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
      <span
        className={`${statusBadgeClass(diagnosticChangeStatusPolishToken(d.status))} preview-diff-badge--${d.status}`}
      >
        {d.status === 'added' ? 'Added' : 'Removed'}
      </span>{' '}
      <span
        className={`${statusBadgeClass(severityPolishToken(d.diagnostic.severity))} sev-${d.diagnostic.severity}`}
      >
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
        <span
          className={`${statusBadgeClass(previewStatusPolishToken(view.status))} preview-badge--${view.status}`}
        >
          {PREVIEW_STATUS_LABEL[view.status]}
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
          <summary>{formatReadinessGroupSummary(view.readinessGroups)}</summary>
          <ul>
            {view.readinessGroups.map((g) => (
              <li
                key={`${view.target}-r-${g.code}`}
                className={`readiness-group--${g.severity}`}
              >
                <span
                  className={`${statusBadgeClass(severityPolishToken(g.severity))} sev-${g.severity}`}
                >
                  {g.severity}
                </span>{' '}
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
            {formatManifestDiagnosticSummary(view.manifestDiagnostics)}
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
          <summary>{formatPreviewSnippetSummary(view.artifacts)}</summary>
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
      <span
        className={`${statusBadgeClass(severityPolishToken(d.severity))} sev-${d.severity}`}
      >
        {d.severity}
      </span>{' '}
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

// ---------------------------------------------------------------------------
// Sprint 92 — Imported (read-only) diff section
// ---------------------------------------------------------------------------

function ImportedCodegenPreviewDiffSection({
  imported,
  filename,
  onImport,
  onClear,
  canCompare,
  onCompare,
}: {
  imported: ImportedCodegenPreviewDiffView;
  filename: string | null;
  onImport: (e: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
  canCompare: boolean;
  onCompare: () => void;
}): JSX.Element {
  return (
    <section
      className="codegen-preview-imported-diff"
      aria-label="Archived preview diff"
    >
      <header className="codegen-preview-imported-diff-header">
        <h4>Archived diff</h4>
        <div className="codegen-preview-actions">
          <label className="btn codegen-preview-imported-diff-import">
            Import diff bundle
            <input
              type="file"
              accept="application/json,.json"
              onChange={onImport}
              hidden
            />
          </label>
          {imported.status === 'loaded' ? (
            <button
              type="button"
              className="btn"
              onClick={onCompare}
              disabled={!canCompare}
              aria-label="Compare archived diff with current preview"
              title={
                canCompare
                  ? undefined
                  : 'Run preview before comparing the archived diff with current output.'
              }
            >
              Compare with current preview
            </button>
          ) : null}
          {imported.status === 'loaded' || imported.status === 'invalid' ? (
            <button
              type="button"
              className="btn"
              onClick={onClear}
              aria-label="Clear imported diff"
            >
              Clear imported diff
            </button>
          ) : null}
        </div>
      </header>

      {imported.status === 'empty' ? (
        <p className="muted">{imported.summary}</p>
      ) : null}

      {imported.status === 'invalid' ? (
        <p className="codegen-preview-imported-diff-error">
          {imported.error}
        </p>
      ) : null}

      {imported.status === 'loaded' && imported.bundle ? (
        <>
          <ImportedDiffBody bundle={imported.bundle} filename={filename} />
          {!canCompare ? (
            <p className="codegen-preview-imported-diff-compare-hint muted">
              Run preview before comparing the archived diff with current
              output.
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function ImportedDiffBody({
  bundle,
  filename,
}: {
  bundle: CodegenPreviewDiffBundle;
  filename: string | null;
}): JSX.Element {
  // Sprint 93 — Expand all / Collapse all for archived target rows.
  const [archivedExpandGen, setArchivedExpandGen] = useState(0);
  const [archivedDefaultOpen, setArchivedDefaultOpen] = useState(false);
  const hasTargets = bundle.targets.length > 0;
  return (
    <>
      <p className="codegen-preview-imported-diff-meta muted">
        {filename ? (
          <>
            <strong>{filename}</strong>
            {' — '}
          </>
        ) : null}
        backend <code>{bundle.selection.backend}</code>
        {bundle.selection.previousBackend &&
        bundle.selection.previousBackend !== bundle.selection.backend ? (
          <>
            {' '}(was <code>{bundle.selection.previousBackend}</code>)
          </>
        ) : null}
        {' • snapshot '}
        <code>{bundle.snapshotName}</code>
        {' • '}
        {bundle.targets.length} target{bundle.targets.length === 1 ? '' : 's'}
      </p>
      <p className="codegen-preview-imported-diff-readonly muted">
        {IMPORTED_DIFF_READ_ONLY_NOTICE}
      </p>
      <p
        className={`codegen-preview-diff-summary codegen-preview-diff-state--${
          bundle.state === 'unchanged' ? 'unchanged' : 'changed'
        }`}
      >
        {bundle.summary}
      </p>
      {hasTargets ? (
        <>
          <div className="codegen-preview-actions codegen-preview-archived-controls">
            <button
              type="button"
              className="btn btn-subtle"
              onClick={() => {
                setArchivedDefaultOpen(true);
                setArchivedExpandGen((g) => g + 1);
              }}
              aria-label="Expand all archived diff target rows"
            >
              Expand all
            </button>
            <button
              type="button"
              className="btn btn-subtle"
              onClick={() => {
                setArchivedDefaultOpen(false);
                setArchivedExpandGen((g) => g + 1);
              }}
              aria-label="Collapse all archived diff target rows"
            >
              Collapse all
            </button>
          </div>
          <div className="codegen-preview-diff-targets">
            {bundle.targets.map((t) => (
              <ImportedDiffTargetRow
                key={`imp-${t.target}-${archivedExpandGen}`}
                target={t}
                defaultOpen={archivedDefaultOpen}
              />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function ImportedDiffTargetRow({
  target,
  defaultOpen,
}: {
  target: CodegenPreviewDiffBundleTarget;
  defaultOpen: boolean;
}): JSX.Element {
  const oneLiner = formatArchivedTargetOneLiner(target);
  const [artifactsOpen, setArtifactsOpen] = useState(defaultOpen);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(defaultOpen);
  return (
    <article
      className={`codegen-preview-diff-row codegen-preview-diff-row--${target.targetStatus}`}
      aria-label={`Imported diff for ${target.target}`}
    >
      <header className="codegen-preview-diff-row-header">
        <code className="codegen-preview-target">{target.target}</code>
        <span
          className={`${statusBadgeClass(targetDiffStatusPolishToken(target.targetStatus))} preview-diff-badge--${target.targetStatus}`}
        >
          {TARGET_DIFF_STATUS_LABEL[target.targetStatus]}
        </span>
        {target.previousStatus && target.currentStatus &&
        target.previousStatus !== target.currentStatus ? (
          <span className="muted">
            {target.previousStatus} → {target.currentStatus}
          </span>
        ) : null}
      </header>
      <p className="muted">{oneLiner}</p>
      {target.artifactChanges.length > 0 ? (
        <details
          className="codegen-preview-diff-artifacts"
          open={artifactsOpen}
          onToggle={(e) =>
            setArtifactsOpen((e.target as HTMLDetailsElement).open)
          }
        >
          <summary>
            {formatArtifactChangesSummary({
              artifactsAdded: target.counts.artifactsAdded,
              artifactsRemoved: target.counts.artifactsRemoved,
              artifactsChanged: target.counts.artifactsChanged,
            })}
          </summary>
          <ul>
            {target.artifactChanges.map((a) => (
              <ImportedDiffArtifactRow
                key={`imp-${target.target}-a-${a.path}`}
                artifact={a}
              />
            ))}
          </ul>
        </details>
      ) : null}
      {target.diagnosticChanges.length > 0 ? (
        <details
          className="codegen-preview-diff-diagnostics"
          open={diagnosticsOpen}
          onToggle={(e) =>
            setDiagnosticsOpen((e.target as HTMLDetailsElement).open)
          }
        >
          <summary>
            {formatDiagnosticChangesSummaryFromArtifactDiff(
              // @ts-expect-error — bundle's diagnostic-change shape is a
              // structural subset of CodegenPreviewDiagnosticDiff (only
              // .status is read), so this passthrough is safe.
              target.diagnosticChanges,
            )}
          </summary>
          <ul>
            {target.diagnosticChanges.map((d, i) => (
              <ImportedDiffDiagnosticRow
                key={`imp-${target.target}-d-${i}-${d.code}`}
                d={d}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function ImportedDiffArtifactRow({
  artifact,
}: {
  artifact: CodegenPreviewDiffBundleArtifactChange;
}): JSX.Element {
  return (
    <li
      className={`codegen-preview-diff-artifact codegen-preview-diff-artifact--${artifact.status}`}
    >
      <header>
        <span
          className={`${statusBadgeClass(artifactDiffStatusPolishToken(artifact.status))} preview-diff-badge--${artifact.status}`}
        >
          {ARTIFACT_DIFF_STATUS_LABEL[artifact.status]}
        </span>{' '}
        <code className="codegen-preview-artifact-path">{artifact.path}</code>
      </header>
      {artifact.status === 'changed' && artifact.diff ? (
        <details>
          <summary>
            {formatDiffSampleSummary({
              path: artifact.path,
              truncated: artifact.diff.truncated,
            })}
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

function ImportedDiffDiagnosticRow({
  d,
}: {
  d: CodegenPreviewDiffBundleDiagnosticChange;
}): JSX.Element {
  return (
    <li className={`codegen-preview-diff-diagnostic preview-diff-${d.status}`}>
      <span
        className={`${statusBadgeClass(diagnosticChangeStatusPolishToken(d.status))} preview-diff-badge--${d.status}`}
      >
        {d.status === 'added' ? 'Added' : 'Removed'}
      </span>{' '}
      <span
        className={`${statusBadgeClass(severityPolishToken(d.severity))} sev-${d.severity}`}
      >
        {d.severity}
      </span>{' '}
      <code>{d.code}</code>{' '}
      <span className="diag-message">{d.message}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Sprint 94 — Archived diff vs. current preview comparison section
// ---------------------------------------------------------------------------

const COMPARISON_STATE_LABEL: Record<
  ArchivedPreviewComparisonView['state'],
  string
> = {
  'no-archived-diff': 'No archived diff',
  'no-current-preview': 'No current preview',
  'selection-mismatch': 'Selection mismatch',
  'unchanged-against-archive': 'Same as archive',
  'changed-against-archive': 'Changed vs archive',
  'partially-comparable': 'Partial overlap',
};

function comparisonStatePolishToken(
  state: ArchivedPreviewComparisonView['state'],
): 'unchanged' | 'changed' | 'warning' | 'unavailable' | 'info' {
  switch (state) {
    case 'unchanged-against-archive':
      return 'unchanged';
    case 'changed-against-archive':
      return 'changed';
    case 'partially-comparable':
      return 'info';
    case 'selection-mismatch':
      return 'warning';
    case 'no-archived-diff':
    case 'no-current-preview':
      return 'unavailable';
  }
}

function ArchivedComparisonSection({
  view,
  stale,
  onClear,
  onDownload,
}: {
  view: ArchivedPreviewComparisonView;
  stale: boolean;
  onClear: () => void;
  onDownload: (view: ArchivedPreviewComparisonView) => void;
}): JSX.Element {
  const [expandGen, setExpandGen] = useState(0);
  const [defaultOpen, setDefaultOpen] = useState(false);
  const canDownload = isArchiveCompareDownloadable({
    comparison: view,
    stale,
  });
  return (
    <section
      className="codegen-preview-archive-compare"
      aria-label="Archived diff vs current preview comparison"
    >
      <header className="codegen-preview-archive-compare-header">
        <h4>Archived vs current preview</h4>
        <div className="codegen-preview-actions">
          {view.targets.length > 0 ? (
            <>
              <button
                type="button"
                className="btn btn-subtle"
                onClick={() => {
                  setDefaultOpen(true);
                  setExpandGen((g) => g + 1);
                }}
                aria-label="Expand all comparison target rows"
              >
                Expand all
              </button>
              <button
                type="button"
                className="btn btn-subtle"
                onClick={() => {
                  setDefaultOpen(false);
                  setExpandGen((g) => g + 1);
                }}
                aria-label="Collapse all comparison target rows"
              >
                Collapse all
              </button>
            </>
          ) : null}
          {canDownload ? (
            <button
              type="button"
              className="btn"
              onClick={() => onDownload(view)}
              aria-label="Download comparison bundle"
            >
              Download comparison bundle
            </button>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={onClear}
            aria-label="Clear comparison"
          >
            Clear comparison
          </button>
        </div>
      </header>
      {stale ? (
        <p className="codegen-preview-archive-compare-stale muted">
          Comparison is stale — the archived diff or current preview moved
          since this snapshot. Click <em>Compare with current preview</em>{' '}
          again to refresh.
        </p>
      ) : null}
      <p
        className={`codegen-preview-archive-compare-summary ${statusBadgeClass(
          comparisonStatePolishToken(view.state),
        )}`}
      >
        {COMPARISON_STATE_LABEL[view.state]} — {view.summary}
      </p>
      <p className="codegen-preview-archive-compare-readonly muted">
        Comparison is read-only. It does not modify the archived diff,
        current preview, Generate, or saved session. Downloaded
        comparison bundles contain hashes, statuses, and capped
        diagnostic / artifact metadata only — not generated artifact
        content.
      </p>
      {view.targets.length > 0 ? (
        <div className="codegen-preview-archive-compare-targets">
          {view.targets.map((t) => (
            <ArchivedComparisonTargetRow
              key={`compare-${t.target}-${expandGen}`}
              target={t}
              defaultOpen={defaultOpen}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ArchivedComparisonTargetRow({
  target,
  defaultOpen,
}: {
  target: ArchivedPreviewComparisonTarget;
  defaultOpen: boolean;
}): JSX.Element {
  const [artifactsOpen, setArtifactsOpen] = useState(defaultOpen);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(defaultOpen);
  const c = target.counts;
  const aDelta =
    c.artifactsChanged + c.artifactsMissingCurrent + c.artifactsNewCurrent;
  const artifactPart =
    aDelta > 0
      ? `${c.artifactsChanged} changed, ${c.artifactsMissingCurrent} missing, ${c.artifactsNewCurrent} new`
      : `${c.artifactsSame} same`;
  const dDelta = c.diagnosticsResolved + c.diagnosticsNewCurrent;
  const diagPart =
    dDelta > 0
      ? `${c.diagnosticsStillPresent} still present, ${c.diagnosticsResolved} resolved, ${c.diagnosticsNewCurrent} new`
      : `${c.diagnosticsStillPresent} still present`;
  return (
    <article
      className={`codegen-preview-archive-compare-target codegen-preview-archive-compare-target--${target.status}`}
      aria-label={`Comparison for ${target.target}`}
    >
      <header className="codegen-preview-diff-row-header">
        <code className="codegen-preview-target">{target.target}</code>
        <span
          className={`${statusBadgeClass(
            target.status === 'same'
              ? 'unchanged'
              : target.status === 'changed'
                ? 'changed'
                : target.status === 'not-comparable'
                  ? 'warning'
                  : 'info',
          )}`}
        >
          {target.status.replace('-', ' ')}
        </span>
        {target.archivedRecordedCurrentStatus &&
        target.currentStatus &&
        target.archivedRecordedCurrentStatus !== target.currentStatus ? (
          <span className="muted">
            archived: {target.archivedRecordedCurrentStatus} → today:{' '}
            {target.currentStatus}
          </span>
        ) : null}
      </header>
      <p className="muted">{target.summary}</p>
      {target.artifactComparisons.length > 0 ? (
        <details
          className="codegen-preview-archive-compare-list"
          open={artifactsOpen}
          onToggle={(e) =>
            setArtifactsOpen((e.target as HTMLDetailsElement).open)
          }
        >
          <summary>
            Artifacts · {artifactPart}
          </summary>
          <ul>
            {target.artifactComparisons.map((a) => (
              <ArchivedComparisonArtifactRow
                key={`compare-${target.target}-a-${a.path}`}
                artifact={a}
              />
            ))}
          </ul>
        </details>
      ) : null}
      {target.diagnosticComparisons.length > 0 ? (
        <details
          className="codegen-preview-archive-compare-list"
          open={diagnosticsOpen}
          onToggle={(e) =>
            setDiagnosticsOpen((e.target as HTMLDetailsElement).open)
          }
        >
          <summary>
            Diagnostics · {diagPart}
          </summary>
          <ul>
            {target.diagnosticComparisons.map((d, i) => (
              <ArchivedComparisonDiagnosticRow
                key={`compare-${target.target}-d-${i}-${d.diagnostic.code}`}
                d={d}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function ArchivedComparisonArtifactRow({
  artifact,
}: {
  artifact: ArchivedArtifactComparison;
}): JSX.Element {
  const token =
    artifact.status === 'same-hash'
      ? 'unchanged'
      : artifact.status === 'changed-hash'
        ? 'changed'
        : artifact.status === 'missing-current'
          ? 'removed'
          : artifact.status === 'new-current'
            ? 'added'
            : 'warning';
  return (
    <li
      className={`codegen-preview-archive-compare-artifact codegen-preview-archive-compare-artifact--${artifact.status}`}
    >
      <span className={statusBadgeClass(token)}>
        {artifact.status.replace('-', ' ')}
      </span>{' '}
      <code className="codegen-preview-artifact-path">{artifact.path}</code>
      {artifact.archivedHash || artifact.currentHash ? (
        <span className="muted codegen-preview-archive-compare-hashes">
          {' '}
          {artifact.archivedHash ? `archived ${artifact.archivedHash}` : ''}
          {artifact.archivedHash && artifact.currentHash ? ' → ' : ''}
          {artifact.currentHash ? `current ${artifact.currentHash}` : ''}
        </span>
      ) : null}
    </li>
  );
}

function ArchivedComparisonDiagnosticRow({
  d,
}: {
  d: ArchivedDiagnosticComparison;
}): JSX.Element {
  const token =
    d.status === 'still-present'
      ? 'unchanged'
      : d.status === 'resolved'
        ? 'removed'
        : d.status === 'new-current'
          ? 'added'
          : 'warning';
  return (
    <li className="codegen-preview-archive-compare-diagnostic">
      <span className={statusBadgeClass(token)}>
        {d.status.replace('-', ' ')}
      </span>{' '}
      <span
        className={`${statusBadgeClass(severityPolishToken(d.diagnostic.severity))} sev-${d.diagnostic.severity}`}
      >
        {d.diagnostic.severity}
      </span>{' '}
      <code>{d.diagnostic.code}</code>{' '}
      <span className="diag-message">{d.diagnostic.message}</span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Sprint 96 — Imported (read-only) archive-comparison section
// ---------------------------------------------------------------------------

function ImportedArchiveComparisonSection({
  imported,
  filename,
  onImport,
  onClear,
}: {
  imported: ImportedCodegenPreviewArchiveCompareView;
  filename: string | null;
  onImport: (e: ChangeEvent<HTMLInputElement>) => void;
  onClear: () => void;
}): JSX.Element {
  return (
    <section
      className="codegen-preview-imported-comparison"
      aria-label="Archived preview comparison"
    >
      <header className="codegen-preview-imported-comparison-header">
        <h4>Archived comparison</h4>
        <div className="codegen-preview-actions">
          <label className="btn codegen-preview-imported-comparison-import">
            Import comparison bundle
            <input
              type="file"
              accept="application/json,.json"
              onChange={onImport}
              hidden
            />
          </label>
          {imported.status === 'loaded' || imported.status === 'invalid' ? (
            <button
              type="button"
              className="btn"
              onClick={onClear}
              aria-label="Clear imported comparison"
            >
              Clear imported comparison
            </button>
          ) : null}
        </div>
      </header>

      {imported.status === 'empty' ? (
        <p className="muted">{imported.summary}</p>
      ) : null}

      {imported.status === 'invalid' ? (
        <p className="codegen-preview-imported-comparison-error">
          {imported.error}
        </p>
      ) : null}

      {imported.status === 'loaded' && imported.bundle ? (
        <ImportedArchiveComparisonBody
          bundle={imported.bundle}
          filename={filename}
        />
      ) : null}
    </section>
  );
}

function ImportedArchiveComparisonBody({
  bundle,
  filename,
}: {
  bundle: CodegenPreviewArchiveCompareBundle;
  filename: string | null;
}): JSX.Element {
  const [expandGen, setExpandGen] = useState(0);
  const [defaultOpen, setDefaultOpen] = useState(false);
  return (
    <>
      <p className="codegen-preview-imported-comparison-meta muted">
        {filename ? (
          <>
            <strong>{filename}</strong>
            {' — '}
          </>
        ) : null}
        {bundle.selection.archivedBackend ? (
          <>
            archived backend{' '}
            <code>{bundle.selection.archivedBackend}</code>
          </>
        ) : null}
        {bundle.selection.archivedBackend &&
        bundle.selection.currentBackend &&
        bundle.selection.archivedBackend !== bundle.selection.currentBackend ? (
          <>
            {' '}vs current{' '}
            <code>{bundle.selection.currentBackend}</code>
          </>
        ) : null}
        {' • snapshot '}
        <code>{bundle.snapshotName}</code>
        {' • '}
        <span>{bundle.createdAt}</span>
        {' • '}
        {bundle.targets.length} target{bundle.targets.length === 1 ? '' : 's'}
      </p>
      <p className="codegen-preview-imported-comparison-readonly muted">
        Imported comparison is read-only. It does not affect the
        archived diff, current preview, Generate, or saved session.
      </p>
      <p
        className={`codegen-preview-archive-compare-summary ${statusBadgeClass(
          bundle.state === 'unchanged-against-archive'
            ? 'unchanged'
            : bundle.state === 'changed-against-archive'
              ? 'changed'
              : bundle.state === 'partially-comparable'
                ? 'info'
                : bundle.state === 'selection-mismatch'
                  ? 'warning'
                  : 'unavailable',
        )}`}
      >
        {bundle.summary}
      </p>
      {bundle.targets.length > 0 ? (
        <>
          <div className="codegen-preview-actions codegen-preview-archived-controls">
            <button
              type="button"
              className="btn btn-subtle"
              onClick={() => {
                setDefaultOpen(true);
                setExpandGen((g) => g + 1);
              }}
              aria-label="Expand all imported comparison target rows"
            >
              Expand all
            </button>
            <button
              type="button"
              className="btn btn-subtle"
              onClick={() => {
                setDefaultOpen(false);
                setExpandGen((g) => g + 1);
              }}
              aria-label="Collapse all imported comparison target rows"
            >
              Collapse all
            </button>
          </div>
          <div className="codegen-preview-archive-compare-targets">
            {bundle.targets.map((t) => (
              <ImportedArchiveComparisonTargetRow
                key={`imp-cmp-${t.target}-${expandGen}`}
                target={t}
                defaultOpen={defaultOpen}
              />
            ))}
          </div>
        </>
      ) : null}
    </>
  );
}

function ImportedArchiveComparisonTargetRow({
  target,
  defaultOpen,
}: {
  target: CodegenPreviewArchiveCompareBundleTarget;
  defaultOpen: boolean;
}): JSX.Element {
  const [artifactsOpen, setArtifactsOpen] = useState(defaultOpen);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(defaultOpen);
  const c = target.counts;
  const aDelta =
    c.artifactsChanged + c.artifactsMissingCurrent + c.artifactsNewCurrent;
  const artifactPart =
    aDelta > 0
      ? `${c.artifactsChanged} changed, ${c.artifactsMissingCurrent} missing, ${c.artifactsNewCurrent} new`
      : `${c.artifactsSame} same`;
  const dDelta = c.diagnosticsResolved + c.diagnosticsNewCurrent;
  const diagPart =
    dDelta > 0
      ? `${c.diagnosticsStillPresent} still present, ${c.diagnosticsResolved} resolved, ${c.diagnosticsNewCurrent} new`
      : `${c.diagnosticsStillPresent} still present`;
  const targetToken =
    target.status === 'same'
      ? 'unchanged'
      : target.status === 'changed'
        ? 'changed'
        : target.status === 'not-comparable'
          ? 'warning'
          : 'info';
  return (
    <article
      className={`codegen-preview-archive-compare-target codegen-preview-archive-compare-target--${target.status}`}
      aria-label={`Imported comparison for ${target.target}`}
    >
      <header className="codegen-preview-diff-row-header">
        <code className="codegen-preview-target">{target.target}</code>
        <span className={statusBadgeClass(targetToken)}>
          {target.status.replace('-', ' ')}
        </span>
        {target.archivedRecordedCurrentStatus &&
        target.currentStatus &&
        target.archivedRecordedCurrentStatus !== target.currentStatus ? (
          <span className="muted">
            archived: {target.archivedRecordedCurrentStatus} → today:{' '}
            {target.currentStatus}
          </span>
        ) : null}
      </header>
      <p className="muted">{target.summary}</p>
      {target.artifactComparisons.length > 0 ? (
        <details
          className="codegen-preview-archive-compare-list"
          open={artifactsOpen}
          onToggle={(e) =>
            setArtifactsOpen((e.target as HTMLDetailsElement).open)
          }
        >
          <summary>Artifacts · {artifactPart}</summary>
          <ul>
            {target.artifactComparisons.map((a) => (
              <ImportedArchiveComparisonArtifactRow
                key={`imp-cmp-${target.target}-a-${a.path}`}
                artifact={a}
              />
            ))}
          </ul>
        </details>
      ) : null}
      {target.diagnosticComparisons.length > 0 ? (
        <details
          className="codegen-preview-archive-compare-list"
          open={diagnosticsOpen}
          onToggle={(e) =>
            setDiagnosticsOpen((e.target as HTMLDetailsElement).open)
          }
        >
          <summary>Diagnostics · {diagPart}</summary>
          <ul>
            {target.diagnosticComparisons.map((d, i) => (
              <ImportedArchiveComparisonDiagnosticRow
                key={`imp-cmp-${target.target}-d-${i}-${d.code}`}
                d={d}
              />
            ))}
          </ul>
        </details>
      ) : null}
    </article>
  );
}

function ImportedArchiveComparisonArtifactRow({
  artifact,
}: {
  artifact: CodegenPreviewArchiveCompareBundleArtifactRow;
}): JSX.Element {
  const token =
    artifact.status === 'same-hash'
      ? 'unchanged'
      : artifact.status === 'changed-hash'
        ? 'changed'
        : artifact.status === 'missing-current'
          ? 'removed'
          : artifact.status === 'new-current'
            ? 'added'
            : 'warning';
  return (
    <li
      className={`codegen-preview-archive-compare-artifact codegen-preview-archive-compare-artifact--${artifact.status}`}
    >
      <span className={statusBadgeClass(token)}>
        {artifact.status.replace('-', ' ')}
      </span>{' '}
      <code className="codegen-preview-artifact-path">{artifact.path}</code>
      {artifact.archivedHash || artifact.currentHash ? (
        <span className="muted codegen-preview-archive-compare-hashes">
          {' '}
          {artifact.archivedHash ? `archived ${artifact.archivedHash}` : ''}
          {artifact.archivedHash && artifact.currentHash ? ' → ' : ''}
          {artifact.currentHash ? `current ${artifact.currentHash}` : ''}
        </span>
      ) : null}
    </li>
  );
}

function ImportedArchiveComparisonDiagnosticRow({
  d,
}: {
  d: CodegenPreviewArchiveCompareBundleDiagnosticRow;
}): JSX.Element {
  const token =
    d.status === 'still-present'
      ? 'unchanged'
      : d.status === 'resolved'
        ? 'removed'
        : d.status === 'new-current'
          ? 'added'
          : 'warning';
  return (
    <li className="codegen-preview-archive-compare-diagnostic">
      <span className={statusBadgeClass(token)}>
        {d.status.replace('-', ' ')}
      </span>{' '}
      <span
        className={`${statusBadgeClass(severityPolishToken(d.severity))} sev-${d.severity}`}
      >
        {d.severity}
      </span>{' '}
      <code>{d.code}</code>{' '}
      <span className="diag-message">{d.message}</span>
    </li>
  );
}
