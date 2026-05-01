// Sprint 98 — Parameter review-card projection.
//
// Pure / DOM-free / total. Sprint 88L → Sprint 97 wired the
// industrial side (CSV / EPLAN / TcECAD parameter extraction +
// PIR R-PR-03 range / unit validation). The review surface in
// `@plccopilot/web` did not have a dedicated parameter card —
// operators saw IO + equipment + assumptions but had no place
// to inspect the metadata Sprint 97 finally enforces. Sprint 98
// closes that UX gap with this small, helper-driven projection
// of `PirParameterCandidate` into renderer-friendly strings +
// status badges.
//
// Hard rules:
//   - Pure: no DOM, no I/O, no clock, no random.
//   - Total: every field on `PirParameterCandidate` may be
//     missing or malformed; the helper never throws and falls
//     back to safe placeholder strings.
//   - Deterministic: same input → byte-identical output.
//   - No mutation: input candidate is never modified.
//   - No new validation semantics. The helper *describes* what
//     the candidate carries; PIR R-PR-03 + the existing
//     ingestion diagnostics decide whether the build will
//     accept the parameter.

import type { PirParameterCandidate } from '@plccopilot/electrical-ingest';

import type { PolishStatusToken } from './codegen-preview-panel-view.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Polish-token subset the parameter card emits. Keeps the call
 * site honest about which Sprint 93 tokens we map onto, so a
 * future palette change in `codegen-preview-panel-view.ts`
 * automatically applies here too.
 */
export type ParameterReviewBadgeToken = Extract<
  PolishStatusToken,
  'info' | 'warning' | 'ready' | 'unavailable' | 'failed'
>;

export interface ParameterReviewBadge {
  /** Sprint 93 unified-palette token. */
  readonly token: ParameterReviewBadgeToken;
  /** Operator-facing label (e.g. "Range", "No unit"). */
  readonly label: string;
  /**
   * Optional title attribute the renderer can attach for hover
   * tooltips. Always present so the renderer stays uniform.
   */
  readonly hint: string;
}

export interface ParameterReviewDetailRow {
  readonly label: string;
  readonly value: string;
}

export interface ParameterReviewView {
  /** Echo of `PirParameterCandidate.id`; used as the row key. */
  readonly id: string;
  /** Human label — falls back to the id when no `label` is set. */
  readonly label: string;
  /** Capitalised dtype string ("Real" / "Int" / "DInt" / "Bool"). */
  readonly dataTypeLabel: string;
  /** Number-stringified default, or "Missing default". */
  readonly defaultLabel: string;
  /** Engineering unit string, or "No unit". */
  readonly unitLabel: string;
  /** Range expression (e.g. "0–60", "≥ 0", "≤ 60", "50", "No range"). */
  readonly rangeLabel: string;
  /** One-line summary the card renders below the id. */
  readonly summary: string;
  /** Status badges (Sprint 93 unified palette tokens). */
  readonly badges: ReadonlyArray<ParameterReviewBadge>;
  /** Detail rows for the expand-to-see-more `<details>` block. */
  readonly detailRows: ReadonlyArray<ParameterReviewDetailRow>;
}

// ---------------------------------------------------------------------------
// Public entry
// ---------------------------------------------------------------------------

/**
 * Build the renderer-friendly view of a parameter candidate.
 * Pure / total. Tolerates missing or malformed fields without
 * throwing; the resulting view always carries human-readable
 * placeholder strings so the card stays scannable even on
 * partial data.
 */
export function buildParameterReviewView(
  parameter: PirParameterCandidate,
): ParameterReviewView {
  const id = readId(parameter);
  const dtype = readDataType(parameter);
  const dataTypeLabel = formatDataTypeLabel(dtype);

  const defaultInfo = readDefault(parameter);
  const defaultLabel = formatDefaultLabel(defaultInfo);

  const unitInfo = readUnit(parameter);
  const unitLabel = formatUnitLabel(unitInfo);

  const rangeInfo = readRange(parameter);
  const rangeLabel = formatRangeLabel(rangeInfo);

  const label = readLabel(parameter, id);
  const summary = formatSummary({
    dataTypeLabel,
    defaultInfo,
    unitInfo,
    rangeInfo,
  });
  const badges = buildBadges({ defaultInfo, unitInfo, rangeInfo });
  const detailRows = buildDetailRows({
    id,
    dtype,
    defaultInfo,
    unitInfo,
    rangeInfo,
  });

  return {
    id,
    label,
    dataTypeLabel,
    defaultLabel,
    unitLabel,
    rangeLabel,
    summary,
    badges,
    detailRows,
  };
}

// ---------------------------------------------------------------------------
// Internal — field reads
// ---------------------------------------------------------------------------

