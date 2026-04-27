import type { ArtifactDiagnostic } from '@plccopilot/codegen-core';
import {
  aggregateDiagnostics,
  sortDiagnosticsForDisplay,
  dedupeDiagnostics,
} from '../utils/diagnostics.js';

export interface DiagnosticsPanelProps {
  title: string;
  diagnostics: readonly ArtifactDiagnostic[];
  /** When true, dedupe entries that appear both on artifacts and the manifest. */
  dedupe?: boolean;
  /**
   * Sprint 44 — optional per-row Jump action. The panel renders a
   * "Jump" button next to a diagnostic only when `isJumpablePath`
   * returns true for the row's `path`. Click invokes
   * `onJumpToPath(path, severity)` so the host app can wire it
   * into its existing focus pipeline (e.g. `handleFocusInEditor`).
   * Omitting the props keeps the panel pristine — no behaviour
   * change for callers that don't opt in.
   */
  onJumpToPath?: (
    path: string,
    severity: ArtifactDiagnostic['severity'],
  ) => void;
  isJumpablePath?: (path: string | undefined) => boolean;
}

export function DiagnosticsPanel({
  title,
  diagnostics,
  dedupe = true,
  onJumpToPath,
  isJumpablePath,
}: DiagnosticsPanelProps): JSX.Element {
  const cleaned = dedupe ? dedupeDiagnostics(diagnostics) : [...diagnostics];
  const sorted = sortDiagnosticsForDisplay(cleaned);
  const counts = aggregateDiagnostics(sorted);
  // Sprint 44 — only render the action column when both props are
  // supplied. Avoids an empty extra column on validation panels and
  // anywhere else that consumes DiagnosticsPanel without the
  // jump-to-PIR affordance.
  const canJump = onJumpToPath !== undefined && isJumpablePath !== undefined;

  return (
    <section className="card">
      <header className="panel-header">
        <h2>{title}</h2>
        <span className="counts">
          <span className="badge sev-error">{counts.errors} errors</span>
          <span className="badge sev-warning">{counts.warnings} warnings</span>
          <span className="badge sev-info">{counts.info} info</span>
        </span>
      </header>

      {sorted.length === 0 ? (
        <p className="muted">No diagnostics.</p>
      ) : (
        <table className="diag-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Code</th>
              <th>Message</th>
              <th>Station</th>
              <th>Path</th>
              <th>Symbol</th>
              {canJump ? <th>Jump</th> : null}
            </tr>
          </thead>
          <tbody>
            {sorted.map((d, i) => {
              const jumpable =
                canJump && isJumpablePath!(d.path) && d.path !== undefined;
              return (
                <tr key={`${d.code}-${i}`} className={`sev-${d.severity}`}>
                  <td>
                    <span className={`badge sev-${d.severity}`}>
                      {d.severity}
                    </span>
                  </td>
                  <td>
                    <code>{d.code}</code>
                  </td>
                  <td>{d.message}</td>
                  <td>{d.stationId ?? ''}</td>
                  <td>{d.path ?? ''}</td>
                  <td>{d.symbol ?? ''}</td>
                  {canJump ? (
                    <td>
                      {jumpable ? (
                        <button
                          type="button"
                          className="diag-action"
                          onClick={() => onJumpToPath!(d.path!, d.severity)}
                          title={`Scroll the PIR editor to ${d.path}`}
                          aria-label={`Jump to PIR path ${d.path}`}
                        >
                          Jump
                        </button>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
