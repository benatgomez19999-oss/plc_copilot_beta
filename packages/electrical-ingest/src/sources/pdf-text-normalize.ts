// Sprint 80 — pure helpers that turn raw pdfjs-dist text items
// into deterministic line-grouped blocks, with combined bboxes.
// No I/O, no dependency on pdfjs at runtime; the inputs are the
// `PdfTextLayerItem` shape produced by `pdf-text-layer.ts`.
//
// Line-grouping strategy (Sprint 80 v0):
//   1. Sort items by `y` descending then `x` ascending.
//   2. Walk items; group consecutive items into the same line when
//      their `y` differs by ≤ `yTolerance` from the line's anchor.
//      The anchor is set by the line's first item.
//   3. Within a line, items are sorted left-to-right by `x` and
//      joined with the heuristic glue rule below.
//
// Glue rule between two adjacent items A (already in line) and B
// (about to be appended):
//   - If A's right edge is followed by a small gap (< 0.5 *
//     fontSize), join with no space.
//   - Otherwise insert a single space. This matches the way
//     pdfjs-dist breaks the same printed word into multiple text
//     items when font kerning is non-trivial.
//
// Determinism: the algorithm is total + side-effect-free; the same
// input always yields the same lines in the same order.

import type { PdfBoundingBox } from './pdf-types.js';
import type { PdfTextLayerItem } from './pdf-text-layer.js';

export interface PdfTextLayerLine {
  /** Anchor y (= first item's y); used as the line's sort key. */
  y: number;
  /** Joined line text after the glue rule; verbatim. */
  text: string;
  /** Underlying items (sorted left-to-right). */
  items: PdfTextLayerItem[];
  /** Combined bounding box of items in PDF point space. */
  bbox: PdfBoundingBox;
}

export interface GroupItemsIntoLinesOptions {
  /**
   * Maximum y-distance (in PDF points) two items may be apart
   * before they're considered on different lines. Default `2`,
   * which works for normal 9–14pt body text.
   */
  yTolerance?: number;
  /**
   * Multiplier on the larger item's font size used to decide
   * whether to insert a space between two adjacent same-line
   * items. Default `0.5` — a gap of ≥ half the font size becomes
   * a space.
   */
  spaceGapFraction?: number;
}

const DEFAULT_Y_TOLERANCE = 2;
const DEFAULT_SPACE_GAP_FRACTION = 0.5;

export function groupItemsIntoLines(
  items: readonly PdfTextLayerItem[],
  options: GroupItemsIntoLinesOptions = {},
): PdfTextLayerLine[] {
  if (!Array.isArray(items) || items.length === 0) return [];
  const yTol = options.yTolerance ?? DEFAULT_Y_TOLERANCE;
  const spaceFrac = options.spaceGapFraction ?? DEFAULT_SPACE_GAP_FRACTION;

  // Sort by y desc (PDF coords have origin at bottom-left), then x asc.
  const sorted = [...items].sort((a, b) => {
    if (a.y !== b.y) return b.y - a.y;
    return a.x - b.x;
  });

  // Greedy grouping: open a new line whenever the next item's y
  // is more than `yTol` below the current line's anchor.
  const lines: PdfTextLayerItem[][] = [];
  for (const item of sorted) {
    const last = lines[lines.length - 1];
    if (!last) {
      lines.push([item]);
      continue;
    }
    const anchor = last[0].y;
    if (Math.abs(anchor - item.y) <= yTol) {
      last.push(item);
    } else {
      lines.push([item]);
    }
  }

  // Within each line, re-sort items by x asc and join with the
  // glue rule.
  return lines.map((group) => {
    const bag = [...group].sort((a, b) => a.x - b.x);
    let text = '';
    for (let i = 0; i < bag.length; i++) {
      if (i === 0) {
        text = bag[i].text;
        continue;
      }
      const prev = bag[i - 1];
      const cur = bag[i];
      const gap = cur.x - (prev.x + prev.width);
      const fontSize = Math.max(prev.fontSize ?? 0, cur.fontSize ?? 0, 1);
      if (gap >= fontSize * spaceFrac) {
        text += ' ' + cur.text;
      } else {
        text += cur.text;
      }
    }
    return {
      y: bag[0].y,
      text,
      items: bag,
      bbox: combineBbox(bag),
    };
  });
}

/**
 * Compute the union bounding box of a list of items. PDF points,
 * origin bottom-left. Empty / single-item inputs are handled
 * gracefully.
 */
export function combineBbox(items: readonly PdfTextLayerItem[]): PdfBoundingBox {
  if (items.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0, unit: 'pt' };
  }
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const it of items) {
    const x0 = it.x;
    const x1 = it.x + it.width;
    const y0 = it.y;
    const y1 = it.y + it.height;
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (y0 < minY) minY = y0;
    if (y1 > maxY) maxY = y1;
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    unit: 'pt',
  };
}