interface DefaultInfo {
  /** Numeric value if finite, otherwise null. */
  readonly value: number | null;
  /** True iff a `defaultValue` was present on the candidate. */
  readonly present: boolean;
  /** True iff the defaultValue was present but non-finite. */
  readonly nonFinite: boolean;
}

interface UnitInfo {
  /** Trimmed unit string if non-empty, otherwise null. */
  readonly value: string | null;
}

interface RangeInfo {
  /** Trimmed numeric value if finite, otherwise null. */
  readonly min: number | null;
  readonly max: number | null;
  /** True iff `min` was present on the candidate but non-finite. */
  readonly minNonFinite: boolean;
  readonly maxNonFinite: boolean;
  /** True iff `min > max` after both passed the finite check. */
  readonly inverted: boolean;
  /** True iff the candidate's `defaultValue` lies outside `[min, max]`. */
  readonly defaultOutOfRange: boolean;
}

function readId(p: PirParameterCandidate): string {
  return typeof p.id === 'string' && p.id.length > 0 ? p.id : 'unknown';
}

function readLabel(p: PirParameterCandidate, fallback: string): string {
  if (typeof p.label === 'string' && p.label.trim().length > 0) {
    return p.label.trim();
  }
  return fallback;
}

function readDataType(p: PirParameterCandidate): string {
  if (typeof p.dataType === 'string' && p.dataType.length > 0) {
    return p.dataType;
  }
  return '';
}

function readDefault(p: PirParameterCandidate): DefaultInfo {
  // `PirParameterCandidate.defaultValue` is typed as `number`, but
  // a malformed JSON payload could land here as undefined / NaN /
  // Infinity. Tolerate every variant.
  const raw = (p as { defaultValue?: unknown }).defaultValue;
  if (raw === undefined || raw === null) {
    return { value: null, present: false, nonFinite: false };
  }
  if (typeof raw !== 'number') {
    return { value: null, present: true, nonFinite: true };
  }
  if (!Number.isFinite(raw)) {
    return { value: null, present: true, nonFinite: true };
  }
  return { value: raw, present: true, nonFinite: false };
}

function readUnit(p: PirParameterCandidate): UnitInfo {
  if (typeof p.unit !== 'string') return { value: null };
  const trimmed = p.unit.trim();
  if (trimmed.length === 0) return { value: null };
  return { value: trimmed };
}

function readRange(p: PirParameterCandidate): RangeInfo {
  const minRaw = (p as { min?: unknown }).min;
  const maxRaw = (p as { max?: unknown }).max;
  const minPresent = minRaw !== undefined && minRaw !== null;
  const maxPresent = maxRaw !== undefined && maxRaw !== null;

  const minFinite =
    minPresent && typeof minRaw === 'number' && Number.isFinite(minRaw);
  const maxFinite =
    maxPresent && typeof maxRaw === 'number' && Number.isFinite(maxRaw);

  const min = minFinite ? (minRaw as number) : null;
  const max = maxFinite ? (maxRaw as number) : null;
  const minNonFinite = minPresent && !minFinite;
  const maxNonFinite = maxPresent && !maxFinite;
  const inverted = min !== null && max !== null && min > max;

  let defaultOutOfRange = false;
  const def = readDefault(p);
  if (def.value !== null) {
    if (min !== null && def.value < min) defaultOutOfRange = true;
    if (max !== null && def.value > max) defaultOutOfRange = true;
  }

  return {
    min,
    max,
    minNonFinite,
    maxNonFinite,
    inverted,
    defaultOutOfRange,
  };
}

// ---------------------------------------------------------------------------
// Internal — formatters
// ---------------------------------------------------------------------------

function formatDataTypeLabel(dtype: string): string {
  const v = dtype.toLowerCase();
  if (v === 'int') return 'Int';
  if (v === 'dint') return 'DInt';
  if (v === 'real') return 'Real';
  if (v === 'bool') return 'Bool';
  return 'Unknown type';
}

function formatDefaultLabel(info: DefaultInfo): string {
  if (!info.present || info.nonFinite) return 'Missing default';
  return formatNumber(info.value as number);
}

function formatUnitLabel(info: UnitInfo): string {
  if (info.value === null) return 'No unit';
  return info.value;
}

function formatRangeLabel(info: RangeInfo): string {
  if (info.minNonFinite || info.maxNonFinite || info.inverted) {
    return 'Invalid range metadata';
  }
  if (info.min === null && info.max === null) return 'No range';
  if (info.min !== null && info.max !== null) {
    if (info.min === info.max) return formatNumber(info.min);
    return `${formatNumber(info.min)}–${formatNumber(info.max)}`;
  }
  if (info.min !== null) return `≥ ${formatNumber(info.min)}`;
  return `≤ ${formatNumber(info.max as number)}`;
}

