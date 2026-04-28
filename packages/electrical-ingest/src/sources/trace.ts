// Sprint 72 — source-traceability helpers. Every node, edge, and
// PIR candidate carries a `sourceRefs` array; consumers (review
// UI, postmortem reports, codegen explainability) need a single
// canonical formatter + structural equality + dedup-merge.

import type { SourceRef } from '../types.js';

/**
 * Format a source ref for human reading. Examples:
 *   "eplan-export#sheet=10/page=1: -K2.1 (line 47)"
 *   "csv:terminal-list.csv (line 12, column 3)"
 *   "manual:sourceId=op-2026-04-28"
 *
 * Non-essential fields are dropped silently when empty, so the
 * output stays short for compact diagnostics.
 */
export function formatSourceRef(ref: SourceRef | null | undefined): string {
  if (!ref || typeof ref !== 'object') return '<no-source>';
  const parts: string[] = [`${ref.kind}`];
  if (typeof ref.path === 'string' && ref.path.length > 0) parts[0] = `${ref.kind}:${ref.path}`;
  const locator: string[] = [];
  if (ref.sheet) locator.push(`sheet=${ref.sheet}`);
  if (ref.page) locator.push(`page=${ref.page}`);
  if (ref.symbol) locator.push(`symbol=${ref.symbol}`);
  if (ref.rawId) locator.push(`raw=${ref.rawId}`);
  if (locator.length > 0) parts.push(`#${locator.join('/')}`);
  const lineCol: string[] = [];
  if (typeof ref.line === 'number') lineCol.push(`line ${ref.line}`);
  if (typeof ref.column === 'number') lineCol.push(`column ${ref.column}`);
  if (lineCol.length > 0) parts.push(`(${lineCol.join(', ')})`);
  if (typeof ref.sourceId === 'string' && ref.sourceId.length > 0) {
    parts.push(`[sourceId=${ref.sourceId}]`);
  }
  return parts.join(' ');
}

/**
 * Structural equality over the canonical SourceRef fields. Two
 * refs are equal iff every observable field matches exactly
 * (`undefined`-vs-missing distinction is collapsed).
 */
export function sourceRefsEqual(
  a: SourceRef | null | undefined,
  b: SourceRef | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.sourceId === b.sourceId &&
    a.kind === b.kind &&
    (a.page ?? null) === (b.page ?? null) &&
    (a.sheet ?? null) === (b.sheet ?? null) &&
    (a.path ?? null) === (b.path ?? null) &&
    (a.symbol ?? null) === (b.symbol ?? null) &&
    (a.line ?? null) === (b.line ?? null) &&
    (a.column ?? null) === (b.column ?? null) &&
    (a.rawId ?? null) === (b.rawId ?? null)
  );
}

/**
 * Merge multiple sourceRef arrays, deduplicating by structural
 * equality. Preserves first-seen order — useful when callers want
 * "earliest source listed first" semantics.
 */
export function mergeSourceRefs(
  ...lists: ReadonlyArray<readonly SourceRef[] | null | undefined>
): SourceRef[] {
  const out: SourceRef[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const ref of list) {
      if (!ref || typeof ref !== 'object') continue;
      if (out.some((existing) => sourceRefsEqual(existing, ref))) continue;
      out.push(ref);
    }
  }
  return out;
}
