// Sprint 81 — table-ish detection over already-grouped PDF text
// lines. The recogniser is deliberately narrow: it identifies
// IO-list-shaped tables (Address / Tag / Direction / Description
// columns, in any order, with a single-row header) and emits
// `PdfTableCandidate` records that carry every cell's source-trace.
// It does NOT attempt full layout-aware table extraction.
//
// Pipeline (per page):
//   1. Walk lines top-to-bottom looking for a header line —
//      `findIoTableHeader(line)` returns a `PdfTableHeaderLayout`
//      when the line's text contains ≥ 2 known header keywords.
//   2. After a header, consecutive lines whose text matches one of
//      the IO-row patterns become `PdfTableRowCandidate` records
//      attached to the same `PdfTableCandidate`.
//   3. The first non-matching line closes the current table.
//
// Column role mapping is keyword-driven (English + German +
// abbreviations). When a column can't be classified, its role is
// `'unknown'` — Sprint 81 preserves it so the operator sees the
// header during review, even if the IO row extractor doesn't
// know how to slot its values.
//
// Pure / DOM-free / deterministic. Same input always produces the
// same tables in the same order.

import { createElectricalDiagnostic } from '../diagnostics.js';
import type { ElectricalDiagnostic, SourceRef } from '../types.js';
import type { PdfTextBlock } from './pdf-types.js';
import type {
  PdfTableCandidate,
  PdfTableColumn,
  PdfTableColumnRole,
  PdfTableHeaderLayout,
  PdfTableRowCandidate,
} from './pdf-types.js';

// ---------------------------------------------------------------------------
// Header keyword classifier
// ---------------------------------------------------------------------------

/**
 * Sprint 83A — table-family classification.
 *
 * Sprint 81's recogniser flagged any header carrying a
 * `tag`/`description` column as "IO-list-shaped". The Sprint 82
 * manual run on `TcECAD_Import_V2_2_x.pdf` exposed the gap: BOM
 * pages carry headers like
 *   "Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer"
 * which classify under `bmk → tag` + `bezeichnung → description`
 * and slip through the floor — even though there is NO address /
 * direction / signal column anywhere on the line. Sprint 83A
 * adds a per-family classifier on top of the role keywords:
 *
 *   - `'io_list'`            real IO-list (address / direction / signal)
 *   - `'bom_parts_list'`     parts list / Stückliste / Komponentenliste
 *   - `'terminal_list'`      Klemmenplan / terminal-strip layouts
 *   - `'cable_list'`         Kabelplan / cable schedules
 *   - `'contents_index'`     table of contents
 *   - `'legend'`             legend / Strukturierungsprinzipien
 *   - `'unknown'`            line is header-shaped but doesn't fit
 *
 * Only `'io_list'` triggers `PdfTableCandidate` creation + IO-row
 * extraction. Every other family lands as a precise info
 * diagnostic and is otherwise ignored.
 */
export type PdfTableFamily =
  | 'io_list'
  | 'bom_parts_list'
  | 'terminal_list'
  | 'cable_list'
  | 'contents_index'
  | 'legend'
  | 'unknown';

export interface PdfTableHeaderClassification {
  family: PdfTableFamily;
  /** 0 .. 1 — confidence the family classification is correct. */
  confidence: number;
  /** Per-token role hits (deduplicated, in input order). */
  roles: PdfTableColumnRole[];
  /** Why the classifier landed where it did — one short clause per family vote. */
  reasons: string[];
}

/**
 * Strong indicators that a header is a real IO-list. Presence of
 * ANY of these tokens (in addition to ≥ 2 column hits) flips the
 * classifier into `'io_list'`. `bmk`/`bezeichnung`/`description`
 * are NOT in this set on purpose — they're shared with BOM
 * headers.
 */
const STRONG_IO_TOKENS: ReadonlySet<string> = new Set([
  'address',
  'addr',
  'adresse',
  'adr',
  'io',
  'i/o',
  'e/a',
  'ea',
  'input',
  'output',
  'eingang',
  'ausgang',
  'direction',
  'dir',
  'signal',
  'channel',
  'kanal',
  'sps',
  'plc',
  'ein',
  'aus',
]);

