// Sprint 77 — "Build PIR" button + ready/not-ready status. Thin
// presentational component over the pure helpers in
// `utils/pir-build-preview.ts`.
//
// UX invariants:
//   - Button is disabled while the gate is false.
//   - Button label + tooltip explain *why* it's disabled
//     (collected by `collectReadyReasons` helper).
//   - Domain builder remains the source of truth: the operator
//     can re-press the button after fixing review state, and the
//     builder will re-evaluate independently.
//   - The label "PIR preview" is used everywhere — never "final
//     PIR" or "verified". The "no automatic codegen" message is
//     surfaced explicitly under the button.

export interface PirBuildPanelProps {
  /** True iff the gate predicate accepts the current state. */
  ready: boolean;
  /** Human-readable list of why the gate is not ready. */
  readyReasons: ReadonlyArray<string>;
  /** Whether a PIR has been built (controls the "PIR preview built" badge). */
  hasBuiltPir: boolean;
  /** Click handler — caller wires this to `buildPirPreview`. */
  onBuild: () => void;
}

export function PirBuildPanel({
  ready,
  readyReasons,
  hasBuiltPir,
  onBuild,
}: PirBuildPanelProps): JSX.Element {
  const disabledTitle = ready
    ? undefined
    : `Cannot build yet:\n• ${readyReasons.join('\n• ')}`;

  return (
    <section
      className="pir-build-panel"
      aria-label="PIR build preview controls"
    >
      <header className="panel-header">
        <h3>PIR preview</h3>
        <span
          className={`badge build-status build-status--${ready ? 'ready' : 'not-ready'}`}
          aria-live="polite"
        >
          {ready ? 'Ready to build' : 'Review required'}
        </span>
      </header>

      <p className="muted pir-build-panel-disclaimer">
        This builder produces a <strong>PIR preview</strong>, not
        final PLC code. <strong>Codegen is not run automatically</strong>
        — operator approval of the built PIR is still required for
        any downstream step.
      </p>

      <div className="pir-build-panel-actions">
        <button
          type="button"
          className="btn build-pir-button"
          disabled={!ready}
          aria-disabled={!ready}
          aria-label={ready ? 'Build PIR preview' : `Build PIR (disabled: ${readyReasons.join('; ')})`}
          title={disabledTitle}
          onClick={() => {
            if (!ready) return;
            onBuild();
          }}
        >
          Build PIR preview
        </button>
        {hasBuiltPir ? (
          <span className="badge build-status--built" role="status">
            Preview generated
          </span>
        ) : null}
      </div>

      {!ready && readyReasons.length > 0 ? (
        <div
          className="pir-build-panel-reasons"
          role="alert"
          aria-label="Reasons the build is not ready"
        >
          <p className="muted">
            <strong>Why it&apos;s disabled:</strong>
          </p>
          <ul>
            {readyReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
