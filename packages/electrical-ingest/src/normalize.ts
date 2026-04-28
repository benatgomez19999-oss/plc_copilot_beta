// Sprint 72 — pure normalisers used by every source ingestor before
// shaping data into the canonical graph. All helpers are
// deterministic and Unicode-aware where it matters (device tags
// often contain `+`, `-`, `=` from EPLAN structure aspects).

/**
 * Canonicalise a node id. Trims, collapses whitespace, replaces
 * forbidden characters with `_`. Does NOT lowercase — many
 * electrical tag systems (EPLAN, IEC 61346) are case-sensitive.
 */
export function normalizeNodeId(raw: string): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim();
  s = s.replace(/\s+/g, '_');
  s = s.replace(/[^A-Za-z0-9_./+\-=:]/g, '_');
  return s;
}

/**
 * Canonicalise a free-form label. Collapses internal whitespace.
 * Returns null/empty for empty input rather than `''`-spam.
 */
export function normalizeLabel(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Coerce an attributes bag to the canonical
 * `Record<string, string | number | boolean>`. Drops keys whose
 * values aren't representable; never throws.
 */
export function normalizeAttributes(
  raw: Record<string, unknown> | null | undefined,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = typeof rawKey === 'string' ? rawKey.trim() : '';
    if (key.length === 0) continue;
    if (typeof rawValue === 'string') {
      const v = rawValue.trim();
      if (v.length > 0) out[key] = v;
    } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      out[key] = rawValue;
    } else if (typeof rawValue === 'boolean') {
      out[key] = rawValue;
    }
  }
  return out;
}

/**
 * Detect whether a string looks like a PLC channel address — broad
 * pattern, intentionally permissive (Siemens %I0.0, Codesys %IX0.0,
 * Rockwell Local:1:I.Data[0].0, generic I0.0 / Q1.7).
 *
 * Returns null if no recognisable form, otherwise a small descriptor
 * the role-inference layer can use to bias classifications.
 */
export interface DetectedAddress {
  raw: string;
  family: 'siemens' | 'codesys' | 'rockwell' | 'generic';
  direction: 'input' | 'output' | 'unknown';
}

export function detectPlcAddress(raw: unknown): DetectedAddress | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0) return null;

  // Siemens: %I0.0, %Q1.7, %IW10, %MW100 — direction inferred from
  // the second character (I/Q/M).
  const siemens = /^%([IQMA])([XBWD]?)\d+(\.\d+)?$/i;
  if (siemens.test(s)) {
    const second = s.charAt(1).toUpperCase();
    return {
      raw: s,
      family: 'siemens',
      direction: second === 'I' ? 'input' : second === 'Q' ? 'output' : 'unknown',
    };
  }

  // Codesys: %IX0.0 / %QX1.7 / %IW10 — same direction inference.
  const codesys = /^%([IQ])([XBWD])\d+(\.\d+)?$/i;
  if (codesys.test(s)) {
    return {
      raw: s,
      family: 'codesys',
      direction: s.charAt(1).toUpperCase() === 'I' ? 'input' : 'output',
    };
  }

  // Rockwell: Local:1:I.Data[0].0  /  Local:1:O.Data[0].0
  const rockwell = /^Local:\d+:([IO])\.Data\[\d+\]\.\d+$/i;
  if (rockwell.test(s)) {
    return {
      raw: s,
      family: 'rockwell',
      direction:
        /:I\./i.test(s) ? 'input' : /:O\./i.test(s) ? 'output' : 'unknown',
    };
  }

  // Bare generic forms: I0.0 / Q1.7 / DI0 / DO0.
  const generic = /^([IQDA])([IO]?)\d+(\.\d+)?$/i;
  if (generic.test(s)) {
    const head = s.charAt(0).toUpperCase();
    let direction: DetectedAddress['direction'] = 'unknown';
    if (head === 'I') direction = 'input';
    else if (head === 'Q') direction = 'output';
    else if (head === 'D') {
      const second = s.charAt(1).toUpperCase();
      if (second === 'I') direction = 'input';
      else if (second === 'O') direction = 'output';
    }
    return { raw: s, family: 'generic', direction };
  }
  return null;
}