/**
 * Strong indicators that a header is a BOM / parts / material
 * list. Presence of ANY of these wins over IO classification
 * unless the IO vote is strictly larger AND carries an
 * `address`-class role (defensive against headers that happen
 * to mention both — vanishingly rare in practice).
 */
const STRONG_BOM_TOKENS: ReadonlySet<string> = new Set([
  'menge',
  'anzahl',
  'qty',
  'quantity',
  'artikelnummer',
  'artikelnr',
  'artno',
  'artnr',
  'artikel',
  'partnumber',
  'part-number',
  'partnr',
  'typnummer',
  'typenummer',
  'typenr',
  'typ-nr',
  'hersteller',
  'manufacturer',
  'fabrikat',
  'lieferant',
  'supplier',
  'bestellnummer',
  'orderno',
  'ordernumber',
  'stückliste',
  'stueckliste',
  'teileliste',
  'stuckliste',
  'parts-list',
  'partslist',
  'material',
  'bom',
  'catalog',
  'catalogue',
]);

/** Strong terminal-list indicators. */
const STRONG_TERMINAL_TOKENS: ReadonlySet<string> = new Set([
  'klemmenplan',
  'klemmleistenübersicht',
  'klemmleiste',
  'klemmleisten',
  'klemmen',
  'klemme',
  'terminal',
  'terminal-strip',
  'ziel',
  'quelle',
  'anschluss',
  'anschlüsse',
]);

/** Strong cable-list indicators. */
const STRONG_CABLE_TOKENS: ReadonlySet<string> = new Set([
  'kabel',
  'kabelplan',
  'kabelübersicht',
  'kabeluebersicht',
  'kabeltyp',
  'cable',
  'ader',
  'adern',
  'conductor',
  'wire',
]);

/** Strong contents/index indicators. */
const STRONG_CONTENTS_TOKENS: ReadonlySet<string> = new Set([
  'inhaltsverzeichnis',
  'contents',
  'seitenbeschreibung',
  'seite',
  'datum',
  'bearbeiter',
  'inhalt',
  'index',
]);

/** Strong legend indicators. */
const STRONG_LEGEND_TOKENS: ReadonlySet<string> = new Set([
  'legende',
  'legend',
  'strukturierungsprinzipien',
  'referenzkennzeichen',
]);

/**
 * Map of normalised header tokens (lowercased, trimmed, punctuation
 * stripped) to column roles. Multiple aliases per role keep the
 * recogniser tolerant of English, German, and abbreviated headers
 * the way real industrial IO lists tend to write them.
 */
const HEADER_KEYWORDS: Record<string, PdfTableColumnRole> = {
  // address column
  address: 'address',
  addr: 'address',
  adresse: 'address',
  adr: 'address',
  io: 'address',
  'i/o': 'address',
  'e/a': 'address',
  // tag column
  tag: 'tag',
  bmk: 'tag', // EPLAN-style "Betriebsmittelkennzeichen"
  kks: 'tag', // KKS power-plant style
  betriebsmittel: 'tag',
  // direction column
  direction: 'direction',
  dir: 'direction',
  type: 'direction',
  signal: 'direction',
  ein: 'direction',
  aus: 'direction',
  eingang: 'direction',
  ausgang: 'direction',
  input: 'direction',
  output: 'direction',
  // description column
  description: 'description',
  desc: 'description',
  bezeichnung: 'description',
  funktion: 'description',
  function: 'description',
  // channel column
  channel: 'channel',
  ch: 'channel',
  kanal: 'channel',
  // comment column
  comment: 'comment',
  comments: 'comment',
  notes: 'comment',
  kommentar: 'comment',
  // signal type column
  'data type': 'signal_type',
  datatype: 'signal_type',
  datentyp: 'signal_type',
  'data-type': 'signal_type',
  type_: 'signal_type', // when "type" already grabbed by direction
};

