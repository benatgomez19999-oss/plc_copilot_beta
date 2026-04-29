// Sprint 84 — PDF layout hardening v0.
//
// Pure / DOM-free / total. The Sprint 80 text-layer extractor
// produces `PdfTextBlock[]` with optional bboxes (PDF point
// space, origin bottom-left). Sprint 81 onwards consumed these
// blocks in extraction order, which is fine for single-column
// pages but interleaves columns on multi-column layouts. Sprint
// 84 adds layout-analysis helpers that operate on block geometry
// when present and fall back to extraction order when it isn't.
//
// Design constraints (load-bearing — do not relax):
//   - **No new extraction capability.** Sprint 84 v0 only
//     reorders / clusters blocks the extractor already emitted;
//     it never invents a row, a column, or a SourceRef.
//   - **Backwards compatible.** When blocks have no bboxes
//     (Sprint 79 test-mode text inputs) every helper returns a
//     no-op equivalent of the input order. Existing tests stay
//     green.
//   - **Pure / total.** Helpers never throw on malformed input;
//     missing fields fall through to single-column / no-region
//     paths.
//   - **No Sprint 82 strictness changes.** Address gating still
//     belongs to `pdf-address-strictness.ts`.
//   - **No Sprint 83A/B/C/D classifier changes.** Family /
//     hygiene / canonical-key code paths are untouched.

import type { PdfBoundingBox, PdfPage, PdfTextBlock } from './pdf-types.js';

// ---------------------------------------------------------------------------
// Column-layout detection
// ---------------------------------------------------------------------------

export interface PdfColumn {
  /** 0-based, left-to-right index. */
  index: number;
  /** Min x of every block assigned to this column (bbox.x). */
  xLeft: number;
  /** Max right edge (bbox.x + bbox.width). */
  xRight: number;
  /** Member blocks in column reading order (top-to-bottom). */
  blocks: PdfTextBlock[];
}

export interface PdfColumnLayout {
  columns: PdfColumn[];
  /** True when ≥ 2 columns were detected with ≥ `minBlocksPerColumn` each. */
  multiColumn: boolean;
  /** Best-effort orientation. `'unknown'` when the page width/height aren't known. */
  orientation: 'portrait' | 'landscape' | 'unknown';
}

export interface DetectColumnLayoutOptions {
  /**
   * Minimum gap between adjacent column centerlines, in PDF
   * points, for the gap to count as a column boundary. Default
   * `36pt` — half an inch in default PDF point space, which
   * comfortably exceeds inter-word gaps and intra-column variance.
   */
  minColumnGapPt?: number;
  /**
   * Minimum number of blocks a column must hold before it counts
   * toward `multiColumn`. Default `3` so a single isolated label
   * on the right margin doesn't create a phantom column.
   */
  minBlocksPerColumn?: number;
  /** Optional page geometry, used to derive orientation. */
  pageWidth?: number;
  pageHeight?: number;
}

const DEFAULT_MIN_COLUMN_GAP_PT = 36;
const DEFAULT_MIN_BLOCKS_PER_COLUMN = 3;

function blockCenterX(block: PdfTextBlock): number | null {
  if (!block.bbox) return null;
  if (
    !Number.isFinite(block.bbox.x) ||
    !Number.isFinite(block.bbox.width)
  ) {
    return null;
  }
  return block.bbox.x + block.bbox.width / 2;
}

function pageOrientation(
  width: number | undefined,
  height: number | undefined,
): PdfColumnLayout['orientation'] {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 'unknown';
  if ((width as number) > (height as number)) return 'landscape';
  return 'portrait';
}

/**
 * Sprint 84 — detect a multi-column layout from the geometry of
 * a page's text blocks. Returns a single-column layout when:
 *   - fewer than `2 * minBlocksPerColumn` blocks have bboxes,
 *   - the centerline gaps never exceed `minColumnGapPt`,
 *   - the input is empty / non-array.
 */
