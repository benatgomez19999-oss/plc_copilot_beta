import { useMemo, useState, type MouseEvent } from 'react';
import type {
  PirStructureNodeKind,
  PirStructureNodeTree,
} from '../utils/pir-structure.js';
import type { Issue } from '@plccopilot/pir';
import type { PirDiffEntry } from '../utils/pir-diff.js';
import {
  firstChangedDescendantPath,
  formatStructureChangeBreakdown,
  type StructureChangeBreakdown,
} from '../utils/structure-diff.js';
import {
  formatValidationSeverityBreakdown,
  type ValidationSeverityBreakdown,
} from '../utils/validation-structure.js';

export interface PirStructureTreeProps {
  /** Root node — typically the project. */
  root: PirStructureNodeTree;
  /** Currently selected node's `jsonPath`, or `null` when nothing is selected. */
  selectedJsonPath: string | null;
  onSelect: (jsonPath: string) => void;
  /**
   * Set of structure-node `jsonPath`s that differ between applied and
   * draft. Each matching row renders a small `●` next to its label. The
   * set is computed via `getChangedStructurePaths`; absent or empty
   * means "no draft differences" — the tree shows no dots. Used as a
   * fallback when `changeCounts` is not supplied (back-compat).
   */
  changedPaths?: ReadonlySet<string>;
  /**
   * Per-node change count — `Map<structureNodeJsonPath, count>` produced
   * by `getStructureChangeCounts`. When supplied, rows render a small
   * `● N` pill carrying the count of pending diff entries that touch the
   * node or its descendants. Takes priority over `changedPaths`; if
   * absent we fall back to the bare-dot rendering.
   */
  changeCounts?: ReadonlyMap<string, number>;
  /**
   * Per-node breakdown — `Map<structureNodeJsonPath, breakdown>` from
   * `structureChangeBreakdownsFromDiffs`. The breakdown enriches the
   * badge's tooltip / aria-label with `<n changed · m added · k removed>`
   * so users see what *kind* of change is pending without leaving the
   * tree. Visible `● N` pill stays the same.
   */
  changeBreakdowns?: ReadonlyMap<string, StructureChangeBreakdown>;
  /**
   * The full diff list. When supplied alongside `onFocusInEditor`, the
   * `● N` badge becomes a clickable button that jumps the PIR editor to
   * the first changed leaf under that branch. The diff list is the only
   * source of truth for that lookup — passing the full list keeps the
   * resolution deterministic (matches the App's memoized `pirDiffs`).
   */
  diffs?: readonly PirDiffEntry[];
  /**
   * Callback to scroll the Monaco PIR editor to a JSONPath. Reused from
   * the App-level focus pulse — same callback that powers the node-level
   * `Find in PIR editor` button and the `Pending changes` rows.
   */
  onFocusInEditor?: (path: string) => void;
  /**
   * Click handler for the `● N` badge that **cycles** through pending
   * changes under a node. App is responsible for tracking the per-node
   * click counter and resolving the next descendant path; the tree
   * just dispatches the node's `jsonPath`. When supplied, this takes
   * precedence over `onFocusInEditor` for badge clicks (the badge will
   * cycle, not jump-to-first).
   */
  onFocusNextChange?: (nodePath: string) => void;
  /**
   * Per-node validation issue count — drives the `⚠ N` badge. Built by
   * `validationIssueCountsFromReport` from either the applied
   * `validationReport` or `draftProjectState.report` depending on view.
   */
  validationCounts?: ReadonlyMap<string, number>;
  /**
   * Per-node severity breakdown for the validation badge tooltip /
   * aria-label and tone (red / amber / blue).
   */
  validationBreakdowns?: ReadonlyMap<string, ValidationSeverityBreakdown>;
  /** Live `Issue[]` so the badge can resolve descendants on click. */
  validationIssues?: readonly Issue[];
  /**
   * Cycle handler for the validation badge. Same shape as
   * `onFocusNextChange`: App owns the per-node counter and dispatches
   * the next descendant path through `handleFocusInEditor`.
   */
  onFocusNextValidationIssue?: (nodePath: string) => void;
  /**
   * Toggle the inline `ValidationIssuesList` panel for this node.
   * When supplied AND the node has at least one validation issue, a
   * sibling `⋯` button is rendered next to the `⚠` badge. Clicks
   * stop propagation so the row's selection / cycle handlers are not
   * fired. Sprint 31 narrows the dispatched payload to just the
   * `nodePath`; App derives the label fresh from the live structure
   * tree on each render, so a renamed node updates the panel header
   * without reopening.
   */
  onOpenValidationIssues?: (nodePath: string) => void;
  /**
   * JSONPath of the node whose validation-issues panel is currently
   * open in App. When supplied, the matching row's `⋯` button gets
   * an `.open` class so the user sees which node spawned the panel.
   * Cosmetic only — behaviour is unchanged.
   */
  openValidationNodePath?: string | null;
}

