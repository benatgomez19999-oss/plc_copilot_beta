export type StructureViewMode = 'applied' | 'draft';

export interface StructureViewModeToggleProps {
  mode: StructureViewMode;
  /** Whether the Draft tab is selectable. Disabled when no valid distinct draft exists. */
  draftAvailable: boolean;
  onModeChange: (mode: StructureViewMode) => void;
  /** Optional human-readable reason rendered as the disabled tab's tooltip. */
  draftIssue?: string;
}

/**
 * Two-button view-mode toggle for the PIR Structure Navigator. Sits in
 * the structure card header next to the title.
 *
 * The active button uses the `.btn primary` styling so the choice is
 * obvious even with the trailing badge. The Draft button stays disabled
 * unless the parent has a valid, distinct-from-applied draft project to
 * display — in which case the parent passes `draftAvailable=true`.
 *
 * The badge below the buttons is the canonical "what am I looking at"
 * pill: `Applied` (info) or `Draft — not applied` (warning). Operator
 * users glance here first before trusting any number on screen.
 */
export function StructureViewModeToggle({
  mode,
  draftAvailable,
  onModeChange,
  draftIssue,
}: StructureViewModeToggleProps): JSX.Element {
  return (
    <div className="view-mode-toggle" role="group" aria-label="Structure view mode">
      <span className="muted small">Viewing:</span>
      <div className="view-mode-buttons">
        <button
          type="button"
          className={`btn${mode === 'applied' ? ' primary' : ''}`}
          onClick={() => onModeChange('applied')}
          aria-pressed={mode === 'applied'}
          title="Show the project Generate / Validate currently see"
        >
          Applied
        </button>
        <button
          type="button"
          className={`btn${mode === 'draft' ? ' primary' : ''}`}
          onClick={() => onModeChange('draft')}
          disabled={!draftAvailable}
          aria-pressed={mode === 'draft'}
          title={
            draftAvailable
              ? 'Inspect the unsaved draft (read-only — Apply still required)'
              : (draftIssue ?? 'No distinct valid draft to view')
          }
        >
          Draft
        </button>
      </div>
      <span
        className={`badge ${mode === 'draft' ? 'sev-warning' : 'sev-info'}`}
        title={
          mode === 'draft'
            ? 'Generate is NOT using this — click Apply JSON to promote'
            : 'This is what Generate / Validate read'
        }
      >
        {mode === 'draft' ? 'Draft — not applied' : 'Applied'}
      </span>
    </div>
  );
}
