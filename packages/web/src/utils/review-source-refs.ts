// Sprint 75 — source-ref drilldown helpers for the review UI.
// Pure: no DOM, no side effects. The components render whatever
// these functions return.

import type { SourceRef } from '@plccopilot/electrical-ingest';

export interface SourceRefField {
  /** Stable key for React lists / aria-label hooks. */
  key: string;
  /** Field label as shown to the operator. */
  label: string;
  /** Field value as a string. */
  value: string;
}

export interface SourceRefSummary {
  /** Stable key derived from the ref's identity (kind + path + line + symbol). */
  key: string;
  /** Compact one-liner for table-cell display. */
  oneLiner: string;
  /** Field-by-field rows for the drilldown panel. */
  fields: SourceRefField[];
  /** The originating ref, kept for callers that need raw access. */
  raw: SourceRef;
}

/**
 * Project a `SourceRef` into a UI-ready summary. Missing optional
 * fields are silently omitted from `fields` (the component must
 * not render them as "undefined" / "null"). The drilldown shows
 * what the ingestor actually emitted, nothing more — honest about
 * gaps in source coverage.
 *
 * Field order is stable: sourceId, kind, path, line, column, sheet,
 * page (n/a here — we coerce missing into nothing), rawId, symbol.
 */
export function summarizeSourceRef(ref: SourceRef): SourceRefSummary {
  const fields: SourceRefField[] = [];
  pushField(fields, 'sourceId', 'Source id', ref.sourceId);
  pushField(fields, 'kind', 'Source kind', ref.kind);
  pushField(fields, 'path', 'File', ref.path);
  if (typeof ref.line === 'number') {
    pushField(fields, 'line', 'Line', String(ref.line));
  }
  if (typeof ref.column === 'number') {
    pushField(fields, 'column', 'Column', String(ref.column));
  }
  pushField(fields, 'sheet', 'Sheet', ref.sheet);
  pushField(fields, 'page', 'Page', ref.page);
  pushField(fields, 'rawId', 'Raw id', ref.rawId);
  // EPLAN ingestor stores the XML locator under `symbol`; we
  // surface it as "XML locator" to make the UI label match the
  // ingestor doc.
  if (typeof ref.symbol === 'string' && ref.symbol.length > 0) {
    pushField(
      fields,
      'symbol',
      ref.kind === 'eplan' || ref.kind === 'eplan-export'
        ? 'XML locator'
        : 'Symbol',
      ref.symbol,
    );
  }
  // Sprint 82 — surface the PDF source snippet + bbox the
  // extractor populates (Sprint 80/81). Earlier sprints had the
  // data in the SourceRef but no UI projection; the manual
  // acceptance run on TcECAD_Import_V2_2_x.pdf showed snippets
  // missing from the source-ref drilldown.
  if (typeof ref.snippet === 'string' && ref.snippet.length > 0) {
    pushField(fields, 'snippet', 'Snippet', ref.snippet);
  }
  if (
    ref.bbox &&
    typeof ref.bbox === 'object' &&
    Number.isFinite(ref.bbox.x) &&
    Number.isFinite(ref.bbox.y) &&
    Number.isFinite(ref.bbox.width) &&
    Number.isFinite(ref.bbox.height)
  ) {
    const unit = typeof ref.bbox.unit === 'string' ? ref.bbox.unit : '';
    pushField(
      fields,
      'bbox',
      'Bounding box',
      `x=${ref.bbox.x.toFixed(1)} y=${ref.bbox.y.toFixed(1)} ` +
        `w=${ref.bbox.width.toFixed(1)} h=${ref.bbox.height.toFixed(1)}` +
        (unit.length > 0 ? ` (${unit})` : ''),
    );
  }

  const oneLiner = buildOneLiner(ref);
  const key = [
    ref.kind,
    ref.path ?? '',
    ref.line ?? '',
    ref.symbol ?? '',
    ref.sourceId,
  ].join('|');
  return { key, oneLiner, fields, raw: ref };
}

function pushField(
  fields: SourceRefField[],
  key: string,
  label: string,
  value: string | number | null | undefined,
): void {
  if (typeof value === 'number' && Number.isFinite(value)) {
    fields.push({ key, label, value: String(value) });
    return;
  }
  if (typeof value !== 'string' || value.length === 0) return;
  fields.push({ key, label, value });
}

function buildOneLiner(ref: SourceRef): string {
  const parts: string[] = [];
  parts.push(ref.kind);
  if (ref.path) parts.push(ref.path);
  if (typeof ref.line === 'number') parts.push(`L${ref.line}`);
  if (ref.sheet) parts.push(`sheet ${ref.sheet}`);
  if (ref.rawId) parts.push(ref.rawId);
  return parts.join(' · ');
}

/**
 * Group source refs by `kind` so the drilldown can surface "this
 * device is backed by 2 CSV rows + 1 EPLAN element" without
 * shuffling them. Kinds are returned in deterministic order.
 */
export interface SourceRefGroup {
  kind: SourceRef['kind'];
  refs: SourceRefSummary[];
}

const KIND_ORDER: ReadonlyArray<SourceRef['kind']> = [
  'eplan',
  'eplan-export',
  'csv',
  'xml',
  // Sprint 78A — Beckhoff/TwinCAT ECAD lives next to its sibling
  // ECAD-export sources; Sprint 82 added it to the projection
  // ordering so its drilldown groups under the structured-source
  // family rather than falling through to "unknown".
  'twincat_ecad',
  'pdf',
  'manual',
  'unknown',
];

export function groupSourceRefsByKind(
  refs: ReadonlyArray<SourceRef>,
): SourceRefGroup[] {
  const buckets = new Map<SourceRef['kind'], SourceRefSummary[]>();
  for (const ref of refs ?? []) {
    if (!ref || typeof ref !== 'object') continue;
    const summary = summarizeSourceRef(ref);
    const list = buckets.get(ref.kind) ?? [];
    list.push(summary);
    buckets.set(ref.kind, list);
  }
  const groups: SourceRefGroup[] = [];
  for (const kind of KIND_ORDER) {
    const list = buckets.get(kind);
    if (list && list.length > 0) groups.push({ kind, refs: list });
  }
  // Catch any kinds we don't know about — append in insertion order.
  for (const [kind, list] of buckets) {
    if (!KIND_ORDER.includes(kind) && list.length > 0) {
      groups.push({ kind, refs: list });
    }
  }
  return groups;
}

/**
 * Sentinel summary returned by the panel when an item carries no
 * source refs at all. The architecture insists on traceability, so
 * an item without refs is itself a finding the UI must surface.
 */
export const NO_SOURCE_REFS_SUMMARY: SourceRefSummary = Object.freeze({
  key: '__no_source_refs__',
  oneLiner: 'no source evidence',
  fields: [],
  raw: { sourceId: '', kind: 'unknown' as const },
});