/**
 * Read-only collapsible tree of the applied PIR. Selection lifts up to the
 * parent (which renders the detail panel + drives "Find in PIR editor").
 *
 * Expand/collapse is local state — a Set of expanded `jsonPath`s. By default
 * the project + every machine + every station are open; equipment is a leaf.
 * No drag-and-drop, no inline edit — strictly a navigator.
 */
export function PirStructureTree({
  root,
  selectedJsonPath,
  onSelect,
  changedPaths,
  changeCounts,
  changeBreakdowns,
  diffs,
  onFocusInEditor,
  onFocusNextChange,
  validationCounts,
  validationBreakdowns,
  validationIssues,
  onFocusNextValidationIssue,
  onOpenValidationIssues,
  openValidationNodePath,
}: PirStructureTreeProps): JSX.Element {
  const initiallyExpanded = useMemo(
    () => collectInitiallyExpanded(root),
    [root],
  );
  const [expanded, setExpanded] = useState<Set<string>>(initiallyExpanded);

  function toggle(jsonPath: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(jsonPath)) next.delete(jsonPath);
      else next.add(jsonPath);
      return next;
    });
  }

  return (
    <ul className="structure-tree" role="tree">
      <TreeRow
        node={root}
        depth={0}
        expanded={expanded}
        selectedJsonPath={selectedJsonPath}
        onSelect={onSelect}
        onToggle={toggle}
        changedPaths={changedPaths}
        changeCounts={changeCounts}
        changeBreakdowns={changeBreakdowns}
        diffs={diffs}
        onFocusInEditor={onFocusInEditor}
        onFocusNextChange={onFocusNextChange}
        validationCounts={validationCounts}
        validationBreakdowns={validationBreakdowns}
        validationIssues={validationIssues}
        onFocusNextValidationIssue={onFocusNextValidationIssue}
        onOpenValidationIssues={onOpenValidationIssues}
        openValidationNodePath={openValidationNodePath}
      />
    </ul>
  );
}

interface TreeRowProps {
  node: PirStructureNodeTree;
  depth: number;
  expanded: Set<string>;
  selectedJsonPath: string | null;
  onSelect: (jsonPath: string) => void;
  onToggle: (jsonPath: string) => void;
  changedPaths?: ReadonlySet<string>;
  changeCounts?: ReadonlyMap<string, number>;
  changeBreakdowns?: ReadonlyMap<string, StructureChangeBreakdown>;
  diffs?: readonly PirDiffEntry[];
  onFocusInEditor?: (path: string) => void;
  onFocusNextChange?: (nodePath: string) => void;
  validationCounts?: ReadonlyMap<string, number>;
  validationBreakdowns?: ReadonlyMap<string, ValidationSeverityBreakdown>;
  validationIssues?: readonly Issue[];
  onFocusNextValidationIssue?: (nodePath: string) => void;
  onOpenValidationIssues?: (nodePath: string) => void;
  openValidationNodePath?: string | null;
}