const NORMALISE_RE = /[^a-z0-9/]+/gi;

function normaliseToken(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(NORMALISE_RE, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function classifyHeaderToken(text: string): PdfTableColumnRole | null {
  if (!text) return null;
  const norm = normaliseToken(text);
  if (norm.length === 0) return null;
  // First try the whole token verbatim, then by individual word
  // (some headers come tightly joined).
  if (HEADER_KEYWORDS[norm]) return HEADER_KEYWORDS[norm];
  for (const word of norm.split(' ')) {
    if (HEADER_KEYWORDS[word]) return HEADER_KEYWORDS[word];
  }
  return null;
}

function tokensFromHeaderText(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const norm = normaliseToken(text);
  if (norm.length === 0) return [];
  return norm.split(' ').filter((t) => t.length > 0);
}

function countSetHits(
  tokens: readonly string[],
  set: ReadonlySet<string>,
): number {
  let hits = 0;
  for (const t of tokens) if (set.has(t)) hits++;
  return hits;
}

/**
 * Sprint 83A — classify a header line into an IO-list / BOM /
 * terminal-list / cable-list / contents / legend / unknown family.
 *
 * The classifier votes per family using the strong-token sets
 * above plus the role-keyword map. Resolution rules are explicit
 * (see body) so each decision is auditable from the `reasons`
 * field.
 *
 * The output `roles` array is the deduplicated set of column
 * roles the line resolves to, in input order. Callers can use
 * it to build a `PdfTableHeaderLayout` when (and only when) the
 * family is `'io_list'`.
 */
export function classifyPdfTableHeader(
  text: string,
): PdfTableHeaderClassification {
  const reasons: string[] = [];
  const tokens = tokensFromHeaderText(text);
  if (tokens.length === 0) {
    return {
      family: 'unknown',
      confidence: 0,
      roles: [],
      reasons: ['empty header text'],
    };
  }

  const bomHits = countSetHits(tokens, STRONG_BOM_TOKENS);
  const ioHits = countSetHits(tokens, STRONG_IO_TOKENS);
  const terminalHits = countSetHits(tokens, STRONG_TERMINAL_TOKENS);
  const cableHits = countSetHits(tokens, STRONG_CABLE_TOKENS);
  const contentsHits = countSetHits(tokens, STRONG_CONTENTS_TOKENS);
  const legendHits = countSetHits(tokens, STRONG_LEGEND_TOKENS);

  // Collect role hits from the role-keyword map.
  const seenRoles = new Set<PdfTableColumnRole>();
  const roles: PdfTableColumnRole[] = [];
  for (const t of tokens) {
    const role = classifyHeaderToken(t);
    if (role && !seenRoles.has(role)) {
      seenRoles.add(role);
      roles.push(role);
    }
  }
  const hasAddressRole = roles.includes('address');

  // Family resolution. Order matters — every branch returns,
  // and earlier branches win to keep the rules auditable.

  // Legend / contents are very specific surface vocabulary; they
  // win when present, regardless of incidental BMK/Bezeichnung
  // hits (those legends often list the very tokens we use to
  // classify).
  if (legendHits > 0) {
    reasons.push(`legend: ${legendHits} strong token(s)`);
    return {
      family: 'legend',
      confidence: clampConfidence(0.55 + 0.1 * legendHits),
      roles,
      reasons,
    };
  }
  if (contentsHits >= 2) {
    reasons.push(`contents: ${contentsHits} strong token(s)`);
    return {
      family: 'contents_index',
      confidence: clampConfidence(0.55 + 0.1 * contentsHits),
      roles,
      reasons,
    };
  }

  // BOM beats IO unless IO has strictly more hits AND owns the
  // address column.
  if (bomHits > 0 && (bomHits >= ioHits || !hasAddressRole)) {
    reasons.push(
      `bom_parts_list: ${bomHits} strong BOM token(s)` +
        (ioHits > 0 ? ` (io tokens=${ioHits} but no address role)` : ''),
    );
    return {
      family: 'bom_parts_list',
      confidence: clampConfidence(0.55 + 0.1 * bomHits),
      roles,
      reasons,
    };
  }

  // Terminal vs cable: cable beats terminal on tie because
  // `kabel` / `ader` / `cable` / `conductor` / `wire` are
  // unambiguous cable tokens, whereas `Quelle` / `Ziel` /
  // `Anschluss` legitimately appear on cable lists too. Strict
  // tie → cable wins.
  if (cableHits >= terminalHits && cableHits > 0 && ioHits === 0) {
    reasons.push(`cable_list: ${cableHits} strong token(s)`);
    return {
      family: 'cable_list',
      confidence: clampConfidence(0.55 + 0.1 * cableHits),
      roles,
      reasons,
    };
  }
  if (terminalHits > cableHits && ioHits === 0) {
    reasons.push(`terminal_list: ${terminalHits} strong token(s)`);
    return {
      family: 'terminal_list',
      confidence: clampConfidence(0.55 + 0.1 * terminalHits),
      roles,
      reasons,
    };
  }

  // IO-list. Requires ≥ 1 strong IO token AND ≥ 2 column roles
  // (so a single "address" line by itself doesn't pass).
  if (ioHits > 0 && roles.length >= 2) {
    reasons.push(`io_list: ${ioHits} strong IO token(s), ${roles.length} role(s)`);
    return {
      family: 'io_list',
      confidence: clampConfidence(0.55 + 0.05 * ioHits + 0.05 * roles.length),
      roles,
      reasons,
    };
  }

  reasons.push(
    `unknown: io=${ioHits} bom=${bomHits} terminal=${terminalHits} cable=${cableHits} contents=${contentsHits} legend=${legendHits}`,
  );
  return { family: 'unknown', confidence: 0.2, roles, reasons };
}

function clampConfidence(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

// ---------------------------------------------------------------------------
// Header detection on a single line
// ---------------------------------------------------------------------------

interface HeaderDetectionInput {
  /** The full line text, joined by the line-grouping helper. */
  text: string;
  /**
   * Underlying text-layer items, when known. The detector uses these
   * to recover x-positions for each header column. Empty for
   * test-mode lines whose geometry isn't tracked.
   */
  items?: Array<{ text: string; x: number; width: number }>;
}

/**
 * Try to recognise the line as an IO-list table header. Returns
 * `null` when fewer than 2 tokens classify as known header keywords
 * — a hard floor that prevents single-keyword false positives like
 * a body line that happens to contain "input".
 */
export function detectIoTableHeader(
  input: HeaderDetectionInput,
): PdfTableHeaderLayout | null {
  if (!input || typeof input.text !== 'string' || input.text.length === 0) {
    return null;
  }
  // When we have geometry from pdfjs, prefer it: each text item
  // becomes a column anchor with its real x position.
  const columns: PdfTableColumn[] = [];
  if (Array.isArray(input.items) && input.items.length > 0) {
    for (const it of input.items) {
      const role = classifyHeaderToken(it.text);
      if (!role) continue;
      columns.push({
        role,
        headerLabel: it.text.trim(),
        xMin: it.x,
        xMax: it.x + it.width,
      });
    }
  } else {
    // Fallback: split the line on whitespace. We don't know x
    // positions, so we synthesise placeholder bands proportional
    // to character offsets — adequate for the test-mode text path.
    // Single-space splitting can over-fire on body lines, so we
    // also enforce the "≥ 2 known keywords" hard floor below to
    // block false positives.
    const tokens = input.text.split(/\s+/).map((t) => t.trim()).filter(
      (t) => t.length > 0,
    );
    let cursor = 0;
    for (const tok of tokens) {
      const role = classifyHeaderToken(tok);
      if (!role) {
        cursor += tok.length + 1;
        continue;
      }
      columns.push({
        role,
        headerLabel: tok,
        xMin: cursor,
        xMax: cursor + Math.max(tok.length, 1),
      });
      cursor += tok.length + 1;
    }
  }

  if (columns.length < 2) return null;

  // Hard requirement: at least one column must classify as `address`
  // OR as `tag`. Otherwise the line could be a section heading like
  // "Description Comment Channel" — header-shaped but not an IO
  // list.
  const hasAddressOrTag = columns.some(
    (c) => c.role === 'address' || c.role === 'tag',
  );
  if (!hasAddressOrTag) return null;

  // Sprint 83A — even if the role floor passes, refuse to flag the
  // line as an IO-list header when the family classifier says it's
  // a BOM / terminal / cable / contents / legend / unknown
  // header. The family classifier owns the global view (presence
  // of `Menge` / `Artikelnummer` / `Klemmenplan` / `Inhaltsverzeichnis`
  // etc.). Returning `null` here pushes the assembler into the
  // non-IO-family branch where it emits the precise
  // `PDF_BOM_TABLE_DETECTED` / `PDF_TERMINAL_TABLE_DETECTED` /
  // `PDF_CABLE_TABLE_DETECTED` / `PDF_CONTENTS_TABLE_IGNORED` /
  // `PDF_LEGEND_TABLE_IGNORED` / `PDF_TABLE_HEADER_REJECTED`
  // diagnostics instead of the over-broad Sprint 81
  // `PDF_TABLE_HEADER_DETECTED` code.
  const family = classifyPdfTableHeader(input.text);
  if (family.family !== 'io_list') return null;

  return {
    columns,
    rawText: input.text,
  };
}

// ---------------------------------------------------------------------------
// IO-row patterns
// ---------------------------------------------------------------------------

/**
 * Address-first regex: `<address> <tag> [label]`. Same shape Sprint
 * 79/80 used; preserved here so the table detector can decide
 * whether a body line is row-shaped.
 */
const ADDR_TAG_RE =
  /^\s*(?<addr>%?[IQM][WDB]?\d+(?:[.\/]\d+)?)\s+(?<tag>[A-Za-z][A-Za-z0-9_.+\-]{0,15})(?:\s+(?<label>.+?))?\s*$/;

/**
 * Tag-first regex: `<tag> <address> [label]`. Common in EPLAN-style
 * exports where the tag column comes first. The tag is restricted
 * to alphanumeric tokens that DO NOT look like an address (the
 * leading character must be a letter that isn't I / Q / M / %).
 */
const TAG_ADDR_RE =
  /^\s*(?<tag>(?!%?[IQM][WDB]?\d)[A-Za-z][A-Za-z0-9_.+\-]{0,15})\s+(?<addr>%?[IQM][WDB]?\d+(?:[.\/]\d+)?)(?:\s+(?<label>.+?))?\s*$/;

/**
 * Tag + direction-word + address: `B1 input I0.0 Part present` or
 * `Y1 output Q0.0 Cylinder extend`. Recognises the same direction
 * keywords used during header detection (English + German short
 * forms).
 */
const TAG_DIR_ADDR_RE =
  /^\s*(?<tag>(?!%?[IQM][WDB]?\d)[A-Za-z][A-Za-z0-9_.+\-]{0,15})\s+(?<dir>input|output|in|out|eingang|ausgang|i|o|e|a)\s+(?<addr>%?[IQM][WDB]?\d+(?:[.\/]\d+)?)(?:\s+(?<label>.+?))?\s*$/i;

/** Matches any of the three patterns above. */
export function looksLikeIoRow(text: string): boolean {
  return (
    ADDR_TAG_RE.test(text) ||
    TAG_ADDR_RE.test(text) ||
    TAG_DIR_ADDR_RE.test(text)
  );
}

// ---------------------------------------------------------------------------
// Table assembly
// ---------------------------------------------------------------------------

/**
 * Minimal per-line record the assembler operates on. Producers
 * (real text-layer + test-mode) both adapt their per-line shape
 * to this interface so the assembler stays single-purpose.
 */
export interface PdfTableDetectorLine {
  /** Source-aligned text-block for the line (carries the SourceRef). */
  block: PdfTextBlock;
  /** Optional per-item geometry passed through from the extractor. */
  items?: Array<{ text: string; x: number; width: number }>;
  /** 1-based page number for the parent `PdfTableCandidate`. */
  pageNumber: number;
}

export interface PdfTableDetectionResult {
  tables: PdfTableCandidate[];
  /** Set of block ids that were absorbed into some table. */
  consumedBlockIds: Set<string>;
  diagnostics: ElectricalDiagnostic[];
}

/**
 * Walk a list of lines (already in top-to-bottom order on a single
 * page) and return the IO-list-shaped tables we recognise. The
 * caller is responsible for pre-grouping lines by page; the
 * assembler only operates on a single page's lines at a time.
 */
export function detectIoTables(args: {
  lines: PdfTableDetectorLine[];
  sourceId: string;
  fileName?: string;
}): PdfTableDetectionResult {
  const tables: PdfTableCandidate[] = [];
  const consumedBlockIds = new Set<string>();
  const diagnostics: ElectricalDiagnostic[] = [];
  const { lines, sourceId, fileName } = args;
  if (!Array.isArray(lines) || lines.length === 0) {
    return { tables, consumedBlockIds, diagnostics };
  }

  let i = 0;
  let tableIndex = 1;
  // Sprint 83A — guard against duplicate non-IO family diagnostics
  // for the same line (e.g. a BOM header repeated across pages).
  // Keyed by `${family}:${page}:${blockId}`.
  const seenNonIoFamilyDiagnostic = new Set<string>();
  while (i < lines.length) {
    const line = lines[i];
    const header = detectIoTableHeader({
      text: line.block.text,
      items: line.items,
    });
    if (!header) {
      // Sprint 83A — even when `detectIoTableHeader` returns null,
      // the line may still be a known non-IO family header (BOM /
      // terminal / cable / contents / legend). Run the family
      // classifier and emit a precise info diagnostic for those
      // families so the operator's stream stays explainable. We
      // skip the diagnostic entirely for `'unknown'` lines —
      // those are body lines that happen to share a few keywords
      // with header vocab; surfacing them would inflate the
      // diagnostic stream.
      const classification = classifyPdfTableHeader(line.block.text);
      if (classification.family !== 'unknown' && classification.family !== 'io_list') {
        const key = `${classification.family}:${line.pageNumber}:${line.block.id}`;
        if (!seenNonIoFamilyDiagnostic.has(key)) {
          seenNonIoFamilyDiagnostic.add(key);
          diagnostics.push(buildNonIoFamilyDiagnostic(line, classification));
        }
      }
      i++;
      continue;
    }
    // Header found. Walk forward while subsequent lines look like
    // IO rows OR are blank-shaped continuation lines.
    const headerRow: PdfTableRowCandidate = {
      cells: [line.block],
      confidence: 0.65,
      rawText: line.block.text,
      kind: 'header',
      sourceRef: line.block.sourceRef,
    };
    const dataRows: PdfTableRowCandidate[] = [];
    let j = i + 1;
    let extracted = 0;
    while (j < lines.length) {
      const next = lines[j];
      if (looksLikeIoRow(next.block.text)) {
        dataRows.push({
          cells: [next.block],
          confidence: 0.6,
          rawText: next.block.text,
          kind: 'data',
          sourceRef: next.block.sourceRef,
        });
        consumedBlockIds.add(next.block.id);
        extracted++;
        j++;
        continue;
      }
      // Stop on the first non-row line. Sprint 81 doesn't try to
      // detect "blank row separators" inside a table — that is
      // future hardening.
      break;
    }

    if (extracted === 0) {
      // Header line had no following IO rows; that's not a table —
      // skip the header and emit a header-detected diagnostic
      // (operators still find the seen-header useful for
      // troubleshooting).
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_TABLE_HEADER_DETECTED',
          severity: 'info',
          message: `Recognised an IO-list-shaped header on page ${line.pageNumber} but no data rows followed.`,
          sourceRef: line.block.sourceRef,
        }),
      );
      i = j;
      continue;
    }

    consumedBlockIds.add(line.block.id);
    const rows: PdfTableRowCandidate[] = [headerRow, ...dataRows];
    const tableId = `pdf:${sourceId}:p${line.pageNumber}:t${tableIndex}`;
    tableIndex++;
    const tableConfidence = 0.65; // never above the header row's confidence
    const tableSourceRef: SourceRef = {
      ...line.block.sourceRef,
      symbol: `pdf:p${line.pageNumber}:table:${tableIndex - 1}`,
    };
    if (fileName) tableSourceRef.path = fileName;
    tables.push({
      id: tableId,
      pageNumber: line.pageNumber,
      rows,
      confidence: tableConfidence,
      sourceRef: tableSourceRef,
      bbox: line.block.bbox,
      headerLayout: header,
    });
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_TABLE_HEADER_DETECTED',
        severity: 'info',
        message: `IO-list header recognised on page ${line.pageNumber} (columns: ${header.columns
          .map((c) => `${c.role}:${c.headerLabel}`)
          .join(', ')}).`,
        sourceRef: line.block.sourceRef,
      }),
    );
    diagnostics.push(
      createElectricalDiagnostic({
        code: 'PDF_TABLE_CANDIDATE_DETECTED',
        severity: 'info',
        message: `IO table extracted on page ${line.pageNumber}: ${dataRows.length} data row(s).`,
        sourceRef: line.block.sourceRef,
      }),
    );
    for (const r of dataRows) {
      diagnostics.push(
        createElectricalDiagnostic({
          code: 'PDF_TABLE_ROW_EXTRACTED',
          severity: 'info',
          message: `Row: ${truncate(r.rawText ?? '', 80)}`,
          sourceRef: r.sourceRef,
        }),
      );
    }
    i = j;
  }

  return { tables, consumedBlockIds, diagnostics };
}

