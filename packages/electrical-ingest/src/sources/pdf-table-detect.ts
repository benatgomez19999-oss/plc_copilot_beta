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
// ---------------------------------------------------------------------------
// Sprint 83B — diagnostic-hygiene helpers
// ---------------------------------------------------------------------------
//
// Sprint 83A made the family classifier safe; the manual run on
// `TcECAD_Import_V2_2_x.pdf` (86 pages) then revealed that the
// non-IO branch fires once per **block id** — i.e. once per line
// — which inflates the diagnostic stream into hundreds of
// per-line entries: vendor metadata footers ("Hersteller (Firma)
// Beckhoff Automation GmbH"), repeated title-block lines
// ("Datum 22.10.2013 ... Seite"), and body rows that incidentally
// hit a strong family token ("Bearb RAL =CABLE").
//
// Three cooperating helpers throttle the noise without losing
// the canonical-header signal:
//
//   1. `isFooterOrTitleBlockLine(text)` — recognises repeated
//      title-block/footer metadata so those lines never produce
//      a non-IO family diagnostic, regardless of how the
//      classifier votes.
//   2. `passesNonIoFamilyHeaderShapeGate(text, classification)` —
//      only lets a non-IO family diagnostic through when the
//      line is *header-shaped*: at least 3 strong family tokens
//      OR matches a canonical family-title regex (e.g.
//      `Stückliste`, `Klemmenplan`, `Inhaltsverzeichnis`).
//   3. `nonIoFamilyDiagnosticSignature(text)` — normalises the
//      line into a stable key so identical headers on the same
//      page collapse to one diagnostic; the same header on a
//      different page still surfaces (per-page granularity).

const FOOTER_OR_TITLE_BLOCK_PATTERNS: ReadonlyArray<RegExp> = [
  // "Datum 22.10.2013 ... Seite" (German title-block footer).
  /^\s*datum\s+\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}\b.*\bseite\b/i,
  // "Bearb RAL ..." (German operator/editor field; almost always
  // followed by an ECAD reference designator like `=CABLE` /
  // `=TERMINAL`).
  /^\s*bearb\b/i,
  // "Änderungsdatum 30.10.2013 von RalfL Anzahl der Seiten 86".
  /^\s*änderungsdatum\b/i,
  /^\s*anzahl\s+der\s+seiten\b/i,
  // "Seite 5 von 10" / "Seite 5/10" trailing page counters.
  /^\s*seite\s+\d+(\s*(von|\/)\s*\d+)?\s*$/i,
];

/**
 * Sprint 83B — recognise repeated PDF page-footer / title-block
 * metadata so the non-IO family branch can suppress diagnostics
 * for them. Pure / DOM-free / total. Empty / non-string input
 * returns `false`.
 *
 * **NOTE:** the helper does NOT remove the line from the parsed
 * `PdfDocument` — Sprint 80's text-layer extractor still surfaces
 * the line as a `PdfTextBlock`. Only the *family diagnostic* is
 * skipped.
 */