function formatSummary(args: {
  dataTypeLabel: string;
  defaultInfo: DefaultInfo;
  unitInfo: UnitInfo;
  rangeInfo: RangeInfo;
}): string {
  const parts: string[] = [args.dataTypeLabel];
  parts.push(
    args.defaultInfo.present && !args.defaultInfo.nonFinite
      ? `default ${formatNumber(args.defaultInfo.value as number)}`
      : 'missing default',
  );
  parts.push(
    args.unitInfo.value === null ? 'no unit' : args.unitInfo.value,
  );
  const rangeFragment =
    args.rangeInfo.minNonFinite ||
    args.rangeInfo.maxNonFinite ||
    args.rangeInfo.inverted
      ? 'invalid range'
      : args.rangeInfo.min === null && args.rangeInfo.max === null
        ? 'no range'
        : `range ${formatRangeLabel(args.rangeInfo)}`;
  parts.push(rangeFragment);
  return parts.join(' · ');
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Number.isInteger(n) ? String(n) : String(n);
}

// ---------------------------------------------------------------------------
// Internal — badges
// ---------------------------------------------------------------------------

function buildBadges(args: {
  defaultInfo: DefaultInfo;
  unitInfo: UnitInfo;
  rangeInfo: RangeInfo;
}): ParameterReviewBadge[] {
  const badges: ParameterReviewBadge[] = [];

  if (args.rangeInfo.minNonFinite || args.rangeInfo.maxNonFinite) {
    badges.push({
      token: 'failed',
      label: 'Invalid range metadata',
      hint:
        'min / max must be finite numbers; PIR R-PR-03 will reject this on build.',
    });
  } else if (args.rangeInfo.inverted) {
    badges.push({
      token: 'failed',
      label: 'Invalid range metadata',
      hint:
        'min is greater than max; PIR R-PR-03 will reject this on build.',
    });
  } else if (args.rangeInfo.min !== null || args.rangeInfo.max !== null) {
    badges.push({
      token: 'ready',
      label: 'Range',
      hint: 'parameter has explicit numeric bounds.',
    });
  } else {
    badges.push({
      token: 'info',
      label: 'No range',
      hint:
        'parameter has no explicit min / max; ingestion never inferred bounds from comments.',
    });
  }

  if (args.unitInfo.value === null) {
    badges.push({
      token: 'warning',
      label: 'No unit',
      hint:
        'parameter has no unit; PIR R-PR-03 surfaces this as info on speed_setpoint_out roles.',
    });
  } else {
    badges.push({
      token: 'info',
      label: `Unit ${args.unitInfo.value}`,
      hint: 'parameter declares an explicit engineering unit.',
    });
  }

  if (args.defaultInfo.present && args.defaultInfo.nonFinite) {
    badges.push({
      token: 'failed',
      label: 'Invalid default',
      hint:
        'default is non-finite; the PIR builder will refuse this candidate.',
    });
  } else if (!args.defaultInfo.present) {
    badges.push({
      token: 'failed',
      label: 'Missing default',
      hint: 'a numeric default is required by the PIR builder.',
    });
  }

  if (
    args.rangeInfo.defaultOutOfRange &&
    args.defaultInfo.value !== null &&
    !args.rangeInfo.inverted &&
    !args.rangeInfo.minNonFinite &&
    !args.rangeInfo.maxNonFinite
  ) {
    badges.push({
      token: 'warning',
      label: 'Default outside range',
      hint:
        'default lies outside the declared min / max; PIR R-PR-02 will reject this on build.',
    });
  }

  return badges;
}

// ---------------------------------------------------------------------------
// Internal — detail rows
// ---------------------------------------------------------------------------

function buildDetailRows(args: {
  id: string;
  dtype: string;
  defaultInfo: DefaultInfo;
  unitInfo: UnitInfo;
  rangeInfo: RangeInfo;
}): ParameterReviewDetailRow[] {
  const rows: ParameterReviewDetailRow[] = [];
  rows.push({ label: 'Id', value: args.id });
  rows.push({
    label: 'Data type',
    value: args.dtype.length > 0 ? args.dtype : 'unknown',
  });
  rows.push({
    label: 'Default',
    value:
      args.defaultInfo.present && !args.defaultInfo.nonFinite
        ? formatNumber(args.defaultInfo.value as number)
        : 'missing',
  });
  rows.push({
    label: 'Unit',
    value: args.unitInfo.value ?? 'none',
  });
  rows.push({
    label: 'Min',
    value: args.rangeInfo.minNonFinite
      ? 'invalid'
      : args.rangeInfo.min !== null
        ? formatNumber(args.rangeInfo.min)
        : 'none',
  });
  rows.push({
    label: 'Max',
    value: args.rangeInfo.maxNonFinite
      ? 'invalid'
      : args.rangeInfo.max !== null
        ? formatNumber(args.rangeInfo.max)
        : 'none',
  });
  return rows;
}
