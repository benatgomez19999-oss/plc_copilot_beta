import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { Issue } from '@plccopilot/pir';
import {
  countValidationIssueListItems,
  filterValidationIssueListItems,
  type ValidationIssueFilter,
  type ValidationIssueListItem,
} from '../utils/validation-structure.js';
import {
  clampRovingIndex,
  nextRovingIndex,
  type RovingDirection,
} from '../utils/roving-index.js';

export interface ValidationIssuesListProps {
  /**
   * Human-readable label of the node the list is opened for. App
   * derives this from the **current** structure tree on every render
   * (sprint 31), so a node renamed while the panel is open updates
   * the header text without reopening.
   */
  nodeLabel: string;
  /** JSONPath of that node, shown in the header for context. */
  nodePath: string;
  /**
   * Pre-filtered (by node) + pre-sorted list of issues for the open
   * node. Empty arrays render `null` so React unmount is implicit
   * when the parent clears its open-list state.
   */
  issues: readonly ValidationIssueListItem[];
  /**
   * Sprint 32 — controlled filter. App owns the state and persists
   * it via `saveValidationIssueFilter`, so the user's preference
   * (e.g. "Errors only") survives across node selections, panel
   * opens, and tab reloads.
   */
  filter: ValidationIssueFilter;
  onFilterChange: (filter: ValidationIssueFilter) => void;
  /**
   * Jump callback. The list stays open on jump so the user can visit
   * every issue without reopening the panel between jumps. Severity
   * is forwarded so App's focus-pulse pipeline can tint the highlight
   * (sprint 29).
   */
  onJump: (path: string, severity: Issue['severity']) => void;
  /** Close the panel — deselects the open node in App. */
  onClose: () => void;
  /**
   * Sprint 34 — optional focus pulse. When the parent supplies a
   * fresh `nonce` (Alt+L only; mouse `⋯` clicks intentionally don't
   * set this), the list focuses the first visible row after render.
   * If the active filter hides every issue, no row is focused — the
   * panel stays open with the empty-filter message.
   */
  focusRequest?: { nonce: number } | null;
}

/**
 * Inline issue navigator (sprints 30 → 33). The panel itself is
 * unchanged structurally; sprint 33 swaps individual row tab-stops
 * for a single roving-tabindex group:
 *
 *   - One row at `tabIndex={0}` (driven by `activeRowIndex` state).
 *   - Every other row at `tabIndex={-1}`.
 *   - Tab from outside lands on the active row only — Tab again
 *     leaves the list. Inside the list, ArrowUp / ArrowDown / Home /
 *     End move the active index AND focus the matching row via
 *     `rowRefs.current[next]?.focus()` (programmatic focus ignores
 *     the `tabIndex={-1}` other rows have).
 *   - Click / `onFocus` mirrors `setActiveRowIndex(idx)` so mouse
 *     and keyboard converge on the same active row.
 *   - `clampRovingIndex` re-pins the active index whenever the
 *     visible list shrinks (filter chip change, Apply clears
 *     issues), so a stale-out-of-range index can't crash.
 *
 * `role="listbox"` is intentionally NOT used — rows are real
 * `<button>`s, mixing button activation semantics with listbox
 * single-select would confuse assistive tech. The list stays a
 * `<ul>` of `<li>` of `<button>`.
 */