function truncate(s: string, n: number): string {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Sprint 83A — emit the precise per-family diagnostic for a
 * non-IO header line. Each family lands as info severity; the
 * line is still source-traceable through `sourceRef`.
 */
function buildNonIoFamilyDiagnostic(
  line: PdfTableDetectorLine,
  classification: PdfTableHeaderClassification,
): ElectricalDiagnostic {
  const snippet = truncate(line.block.text, 80);
  const reason = classification.reasons[classification.reasons.length - 1] ?? '';
  const message =
    `Non-IO table header on page ${line.pageNumber}: "${snippet}" classified as ` +
    `${classification.family}` +
    (reason ? ` (${reason})` : '') +
    `. Ignored for IO extraction.`;
  switch (classification.family) {
    case 'bom_parts_list':
      return createElectricalDiagnostic({
        code: 'PDF_BOM_TABLE_DETECTED',
        severity: 'info',
        message,
        sourceRef: line.block.sourceRef,
      });
    case 'terminal_list':
      return createElectricalDiagnostic({
        code: 'PDF_TERMINAL_TABLE_DETECTED',
        severity: 'info',
        message,
        sourceRef: line.block.sourceRef,
      });
    case 'cable_list':
      return createElectricalDiagnostic({
        code: 'PDF_CABLE_TABLE_DETECTED',
        severity: 'info',
        message,
        sourceRef: line.block.sourceRef,
      });
    case 'contents_index':
      return createElectricalDiagnostic({
        code: 'PDF_CONTENTS_TABLE_IGNORED',
        severity: 'info',
        message,
        sourceRef: line.block.sourceRef,
      });
    case 'legend':
      return createElectricalDiagnostic({
        code: 'PDF_LEGEND_TABLE_IGNORED',
        severity: 'info',
        message,
        sourceRef: line.block.sourceRef,
      });
    default:
      return createElectricalDiagnostic({
        code: 'PDF_TABLE_HEADER_REJECTED',
        severity: 'info',
        message,
        sourceRef: line.block.sourceRef,
      });
  }
}