export function detectColumnLayout(
  blocks: ReadonlyArray<PdfTextBlock>,
  options: DetectColumnLayoutOptions = {},
): PdfColumnLayout {
  const minGap = options.minColumnGapPt ?? DEFAULT_MIN_COLUMN_GAP_PT;
  const minBlocks =
    options.minBlocksPerColumn ?? DEFAULT_MIN_BLOCKS_PER_COLUMN;
  const orientation = pageOrientation(options.pageWidth, options.pageHeight);
  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { columns: [], multiColumn: false, orientation };
  }

  // Single-column fast path: no geometry, or too few geometry-bearing blocks.
  const withGeometry = blocks.filter((b) => blockCenterX(b) != null);
  if (withGeometry.length < minBlocks * 2) {
    return {
      columns: [
        {
          index: 0,
          xLeft: 0,
          xRight: 0,
          blocks: blocks.slice(),
        },
      ],
      multiColumn: false,
      orientation,
    };
  }

  // Cluster centerlines. The algorithm is one-pass: sort by
  // center, find gaps > `minGap`, every gap opens a new column.
  const indexed = withGeometry
    .map((b) => ({ block: b, center: blockCenterX(b) as number }))
    .sort((a, b) => a.center - b.center);

  type ColumnAcc = { centers: number[]; blocks: PdfTextBlock[] };
  const accs: ColumnAcc[] = [];
  let current: ColumnAcc | null = null;
  let lastCenter = Number.NEGATIVE_INFINITY;
  for (const entry of indexed) {
    if (current == null || entry.center - lastCenter > minGap) {
      current = { centers: [], blocks: [] };
      accs.push(current);
    }
    current.centers.push(entry.center);
    current.blocks.push(entry.block);
    lastCenter = entry.center;
  }

  // Drop columns that don't meet the size floor — they're more
  // likely floating labels than real columns. Their blocks fall
  // into the nearest neighbour column.
  const meaningful = accs.filter((c) => c.blocks.length >= minBlocks);
  if (meaningful.length <= 1) {
    return {
      columns: [
        {
          index: 0,
          xLeft: 0,
          xRight: 0,
          blocks: blocks.slice(),
        },
      ],
      multiColumn: false,
      orientation,
    };
  }

  // Re-attach orphan blocks (centers that fell into a too-small
  // accumulator) to the closest meaningful column by centerline
  // distance.
  const meaningfulCenters = meaningful.map(
    (c) => c.centers.reduce((s, v) => s + v, 0) / c.centers.length,
  );
  for (const acc of accs) {
    if (meaningful.includes(acc)) continue;
    for (const b of acc.blocks) {
      const cx = blockCenterX(b) as number;
      let best = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < meaningfulCenters.length; i++) {
        const d = Math.abs(meaningfulCenters[i] - cx);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
      meaningful[best].blocks.push(b);
    }
  }

  // Re-attach blocks that had no bbox to the leftmost column —
  // they preserve their position in the input order so any
  // metadata lines (titles, etc.) don't get shoved out of order.
  const noGeometry = blocks.filter((b) => blockCenterX(b) == null);
  if (noGeometry.length > 0 && meaningful[0]) {
    meaningful[0].blocks.push(...noGeometry);
  }

  const columns: PdfColumn[] = meaningful.map((acc, idx) => {
    let xLeft = Number.POSITIVE_INFINITY;
    let xRight = Number.NEGATIVE_INFINITY;
    for (const b of acc.blocks) {
      const cx = blockCenterX(b);
      if (cx == null || !b.bbox) continue;
      if (b.bbox.x < xLeft) xLeft = b.bbox.x;
      const right = b.bbox.x + b.bbox.width;
      if (right > xRight) xRight = right;
    }
    return {
      index: idx,
      xLeft: Number.isFinite(xLeft) ? xLeft : 0,
      xRight: Number.isFinite(xRight) ? xRight : 0,
      blocks: acc.blocks,
    };
  });
  return { columns, multiColumn: columns.length > 1, orientation };
}

// ---------------------------------------------------------------------------
// Reading-order
// ---------------------------------------------------------------------------