export function ValidationIssuesList({
  nodeLabel,
  nodePath,
  issues,
  filter,
  onFilterChange,
  onJump,
  onClose,
  focusRequest,
}: ValidationIssuesListProps): JSX.Element | null {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [activeRowIndex, setActiveRowIndex] = useState(0);

  // Compute counts/visible items unconditionally — hooks must run in
  // the same order on every render, and the early `return null`
  // below would skip the `useEffect` if these were post-return.
  const counts = countValidationIssueListItems(issues);
  const visibleItems = filterValidationIssueListItems(issues, filter);
  // Truncate stale refs so a previous render's longer ref array
  // can't match `document.activeElement` after a filter shrink.
  rowRefs.current.length = visibleItems.length;

  // Re-clamp the active index whenever the visible list length
  // changes. Empty list → 0. Active was beyond new length → last
  // valid index. Otherwise unchanged.
  useEffect(() => {
    setActiveRowIndex((prev) => clampRovingIndex(prev, visibleItems.length));
  }, [visibleItems.length]);

  // Sprint 34 — Alt+L focus pulse. Fires only when the parent bumps
  // the nonce; mouse-driven panel opens never fire so we don't
  // steal focus from the structure tree the user just clicked. We
  // wait one rAF tick so React has rendered the row buttons before
  // we call `.focus()`. If the active filter hides everything we
  // do nothing — the panel stays open with the empty-filter
  // message and the user can flip chips.
  useEffect(() => {
    if (!focusRequest) return;
    if (visibleItems.length === 0) return;
    setActiveRowIndex(0);
    const id = requestAnimationFrame(() => {
      rowRefs.current[0]?.focus();
    });
    return () => cancelAnimationFrame(id);
    // We deliberately depend only on the nonce so unrelated re-renders
    // (filter changes, issue list updates) never refocus. Filter
    // changes have their own clamp effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  if (issues.length === 0) return null;

  function handleRowsKeyDown(
    event: KeyboardEvent<HTMLUListElement>,
  ): void {
    const count = visibleItems.length;
    if (count === 0) return;
    let direction: RovingDirection | null = null;
    if (event.key === 'ArrowDown') direction = 'next';
    else if (event.key === 'ArrowUp') direction = 'prev';
    else if (event.key === 'Home') direction = 'first';
    else if (event.key === 'End') direction = 'last';
    if (!direction) return;
    event.preventDefault();
    const target = nextRovingIndex(activeRowIndex, count, direction);
    if (target === null) return;
    setActiveRowIndex(target);
    rowRefs.current[target]?.focus();
  }

  return (
    <section
      className="validation-issues-list"
      aria-label={`Validation issues for ${nodeLabel}`}
    >
      <header className="validation-issues-header">
        <h3>
          Validation issues under <code>{nodeLabel}</code>
        </h3>
        <span className="validation-issues-count muted small">
          {issues.length} total · <code>{nodePath}</code>
        </span>
        <button
          type="button"
          className="btn"
          onClick={onClose}
          aria-label="Close validation issues list"
          title="Close the issues list"
        >
          Close
        </button>
      </header>

      <div
        className="validation-issue-filters"
        role="group"
        aria-label="Filter by severity"
      >
        <FilterChip
          tone=""
          label="All"
          count={counts.total}
          active={filter === 'all'}
          onClick={() => onFilterChange('all')}
        />
        <FilterChip
          tone="error"
          label="Errors"
          count={counts.errors}
          active={filter === 'error'}
          onClick={() => onFilterChange('error')}
        />
        <FilterChip
          tone="warning"
          label="Warnings"
          count={counts.warnings}
          active={filter === 'warning'}
          onClick={() => onFilterChange('warning')}
        />
        <FilterChip
          tone="info"
          label="Info"
          count={counts.info}
          active={filter === 'info'}
          onClick={() => onFilterChange('info')}
        />
      </div>

      {visibleItems.length === 0 ? (
        <p className="validation-issues-empty-filter muted small">
          No {filter} issues under this node.
        </p>
      ) : (
        <ul
          className="validation-issue-rows"
          role="list"
          onKeyDown={handleRowsKeyDown}
        >
          {visibleItems.map((item, idx) => (
            <li key={`${item.index}-${item.rule}-${item.path}`}>
              <button
                ref={(el) => {
                  rowRefs.current[idx] = el;
                }}
                type="button"
                tabIndex={idx === activeRowIndex ? 0 : -1}
                className={`validation-issue-row-button tone-${item.severity}`}
                onClick={() => onJump(item.path, item.severity)}
                onFocus={() => setActiveRowIndex(idx)}
                aria-label={`Jump to ${item.severity} ${item.rule} at ${item.path}`}
              >
                <span
                  className={`validation-issue-severity ${item.severity}`}
                  aria-hidden="true"
                >
                  {item.severity}
                </span>
                <code className="validation-issue-rule">{item.rule}</code>
                <span
                  className="validation-issue-message"
                  title={item.message}
                >
                  {item.message}
                </span>
                <code
                  className="validation-issue-path"
                  title={item.path}
                >
                  {item.path}
                </code>
                <span
                  className="validation-issue-jump-hint"
                  aria-hidden="true"
                >
                  Jump ↗
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * One severity chip in the filter row. Reused from sprint 31 with
 * the same shape — only the parent's onClick now routes through
 * App's `onFilterChange`, and the chips themselves remain a
 * separate Tab stop (each is its own button — they don't participate
 * in the row roving-tabindex).
 */
function FilterChip({
  tone,
  label,
  count,
  active,
  onClick,
}: {
  tone: '' | 'error' | 'warning' | 'info';
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  const className = ['validation-issue-filter', tone, active ? 'active' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={className}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}{' '}
      <span className="validation-issue-filter-count">{count}</span>
    </button>
  );
}