export function isFooterOrTitleBlockLine(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  for (const re of FOOTER_OR_TITLE_BLOCK_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

const CANONICAL_FAMILY_TITLE_PATTERNS: ReadonlyArray<RegExp> = [
  // BOM / parts list / material list (German + English titles).
  /\bstückliste\b/i,
  /\bstueckliste\b/i,
  /\bteileliste\b/i,
  /\bparts[ -]?list\b/i,
  /\bbill\s+of\s+materials\b/i,
  // Terminal lists.
  /\bklemmenplan\b/i,
  /\bklemmleisten[üu]bersicht\b/i,
  /\bklemmleistenplan\b/i,
  /\bterminal[ -]?list\b/i,
  // Cable lists.
  /\bkabelplan\b/i,
  /\bkabel[üu]bersicht\b/i,
  /\bcable[ -]?list\b/i,
  // Contents / legend.
  /\binhaltsverzeichnis\b/i,
  /\btable\s+of\s+contents\b/i,
  /\blegende\b/i,
];

const NON_TRIVIAL_TOKEN_RE = /[\p{L}\p{N}/]{2,}/gu;

function strongFamilyTokenCount(
  text: string,
  family: PdfTableFamily,
): number {
  const tokens = tokensFromHeaderText(text);
  switch (family) {
    case 'bom_parts_list':
      return countSetHits(tokens, STRONG_BOM_TOKENS);
    case 'terminal_list':
      return countSetHits(tokens, STRONG_TERMINAL_TOKENS);
    case 'cable_list':
      return countSetHits(tokens, STRONG_CABLE_TOKENS);
    case 'contents_index':
      return countSetHits(tokens, STRONG_CONTENTS_TOKENS);
    case 'legend':
      return countSetHits(tokens, STRONG_LEGEND_TOKENS);
    default:
      return 0;
  }
}

/**
 * Sprint 83B — gate non-IO family diagnostics behind a real
 * header shape. Returns `true` when the line should produce a
 * diagnostic; `false` when it should be suppressed as a body /
 * footer / weak-keyword line. Pure / DOM-free / total.
 *
 * Pass rules (any of):
 *   - The line matches a canonical family-title regex
 *     (`Stückliste`, `Klemmenplan`, `Inhaltsverzeichnis`,
 *     `Legende`, etc.).
 *   - The line has ≥ 3 strong family-token hits AND ≥ 4 total
 *     non-trivial tokens (a bona-fide column header row).
 *
 * Footer / title-block lines (caught by
 * `isFooterOrTitleBlockLine`) ALWAYS fail this gate, regardless
 * of any token count — that ladder is checked first.
 */
export function passesNonIoFamilyHeaderShapeGate(
  text: unknown,
  classification: PdfTableHeaderClassification,
): boolean {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (isFooterOrTitleBlockLine(trimmed)) return false;
  // Canonical family-title patterns — the operator clearly named
  // the page kind on this line.
  for (const re of CANONICAL_FAMILY_TITLE_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  // Multi-strong-token header. The TcECAD canonical BOM header
  //   "Benennung (BMK) Menge Bezeichnung Typnummer Hersteller Artikelnummer"
  // carries 4 strong BOM tokens; a single-token line like
  // "Hersteller (Firma) Beckhoff Automation GmbH" carries 1.
  const strongCount = strongFamilyTokenCount(trimmed, classification.family);
  if (strongCount < 3) return false;
  // Total non-trivial tokens — guard against three-strong-tokens
  // pile-ups inside a body row that's mostly punctuation/numbers.
  const totalTokens = trimmed.match(NON_TRIVIAL_TOKEN_RE)?.length ?? 0;
  if (totalTokens < 4) return false;
  return true;
}

/**
 * Sprint 83B — normalised diagnostic signature for a non-IO
 * family header line. Used as the dedup key so the same header
 * appearing on multiple lines of the same page collapses to one
 * diagnostic. The signature is intentionally short (capped at
 * ~120 chars) so trailing text variation doesn't spawn variants.
 */
export function nonIoFamilyDiagnosticSignature(text: unknown): string {
  if (typeof text !== 'string') return '';
  const norm = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm.length > 120 ? norm.slice(0, 120) : norm;
}

// ---------------------------------------------------------------------------
// Sprint 83C — non-IO family rollups
// ---------------------------------------------------------------------------
//
// Sprint 83B's hygiene gate already drops vendor-metadata footers
// and weak single-token lines. Sprint 83A's classification is
// safe. But the manual run on `TcECAD_Import_V2_2_x.pdf` (86
// pages) still produced one diagnostic per `(family, page,
// signature)` tuple — i.e. one BOM diagnostic per page across
// pages 80–86, one cable-list diagnostic per page across pages
// 55–79, and so on. Operationally that's still too noisy for an
// operator to scan.
//
// Sprint 83C swaps the per-occurrence emission for a
// collect-then-rollup pattern:
//   1. During the scan, every passing non-IO line is folded into
//      a `(family, signature)` bucket along with its page number
//      and the first-evidence sourceRef + snippet.
//   2. After the scan, one rollup diagnostic per bucket is
//      emitted, with the page range coalesced via
//      `compressPageRanges` and the first-evidence sourceRef
//      preserved as `sourceRef`.
//
// The existing per-family diagnostic codes
// (`PDF_BOM_TABLE_DETECTED`, `PDF_TERMINAL_TABLE_DETECTED`,
// `PDF_CABLE_TABLE_DETECTED`, `PDF_CONTENTS_TABLE_IGNORED`,
// `PDF_LEGEND_TABLE_IGNORED`, `PDF_TABLE_HEADER_REJECTED`) are
// reused — Sprint 83C is a *volume* change, not a schema change.
// The diagnostic message gains a "pages X–Y, Z–W" range string
// and a "First evidence: <snippet>" trailer, but the
// `ElectricalDiagnostic` shape is otherwise unchanged.

/**
 * Sprint 83C — coalesce a list of page numbers into a compact
 * range string with `–` (en-dash) separators between
 * consecutive runs and `, ` between non-consecutive groups.
 *
 * Examples:
 *   - []                        → ''
 *   - [80]                      → '80'
 *   - [80, 81, 82, 83, 84, 85, 86] → '80–86'
 *   - [3, 49, 50, 51, 52, 53, 54] → '3, 49–54'
 *   - [86, 80, 81, 82, 86, 84, 85, 83] → '80–86'  (sort + dedup)
 *   - ['80', 81, '82']          → '80–82'         (string + number)
 *   - [3.5, NaN, 'abc', null]   → ''              (defensive drops)
 *
 * Pure / total / DOM-free.
 */
export function compressPageRanges(pages: ReadonlyArray<number | string>): string {
  if (!Array.isArray(pages) || pages.length === 0) return '';
  // Coerce to integers, drop anything non-finite or non-integer.
  const seen = new Set<number>();
  for (const raw of pages) {
    const n =
      typeof raw === 'number'
        ? raw
        : typeof raw === 'string'
          ? Number.parseInt(raw, 10)
          : NaN;
    if (Number.isFinite(n) && Number.isInteger(n)) seen.add(n);
  }
  if (seen.size === 0) return '';
  const sorted = Array.from(seen).sort((a, b) => a - b);
  const parts: string[] = [];
  let runStart = sorted[0];
  let runEnd = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const v = sorted[i];
    if (v === runEnd + 1) {
      runEnd = v;
      continue;
    }
    parts.push(runStart === runEnd ? `${runStart}` : `${runStart}–${runEnd}`);
    runStart = v;
    runEnd = v;
  }
  parts.push(runStart === runEnd ? `${runStart}` : `${runStart}–${runEnd}`);
  return parts.join(', ');
}

// ---------------------------------------------------------------------------
// Sprint 83D — non-IO rollup canonicalization
// ---------------------------------------------------------------------------
//
// Sprint 83C grouped non-IO family rollups by `(family, signature)`,
// where `signature` is the Sprint 83B normalised line text. On
// real-world PDFs that key was still too granular: numbered TcECAD
// section markers (`=COMPONENTS&EPB/1` … `/7`, `=CABLE&EMB/1` …
// `/24`) gave each occurrence a distinct signature, and BOM pages
// 80–86 produced separate rollups for "Teileliste / Stückliste …",
// "Benennung (BMK) …", "Schaltplan / Position …" — three different
// signatures of the same logical section.
//
// Sprint 83D replaces the signature-based key with a *canonical
// section role* per family. Role determination is text-based and
// pure; it never widens the Sprint 83B hygiene gate (lines that
// were suppressed under 83B stay suppressed under 83D). The
// representative `SourceRef` and first-evidence snippet still
// come from the first occurrence, and page ranges still appear in
// the rollup message via `compressPageRanges`.

/**
 * Canonical TcECAD numbered section markers
 * (`=COMPONENTS&EPB/N`, `=CABLE&EMB/N`, etc.).
 */
const NUMBERED_SECTION_MARKERS: ReadonlyArray<{
  re: RegExp;
  marker: string;
  family: Exclude<PdfTableFamily, 'unknown' | 'io_list'>;
}> = [
  {
    re: /=\s*COMPONENTS\s*&\s*EPB\s*\/\s*\d+(?:\.\d+)?/i,
    marker: 'COMPONENTS_EPB',
    family: 'bom_parts_list',
  },
  {
    re: /=\s*CABLE\s*&\s*EMB\s*\/\s*\d+(?:\.\d+)?/i,
    marker: 'CABLE_EMB',
    family: 'cable_list',
  },
  {
    re: /=\s*CONTENTS\s*&\s*EAB\s*\/\s*\d+(?:\.\d+)?/i,
    marker: 'CONTENTS_EAB',
    family: 'contents_index',
  },
  {
    re: /=\s*LEGEND\s*&\s*ETL\s*\/\s*\d+(?:\.\d+)?/i,
    marker: 'LEGEND_ETL',
    family: 'legend',
  },
  {
    re: /=\s*TERMINAL\s*&\s*EMA\s*\/\s*\d+(?:\.\d+)?/i,
    marker: 'TERMINAL_EMA',
    family: 'terminal_list',
  },
];

/**
 * Sprint 83D — recognise a numbered TcECAD section marker
 * (`=COMPONENTS&EPB/3`, `=CABLE&EMB/24`, `=CONTENTS&EAB/1`,
 * `=LEGEND&ETL/6`, `=TERMINAL&EMA/7`, etc.). The numbered suffix
 * is intentionally discarded — `/1` and `/24` collapse to the
 * same marker so rollups can group across the whole numbered
 * series. Pure / DOM-free / total. Returns `null` when no marker
 * is present.
 */
export function normalizeNumberedPdfSectionMarker(
  text: unknown,
): { marker: string; family: PdfTableFamily } | null {
  if (typeof text !== 'string' || text.length === 0) return null;
  for (const entry of NUMBERED_SECTION_MARKERS) {
    if (entry.re.test(text)) {
      return { marker: entry.marker, family: entry.family };
    }
  }
  return null;
}

type CanonicalSectionRole =
  | 'bom_parts_list'
  | 'cable_overview'
  | 'cable_plan'
  | 'cable_index'
  | 'terminal_overview'
  | 'terminal_plan'
  | 'terminal_index'
  | 'contents_index'
  | 'legend';

const CABLE_OVERVIEW_RE = /\bkabel[üu]bersicht\b|\bcable[ -]?overview\b/i;
const CABLE_PLAN_RE = /\bkabelplan\b|\bcable[ -]?plan\b/i;
const TERMINAL_OVERVIEW_RE =
  /\bklemmleisten[üu]bersicht\b|\bterminal[ -]?overview\b/i;
const TERMINAL_PLAN_RE =
  /\bklemmenplan\b|\bklemmleistenplan\b|\bklemmleiste\b|\bterminal[ -]?plan\b|\bterminal[ -]?list\b/i;

/**
 * Sprint 83D — derive the canonical *section role* for a non-IO
 * family header line. The role is the dedup unit for rollups —
 * two lines with the same `(family, role)` collapse into one
 * rollup regardless of trailing differences (numbered TcECAD
 * suffixes, vendor strings, column reorderings).
 *
 * - BOM family → always `bom_parts_list` (parts-list table headers
 *   and `=COMPONENTS&EPB/N` markers are the same logical section).
 * - Cable family → `cable_overview` (Kabelübersicht), `cable_plan`
 *   (Kabelplan) or `cable_index` (everything else, e.g. raw
 *   `=CABLE&EMB/N` markers).
 * - Terminal family → `terminal_overview` (Klemmleistenübersicht),
 *   `terminal_plan` (Klemmenplan / Klemmleiste / Klemmen-style
 *   pages) or `terminal_index` (raw markers).
 * - Contents family → `contents_index` (single bucket).
 * - Legend family → `legend` (single bucket).
 */
export function canonicalizeNonIoHeaderRole(
  text: unknown,
  family: PdfTableFamily,
): CanonicalSectionRole | null {
  if (typeof text !== 'string') return null;
  switch (family) {
    case 'bom_parts_list':
      return 'bom_parts_list';
    case 'cable_list':
      if (CABLE_OVERVIEW_RE.test(text)) return 'cable_overview';
      if (CABLE_PLAN_RE.test(text)) return 'cable_plan';
      return 'cable_index';
    case 'terminal_list':
      if (TERMINAL_OVERVIEW_RE.test(text)) return 'terminal_overview';
      if (TERMINAL_PLAN_RE.test(text)) return 'terminal_plan';
      return 'terminal_index';
    case 'contents_index':
      return 'contents_index';
    case 'legend':
      return 'legend';
    default:
      return null;
  }
}

/**
 * Sprint 83D — produce the `(family, role)` rollup key for a
 * non-IO header line. The numbered-marker normaliser is consulted
 * first so `=CABLE&EMB/1` … `/24` collapse to the same key even
 * before the canonical role keyword is examined. The returned
 * `role` is empty when neither path resolves a role — callers
 * fall back to a per-line bucket in that case (rare on
 * hygiene-gated lines).
 */
export function canonicalizeNonIoFamilyRollupKey(args: {
  family: PdfTableFamily;
  text: string;
}): { key: string; role: string } {
  const { family, text } = args;
  const role = canonicalizeNonIoHeaderRole(text, family);
  if (role) return { key: `${family}:${role}`, role };
  // Fallback path — should not fire under the current family set
  // (every non-IO family above resolves a role), but keep a
  // deterministic per-signature bucket so future families don't
  // silently merge into one rollup.
  const sig = nonIoFamilyDiagnosticSignature(text);
  return { key: `${family}:_sig:${sig}`, role: '' };
}

interface NonIoFamilyOccurrence {
  family: PdfTableFamily;
  /** Sprint 83D — canonical `(family, role)` rollup role string. */
  role: string;
  /** Sprint 83C — first-occurrence signature, kept for diagnostics. */
  signature: string;
  /**
   * Sprint 83F — per-page evidence map. Each page in the rollup
   * contributes its first matching line's `SourceRef` (subsequent
   * matches on the same page collapse via the canonical-key dedup).
   * Replaces the Sprint 83C `Set<number>` so the diagnostic emitter
   * can thread per-occurrence drilldown into `additionalSourceRefs`
   * without re-walking the document.
   */
  perPage: Map<number, SourceRef>;
  representativeSourceRef: SourceRef;
  representativeSnippet: string;
  firstReason: string;
}

function familyHumanLabel(family: PdfTableFamily): string {
  switch (family) {
    case 'bom_parts_list':
      return 'BOM / parts-list';
    case 'terminal_list':
      return 'terminal-list';
    case 'cable_list':
      return 'cable-list';
    case 'contents_index':
      return 'contents/index';
    case 'legend':
      return 'legend';
    default:
      return family;
  }
}

function familyDiagnosticCode(
  family: PdfTableFamily,
):
  | 'PDF_BOM_TABLE_DETECTED'
  | 'PDF_TERMINAL_TABLE_DETECTED'
  | 'PDF_CABLE_TABLE_DETECTED'
  | 'PDF_CONTENTS_TABLE_IGNORED'
  | 'PDF_LEGEND_TABLE_IGNORED'
  | 'PDF_TABLE_HEADER_REJECTED' {
  switch (family) {
    case 'bom_parts_list':
      return 'PDF_BOM_TABLE_DETECTED';
    case 'terminal_list':
      return 'PDF_TERMINAL_TABLE_DETECTED';
    case 'cable_list':
      return 'PDF_CABLE_TABLE_DETECTED';
    case 'contents_index':
      return 'PDF_CONTENTS_TABLE_IGNORED';
    case 'legend':
      return 'PDF_LEGEND_TABLE_IGNORED';
    default:
      return 'PDF_TABLE_HEADER_REJECTED';
  }
}

function buildNonIoFamilyRollupDiagnostic(
  occurrence: NonIoFamilyOccurrence,
): ElectricalDiagnostic {
  const sortedPages = Array.from(occurrence.perPage.keys()).sort(
    (a, b) => a - b,
  );
  const pageRange = compressPageRanges(sortedPages);
  const code = familyDiagnosticCode(occurrence.family);
  const label = familyHumanLabel(occurrence.family);
  const pageCount = sortedPages.length;
  const pagePhrase =
    pageCount === 1
      ? `page ${pageRange}`
      : `pages ${pageRange}`;
  const reason = occurrence.firstReason;
  const message =
    `Ignored ${label} sections on ${pagePhrase}. ` +
    `These are not IO lists. First evidence: "${truncate(occurrence.representativeSnippet, 80)}"` +
    (reason ? ` (${reason})` : '') +
    `.`;
  // Sprint 83F — thread per-page evidence into the diagnostic.
  // Page-ascending order; first page's SourceRef stays in
  // `sourceRef` for backwards compatibility with Sprint 83C/D/E
  // consumers, the rest land in `additionalSourceRefs`.
  const additionalSourceRefs: SourceRef[] = [];
  for (const page of sortedPages) {
    if (page === sortedPages[0]) continue;
    const ref = occurrence.perPage.get(page);
    if (ref) additionalSourceRefs.push(ref);
  }
  const diag: ElectricalDiagnostic = {
    ...createElectricalDiagnostic({
      code,
      severity: 'info',
      message,
      sourceRef: occurrence.representativeSourceRef,
    }),
  };
  if (additionalSourceRefs.length > 0) {
    diag.additionalSourceRefs = additionalSourceRefs;
  }
  return diag;
}

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
  // Sprint 83C → 83D — collect non-IO family occurrences during
  // the scan, then emit aggregated rollup diagnostics at the end.
  // Sprint 83C used `(family, signature)` as the dedup key, which
  // still produced distinct rollups for numbered TcECAD section
  // markers (`=CABLE&EMB/1` vs `/2`) and for the three sibling
  // BOM table headers on the same page series. Sprint 83D switches
  // the key to a *canonical section role* via
  // `canonicalizeNonIoFamilyRollupKey`, so all numbered cable-plan
  // entries collapse to one `cable_list:cable_plan` rollup, all
  // BOM table headers across pages 80–86 collapse to one
  // `bom_parts_list:bom_parts_list` rollup, etc. The hygiene gate
  // is unchanged — lines suppressed under Sprint 83B stay
  // suppressed under 83D.
  const nonIoOccurrences = new Map<string, NonIoFamilyOccurrence>();
  while (i < lines.length) {
    const line = lines[i];
    const header = detectIoTableHeader({
      text: line.block.text,
      items: line.items,
    });
    if (!header) {
      // Sprint 83A → 83B → 83C — even when `detectIoTableHeader`
      // returns null, the line may still be a known non-IO family
      // header. Hygiene gates from Sprint 83B still apply:
      //   - footer / title-block lines NEVER contribute;
      //   - weak / single-strong-token / body-row lines NEVER
      //     contribute;
      //   - canonical family-title and multi-strong-token header
      //     rows contribute one occurrence per page.
      const classification = classifyPdfTableHeader(line.block.text);
      if (classification.family !== 'unknown' && classification.family !== 'io_list') {
        if (passesNonIoFamilyHeaderShapeGate(line.block.text, classification)) {
          const signature = nonIoFamilyDiagnosticSignature(line.block.text);
          // Sprint 83D — canonical `(family, role)` key. Numbered
          // TcECAD markers and sibling BOM table-header lines map
          // to the same role; all such lines collapse into a
          // single rollup at the end of the scan.
          const { key: groupKey, role } = canonicalizeNonIoFamilyRollupKey({
            family: classification.family,
            text: line.block.text,
          });
          const existing = nonIoOccurrences.get(groupKey);
          if (existing) {
            // Sprint 83F — only record the first matching line per
            // page; subsequent same-key matches on the same page
            // remain collapsed (Sprint 83B intra-page dedup).
            if (!existing.perPage.has(line.pageNumber)) {
              existing.perPage.set(line.pageNumber, line.block.sourceRef);
            }
          } else {
            const perPage = new Map<number, SourceRef>();
            perPage.set(line.pageNumber, line.block.sourceRef);
            nonIoOccurrences.set(groupKey, {
              family: classification.family,
              role,
              signature,
              perPage,
              representativeSourceRef: line.block.sourceRef,
              representativeSnippet: line.block.text,
              firstReason:
                classification.reasons[classification.reasons.length - 1] ?? '',
            });
          }
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

  // Sprint 83C → 83D — emit one rollup diagnostic per
  // `(family, role)` group. Sorted by family then role then
  // earliest page so the operator's stream reads stably across
  // runs and roughly top-to-bottom of the document.
  const orderedOccurrences = Array.from(nonIoOccurrences.values()).sort(
    (a, b) => {
      if (a.family !== b.family) return a.family.localeCompare(b.family);
      if (a.role !== b.role) return a.role.localeCompare(b.role);
      const ap = Math.min(...a.perPage.keys());
      const bp = Math.min(...b.perPage.keys());
      return ap - bp;
    },
  );
  for (const occurrence of orderedOccurrences) {
    diagnostics.push(buildNonIoFamilyRollupDiagnostic(occurrence));
  }

  return { tables, consumedBlockIds, diagnostics };
}

function truncate(s: string, n: number): string {
  if (typeof s !== 'string') return '';
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Sprint 83A's `buildNonIoFamilyDiagnostic` (per-line emitter)
// was retired in Sprint 83C; the rollup-builder
// `buildNonIoFamilyRollupDiagnostic` defined above replaces it.
// Per-family diagnostic codes are unchanged — see
// `familyDiagnosticCode` for the mapping.
