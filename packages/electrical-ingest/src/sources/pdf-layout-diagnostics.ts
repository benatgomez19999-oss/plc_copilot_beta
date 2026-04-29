// Sprint 84.1B — PDF layout diagnostic rollups.
//
// Sprint 84 / 84.1 emit `PDF_LAYOUT_MULTI_COLUMN_DETECTED` and
// `PDF_LAYOUT_REGION_CLUSTERED` once per page. On the 86-page
// TcECAD test fixture that produced dozens of layout-info
// diagnostic rows in the operator panel — undoing the Sprint
// 83B → 83F rollup hygiene work for a different reason. Sprint
// 84.1B keeps the same diagnostic *codes* but emits them as
// compact rollups: one diagnostic per code, with a compressed
// page-range string and (when there's variation) a count
// summary.
//
// Pure / DOM-free / total. No new diagnostic codes, no schema
// bump, no extraction-capability change.

import { createElectricalDiagnostic } from '../diagnostics.js';
import type { ElectricalDiagnostic } from '../types.js';
import { compressPageRanges } from './pdf-table-detect.js';

/**
 * Sprint 84.1B — one finding per page that exhibited a layout
 * signal. The collector emits one finding per call; the rollup
 * emitter compresses many findings into one diagnostic at the
 * end of the ingest pass.
 */
export interface LayoutPageFinding {
  /** 1-based PDF page number. */
  page: number;
  /** Layout-specific count: column count, region count, etc. */
  count: number;
}

export interface LayoutDiagnosticRollupInput {
  /** Pages where `detectColumnLayout` flagged multi-column ordering. */
  multiColumnPages: ReadonlyArray<LayoutPageFinding>;
  /** Pages where `clusterBlocksIntoRegions` returned ≥ 2 regions. */
  regionClusterPages: ReadonlyArray<LayoutPageFinding>;
}

function uniqValidPages(
  findings: ReadonlyArray<LayoutPageFinding>,
): LayoutPageFinding[] {
  const byPage = new Map<number, LayoutPageFinding>();
  for (const f of findings) {
    if (!f || typeof f !== 'object') continue;
    if (!Number.isFinite(f.page) || f.page < 1) continue;
    if (!Number.isFinite(f.count) || f.count < 0) continue;
    // Keep first finding per page; subsequent ones (re-runs) are
    // considered idempotent and discarded.
    if (!byPage.has(f.page)) byPage.set(f.page, f);
  }
  return Array.from(byPage.values()).sort((a, b) => a.page - b.page);
}

function pagePhrase(pages: ReadonlyArray<number>): string {
  if (pages.length === 0) return '';
  const range = compressPageRanges(pages);
  return pages.length === 1 ? `page ${range}` : `pages ${range}`;
}

function countMinMaxSuffix(findings: ReadonlyArray<LayoutPageFinding>): string {
  if (findings.length === 0) return '';
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const f of findings) {
    if (f.count < lo) lo = f.count;
    if (f.count > hi) hi = f.count;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '';
  return lo === hi ? String(lo) : `${lo} to ${hi}`;
}

function buildMultiColumnRollup(
  findings: ReadonlyArray<LayoutPageFinding>,
): ElectricalDiagnostic | null {
  const filtered = uniqValidPages(findings);
  if (filtered.length === 0) return null;
  const phrase = pagePhrase(filtered.map((f) => f.page));
  const minMax = countMinMaxSuffix(filtered);
  const sameCount = filtered.every((f) => f.count === filtered[0].count);
  const tail = sameCount
    ? ` (${filtered[0].count} columns)`
    : ` Column counts ranged from ${minMax}.`;
  return createElectricalDiagnostic({
    code: 'PDF_LAYOUT_MULTI_COLUMN_DETECTED',
    severity: 'info',
    message:
      `Detected multi-column layout on ${phrase}; ` +
      `using column-aware reading order.` +
      (sameCount ? tail : tail),
  });
}

function buildRegionClusterRollup(
  findings: ReadonlyArray<LayoutPageFinding>,
): ElectricalDiagnostic | null {
  const filtered = uniqValidPages(findings);
  if (filtered.length === 0) return null;
  const phrase = pagePhrase(filtered.map((f) => f.page));
  const minMax = countMinMaxSuffix(filtered);
  const sameCount = filtered.every((f) => f.count === filtered[0].count);
  const tail =
    filtered.length === 1
      ? ` Region count: ${filtered[0].count}.`
      : sameCount
        ? ` Region count: ${filtered[0].count}.`
        : ` Region counts ranged from ${minMax}.`;
  return createElectricalDiagnostic({
    code: 'PDF_LAYOUT_REGION_CLUSTERED',
    severity: 'info',
    message:
      `Clustered page layout into vertical regions on ${phrase}; ` +
      `IO-table walks are scoped to a single region where region ` +
      `boundaries are available.` +
      tail,
  });
}

/**
 * Sprint 84.1B — emit at most one diagnostic per layout code.
 * Order is deterministic: multi-column rollup first, then
 * region-cluster rollup. Empty inputs produce zero diagnostics
 * (text-mode without geometry continues to emit nothing — the
 * Sprint 84 contract).
 */
export function buildLayoutDiagnosticRollups(
  input: LayoutDiagnosticRollupInput,
): ElectricalDiagnostic[] {
  const out: ElectricalDiagnostic[] = [];
  const multi = buildMultiColumnRollup(input.multiColumnPages ?? []);
  if (multi) out.push(multi);
  const region = buildRegionClusterRollup(input.regionClusterPages ?? []);
  if (region) out.push(region);
  return out;
}