/**
 * Sprint 84 — order blocks by reading order. Pure / total /
 * deterministic. PDF coordinates have origin at bottom-left, so
 * "top-to-bottom" is **descending** y of `bbox.y + bbox.height`
 * (the top edge). Falls back to input order when no blocks have
 * bboxes (Sprint 79 test-mode preserved).
 *
 * For multi-column pages, blocks are returned column-by-column
 * (left-to-right), top-to-bottom inside each column.
 */
export function orderBlocksByLayout(
  blocks: ReadonlyArray<PdfTextBlock>,
  options: DetectColumnLayoutOptions = {},
): PdfTextBlock[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const layout = detectColumnLayout(blocks, options);
  // No-op fast path — preserves Sprint 79/81 test-mode behaviour
  // when blocks have no geometry.
  if (
    !layout.multiColumn &&
    blocks.every((b) => !b.bbox || !Number.isFinite(b.bbox.y))
  ) {
    return blocks.slice();
  }
  const sortColumn = (column: PdfColumn): PdfTextBlock[] => {
    const indexInInput = new Map<string, number>();
    blocks.forEach((b, i) => {
      indexInInput.set(b.id, i);
    });
    return column.blocks.slice().sort((a, b) => {
      const ay = blockTopY(a);
      const by = blockTopY(b);
      if (ay == null && by == null) {
        return (
          (indexInInput.get(a.id) ?? 0) - (indexInInput.get(b.id) ?? 0)
        );
      }
      if (ay == null) return 1; // bbox-less blocks sink to the end of the column
      if (by == null) return -1;
      // Descending y (top of page first).
      if (ay !== by) return by - ay;
      // Tie-break left-to-right by bbox.x for stability.
      const ax = a.bbox?.x ?? 0;
      const bx = b.bbox?.x ?? 0;
      return ax - bx;
    });
  };
  const out: PdfTextBlock[] = [];
  for (const column of layout.columns) {
    out.push(...sortColumn(column));
  }
  return out;
}

function blockTopY(block: PdfTextBlock): number | null {
  if (!block.bbox) return null;
  if (
    !Number.isFinite(block.bbox.y) ||
    !Number.isFinite(block.bbox.height)
  ) {
    return null;
  }
  return block.bbox.y + block.bbox.height;
}

// ---------------------------------------------------------------------------
// Region clustering
// ---------------------------------------------------------------------------

export interface PdfRegion {
  blocks: PdfTextBlock[];
  bbox: PdfBoundingBox;
}

export interface ClusterBlocksIntoRegionsOptions {
  /**
   * Vertical gap (in *median block heights*) that opens a new
   * region. Default `2.0` — twice the median line height. A
   * single blank line is ~1 height; a real region break (footer
   * separator, table-vs-narrative break) is typically ≥ 2.
   */
  vGapMultiplier?: number;
}

const DEFAULT_V_GAP_MULTIPLIER = 2.0;

/**
 * Sprint 84 — group blocks into vertical regions separated by
 * gaps larger than `vGapMultiplier * medianBlockHeight`. Pure /
 * total. Returns a single-region list (carrying all input blocks)
 * when fewer than 2 blocks have geometry, since region breaks
 * only make sense in geometric space.
 */
export function clusterBlocksIntoRegions(
  blocks: ReadonlyArray<PdfTextBlock>,
  options: ClusterBlocksIntoRegionsOptions = {},
): PdfRegion[] {
  if (!Array.isArray(blocks) || blocks.length === 0) return [];
  const vGapMul = options.vGapMultiplier ?? DEFAULT_V_GAP_MULTIPLIER;
  const withGeometry = blocks.filter(
    (b) =>
      b.bbox &&
      Number.isFinite(b.bbox.y) &&
      Number.isFinite(b.bbox.height),
  );
  if (withGeometry.length < 2) {
    return [{ blocks: blocks.slice(), bbox: regionBbox(blocks) }];
  }
  const heights = withGeometry
    .map((b) => b.bbox?.height ?? 0)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const medianHeight =
    heights.length === 0 ? 12 : heights[Math.floor(heights.length / 2)];
  const sorted = withGeometry.slice().sort((a, b) => {
    const ay = blockTopY(a);
    const by = blockTopY(b);
    return (by ?? 0) - (ay ?? 0); // descending y
  });
  const regions: PdfRegion[] = [];
  let current: PdfTextBlock[] = [];
  let prevBottom: number | null = null;
  for (const b of sorted) {
    const top = blockTopY(b);
    const bottom = b.bbox?.y;
    if (top == null || bottom == null) continue;
    if (
      current.length > 0 &&
      prevBottom != null &&
      prevBottom - top > vGapMul * medianHeight
    ) {
      regions.push({ blocks: current, bbox: regionBbox(current) });
      current = [];
    }
    current.push(b);
    prevBottom = bottom;
  }
  if (current.length > 0) {
    regions.push({ blocks: current, bbox: regionBbox(current) });
  }
  return regions;
}

