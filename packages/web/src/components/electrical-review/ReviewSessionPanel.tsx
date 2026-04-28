// Sprint 78B — review session panel. Surface for "saved locally?",
// load last session, clear saved, save now, download review session
// JSON, and (optional) re-import from file.
//
// UX invariants:
//   - Honest copy: "Saved locally in this browser. No upload."
//   - The button labels never imply cloud sync, audit compliance,
//     or final PLC code generation.
//   - Disabled buttons carry an explanatory `title`.
//   - The panel is presentation-only — the workspace owns state.

import type { ElectricalReviewSessionSnapshot } from '../../utils/electrical-review-session.js';

export interface ReviewSessionPanelProps {
  /** Live snapshot for the active session, or null when nothing is loaded. */
  snapshot: ElectricalReviewSessionSnapshot | null;
  /** True when the latest snapshot has been autosaved. */
  saved: boolean;
  /** ISO of the most recent autosave (nullable for "not saved yet"). */
  savedAt: string | null;
  /** When non-null, an info/warn banner is shown above the buttons. */
  notice: string | null;
  /** Persist now (typically same as autosave but explicit). */
  onSaveNow: () => void;
  /** Restore the latest saved snapshot from localStorage. */
  onLoadLast: () => void;
  /** Drop the saved snapshot from localStorage. */
  onClearSaved: () => void;
  /** Download the review session JSON. */
  onDownloadSession: () => void;
  /** Operator picked a JSON file to re-import; receives the parsed contents. */
  onImportSession: (file: File) => void;
}

export function ReviewSessionPanel({
  snapshot,
  saved,
  savedAt,
  notice,
  onSaveNow,
  onLoadLast,
  onClearSaved,
  onDownloadSession,
  onImportSession,
}: ReviewSessionPanelProps): JSX.Element {
  const hasSession = snapshot !== null;
  return (
    <section
      className="review-session-panel"
      aria-label="Review session persistence and export"
    >
      <header className="panel-header">
        <h3>Review session</h3>
        <span
          className={`badge review-session-status review-session-status--${saved ? 'saved' : 'unsaved'}`}
          aria-live="polite"
        >
          {saved ? 'Saved locally' : hasSession ? 'Not saved yet' : 'No session'}
        </span>
      </header>

      <p className="muted review-session-disclaimer">
        Saved locally in this browser only. <strong>No upload.</strong>{' '}
        Raw source content (CSV / XML body) is{' '}
        <strong>not persisted by default</strong> — only the extracted
        candidate, your review decisions, and diagnostics. No PLC codegen
        is run.
      </p>

      {hasSession ? (
        <dl className="review-session-meta">
          <div>
            <dt>File</dt>
            <dd>{snapshot.source.fileName ?? '(none)'}</dd>
          </div>
          <div>
            <dt>Detected source</dt>
            <dd>{snapshot.source.sourceKind ?? snapshot.source.inputKind}</dd>
          </div>
          <div>
            <dt>Source id</dt>
            <dd>
              <code>{snapshot.source.sourceId}</code>
            </dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{snapshot.updatedAt}</dd>
          </div>
          {savedAt ? (
            <div>
              <dt>Last save</dt>
              <dd>{savedAt}</dd>
            </div>
          ) : null}
          {snapshot.source.contentHash ? (
            <div>
              <dt>Content hash</dt>
              <dd>
                <code>{snapshot.source.contentHash}</code>
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}

      {notice ? (
        <p className="muted review-session-notice" role="status">
          {notice}
        </p>
      ) : null}

      <div className="review-session-actions">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onSaveNow}
          disabled={!hasSession}
          title={hasSession ? undefined : 'Ingest a source first'}
        >
          Save now
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onLoadLast}
        >
          Load last
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onClearSaved}
          title="Remove the locally-saved review session"
        >
          Clear saved
        </button>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={onDownloadSession}
          disabled={!hasSession}
          title={
            hasSession
              ? 'Download the review session JSON snapshot'
              : 'No session to download'
          }
        >
          Download review session
        </button>
        <label className="btn btn-secondary review-session-import">
          Import session
          <input
            type="file"
            accept="application/json,.json"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onImportSession(file);
              // Reset so the same file can be re-imported back-to-back.
              e.target.value = '';
            }}
          />
        </label>
      </div>
    </section>
  );
}
