// Sprint 80 — minimal valid PDF builder used by the text-layer
// extraction tests. Pure / deterministic: every call produces the
// same bytes for the same inputs. No external dependency.
//
// The output is a one-page-per-input-string PDF with selectable
// Helvetica text at 12pt. Content streams are deliberately simple:
// each newline in the input becomes a separate Tj operation
// stacked top-to-bottom, so the line-grouping helper has clean
// Y coordinates to work with.
//
// PDF spec invariant: cross-reference table byte offsets MUST be
// computed from the actual byte stream, not the source string —
// we stage every object as Uint8Array, accumulate offsets, then
// emit the xref + trailer + startxref pointer last.

const PDF_HEADER = '%PDF-1.4\n';
// Standard "this file contains binary data" comment (4 high-bit
// bytes + LF) — pdfjs-dist tolerates a missing one but real
// readers prefer it, so we always emit it.
const PDF_BINARY_COMMENT = '%\xC4\xE5\xF2\xE5\n';

export interface BuildPdfFixtureInput {
  pages: string[];
  /** PDF point Y of the first line on each page (default 720). */
  firstLineY?: number;
  /** Vertical step between successive lines on the same page (default 18). */
  lineSpacing?: number;
}

export function buildMinimalPdfFixture(
  input: BuildPdfFixtureInput,
): Uint8Array {
  const pages = input.pages.length > 0 ? input.pages : [''];
  const firstLineY = input.firstLineY ?? 720;
  const lineSpacing = input.lineSpacing ?? 18;
  const enc = new TextEncoder();

  // Object id layout. Object 0 is reserved (free).
  //   1 = catalog
  //   2 = pages tree
  //   3 .. 2+n = page objects (one per page)
  //   3+n .. 2+2n = content streams (one per page)
  //   3+2n = font (Helvetica)
  const n = pages.length;
  const fontId = 3 + 2 * n;
  const totalObjects = fontId; // ids run 1..fontId

  // Stage object bodies (without the `<id> 0 obj\n` / `endobj` wrappers).
  const bodies: string[] = new Array(totalObjects + 1).fill('');
  bodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const pageObjIds = pages.map((_, i) => 3 + i);
  bodies[2] = `<< /Type /Pages /Kids [ ${pageObjIds.map((id) => `${id} 0 R`).join(' ')} ] /Count ${n} >>`;

  for (let i = 0; i < n; i++) {
    const pageId = 3 + i;
    const streamId = 3 + n + i;
    bodies[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${streamId} 0 R ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
  }

  for (let i = 0; i < n; i++) {
    const streamId = 3 + n + i;
    const lines = pages[i].split('\n');
    // First Tj uses an absolute Td; subsequent lines use a relative
    // Td of (0, -lineSpacing). Empty lines are emitted as empty Tj
    // so line numbering stays stable.
    const ops: string[] = [];
    ops.push('BT');
    ops.push('/F1 12 Tf');
    ops.push(`50 ${firstLineY} Td`);
    for (let li = 0; li < lines.length; li++) {
      if (li > 0) ops.push(`0 -${lineSpacing} Td`);
      ops.push(`(${escapePdfString(lines[li])}) Tj`);
    }
    ops.push('ET');
    const stream = ops.join('\n');
    bodies[streamId] =
      `<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}\nendstream`;
  }

  bodies[fontId] =
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;

  // Now compute byte offsets by serialising in order. Object 0 is
  // the free entry (offset 0, generation 65535).
  const offsets: number[] = new Array(totalObjects + 1).fill(0);
  const headerBytes = enc.encode(PDF_HEADER + PDF_BINARY_COMMENT);
  let cursor = headerBytes.length;
  const chunks: Uint8Array[] = [headerBytes];
  for (let id = 1; id <= totalObjects; id++) {
    offsets[id] = cursor;
    const objBytes = enc.encode(`${id} 0 obj\n${bodies[id]}\nendobj\n`);
    chunks.push(objBytes);
    cursor += objBytes.length;
  }

  const xrefOffset = cursor;
  const xrefHeader = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  const xrefBody = offsets
    .slice(1)
    .map((off) => `${String(off).padStart(10, '0')} 00000 n \n`)
    .join('');
  const trailer =
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  const xrefBytes = enc.encode(xrefHeader + xrefBody + trailer);
  chunks.push(xrefBytes);

  // Concatenate.
  const total = cursor + xrefBytes.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

function escapePdfString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// =============================================================================
// Sprint 81 — tabular fixture builder
// =============================================================================

export interface TabularCell {
  /** Verbatim text for this cell. */
  text: string;
  /** Absolute x position in PDF points for the start of the text. */
  x: number;
}

export interface TabularRow {
  /** Y position of the row in PDF points. */
  y: number;
  cells: TabularCell[];
}

export interface BuildTabularPdfFixtureInputPage {
  rows: TabularRow[];
}

export interface BuildTabularPdfFixtureInput {
  pages: BuildTabularPdfFixtureInputPage[];
}

/**
 * Build a PDF whose content streams are full table layouts: each
 * row on its own Y, with explicit x positions per cell. Sprint 81
 * uses this to feed the line-grouper + table-detector real
 * geometry without depending on font metrics.
 */
export function buildTabularPdfFixture(
  input: BuildTabularPdfFixtureInput,
): Uint8Array {
  const enc = new TextEncoder();
  const pages = input.pages;
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('buildTabularPdfFixture: pages must be a non-empty array.');
  }
  const n = pages.length;
  const fontId = 3 + 2 * n;
  const totalObjects = fontId;
  const bodies: string[] = new Array(totalObjects + 1).fill('');
  bodies[1] = `<< /Type /Catalog /Pages 2 0 R >>`;
  const pageObjIds = pages.map((_, i) => 3 + i);
  bodies[2] = `<< /Type /Pages /Kids [ ${pageObjIds.map((id) => `${id} 0 R`).join(' ')} ] /Count ${n} >>`;
  for (let i = 0; i < n; i++) {
    const pageId = 3 + i;
    const streamId = 3 + n + i;
    bodies[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${streamId} 0 R ` +
      `/Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
  }
  for (let i = 0; i < n; i++) {
    const streamId = 3 + n + i;
    const ops: string[] = [];
    ops.push('BT');
    ops.push('/F1 12 Tf');
    for (const row of pages[i].rows) {
      // Each cell uses its own absolute Td so the text item lands
      // at the requested (x, y) in PDF point space.
      for (const cell of row.cells) {
        ops.push(`1 0 0 1 ${cell.x} ${row.y} Tm`);
        ops.push(`(${escapePdfString(cell.text)}) Tj`);
      }
    }
    ops.push('ET');
    const stream = ops.join('\n');
    bodies[streamId] =
      `<< /Length ${enc.encode(stream).length} >>\nstream\n${stream}\nendstream`;
  }
  bodies[fontId] =
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`;

  const offsets: number[] = new Array(totalObjects + 1).fill(0);
  const headerBytes = enc.encode('%PDF-1.4\n%\xC4\xE5\xF2\xE5\n');
  let cursor = headerBytes.length;
  const chunks: Uint8Array[] = [headerBytes];
  for (let id = 1; id <= totalObjects; id++) {
    offsets[id] = cursor;
    const objBytes = enc.encode(`${id} 0 obj\n${bodies[id]}\nendobj\n`);
    chunks.push(objBytes);
    cursor += objBytes.length;
  }
  const xrefOffset = cursor;
  const xrefHeader = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  const xrefBody = offsets
    .slice(1)
    .map((off) => `${String(off).padStart(10, '0')} 00000 n \n`)
    .join('');
  const trailer =
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  const xrefBytes = enc.encode(xrefHeader + xrefBody + trailer);
  chunks.push(xrefBytes);
  const total = cursor + xrefBytes.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