function regionBbox(blocks: ReadonlyArray<PdfTextBlock>): PdfBoundingBox {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let any = false;
  for (const b of blocks) {
    if (!b.bbox) continue;
    if (
      !Number.isFinite(b.bbox.x) ||
      !Number.isFinite(b.bbox.y) ||
      !Number.isFinite(b.bbox.width) ||
      !Number.isFinite(b.bbox.height)
    ) {
      continue;
    }
    any = true;
    if (b.bbox.x < minX) minX = b.bbox.x;
    if (b.bbox.x + b.bbox.width > maxX) maxX = b.bbox.x + b.bbox.width;
    if (b.bbox.y < minY) minY = b.bbox.y;
    if (b.bbox.y + b.bbox.height > maxY) maxY = b.bbox.y + b.bbox.height;
  }
  if (!any) {
    return { x: 0, y: 0, width: 0, height: 0, unit: 'pt' };
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    unit: 'pt',
  };
}

// ---------------------------------------------------------------------------
// Rotation signal
// ---------------------------------------------------------------------------

export interface PdfRotationSignal {
  suspected: boolean;
  /** One of: `'none'`, `'page-rotation-tag'`, `'block-aspect-ratio'`. */
  reason: string;
  /** Median block aspect ratio (width / height) used by the heuristic. */
  medianAspect: number | null;
}

/**
 * Sprint 84 — flag pages whose rotation looks suspect. v0 only
 * *detects*; it does NOT un-rotate. The downstream extractor
 * surfaces a rotation diagnostic so the operator knows the page
 * should be treated as evidence, not as input to deterministic
 * extraction.
 *
 * Two signals contribute:
 *   - `page.rotation` is a non-zero multiple of 90 (the binary
 *     parser has already told us the page is rotated).
 *   - The median block aspect ratio (width / height) is < 0.6
 *     across ≥ 5 geometry-bearing blocks. Normal portrait body
 *     text sits comfortably above 1; long single-column lines
 *     above 5. A rotated page collapses every line into a tall
 *     narrow stripe.
 *
 * Returns `{ suspected: false, reason: 'none' }` when neither
 * signal fires or the page has too few blocks to evaluate.
 */
export function detectPageRotation(
  page: Pick<PdfPage, 'rotation' | 'textBlocks'>,
): PdfRotationSignal {
  if (
    typeof page.rotation === 'number' &&
    page.rotation !== 0 &&
    page.rotation % 90 === 0
  ) {
    return {
      suspected: true,
      reason: 'page-rotation-tag',
      medianAspect: medianBlockAspect(page.textBlocks),
    };
  }
  const aspect = medianBlockAspect(page.textBlocks);
  if (aspect != null && aspect < 0.6) {
    return {
      suspected: true,
      reason: 'block-aspect-ratio',
      medianAspect: aspect,
    };
  }
  return { suspected: false, reason: 'none', medianAspect: aspect };
}

function medianBlockAspect(
  blocks: ReadonlyArray<PdfTextBlock>,
): number | null {
  const ratios: number[] = [];
  for (const b of blocks) {
    if (!b.bbox) continue;
    if (
      !Number.isFinite(b.bbox.width) ||
      !Number.isFinite(b.bbox.height) ||
      b.bbox.height <= 0
    ) {
      continue;
    }
    ratios.push(b.bbox.width / b.bbox.height);
  }
  if (ratios.length < 5) return null;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}