function TreeRow({
  node,
  depth,
  expanded,
  selectedJsonPath,
  onSelect,
  onToggle,
  changedPaths,
  changeCounts,
  changeBreakdowns,
  diffs,
  onFocusInEditor,
  onFocusNextChange,
  validationCounts,
  validationBreakdowns,
  validationIssues,
  onFocusNextValidationIssue,
  onOpenValidationIssues,
  openValidationNodePath,
}: TreeRowProps): JSX.Element {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.jsonPath);
  const isSelected = selectedJsonPath === node.jsonPath;
  // Priority: `changeCounts` (count pill) → `changedPaths` (bare dot) →
  // nothing. The two props coexist for back-compat — App now passes
  // both, but a caller that only supplies `changedPaths` still gets
  // the dot rendering from sprint 19.
  const changeCount = changeCounts?.get(node.jsonPath) ?? 0;
  const isChangedByDot =
    changeCount === 0 && (changedPaths?.has(node.jsonPath) ?? false);
  const validationCount = validationCounts?.get(node.jsonPath) ?? 0;
  const count = countLabelFor(node);

  return (
    <li role="treeitem" aria-expanded={hasChildren ? isExpanded : undefined}>
      <div
        className={`structure-row${isSelected ? ' active' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
      >
        <button
          type="button"
          className="structure-twist"
          onClick={() => hasChildren && onToggle(node.jsonPath)}
          aria-label={
            hasChildren
              ? isExpanded
                ? 'Collapse'
                : 'Expand'
              : 'Leaf node'
          }
          disabled={!hasChildren}
          tabIndex={-1}
        >
          {hasChildren ? (isExpanded ? '▾' : '▸') : '·'}
        </button>
        <button
          type="button"
          className="structure-label"
          onClick={() => onSelect(node.jsonPath)}
          title={node.jsonPath}
        >
          <span className={`kind-badge kind-${node.kind}`}>
            {kindShortLabel(node.kind)}
          </span>
          <span className="structure-name">{node.label}</span>
        </button>
        {/*
          All badges + the metadata count sit OUTSIDE the label button —
          the interactive ones (`ChangeBadge`, `ValidationBadge`) need
          their own <button> nodes (no nesting), and the metadata pill
          stays as a sibling for consistent alignment. Visual order
          follows the spec: change → validation → count.
        */}
        {changeCount > 0 ? (
          <ChangeBadge
            count={changeCount}
            breakdown={changeBreakdowns?.get(node.jsonPath)}
            nodePath={node.jsonPath}
            nodeLabel={node.label}
            diffs={diffs}
            onFocusInEditor={onFocusInEditor}
            onFocusNextChange={onFocusNextChange}
          />
        ) : isChangedByDot ? (
          <span
            className="changed-dot"
            aria-label="Changed in draft"
            title="Changed in draft (apply to promote)"
          >
            ●
          </span>
        ) : null}
        {validationCount > 0 ? (
          <ValidationBadge
            count={validationCount}
            breakdown={validationBreakdowns?.get(node.jsonPath)}
            nodePath={node.jsonPath}
            nodeLabel={node.label}
            issues={validationIssues}
            onFocusNext={onFocusNextValidationIssue}
          />
        ) : null}
        {validationCount > 0 && onOpenValidationIssues ? (
          <button
            type="button"
            className={`validation-list-button${
              openValidationNodePath === node.jsonPath ? ' open' : ''
            }`}
            onClick={(e: MouseEvent<HTMLButtonElement>) => {
              // Don't bubble into the row's label/select handler — the
              // list trigger has its own action and shouldn't change
              // selection or expansion.
              e.stopPropagation();
              onOpenValidationIssues(node.jsonPath);
            }}
            aria-label={`Show ${validationCount} validation issue${validationCount === 1 ? '' : 's'} under ${node.label}`}
            aria-pressed={openValidationNodePath === node.jsonPath}
            title={`Show ${validationCount} validation issue${validationCount === 1 ? '' : 's'} under ${node.label}`}
          >
            ⋯
          </button>
        ) : null}
        {count ? <span className="structure-count">{count}</span> : null}
      </div>
      {hasChildren && isExpanded ? (
        <ul className="structure-children" role="group">
          {node.children.map((c) => (
            <TreeRow
              key={c.jsonPath}
              node={c}
              depth={depth + 1}
              expanded={expanded}
              selectedJsonPath={selectedJsonPath}
              onSelect={onSelect}
              onToggle={onToggle}
              changedPaths={changedPaths}
              changeCounts={changeCounts}
              changeBreakdowns={changeBreakdowns}
              diffs={diffs}
              onFocusInEditor={onFocusInEditor}
              onFocusNextChange={onFocusNextChange}
              validationCounts={validationCounts}
              validationBreakdowns={validationBreakdowns}
              validationIssues={validationIssues}
              onFocusNextValidationIssue={onFocusNextValidationIssue}
              onOpenValidationIssues={onOpenValidationIssues}
              openValidationNodePath={openValidationNodePath}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// =============================================================================
// helpers
// =============================================================================

function collectInitiallyExpanded(root: PirStructureNodeTree): Set<string> {
  // Expand project + machines + stations by default; leave equipment leaves
  // closed (they have no children anyway). This shows the operator-level
  // structure at a glance without drowning the panel in deep detail.
  const out = new Set<string>();
  out.add(root.jsonPath);
  for (const m of root.children) {
    out.add(m.jsonPath);
    for (const s of m.children) {
      out.add(s.jsonPath);
    }
  }
  return out;
}

function pluralize(n: number): string {
  return `${n} pending change${n === 1 ? '' : 's'}`;
}

interface ChangeBadgeProps {
  count: number;
  /**
   * Per-node breakdown for tooltip / aria-label. When supplied, replaces
   * the bare `pluralize(count)` wording with a kind-aware phrase like
   * `2 changed · 1 added`. Visible `● N` pill is unchanged either way.
   */
  breakdown?: StructureChangeBreakdown;
  nodePath: string;
  nodeLabel: string;
  diffs?: readonly PirDiffEntry[];
  onFocusInEditor?: (path: string) => void;
  onFocusNextChange?: (nodePath: string) => void;
}

/**
 * Visual `● N` pill rendered next to changed structure-tree rows.
 *
 * Three render modes, evaluated in order:
 *
 *   1. **Cycle** — `onFocusNextChange` supplied. Click dispatches the
 *      node's `jsonPath` to App, which keeps a per-node click counter
 *      (in a ref, not state) and indexes into the descendant-paths
 *      array. Repeated clicks loop through every change under the
 *      node. Tooltip / aria-label say "click repeatedly to cycle".
 *      The badge does NOT precompute the target here — App owns that
 *      logic and stays in sync with the live `pirDiffs`.
 *   2. **Jump-to-first (back-compat)** — only `onFocusInEditor` and
 *      `diffs` supplied. Resolves `firstChangedDescendantPath` on
 *      click and dispatches that path. This is the sprint-22
 *      behavior; preserved so a caller without cycle support keeps
 *      working.
 *   3. **Static** — neither set. Renders a `<span>` with the count.
 *
 * In every mode the badge `stopPropagation()`s on click so the row's
 * label button does NOT also receive the event. Selecting / expanding
 * the row stays bound to the label and twist buttons.
 */
function ChangeBadge({
  count,
  breakdown,
  nodePath,
  nodeLabel,
  diffs,
  onFocusInEditor,
  onFocusNextChange,
}: ChangeBadgeProps): JSX.Element {
  const innerContent = (
    <>
      <span className="changed-badge-dot" aria-hidden="true">●</span>
      <span className="changed-badge-count">{count}</span>
    </>
  );

  // Lead phrase for tooltip / aria — breakdown if available, otherwise
  // the legacy pluralized count. `formatStructureChangeBreakdown` is
  // total-function so we can call it unconditionally when breakdown
  // exists, without if-guarding empty buckets.
  const headline = breakdown
    ? formatStructureChangeBreakdown(breakdown)
    : pluralize(count);

  // Cycle mode (preferred — App owns the counter).
  if (onFocusNextChange) {
    return (
      <button
        type="button"
        className="changed-badge changed-badge-button"
        onClick={(e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          onFocusNextChange(nodePath);
        }}
        aria-label={
          breakdown
            ? `Jump through ${pluralize(count)} under ${nodeLabel}. ${headline}.`
            : `Jump through ${pluralize(count)} under ${nodeLabel}`
        }
        title={`${headline} in draft. Click repeatedly to cycle through them.`}
      >
        {innerContent}
      </button>
    );
  }

  // Jump-to-first fallback (sprint-22 back-compat).
  if (onFocusInEditor && diffs) {
    const target = firstChangedDescendantPath(nodePath, diffs);
    const disabled = target === null;
    return (
      <button
        type="button"
        className="changed-badge changed-badge-button"
        onClick={(e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          if (target) onFocusInEditor(target);
        }}
        disabled={disabled}
        aria-label={
          breakdown
            ? `Jump to first pending change under ${nodeLabel}. ${headline}.`
            : `Jump to first pending change under ${nodeLabel}`
        }
        title={
          disabled
            ? `${headline} in draft. No descendant resolves under this node.`
            : `${headline} in draft. Click to jump to first change.`
        }
      >
        {innerContent}
      </button>
    );
  }

  // Static fallback — read-only contexts.
  return (
    <span
      className="changed-badge"
      aria-label={headline}
      title={`${headline} in draft (apply to promote)`}
    >
      {innerContent}
    </span>
  );
}

interface ValidationBadgeProps {
  count: number;
  breakdown?: ValidationSeverityBreakdown;
  nodePath: string;
  nodeLabel: string;
  issues?: readonly Issue[];
  onFocusNext?: (nodePath: string) => void;
}

/**
 * `⚠ N` pill rendered next to a row when the active validation report
 * (Applied → `validationReport`, Draft → `draftProjectState.report`)
 * has issues touching this node or its descendants.
 *
 * Two render modes:
 *   - **Cycle** — `onFocusNext` and `issues` both supplied. The pill
 *     becomes a real `<button>` whose click dispatches the node's
 *     `jsonPath` so App can advance the per-node click counter. App
 *     keeps the cycle state in a ref (no tree re-render per click).
 *   - **Static** — neither set. Renders a `<span>` with the same
 *     visual treatment so read-only contexts still get the indicator.
 *
 * Tone is derived from `breakdown` per the design spec:
 *   any errors  → `has-errors`   (red)
 *   any warnings → `has-warnings` (amber)
 *   only info   → `info-only`    (blue)
 *
 * Click `stopPropagation()`s so the row's label / select handler does
 * NOT fire — selection stays bound to the label button only.
 */
function ValidationBadge({
  count,
  breakdown,
  nodePath,
  nodeLabel,
  issues,
  onFocusNext,
}: ValidationBadgeProps): JSX.Element {
  const tone =
    breakdown && breakdown.errors > 0
      ? 'has-errors'
      : breakdown && breakdown.warnings > 0
        ? 'has-warnings'
        : breakdown && breakdown.info > 0
          ? 'info-only'
          : 'has-errors'; // defensive default — `count > 0` shouldn't reach here without breakdown

  const headline = breakdown
    ? formatValidationSeverityBreakdown(breakdown)
    : `${count} validation issue${count === 1 ? '' : 's'}`;

  const innerContent = (
    <>
      <span className="validation-badge-icon" aria-hidden="true">⚠</span>
      <span className="validation-badge-count">{count}</span>
    </>
  );

  if (onFocusNext && issues) {
    return (
      <button
        type="button"
        className={`validation-badge validation-badge-button ${tone}`}
        onClick={(e: MouseEvent<HTMLButtonElement>) => {
          e.stopPropagation();
          onFocusNext(nodePath);
        }}
        aria-label={`Jump through ${count} validation issue${count === 1 ? '' : 's'} under ${nodeLabel}. ${headline}.`}
        title={`${headline}. Click to cycle through validation issues.`}
      >
        {innerContent}
      </button>
    );
  }

  return (
    <span
      className={`validation-badge ${tone}`}
      aria-label={headline}
      title={headline}
    >
      {innerContent}
    </span>
  );
}

function kindShortLabel(kind: PirStructureNodeKind): string {
  switch (kind) {
    case 'project':
      return 'PRJ';
    case 'machine':
      return 'MCH';
    case 'station':
      return 'STN';
    case 'equipment':
      return 'EQP';
  }
}

/**
 * One-line count badge per kind — the most operator-relevant tally for that
 * level. The full summary lives in the details panel; this is just the hint
 * shown next to the label.
 */
function countLabelFor(node: PirStructureNodeTree): string | null {
  const s = node.summary;
  switch (node.kind) {
    case 'project': {
      const n = s.machines;
      return typeof n === 'number' ? `${n} machine${n === 1 ? '' : 's'}` : null;
    }
    case 'machine': {
      const n = s.stations;
      return typeof n === 'number' ? `${n} station${n === 1 ? '' : 's'}` : null;
    }
    case 'station': {
      const n = s.equipment;
      return typeof n === 'number' ? `${n} eq.` : null;
    }
    case 'equipment': {
      const t = s.type;
      return typeof t === 'string' ? t : null;
    }
  }
}
