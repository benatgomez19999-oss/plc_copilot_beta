import type { FieldDiffResult } from '../../utils/field-diff.js';

export interface FieldDiffProps {
  /** Optional human-readable field name shown above the values. */
  label?: string;
  /**
   * Bracket-indexed JSONPath the row maps to (e.g.
   * `$.machines[0].stations[1].equipment[0].name`). Used by the click
   * handler to ask the editor to scroll there.
   */
  path: string;
  /** Result from `getFieldDiff`. Renders null when `!diff?.changed`. */
  diff?: FieldDiffResult;
  /**
   * When supplied, the row renders as a real `<button>` and clicking /
   * activating it calls `onFindInEditor(path)`. Omit to fall back to a
   * static, non-interactive `<div>` (back-compat for read-only contexts).
   */
  onFindInEditor?: (path: string) => void;
}

/**
 * Compact "Applied vs Draft" diff block for a single field. Two render
 * modes share the same visual treatment so operators recognise the row
 * regardless of whether it's clickable:
 *
 *   - **Static** (`onFindInEditor` omitted) — wrapped in a plain `<div>`.
 *   - **Interactive** (`onFindInEditor` supplied) — wrapped in a
 *     `<button type="button">` with hover / focus styling and a small
 *     `Jump to JSON ↗` affordance hint at the bottom-right.
 *
 * The inner row markup uses `<span>` (not `<div>`) so the structure is
 * valid HTML inside the interactive `<button>` (buttons accept only
 * phrasing content per the HTML spec).
 */
export function FieldDiff({
  label,
  path,
  diff,
  onFindInEditor,
}: FieldDiffProps): JSX.Element | null {
  if (!diff || !diff.changed) return null;

  const interactive = typeof onFindInEditor === 'function';

  const content = (
    <>
      {label ? (
        <span className="field-diff-label muted small">{label}</span>
      ) : null}
      <span className="field-diff-row">
        <span className="field-diff-side">Applied</span>
        <code className="diff-value-applied">
          {formatValue(diff.appliedValue)}
        </code>
      </span>
      <span className="field-diff-row">
        <span className="field-diff-side">Draft</span>
        <code className="diff-value-draft">
          {formatValue(diff.draftValue)}
        </code>
      </span>
      {interactive ? (
        <span className="field-diff-jump-hint muted small">
          Jump to JSON ↗
        </span>
      ) : null}
    </>
  );

  if (interactive) {
    return (
      <button
        type="button"
        className="field-diff field-diff-button"
        onClick={() => onFindInEditor(path)}
        title="Find this change in the PIR editor"
        aria-label={`Find ${label ?? path} in the PIR editor`}
      >
        {content}
      </button>
    );
  }

  return <div className="field-diff">{content}</div>;
}

function formatValue(v: unknown): string {
  if (v === undefined) return '—';
  if (v === null) return 'null';
  if (typeof v === 'string') return v === '' ? '""' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
