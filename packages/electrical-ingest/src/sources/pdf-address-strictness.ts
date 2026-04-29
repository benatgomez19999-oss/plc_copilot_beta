// Sprint 82 — PDF-specific address strictness classifier.
//
// Why this file exists:
//
//   The Sprint 80/81 PDF extractor leaned on `detectPlcAddress`
//   (in `normalize.ts`), which accepts Siemens-style addresses
//   with the bit notation OPTIONAL: `%I0.0` → ok, `%I1` → ok,
//   even `I1` (after our `%`-prefixing) → ok. That is correct
//   for CSV and EPLAN where the address column is canonical;
//   it is WRONG for PDF, where the same `I1` token routinely
//   appears as a Beckhoff module *channel marker* on a hardware
//   overview page. Promoting `I1` to a buildable `%I1` PIR
//   address synthesises evidence that does not exist.
//
//   `classifyPdfAddress(token)` answers, **for the PDF context
//   only**: is this token a strict PLC address (safe to promote
//   to PIR), a channel marker (preserve as evidence but never
//   build), or something we don't yet recognise?
//
//   CSV / EPLAN / TcECAD ingestors are NOT affected — they keep
//   using `detectPlcAddress` directly.
//
// Pure / DOM-free / deterministic.

export type PdfAddressClassification =
  | 'strict_plc_address'
  | 'channel_marker'
  | 'ambiguous'
  | 'invalid';

export interface PdfAddressClassificationResult {
  classification: PdfAddressClassification;
  /**
   * Verbatim input token, trimmed but otherwise unchanged. Used
   * downstream when the row is preserved as channel-marker
   * evidence (not as a buildable PLC address).
   */
  token: string;
  /** Why the classifier landed where it did — for diagnostics. */
  reason: string;
}

// ---------------------------------------------------------------------------
// Strict patterns
// ---------------------------------------------------------------------------
//
// "Strict" means: there is unambiguous evidence the token names a
// real PLC address. The bit position MUST be present (Siemens /
// IEC), or the address MUST be in the explicit Rockwell tag form.
// We deliberately do NOT widen the catalogue here — anything we
// cannot confidently prove is a PLC address falls back to
// channel_marker / ambiguous.

const STRICT_SIEMENS = /^%?[IQM][BWD]?\s*\d+\.\d+$/i;
// `%IX0.0` / `%QX0.1` / `%MX0.0` — IEC explicit-bit notation.
const STRICT_IEC = /^%[IQM]X\d+\.\d+$/i;
// Rockwell tag-style: `Local:1:I.Data[0].0` etc.
const STRICT_ROCKWELL = /^Local:\d+:[IO]\.Data\[\d+\]\.\d+$/i;

// ---------------------------------------------------------------------------
// Channel-marker patterns
// ---------------------------------------------------------------------------
//
// "Channel marker" means: the token looks like a PLC-address-shaped
// label — but the bit position is missing. On a Beckhoff EL1004 /
// EL2004 overview page, the labels `I1` / `I2` / `O1` / `O2` /
// `I1+` / `O2-` mean *module channel*, NOT PLC byte/bit address.
// PDF promotion of these tokens to `%I1` would invent evidence.
//
// `%`-prefixed forms WITHOUT a bit (`%I1`, `%Q1`) are also treated
// as channel markers — Sprint 79's `detectPlcAddress` accepted
// them (Siemens family with optional bit), but PDF context is too
// loose for that to be safe.

const CHANNEL_MARKER_BARE = /^[IOQ]\d+[+\-]?$/i;
const CHANNEL_MARKER_PERCENT = /^%[IOQ]\d+$/i;

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

/**
 * Classify a single token as a PDF-context PLC address. Pure /
 * deterministic; no I/O. Empty / non-string / whitespace input
 * returns `'invalid'`.
 *
 * Strictness order (first match wins):
 *   1. Strict Rockwell tag.
 *   2. Strict IEC `%IX/%QX/%MX`.
 *   3. Strict Siemens with explicit `byte.bit`.
 *   4. Channel-marker shape (with or without `%`).
 *   5. Anything else → `'ambiguous'`.
 *
 * The `reason` field is included in the result so callers can
 * surface it in `PDF_*` diagnostics without re-deriving it.
 */
export function classifyPdfAddress(
  raw: unknown,
): PdfAddressClassificationResult {
  if (typeof raw !== 'string') {
    return { classification: 'invalid', token: '', reason: 'non-string input' };
  }
  const token = raw.trim();
  if (token.length === 0) {
    return { classification: 'invalid', token, reason: 'empty token' };
  }
  if (STRICT_ROCKWELL.test(token)) {
    return {
      classification: 'strict_plc_address',
      token,
      reason: 'strict Rockwell tag form',
    };
  }
  if (STRICT_IEC.test(token)) {
    return {
      classification: 'strict_plc_address',
      token,
      reason: 'strict IEC %IX/%QX form',
    };
  }
  if (STRICT_SIEMENS.test(token)) {
    return {
      classification: 'strict_plc_address',
      token,
      reason: 'strict Siemens byte.bit form',
    };
  }
  if (CHANNEL_MARKER_BARE.test(token)) {
    return {
      classification: 'channel_marker',
      token,
      reason: 'bare I/O/Q channel without byte.bit (likely module channel marker)',
    };
  }
  if (CHANNEL_MARKER_PERCENT.test(token)) {
    return {
      classification: 'channel_marker',
      token,
      reason: '%I/%Q/%O channel without byte.bit (likely module channel marker, not PLC address)',
    };
  }
  return {
    classification: 'ambiguous',
    token,
    reason: 'no recognised strict-address or channel-marker shape',
  };
}

/**
 * Convenience: predicate over `classifyPdfAddress`. True when the
 * token is safe to promote to a buildable PIR address from a PDF
 * source.
 */
export function isStrictPdfPlcAddress(raw: unknown): boolean {
  return classifyPdfAddress(raw).classification === 'strict_plc_address';
}

/**
 * Convenience: true when the token looks like a Beckhoff-style
 * module channel marker. Used by the row extractor to reject
 * "address+tag" rows whose tag column is itself a channel marker
 * (e.g. an `I1 I2` row on a module overview page — neither side
 * is a real address+tag pair).
 */
export function isPdfChannelMarker(raw: unknown): boolean {
  return classifyPdfAddress(raw).classification === 'channel_marker';
}
