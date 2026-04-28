// Sprint 75 — diagnostics list dedicated to ElectricalDiagnostic
// (CSV / EPLAN / generic). The existing DiagnosticsPanel.tsx
// targets ArtifactDiagnostic from codegen — different shape — so we
// build a small parallel component here. Same a11y idioms (per-row
// severity badge + count summary at the top).

import { useMemo, useState } from 'react';
import type {
  ElectricalDiagnostic,
  ElectricalDiagnosticSeverity,
} from '@plccopilot/electrical-ingest';

import { filterDiagnosticsBySeverity } from '../../utils/review-state.js';

const SEVERITIES: ElectricalDiagnosticSeverity[] = [
  'error',
  'warning',
  'info',
];

export interface ElectricalDiagnosticsListProps {
  diagnostics: ReadonlyArray<ElectricalDiagnostic>;
}

export function ElectricalDiagnosticsList({
  diagnostics,
}: ElectricalDiagnosticsListProps): JSX.Element {
  const [filter, setFilter] = useState<ElectricalDiagnosticSeverity | null>(
    null,
  );

  const counts = useMemo(() => {
    const out: Record<ElectricalDiagnosticSeverity, number> = {
      error: 0,
      warning: 0,
      info: 0,
    };
    for (const d of diagnostics) out[d.severity]++;
    return out;
  }, [diagnostics]);

  const visible = useMemo(
    () => filterDiagnosticsBySeverity(diagnostics, filter),
    [diagnostics, filter],
  );

  return (
    <section className="electrical-diagnostics" aria-label="Ingestion diagnostics">
      <header className="panel-header">
        <h3>Ingestion diagnostics</h3>
        <div className="filter-chips" role="toolbar" aria-label="Filter diagnostics by severity">
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
          No diagnostics{filter ? ` at severity "${filter}"` : ''}.
        </p>
      ) : (
        <ul className="electrical-diagnostics-list">
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
              {d.hint ? <p className="diag-hint muted">Hint: {d.hint}</p> : null}
              {d.nodeId || d.edgeId ? (
                <p className="diag-target muted">
                  {d.nodeId ? <>node: <code>{d.nodeId}</code> </> : null}
                  {d.edgeId ? <>edge: <code>{d.edgeId}</code></> : null}
                </p>
              ) : null}
              {d.sourceRef ? (
                <p className="diag-source muted">
                  source: <code>{d.sourceRef.kind}</code>
                  {d.sourceRef.path ? ' · ' + d.sourceRef.path : ''}
                  {typeof d.sourceRef.line === 'number'
                    ? ' · line ' + d.sourceRef.line
                    : ''}
                  {d.sourceRef.symbol ? ' · ' + d.sourceRef.symbol : ''}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
