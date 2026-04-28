// Sprint 77 — diagnostics panel for the PIR build step. Mirrors
// the Sprint 75 ElectricalDiagnosticsList shape but takes the
// builder's PirBuildDiagnostic[] (which has an extra `path` /
// `candidateId` field). Severity filter chips + per-row badge.

import { useMemo, useState } from 'react';
import type { PirBuildDiagnostic } from '@plccopilot/electrical-ingest';

const SEVERITIES: PirBuildDiagnostic['severity'][] = [
  'error',
  'warning',
  'info',
];

export interface BuildDiagnosticsPanelProps {
  diagnostics: ReadonlyArray<PirBuildDiagnostic>;
}

export function BuildDiagnosticsPanel({
  diagnostics,
}: BuildDiagnosticsPanelProps): JSX.Element {
  const [filter, setFilter] = useState<PirBuildDiagnostic['severity'] | null>(null);

  const counts = useMemo(() => {
    const out: Record<PirBuildDiagnostic['severity'], number> = {
      error: 0,
      warning: 0,
      info: 0,
    };
    for (const d of diagnostics) out[d.severity]++;
    return out;
  }, [diagnostics]);

  const visible = useMemo(
    () =>
      filter === null
        ? [...diagnostics]
        : diagnostics.filter((d) => d.severity === filter),
    [diagnostics, filter],
  );

  return (
    <section className="build-diagnostics" aria-label="PIR build diagnostics">
      <header className="panel-header">
        <h3>PIR build diagnostics</h3>
        <div className="filter-chips" role="toolbar" aria-label="Filter build diagnostics by severity">
          <button
            type="button"
            className={`filter-chip ${filter === null ? 'is-active' : ''}`}
            onClick={() => setFilter(null)}
            aria-pressed={filter === null}
          >
            All ({diagnostics.length})
          </button>
          {SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              className={`filter-chip filter-chip--${s} ${filter === s ? 'is-active' : ''}`}
              onClick={() => setFilter(filter === s ? null : s)}
              aria-pressed={filter === s}
            >
              {s} ({counts[s]})
            </button>
          ))}
        </div>
      </header>

      {visible.length === 0 ? (
        <p className="muted">
          No build diagnostics{filter ? ` at severity "${filter}"` : ''}.
        </p>
      ) : (
        <ul className="build-diagnostics-list">
          {visible.map((d, i) => (
            <li
              key={`${d.code}-${i}`}
              className={`diag-item diag-item--${d.severity}`}
            >
              <header className="diag-item-header">
                <span className={`badge sev-${d.severity}`}>{d.severity}</span>
                <code className="diag-code">{d.code}</code>
              </header>
              <p className="diag-message">{d.message}</p>
              {d.candidateId ? (
                <p className="diag-target muted">
                  candidate: <code>{d.candidateId}</code>
                </p>
              ) : null}
              {d.path ? (
                <p className="diag-path muted">
                  path: <code>{d.path}</code>
                </p>
              ) : null}
              {d.sourceRefs && d.sourceRefs.length > 0 ? (
                <p className="diag-source muted">
                  sources: {d.sourceRefs.length}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
