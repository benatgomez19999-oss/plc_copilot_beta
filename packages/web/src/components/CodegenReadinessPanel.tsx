// Sprint 87B — Codegen readiness panel.
//
// A thin renderer of `buildCodegenReadinessView`. Lives next to
// the BackendSelector / Generate area in App.tsx so the
// operator sees readiness BEFORE pressing Generate.
//
// The component is intentionally dumb:
//   - takes a `project` + `target` (or `'all'` for the
//     multi-target overview),
//   - delegates everything to the pure helper,
//   - renders a small status badge + grouped diagnostics.
//
// No DOM tooling assumptions: the existing web test suite is
// node-mode + helper-level; coverage for the rendering shape
// happens via the helper spec.

import { useMemo } from 'react';

import {
  buildCodegenReadinessView,
  type CodegenReadinessView,
} from '../utils/codegen-readiness-view.js';
import {
  READINESS_STATUS_LABEL,
  readinessStatusPolishToken,
  severityPolishToken,
  statusBadgeClass,
} from '../utils/codegen-preview-panel-view.js';
import type { CodegenTarget } from '@plccopilot/codegen-core';
import type { Project } from '@plccopilot/pir';

export type CodegenReadinessPanelTarget = CodegenTarget | 'all';

export interface CodegenReadinessPanelProps {
  project: Project | null | undefined;
  /**
   * One of `'siemens'`, `'codesys'`, `'rockwell'`, or `'all'` to
   * stack the three vendor targets in one panel.
   */
  target: CodegenReadinessPanelTarget;
}

const VENDOR_TARGETS: ReadonlyArray<CodegenTarget> = [
  'siemens',
  'codesys',
  'rockwell',
];

export function CodegenReadinessPanel({
  project,
  target,
}: CodegenReadinessPanelProps): JSX.Element {
  const views = useMemo<ReadonlyArray<CodegenReadinessView>>(() => {
    if (target === 'all') {
      return VENDOR_TARGETS.map((t) =>
        buildCodegenReadinessView({ project: project ?? null, target: t }),
      );
    }
    return [buildCodegenReadinessView({ project: project ?? null, target })];
  }, [project, target]);

  return (
    <section
      className="codegen-readiness-panel"
      aria-label="Codegen readiness"
    >
      <header className="panel-header">
        <h3>Codegen readiness</h3>
      </header>
      <div className="codegen-readiness-cards">
        {views.map((view) => (
          <ReadinessCard key={view.target} view={view} />
        ))}
      </div>
    </section>
  );
}

function ReadinessCard({ view }: { view: CodegenReadinessView }): JSX.Element {
  return (
    <article
      className={`codegen-readiness-card readiness-status--${view.status}`}
      aria-label={`Readiness for ${view.target}`}
    >
      <header className="codegen-readiness-card-header">
        <code className="codegen-readiness-target">{view.target}</code>
        <span
          className={`${statusBadgeClass(readinessStatusPolishToken(view.status))} readiness-badge--${view.status}`}
        >
          {READINESS_STATUS_LABEL[view.status]}
        </span>
      </header>
      <p className="codegen-readiness-summary">{view.summary}</p>
      {view.groups.length === 0 ? null : (
        <ul className="codegen-readiness-groups">
          {view.groups.map((group) => (
            <li
              key={`${view.target}-${group.severity}-${group.code}`}
              className={`codegen-readiness-group readiness-group--${group.severity}`}
            >
              <header className="codegen-readiness-group-header">
                <span
                  className={`${statusBadgeClass(severityPolishToken(group.severity))} sev-${group.severity}`}
                >
                  {group.severity}
                </span>
                <code className="diag-code">{group.code}</code>
                <span className="codegen-readiness-group-title">
                  {group.title}
                </span>
                <span className="muted">
                  ({group.items.length} item
                  {group.items.length === 1 ? '' : 's'})
                </span>
              </header>
              <ul className="codegen-readiness-items">
                {group.items.map((item, i) => (
                  <li
                    key={`${view.target}-${group.code}-${i}`}
                    className="codegen-readiness-item"
                  >
                    <p className="diag-message">{item.message}</p>
                    {item.path ? (
                      <p className="diag-path muted">
                        path: <code>{item.path}</code>
                      </p>
                    ) : null}
                    {item.stationId ? (
                      <p className="diag-target muted">
                        station: <code>{item.stationId}</code>
                      </p>
                    ) : null}
                    {item.symbol ? (
                      <p className="diag-target muted">
                        symbol: <code>{item.symbol}</code>
                      </p>
                    ) : null}
                    {item.hint ? (
                      <p className="diag-hint muted">Hint: {item.hint}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}
